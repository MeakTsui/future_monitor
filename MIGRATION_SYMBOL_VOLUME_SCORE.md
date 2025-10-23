# symbol_volume_score 表结构优化

## 问题描述

原设计中，`symbol_volume_score` 表每分钟为每个币种新增一条记录：
- 每分钟新增 500+ 条记录
- 数据不断累积，表会越来越大
- 查询时需要按 `ts_minute` 过滤

## 优化方案

修改为每个币种只保留最新的一条记录：
- 表中始终保持约 500 条数据（每个币种一条）
- 每次更新覆盖旧数据
- 查询更简单高效

## 表结构变更

### 修改前
```sql
CREATE TABLE IF NOT EXISTS symbol_volume_score (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_minute INTEGER,
  symbol TEXT,
  volume_ma1 REAL,
  volume_ma2 REAL,
  volume_score REAL,
  created_at TEXT,
  UNIQUE(ts_minute, symbol)  -- 每个币种每分钟一条记录
);
```

### 修改后
```sql
CREATE TABLE IF NOT EXISTS symbol_volume_score (
  symbol TEXT PRIMARY KEY,      -- symbol 作为主键
  ts_minute INTEGER,             -- 最后更新的时间戳
  volume_ma1 REAL,
  volume_ma2 REAL,
  volume_score REAL,
  updated_at TEXT                -- 记录更新时间
);
```

## 代码变更

### 1. db.js - upsertSymbolVolumeScore

**修改前:**
```javascript
export function upsertSymbolVolumeScore({ ts_minute, symbol, volume_ma1, volume_ma2, volume_score }) {
  const stmt = db.prepare(`INSERT INTO symbol_volume_score (
    ts_minute, symbol, volume_ma1, volume_ma2, volume_score, created_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(ts_minute, symbol) DO UPDATE SET
    volume_ma1=excluded.volume_ma1,
    volume_ma2=excluded.volume_ma2,
    volume_score=excluded.volume_score`);
  stmt.run(ts_minute, symbol, volume_ma1, volume_ma2, volume_score, new Date().toISOString());
}
```

**修改后:**
```javascript
export function upsertSymbolVolumeScore({ ts_minute, symbol, volume_ma1, volume_ma2, volume_score }) {
  const stmt = db.prepare(`INSERT INTO symbol_volume_score (
    symbol, ts_minute, volume_ma1, volume_ma2, volume_score, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(symbol) DO UPDATE SET              -- 按 symbol 冲突检测
    ts_minute=excluded.ts_minute,
    volume_ma1=excluded.volume_ma1,
    volume_ma2=excluded.volume_ma2,
    volume_score=excluded.volume_score,
    updated_at=excluded.updated_at`);
  stmt.run(symbol, ts_minute, volume_ma1, volume_ma2, volume_score, new Date().toISOString());
}
```

### 2. db.js - getLatestSymbolVolumeScores

**修改前:**
```javascript
export function getLatestSymbolVolumeScores(symbols, ts_minute) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];
  const placeholders = symbols.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT * FROM symbol_volume_score 
    WHERE symbol IN (${placeholders}) AND ts_minute = ?
  `);
  return stmt.all(...symbols, ts_minute);
}
```

**修改后:**
```javascript
export function getLatestSymbolVolumeScores(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];
  const placeholders = symbols.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT * FROM symbol_volume_score 
    WHERE symbol IN (${placeholders})
  `);
  return stmt.all(...symbols);  // 不需要 ts_minute 参数
}
```

### 3. volume_score_calculator.js

**修改前:**
```javascript
const scores = getLatestSymbolVolumeScores(symbolsUnder500M, tsMinute);
```

**修改后:**
```javascript
const scores = getLatestSymbolVolumeScores(symbolsUnder500M);
```

## 数据迁移步骤

如果已有旧数据，需要手动迁移：

### 方法1：删除旧表重建（推荐，如果不需要历史数据）

```bash
# 1. 停止 volume-score-calc 进程
pm2 stop volume-score-calc

# 2. 删除旧表
sqlite3 data.sqlite "DROP TABLE IF EXISTS symbol_volume_score;"

# 3. 重启应用（会自动创建新表结构）
pm2 restart all
```

### 方法2：保留历史数据并迁移

```sql
-- 1. 备份旧表
ALTER TABLE symbol_volume_score RENAME TO symbol_volume_score_old;

-- 2. 创建新表
CREATE TABLE symbol_volume_score (
  symbol TEXT PRIMARY KEY,
  ts_minute INTEGER,
  volume_ma1 REAL,
  volume_ma2 REAL,
  volume_score REAL,
  updated_at TEXT
);

-- 3. 迁移最新数据（每个币种取最新的一条）
INSERT INTO symbol_volume_score (symbol, ts_minute, volume_ma1, volume_ma2, volume_score, updated_at)
SELECT symbol, ts_minute, volume_ma1, volume_ma2, volume_score, created_at
FROM symbol_volume_score_old
WHERE (symbol, ts_minute) IN (
  SELECT symbol, MAX(ts_minute)
  FROM symbol_volume_score_old
  GROUP BY symbol
);

-- 4. 验证数据
SELECT COUNT(*) FROM symbol_volume_score;  -- 应该约等于币种数量

-- 5. 删除旧表（确认无误后）
DROP TABLE symbol_volume_score_old;
```

## 优势

1. **存储优化**: 表大小从无限增长变为固定约 500 条
2. **查询简化**: 不需要按时间过滤和排序
3. **性能提升**: 主键查询更快
4. **逻辑清晰**: 每个币种一条最新记录，符合业务需求

## 注意事项

1. **历史数据**: 新设计不保留历史数据，如需历史分析，建议定期导出到其他表
2. **时间戳**: `ts_minute` 字段仍然保留，记录最后更新的时间
3. **并发**: SQLite 的 `ON CONFLICT` 机制保证并发安全

## 验证

启动后检查表数据：

```sql
-- 查看表结构
.schema symbol_volume_score

-- 查看记录数（应该约等于交易对数量）
SELECT COUNT(*) FROM symbol_volume_score;

-- 查看示例数据
SELECT * FROM symbol_volume_score LIMIT 10;

-- 检查是否有重复的 symbol
SELECT symbol, COUNT(*) as cnt 
FROM symbol_volume_score 
GROUP BY symbol 
HAVING cnt > 1;  -- 应该返回空结果
```

## 修改日期

2025-10-23
