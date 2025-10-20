# Market State 获取逻辑修改总结

## 修改完成时间
2025-10-20 15:08

---

## 核心变更

### 变更内容

**之前**: 查询总体聚合的市场状态（所有币种已加权合并）
```javascript
const avgState = getMarketStateMinuteLast5Min();
// 返回: { price_score, volume_score, state }
```

**现在**: 查询市值<5亿的所有币种，分别计算每个币种的MA5和MA60，然后相同权重合并
```javascript
const marketStateMA = await computeWeightedMarketStateMA(500_000_000, priceMap);
// 返回: { 
//   ma5: { price_score, volume_score, symbols_count },
//   ma60: { price_score, volume_score, symbols_count }
// }
```

---

## 修改的文件

### 1. `db.js` - 新增数据库查询函数

**新增函数**:
```javascript
// 获取指定币种的最近N分钟的 state 数据
getSymbolStateMinutesHistory(symbol, minutes)

// 批量获取多个币种的最近N分钟的 state 数据（性能优化）
getBatchSymbolStateMinutesHistory(symbols, minutes)

// 获取最近一次市场状态计算中的所有币种列表
getLatestMarketStateSymbols()
```

**作用**: 提供高效的数据库查询接口，支持批量查询减少数据库访问次数。

---

### 2. `market_state_aggregator.js` - 新增核心聚合模块

**主要函数**:
```javascript
// 计算单个币种的 MA
computeSymbolMA(stateHistory)

// 计算市值加权的总体市场状态（相同权重版本）
computeWeightedMarketStateMA(maxMarketCapUsd, priceMap)

// 清除缓存
clearCache()
```

**核心逻辑**:
1. 获取市值<5亿的所有币种列表（从最新的市场状态计算结果）
2. 批量查询所有币种的MA5和MA60数据
3. 计算每个币种的MA（简单平均）
4. 相同权重合并所有币种的MA（简单平均）
5. 缓存结果1秒

**性能优化**:
- 使用 SQL IN 批量查询
- 1秒缓存机制
- 预期耗时: 50-100ms（首次），<1ms（缓存命中）

---

### 3. `ws_rule3_monitor.js` - 添加价格获取接口

**新增方法**:
```javascript
getAllPrices: () => {
  const prices = {};
  for (const [symbol, price] of this.lastClosePrice.entries()) {
    prices[symbol] = price;
  }
  return prices;
}
```

**作用**: 为策略提供所有币种的实时价格，用于未来扩展（如市值加权）。

---

### 4. `strategies/rule3_default.js` - 更新市场状态获取逻辑

**修改位置**: 第294-333行

**旧代码**:
```javascript
const avgState = getMarketStateMinuteLast5Min();
const avgState1h = getMarketStateMinuteLast1Hour();
```

**新代码**:
```javascript
// 构建实时价格 Map
const priceMap = new Map();
if (helpers && typeof helpers.getAllPrices === 'function') {
  const prices = helpers.getAllPrices();
  for (const [sym, price] of Object.entries(prices)) {
    priceMap.set(sym, price);
  }
}

const marketStateMA = await computeWeightedMarketStateMA(500_000_000, priceMap);

marketStateRes = {
  price_score: marketStateMA.ma5.price_score,
  volume_score: marketStateMA.ma5.volume_score,
  sample_count: marketStateMA.ma5.symbols_count,
};

marketState1h = {
  price_score_1h: marketStateMA.ma60.price_score,
  sample_count_1h: marketStateMA.ma60.symbols_count,
};
```

---

### 5. `strategies/rule3_tier_bypass.js` - 更新市场状态获取逻辑

**修改位置**: 第170-211行

**修改内容**: 与 `rule3_default.js` 相同，使用新的聚合器计算市场状态MA。

---

## 新增文件

1. **`market_state_aggregator.js`** - 核心聚合逻辑（155行）
2. **`test_market_state_aggregator.js`** - 测试脚本（120行）
3. **`MARKET_STATE_AGGREGATOR_README.md`** - 详细文档
4. **`MARKET_STATE_CHANGES.md`** - 本文档

---

## 数据流程对比

### 旧流程
```
策略触发 → 查询数据库总体聚合结果 → 使用结果
```

### 新流程
```
策略触发
  ↓
获取最新币种列表（市值<5亿）
  ↓
批量查询所有币种的MA5和MA60数据
  ↓
计算每个币种的MA
  ↓
相同权重合并
  ↓
返回结果（带缓存）
```

