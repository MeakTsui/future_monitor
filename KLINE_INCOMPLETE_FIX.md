# K线数据完整性修复说明

## 问题描述

在单币种 Volume Score 计算时，从 Binance API 获取的最新一根 K 线数据是**未完成的**（正在形成中），使用这根未完成的 K 线会导致：

1. **数据不准确**: 未完成的 K 线成交量会随时间变化
2. **计算波动**: 每次计算结果不稳定
3. **误导性指标**: 基于不完整数据的 MA 值不可靠

## 示例场景

假设当前时间是 `14:03:30`（某个 5 分钟 K 线的中间）：

```
请求 Binance API: GET /fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=130

返回的 K 线:
[
  [1729670400000, ...],  // 14:00:00 - 14:05:00 (完整)
  [1729670100000, ...],  // 13:55:00 - 14:00:00 (完整)
  [1729669800000, ...],  // 13:50:00 - 13:55:00 (完整)
  ...
  [1729669500000, ...],  // 13:45:00 - 13:50:00 (完整)
  [1729670700000, ...]   // 14:05:00 - 14:10:00 (未完成！) ← 问题所在
]
                         ↑
                    最新一根 K 线
                    只有 3.5 分钟的数据
                    成交量不完整
```

## 解决方案

在计算前去掉最新的一根 K 线，只使用完整的历史 K 线：

```javascript
// 修改前
const klines = await fetch5mKlines(symbol, klineLimit);
const volumeMa1 = calculateMA(klines, ma1Window);
const volumeMa2 = calculateMA(klines, ma2Window);

// 修改后
const klines = await fetch5mKlines(symbol, klineLimit);

// 去掉最新的一根K线（未完成的K线）
const completedKlines = klines.slice(0, -1);

// 检查数据量是否足够
if (completedKlines.length < Math.max(ma1Window, ma2Window)) {
  logger.debug({ symbol, availableKlines: completedKlines.length }, 'K线数据不足，跳过计算');
  return;
}

const volumeMa1 = calculateMA(completedKlines, ma1Window);
const volumeMa2 = calculateMA(completedKlines, ma2Window);
```

## 修改详情

### 文件: `volume_score_calculator.js`

#### 函数: `calculateSymbolVolumeScore()`

**修改内容:**

1. **去掉最新 K 线**
   ```javascript
   const completedKlines = klines.slice(0, -1);
   ```
   使用 `slice(0, -1)` 去掉数组最后一个元素（最新的未完成 K 线）

2. **数据量检查**
   ```javascript
   if (completedKlines.length < Math.max(ma1Window, ma2Window)) {
     logger.debug({ symbol, availableKlines: completedKlines.length, required: Math.max(ma1Window, ma2Window) }, 'K线数据不足，跳过计算');
     return;
   }
   ```
   确保去掉一根后，剩余的 K 线数量仍然足够计算 MA

3. **使用完整 K 线计算**
   ```javascript
   const volumeMa1 = calculateMA(completedKlines, ma1Window);
   const volumeMa2 = calculateMA(completedKlines, ma2Window);
   ```

## 数据流程对比

### 修改前

```
Binance API 返回 130 根 K 线
↓
包含 1 根未完成 K 线
↓
直接用于计算 MA5 和 MA120
↓
结果不稳定 ❌
```

### 修改后

```
Binance API 返回 130 根 K 线
↓
去掉最后 1 根（未完成）
↓
剩余 129 根完整 K 线
↓
检查数量是否足够（129 >= 120）✓
↓
用于计算 MA5 和 MA120
↓
结果稳定可靠 ✅
```

## 配置参数影响

### 默认配置

```json
{
  "volumeScore": {
    "volume1": 5,    // MA5
    "volume2": 120   // MA120
  }
}
```

- **请求数量**: `Math.max(5, 120) + 10 = 130` 根 K 线
- **去掉 1 根后**: 剩余 129 根
- **是否足够**: 129 >= 120 ✓

### 边界情况

如果配置了非常大的窗口：

```json
{
  "volumeScore": {
    "volume1": 5,
    "volume2": 500   // 需要 500 根 K 线
  }
}
```

