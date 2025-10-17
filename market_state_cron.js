// 市场状态定时任务 - 每分钟计算并保存市场状态
import fs from "fs";
import fetch from "node-fetch";
import logger from "./logger.js";
import { computeMarketStateRealtime } from "./market_state_calculator.js";
import { upsertMarketStateMinute, upsertMarketStateSymbolMinute } from "./db.js";

// Config
const CONFIG_FILE = "./config.json";
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

// 从 Binance API 获取 K 线数据
async function fetchKlines(symbol, interval = '1m', limit = 100, restBaseUrl = 'https://fapi.binance.com') {
  const url = `${restBaseUrl}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn({ symbol, status: resp.status }, 'fetchKlines 失败');
      return [];
    }
    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    
    // 转换为标准格式: { openTime, open, low, close, volume }
    return data.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[7]), // quote asset volume (USDT)
    }));
  } catch (e) {
    logger.warn({ symbol, err: e.message }, 'fetchKlines 异常');
    return [];
  }
}

// 数据读取器：从 Binance API 获取窗口数据
class BinanceKlineReader {
  constructor(restBaseUrl = 'https://fapi.binance.com') {
    this.restBaseUrl = restBaseUrl;
    this.cache = new Map(); // symbol -> { data, fetchedAt }
    this.cacheTTL = 50000; // 50秒缓存，避免频繁请求
  }

  async getWindow(symbol) {
    const now = Date.now();
    const cached = this.cache.get(symbol);
    
    // 使用缓存
    if (cached && (now - cached.fetchedAt < this.cacheTTL)) {
      return cached.data;
    }

    // 获取新数据
    const data = await fetchKlines(symbol, '1m', 100, this.restBaseUrl);
    this.cache.set(symbol, { data, fetchedAt: now });
    return data;
  }

  clearCache() {
    this.cache.clear();
  }
}

// 定时任务主函数
async function runMarketStateCalculation() {
  try {
    const config = loadConfig();
    const restBaseUrl = (config.rule3ws && config.rule3ws.restBaseUrl) || 'https://fapi.binance.com';
    
    const reader = new BinanceKlineReader(restBaseUrl);
    const tsMs = Date.now();
    
    logger.info({ ts: tsMs }, '开始计算市场状态');
    
    // 计算市场状态
    const result = await computeMarketStateRealtime(tsMs, reader);
    
    if (!result) {
      logger.warn('计算市场状态失败：返回空结果');
      return;
    }

    const { ts, price_score, volume_score, state, state_text, rows } = result;
    
    // 保存到数据库
    const ts_minute = Math.floor(ts / 60000) * 60000; // 对齐到分钟
    
    upsertMarketStateMinute({
      ts_minute,
      price_score,
      volume_score,
      state: state_text,
      details_version: 2, // 新版本标识
    });

    // 保存详细数据
    if (Array.isArray(rows)) {
      for (const row of rows) {
        upsertMarketStateSymbolMinute({
          ts_minute,
          symbol: row.symbol,
          price_score: row.price_score,
          vol_score: row.vol_score,
          symbol_score: row.symbol_score,
          weight: row.weight,
          latest_price: row.latest_price,
          open_price_5m: row.open_price_5m,
          vol_5m: row.vol_5m,
          avg_vol_5m_5h: row.avg_vol_5m_5h,
        });
      }
    }

    logger.info({ 
      ts_minute, 
      price_score: price_score.toFixed(2), 
      volume_score: volume_score.toFixed(2),
      symbols_count: rows ? rows.length : 0 
    }, '市场状态计算完成并保存');

  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, '市场状态计算任务异常');
  }
}

// 启动定时任务
async function main() {
  const config = loadConfig();
  if (config.logLevel) {
    try { logger.level = config.logLevel; } catch {}
  }

  logger.info('市场状态定时任务启动');

  // 立即执行一次
  await runMarketStateCalculation();

  // 每分钟执行一次
  setInterval(async () => {
    await runMarketStateCalculation();
  }, 60000);
}

main().catch(err => {
  logger.error({ err: err.message }, "market_state_cron 运行失败");
  process.exit(1);
});
