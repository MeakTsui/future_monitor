# 未来监控（Future Monitor）

本项目用于监控 Binance USDT 永续合约市场，基于滚动成交额窗口与可插拔的 WS 策略触发告警，并通过模块化的告警系统（alerting）进行派发。

## 告警系统（模块化 / 插件化）

所有告警统一通过 `alerting/` 模块派发：

- `alerting/index.js`：Provider 注册表与 `dispatchAlert()`
- `alerting/format.js`：文本与数值格式化工具、`buildDefaultText`、`buildAlertPayload`
- `alerting/providers/`：内置 Provider
  - `console`
  - `telegram`
  - `webhook`（支持“模板模式”和“自定义模块构建器”两种定制方式）

在 `ws_rule3_monitor.js` 中使用示例：

```js
import {
  dispatchAlert,
  buildAlertPayload,
  buildDefaultText,
} from './alerting/index.js';
```

### 基本配置（config.json）

在根目录 `config.json` 中配置 `alerts`（告警通道列表）与 `rule3ws`（WS 规则与运行参数），示例：

```json
{
  "alerts": [
    { "provider": "console" },
    { "provider": "telegram", "botToken": "<BOT_TOKEN>", "chatId": "<CHAT_ID>" },
    { "provider": "webhook", "url": "https://example.com/hook" }
  ],
  "rule3ws": {
    "windowMinutes": 5,
    "turnoverUsdThreshold": 5000000,
    "cooldownSec": 1800,
    "maxPerSocket": 80,
    "marketCapMaxUsd": 500000000,
    "debugPort": 18081
  }
}
```

## Provider 配置说明

### 1) Console Provider（控制台）

- 最小配置：
```json
{ "provider": "console" }
```
- 行为：将文本和结构化 payload 打印到控制台（`pino` 日志）。

### 2) Telegram Provider

- 配置：
```json
{ "provider": "telegram", "botToken": "<BOT_TOKEN>", "chatId": "<CHAT_ID>" }
```
- 行为：以 `Markdown` 发送消息，`disable_web_page_preview: true`。

### 3) Webhook Provider（高度可定制）

支持两种使用方式：模板模式（Template Mode）与自定义模块构建器（Custom Builder Module）。

通用字段：
- `url`：目标地址（若使用 `module` 则可选）
- `method`：HTTP 方法（默认 `POST`）
- `headers`：请求头（默认 `{ "Content-Type": "application/json" }`）
- `query`：附加查询参数（对象，将自动拼接到 `url`）
- `bodyMode`：`json` | `form` | `raw`（默认 `json`）
- `includeText`：是否在 body 中包含 `text`（默认 `true`）
- `includePayload`：是否在 body 中包含结构化 `payload`（默认 `true`）
- `textKey` / `payloadKey`：当适用时，文本和载荷所在的键名（默认 `text` / `payload`）
- `bodyTemplate` / `rawBodyTemplate`：模板，支持 `${...}` 占位符

占位符说明：
- `${text}`：格式化后的文本（Markdown）
- `${payload.*}`：结构化 payload 字段，如 `${payload.symbol}`、`${payload.metrics.sumTurnover}`
- `${context.*}`：扩展上下文（预留）

#### 3.1 模板模式（Template Mode）

- JSON body：
```json
{
  "provider": "webhook",
  "url": "https://example.com/hook",
  "headers": { "Authorization": "Bearer xxx" },
  "bodyMode": "json",
  "includeText": true,
  "includePayload": true,
  "bodyTemplate": {
    "title": "Rule3 Alert",
    "symbol": "${payload.symbol}",
    "reason": "${payload.reason}",
    "sumTurnover": "${payload.metrics.sumTurnover}",
    "marketCap": "${payload.metrics.marketCap}",
    "ratio": "${payload.metrics.ratio}",
    "binance": "${payload.links.binanceFutures}"
  }
}
```

