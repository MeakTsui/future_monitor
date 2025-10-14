// 默认 Rule3 WS 策略（插件化）
import fetch from "node-fetch";
import logger from "../logger.js";
import { getLatestUniverseSnapshotBefore, getAvgVolMapForLatestHourBefore } from "../db.js";
import * as helpers from "../alerting/index.js";
// 行为与内置版本一致：当聚合器计算的滚动成交额 sum >= 阈值 thresholdUsd 时：
// - 若启用市值过滤(marketCapMaxUsd > 0)，要求市值在 (0, marketCapMaxUsd)
// - 同一分钟桶去重
// - 冷却检查（本地 + 数据库）
// - 通过 helpers.notify() 发送格式化告警
// 仅在聚合器已判定 sumTurnover >= 阈值时被调用。
// 签名：(ctx, config, helpers)

const lastBucketSent = new Map(); // symbol -> last openTime

function buildStrategyText(ctx, reasonLine, helpers) {
  const { symbol, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice } = ctx;
  const {
    formatNumber,
    formatCurrency,
    formatCurrencyCompact,
    buildBinanceFuturesUrl,
  } = helpers;

  const lines = [];
  const link = `[${symbol}](${buildBinanceFuturesUrl(symbol)})`;
  const prefixEmoji = '‼️‼️'; // rule3 默认策略前缀
  lines.push(`${prefixEmoji} ${link} ${trendEmoji || ''}`.trim());
  if (reasonLine) lines.push(`原因: ${reasonLine}`);
  lines.push(`成交量(USD): ${formatCurrencyCompact(sumTurnover)}`);
  if (Number.isFinite(marketCap)) lines.push(`市值: ${formatCurrencyCompact(marketCap)}`);
  if (Number.isFinite(marketCap) && marketCap > 0) {
    const ratio = sumTurnover / marketCap;
    const digits = ratio < 0.01 ? 4 : 2;
    lines.push(`倍数: ${formatNumber(ratio, digits)}`);
  }
  const prev = Number.isFinite(prevForDisplay) ? prevForDisplay : undefined;
  const close = Number.isFinite(closeForDisplay) ? closeForDisplay : (Number.isFinite(closePrice) ? closePrice : undefined);
  if (typeof prev === 'number' && typeof close === 'number') {
    const pctText = (typeof deltaPct === 'number' && Number.isFinite(deltaPct)) ? ` (${deltaPct >= 0 ? '+' : ''}${formatNumber(deltaPct * 100)}%)` : '';
    lines.push(`价格: ${formatCurrency(prev)} → ${formatCurrency(close)}${pctText} ${trendEmoji || ''}`.trim());
  }
  return lines.join('\n');
}

let cachedUniverse = { ts_period: null, symbols: null };
let cachedAvg = { ts_hour: null, map: null };

function floorToHourUTCms(d) {
  const t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  return t.getTime();
}

function floorTo12hUTCms(d) {
  const t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  const h = t.getUTCHours();
  const h12 = Math.floor(h / 12) * 12;
  t.setUTCHours(h12);
  return t.getTime();
}

function sliceLastMinutes(arr, minutes) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const needMs = minutes * 60000;
  const endMs = arr[arr.length - 1].openTime;
  const startMs = endMs - needMs + 60000;
  let i = arr.length - 1;
  while (i >= 0 && arr[i].openTime >= startMs) i--;
  return arr.slice(i + 1);
}

function sumVolumes(arr) {
  let s = 0;
  for (const k of arr) s += Number(k.volume || 0);
  return s;
}

function minLow(arr) {
  let m = Infinity;
  for (const k of arr) {
    const v = Number(k.low || 0);
    if (v < m) m = v;
  }
  return Number.isFinite(m) ? m : 0;
}

function scorePrice(latest, min5m) {
  if (!(latest > 0) || !(min5m > 0)) return 0;
  const ratio = latest / min5m;
  if (ratio <= 1) return 0;
  if (ratio >= 1.02) return 0.5;
  return ((ratio - 1) / 0.02) * 0.5;
}

function scoreVolume(vol5m, avg5m) {
  if (!(avg5m > 0) || !(vol5m >= 0)) return 0;
  const ratio = vol5m / avg5m;
  if (ratio >= 2) return 0.5;
  const r = ratio / 2;
  const clamped = Math.max(0, Math.min(1, r));
  return clamped * 0.5;
}

