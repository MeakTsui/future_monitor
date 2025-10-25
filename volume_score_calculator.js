import fs from 'fs';
import fetch from 'node-fetch';
import logger from './logger.js';
import {
  upsertSymbolVolumeScore,
  getLatestSymbolVolumeScores,
  getSymbolsWithMarketCapLessThan,
  upsertMarketVolumeScore,
} from './db.js';

// 配置文件
const CONFIG_FILE = './config.json';
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    logger.error({ err: e.message }, '加载配置文件失败');
    return {};
  }
}

// 获取所有交易中的 USDT 永续合约
async function fetchAllTradingSymbols() {
  try {
    const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.error({ status: resp.status }, '获取交易对列表失败');
      return [];
    }
    const data = await resp.json();
    const symbols = data.symbols
      .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL')
      .map(s => s.symbol);
    logger.info({ count: symbols.length }, '获取交易对列表成功');
    return symbols;
  } catch (e) {
    logger.error({ err: e.message }, '获取交易对列表异常');
    return [];
  }
}

// Binance 支持的 K 线周期（分钟数 -> interval 符号）
const SUPPORTED_INTERVALS = [
  { minutes: 1, symbol: '1m' },
  { minutes: 3, symbol: '3m' },
  { minutes: 5, symbol: '5m' },
  { minutes: 15, symbol: '15m' },
  { minutes: 30, symbol: '30m' },
  { minutes: 60, symbol: '1h' },
  { minutes: 120, symbol: '2h' },
  { minutes: 240, symbol: '4h' },
  { minutes: 360, symbol: '6h' },
  { minutes: 480, symbol: '8h' },
  { minutes: 720, symbol: '12h' },
  { minutes: 1440, symbol: '1d' },
  { minutes: 4320, symbol: '3d' },
  { minutes: 10080, symbol: '1w' },
  { minutes: 43200, symbol: '1M' },
];

// 根据分钟数自动选择最优的 K 线周期（减少 API 权重）
// 优先选择能整除的最大周期
function selectOptimalInterval(minutes) {
  // 从大到小尝试，选择能整除的最大周期
  const intervals = [
    { minutes: 43200, symbol: '1M' },
    { minutes: 10080, symbol: '1w' },
    { minutes: 4320, symbol: '3d' },
    { minutes: 1440, symbol: '1d' },
    { minutes: 720, symbol: '12h' },
    { minutes: 480, symbol: '8h' },
    { minutes: 360, symbol: '6h' },
    { minutes: 240, symbol: '4h' },
    { minutes: 120, symbol: '2h' },
    { minutes: 60, symbol: '1h' },
    { minutes: 30, symbol: '30m' },
    { minutes: 15, symbol: '15m' },
    { minutes: 5, symbol: '5m' },
    { minutes: 3, symbol: '3m' },
    { minutes: 1, symbol: '1m' },
  ];
  
  // 找到能整除的最大周期
  for (const interval of intervals) {
    if (minutes % interval.minutes === 0 && minutes >= interval.minutes) {
      return {
        interval: interval.symbol,
        intervalMinutes: interval.minutes,
        count: minutes / interval.minutes
      };
    }
  }
  
  // 默认用 1 分钟
  return { interval: '1m', intervalMinutes: 1, count: minutes };
}

// 通用 K 线获取函数
async function fetchKlines(symbol, interval, limit) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn({ symbol, interval, status: resp.status }, '获取K线失败');
      return null;
    }
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn({ symbol, interval, len: data?.length }, 'K线数据为空');
      return null;
    }
    return data;
  } catch (e) {
    logger.error({ symbol, interval, err: e.message }, '获取K线异常');
    return null;
  }
}

// 计算平均成交量
// klines: [[openTime, open, high, low, close, volume, closeTime, quoteVolume, ...], ...]
// count: 使用的 K 线数量
// 返回: 平均成交量（quoteVolume，即 USDT 成交量）
function calculateAverageVolume(klines, count) {
  if (!Array.isArray(klines) || klines.length < count) return 0;
  const slice = klines.slice(0, count);  // 从最新的开始取
  let sum = 0;
  for (const k of slice) {
    const quoteVolume = parseFloat(k[7]); // k[7] 为报价资产成交量（USDT）
    if (Number.isFinite(quoteVolume)) sum += quoteVolume;
  }
  return sum / count;
}

// 获取单根 K 线的成交量
// klines: [[openTime, open, high, low, close, volume, closeTime, quoteVolume, ...], ...]
// 返回: 第一根（最新完成的）K 线的成交量
function getSingleKlineVolume(klines) {
  if (!Array.isArray(klines) || klines.length === 0) return 0;
  const quoteVolume = parseFloat(klines[0][7]);
  return Number.isFinite(quoteVolume) ? quoteVolume : 0;
}