- 表单（`application/x-www-form-urlencoded`）：
```json
{
  "provider": "webhook",
  "url": "https://example.com/formhook",
  "bodyMode": "form",
  "bodyTemplate": {
    "msgtype": "text",
    "content": "${text}",
    "symbol": "${payload.symbol}"
  }
}
```

- 纯文本 Raw body：
```json
{
  "provider": "webhook",
  "url": "https://example.com/raw",
  "bodyMode": "raw",
  "rawBodyTemplate": "[${payload.symbol}] ${payload.reason}\n${text}",
  "headers": { "Content-Type": "text/plain" },
  "includeText": false,
  "includePayload": false
}
```

- 携带 query 参数与头部模板：
```json
{
  "provider": "webhook",
  "url": "https://example.com/hook",
  "method": "POST",
  "query": { "source": "future_monitor", "strategy": "${payload.strategy}" },
  "headers": { "X-SYMBOL": "${payload.symbol}" },
  "bodyMode": "json",
  "bodyTemplate": {
    "severity": "${payload.severity}",
    "data": "${payload.metrics}",
    "link": "${payload.links.binanceFutures}"
  }
}
```

#### 3.2 自定义模块构建器（Custom Builder Module）

当需要复杂签名或特殊协议时，使用模块来自定义请求构建。配置示例：

```json
{
  "provider": "webhook",
  "module": "./alerting/custom/dingtalk.js",
  "url": "https://oapi.dingtalk.com/robot/send",
  "secret": "<YOUR_SECRET>"
}
```

模块 `alerting/custom/dingtalk.js` 示例：

