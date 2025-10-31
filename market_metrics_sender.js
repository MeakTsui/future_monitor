#!/usr/bin/env node
// 市场指标定时发送器
// 每分钟发送 market_price_score, market_volume_score_2, market_price_score_1h 到 webhook
import fs from 'fs';
import fetch from 'node-fetch';
import logger from './logger.js';
import { getLatestMarketVolumeScore } from './db.js';
import { computeWeightedMarketStateMA } from './market_state_aggregator.js';

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

// 获取 webhook URL
function getWebhookUrl(config) {
  const alerts = config.alerts || [];
  for (const alert of alerts) {
    if (alert.provider === 'webhook' && alert.url) {
      return alert.url;
    }
  }
  return null;
}

// 发送市场指标到 webhook
async function sendMarketMetrics(webhookUrl, metrics) {
  try {
    const payload = {
      type: 0,
      market_price_score: metrics.market_price_score,
      market_volume_score_2: metrics.market_volume_score_2,
      market_price_score_1h: metrics.market_price_score_1h,
    };

    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.error({ status: resp.status, text }, '发送市场指标失败');
    } else {
      logger.debug({ payload }, '市场指标发送成功');
    }
  } catch (err) {
    logger.error({ err: err.message }, '发送市场指标异常');
  }
}

// 获取市场指标
async function getMarketMetrics() {
  const metrics = {
    market_price_score: null,
    market_volume_score_2: null,
    market_price_score_1h: null,
  };

  try {
    // 1. 获取 market_volume_score_2
    const mvs = getLatestMarketVolumeScore();
    if (mvs && typeof mvs.market_volume_score_2 === 'number') {
      metrics.market_volume_score_2 = Number(mvs.market_volume_score_2.toFixed(4));
    }
  } catch (e) {
    logger.warn({ err: String(e) }, '获取 market_volume_score_2 失败');
  }

  try {
    // 2. 获取 market_price_score 和 market_price_score_1h
    // 注意：这里没有实时价格 Map，传入空 Map
    const priceMap = new Map();
    const marketStateMA = await computeWeightedMarketStateMA(500_000_000, priceMap);
    
    if (marketStateMA && marketStateMA.ma5) {
      metrics.market_price_score = Number(marketStateMA.ma5.price_score.toFixed(2));
    }
    
    if (marketStateMA && marketStateMA.ma60) {
      metrics.market_price_score_1h = Number(marketStateMA.ma60.price_score.toFixed(2));
    }
  } catch (e) {
    logger.warn({ err: String(e), stack: e.stack }, '计算市场状态 MA 失败');
  }

  return metrics;
}

// 主循环
async function runMarketMetricsSender() {
  const config = loadConfig();
  const webhookUrl = getWebhookUrl(config);

  if (!webhookUrl) {
    logger.error('未找到 webhook 配置，退出');
    process.exit(1);
  }

  logger.info({ webhookUrl }, '启动市场指标发送器（每分钟一次）');

  const tick = async () => {
    const tsMinute = Math.floor(Date.now() / 60000) * 60000;
    logger.info({ tsMinute: new Date(tsMinute).toISOString() }, '开始获取市场指标');

    const metrics = await getMarketMetrics();
    
    // 检查是否至少有一个指标可用
    const hasData = metrics.market_price_score !== null 
      || metrics.market_volume_score_2 !== null 
      || metrics.market_price_score_1h !== null;

    if (!hasData) {
      logger.warn('所有市场指标均为空，跳过本次发送');
      return;
    }

    logger.info({ 
      market_price_score: metrics.market_price_score,
      market_volume_score_2: metrics.market_volume_score_2,
      market_price_score_1h: metrics.market_price_score_1h,
    }, '市场指标获取完成');

    await sendMarketMetrics(webhookUrl, metrics);
  };

  // 立即执行一次
  await tick();

  // 每分钟执行一次
  setInterval(tick, 60000);
}

// 主入口
async function main() {
  logger.info('market_metrics_sender 启动');
  await runMarketMetricsSender();
}

main().catch(e => {
  logger.error({ err: e.message, stack: e.stack }, '市场指标发送器异常退出');
  process.exit(1);
});
