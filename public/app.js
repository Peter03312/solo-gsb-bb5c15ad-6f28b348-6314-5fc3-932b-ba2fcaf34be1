'use strict';

let state = { materials: [], equipment: [], events: [], batches: [], label_rolls: [], shipments: [] };
let editingEventId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data;
  return data;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function fmtTime(t) {
  return t ? t.replace('T', ' ') : '—';
}
function allergenTags(list, emptyText = '无过敏原') {
  if (!list || !list.length) return `<span class="tag none">${esc(emptyText)}</span>`;
  return list.map((a) => `<span class="tag">${esc(a)}</span>`).join('');
}
function pathClass(p) {
  if (p.includes('设备残留')) return 'path-res';
  if (p.includes('批次引用')) return 'path-ref';
  return 'path-raw';
}

function notice(type, title, items) {
  const box = $('#notice');
  box.className = `notice ${type}`;
  const list = Array.isArray(items) && items.length
    ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    : (items ? `<div>${esc(items)}</div>` : '');
  box.innerHTML = `<span class="close">×</span><b>${esc(title)}</b>${list}`;
  box.querySelector('.close').onclick = () => box.classList.add('hidden');
  clearTimeout(notice._t);
  if (type === 'ok') notice._t = setTimeout(() => box.classList.add('hidden'), 5000);
}

function reportInvalidated(list) {
  if (Array.isArray(list) && list.length) {
    notice('error', `重算后 ${list.length} 条放行记录已失效`,
      list.map((r) => `${r.batch_code}：${r.reason}`));
  }
}

function reportRetiredRolls(list) {
  if (Array.isArray(list) && list.length) {
    notice('error', `${list.length} 卷过敏原标签已永久停用（余量冻结，已贴数量待复核）`,
      list.map((r) => `${r.roll_code || ('卷#' + r.id)}${r.batch_code ? '（' + r.batch_code + '）' : ''}：${r.reason}`));
  }
}

function reportPendingShipments(list) {
  if (Array.isArray(list) && list.length) {
    notice('error', `${list.length} 笔出货单已标记待评估（终态，不自动恢复）`,
      list.map((s) => `${s.shipment_code || ('出货单#' + s.id)}${s.batch_code ? '（' + s.batch_code + '）' : ''}：${s.reason}`));
  }
}

// ================= 渲染 =================
async function refresh() {
  state = await api('/api/state');
  renderResidue();
  renderBatches();
  renderRolls();
  renderBalances();
  renderShipments();
  renderEvents();
  renderBase();
}

function renderResidue() {
  $('#residueCards').innerHTML = state.equipment.map((q) => `
    <div class="residue-card">
      <h4>${esc(q.name)} <span class="batch-meta">(${esc(q.code)})</span></h4>
      <div class="residue-meta">最后已核实清洗：${q.last_cleaned_at ? esc(fmtTime(q.last_cleaned_at)) : '无记录'}</div>
      ${q.allergens.length
        ? `<div class="tag-row">${allergenTags(q.allergens, '')}</div>
           <details><summary>查看残留来源路径（${Object.values(q.paths).reduce((n, p) => n + p.length, 0)} 条）</summary>
             ${renderPaths(q.paths)}</details>`
        : '<div class="residue-empty">✓ 当前无残留（已清洗或尚未加工）</div>'}
    </div>`).join('');
}

function renderPaths(paths) {
  const keys = Object.keys(paths);
  if (!keys.length) return '';
  return `<div class="paths">${keys.map((a) => `
    <div class="path-block">
      <span class="allergen-name">${esc(a)}</span>
      <ul class="path-list">
        ${paths[a].map((p) => `<li class="${pathClass(p)}">${esc(p)}</li>`).join('')}
      </ul>
    </div>`).join('')}</div>`;
}