```js
import crypto from 'crypto';

export default function buildRequest({ text, payload, providerConfig, context }) {
  const timestamp = Date.now();
  const sign = crypto
    .createHmac('sha256', providerConfig.secret)
    .update(`${timestamp}\n${text}`)
    .digest('base64');

  const url = `${providerConfig.url}?timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;

  const bodyObj = {
    msgtype: 'markdown',
    markdown: { title: `Alert ${payload.symbol}`, text }
  };

  return {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj)
  };
}
```

> 注意：一旦提供了 `module`，其构建结果会覆盖模板模式的所有设置。

## WS 策略（插件化）

`ws_rule3_monitor.js` 支持通过 `config.rule3ws.wsStrategies` 动态加载策略（模块路径数组）。未配置时将加载内置的 Rule3 默认策略。

策略函数签名：

```js
export default function strategy(ctx, config, helpers) { /* ... */ }
```

- `ctx` 包含：`symbol, openTime, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice`
- `helpers` 包含：`windowMinutes, thresholdUsd, marketCapMaxUsd, cooldownSec, shouldAlertLocal, shouldAlert, markAlertSentLocal, markAlertSent, getSumLastMinutes, buildReasonLine, notify`

## 快速测试（Quick Test）

1) 在 `config.json` 中配置 console + webhook：
```json
{
  "alerts": [
    { "provider": "console" },
    { "provider": "webhook", "url": "http://localhost:8080/hook", "bodyMode": "json", "includeText": true, "includePayload": true }
  ],
  "rule3ws": { "windowMinutes": 5, "turnoverUsdThreshold": 1000000, "marketCapMaxUsd": 500000000, "cooldownSec": 300 }
}
```
2) 运行 `node ws_rule3_monitor.js`
3) 查看 webhook 接收日志是否包含 text 与 payload

---

# Payload 字段说明（重要）

派发到 Webhook 的结构化载荷由 `buildAlertPayload()` 生成，核心字段：

- `strategy`：策略标识（已重构为具体策略名，而非固定 `rule3_ws`）。示例：
  - 默认规则3：`"5m_turnover"`（取决于 `windowMinutes`）
  - 三分钟成交额策略：`"3m_turnover"`
  - 自定义样例：`"custom_over2x_5m"`
- `symbol`：交易对，例如 `BTCUSDT`
- `reason`：触发原因（人类可读）
- `windowMinutes`：滚动窗口分钟数
- `severity`：`info | warning | critical`（当前为 `warning`）
- `metrics`：结构化指标，如 `sumTurnover, marketCap, ratio, prevClose, closePrice, deltaPct`
- `links`：外链，如 `binanceFutures`
- `tags`：标签数组，如 `['ws','rule3']`

在策略插件里通过 `helpers.notify(..., options)` 传入 `options.strategy` 指定策略标识：

```js
await helpers.notify(symbol, reasonLine, sumTurnover, { alerts: config.alerts }, extras, {
  strategy: '3m_turnover'
});
```

默认（未显式传入）时会回退为 `ws_rule3` 以保持向后兼容。

# Future Monitor

This repository monitors Binance Futures markets and emits alerts based on rolling turnover windows and custom WS strategies.

## Alerting (Modular + Pluggable)

Alerts are routed through the centralized `alerting/` module.

- `alerting/index.js`: Provider registry and `dispatchAlert()`.
- `alerting/format.js`: Formatting helpers and default builders (`buildDefaultText`, `buildAlertPayload`).
- `alerting/providers/`: Built-in providers
  - `console`
  - `telegram`
  - `webhook` (supports template bodies and custom builder modules)

`ws_rule3_monitor.js` uses:

```js
import {
  dispatchAlert,
  buildAlertPayload,
  buildDefaultText,
} from './alerting/index.js';
```

### Config Basics

The root `config.json` should contain an `alerts` array with one or more providers. Example:

```json
{
  "alerts": [
    { "provider": "console" },
    { "provider": "telegram", "botToken": "<BOT_TOKEN>", "chatId": "<CHAT_ID>" },
    { "provider": "webhook", "url": "https://example.com/hook" }
  ],
  "rule3ws": {
    "windowMinutes": 5,
    "turnoverUsdThreshold": 5000000,
    "cooldownSec": 1800,
    "maxPerSocket": 80,
    "marketCapMaxUsd": 500000000,
    "debugPort": 18081
  }
}
```

## Providers

### 1) Console Provider

- Minimal configuration:
```json
{ "provider": "console" }
```
- Behavior: logs text and payload to the console (using `pino` logger).

### 2) Telegram Provider

- Configuration:
```json
{ "provider": "telegram", "botToken": "<BOT_TOKEN>", "chatId": "<CHAT_ID>" }
```
- Behavior: sends a message using `parse_mode: Markdown` and `disable_web_page_preview: true`.

### 3) Webhook Provider

Supports two modes: Template Mode and Custom Builder Module.

Common params:
- `url`: target URL (required unless using `module`)
- `method`: HTTP method (default `POST`)
- `headers`: request headers (default `{ "Content-Type": "application/json" }`)
- `query`: appended query parameters (object)
- `bodyMode`: `json` | `form` | `raw` (default `json`)
- `includeText`: include `text` in body (default `true`)
- `includePayload`: include structured `payload` (default `true`)
- `textKey` / `payloadKey`: body keys for text and payload when applicable (defaults `"text"` and `"payload"`)
- `bodyTemplate` / `rawBodyTemplate`: templates supporting `${...}` placeholders.

Placeholders:
- `${text}`: formatted alert text (Markdown).
- `${payload.*}`: structured alert payload fields (e.g., `${payload.symbol}`, `${payload.metrics.sumTurnover}`).
- `${context.*}`: optional extra context future extensions.

#### 3.1 Template Mode

- JSON body:
```json
{
  "provider": "webhook",
  "url": "https://example.com/hook",
  "headers": { "Authorization": "Bearer xxx" },
  "bodyMode": "json",
  "includeText": true,
  "includePayload": true,
  "bodyTemplate": {
    "title": "Rule3 Alert",
    "symbol": "${payload.symbol}",
    "reason": "${payload.reason}",
    "sumTurnover": "${payload.metrics.sumTurnover}",
    "marketCap": "${payload.metrics.marketCap}",
    "ratio": "${payload.metrics.ratio}",
    "binance": "${payload.links.binanceFutures}"
  }
}
```

- Form body (`application/x-www-form-urlencoded`):
```json
{
  "provider": "webhook",
  "url": "https://example.com/formhook",
  "bodyMode": "form",
  "bodyTemplate": {
    "msgtype": "text",
    "content": "${text}",
    "symbol": "${payload.symbol}"
  }
}
```

- Raw body (e.g., `text/plain`):
```json
{
  "provider": "webhook",
  "url": "https://example.com/raw",
  "bodyMode": "raw",
  "rawBodyTemplate": "[${payload.symbol}] ${payload.reason}\n${text}",
  "headers": { "Content-Type": "text/plain" },
  "includeText": false,
  "includePayload": false
}
```

- With query parameters and header templating:
```json
{
  "provider": "webhook",
  "url": "https://example.com/hook",
  "method": "POST",
  "query": { "source": "future_monitor", "strategy": "${payload.strategy}" },
  "headers": { "X-SYMBOL": "${payload.symbol}" },
  "bodyMode": "json",
  "bodyTemplate": {
    "severity": "${payload.severity}",
    "data": "${payload.metrics}",
    "link": "${payload.links.binanceFutures}"
  }
}
```

#### 3.2 Custom Builder Module

For complex signing or custom protocols, use a JS module to build the request.

- Config:
```json
{
  "provider": "webhook",
  "module": "./alerting/custom/dingtalk.js",
  "url": "https://oapi.dingtalk.com/robot/send",
  "secret": "<YOUR_SECRET>"
}
```

- Module `alerting/custom/dingtalk.js`:
```js
import crypto from 'crypto';

