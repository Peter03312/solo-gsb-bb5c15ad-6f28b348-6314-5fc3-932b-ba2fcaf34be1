'use strict';
// 包装出货：按批次把“已贴用标签卷”的张数分配给出货单。
//
// 确认出货（整单事务化，违反任意一条则整单回滚拒绝、不占用任何数量）：
//   - 必须录入：批次、正整数出货量、各卷分配张数（每卷一条）、操作人；
//   - 各卷必须属于该批次、未停用（ACTIVE）且绑定有效放行；
//   - 各卷分配张数为正整数，同一卷不可重复出现；
//   - 分配总数必须恰好等于出货量；
//   - 每卷“累计已分配数 + 本次分配”不得超过该卷已贴用数（applied_qty，作废张数不算）。
// 确认时保存当时快照：放行标识、过敏原集合、卷号、卷修订号；出货记录不提供删除/修改，
// 不会因后续更正而消失。
//
// 待评估（终态，不自动恢复）：
//   原料/事件变更、整组换线确认应用、绑定放行失效/删除导致卷停用时，
//   使用了该卷的已确认出货单整单标记为 PENDING_REVIEW 并显示具体原因；
//   该卷尚未分配的已贴张数随即冻结，不得再出货。

class ShipmentError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ShipmentError';
    this.code = code;
    this.details = details || [];
  }
}

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// 整单拒绝时按“最严重的一条”决定 HTTP 状态码（数字越大越优先）。
const ERROR_STATUS = {
  ROLL_RETIRED: 409,
  ROLL_RELEASE_INACTIVE: 409,
  ROLL_QTY_EXCEEDED: 409,
  ROLL_NOT_FOUND: 404,
  SHIPMENT_NOT_FOUND: 404,
  BATCH_NOT_FOUND: 404,
  BATCH_NOT_PRODUCED: 400,
  ROLL_BATCH_MISMATCH: 400,
  ALLOCATION_MISMATCH: 400,
  INVALID_REQUEST: 400
};

function pickPrimaryError(errors) {
  let best = errors[0];
  for (const e of errors) {
    if ((ERROR_STATUS[e.code] || 400) > (ERROR_STATUS[best.code] || 400)) best = e;
  }
  return new ShipmentError(best.code, best.message, errors.map((e) => e.message));
}

function positiveInt(v, field) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ShipmentError('INVALID_REQUEST', `${field}必须是正整数`);
  }
  return n;
}