function renderBatches() {
  $('#batchList').innerHTML = state.batches.map((b) => {
    const validRelease = (b.releases || []).find((r) => r.status === 'ACTIVE');
    const invalidReleases = (b.releases || []).filter((r) => r.status === 'INVALIDATED');
    return `
    <div class="batch-card">
      <div class="batch-head">
        <span class="batch-code">${esc(b.code)}</span>
        <span class="batch-meta">产出 ${b.produced_at ? esc(fmtTime(b.produced_at)) : '—'} · 设备 ${esc(b.equipment_code || '—')}</span>
        <span class="spacer"></span>
        ${validRelease
          ? '<span class="badge active">放行有效</span>'
          : (invalidReleases.length ? '<span class="badge invalid">放行已失效</span>' : '<span class="tag none">未放行</span>')}
        <button class="btn small primary" onclick="openRelease(${b.id})">登记放行</button>
      </div>
      ${renderBatchRollSummary(b.id)}
      <div style="margin-top:8px" class="tag-row">
        <b style="font-size:12.5px;color:var(--muted)">推导过敏原：</b>${allergenTags(b.allergens)}
      </div>
      ${renderPaths(b.paths)}
      <div class="release-box">
        ${(b.releases || []).map((r) => `
          <div class="release-item ${r.status === 'INVALIDATED' ? 'invalid' : ''}">
            <div class="rl-head">
              <span class="badge ${r.status === 'ACTIVE' ? 'active' : 'invalid'}">
                ${r.status === 'ACTIVE' ? '放行有效' : '已失效'}
              </span>
              <span class="muted">${esc(fmtTime(r.released_at))} · ${esc(r.released_by)}</span>
              <span class="spacer"></span>
              <span class="muted">登记时集合：${r.snapshot_allergens.length ? esc(r.snapshot_allergens.join('、')) : '无'}</span>
              <button class="btn small danger" onclick="deleteRelease(${r.id})">删除</button>
            </div>
            ${r.status === 'INVALIDATED' ? `<div class="invalid-reason">⚠ 失效原因：${esc(r.invalid_reason)}</div>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
  }).join('') || '<div class="batch-meta">尚无批次，请先录入加工事件。</div>';
}

function renderBatchRollSummary(batchId) {
  const rolls = (state.label_rolls || []).filter((r) => r.batch_id === batchId);
  if (!rolls.length) return '';
  const active = rolls.filter((r) => r.active).length;
  const retired = rolls.length - active;
  return `
    <div class="batch-roll-summary" onclick="gotoRolls()">
      📦 标签卷 ${rolls.length} 卷：
      <b>${active}</b> 卷可用${retired ? `，<span class="retired-text">${retired} 卷已停用</span>` : ''}
      <span class="batch-meta">（点击查看印量/贴用/作废/剩余）</span>
    </div>`;
}
window.gotoRolls = function () {
  $$('.tab').find((x) => x.dataset.tab === 'labels').click();
};

function renderRolls() {
  const rolls = state.label_rolls || [];
  if (!rolls.length) {
    $('#rollList').innerHTML = '<div class="batch-meta">尚无标签卷。包装前请先选择“存在有效放行”的批次登记一卷。</div>';
    return;
  }
  // 按批次分组（含批次已删除的孤儿卷）
  const groups = new Map();
  for (const r of rolls) {
    const key = r.batch_id == null ? '__orphan__' : r.batch_id;
    if (!groups.has(key)) groups.set(key, { code: r.batch_code || '（批次已删除）', items: [] });
    groups.get(key).items.push(r);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) =>
    (a[0] === '__orphan__' ? 1 : 0) - (b[0] === '__orphan__' ? 1 : 0) ||
    a[1].code.localeCompare(b[1].code, 'zh'));

  $('#rollList').innerHTML = sortedGroups.map(([, g]) => `
    <div class="roll-group">
      <h3 class="roll-group-title">批次 ${esc(g.code)}</h3>
      ${g.items.map(renderRollCard).join('')}
    </div>`).join('');
}

function renderRollCard(r) {
  return `
  <div class="roll-card ${r.active ? '' : 'retired'}">
    <div class="roll-head">
      <span class="roll-code">${esc(r.roll_code)}</span>
      <span class="badge ${r.active ? 'active' : 'invalid'}">${r.active ? '使用中' : '已永久停用'}</span>
      <span class="batch-meta">登记 ${esc(fmtTime(r.registered_at))} · ${esc(r.registered_by)}</span>
      <span class="spacer"></span>
      <span class="batch-meta">当前修订号 <b>${r.revision}</b></span>
    </div>
    <div class="tag-row" style="margin:8px 0">
      <b class="batch-meta">拟印集合：</b>${allergenTags(r.allergens, '无过敏原')}
      ${r.release_id ? '' : '<span class="tag danger">绑定放行已删除</span>'}
    </div>
    <div class="roll-numbers">
      <div class="roll-num"><span class="n">${r.print_qty}</span><span class="l">印量</span></div>
      <div class="roll-num"><span class="n">${r.applied_qty}</span><span class="l">贴用${r.active ? '' : '（待复核）'}</span></div>
      <div class="roll-num"><span class="n">${r.void_qty}</span><span class="l">作废</span></div>
      <div class="roll-num ${r.active ? 'remain' : 'remain-frozen'}">
        <span class="n">${r.remaining_qty}</span><span class="l">${r.active ? '剩余可贴' : '余量冻结'}</span>
      </div>
    </div>
    ${r.active ? `
      <form class="consume-form" data-roll-id="${r.id}">
        <input type="hidden" name="expected_revision" value="${r.revision}">
        <span class="batch-meta">按修订号 ${r.revision} 核销：</span>
        <label>贴用 <input type="number" name="applied" min="0" step="1" value="0"></label>
        <label>作废 <input type="number" name="voided" min="0" step="1" value="0"></label>
        <label>操作人 <input type="text" name="used_by" placeholder="姓名/工号" class="consume-by"></label>
        <button type="submit" class="btn small primary">核销（整次提交）</button>
      </form>` : `
      <div class="roll-retired-reason">⛔ 停用原因：${esc(r.retired_reason || '—')}</div>
      <div class="batch-meta">已贴 ${r.applied_qty} 张已标记待复核；即使集合后来恢复，本卷也不会自动解冻。</div>`}
  </div>`;
}

function renderEvents() {
  $('#eventList').innerHTML = state.events.map((ev) => {
    const eq = state.equipment.find((q) => q.id === ev.equipment_id);
    let body = '';
    if (ev.type === 'PROCESS') {
      const mats = ev.inputs.filter((i) => i.material_id);
      const refs = ev.inputs.filter((i) => i.ref_batch_id);
      body = `
        <div class="event-inputs"><b>产出：</b>${esc(ev.batch_code || '?')}
          ｜推导过敏原：<span class="tag-row" style="display:inline-flex">${allergenTags(ev.out_allergens)}</span>
        </div>
        <div class="event-inputs"><b>原料：</b>${mats.length ? mats.map((m) => `${esc(m.material_name)}(${esc(m.material_code)})`).join('、') : '—'}
          ｜<b>引用批次：</b>${refs.length ? refs.map((r) => esc(r.ref_batch_code)).join('、') : '—'}</div>`;
    } else {
      body = `<div class="event-inputs"><b>已核实清洗：</b>清空设备残留${ev.note ? `｜${esc(ev.note)}` : ''}</div>`;
    }
    return `
    <div class="event-item ${ev.type === 'CLEAN' ? 'clean' : ''}">
      <div class="event-head">
        <span class="event-time">${esc(fmtTime(ev.event_time))}</span>
        <span class="event-type ${ev.type}">${ev.type === 'PROCESS' ? '加工' : '已核实清洗'}</span>
        <span class="batch-meta">${esc(eq ? `${eq.name}(${eq.code})` : '?')}</span>
        ${ev.type === 'PROCESS' && ev.note ? `<span class="batch-meta">${esc(ev.note)}</span>` : ''}
      </div>
      ${body}
      ${ev.type === 'PROCESS' ? renderPaths(ev.out_paths) : ''}
      <div class="event-actions">
        <button class="btn small" onclick="editEvent(${ev.id})">更正</button>
        <button class="btn small danger" onclick="deleteEvent(${ev.id})">删除</button>
      </div>
    </div>`;
  }).join('') || '<div class="batch-meta">尚无事件。</div>';
}

function renderBase() {
  $('#materialRows').innerHTML = state.materials.map((m) => `
    <tr>
      <td>${esc(m.code)}</td>
      <td>${esc(m.name)}</td>
      <td>${allergenTags(m.allergens, '无')}</td>
      <td class="row-actions">
        <button class="btn small" onclick='editMaterial(${JSON.stringify(m).replace(/'/g, '&#39;')})'>编辑</button>
        <button class="btn small danger" onclick="deleteMaterial(${m.id})">删除</button>
      </td>
    </tr>`).join('');

  $('#equipmentRows').innerHTML = state.equipment.map((q) => `
    <tr>
      <td>${esc(q.code)}</td>
      <td>${esc(q.name)}</td>
      <td class="row-actions">
        <button class="btn small" onclick='editEquipment(${JSON.stringify({ id: q.id, code: q.code, name: q.name }).replace(/'/g, '&#39;')})'>编辑</button>
        <button class="btn small danger" onclick="deleteEquipment(${q.id})">删除</button>
      </td>
    </tr>`).join('');
}

// ================= Tabs =================
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.tab-panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $(`#tab-${t.dataset.tab}`).classList.add('active');
}));

