'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'allergen.db');

let db;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initDbFile() {
  const d = getDb();
  return d;
}

function initSchema(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    allergens TEXT NOT NULL DEFAULT '[]'  -- JSON 字符串数组
  );

  CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_time TEXT NOT NULL,          -- ISO 字符串，如 2026-09-30T08:00
    type TEXT NOT NULL CHECK (type IN ('PROCESS','CLEAN')),
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    batch_id INTEGER UNIQUE REFERENCES batches(id), -- PROCESS 时唯一
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS process_inputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    material_id INTEGER REFERENCES materials(id),
    batch_id INTEGER REFERENCES batches(id),
    CHECK ((material_id IS NOT NULL AND batch_id IS NULL)
        OR (material_id IS NULL AND batch_id IS NOT NULL))
  );

  -- 重算结果（派生数据，随事件变更全量刷新）
  CREATE TABLE IF NOT EXISTS batch_outputs (
    batch_id INTEGER PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
    allergens TEXT NOT NULL DEFAULT '[]',
    paths_json TEXT NOT NULL DEFAULT '[]'
  );

  -- 设备当前残留（最后一次已核实清洗之后的累积）
  CREATE TABLE IF NOT EXISTS equipment_residue (
    equipment_id INTEGER PRIMARY KEY REFERENCES equipment(id) ON DELETE CASCADE,
    allergens TEXT NOT NULL DEFAULT '[]',
    paths_json TEXT NOT NULL DEFAULT '[]',
    last_cleaned_at TEXT
  );

  CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    released_at TEXT NOT NULL,
    released_by TEXT NOT NULL DEFAULT '',
    snapshot_allergens TEXT NOT NULL DEFAULT '[]',  -- 登记当时的过敏原集合（排序）
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','INVALIDATED')),
    invalid_reason TEXT NOT NULL DEFAULT '',
    created_event_seq INTEGER NOT NULL DEFAULT 0  -- 登记时的事件版本号
  );

  -- 过敏原标签卷：包装前按“当前批次推导集合 ∩ 所选有效放行快照”一致后登记一卷。
  -- 卷一旦停用（status='RETIRED'）为终态：余量不可再贴，即使集合后来恢复也不自动解冻。
  CREATE TABLE IF NOT EXISTS label_rolls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_code TEXT NOT NULL UNIQUE,         -- 卷号，如 LABEL-0001（登记事务内补发）
    batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL,
    print_qty INTEGER NOT NULL CHECK (print_qty > 0),  -- 印量（正整数张数）
    applied_qty INTEGER NOT NULL DEFAULT 0 CHECK (applied_qty >= 0), -- 已贴用
    void_qty INTEGER NOT NULL DEFAULT 0 CHECK (void_qty >= 0),       -- 已作废
    revision INTEGER NOT NULL DEFAULT 0,    -- 核销修订号（乐观并发：每次核销 +1）
    allergen_set TEXT NOT NULL DEFAULT '[]',-- 拟印过敏原集合（规范化排序 JSON）
    registered_at TEXT NOT NULL,
    registered_by TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
    retired_reason TEXT NOT NULL DEFAULT '', -- 停用原因（终态留痕）
    CHECK (applied_qty + void_qty <= print_qty)
  );

  -- 标签卷核销流水：贴用 / 作废按修订号核销，整次事务化。
  CREATE TABLE IF NOT EXISTS label_roll_usages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_id INTEGER NOT NULL REFERENCES label_rolls(id) ON DELETE CASCADE,
    used_at TEXT NOT NULL,
    applied_qty INTEGER NOT NULL CHECK (applied_qty >= 0),
    void_qty INTEGER NOT NULL CHECK (void_qty >= 0),
    expected_revision INTEGER NOT NULL,     -- 客户端核销时依据的修订号
    used_by TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_time, id);
  CREATE INDEX IF NOT EXISTS idx_process_inputs_event ON process_inputs(event_id);
  CREATE INDEX IF NOT EXISTS idx_releases_batch ON releases(batch_id);
  CREATE INDEX IF NOT EXISTS idx_label_rolls_batch ON label_rolls(batch_id);
  CREATE INDEX IF NOT EXISTS idx_label_usages_roll ON label_roll_usages(roll_id);
  `);
}

module.exports = { getDb, initDbFile, initSchema, DB_PATH };