---

## 权重策略

### 当前实现：相同权重（简单平均）

```javascript
// 每个币种权重相同
weight = 1 / symbols_count

// 总分计算
total_price_score = sum(all_symbol_price_score) / symbols_count
total_volume_score = sum(all_symbol_volume_score) / symbols_count
```

**优势**:
- ✅ 简单直观
- ✅ 每个币种平等对待
- ✅ 不受市值波动影响
- ✅ 计算快速

---

## 性能指标

| 指标 | 数值 | 说明 |
|------|------|------|
| 计算频率 | 按需 | 告警触发时计算 |
| 缓存时长 | 1秒 | 减少重复计算 |
| 首次耗时 | 50-100ms | 包含数据库查询 |
| 缓存命中 | <1ms | 使用缓存结果 |
| 币种数量 | 100-500 | 市值<5亿的币种 |
| MA5 数据点 | 5 | 每个币种5分钟数据 |
| MA60 数据点 | 60 | 每个币种60分钟数据 |

---

## 测试验证

### 运行测试

```bash
node test_market_state_aggregator.js
```

### 测试内容

1. ✅ 检查数据库中的币种数量
2. ✅ 验证单个币种的历史数据
3. ✅ 执行聚合计算
4. ✅ 验证结果格式
5. ✅ 测试缓存机制
6. ✅ 清除缓存并重新计算
7. ✅ 验证结果一致性
8. ✅ 性能评估

---

## 部署步骤

### 1. 确认前置条件

```bash
# 确认 ws-rule3 进程正在运行
pm2 list | grep ws-rule3

# 确认数据库有市场状态数据
sqlite3 data.sqlite "SELECT COUNT(*) FROM market_state_symbol_minute;"
```

### 2. 重启服务

```bash
# 重启 ws-rule3 进程
pm2 restart ws-rule3

# 查看日志
pm2 logs ws-rule3 --lines 50
```

### 3. 验证运行

```bash
# 等待告警触发，查看新的市场状态计算日志
pm2 logs ws-rule3 | grep "计算市场状态MA完成"

# 应该看到类似日志：
# "计算市场状态MA完成 {"price_score_ma5":"12.34","volume_score_ma5":"45.67","symbols_count_ma5":180,...}"
```

---

## 优势分析

### ✅ 更精细
- 每个币种独立计算MA，反映个体表现
- 可以识别异常币种并过滤

### ✅ 更灵活
- 支持多种权重策略（当前为相同权重）
- 可以轻松切换到市值加权或其他策略

### ✅ 更准确
- 基于每个币种的历史数据计算MA
- 避免了总体聚合可能掩盖的细节

### ✅ 性能可控
- 批量查询优化
- 1秒缓存机制
- 预期耗时在可接受范围内

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 查询耗时过长 | 告警延迟 | 批量查询 + 缓存 |
| 币种数据缺失 | 部分币种无MA | 跳过无数据币种 |
| 计算异常 | 告警失败 | try-catch 包裹 |
| 缓存过期 | 重复计算 | 1秒缓存足够 |

---

## 监控建议

### 关键日志

```bash
# 查看计算成功日志
pm2 logs ws-rule3 | grep "计算市场状态MA完成"

# 查看计算失败日志
pm2 logs ws-rule3 | grep "计算市场状态MA失败"

# 查看缓存使用日志
pm2 logs ws-rule3 | grep "使用缓存的市场状态MA结果"
```

### 性能监控

```bash
# 检查计算耗时（应 < 100ms）
pm2 logs ws-rule3 | grep "ma5_price"

# 检查币种数量（应在 100-500 之间）
pm2 logs ws-rule3 | grep "symbols_count_ma5"
```

---

## 后续优化建议

1. **多种权重策略**: 支持市值加权、成交量加权等
2. **自定义时间窗口**: 不限于5分钟和60分钟
3. **异常币种过滤**: 剔除异常数据点
4. **性能监控**: 添加详细的性能指标统计
5. **告警优化**: 根据新的MA值调整告警阈值

---

## 文档索引

- **详细文档**: `MARKET_STATE_AGGREGATOR_README.md`
- **测试脚本**: `test_market_state_aggregator.js`
- **核心代码**: `market_state_aggregator.js`
- **本文档**: `MARKET_STATE_CHANGES.md`

---

## 联系与支持

如有问题，请查看日志或联系开发团队。

**修改完成** ✅
