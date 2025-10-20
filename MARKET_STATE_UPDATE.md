# Market State 计算逻辑更新说明

## 更新时间
2025-10-20

## 主要变更

### 1. 计算频率变更
- **之前**: 每分钟计算一次（独立进程 `market_state_cron.js`）
- **现在**: 每秒计算一次（集成到 `ws_rule3_monitor.js`）
- **数据库更新**: 每秒更新到数据库（同一分钟桶内覆盖更新，UPSERT 机制）
- **优势**: 查询时获取准实时数据，告警时使用最新市场状态

### 2. 币种池选择逻辑
- **之前**: 固定池（ETH + SOL + 排名51-130的80个币种）
- **现在**: 动态池（所有市值 < 5亿美元的币种）
- **排序方式**: 使用实时价格 × 流通供应量计算市值，按市值降序排序
- **数量限制**: 最多500个币种（可配置）

### 3. 权重计算方式
- **之前**: 固定权重（ETH=0.15, SOL=0.05, 其他=0.01）
- **现在**: 市值加权（每个币种权重 = 该币种市值 / 总市值）
- **优势**: 更合理反映市场结构，大市值币种影响更大

### 4. 数据源变更
- **之前**: 从 Binance REST API 获取K线数据
- **现在**: 从 WebSocket 滑动窗口直接读取（零延迟）
- **价格来源**: 使用 WS 实时价格计算市值

### 5. 进程架构调整
- **之前**: 独立的 `market-state` 进程
- **现在**: 集成到 `ws-rule3` 进程
- **优势**: 减少进程数量，直接访问内存数据

---

## 修改的文件

### 1. `db.js`
**新增函数**:
```javascript
getAllSymbolsWithCirculatingSupply()
```
- 查询所有有流通供应量的币种
- 用于实时市值计算

### 2. `market_state_calculator.js`
**主要修改**:
- 币种池获取逻辑：从固定池改为动态市值筛选
- 权重计算：从固定权重改为市值加权
- 添加实时价格获取接口 `readers.getPrice(symbol)`
- 添加市值排序逻辑

**缓存策略**:
- 供应量数据：每小时更新一次
- 均量数据：每小时更新一次
- 币种池：每次计算时根据实时价格动态筛选

### 3. `ws_rule3_monitor.js`
**新增功能**:
- 市场状态计算集成（每秒触发）
- 按分钟去重保存到数据库
- 提供价格读取接口给计算模块

**新增属性**:
```javascript
this.lastMarketStateCalcMs = 0;
this.marketStateCalcIntervalMs = 1000; // 每秒
this.lastMarketStateDbSaveMinute = 0;
```

**新增方法**:
```javascript
async _calculateMarketState(tsMs, config)
```

### 4. `ecosystem.config.cjs`
**变更**:
- 注释掉独立的 `market-state` 进程
- 添加 `ws-rule3` 进程配置

---

## 配置参数

在 `config.json` 中可配置：

```json
{
  "rule3ws": {
    "marketCapMaxUsd": 500000000,  // 最大市值（5亿美元）
    "maxSymbols": 500,              // 最多计算币种数
    "logLevel": "info"
  }
}
```

---

## 性能考虑

### 计算频率
- **每秒计算**: 实时性更好，但CPU占用略增
- **每秒更新数据库**: UPSERT 覆盖更新，同一分钟只有一条记录
- **数据库写入**: 使用 UPSERT 机制，性能影响可控
- **预期影响**: 单次计算+写入 < 150ms（取决于币种数量）

### 币种数量
- **当前**: 预估200-400个币种（市值 < 5亿）
- **限制**: 最多500个（防止性能问题）
- **排序**: 按市值降序，优先计算大市值币种

### 内存占用
- **供应量缓存**: ~1MB（每小时更新）
- **价格数据**: 来自 WS 窗口（已有）
- **计算结果**: 临时对象，计算后释放

---

## 测试验证

### 1. 运行测试脚本
```bash
node test_market_state.js
```

**验证项**:
- 数据库查询是否正常
- 市值计算是否正确
- 权重总和是否接近 1.0
- 计算耗时是否合理

### 2. 启动服务
```bash
# 停止旧的 market-state 进程
pm2 stop market-state
pm2 delete market-state

# 启动新的 ws-rule3 进程
pm2 start ecosystem.config.cjs --only ws-rule3

# 查看日志
pm2 logs ws-rule3 --lines 100
```

### 3. 验证数据库
```bash
sqlite3 data.sqlite

# 查看最新的市场状态记录
SELECT 
  datetime(ts_minute/1000, 'unixepoch') as time,
  price_score, 
  volume_score,
  state
FROM market_state_minute 
ORDER BY ts_minute DESC 
LIMIT 10;

# 查看币种详情
SELECT 
  symbol,
  price_score,
  vol_score,
  weight,
  latest_price
FROM market_state_symbol_minute 
WHERE ts_minute = (SELECT MAX(ts_minute) FROM market_state_minute)
ORDER BY weight DESC
LIMIT 20;
```

---

## 回滚方案

如果需要回滚到旧版本：

1. 恢复 `ecosystem.config.cjs` 中的 `market-state` 进程配置
2. 停止 `ws-rule3` 进程
3. 启动 `market-state` 进程

```bash
pm2 stop ws-rule3
pm2 start ecosystem.config.cjs --only market-state
```

---

## 注意事项

### 1. 供应量数据依赖
- 必须确保 `supply-sync-binance` 进程正常运行
- 每天更新2次（0:00 和 3:00）
- 如果供应量数据缺失，该币种不会参与计算

### 2. WebSocket 连接
- 市场状态计算依赖 WS 连接正常
- 启动后等待5秒让 WS 建立连接
- 如果 WS 断开，计算会继续但使用缓存价格

### 3. 数据库写入
- 每分钟只写入一次（按分钟桶去重）
- 使用 UPSERT 避免重复记录
- 详细数据表可能较大，建议定期清理旧数据

### 4. 日志级别
- 默认 `info` 级别
- 调试时可设置为 `debug` 查看详细信息
- 生产环境建议 `info` 或 `warn`

---

## 后续优化建议

1. **性能监控**: 添加计算耗时统计
2. **数据清理**: 定期清理超过30天的详细数据
3. **告警阈值**: 根据新的分数范围调整告警策略
4. **可视化**: 更新前端图表展示新的市值加权逻辑
5. **A/B测试**: 对比新旧算法的告警质量

---

## 联系方式

如有问题，请查看日志或联系开发团队。