// ================= 事件弹窗 =================
function openEventModal() {
  editingEventId = null;
  $('#eventModalTitle').textContent = '录入事件';
  const form = $('#eventForm');
  form.reset();
  form.event_time.value = new Date().toISOString().slice(0, 16);
  fillEventModalOptions(null);
  $('#processFields').style.display = form.type.value === 'PROCESS' ? 'block' : 'none';
  $('#eventModal').classList.remove('hidden');
}
window.openEventModal = openEventModal;
$('#btnNewEvent').onclick = openEventModal;
$('#btnNewEventTop').onclick = () => {
  $$('.tab').find((x) => x.dataset.tab === 'events').click();
  openEventModal();
};
$('#eventCancel').onclick = () => $('#eventModal').classList.add('hidden');
$('#evType').onchange = (e) => {
  $('#processFields').style.display = e.target.value === 'PROCESS' ? 'block' : 'none';
};
$('#eventForm').addEventListener('input', (e) => {
  if (e.target.name === 'event_time') refreshRefBatchOptions();
});

function fillEventModalOptions(ev) {
  $('#evEquipment').innerHTML = state.equipment
    .map((q) => `<option value="${q.id}" ${ev && ev.equipment_id === q.id ? 'selected' : ''}>${esc(q.name)}（${esc(q.code)}）</option>`)
    .join('');
  $('#evMaterials').innerHTML = state.materials.map((m) => `
    <label><input type="checkbox" name="material_ids" value="${m.id}"
      ${ev && ev.inputs.some((i) => i.material_id === m.id) ? 'checked' : ''}>
      ${esc(m.name)} <span class="batch-meta">[${esc(m.allergens.join('/') || '无过敏原')}]</span></label>`).join('');
  refreshRefBatchOptions(ev);
}

