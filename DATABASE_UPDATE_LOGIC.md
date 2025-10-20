# Market State 数据库更新逻辑说明

## 核心机制：每秒覆盖更新

### 工作原理

```
时间线示例（同一分钟内）：

14:25:00 → 计算 → UPSERT(ts_minute=14:25:00, price_score=10.5) → 数据库有1条记录
14:25:01 → 计算 → UPSERT(ts_minute=14:25:00, price_score=11.2) → 覆盖更新，仍是1条记录
14:25:02 → 计算 → UPSERT(ts_minute=14:25:00, price_score=10.8) → 覆盖更新，仍是1条记录
...
14:25:59 → 计算 → UPSERT(ts_minute=14:25:00, price_score=12.3) → 覆盖更新，仍是1条记录

14:26:00 → 计算 → UPSERT(ts_minute=14:26:00, price_score=13.1) → 新分钟，新增1条记录
```

### 关键点

1. **分钟桶对齐**: 所有时间戳向下取整到分钟
   ```javascript
   ts_minute = Math.floor(timestamp / 60000) * 60000
   ```

2. **UPSERT 机制**: 
   - 主键: `ts_minute`（market_state_minute 表）
   - 唯一键: `(ts_minute, symbol)`（market_state_symbol_minute 表）
   - 如果存在则更新，不存在则插入

3. **准实时数据**: 
   - 查询时总是获取最新的计算结果
   - 同一分钟内的最后一次计算结果会保留到下一分钟

---

## 数据库表结构

### market_state_minute 表
```sql
CREATE TABLE market_state_minute (
  ts_minute INTEGER PRIMARY KEY,  -- 分钟时间戳（主键）
  price_score REAL,               -- 价格得分
  volume_score REAL,              -- 成交量得分
  state TEXT,                     -- 市场状态
  details_version INTEGER,        -- 版本号
  created_at TEXT                 -- 创建时间
);
```

### market_state_symbol_minute 表
```sql
CREATE TABLE market_state_symbol_minute (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_minute INTEGER,              -- 分钟时间戳
  symbol TEXT,                    -- 币种符号
  price_score REAL,               -- 价格得分
  vol_score REAL,                 -- 成交量得分
  symbol_score REAL,              -- 总得分
  weight REAL,                    -- 权重
  latest_price REAL,              -- 最新价格
  open_price_5m REAL,             -- 5分钟开盘价
  vol_5m REAL,                    -- 5分钟成交量
  avg_vol_5m_5h REAL,             -- 5小时平均5分钟成交量
  created_at TEXT,                -- 创建时间
  UNIQUE(ts_minute, symbol)       -- 唯一约束
);
```

---

## 更新流程

### 1. 每秒计算
```javascript
// 每秒触发一次
if (now - lastCalcTime >= 1000) {
  calculateMarketState();
}
```

### 2. 计算市场状态
```javascript
const result = await computeMarketStateRealtime(tsMs, reader, options);
// result = { price_score, volume_score, rows: [...] }
```

### 3. 更新数据库
```javascript
const ts_minute = Math.floor(tsMs / 60000) * 60000;

// 更新总体状态（覆盖同一分钟的旧数据）
upsertMarketStateMinute({
  ts_minute,
  price_score,
  volume_score,
  state: state_text,
  details_version: 2,
});

// 更新每个币种的详细数据（覆盖同一分钟+同一symbol的旧数据）
for (const row of rows) {
  upsertMarketStateSymbolMinute({
    ts_minute,
    symbol: row.symbol,
    price_score: row.price_score,
    vol_score: row.vol_score,
    ...
  });
}
```

---

## 查询逻辑

### 获取最新市场状态
```javascript
// strategies/rule3_default.js 中的查询
const avgState = getMarketStateMinuteLast5Min();
// 返回最近5分钟的平均值

const avgState1h = getMarketStateMinuteLast1Hour();
// 返回最近1小时的平均值
```

### 数据新鲜度
```
查询时间: 14:25:45
最新记录: ts_minute=14:25:00, 最后更新于 14:25:44
数据延迟: < 1秒（准实时）
```

---

## 优势分析

### ✅ 准实时性
- **之前**: 最多1分钟延迟（每分钟计算一次）
- **现在**: 最多1秒延迟（每秒更新一次）
- **告警场景**: 发送告警时使用的是最新的市场状态

### ✅ 数据一致性
- 同一分钟只有一条记录
- 避免数据冗余
- 查询简单高效

### ✅ 性能可控
- UPSERT 操作高效（索引查找 + 更新）
- 不会产生大量历史记录
- 数据库大小可控

---

## 性能影响

### 写入频率
```
旧方案: 1次/分钟 × 1条记录 = 1次写入/分钟
新方案: 60次/分钟 × 1条记录（覆盖） = 60次 UPSERT/分钟
```

### UPSERT 性能
- SQLite UPSERT 操作：~1-2ms（有索引）
- 单次更新包含：1条总体记录 + N条币种记录（N=100-500）
- 预估耗时：10-50ms（取决于币种数量）

### 总体影响
- CPU: 略增（每秒计算）
- 磁盘 I/O: 略增（每秒写入）
- 数据库大小: 不变（覆盖更新）
- 查询性能: 不变（记录数量相同）

---

## 示例场景

### 场景1: 告警触发时查询市场状态

```javascript
// 14:25:45 触发告警
const marketState = getMarketStateMinuteLast5Min();

// 查询结果包含：
// - 14:25:00 的记录（最后更新于 14:25:44，延迟1秒）
// - 14:24:00 的记录（最后更新于 14:24:59，延迟46秒）
// - 14:23:00 的记录（最后更新于 14:23:59，延迟106秒）
// ...

// 平均延迟：约30秒（相比旧方案的平均30秒，新方案接近实时）
```

### 场景2: 数据库记录增长

```
旧方案（每分钟保存）:
- 1小时: 60条记录
- 1天: 1440条记录
- 1月: 43200条记录

新方案（每秒覆盖）:
- 1小时: 60条记录（相同）
- 1天: 1440条记录（相同）
- 1月: 43200条记录（相同）

结论: 数据库增长速度完全相同
```

---

## 监控建议

### 关键指标
1. **更新频率**: 应为 ~1次/秒
2. **更新耗时**: 应 < 100ms
3. **数据新鲜度**: 最新记录的 created_at 应在1秒内
4. **错误率**: 应为 0

### 监控查询
```sql
-- 检查最新记录的新鲜度
SELECT 
  datetime(ts_minute/1000, 'unixepoch', 'localtime') as minute,
  datetime(created_at) as updated_at,
  (strftime('%s', 'now') - strftime('%s', created_at)) as age_seconds
FROM market_state_minute 
ORDER BY ts_minute DESC 
LIMIT 1;

-- 应该看到 age_seconds < 2
```

---

## 回滚方案

如果性能有问题，可以调整更新频率：

```javascript
// ws_rule3_monitor.js
this.marketStateCalcIntervalMs = 5000; // 改为每5秒更新一次
```

或恢复到每分钟保存：

```javascript
// 添加分钟去重检查
if (ts_minute !== this.lastMarketStateDbSaveMinute) {
  this.lastMarketStateDbSaveMinute = ts_minute;
  // ... 保存逻辑
}
```

---

## 总结

**新机制的核心优势**:
- ✅ 准实时数据（< 1秒延迟）
- ✅ 数据库大小不变（覆盖更新）
- ✅ 告警使用最新市场状态
- ✅ 性能影响可控

**适用场景**:
- 需要准实时市场状态的告警系统
- 对数据新鲜度要求高的场景
- 可接受略微增加的 CPU 和 I/O 开销