// 单币种计算任务
// volume1: 短期窗口（分钟），固定使用 1 分钟 K 线，计算 N 根 1 分钟 K 线的成交量总和
// volume2: 长期窗口（分钟），自动选择最优 K 线周期，计算平均成交量
async function calculateSymbolVolumeScore(symbol, tsMinute, config) {
  const volumeCfg = config.volumeScore || {};
  const volume1Minutes = (typeof volumeCfg.volume1 === 'number' && volumeCfg.volume1 > 0) ? volumeCfg.volume1 : 10;
  const volume2Minutes = (typeof volumeCfg.volume2 === 'number' && volumeCfg.volume2 > 0) ? volumeCfg.volume2 : 600;

  try {
    // ========== volume1: 固定使用 1 分钟 K 线 ==========
    const limit1 = volume1Minutes + 1;  // +1 用于去掉最新未完成的
    const klines1m = await fetchKlines(symbol, '1m', limit1);
    if (!klines1m || klines1m.length < limit1) {
      logger.debug({ symbol, interval: '1m', required: limit1, actual: klines1m?.length }, 'volume1 K线数据不足，跳过计算');
      return;
    }
    
    // 去掉最新一根（未完成）
    const completed1m = klines1m.slice(0, -1);
    if (completed1m.length < volume1Minutes) {
      logger.debug({ symbol, availableKlines: completed1m.length, required: volume1Minutes }, 'volume1 K线数据不足，跳过计算');
      return;
    }
    
    // volume1: 计算 N 根 1 分钟 K 线的成交量总和
    let volume1Sum = 0;
    for (let i = 0; i < volume1Minutes; i++) {
      const quoteVolume = parseFloat(completed1m[i][7]);
      if (Number.isFinite(quoteVolume)) volume1Sum += quoteVolume;
    }
    const volumeMa1 = volume1Sum;
    
    // ========== volume2: 自动选择最优 K 线周期 ==========
    const optimal = selectOptimalInterval(volume2Minutes);
    const limit2 = optimal.count + 1;  // +1 用于去掉最新未完成的
    
    const klines2 = await fetchKlines(symbol, optimal.interval, limit2);
    if (!klines2 || klines2.length < limit2) {
      logger.debug({ symbol, interval: optimal.interval, required: limit2, actual: klines2?.length }, 'volume2 K线数据不足，跳过计算');
      return;
    }
    
    // 去掉最新一根（未完成）
    const completed2 = klines2.slice(0, -1);
    if (completed2.length < optimal.count) {
      logger.debug({ symbol, availableKlines: completed2.length, required: optimal.count }, 'volume2 K线数据不足，跳过计算');
      return;
    }
    
    // volume2: 计算平均成交量
    const volumeMa2Raw = calculateAverageVolume(completed2, optimal.count);
    
    // 换算到 volume1 的时间单位（重要！）
    // volumeMa2Raw 是 optimal.intervalMinutes 分钟的平均成交量
    // 需要换算到 volume1Minutes 分钟，才能与 volume1 比较
    const volumeMa2 = volumeMa2Raw * volume1Minutes / optimal.intervalMinutes;
    
    // 计算得分（上限 5 分）
    const volumeScoreRaw = volumeMa2 > 0 ? volumeMa1 / volumeMa2 : 0;
    const volumeScore = Math.min(volumeScoreRaw, 5);
    
    // 保存到数据库
    upsertSymbolVolumeScore({
      ts_minute: tsMinute,
      symbol,
      volume_ma1: volumeMa1,
      volume_ma2: volumeMa2,
      volume_score: volumeScore,
    });
    
    logger.debug({ 
      symbol, 
      volume1: { minutes: volume1Minutes, interval: '1m', klines: volume1Minutes },
      volume2: { minutes: volume2Minutes, interval: optimal.interval, klines: optimal.count },
      volumeMa1: volumeMa1.toFixed(2), 
      volumeMa2: volumeMa2.toFixed(2), 
      volumeScore: volumeScore.toFixed(4) 
    }, '单币种 volume score 计算完成');
  } catch (err) {
    logger.error({ symbol, err: err.message }, '单币种 volume score 计算失败');
  }
}

// 均匀分布处理：将 symbols 在指定时间窗口内均匀分布更新
// distributeMs: 分布时间窗口（毫秒），例如 60000 表示在 1 分钟内均匀分布
async function processDistributed(symbols, tsMinute, config, distributeMs = 60000) {
  if (symbols.length === 0) return;
  
  // 计算每个币种之间的时间间隔
  const intervalMs = distributeMs / symbols.length;
  
  logger.info({ 
    totalSymbols: symbols.length, 
    distributeMs, 
    intervalMs: intervalMs.toFixed(2) 
  }, '开始均匀分布处理');

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const startTime = Date.now();
    
    // 计算并保存
    await calculateSymbolVolumeScore(symbol, tsMinute, config);
    
    // 计算下一个币种应该在什么时候开始
    const nextScheduledTime = startTime + intervalMs;
    const now = Date.now();
    const waitMs = Math.max(0, nextScheduledTime - now);
    
    // 如果还有下一个币种，等待到预定时间
    if (i < symbols.length - 1 && waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    
    // 每处理 50 个币种输出一次进度
    if ((i + 1) % 50 === 0 || i === symbols.length - 1) {
      logger.debug({ 
        processed: i + 1, 
        total: symbols.length, 
        progress: ((i + 1) / symbols.length * 100).toFixed(1) + '%'
      }, '处理进度');
    }
  }
  
  logger.info({ totalSymbols: symbols.length }, '均匀分布处理完成');
}

