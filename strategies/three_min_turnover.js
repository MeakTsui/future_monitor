// Three-minute turnover strategy plugin
// Trigger when last 3-minute quote volume (USDT) >= turnoverMinUsd AND market cap < marketCapMaxUsd
// Config path: config.rule3ws.custom3m
// Example:
//   rule3ws: {
//     ...,
//     custom3m: { enabled: true, turnoverMinUsd: 1000000, marketCapMaxUsd: 500000000, cooldownSec: 1800 }
//   }
// Signature: (ctx, config, helpers)

const lastBucketSent = new Map(); // symbol -> last openTime used to avoid duplicates per minute

export default async function threeMinTurnoverStrategy(ctx, config, helpers) {
  const opts = (config && config.rule3ws && config.rule3ws.custom3m) || {};
  if (opts.enabled === false) return;

  const turnoverMinUsd = typeof opts.turnoverMinUsd === 'number' ? opts.turnoverMinUsd : 1_000_000;
  const capMaxUsd = typeof opts.marketCapMaxUsd === 'number' ? opts.marketCapMaxUsd : 500_000_000;
  const cooldownSec = typeof opts.cooldownSec === 'number' ? opts.cooldownSec : helpers.cooldownSec;

  const { symbol, openTime } = ctx;

  // Compute last 3 minutes quote volume
  const sum3 = helpers.getSumLastMinutes(symbol, 3);
  if (!(sum3 >= turnoverMinUsd)) return;

  // Market cap check: prefer ctx.marketCap computed by aggregator
  const marketCap = ctx.marketCap;
  if (!(Number.isFinite(marketCap) && marketCap > 0 && marketCap < capMaxUsd)) return;

  // Per-minute dedupe
  const lastSent = lastBucketSent.get(symbol);
  if (lastSent === openTime) return;

  const reason = `ws_custom_3m_turnover_${turnoverMinUsd}_mc_lt_${capMaxUsd}`;
  const local = helpers.shouldAlertLocal(symbol, reason, cooldownSec);
  if (!local.ok) return;
  const db = helpers.shouldAlert(symbol, reason, cooldownSec);
  if (!db.ok) return;

  helpers.markAlertSentLocal(symbol, reason);
  helpers.markAlertSent(symbol, reason);
  lastBucketSent.set(symbol, openTime);

  // Compose extras for nice alert
  const trendEmoji = ctx.trendEmoji;
  const prevForDisplay = Number.isFinite(ctx.prevForDisplay) ? ctx.prevForDisplay : undefined;
  const closeForDisplay = Number.isFinite(ctx.closeForDisplay) ? ctx.closeForDisplay : (Number.isFinite(ctx.closePrice) ? ctx.closePrice : undefined);
  const ratio = marketCap > 0 ? (sum3 / marketCap) : undefined;
  const reasonLine = `3m成交额超过$${(turnoverMinUsd/1_000_000).toFixed(2)}M且市值低于$${(capMaxUsd/1_000_000).toFixed(2)}M`;

  await helpers.notify(symbol, reasonLine, sum3, { alerts: config.alerts }, {
    trendEmoji,
    marketCap,
    ratio,
    prevClose: prevForDisplay,
    closePrice: closeForDisplay,
    deltaPct: ctx.deltaPct,
  });
}
