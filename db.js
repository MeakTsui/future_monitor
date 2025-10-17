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
 CREATE TABLE IF NOT EXISTS market_state_minute (
   ts_minute INTEGER PRIMARY KEY,
   price_score REAL,
   volume_score REAL,
   state TEXT,
   details_version INTEGER,
   created_at TEXT
 );
 CREATE TABLE IF NOT EXISTS market_state_symbol_minute (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   ts_minute INTEGER,
   symbol TEXT,
   price_score REAL,
   vol_score REAL,
   symbol_score REAL,
   weight REAL,
   latest_price REAL,
   open_price_5m REAL,
   vol_5m REAL,
   avg_vol_5m_5h REAL,
   created_at TEXT,
   UNIQUE(ts_minute, symbol)
 );
 CREATE TABLE IF NOT EXISTS universe_selection_daily (
   date TEXT PRIMARY KEY,
   symbols_ranked TEXT,
   selected_51_130 TEXT,
   created_at TEXT
 );
 CREATE TABLE IF NOT EXISTS market_avg_vol_5m_5h_hourly (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   ts_hour INTEGER,
   symbol TEXT,
   avg_vol_5m_5h REAL,
   created_at TEXT,
   UNIQUE(ts_hour, symbol)
 );
 CREATE TABLE IF NOT EXISTS universe_selection_snapshot (
   ts_period INTEGER PRIMARY KEY,
   symbols_ranked TEXT,
   selected_51_130 TEXT,
   created_at TEXT
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

// Market state APIs
export function upsertMarketStateMinute({ ts_minute, price_score, volume_score, state, details_version = 1 }) {
  const stmt = db.prepare(`INSERT INTO market_state_minute (ts_minute, price_score, volume_score, state, details_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ts_minute) DO UPDATE SET price_score=excluded.price_score, volume_score=excluded.volume_score, state=excluded.state, details_version=excluded.details_version`);
  stmt.run(ts_minute, price_score, volume_score, state, details_version, new Date().toISOString());
}

export function upsertMarketStateSymbolMinute(row) {
  const stmt = db.prepare(`INSERT INTO market_state_symbol_minute (
      ts_minute, symbol, price_score, vol_score, symbol_score, weight,
      latest_price, open_price_5m, vol_5m, avg_vol_5m_5h, created_at
    ) VALUES (
      @ts_minute, @symbol, @price_score, @vol_score, @symbol_score, @weight,
      @latest_price, @open_price_5m, @vol_5m, @avg_vol_5m_5h, @created_at
    )
    ON CONFLICT(ts_minute, symbol) DO UPDATE SET
      price_score=excluded.price_score,
      vol_score=excluded.vol_score,
      symbol_score=excluded.symbol_score,
      weight=excluded.weight,
      latest_price=excluded.latest_price,
      open_price_5m=excluded.open_price_5m,
      vol_5m=excluded.vol_5m,
      avg_vol_5m_5h=excluded.avg_vol_5m_5h`);
  const payload = { ...row, created_at: row.created_at || new Date().toISOString() };
  stmt.run(payload);
}

export function getLatestMarketState() {
  const row = db.prepare('SELECT * FROM market_state_minute ORDER BY ts_minute DESC LIMIT 1').get();
  return row || null;
}

export function getLatestMarketStateMinute() {
  const row = db.prepare('SELECT * FROM market_state_minute ORDER BY ts_minute DESC LIMIT 1').get();
  return row || null;
}

export function getMarketStateMinuteLast5Min() {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;
  const rows = db.prepare('SELECT * FROM market_state_minute WHERE ts_minute >= ? ORDER BY ts_minute DESC LIMIT 5').all(fiveMinAgo);
  
  if (!rows || rows.length === 0) return null;
  
  // 计算均值
  let sumPrice = 0;
  let sumVolume = 0;
  let count = 0;
  
  for (const row of rows) {
    if (typeof row.price_score === 'number' && Number.isFinite(row.price_score)) {
      sumPrice += row.price_score;
    }
    if (typeof row.volume_score === 'number' && Number.isFinite(row.volume_score)) {
      sumVolume += row.volume_score;
    }
    count++;
  }
  
  if (count === 0) return null;
  
  return {
    price_score: sumPrice / count,
    volume_score: sumVolume / count,
    state: rows[0].state, // 使用最新的 state
    count: count,
    latest_ts: rows[0].ts_minute
  };
}

export function getMarketStateMinuteLast1Hour() {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const rows = db.prepare('SELECT * FROM market_state_minute WHERE ts_minute >= ? ORDER BY ts_minute DESC LIMIT 60').all(oneHourAgo);
  
  if (!rows || rows.length === 0) return null;
  
  // 计算均值
  let sumPrice = 0;
  let sumVolume = 0;
  let count = 0;
  
  for (const row of rows) {
    if (typeof row.price_score === 'number' && Number.isFinite(row.price_score)) {
      sumPrice += row.price_score;
    }
    if (typeof row.volume_score === 'number' && Number.isFinite(row.volume_score)) {
      sumVolume += row.volume_score;
    }
    count++;
  }
  
  if (count === 0) return null;
  
  return {
    price_score: sumPrice / count,
    volume_score: sumVolume / count,
    state: rows[0].state, // 使用最新的 state
    count: count,
    latest_ts: rows[0].ts_minute
  };
}

export function getMarketStateHistory(from, to, limit = 1000) {
  if (from && to) {
    return db.prepare('SELECT * FROM market_state_minute WHERE ts_minute >= ? AND ts_minute <= ? ORDER BY ts_minute ASC LIMIT ?')
      .all(from, to, limit);
  }
  if (from) {
    return db.prepare('SELECT * FROM market_state_minute WHERE ts_minute >= ? ORDER BY ts_minute ASC LIMIT ?')
      .all(from, limit);
  }
  return db.prepare('SELECT * FROM market_state_minute ORDER BY ts_minute ASC LIMIT ?').all(limit);
}

export function getMarketStateDetails(ts_minute) {
  return db.prepare('SELECT * FROM market_state_symbol_minute WHERE ts_minute = ? ORDER BY symbol ASC').all(ts_minute);
}

// Daily universe APIs
export function getUniverseByDate(date) {
  const row = db.prepare('SELECT * FROM universe_selection_daily WHERE date = ?').get(date);
  if (!row) return null;
  return {
    date: row.date,
    symbols_ranked: safeJSON(row.symbols_ranked, []),
    selected_51_130: safeJSON(row.selected_51_130, []),
    created_at: row.created_at,
  };
}

export function saveUniverse({ date, symbols_ranked, selected_51_130 }) {
  const stmt = db.prepare(`INSERT INTO universe_selection_daily (date, symbols_ranked, selected_51_130, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET symbols_ranked=excluded.symbols_ranked, selected_51_130=excluded.selected_51_130`);
  stmt.run(date, JSON.stringify(symbols_ranked || []), JSON.stringify(selected_51_130 || []), new Date().toISOString());
}

function safeJSON(s, d) {
  try { return JSON.parse(s); } catch { return d; }
}

// Hourly avg_vol_5m_5h APIs
export function upsertAvgVolHourly({ ts_hour, symbol, avg_vol_5m_5h }) {
  const stmt = db.prepare(`INSERT INTO market_avg_vol_5m_5h_hourly (ts_hour, symbol, avg_vol_5m_5h, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ts_hour, symbol) DO UPDATE SET avg_vol_5m_5h=excluded.avg_vol_5m_5h`);
  stmt.run(ts_hour, symbol, avg_vol_5m_5h, new Date().toISOString());
}

export function getAvgVolMapForLatestHourBefore(ts_minute) {
  const row = db.prepare('SELECT MAX(ts_hour) AS ts_hour FROM market_avg_vol_5m_5h_hourly WHERE ts_hour <= ?').get(ts_minute);
  if (!row || !row.ts_hour) return { ts_hour: null, map: {} };
  const tsHour = row.ts_hour;
  const rows = db.prepare('SELECT symbol, avg_vol_5m_5h FROM market_avg_vol_5m_5h_hourly WHERE ts_hour = ?').all(tsHour);
  const map = {};
  for (const r of rows) map[r.symbol] = r.avg_vol_5m_5h;
  return { ts_hour: tsHour, map };
}

// Universe snapshot APIs
export function saveUniverseSnapshot({ ts_period, symbols_ranked, selected_51_130 }) {
  const stmt = db.prepare(`INSERT INTO universe_selection_snapshot (ts_period, symbols_ranked, selected_51_130, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ts_period) DO UPDATE SET symbols_ranked=excluded.symbols_ranked, selected_51_130=excluded.selected_51_130`);
  stmt.run(ts_period, JSON.stringify(symbols_ranked || []), JSON.stringify(selected_51_130 || []), new Date().toISOString());
}

export function getLatestUniverseSnapshotBefore(ts_minute) {
  const row = db.prepare('SELECT MAX(ts_period) AS ts_period FROM universe_selection_snapshot WHERE ts_period <= ?').get(ts_minute);
  if (!row || !row.ts_period) return { ts_period: null, selected_51_130: [], symbols_ranked: [] };
  const snap = db.prepare('SELECT symbols_ranked, selected_51_130 FROM universe_selection_snapshot WHERE ts_period = ?').get(row.ts_period);
  return {
    ts_period: row.ts_period,
    symbols_ranked: safeJSON(snap.symbols_ranked, []),
    selected_51_130: safeJSON(snap.selected_51_130, []),
  };
}

export default db;