function refreshRefBatchOptions(ev) {
  const t = $('#eventForm').event_time.value;
  const editingBatchId = ev ? ev.batch_id : null;
  // 只列出产出时间严格更早的批次（未来/同时刻由后端强制拒绝）
  const candidates = state.batches.filter((b) => {
    if (b.id === editingBatchId) return false;
    if (ev) {
      // 编辑时已选中的引用即便当前列表时间变化也保留显示
    }
    return b.produced_at && (!t || b.produced_at < t);
  });
  const selected = new Set(ev ? ev.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id) : []);
  // 编辑场景下已引用但时间不再满足的批次也显示，由后端报错提示
  if (ev) {
    for (const b of state.batches) {
      if (selected.has(b.id) && !candidates.includes(b)) candidates.push(b);
    }
  }
  $('#evBatches').innerHTML = candidates.length ? candidates.map((b) => `
    <label><input type="checkbox" name="ref_batch_ids" value="${b.id}" ${selected.has(b.id) ? 'checked' : ''}>
      ${esc(b.code)} <span class="batch-meta">(${esc(fmtTime(b.produced_at))})</span></label>`).join('')
    : '<small class="hint">所选时间之前没有可引用的批次</small>';
}

window.editEvent = function (id) {
  const ev = state.events.find((x) => x.id === id);
  if (!ev) return;
  editingEventId = id;
  $('#eventModalTitle').textContent = `更正事件 #${id}（${ev.type === 'PROCESS' ? '加工' : '已核实清洗'}）`;
  const form = $('#eventForm');
  form.type.value = ev.type;
  form.event_time.value = ev.event_time.length === 16 ? ev.event_time : ev.event_time.slice(0, 16);
  form.note.value = ev.note || '';
  form.batch_code.value = ev.batch_code || '';
  $('#processFields').style.display = ev.type === 'PROCESS' ? 'block' : 'none';
  fillEventModalOptions(ev);
  $('#eventModal').classList.remove('hidden');
};

$('#eventForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    event_time: f.event_time.value,
    type: f.type.value,
    equipment_id: parseInt(f.equipment_id.value, 10),
    note: f.note.value,
    batch_code: f.batch_code.value,
    material_ids: $$('#evMaterials input:checked').map((x) => parseInt(x.value, 10)),
    ref_batch_ids: $$('#evBatches input:checked').map((x) => parseInt(x.value, 10))
  };
  try {
    let r;
    if (editingEventId) {
      r = await api(`/api/events/${editingEventId}`, { method: 'PUT', body });
      notice('ok', '事件已更正，受影响批次与设备残留已重算');
    } else {
      r = await api('/api/events', { method: 'POST', body });
      notice('ok', '事件已录入并完成推导');
    }
    $('#eventModal').classList.add('hidden');
    await refresh();
    if (r.invalidated && r.invalidated.length) reportInvalidated(r.invalidated);
    if (r.retired_rolls && r.retired_rolls.length) reportRetiredRolls(r.retired_rolls);
    reportPendingShipments(r.pending_shipments);
  } catch (err) {
    notice('error', err.error || '提交失败', err.details);
  }
};