// 主循环：每分钟更新所有币种（均匀分布）
async function runSymbolVolumeScoreLoop() {
  const config = loadConfig();
  const volumeCfg = config.volumeScore || {};
  const updateIntervalMs = (typeof volumeCfg.updateIntervalMs === 'number' && volumeCfg.updateIntervalMs > 0) ? volumeCfg.updateIntervalMs : 60000;
  const distributeMs = (typeof volumeCfg.distributeMs === 'number' && volumeCfg.distributeMs > 0) ? volumeCfg.distributeMs : 55000; // 默认在 55 秒内分布，留 5 秒缓冲

  logger.info({ updateIntervalMs, distributeMs }, '启动单币种 volume score 计算循环（均匀分布模式）');

  const tick = async () => {
    const tsMinute = Math.floor(Date.now() / 60000) * 60000;
    logger.info({ tsMinute: new Date(tsMinute).toISOString() }, '开始计算单币种 volume score');

    const symbols = await fetchAllTradingSymbols();
    if (symbols.length === 0) {
      logger.warn('未获取到交易对，跳过本次计算');
      return;
    }

    // 使用均匀分布处理
    await processDistributed(symbols, tsMinute, config, distributeMs);
    logger.info({ count: symbols.length }, '单币种 volume score 计算完成');
  };

  // 立即执行一次
  await tick();

  // 定时执行
  setInterval(tick, updateIntervalMs);
}

// 市场整体计算：每 N 秒查询市值 < 5 亿的币种，计算总和
async function runMarketVolumeScoreLoop() {
  const config = loadConfig();
  const volumeCfg = config.volumeScore || {};
  const marketCalcIntervalMs = (typeof volumeCfg.marketCalcIntervalMs === 'number' && volumeCfg.marketCalcIntervalMs > 0) ? volumeCfg.marketCalcIntervalMs : 5000;
  const marketCapThreshold = (typeof volumeCfg.marketCapThreshold === 'number' && volumeCfg.marketCapThreshold > 0) ? volumeCfg.marketCapThreshold : 500_000_000;

  logger.info({ marketCalcIntervalMs, marketCapThreshold }, '启动市场整体 volume score 计算循环');

  const tick = async () => {
    const tsMinute = Math.floor(Date.now() / 60000) * 60000;

    // 查询市值 < 5 亿的币种
    const symbolsUnder500M = getSymbolsWithMarketCapLessThan(marketCapThreshold);
    if (symbolsUnder500M.length === 0) {
      logger.debug('未找到市值 < 5 亿的币种，跳过本次计算');
      return;
    }

    // 从数据库读取这些币种的最新 volume score
    const scores = getLatestSymbolVolumeScores(symbolsUnder500M);
    if (scores.length === 0) {
      logger.debug('未找到 volume score 数据，跳过本次计算');
      return;
    }

    // 计算平均值
    let totalVolumeScore = 0;
    let totalVolumeMa1 = 0;
    let totalVolumeMa2 = 0;
    for (const row of scores) {
      totalVolumeScore += row.volume_score || 0;
      totalVolumeMa1 += row.volume_ma1 || 0;
      totalVolumeMa2 += row.volume_ma2 || 0;
    }

    const marketVolumeScore2 = scores.length > 0 ? totalVolumeScore / scores.length : 0;

    // 保存到数据库（按分钟去重）
    upsertMarketVolumeScore({
      ts_minute: tsMinute,
      total_volume_ma1: totalVolumeMa1,
      total_volume_ma2: totalVolumeMa2,
      market_volume_score_2: marketVolumeScore2,
      symbols_count: scores.length,
    });

    logger.debug({
      tsMinute: new Date(tsMinute).toISOString(),
      symbolsCount: scores.length,
      totalVolumeMa1: totalVolumeMa1.toFixed(2),
      totalVolumeMa2: totalVolumeMa2.toFixed(2),
      marketVolumeScore2: marketVolumeScore2.toFixed(4),
    }, '市场整体 volume score 计算完成');
  };

  // 立即执行一次
  await tick();

  // 定时执行
  setInterval(tick, marketCalcIntervalMs);
}

// 主入口
async function main() {
  logger.info('volume_score_calculator 启动');

  // 启动两个循环
  runSymbolVolumeScoreLoop().catch(e => {
    logger.error({ err: e.message, stack: e.stack }, '单币种 volume score 循环异常');
  });

  runMarketVolumeScoreLoop().catch(e => {
    logger.error({ err: e.message, stack: e.stack }, '市场整体 volume score 循环异常');
  });
}

main();
