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

// 获取 5 分钟 K 线数据
async function fetch5mKlines(symbol, limit) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn({ symbol, status: resp.status }, '获取K线失败');
      return null;
    }
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn({ symbol, len: data?.length }, 'K线数据为空');
      return null;
    }
    return data;
  } catch (e) {
    logger.error({ symbol, err: e.message }, '获取K线异常');
    return null;
  }
}

// 计算移动平均（基于 5 分钟 K 线的成交量）
// klines: [[openTime, open, high, low, close, volume, closeTime, quoteVolume, ...], ...]
// window: MA 窗口大小
// 返回最近 window 根 K 线的平均成交量（quoteVolume，即 USDT 成交量）
function calculateMA(klines, window) {
  if (!Array.isArray(klines) || klines.length < window) return 0;
  const slice = klines.slice(-window);
  let sum = 0;
  for (const k of slice) {
    const quoteVolume = parseFloat(k[7]); // k[7] 为报价资产成交量（USDT）
    if (Number.isFinite(quoteVolume)) sum += quoteVolume;
  }
  return sum / window;
}

// 单币种计算任务
async function calculateSymbolVolumeScore(symbol, tsMinute, config) {
  const volumeCfg = config.volumeScore || {};
  const ma1Window = (typeof volumeCfg.volume1 === 'number' && volumeCfg.volume1 > 0) ? volumeCfg.volume1 : 5;
  const ma2Window = (typeof volumeCfg.volume2 === 'number' && volumeCfg.volume2 > 0) ? volumeCfg.volume2 : 120;
  const klineLimit = Math.max(ma1Window, ma2Window) + 10; // 多取一些以防数据不足

  const klines = await fetch5mKlines(symbol, klineLimit);
  if (!klines) return;

  // 去掉最新的一根K线（未完成的K线）
  const completedKlines = klines.slice(0, -1);
  if (completedKlines.length < Math.max(ma1Window, ma2Window)) {
    logger.debug({ symbol, availableKlines: completedKlines.length, required: Math.max(ma1Window, ma2Window) }, 'K线数据不足，跳过计算');
    return;
  }

  const volumeMa1 = calculateMA(completedKlines, ma1Window);
  const volumeMa2 = calculateMA(completedKlines, ma2Window);
  const volumeScore = volumeMa2 > 0 ? volumeMa1 / volumeMa2 : 0;

  upsertSymbolVolumeScore({
    ts_minute: tsMinute,
    symbol,
    volume_ma1: volumeMa1,
    volume_ma2: volumeMa2,
    volume_score: volumeScore,
  });

  logger.debug({ symbol, volumeMa1: volumeMa1.toFixed(2), volumeMa2: volumeMa2.toFixed(2), volumeScore: volumeScore.toFixed(4) }, '单币种 volume score 计算完成');
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

    // 计算总和
    let totalVolumeMa1 = 0;
    let totalVolumeMa2 = 0;
    for (const row of scores) {
      totalVolumeMa1 += row.volume_ma1 || 0;
      totalVolumeMa2 += row.volume_ma2 || 0;
    }

    const marketVolumeScore2 = totalVolumeMa2 > 0 ? totalVolumeMa1 / totalVolumeMa2 : 0;

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
