import fetch from "node-fetch";
import logger from "./logger.js";

// 统一的告警派发模块
// - Telegram/Console 仍发送文本（与现状兼容）
// - Webhook 发送结构化 JSON（包含 text 字段以便兼容现有接收端）

export function buildAlertPayload({
  strategy = "",
  symbol = "",
  reason = "",
  windowMinutes,
  severity = "info", // info | warning | critical
  metrics = {},       // 自定义指标，如 { sumTurnover, marketCap, ratio, prevClose, closePrice, deltaPct }
  links = {},         // 外链，如 { binanceFutures: "..." }
  timestamps = {},    // 时间相关，如 { eventTime: Date.now(), klineOpen, klineClose }
  tags = [],          // 额外标签
  extra = {},         // 其他扩展字段
} = {}) {
  return {
    version: 1,
    source: "future_monitor",
    strategy,
    symbol,
    reason,
    windowMinutes,
    severity,
    metrics,
    links,
    timestamps,
    tags,
    ...extra,
  };
}

async function sendConsole(text, payload, providerConfig) {
  // 控制台打印文本 + 结构化对象
  if (text) logger.info(text);
  if (payload) logger.info({ payload }, "console payload");
}

async function sendTelegram(text, payload, providerConfig) {
  if (!providerConfig?.botToken || !providerConfig?.chatId) {
    logger.warn({ providerConfig }, "Telegram 配置缺失，跳过发送");
    return;
  }
  const url = `https://api.telegram.org/bot${providerConfig.botToken}/sendMessage`;
  const body = {
    chat_id: providerConfig.chatId,
    text: text || JSON.stringify(payload),
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await resp.json();
    if (!result.ok) {
      logger.error({ result }, "发送 Telegram 失败");
    }
  } catch (err) {
    logger.error({ err: err.message }, "发送 Telegram 出错");
  }
}

async function sendWebhook(text, payload, providerConfig) {
  if (!providerConfig?.url) {
    logger.warn({ providerConfig }, "Webhook 配置缺失，跳过发送");
    return;
  }
  try {
    const body = payload ? { text, ...payload } : { text };
    const resp = await fetch(providerConfig.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      logger.error({ status: resp.status, text: await resp.text() }, "Webhook 推送失败");
    }
  } catch (err) {
    logger.error({ err: err.message }, "Webhook 推送出错");
  }
}

const providers = {
  console: sendConsole,
  telegram: sendTelegram,
  webhook: sendWebhook,
};

export async function dispatchAlert({ config, text, payload }) {
  const alerts = config?.alerts || [];
  for (const provider of alerts) {
    const sender = providers[provider.provider];
    if (!sender) {
      logger.warn({ provider }, "未知的 provider，已跳过");
      continue;
    }
    await sender(text, payload, provider);
  }
}