window.deleteEvent = async function (id) {
  if (!confirm('确定删除该事件？加工事件会同时删除其产出批次（整次提交仍会完整校验，失败则回滚）。')) return;
  try {
    const r = await api(`/api/events/${id}`, { method: 'DELETE' });
    await refresh();
    notice('ok', '事件已删除并重算');
    reportInvalidated(r.invalidated);
    reportRetiredRolls(r.retired_rolls);
    reportPendingShipments(r.pending_shipments);
  } catch (err) { notice('error', err.error || '删除失败', err.details); }
};

// ================= 原料 / 设备弹窗 =================
$('#btnNewMaterial').onclick = () => {
  const f = $('#materialForm');
  f.reset(); f.id.value = '';
  $('#materialModalTitle').textContent = '新增原料';
  $('#materialModal').classList.remove('hidden');
};
window.editMaterial = (m) => {
  const f = $('#materialForm');
  f.id.value = m.id; f.code.value = m.code; f.name.value = m.name;
  f.allergens.value = m.allergens.join(',');
  $('#materialModalTitle').textContent = '编辑原料';
  $('#materialModal').classList.remove('hidden');
};
$('#materialForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    code: f.code.value, name: f.name.value,
    allergens: f.allergens.value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
  };
  try {
    if (f.id.value) {
      const r = await api(`/api/materials/${f.id.value}`, { method: 'PUT', body });
      await refresh();
      notice('ok', '原料已更新并重算');
      reportInvalidated(r.invalidated);
      reportRetiredRolls(r.retired_rolls);
    reportPendingShipments(r.pending_shipments);
    } else {
      await api('/api/materials', { method: 'POST', body });
      await refresh();
      notice('ok', '原料已新增');
    }
    $('#materialModal').classList.add('hidden');
  } catch (err) { notice('error', err.error || '保存失败', err.details); }
};
window.deleteMaterial = async (id) => {
  if (!confirm('删除该原料？已被事件引用的原料不允许删除。')) return;
  try { await api(`/api/materials/${id}`, { method: 'DELETE' }); await refresh(); }
  catch (err) { notice('error', err.error || '删除失败', err.details); }
};

$('#btnNewEquipment').onclick = () => {
  const f = $('#equipmentForm');
  f.reset(); f.id.value = '';
  $('#equipmentModalTitle').textContent = '新增设备';
  $('#equipmentModal').classList.remove('hidden');
};
window.editEquipment = (q) => {
  const f = $('#equipmentForm');
  f.id.value = q.id; f.code.value = q.code; f.name.value = q.name;
  $('#equipmentModalTitle').textContent = '编辑设备';
  $('#equipmentModal').classList.remove('hidden');
};
$('#equipmentForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { code: f.code.value, name: f.name.value };
  try {
    if (f.id.value) await api(`/api/equipment/${f.id.value}`, { method: 'PUT', body });
    else await api('/api/equipment', { method: 'POST', body });
    $('#equipmentModal').classList.add('hidden');
    await refresh();
  } catch (err) { notice('error', err.error || '保存失败', err.details); }
};
window.deleteEquipment = async (id) => {
  if (!confirm('删除该设备？其下仍有事件时不允许删除。')) return;
  try { await api(`/api/equipment/${id}`, { method: 'DELETE' }); await refresh(); }
  catch (err) { notice('error', err.error || '删除失败', err.details); }
};

$$('[data-close]').forEach((b) => b.onclick = (e) => e.target.closest('.modal').classList.add('hidden'));

// ================= 放行 =================
window.openRelease = function (batchId) {
  const b = state.batches.find((x) => x.id === batchId);
  if (!b) return;
  const f = $('#releaseForm');
  f.batch_id.value = b.id;
  f.batch_code.value = b.code;
  f.released_at.value = new Date().toISOString().slice(0, 16);
  f.released_by.value = '';
  $('#releaseAllergens').innerHTML = allergenTags(b.allergens);
  $('#releaseModal').classList.remove('hidden');
};
$('#releaseForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/releases', {
      method: 'POST',
      body: {
        batch_id: parseInt(f.batch_id.value, 10),
        released_at: f.released_at.value,
        released_by: f.released_by.value
      }
    });
    $('#releaseModal').classList.add('hidden');
    await refresh();
    notice('ok', '放行已按当时推导结果登记');
  } catch (err) { notice('error', err.error || '登记失败', err.details); }
};
window.deleteRelease = async (id) => {
  if (!confirm('删除该放行记录？其名下仍有效的过敏原标签卷将被永久停用（余量冻结、已贴待复核）。')) return;
  try {
    const r = await api(`/api/releases/${id}`, { method: 'DELETE' });
    await refresh();
    notice('ok', '放行记录已删除');
    reportRetiredRolls(r.retired_rolls);
    reportPendingShipments(r.pending_shipments);
  } catch (err) { notice('error', err.error || '删除失败', err.details); }
};

