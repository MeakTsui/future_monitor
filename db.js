import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_FILE = path.resolve('./data.sqlite');

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDirExists(DB_FILE);
const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS supplies (
  symbol TEXT PRIMARY KEY,
  name TEXT,
  circulating_supply REAL,
  market_cap REAL,
  total_supply REAL,
  max_supply REAL,
  volume_24h_usd REAL,
  fully_diluted_market_cap REAL,
  rank INTEGER,
  last_updated TEXT
);

CREATE TABLE IF NOT EXISTS alerts_state (
  key TEXT PRIMARY KEY,
  last_at INTEGER,
  last_kline_close INTEGER
);

CREATE TABLE IF NOT EXISTS sync_state (
  name TEXT PRIMARY KEY,
  state TEXT,
  updated_at TEXT
);
`);

// Supplies API
export function upsertSupply(entry) {
  const stmt = db.prepare(`INSERT INTO supplies (
    symbol, name, circulating_supply, market_cap, total_supply, max_supply,
    volume_24h_usd, fully_diluted_market_cap, rank, last_updated
  ) VALUES (@symbol, @name, @circulating_supply, @market_cap, @total_supply, @max_supply, @volume_24h_usd, @fully_diluted_market_cap, @rank, @last_updated)
  ON CONFLICT(symbol) DO UPDATE SET
    name=excluded.name,
    circulating_supply=excluded.circulating_supply,
    market_cap=excluded.market_cap,
    total_supply=excluded.total_supply,
    max_supply=excluded.max_supply,
    volume_24h_usd=excluded.volume_24h_usd,
    fully_diluted_market_cap=excluded.fully_diluted_market_cap,
    rank=excluded.rank,
    last_updated=excluded.last_updated
  `);
  stmt.run(entry);
}

export function getSupplyBySymbol(symbol) {
  const stmt = db.prepare('SELECT * FROM supplies WHERE symbol = ?');
  return stmt.get(symbol.toUpperCase());
}

export function getAllSuppliesMap() {
  const rows = db.prepare('SELECT * FROM supplies').all();
  const map = {};
  for (const r of rows) {
    map[r.symbol] = r;
  }
  return map;
}

// Alerts state API
export function getAlertState(key) {
  const stmt = db.prepare('SELECT * FROM alerts_state WHERE key = ?');
  return stmt.get(key) || null;
}

export function setAlertState(key, last_at, last_kline_close) {
  const stmt = db.prepare(`INSERT INTO alerts_state (key, last_at, last_kline_close)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET last_at=excluded.last_at, last_kline_close=excluded.last_kline_close`);
  stmt.run(key, last_at, last_kline_close);
}

// Sync state API (generic JSON state)
export function getSyncState(name) {
  const row = db.prepare('SELECT state FROM sync_state WHERE name = ?').get(name);
  if (!row) return null;
  try { return JSON.parse(row.state); } catch { return null; }
}

export function setSyncState(name, state) {
  const json = JSON.stringify(state);
  const stmt = db.prepare(`INSERT INTO sync_state (name, state, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`);
  stmt.run(name, json, new Date().toISOString());
}

export default db;
