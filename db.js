/**
 * SQLite via sql.js (pure JS — no Visual Studio / node-gyp on Windows)
 */
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

const DB_PATH = path.join(__dirname, "novorte.db");

let SQL = null;
let db = null;

function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function prepare(sql) {
  return {
    run(...params) {
      const isInsert = /^\s*INSERT/i.test(sql);
      db.run(sql, params);
      save();
      const info = {
        lastInsertRowid: isInsert ? Number(db.exec("SELECT last_insert_rowid() AS id")[0]?.values[0][0] || 0) : 0,
        changes: db.getRowsModified()
      };
      return info;
    },
    get(...params) {
      return get(sql, params);
    },
    all(...params) {
      return all(sql, params);
    }
  };
}

async function init() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  address TEXT,
  balance REAL NOT NULL DEFAULT 0,
  invested REAL NOT NULL DEFAULT 0,
  principal REAL NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  plan TEXT,
  plan_started_at INTEGER,
  days_active INTEGER NOT NULL DEFAULT 0,
  admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  invoice_id TEXT,
  payment_id TEXT,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  kind TEXT NOT NULL DEFAULT 'deposit',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  ref TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
`);
  try { db.run("ALTER TABLE payments ADD COLUMN kind TEXT DEFAULT 'deposit'"); } catch (e) {}
  save();

  return { prepare, exec: (sql) => { db.run(sql); save(); } };
}

module.exports = { init };

  return { prepare, exec: (sql) => { db.run(sql); save(); } };
}

module.exports = { init };