// ================= 过敏原标签卷 =================
function batchesWithActiveRelease() {
  return state.batches.filter((b) => (b.releases || []).some((x) => x.status === 'ACTIVE'));
}

$('#btnNewRoll').onclick = () => {
  const f = $('#rollForm');
  f.reset();
  const candidates = batchesWithActiveRelease();
  $('#rollBatch').innerHTML = candidates.length
    ? candidates.map((b) => `<option value="${b.id}">${esc(b.code)}（${esc(fmtTime(b.produced_at))}）</option>`).join('')
    : '';
  $('#rollCurrent').innerHTML = candidates.length
    ? allergenTags(candidates[0].allergens)
    : '<span class="tag danger">没有存在有效放行的批次；请先在“批次与放行”登记放行</span>';
  fillRollReleaseOptions(candidates[0]);
  if (candidates[0]) {
    $('#rollAllergens').value = candidates[0].allergens.join(',');
  }
  $('#rollModal').classList.remove('hidden');
};

$('#rollBatch').onchange = (e) => {
  const b = state.batches.find((x) => x.id === parseInt(e.target.value, 10));
  $('#rollCurrent').innerHTML = b ? allergenTags(b.allergens) : '';
  fillRollReleaseOptions(b);
  if (b) $('#rollAllergens').value = b.allergens.join(',');
};

function fillRollReleaseOptions(batch) {
  const active = batch ? (batch.releases || []).filter((r) => r.status === 'ACTIVE') : [];
  $('#rollRelease').innerHTML = active.length
    ? active.map((r) => `<option value="${r.id}">${esc(fmtTime(r.released_at))} · ${esc(r.released_by)}｜快照：${esc(r.snapshot_allergens.join('、') || '无过敏原')}</option>`).join('')
    : '';
}

$('#rollRelease').onchange = () => { /* 集合展示不变；三方一致由后端强制 */ };

$('#rollForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const batch_id = parseInt(f.batch_id.value, 10);
  const body = {
    batch_id,
    release_id: parseInt(f.release_id.value, 10),
    allergens: f.allergens_text.value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean),
    print_qty: parseInt(f.print_qty.value, 10),
    registered_by: f.registered_by.value
  };
  try {
    const r = await api('/api/label-rolls', { method: 'POST', body });
    $('#rollModal').classList.add('hidden');
    $$('.tab').find((x) => x.dataset.tab === 'labels').click();
    await refresh();
    notice('ok', `登记成功：卷号 ${r.roll_code}，印量 ${r.print_qty}，可用张数 ${r.remaining_qty}`);
  } catch (err) { notice('error', err.error || '登记失败', err.details); }
};

// 核销（事件委托，动态表单也生效）
$('#rollList').addEventListener('submit', async (e) => {
  const form = e.target.closest('.consume-form');
  if (!form) return;
  e.preventDefault();
  const rollId = form.dataset.rollId;
  const body = {
    expected_revision: parseInt(form.expected_revision.value, 10),
    applied: parseInt(form.applied.value, 10),
    voided: parseInt(form.voided.value, 10),
    used_by: form.used_by.value
  };
  try {
    const r = await api(`/api/label-rolls/${rollId}/consume`, { method: 'POST', body });
    await refresh();
    notice('ok', `核销成功：${r.roll_code} 新修订号 ${r.revision}，剩余可贴 ${r.remaining_qty} 张`);
  } catch (err) {
    notice('error', err.error || '核销被拒绝', err.details);
    await refresh(); // 修订号可能已被他人推进，刷新表单
  }
});

// ================= 包装出货 =================
// 本地计算与 /api/batches/:id/shipment-balance 相同口径的卷余额（基于 state 中的出货明细）。
function rollAllocationMap() {
  const map = new Map();
  for (const s of state.shipments || []) {
    for (const it of s.items || []) {
      if (it.roll_id == null) continue;
      map.set(it.roll_id, (map.get(it.roll_id) || 0) + it.alloc_qty);
    }
  }
  return map;
}