// ---------- 确认出货 ----------
function createShipment(db, body) {
  body = body || {};
  const errors = [];

  const batch_id = parseInt(body.batch_id, 10);
  if (!Number.isInteger(batch_id)) {
    throw new ShipmentError('INVALID_REQUEST', '请选择批次');
  }
  let ship_qty;
  try {
    ship_qty = positiveInt(body.ship_qty, '出货量');
    if (ship_qty > 1e9) throw new ShipmentError('INVALID_REQUEST', '出货量超出允许范围');
  } catch (e) { errors.push(e); }
  const shipped_by = String(body.shipped_by || body.operator || '').trim() || '未署名';
  const shipped_at = String(body.shipped_at || '').trim();
  if (shipped_at && !TIME_RE.test(shipped_at)) {
    throw new ShipmentError('INVALID_REQUEST', '出货时间格式应为 YYYY-MM-DDTHH:MM');
  }

  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems || rawItems.length === 0) {
    throw new ShipmentError('INVALID_REQUEST', '请录入各卷分配张数（items 至少一条）');
  }

  // 条目级格式校验（缺字段/非正整数/重复卷）
  const items = [];
  const seenRoll = new Set();
  rawItems.forEach((raw, idx) => {
    const where = `items[${idx}]`;
    const roll_id = parseInt(raw && raw.roll_id, 10);
    if (!Number.isInteger(roll_id)) {
      errors.push(new ShipmentError('INVALID_REQUEST', `${where}：缺少合法的卷号 roll_id`));
      return;
    }
    if (seenRoll.has(roll_id)) {
      errors.push(new ShipmentError('INVALID_REQUEST', `${where}：卷 #${roll_id} 在本单中重复分配，同一卷只能出现一次`));
      return;
    }
    seenRoll.add(roll_id);
    let alloc_qty;
    try {
      alloc_qty = positiveInt(raw && (raw.alloc_qty != null ? raw.alloc_qty : raw.qty),
        `${where} 分配张数`);
    } catch (e) {
      errors.push(new ShipmentError('INVALID_REQUEST', `${where}（卷 #${roll_id}）：分配张数必须是正整数`));
      return;
    }
    items.push({ roll_id, alloc_qty });
  });
  if (errors.length) throw pickPrimaryError(errors);

  const batch = db.prepare('SELECT id, code FROM batches WHERE id = ?').get(batch_id);
  if (!batch) throw new ShipmentError('BATCH_NOT_FOUND', '该批次不存在');
  const out = db.prepare('SELECT 1 FROM batch_outputs WHERE batch_id = ?').get(batch_id);
  const ev = db.prepare('SELECT 1 FROM events WHERE batch_id = ?').get(batch_id);
  if (!out || !ev) throw new ShipmentError('BATCH_NOT_PRODUCED', '该批次尚无加工记录，无法包装出货');

  let shipmentId;
  const tx = db.transaction(() => {
    // 事务内对每卷重新读取并逐条核对（better-sqlite3 同步执行，读取即当前已提交状态）。
    const checked = [];
    let total = 0;
    for (const { roll_id, alloc_qty } of items) {
      const roll = db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(roll_id);
      if (!roll) {
        errors.push(new ShipmentError('ROLL_NOT_FOUND', `卷 #${roll_id} 不存在`));
        continue;
      }
      if (roll.batch_id !== batch_id) {
        errors.push(new ShipmentError('ROLL_BATCH_MISMATCH',
          `卷 ${roll.roll_code}（#${roll_id}）不属于批次 ${batch.code}`));
        continue;
      }
      if (roll.status !== 'ACTIVE') {
        errors.push(new ShipmentError('ROLL_RETIRED',
          `卷 ${roll.roll_code} 已永久停用（${roll.retired_reason || '见停用原因'}），不得再出货`));
        continue;
      }
      // 必须绑定有效放行（release_id 为空表示放行已被删除；release 行不存在/失效同样拒绝）
      const release = roll.release_id == null ? null
        : db.prepare('SELECT status FROM releases WHERE id = ?').get(roll.release_id);
      if (!release || release.status !== 'ACTIVE') {
        errors.push(new ShipmentError('ROLL_RELEASE_INACTIVE',
          `卷 ${roll.roll_code} 未绑定有效放行（放行已失效或被删除），不得出货`));
        continue;
      }
      const allocated = db.prepare(
        'SELECT COALESCE(SUM(alloc_qty),0) AS n FROM shipment_items WHERE roll_id = ?'
      ).get(roll_id).n;
      if (allocated + alloc_qty > roll.applied_qty) {
        errors.push(new ShipmentError('ROLL_QTY_EXCEEDED',
          `卷 ${roll.roll_code} 分配超出已贴用数：已贴用 ${roll.applied_qty} 张，` +
          `此前已分配 ${allocated} 张，本次申请 ${alloc_qty} 张，累计 ${allocated + alloc_qty} 超过已贴用数；整单拒绝`));
        continue;
      }
      checked.push({ roll, alloc_qty });
      total += alloc_qty;
    }

    if (total !== ship_qty) {
      errors.push(new ShipmentError('ALLOCATION_MISMATCH',
        `各卷分配总数 ${total} 张与出货量 ${ship_qty} 张不一致；整单拒绝，不占用任何数量`));
    }
    if (errors.length) throw pickPrimaryError(errors);

    shipmentId = db.prepare(
      `INSERT INTO shipments
         (shipment_code, batch_id, batch_code_snapshot, ship_qty, status, review_reason,
          reviewed_rolls_json, shipped_at, shipped_by, created_event_seq)
       VALUES ('', ?, ?, ?, 'CONFIRMED', '', '[]', COALESCE(?, datetime('now')), ?,
               (SELECT COUNT(*) FROM events))`
    ).run(batch_id, batch.code, ship_qty, shipped_at || null, shipped_by).lastInsertRowid;
    const shipment_code = `SHIP-${String(shipmentId).padStart(4, '0')}`;
    db.prepare('UPDATE shipments SET shipment_code = ? WHERE id = ?').run(shipment_code, shipmentId);

    const insItem = db.prepare(
      `INSERT INTO shipment_items
         (shipment_id, roll_id, roll_code_snapshot, batch_id_snapshot, release_id_snapshot,
          allergens_snapshot, roll_revision_snapshot, alloc_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const { roll, alloc_qty } of checked) {
      insItem.run(shipmentId, roll.id, roll.roll_code, roll.batch_id, roll.release_id,
        roll.allergen_set, roll.revision, alloc_qty);
    }
  });
  tx();

  return getShipment(db, shipmentId);
}

// ---------- 卷停用时把相关已确认出货单整单标记为待评估 ----------
// 只在卷停用的同一事务内调用；终态，不做任何“恢复 CONFIRMED”。
// retiredRows: [{ id, roll_code, reason }]
// 返回本次新标记/追加原因的出货单列表。
function markShipmentsForRetiredRolls(db, retiredRows) {
  if (!Array.isArray(retiredRows) || !retiredRows.length) return [];
  const reasonByRoll = new Map();
  for (const r of retiredRows) {
    if (r && r.id != null && !reasonByRoll.has(r.id)) {
      reasonByRoll.set(r.id, { roll_code: r.roll_code || `卷#${r.id}`, reason: r.reason || '标签卷已停用' });
    }
  }

  const affected = db.prepare(
    `SELECT DISTINCT s.* FROM shipments s
       JOIN shipment_items si ON si.shipment_id = s.id
      WHERE s.status = 'CONFIRMED' AND si.roll_id IN (${[...reasonByRoll.keys()].map(() => '?').join(',')})`
  ).all(...reasonByRoll.keys());

  const upd = db.prepare(
    `UPDATE shipments SET status = 'PENDING_REVIEW', review_reason = ?, reviewed_rolls_json = ?
      WHERE id = ?`
  );
  const result = [];
  for (const s of affected) {
    const reviewed = JSON.parse(s.reviewed_rolls_json || '[]');
    const seen = new Set(reviewed.map((x) => x.roll_id));
    const appended = [];
    for (const [rollId, info] of reasonByRoll.entries()) {
      if (seen.has(rollId)) continue;
      // 仅追加本出货单实际使用到的卷
      const uses = db.prepare(
        'SELECT 1 FROM shipment_items WHERE shipment_id = ? AND roll_id = ?'
      ).get(s.id, rollId);
      if (!uses) continue;
      reviewed.push({ roll_id: rollId, roll_code: info.roll_code, reason: info.reason });
      appended.push(info);
    }
    if (!appended.length) continue;
    const parts = appended.map((x) => `${x.roll_code}：${x.reason}`);
    const reason = s.review_reason
      ? `${s.review_reason}；${parts.join('；')}`
      : `相关标签卷已停用，出货单待评估：${parts.join('；')}`;
    upd.run(reason, JSON.stringify(reviewed), s.id);
    result.push({
      id: s.id,
      shipment_code: s.shipment_code,
      batch_id: s.batch_id,
      batch_code: s.batch_code_snapshot,
      reason
    });
  }
  return result;
}

