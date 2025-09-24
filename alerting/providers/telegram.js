import fetch from "node-fetch";
import logger from "../../logger.js";

export default async function sendTelegram({ text, payload, providerConfig }) {
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
