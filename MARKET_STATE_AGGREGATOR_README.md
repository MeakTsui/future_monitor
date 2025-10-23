# Market State Aggregator - 市场状态聚合器

## 概述

市场状态聚合器用于计算市值 < 5亿美元的所有币种的 MA5（5分钟均值）和 MA60（60分钟均值），并按**相同权重**合并，得出总体市场状态。

---

## 核心变更

### 之前的逻辑
```javascript
// 查询总体聚合的市场状态（所有币种已经加权合并）
const avgState = getMarketStateMinuteLast5Min();
// 返回: { price_score, volume_score, state }
```

**问题**: 无法区分单个币种的表现，无法按需调整权重。

### 现在的逻辑
```javascript
// 1. 获取市值<5亿的所有币种列表
const symbols = getLatestMarketStateSymbols();

// 2. 批量获取每个币种的历史数据
const stateHistory5 = getBatchSymbolStateMinutesHistory(symbols, 5);
const stateHistory60 = getBatchSymbolStateMinutesHistory(symbols, 60);

// 3. 计算每个币种的 MA5 和 MA60
for (const symbol of symbols) {
  const ma5 = computeSymbolMA(stateHistory5.get(symbol));
  const ma60 = computeSymbolMA(stateHistory60.get(symbol));
}

// 4. 相同权重合并（简单平均）
const totalMA5 = sum(all_ma5) / count;
const totalMA60 = sum(all_ma60) / count;
```

**优势**: 
- ✅ 每个币种独立计算 MA
- ✅ 相同权重合并（不受市值影响）
- ✅ 灵活调整权重策略
- ✅ 准确反映市场整体情绪

---

## 文件结构

### 新增文件

1. **`market_state_aggregator.js`** - 核心聚合逻辑
   - `computeWeightedMarketStateMA()` - 主计算函数
   - `computeSymbolMA()` - 单币种 MA 计算
   - `clearCache()` - 清除缓存

2. **`test_market_state_aggregator.js`** - 测试脚本
   - 验证数据库查询
   - 测试聚合计算
   - 性能评估

### 修改文件

1. **`db.js`** - 新增数据库查询函数
   - `getSymbolStateMinutesHistory()` - 单币种历史查询
   - `getBatchSymbolStateMinutesHistory()` - 批量查询（性能优化）
   - `getLatestMarketStateSymbols()` - 获取最新币种列表

2. **`ws_rule3_monitor.js`** - 添加价格获取接口
   - `getAllPrices()` - 返回所有币种的实时价格

3. **`strategies/rule3_default.js`** - 更新市场状态获取逻辑
   - 使用 `computeWeightedMarketStateMA()` 替代旧函数

4. **`strategies/rule3_tier_bypass.js`** - 更新市场状态获取逻辑
   - 使用 `computeWeightedMarketStateMA()` 替代旧函数

---

## API 说明

### computeWeightedMarketStateMA()

```javascript
import { computeWeightedMarketStateMA } from './market_state_aggregator.js';

const result = await computeWeightedMarketStateMA(
  maxMarketCapUsd,  // 最大市值（默认 500_000_000）
  priceMap          // 实时价格 Map（可选，用于未来扩展）
);

// 返回值
{
  ma5: {
    price_score: 12.34,      // 5分钟价格得分均值（范围 -100 ~ 100）
    volume_score: 2.15,      // 5分钟成交量得分均值（成交量倍数，范围 0 ~ ∞，实际 0.5 ~ 5）
    symbols_count: 180       // 参与计算的币种数量
  },
  ma60: {
    price_score: 10.23,      // 60分钟价格得分均值（范围 -100 ~ 100）
    volume_score: 1.85,      // 60分钟成交量得分均值（成交量倍数，范围 0 ~ ∞，实际 0.5 ~ 5）
    symbols_count: 175       // 参与计算的币种数量
  }
}
```

### 在策略中使用

```javascript
// strategies/rule3_default.js

import { computeWeightedMarketStateMA } from '../market_state_aggregator.js';

// 构建实时价格 Map
const priceMap = new Map();
if (helpers && typeof helpers.getAllPrices === 'function') {
  const prices = helpers.getAllPrices();
  for (const [sym, price] of Object.entries(prices)) {
    priceMap.set(sym, price);
  }
}

// 计算市场状态 MA
const marketStateMA = await computeWeightedMarketStateMA(500_000_000, priceMap);

// 使用结果
const marketStateRes = {
  price_score: marketStateMA.ma5.price_score,
  volume_score: marketStateMA.ma5.volume_score,
  sample_count: marketStateMA.ma5.symbols_count,
};

const marketState1h = {
  price_score_1h: marketStateMA.ma60.price_score,
  sample_count_1h: marketStateMA.ma60.symbols_count,
};
```

---

## 数据流程

```
1. 策略触发告警
   ↓
2. 调用 computeWeightedMarketStateMA()
   ↓
3. 从数据库获取最近一次市场状态计算的币种列表
   (这些币种已经是市值<5亿的，由 ws_rule3_monitor 筛选)
   ↓
4. 批量查询所有币种的最近5分钟和60分钟的 state 数据
   ↓
5. 对每个币种计算 MA5 和 MA60
   MA = (sum of price_score) / count
   ↓
6. 相同权重合并所有币种的 MA
   Total MA = (sum of all symbol MA) / symbol_count
   ↓
7. 将 price_score 乘以100，volume_score 保持原值
   price_score: -1~1 → -100~100
   volume_score: 保持成交量倍数（0~∞）
   ↓
8. 返回结果并缓存（1秒）
```

---

## 性能优化

### 1. 缓存机制
- **缓存时长**: 1秒
- **缓存键**: 无（全局缓存）
- **缓存清除**: 自动（超时）或手动（`clearCache()`）

