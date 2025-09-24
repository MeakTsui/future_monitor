import logger from "../logger.js";
import consoleProvider from "./providers/console.js";
import telegramProvider from "./providers/telegram.js";
import webhookProvider from "./providers/webhook.js";
export { buildAlertPayload, buildDefaultText, formatNumber, formatCurrency, formatCurrencyCompact, buildBinanceFuturesUrl } from "./format.js";

// Provider registry
const registry = new Map([
  ["console", consoleProvider],
  ["telegram", telegramProvider],
  ["webhook", webhookProvider],
]);

export function registerProvider(name, fn) {
  if (typeof fn !== 'function') throw new Error("provider must be a function");
  registry.set(name, fn);
}

export async function dispatchAlert({ config, text, payload, context = {} }) {
  const providers = (config && Array.isArray(config.alerts)) ? config.alerts : [];
  for (const p of providers) {
    if (p && p.enabled === false) continue;
    const sender = registry.get(p.provider);
    if (!sender) {
      logger.warn({ provider: p }, "未知的 provider，已跳过");
      continue;
    }
    try {
      await sender({ text, payload, providerConfig: p, context });
    } catch (e) {
      logger.error({ provider: p, err: e.message }, "告警发送失败");
    }
  }
}