function computeBalances() {
  const allocMap = rollAllocationMap();
  const byBatch = new Map();
  for (const b of state.batches) byBatch.set(b.id, { batch: b, rolls: [] });
  for (const r of state.label_rolls || []) {
    if (!byBatch.has(r.batch_id)) continue;
    const allocated = allocMap.get(r.id) || 0;
    byBatch.get(r.batch_id).rolls.push({
      roll_id: r.id, roll_code: r.roll_code, status: r.status, active: r.active,
      revision: r.revision, release_id: r.release_id,
      applied_qty: r.applied_qty, allocated_qty: allocated,
      shippable_qty: r.active ? Math.max(r.applied_qty - allocated, 0) : 0,
      frozen_qty: r.active ? 0 : Math.max(r.applied_qty - allocated, 0),
      retired_reason: r.retired_reason
    });
  }
  const out = [];
  for (const { batch, rolls } of byBatch.values()) {
    out.push({
      batch_id: batch.id, batch_code: batch.code, produced_at: batch.produced_at,
      shippable_qty: rolls.filter((r) => r.active).reduce((n, r) => n + r.shippable_qty, 0),
      allocated_qty: rolls.reduce((n, r) => n + r.allocated_qty, 0),
      active_rolls: rolls.filter((r) => r.active).length,
      retired_rolls: rolls.length - rolls.filter((r) => r.active).length,
      rolls
    });
  }
  return out;
}

function renderBalances() {
  const balances = computeBalances();
  $('#balanceList').innerHTML = balances.map((b) => `
    <div class="balance-card ${b.shippable_qty === 0 ? 'empty' : ''}">
      <div class="balance-head">
        <span class="batch-code">${esc(b.batch_code)}</span>
        <span class="batch-meta">${b.produced_at ? esc(fmtTime(b.produced_at)) : '尚无加工'}</span>
        <span class="spacer"></span>
        <span class="balance-total ${b.shippable_qty === 0 ? 'zero' : ''}">
          批次可出货余额 <b>${b.shippable_qty}</b> 张
        </span>
        <span class="batch-meta">累计已分配 ${b.allocated_qty} 张 ·
          ${b.active_rolls} 卷可用${b.retired_rolls ? ` · <span class="retired-text">${b.retired_rolls} 卷停用</span>` : ''}
        </span>
      </div>
      ${b.rolls.length ? `<div class="balance-rolls">${b.rolls.map((r) => `
        <div class="balance-roll ${r.active ? '' : 'retired'}">
          <span class="roll-code">${esc(r.roll_code)}</span>
          <span class="badge ${r.active ? 'active' : 'invalid'}">${r.active ? '未停用' : '已停用'}</span>
          <span class="num">已贴用 ${r.applied_qty}</span>
          <span class="num">已分配 ${r.allocated_qty}</span>
          <span class="num">${r.active ? `可出货 ${r.shippable_qty}` : `冻结 ${r.frozen_qty}`}</span>
          <span class="spacer"></span>
          ${r.active ? '' : `<span class="batch-meta">${esc(r.retired_reason || '已停用')}</span>`}
        </div>`).join('')}</div>`
        : '<div class="batch-meta" style="margin-top:6px">该批次尚无标签卷。</div>'}
    </div>`).join('');
}