// ---------- 读取模型 ----------
function formatShipmentItem(r) {
  return {
    id: r.id,
    roll_id: r.roll_id,                 // 卷当前 id（卷被删除时为 null；当前系统不删卷）
    roll_code: r.roll_code_snapshot,   // 出货当时的卷号
    release_id: r.release_id_snapshot, // 出货当时的放行标识
    allergens: JSON.parse(r.allergens_snapshot || '[]'), // 出货当时的过敏原集合
    roll_revision: r.roll_revision_snapshot,             // 出货当时的卷修订号
    alloc_qty: r.alloc_qty
  };
}

function formatShipment(s, items) {
  if (!s) return null;
  const list = items || [];
  return {
    id: s.id,
    shipment_code: s.shipment_code,
    batch_id: s.batch_id,
    batch_code: s.batch_code_snapshot, // 出货当时的批次编码
    ship_qty: s.ship_qty,
    allocated_qty: list.reduce((n, x) => n + x.alloc_qty, 0),
    status: s.status,
    confirmed: s.status === 'CONFIRMED',
    pending_review: s.status === 'PENDING_REVIEW',
    review_reason: s.review_reason || '',
    reviewed_rolls: JSON.parse(s.reviewed_rolls_json || '[]'),
    shipped_at: s.shipped_at,
    shipped_by: s.shipped_by,
    items: list.map(formatShipmentItem)
  };
}