- **请求数量**: `Math.max(5, 500) + 10 = 510` 根 K 线
- **去掉 1 根后**: 剩余 509 根
- **是否足够**: 509 >= 500 ✓

## 时间延迟说明

### 修改前

```
当前时间: 14:03:30
使用 K 线: 14:05:00 - 14:10:00 (未完成，只有 3.5 分钟数据)
数据时效: 实时但不准确
```

### 修改后

```
当前时间: 14:03:30
使用 K 线: 14:00:00 - 14:05:00 (完整，5 分钟数据)
数据时效: 延迟最多 5 分钟，但准确可靠
```

**权衡**: 牺牲最多 5 分钟的实时性，换取数据的准确性和稳定性。

## 对 MA 计算的影响

### MA5 (最近 5 根 5 分钟 K 线 = 25 分钟)

**修改前:**
```
使用 K 线: [14:05-14:10(未完成), 14:00-14:05, 13:55-14:00, 13:50-13:55, 13:45-13:50]
时间跨度: 约 20-25 分钟（最新一根不完整）
```

**修改后:**
```
使用 K 线: [14:00-14:05, 13:55-14:00, 13:50-13:55, 13:45-13:50, 13:40-13:45]
时间跨度: 完整 25 分钟
```

### MA120 (最近 120 根 5 分钟 K 线 = 10 小时)

**修改前:**
```
使用 K 线: 最新 120 根（包含 1 根未完成）
时间跨度: 约 9.92-10 小时
```

**修改后:**
```
使用 K 线: 最新 120 根完整 K 线
时间跨度: 完整 10 小时
```

## Volume Score 2 的影响

由于 `market_volume_score_2 = total_volume_ma1 / total_volume_ma2`，使用完整 K 线后：

- **分子 (total_volume_ma1)**: 更稳定
- **分母 (total_volume_ma2)**: 更稳定
- **比值**: 更可靠，波动更小

## 日志示例

### 正常情况

```
[DEBUG] 单币种 volume score 计算完成
        { symbol: 'BTCUSDT', volumeMa1: 12345678.90, volumeMa2: 10234567.89, volumeScore: 1.2063 }
```

### 数据不足情况（极少见）

```
[DEBUG] K线数据不足，跳过计算
        { symbol: 'NEWCOIN', availableKlines: 50, required: 120 }
```

这种情况只会在新上线的币种出现，因为历史 K 线不足 120 根。

## 测试验证

### 1. 检查计算结果稳定性

在同一分钟内多次计算，结果应该一致：

```bash
# 查看最近的计算结果
sqlite3 data.sqlite "SELECT symbol, volume_ma1, volume_ma2, volume_score, updated_at 
FROM symbol_volume_score 
WHERE symbol = 'BTCUSDT' 
ORDER BY updated_at DESC 
LIMIT 5;"
```

### 2. 对比修改前后

**修改前**: 同一分钟内多次查询，`volume_ma1` 和 `volume_ma2` 可能略有不同

**修改后**: 同一分钟内多次查询，结果完全一致

## 注意事项

1. **数据延迟**: 最多延迟 5 分钟（一根 K 线的时间）
2. **新币种**: 历史 K 线不足 120 根的币种会被跳过
3. **API 请求**: 仍然请求 130 根 K 线，只是在计算时去掉最后一根
4. **兼容性**: 不影响其他模块，只修改计算逻辑

## 相关配置

在 `config.json` 中：

```json
{
  "volumeScore": {
    "volume1": 5,              // MA1 窗口（根）
    "volume2": 120,            // MA2 窗口（根）
    "updateIntervalMs": 60000, // 更新间隔（毫秒）
    "distributeMs": 55000      // 分布时间窗口（毫秒）
  }
}
```

建议保持默认值，已经过优化。

## 修改日期

2025-10-23

## 相关文档

- `VOLUME_SCORE_DISTRIBUTION_STRATEGY.md` - 均匀分布更新策略
- `MIGRATION_SYMBOL_VOLUME_SCORE.md` - 表结构优化
- `SYMBOL_FORMAT_FIX.md` - Symbol 格式统一