function weightOf(sym) {
  if (sym === 'ETHUSDT') return 0.15;
  if (sym === 'SOLUSDT') return 0.05;
  return 0.01;
}

export async function computeMarketStateRealtime(tsMs, readers, options = {}) {
  const hourKey = floorToHourUTCms(new Date(tsMs));
  const periodKey = floorTo12hUTCms(new Date(tsMs));

  if (!cachedUniverse.symbols || cachedUniverse.ts_period !== periodKey) {
    const snap = getLatestUniverseSnapshotBefore(tsMs);
    const list = (snap && Array.isArray(snap.selected_51_130)) ? snap.selected_51_130 : [];
    cachedUniverse = { ts_period: periodKey, symbols: ['ETHUSDT', 'SOLUSDT', ...list] };
  }

  if (!cachedAvg.map || cachedAvg.ts_hour !== hourKey) {
    const { ts_hour, map } = getAvgVolMapForLatestHourBefore(tsMs);
    cachedAvg = { ts_hour: ts_hour || hourKey, map: map || {} };
  }

  const symbols = cachedUniverse.symbols || [];
  const avgMap = cachedAvg.map || {};
  const rows = [];
  for (const sym of symbols) {
    const win = readers && typeof readers.getWindow === 'function' ? readers.getWindow(sym) : null;
    if (!Array.isArray(win) || win.length === 0) continue;
    const last5 = sliceLastMinutes(win, 5);
    if (last5.length === 0) continue;
    const min5 = minLow(last5);
    const vol5 = sumVolumes(last5);
    const latest = Number(win[win.length - 1].close || 0);
    const preAvg = Number(avgMap[sym] || 0);
    const avg5m = preAvg > 0 ? preAvg : 0;
    const price_score = scorePrice(latest, min5);
    const vol_score = scoreVolume(vol5, avg5m);
    const symbol_score = price_score + vol_score;
    const weight = weightOf(sym);
    rows.push({
      symbol: sym,
      price_score,
      vol_score,
      symbol_score,
      weight,
      latest_price: latest,
      min_price_5m: min5,
      vol_5m: vol5,
      avg_vol_5m_5h: avg5m,
    });
  }

  let total = 0;
  for (const r of rows) total += r.symbol_score * r.weight;
  const total_score = total * 100;
  const threshold = (typeof options.aggressiveThreshold === 'number' && Number.isFinite(options.aggressiveThreshold)) ? options.aggressiveThreshold : 60;
  const state_text = total_score > threshold ? 'aggressive' : 'conservative';
  const state = total_score > threshold ? 1 : 0;
  return { ts: tsMs, total_score, state, state_text, rows };
}


