// Default Rule3 WS strategy (pluginized)
// Behavior mirrors the original built-in: when aggregator computed sum >= thresholdUsd,
// - If (marketCapMaxUsd > 0) require marketCap in (0, marketCapMaxUsd)
// - Dedupe within same kline bucket per symbol
// - Respect cooldown (local + DB)
// - Send a nicely formatted alert via helpers.notify()
// Expects to be run only when aggregator's rolling sum (ctx.sumTurnover) already >= threshold.
// Signature: (ctx, config, helpers)

const lastBucketSent = new Map(); // symbol -> last openTime

export default async function rule3Default(ctx, config, helpers) {
  const { symbol, openTime, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice } = ctx;

  // Same-bucket dedupe
  const last = lastBucketSent.get(symbol);
  if (last === openTime) return;

  // Market cap filter
  if (helpers.marketCapMaxUsd > 0) {
    if (!Number.isFinite(marketCap) || !(marketCap > 0 && marketCap < helpers.marketCapMaxUsd)) return;
  }

  const reason = `ws_rule3_${helpers.windowMinutes}m_${helpers.thresholdUsd}`;

  // Cooldown checks
  const local = helpers.shouldAlertLocal(symbol, reason, helpers.cooldownSec);
  if (!local.ok) return;
  const db = helpers.shouldAlert(symbol, reason, helpers.cooldownSec);
  if (!db.ok) return;

  // Mark sent
  helpers.markAlertSentLocal(symbol, reason);
  helpers.markAlertSent(symbol, reason);
  lastBucketSent.set(symbol, openTime);

  // Build reason line and ratio
  const reasonLine = (helpers.marketCapMaxUsd > 0)
    ? `市值低于$${(helpers.marketCapMaxUsd/1_000_000).toFixed(2)}M且${helpers.windowMinutes}m成交额超过$${(helpers.thresholdUsd/1_000_000).toFixed(2)}M`
    : `${helpers.windowMinutes}m成交额超过$${(helpers.thresholdUsd/1_000_000).toFixed(2)}M`;
  const ratio = (typeof marketCap === 'number' && marketCap > 0) ? (sumTurnover / marketCap) : undefined;

  await helpers.notify(symbol, reasonLine, sumTurnover, { alerts: config.alerts }, {
    trendEmoji,
    marketCap,
    ratio,
    prevClose: Number.isFinite(prevForDisplay) ? prevForDisplay : undefined,
    closePrice: Number.isFinite(closeForDisplay) ? closeForDisplay : (Number.isFinite(closePrice) ? closePrice : undefined),
    deltaPct
  });
}