function renderShipments() {
  const list = (state.shipments || []).slice()
    .sort((a, b) => (b.shipped_at || '').localeCompare(a.shipped_at || '') || b.id - a.id);
  if (!list.length) {
    $('#shipmentList').innerHTML = '<div class="batch-meta">尚无出货单。</div>';
    return;
  }
  $('#shipmentList').innerHTML = list.map((s) => `
    <div class="shipment-card ${s.pending_review ? 'pending' : ''}">
      <div class="shipment-head">
        <span class="shipment-code">${esc(s.shipment_code)}</span>
        <span class="batch-meta">批次 ${esc(s.batch_code)}</span>
        <span class="badge ${s.status === 'CONFIRMED' ? 'active' : 'invalid'}">
          ${s.status === 'CONFIRMED' ? '已确认' : '待评估'}
        </span>
        <span class="batch-meta">${esc(fmtTime(s.shipped_at))} · ${esc(s.shipped_by)}</span>
        <span class="spacer"></span>
        <span class="batch-meta">出货量 <b>${s.ship_qty}</b> 张</span>
      </div>
      <div class="shipment-items">
        <table>
          <thead><tr><th>卷号（出货当时）</th><th>分配张数</th><th>放行标识</th><th>过敏原集合</th><th>卷修订号</th></tr></thead>
          <tbody>${(s.items || []).map((it) => `
            <tr>
              <td>${esc(it.roll_code)}</td>
              <td class="num">${it.alloc_qty}</td>
              <td class="num">放行 #${it.release_id == null ? '（已删除）' : it.release_id}</td>
              <td>${esc((it.allergens || []).join('、') || '无过敏原')}</td>
              <td class="num">${it.roll_revision}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${s.pending_review ? `<div class="review-reason">⛔ 待评估原因：${esc(s.review_reason || '—')}</div>` : ''}
    </div>`).join('');
}

$('#btnNewShipment').onclick = () => {
  const f = $('#shipmentForm');
  f.reset();
  fillShipmentModal();
  updateShipTotal();
  $('#shipmentModal').classList.remove('hidden');
};

function fillShipmentModal() {
  const balances = computeBalances();
  const options = balances
    .filter((b) => b.rolls.some((r) => r.active && r.shippable_qty > 0))
    .map((b) => `<option value="${b.batch_id}">${esc(b.batch_code)}（可出货 ${b.shippable_qty} 张）</option>`)
    .join('');
  $('#shipBatch').innerHTML = options || '';
  renderShipItems();
}

$('#shipBatch').onchange = renderShipItems;

function currentShipBalance() {
  const batchId = parseInt($('#shipBatch').value, 10);
  return computeBalances().find((b) => b.batch_id === batchId) || null;
}

function renderShipItems() {
  const b = currentShipBalance();
  if (!b) {
    $('#shipBalance').innerHTML = '<span class="tag danger">没有可出货的批次（需要存在未停用、绑定有效放行且有已贴张数的卷）</span>';
    $('#shipItems').innerHTML = '';
    updateShipTotal();
    return;
  }
  $('#shipBalance').innerHTML = b.rolls.map((r) => `
    <div class="bal-line ${r.active ? '' : 'retired-text'}">
      ${esc(r.roll_code)}：已贴用 ${r.applied_qty}，已分配 ${r.allocated_qty}，
      <b>${r.active ? `可出货 ${r.shippable_qty}` : `已停用，${r.frozen_qty} 张冻结`}</b>
    </div>`).join('');
  $('#shipItems').innerHTML = b.rolls.map((r) => {
    if (!r.active) {
      return `<div class="ship-item-row disabled">
        <span class="roll-code">${esc(r.roll_code)}</span>
        <span class="badge invalid">已停用，不可分配</span>
        <span class="spacer"></span><span>${esc(r.retired_reason || '')}</span></div>`;
    }
    return `<div class="ship-item-row" data-roll-id="${r.roll_id}" data-ship-max="${r.shippable_qty}">
      <span class="roll-code">${esc(r.roll_code)}</span>
      <label>分配 <input type="number" class="alloc-input" min="0" max="${r.shippable_qty}" step="1" value="0"></label>
      <span class="spacer"></span><span class="batch-meta">最多可分配 ${r.shippable_qty} 张</span><span class="alloc-state"></span>
    </div>`;
  }).join('');
  updateShipTotal();
}

$('#shipItems').addEventListener('input', (e) => {
  if (!e.target.classList.contains('alloc-input')) return;
  const row = e.target.closest('.ship-item-row');
  const max = parseInt(row.dataset.shipMax, 10);
  const v = parseInt(e.target.value, 10) || 0;
  const stateEl = row.querySelector('.alloc-state');
  if (v < 0) stateEl.innerHTML = '<span class="over">不可为负</span>';
  else if (v > max) stateEl.innerHTML = `<span class="over">超出可出货 ${max} 张</span>`;
  else if (v > 0) stateEl.innerHTML = '<span class="ok">✓</span>';
  else stateEl.innerHTML = '';
  updateShipTotal();
});

function updateShipTotal() {
  const total = $$('#shipItems .alloc-input').reduce((n, el) => n + (parseInt(el.value, 10) || 0), 0);
  $('#shipTotal').textContent = total;
}

$('#shipmentForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const batch_id = parseInt(f.batch_id.value, 10);
  const items = $$('#shipItems .ship-item-row[data-roll-id]').map((row) => ({
    roll_id: parseInt(row.dataset.rollId, 10),
    alloc_qty: parseInt(row.querySelector('.alloc-input').value, 10) || 0
  })).filter((x) => x.alloc_qty > 0);
  try {
    const r = await api('/api/shipments', {
      method: 'POST',
      body: {
        batch_id,
        ship_qty: parseInt(f.ship_qty.value, 10),
        items,
        shipped_by: f.shipped_by.value
      }
    });
    $('#shipmentModal').classList.add('hidden');
    await refresh();
    notice('ok', `出货确认：出货单号 ${r.shipment_code}，状态${r.status === 'CONFIRMED' ? '已确认' : '待评估'}，出货 ${r.ship_qty} 张`);
  } catch (err) { notice('error', err.error || '出货被整单拒绝', err.details); }
};

// ================= 启动 =================
refresh().catch((err) => notice('error', '加载状态失败', err.message || String(err)));