export default async function rule3Default(ctx, config, helpers) {
  const { symbol, openTime, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice } = ctx;

  // 同一分钟桶去重
  const last = lastBucketSent.get(symbol);
  if (last === openTime) return;

  // 市值过滤
  if (helpers.marketCapMaxUsd > 0) {
    if (!Number.isFinite(marketCap) || !(marketCap > 0 && marketCap < helpers.marketCapMaxUsd)) return;
  }

  const reason = `ws_rule3_${helpers.windowMinutes}m_${helpers.thresholdUsd}`;

  // 冷却检查
  const local = helpers.shouldAlertLocal(symbol, reason, helpers.cooldownSec);
  if (!local.ok) return;
  const db = helpers.shouldAlert(symbol, reason, helpers.cooldownSec);
  if (!db.ok) return;

  // 标记已发送
  helpers.markAlertSentLocal(symbol, reason);
  helpers.markAlertSent(symbol, reason);
  lastBucketSent.set(symbol, openTime);

  // 按档位配置，基于市值与5m成交额，决定是否绕过均量检查
  let bypassAvg = false;
  try {
    const ruleCfg = (config && config.rule3ws) || {};
    const tiers = Array.isArray(ruleCfg.bypassAvgVolumeTiers) ? ruleCfg.bypassAvgVolumeTiers : [];
    if (tiers.length > 0) {
      if (!(Number.isFinite(marketCap) && marketCap > 0)) {
        logger.debug({ symbol }, '均量绕过检查：缺少可用市值，跳过档位匹配');
      } else if (!(helpers && typeof helpers.getWindow === 'function')) {
        logger.debug({ symbol }, '均量绕过检查：缺少窗口读取器，跳过档位匹配');
      } else {
        const win = helpers.getWindow(symbol) || [];
        const last5 = sliceLastMinutes(win, 5);
        const vol5m = sumVolumes(last5);
        for (let i = 0; i < tiers.length; i++) {
          const t = tiers[i] || {};
          const vCond = (typeof t.vol5mGteUsd === 'number' && t.vol5mGteUsd >= 0) ? (vol5m >= t.vol5mGteUsd) : false;
          let mcCond = false;
          const hasLt = (typeof t.marketCapLtUsd === 'number');
          const hasGte = (typeof t.marketCapGteUsd === 'number');
          if (hasLt && hasGte) {
            mcCond = (marketCap >= t.marketCapGteUsd && marketCap < t.marketCapLtUsd);
          } else if (hasLt) {
            mcCond = (marketCap < t.marketCapLtUsd);
          } else if (hasGte) {
            mcCond = (marketCap >= t.marketCapGteUsd);
          } else {
            mcCond = false; // no bounds specified => do not match by market cap
          }
          if (vCond && mcCond) {
            bypassAvg = true;
            logger.info({ symbol, marketCap, vol5m, tierIndex: i, tier: t }, '均量检查：满足档位，绕过均量检查');
            break;
          }
        }
        if (!bypassAvg) {
          logger.debug({ symbol, marketCap, vol5m, tiers: tiers.length }, '均量检查：未匹配任何档位，不绕过');
        }
      }
    }
  } catch (e) {
    logger.warn({ symbol, err: e.message }, '均量绕过检查：异常，按未绕过处理');
  }

  // 均量检查（可选）：
  // 拉取最近 limit 根 1m K 线；使用前 (limit - windowMinutes) 根，按 windowMinutes 为一组不重叠分组，
  // 计算这些分组的 5m（或 W 分钟）成交额均值 baseline，要求当前窗口 sumTurnover >= multiplier * baseline。
  // 示例：limit=100, windowMinutes=5，则均量 = sum(vol(100-5)) / ((100-5)/5)。
  try {
    const ruleCfg = (config && config.rule3ws) || {};
    const enabled = !!ruleCfg.enableAvgVolumeCheck && !bypassAvg;
    const multiplier = (typeof ruleCfg.avgVolumeMultiplier === 'number' && ruleCfg.avgVolumeMultiplier > 0) ? ruleCfg.avgVolumeMultiplier : 2;
    const W = Math.max(1, Math.floor(helpers.windowMinutes));
    const limit = (typeof ruleCfg.avgVolumeKlinesLimit === 'number' && ruleCfg.avgVolumeKlinesLimit > W)
      ? Math.min(1500, Math.floor(ruleCfg.avgVolumeKlinesLimit))
      : 100; // 默认 100
    if (enabled) {
      const base = (typeof ruleCfg.restBaseUrl === 'string' && ruleCfg.restBaseUrl) ? ruleCfg.restBaseUrl : 'https://fapi.binance.com';
      const url = `${base}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=${limit}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data) && data.length === limit) {
          // 使用前 (limit - W) 根，避免与当前窗口重叠
          const usable = data.slice(0, limit - W);
          const blocks = Math.floor(usable.length / W);
          if (blocks > 0) {
            let total = 0;
            for (let b = 0; b < blocks; b++) {
              let sum = 0;
              for (let j = 0; j < W; j++) {
                const k = usable[b * W + j];
                // k[7] 为该 1m 的报价资产成交量（USDT）
                const q = parseFloat(k && k[7]);
                if (Number.isFinite(q)) sum += q;
              }
              total += sum;
            }
            const avgW = total / blocks;
            if (!(sumTurnover >= multiplier * avgW)) {
              // 未达到均量倍数阈值，跳过告警
              logger.debug({ usable: usable.length, W }, `均量检查：${symbol}, ${ruleCfg.windowMinutes}m成交量${sumTurnover} 没有超过均值 ${avgW}，不发送`);
              return;
            }
            logger.info({ usable: usable.length, W }, `均量检查：${symbol}, ${ruleCfg.windowMinutes}m成交量${sumTurnover} 超过均值 ${avgW}，发送告警`);
          } else {
            logger.warn({ usable: usable.length, W }, '均量检查：可用数据不足，不发送');
            return
          }
        } else {
          logger.warn({ len: Array.isArray(data) ? data.length : -1, need: limit }, '均量检查：返回 K 线数量异常，不发送');
          return
        }
      } else {
        logger.warn({ status: resp.status }, '均量检查：请求 K 线失败，不发送');
        return
      }
    }
    if (!enabled && !bypassAvg && !!ruleCfg.enableAvgVolumeCheck) {
      // enable=true 但被其他原因短路（理论上不会到这里）；保底日志
      logger.debug({ symbol }, '均量检查：被禁用或未启用');
    }
  } catch (e) {
    logger.error({ err: e.message }, '均量检查：发生异常，不发送');
    return
  }

  // 构建原因文案与倍数
  const reasonLine = (helpers.marketCapMaxUsd > 0)
    ? `市值低于$${(helpers.marketCapMaxUsd/1_000_000).toFixed(2)}M且${helpers.windowMinutes}m成交额超过$${(helpers.thresholdUsd/1_000_000).toFixed(2)}M`
    : `${helpers.windowMinutes}m成交额超过$${(helpers.thresholdUsd/1_000_000).toFixed(2)}M`;
  const ratio = (typeof marketCap === 'number' && marketCap > 0) ? (sumTurnover / marketCap) : undefined;

  let marketStateRes = null;
  try {
    const readers = (helpers && typeof helpers.getWindow === 'function') ? { getWindow: helpers.getWindow } : null;
    if (readers) {
      const aggressiveThreshold = (config && config.marketState && typeof config.marketState.aggressiveThreshold === 'number') ? config.marketState.aggressiveThreshold : 60;
      marketStateRes = await computeMarketStateRealtime(Date.now(), readers, { aggressiveThreshold });
    }
  } catch (e) {
    logger.warn({ err: String(e) }, '实时计算市场状态失败，忽略');
  }

  let halfBars = undefined;
  let halfMs = undefined;
  let priceChangePct = undefined;
  try {
    if (helpers && typeof helpers.getWindow === 'function') {
      const win = helpers.getWindow(symbol) || [];
      if (Array.isArray(win) && win.length > 0) {
        const half = Number(helpers.thresholdUsd) / 2;
        let acc = 0;
        let count = 0;
        for (let i = win.length - 1; i >= 0; i--) {
          const v = Number(win[i] && win[i].volume || 0);
          acc += v;
          count++;
          if (acc >= half) {
            halfBars = count;
            halfMs = count * 60000;
            const earliest = win[i];
            const latest = win[win.length - 1];
            const o = Number(earliest && earliest.open);
            const c = Number(latest && latest.close);
            if (Number.isFinite(o) && o > 0 && Number.isFinite(c)) {
              priceChangePct = (c - o) / o;
            }
            break;
          }
        }
      }
    }
  } catch {}

  let text = buildStrategyText(ctx, reasonLine, helpers);
  try {
    const extra = [];
    if (typeof halfBars === 'number') extra.push(`速度: 最近${halfBars}根1m达到阈值一半`);
    if (typeof priceChangePct === 'number') extra.push(`价格变动: ${helpers.formatNumber(priceChangePct, 3)}`);
    if (extra.length) text = `${text}\n${extra.join('\n')}`;
  } catch {}

  await helpers.notify(symbol, reasonLine, sumTurnover, { alerts: config.alerts }, {
    trendEmoji,
    marketCap,
    ratio,
    prevClose: Number.isFinite(prevForDisplay) ? prevForDisplay : undefined,
    closePrice: Number.isFinite(closeForDisplay) ? closeForDisplay : (Number.isFinite(closePrice) ? closePrice : undefined),
    deltaPct,
    total_score: (marketStateRes && typeof marketStateRes.total_score === 'number') ? Number(marketStateRes.total_score.toFixed(3)) : undefined,
    state_text: marketStateRes ? marketStateRes.state_text : undefined,
    state: marketStateRes ? marketStateRes.state : undefined,
    half_bars_to_half_threshold: typeof halfBars === 'number' ? halfBars : undefined,
    price_change_pct_from_earliest_open: (typeof priceChangePct === 'number') ? Number(priceChangePct.toFixed(3)) : undefined
  }, { strategy: `${helpers.windowMinutes}m_turnover`, text });
}
