# Rule3 Tier Bypass Strategy

## 概述

`rule3_tier_bypass.js` 是一个独立的 WS Rule3 策略插件，专注于基于**市值区间**与**5分钟成交额**的档位匹配逻辑。

- **核心功能**: 当 symbol 的市值与最近5分钟成交额命中任意配置档位时，立即发送告警（无需均量检查）。
- **输出格式**: 与默认策略保持一致，包含市值、倍数、价格变动、速度指标、市场状态等。
- **独立性**: 可单独使用或与其他策略并行加载。

---

## 配置示例

在 `config.json` 中配置：

```json
{
  "rule3ws": {
    "windowMinutes": 5,
    "turnoverUsdThreshold": 5000000,
    "cooldownSec": 1800,
    "marketCapMaxUsd": 500000000,
    "wsStrategies": [
      "./strategies/rule3_tier_bypass.js"
    ],
    "tierBypassStrategy": {
      "tiers": [
        {
          "marketCapLtUsd": 50000000,
          "vol5mGteUsd": 350000
        },
        {
          "marketCapGteUsd": 50000000,
          "vol5mGteUsd": 500000
        },
        {
          "marketCapGteUsd": 20000000,
          "marketCapLtUsd": 80000000,
          "vol5mGteUsd": 400000
        }
      ],
      "symbolBlacklist": ["BTCUSDT", "ETHUSDT"],
      "enableMarketState": true,
      "volumeThresholdRatio": 0.7,
      "defaultMarketCapUsd": 30000000
    }
  }
}
```

---

## 配置字段说明

### `tierBypassStrategy.tiers` (必需)

档位数组，每个档位包含：

- **`marketCapLtUsd`** (可选): 市值上限（不含），单位 USD
- **`marketCapGteUsd`** (可选): 市值下限（含），单位 USD
- **`vol5mGteUsd`** (必需): 最近5分钟成交额下限（含），单位 USD

**匹配规则**:
- 同时提供 `marketCapGteUsd` 和 `marketCapLtUsd` 时，要求市值在区间 `[marketCapGteUsd, marketCapLtUsd)` 内。
- 仅提供一侧边界时，执行单边判断。
- 市值条件 **AND** 5m成交额条件同时满足时，档位命中。

### `tierBypassStrategy.enableMarketState` (可选，默认 true)

是否计算并附加市场状态（`total_score`、`state`、`state_text`）到告警 payload。

### `tierBypassStrategy.volumeThresholdRatio` (可选，默认 0.7)

用于计算"速度"指标的阈值比例：从最新K线往回累计，达到 `ratio * vol5m` 所需的K线数量。

### `tierBypassStrategy.symbolBlacklist` (可选)

币对黑名单数组。黑名单中的币对将不会触发告警，即使命中档位。

- 数组格式，每个元素为完整的币对名称（如 `"BTCUSDT"`）
- 黑名单检查在档位匹配之前执行，避免不必要的计算
- 黑名单币对会输出 debug 级别日志

**使用场景**: 
- 过滤掉不关注的主流币（如 BTC、ETH）
- 临时屏蔽某些异常波动的币对
- 避免对特定币对产生告警噪音

### `tierBypassStrategy.defaultMarketCapUsd` (可选)

默认市值（USD）。当无法从供给数据计算出实际市值时，使用此默认值进行档位匹配。

- 若未配置且无法获取市值，该 symbol 将跳过档位检查。
- 若配置了默认市值，告警文本中会标注"(默认)"，且 payload 中 `using_default_market_cap` 字段为 `true`。

**使用场景**: 针对新上线或供给数据未同步的币种，可设置一个合理的默认市值（如 30M USD）以避免漏报。

---

## 告警输出

### 文本格式

```
🔥🔥 [SYMBOL](链接) 📈
原因: 市值$XX.XXM且5m成交额$YY.YYM，命中第N档
成交量(USD): $ZZ.ZZM
市值: $AA.AAM
倍数: X.XX
价格: $P1 → $P2 (+X.XX%) 📈
档位: 第N档 (5m量=$YY.YYM)
速度: 最近X根1m达到阈值0.7
价格变动: 0.XXX
```

**注**: 若使用默认市值，原因行会显示为：`市值$XX.XXM(默认)且5m成交额$YY.YYM，命中第N档`

### Webhook Payload

