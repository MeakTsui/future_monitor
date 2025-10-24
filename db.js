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
 CREATE TABLE IF NOT EXISTS symbol_volume_score (
   symbol TEXT PRIMARY KEY,
   ts_minute INTEGER,
   volume_ma1 REAL,
   volume_ma2 REAL,
   volume_score REAL,
   updated_at TEXT
 );
 CREATE TABLE IF NOT EXISTS market_volume_score_minute (
   ts_minute INTEGER PRIMARY KEY,
   total_volume_ma1 REAL,
   total_volume_ma2 REAL,
   market_volume_score_2 REAL,
   symbols_count INTEGER,
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

/**
 * 获取所有有流通供应量的币种（用于实时市值计算）
 * @returns {Array<{symbol: string, circulating_supply: number}>}
 */
export function getAllSymbolsWithCirculatingSupply() {
  const stmt = db.prepare(`
    SELECT symbol, circulating_supply 
    FROM supplies 
    WHERE circulating_supply > 0
    ORDER BY symbol
  `);
  return stmt.all();
}

/**
 * 获取指定币种的最近N分钟的 state 数据
 * @param {string} symbol - 币种符号
 * @param {number} minutes - 分钟数（5 或 60）
 * @returns {Array<{ts_minute, price_score, vol_score, symbol_score, weight}>}
 */
export function getSymbolStateMinutesHistory(symbol, minutes) {
  const now = Date.now();
  const startMs = now - minutes * 60 * 1000;
  const stmt = db.prepare(`
    SELECT ts_minute, price_score, vol_score, symbol_score, weight, latest_price
    FROM market_state_symbol_minute 
    WHERE symbol = ? AND ts_minute >= ?
    ORDER BY ts_minute DESC
    LIMIT ?
  `);
  return stmt.all(symbol, startMs, minutes);
}

/**
 * 批量获取多个币种的最近N分钟的 state 数据
 * @param {Array<string>} symbols - 币种符号数组
 * @param {number} minutes - 分钟数（5 或 60）
 * @returns {Map<string, Array>} symbol -> state数据数组
 */
export function getBatchSymbolStateMinutesHistory(symbols, minutes) {
  if (!Array.isArray(symbols) || symbols.length === 0) return new Map();
  
  const now = Date.now();
  const startMs = now - minutes * 60 * 1000;
  
  // 使用 IN 查询批量获取
  const placeholders = symbols.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT symbol, ts_minute, price_score, vol_score, symbol_score, weight, latest_price
    FROM market_state_symbol_minute 
    WHERE symbol IN (${placeholders}) AND ts_minute >= ?
    ORDER BY symbol, ts_minute DESC
  `);
  
  const rows = stmt.all(...symbols, startMs);
  
  // 按 symbol 分组
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.symbol)) {
      result.set(row.symbol, []);
    }
    result.get(row.symbol).push(row);
  }
  
  return result;
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

/**
 * 获取最近一次市场状态计算中的所有币种列表
 * @returns {Array<string>} 币种符号数组
 */
export function getLatestMarketStateSymbols() {
  const latestRow = db.prepare('SELECT MAX(ts_minute) as ts_minute FROM market_state_symbol_minute').get();
  if (!latestRow || !latestRow.ts_minute) return [];
  
  const rows = db.prepare('SELECT DISTINCT symbol FROM market_state_symbol_minute WHERE ts_minute = ?').all(latestRow.ts_minute);
  return rows.map(r => r.symbol);
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

// 计算指定时间窗口的移动平均线（用于图表显示）
// windowMinutes: 窗口大小（分钟）
// from, to: 时间范围（毫秒）
export function calculateMovingAverage(windowMinutes, from, to) {
  const rows = db.prepare('SELECT ts_minute, price_score, volume_score FROM market_state_minute WHERE ts_minute >= ? AND ts_minute <= ? ORDER BY ts_minute ASC')
    .all(from, to);
  
  if (!rows || rows.length === 0) return [];
  
  const result = [];
  const windowMs = windowMinutes * 60 * 1000;
  
  for (let i = 0; i < rows.length; i++) {
    const currentTime = rows[i].ts_minute;
    const windowStart = currentTime - windowMs + 60000; // 包含当前分钟
    
    // 收集窗口内的数据
    let sumPrice = 0;
    let sumVolume = 0;
    let count = 0;
    
    for (let j = i; j >= 0; j--) {
      if (rows[j].ts_minute < windowStart) break;
      if (typeof rows[j].price_score === 'number' && Number.isFinite(rows[j].price_score)) {
        sumPrice += rows[j].price_score;
      }
      if (typeof rows[j].volume_score === 'number' && Number.isFinite(rows[j].volume_score)) {
        sumVolume += rows[j].volume_score;
      }
      count++;
    }
    
    if (count > 0) {
      result.push({
        ts_minute: currentTime,
        price_score: sumPrice / count,
        volume_score: sumVolume / count,
        sample_count: count
      });
    }
  }
  
  return result;
}

// 获取所有交易对列表（从 supplies 表）
export function getAllSymbols() {
  const stmt = db.prepare('SELECT symbol FROM supplies WHERE symbol LIKE "%USDT" ORDER BY symbol');
  return stmt.all().map(row => row.symbol);
}

// 获取告警统计（按币种）
export function getAlertsStatsBySymbol(hours = 24) {
  const since = Date.now() - (hours * 3600 * 1000);
  const stmt = db.prepare(`
    SELECT 
      SUBSTR(key, 1, INSTR(key, ':') - 1) as symbol,
      COUNT(*) as total,
      SUM(CASE WHEN key LIKE '%tier_bypass%' THEN 1 ELSE 0 END) as type2,
      SUM(CASE WHEN key LIKE '%ws_rule3%' THEN 1 ELSE 0 END) as type1
    FROM alerts_state
    WHERE last_at >= ?
    GROUP BY symbol
  `);
  
  const rows = stmt.all(since);
  const result = {};
  rows.forEach(row => {
    result[row.symbol] = {
      total: row.total,
      type1: row.type1,
      type2: row.type2
    };
  });
  return result;
}

// 获取单个币种的告警历史
export function getSymbolAlerts(symbol, hours = 24) {
  const since = Date.now() - (hours * 3600 * 1000);
  const stmt = db.prepare(`
    SELECT 
      key,
      last_at as timestamp,
      last_kline_close as kline_close
    FROM alerts_state
    WHERE key LIKE ? AND last_at >= ?
    ORDER BY last_at DESC
  `);
  
  const rows = stmt.all(`${symbol}:%`, since);
  return rows.map((row, index) => {
    const isTier = row.key.includes('tier_bypass');
    return {
      id: `alert_${index}`,
      symbol: symbol,
      timestamp: row.timestamp,
      kline_close: row.kline_close,
      type: isTier ? '2' : '1',
      reason: row.key
    };
  });
}

// Symbol volume score APIs
export function upsertSymbolVolumeScore({ ts_minute, symbol, volume_ma1, volume_ma2, volume_score }) {
  const stmt = db.prepare(`INSERT INTO symbol_volume_score (
    symbol, ts_minute, volume_ma1, volume_ma2, volume_score, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(symbol) DO UPDATE SET
    ts_minute=excluded.ts_minute,
    volume_ma1=excluded.volume_ma1,
    volume_ma2=excluded.volume_ma2,
    volume_score=excluded.volume_score,
    updated_at=excluded.updated_at`);
  stmt.run(symbol, ts_minute, volume_ma1, volume_ma2, volume_score, new Date().toISOString());
}

export function getLatestSymbolVolumeScore(symbol) {
  const stmt = db.prepare('SELECT * FROM symbol_volume_score WHERE symbol = ?');
  return stmt.get(symbol);
}

export function getLatestSymbolVolumeScores(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];
  const placeholders = symbols.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT * FROM symbol_volume_score 
    WHERE symbol IN (${placeholders})
  `);
  return stmt.all(...symbols);
}

export function getSymbolsWithMarketCapLessThan(maxMarketCap) {
  const stmt = db.prepare(`
    SELECT symbol FROM supplies 
    WHERE market_cap > 0 AND market_cap < ?
    ORDER BY symbol
    LIMIT 500
  `);
  // 将基础资产符号转换为 USDT 永续合约符号
  // 例如：BTC -> BTCUSDT
  return stmt.all(maxMarketCap).map(row => row.symbol + 'USDT');
}

// Market volume score APIs
export function upsertMarketVolumeScore({ ts_minute, total_volume_ma1, total_volume_ma2, market_volume_score_2, symbols_count }) {
  const stmt = db.prepare(`INSERT INTO market_volume_score_minute (
    ts_minute, total_volume_ma1, total_volume_ma2, market_volume_score_2, symbols_count, created_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(ts_minute) DO UPDATE SET
    total_volume_ma1=excluded.total_volume_ma1,
    total_volume_ma2=excluded.total_volume_ma2,
    market_volume_score_2=excluded.market_volume_score_2,
    symbols_count=excluded.symbols_count`);
  stmt.run(ts_minute, total_volume_ma1, total_volume_ma2, market_volume_score_2, symbols_count, new Date().toISOString());
}

export function getLatestMarketVolumeScore() {
  const stmt = db.prepare('SELECT * FROM market_volume_score_minute ORDER BY ts_minute DESC LIMIT 1');
  return stmt.get();
}

export function getMarketVolumeScoreHistory(from, to, limit) {
  let stmt = 'SELECT * FROM market_volume_score_minute WHERE 1=1'
  let params = []

  if (to) {
    stmt += ' and ts_minute <= ?'
    params.push(to)
  }
  if (from) {
    stmt += ' and ts_minute >= ?'
    params.push(from)
  }
  stmt += ' ORDER BY ts_minute ASC'
  if (limit > 0) {
    stmt += ' limit ?'
    params.push(limit)
  }

  return db.prepare(stmt).all(params);
}

export default db;