function getShipment(db, id) {
  const s = db.prepare('SELECT * FROM shipments WHERE id = ?').get(id);
  if (!s) return null;
  const items = db.prepare(
    'SELECT * FROM shipment_items WHERE shipment_id = ? ORDER BY id'
  ).all(id);
  return formatShipment(s, items);
}

function listShipments(db, filter = {}) {
  const where = [];
  const params = [];
  if (filter.batch_id != null) {
    const batch_id = parseInt(filter.batch_id, 10);
    if (!Number.isInteger(batch_id)) {
      throw new ShipmentError('INVALID_REQUEST', '批次号不合法');
    }
    where.push('batch_id = ?');
    params.push(batch_id);
  }
  if (filter.status) {
    const status = String(filter.status).toUpperCase();
    if (status !== 'CONFIRMED' && status !== 'PENDING_REVIEW') {
      throw new ShipmentError('INVALID_REQUEST', '出货单状态仅支持 CONFIRMED / PENDING_REVIEW');
    }
    where.push('status = ?');
    params.push(status);
  }
  const rows = db.prepare(
    `SELECT * FROM shipments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY shipped_at DESC, id DESC`
  ).all(...params);
  return rows.map((s) => getShipment(db, s.id));
}

// 单卷的可出货口径：
//   累计已分配 = 全部出货单（含待评估，记录不消失）对该卷的分配之和；
//   可出货 = max(已贴用 - 累计已分配, 0)，且仅 ACTIVE 卷可出货；停用卷恒为 0（冻结）。
function rollBalanceRow(r, allocated) {
  const shippable = r.status === 'ACTIVE'
    ? Math.max(r.applied_qty - allocated, 0)
    : 0;
  return {
    roll_id: r.id,
    roll_code: r.roll_code,
    status: r.status,
    active: r.status === 'ACTIVE',
    revision: r.revision,
    release_id: r.release_id,
    applied_qty: r.applied_qty,
    allocated_qty: allocated,
    shippable_qty: shippable,
    frozen_qty: r.status === 'ACTIVE' ? 0 : Math.max(r.applied_qty - allocated, 0),
    retired_reason: r.retired_reason || ''
  };
}

function getBatchBalance(db, batchId) {
  const batch = db.prepare(
    `SELECT b.id, b.code, ev.event_time AS produced_at
       FROM batches b LEFT JOIN events ev ON ev.batch_id = b.id
      WHERE b.id = ?`
  ).get(batchId);
  if (!batch) throw new ShipmentError('BATCH_NOT_FOUND', '该批次不存在');
  if (!batch.produced_at) {
    throw new ShipmentError('BATCH_NOT_PRODUCED', '该批次尚无加工记录，无可出货标签');
  }
  return buildBatchBalance(db, batch);
}

function buildBatchBalance(db, batch) {
  const rolls = db.prepare(
    'SELECT * FROM label_rolls WHERE batch_id = ? ORDER BY roll_code'
  ).all(batch.id);
  const allocStmt = db.prepare(
    'SELECT COALESCE(SUM(alloc_qty),0) AS n FROM shipment_items WHERE roll_id = ?'
  );
  const rollRows = rolls.map((r) => {
    const allocated = allocStmt.get(r.id).n;
    return rollBalanceRow(r, allocated);
  });
  const shippable_qty = rollRows
    .filter((r) => r.active).reduce((n, r) => n + r.shippable_qty, 0);
  const allocated_qty = rollRows.reduce((n, r) => n + r.allocated_qty, 0);
  return {
    batch_id: batch.id,
    batch_code: batch.code,
    produced_at: batch.produced_at,
    shippable_qty,                       // 批次可出货余额（仅未停用卷的未分配已贴张数）
    allocated_qty,                       // 该批各卷累计已分配总数
    active_rolls: rollRows.filter((r) => r.active).length,
    retired_rolls: rollRows.length - rollRows.filter((r) => r.active).length,
    rolls: rollRows
  };
}

function listBatchBalances(db) {
  const batches = db.prepare(
    `SELECT b.id, b.code, ev.event_time AS produced_at
       FROM batches b JOIN events ev ON ev.batch_id = b.id
      ORDER BY ev.event_time, b.code`
  ).all();
  return batches.map((b) => buildBatchBalance(db, b));
}

module.exports = {
  ShipmentError,
  ERROR_STATUS,
  createShipment,
  markShipmentsForRetiredRolls,
  getShipment,
  listShipments,
  getBatchBalance,
  listBatchBalances,
  formatShipment
};