export default function buildRequest({ text, payload, providerConfig, context }) {
  const timestamp = Date.now();
  const sign = crypto
    .createHmac('sha256', providerConfig.secret)
    .update(`${timestamp}\n${text}`)
    .digest('base64');

  const url = `${providerConfig.url}?timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;

  const bodyObj = {
    msgtype: 'markdown',
    markdown: { title: `Alert ${payload.symbol}`, text }
  };

  return {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj)
  };
}
```

> Note: If `module` is provided, it takes precedence over all template options.

## WS Strategies

`ws_rule3_monitor.js` supports dynamic strategy loading with `config.rule3ws.wsStrategies` (array of module paths). If unspecified, a default Rule3 strategy is used.

Strategy signature:
```js
export default function strategy(ctx, config, helpers) { /* ... */ }
```
- `ctx` includes: `symbol, openTime, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice`.
- `helpers` includes: `windowMinutes, thresholdUsd, marketCapMaxUsd, cooldownSec, shouldAlertLocal, shouldAlert, markAlertSentLocal, markAlertSent, getSumLastMinutes, buildReasonLine, notify`.

## Quick Test

1. Configure a simple console + webhook provider in `config.json`:
```json
{
  "alerts": [
    { "provider": "console" },
    { "provider": "webhook", "url": "http://localhost:8080/hook", "bodyMode": "json", "includeText": true, "includePayload": true }
  ],
  "rule3ws": { "windowMinutes": 5, "turnoverUsdThreshold": 1000000, "marketCapMaxUsd": 500000000, "cooldownSec": 300 }
}
```
2. Run `node ws_rule3_monitor.js`.
3. Verify webhook receiver gets the JSON with both `text` and `payload`.

## Notes

- All imports in `ws_rule3_monitor.js` related to alerting and formatting now come from `alerting/index.js`.
- For rate limits and retries, consider adding logic in providers (not enabled by default).
- To add a new provider, create a module exporting `async function send({ text, payload, providerConfig, context })` and register via `registerProvider()` or use a unique `provider` name and wire it in `alerting/index.js`.
