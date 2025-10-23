# Symbol 格式统一修复说明

## 问题描述

在实现 `market_volume_score_2` 功能时，发现不同模块中 symbol 的格式不一致，导致数据无法正确匹配。

## Symbol 格式对比

### 1. `supplies` 表（市值数据）
- **来源**: `supply_sync_binance.js` 从 Binance API 同步
- **格式**: 基础资产符号（baseAsset）
- **示例**: `BTC`, `ETH`, `SOL`, `DOGE`
- **说明**: 不带报价币种后缀

### 2. `symbol_volume_score` 表（成交量数据）
- **来源**: `volume_score_calculator.js` 计算
- **格式**: 完整合约符号
- **示例**: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `DOGEUSDT`
- **说明**: 带 USDT 后缀的永续合约符号

### 3. `ws_rule3_monitor.js`（实时监控）
- **格式**: 完整合约符号
- **示例**: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`
- **说明**: 与 Binance WebSocket 保持一致

## 问题影响

在市场整体 volume score 计算时：

```javascript
// volume_score_calculator.js - runMarketVolumeScoreLoop()
const symbolsUnder500M = getSymbolsWithMarketCapLessThan(500_000_000);
// 返回: ['BTC', 'ETH', 'SOL', ...]  ← 基础资产格式

const scores = getLatestSymbolVolumeScores(symbolsUnder500M, tsMinute);
// 查询 symbol_volume_score 表，但表中存储的是 'BTCUSDT', 'ETHUSDT' 格式
// 结果: 无法匹配，scores.length = 0
```

## 解决方案

### 修改 `db.js` 中的 `getSymbolsWithMarketCapLessThan` 函数

**修改前:**
```javascript
export function getSymbolsWithMarketCapLessThan(maxMarketCap) {
  const stmt = db.prepare(`
    SELECT symbol FROM supplies 
    WHERE market_cap > 0 AND market_cap < ?
    ORDER BY symbol
    LIMIT 500
  `);
  return stmt.all(maxMarketCap).map(row => row.symbol);
  // 返回: ['BTC', 'ETH', 'SOL', ...]
}
```

**修改后:**
```javascript
export function getSymbolsWithMarketCapLessThan(maxMarketCap) {
  const stmt = db.prepare(`
    SELECT symbol FROM supplies 
    WHERE market_cap > 0 AND market_cap < ?
    ORDER BY symbol
    LIMIT 500
  `);
  // 将基础资产符号转换为 USDT 永续合约符号
  return stmt.all(maxMarketCap).map(row => row.symbol + 'USDT');
  // 返回: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', ...]
}
```

## 数据流程（修复后）

```
1. supply_sync_binance.js
   ↓
   从 Binance API 获取基础资产: BTC, ETH, SOL
   ↓
   保存到 supplies 表: symbol='BTC', market_cap=500000000

2. volume_score_calculator.js
   ↓
   从 Binance API 获取合约: BTCUSDT, ETHUSDT, SOLUSDT
   ↓
   保存到 symbol_volume_score 表: symbol='BTCUSDT', volume_score=1.23

3. 市场整体计算
   ↓
   查询 supplies 表: WHERE market_cap < 500000000
   ↓
   得到基础资产: ['BTC', 'ETH', 'SOL']
   ↓
   转换为合约符号: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']  ← 修复点
   ↓
   查询 symbol_volume_score 表: WHERE symbol IN ('BTCUSDT', 'ETHUSDT', ...)
   ↓
   成功匹配！计算市场整体 volume_score_2
```

## 验证

修复后，可以通过以下方式验证：

```javascript
// 1. 检查 supplies 表
SELECT symbol, market_cap FROM supplies WHERE market_cap < 500000000 LIMIT 10;
// 结果: BTC, ETH, SOL, ...

// 2. 检查 symbol_volume_score 表
SELECT DISTINCT symbol FROM symbol_volume_score LIMIT 10;
// 结果: BTCUSDT, ETHUSDT, SOLUSDT, ...

// 3. 检查转换后的查询
// getSymbolsWithMarketCapLessThan(500000000)
// 返回: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', ...]

// 4. 检查市场 volume score 计算日志
// 应该看到 symbolsCount > 0
```

## 注意事项

1. **不修改现有表结构**: 保持 `supplies` 表和 `symbol_volume_score` 表的原有格式
2. **仅在查询时转换**: 在 `getSymbolsWithMarketCapLessThan` 函数中转换格式
3. **假设所有合约都是 USDT 永续**: 当前实现假设所有需要的合约都是 USDT 报价的永续合约
4. **特殊情况**: 如果未来需要支持其他报价币种（如 BUSD），需要调整转换逻辑

## 相关文件

- `/Users/cuishiqiang/project/js/future_monitor/db.js` - 数据库操作函数
- `/Users/cuishiqiang/project/js/future_monitor/supply_sync_binance.js` - 市值数据同步
- `/Users/cuishiqiang/project/js/future_monitor/volume_score_calculator.js` - Volume Score 计算

## 修复日期

2025-10-23