```javascript
// 第一次调用：查询数据库 + 计算
const result1 = await computeWeightedMarketStateMA(); // ~50-100ms

// 1秒内的后续调用：使用缓存
const result2 = await computeWeightedMarketStateMA(); // <1ms
```

### 2. 批量查询
使用 SQL `IN` 语句批量查询，减少数据库访问次数：

```sql
SELECT symbol, ts_minute, price_score, vol_score
FROM market_state_symbol_minute 
WHERE symbol IN (?, ?, ..., ?) AND ts_minute >= ?
```

### 3. 性能指标

| 操作 | 预期耗时 | 说明 |
|------|---------|------|
| 数据库查询 | 30-80ms | 取决于币种数量（100-500个） |
| MA 计算 | 5-20ms | 纯内存计算 |
| 总耗时 | 50-100ms | 首次调用 |
| 缓存命中 | <1ms | 1秒内重复调用 |

---

## 测试验证

### 运行测试脚本

```bash
node test_market_state_aggregator.js
```

### 测试内容

1. ✅ 检查数据库中的币种数量
2. ✅ 验证单个币种的历史数据
3. ✅ 执行聚合计算
4. ✅ 验证结果格式
5. ✅ 测试缓存机制
6. ✅ 性能评估

### 预期输出

```
=== 测试市场状态聚合器 ===

1. 检查最近一次市场状态计算的币种...
   找到 180 个币种

2. 检查单个币种的历史数据...
   BTCUSDT 的 MA5 数据点: 5
   BTCUSDT 的 MA60 数据点: 60

3. 执行市场状态聚合计算...
   计算完成，耗时: 65ms

4. 聚合结果:
   MA5 (5分钟均值):
   - price_score: 12.3456
   - volume_score: 45.6789
   - symbols_count: 180

   MA60 (60分钟均值):
   - price_score: 10.2345
   - volume_score: 40.1234
   - symbols_count: 175

5. 测试缓存机制...
   第二次调用耗时: 0ms (应该 < 5ms，使用缓存)

6. 性能评估:
   ✓ 计算速度优秀 (65ms < 100ms)
   ✓ MA5 有效数据 (180 个币种)
   ✓ MA60 有效数据 (175 个币种)

=== 测试完成 ===
```

---

## 权重策略

### 当前策略：相同权重（简单平均）

```javascript
// 每个币种权重相同
weight = 1 / symbols_count

// 总分计算
total_price_score = sum(symbol_price_score) / symbols_count
total_volume_score = sum(symbol_volume_score) / symbols_count
```

### 未来可扩展的权重策略

如果需要改为市值加权或其他策略，只需修改 `computeWeightedMarketStateMA()` 函数：

```javascript
// 市值加权示例
let totalMarketCap = 0;
for (const symbol of symbols) {
  const price = priceMap.get(symbol) || 0;
  const supply = supplyMap.get(symbol) || 0;
  const marketCap = price * supply;
  totalMarketCap += marketCap;
}

// 计算加权 MA
for (const ma of symbolMA5List) {
  const weight = marketCap / totalMarketCap;
  totalPriceScore5 += ma.price_score_ma * weight;
  totalVolScore5 += ma.vol_score_ma * weight;
}
```

---

## 故障排查

### 问题1: symbols_count 为 0

**原因**: 数据库中没有市场状态数据

**解决**:
```bash
# 检查 ws-rule3 进程是否运行
pm2 list | grep ws-rule3

# 检查数据库
sqlite3 data.sqlite "SELECT COUNT(*) FROM market_state_symbol_minute;"

# 如果为0，等待市场状态计算运行（每秒一次）
pm2 logs ws-rule3 | grep "市场状态已更新"
```

### 问题2: 计算耗时过长

**原因**: 币种数量过多或数据库性能问题

**解决**:
```bash
# 检查币种数量
sqlite3 data.sqlite "SELECT COUNT(DISTINCT symbol) FROM market_state_symbol_minute WHERE ts_minute = (SELECT MAX(ts_minute) FROM market_state_symbol_minute);"

# 如果超过500个，检查市值筛选逻辑
# 查看 market_state_calculator.js 中的 maxSymbols 配置
```

### 问题3: MA60 数据不足

**原因**: 系统运行时间不足60分钟

**解决**: 等待系统运行至少60分钟后，MA60 数据才会完整

---

## 监控建议

### 关键指标

1. **计算耗时**: 应 < 100ms
2. **缓存命中率**: 应 > 90%（1秒内多次调用）
3. **参与币种数**: 应在 100-500 之间
4. **MA5 数据点**: 应 = 5（每个币种）
5. **MA60 数据点**: 应 = 60（每个币种）

### 日志监控

```bash
# 查看计算日志
pm2 logs ws-rule3 | grep "计算市场状态MA完成"

# 查看性能日志
pm2 logs ws-rule3 | grep "ma5_price"

# 查看错误日志
pm2 logs ws-rule3 --err | grep "计算市场状态MA失败"
```

---

## 总结

### ✅ 完成的功能

1. 每个币种独立计算 MA5 和 MA60
2. 相同权重合并（简单平均）
3. 批量查询优化性能
4. 1秒缓存机制
5. 完整的测试脚本
6. 集成到两个策略文件

### 📊 性能指标

- **计算频率**: 按需计算（告警触发时）
- **缓存时长**: 1秒
- **单次耗时**: 50-100ms
- **缓存命中**: <1ms
- **币种数量**: 100-500个

### 🚀 后续优化

1. 添加更多权重策略（市值加权、成交量加权等）
2. 支持自定义时间窗口（不限于5分钟和60分钟）
3. 添加异常币种过滤（剔除异常数据）
4. 性能监控和告警