结构化 JSON，包含：
- `strategy`: `"tier_bypass"`
- `metrics`:
  - `sumTurnover`, `marketCap`, `ratio`, `deltaPct`
  - `total_score`, `state`, `state_text` (若启用市场状态)
  - `half_bars_to_half_threshold`, `price_change_pct_from_earliest_open`
  - `tier_index`: 命中的档位索引（从0开始）
  - `vol_5m`: 最近5分钟成交额
  - `using_default_market_cap`: 布尔值，是否使用了默认市值

---

## 与默认策略的区别

| 特性 | `rule3_default.js` | `rule3_tier_bypass.js` |
|------|-------------------|------------------------|
| **触发条件** | 成交额达阈值 + 市值过滤 + 均量检查 | 成交额达阈值 + 档位匹配（市值区间 + 5m量） |
| **均量检查** | 可选启用，通过 REST 拉取 K 线校验 | 无均量检查，档位命中即发送 |
| **前缀 Emoji** | ‼️‼️ | 🔥🔥 |
| **冷却 key** | `ws_rule3_...` | `tier_bypass_...` |
| **适用场景** | 通用规则3监控 | 针对特定市值与5m量组合的快速响应 |

---

## 使用建议

1. **单独使用**: 适合只关注档位匹配的场景，配置 `wsStrategies: ["./strategies/rule3_tier_bypass.js"]`。
2. **并行使用**: 可与默认策略同时加载，分别触发不同类型的告警：
   ```json
   "wsStrategies": [
     "./strategies/rule3_default.js",
     "./strategies/rule3_tier_bypass.js"
   ]
   ```
   - 默认策略处理常规成交额告警（含均量校验）。
   - Tier bypass 策略处理档位匹配的快速告警（无均量校验）。
   - 两者冷却 key 不同，互不干扰。

3. **档位调整**: 根据市场情况动态调整 `tiers` 配置，无需修改代码。

---

## 日志输出

### INFO 级别（正常运行时可见）

- **通过所有检查，准备发送告警**: 
  ```
  logger.info({ symbol, marketCap, usingDefault, vol5m, tierIndex, tier }, 'tier_bypass策略：命中档位并通过冷却检查，准备发送告警')
  ```

### DEBUG 级别（需设置 LOG_LEVEL=debug 才可见）

- **命中档位但在冷却期**:
  ```
  logger.debug({ symbol, marketCap, vol5m, tierIndex, remainingSec }, 'tier_bypass策略：命中档位但本地冷却中，跳过')
  logger.debug({ symbol, marketCap, vol5m, tierIndex, remainingSec }, 'tier_bypass策略：命中档位但数据库冷却中，跳过')
  ```
- **未命中任何档位**: 
  ```
  logger.debug({ symbol, marketCap, vol5m, tiers }, 'tier_bypass策略：未匹配任何档位，跳过')
  ```
- **缺少必要数据**: 
  ```
  logger.debug({ symbol }, 'tier_bypass策略：缺少可用市值/窗口读取器，跳过')
  ```
- **币对在黑名单中**:
  ```
  logger.debug({ symbol }, 'tier_bypass策略：币对在黑名单中，跳过')
  ```

**优化说明**: 命中档位但在冷却期的日志已降级为 `debug`，避免在正常运行时产生大量重复日志。只有真正发送告警时才输出 `info` 级别日志。

---

## 示例场景

### 场景1：小市值快速拉升

- 市值 < 50M，5分钟量 > 350K → 立即告警，无需等待均量校验。

### 场景2：中等市值异常放量

- 市值在 [20M, 80M)，5分钟量 > 400K → 快速响应。

### 场景3：大市值稳定监控

- 市值 ≥ 50M，5分钟量 > 500K → 档位命中。

### 场景4：过滤主流币

- 配置黑名单 `["BTCUSDT", "ETHUSDT"]`，即使这些币对命中档位也不发送告警。
- 适用于只关注小市值山寨币的监控场景。

---

## 扩展性

- **新增档位**: 在 `tiers` 数组中追加新对象即可。
- **自定义文本**: 修改 `buildStrategyText()` 函数调整输出格式。
- **其他指标**: 在 `helpers.notify()` 的 `extras` 参数中添加自定义字段。

---

## 注意事项

- 确保 `config.rule3ws.tierBypassStrategy.tiers` 至少包含一个档位，否则策略跳过所有 symbol。
- 档位匹配优先级按数组顺序，命中第一个即停止。
- 若需同时使用默认策略与 tier bypass 策略，建议在默认策略中禁用或移除 `bypassAvgVolumeTiers` 配置，避免逻辑重复。
