# 均量（平均成交量）数据来源说明

## 📊 均量是什么

**均量** = `avg_vol_5m_5h` = **5小时内的平均5分钟成交量**

用于衡量每个币种的"正常"成交量水平，作为计算 volume_score 的基准。

---

## 🔄 数据流程

### 1. 数据计算（每小时一次）

**文件**: `avg_vol_hourly.js`  
**触发**: PM2 定时任务，每小时整点运行（cron: `0 * * * *`）

```javascript
// 计算逻辑（第27-46行）
async function computeAndSave(tsHour) {
  // 1. 获取所有需要监控的币种
  const snap = getLatestUniverseSnapshotBefore(tsHour);
  const symbols = ['ETHUSDT', 'SOLUSDT', ...(snap.selected_51_130 || [])];
  
  // 2. 对每个币种计算均量
  for (const sym of symbols) {
    // 2.1 获取最近320分钟的K线数据
    const ks = await fetchKlines1m(sym, 320);
    
    // 2.2 取最近300分钟（5小时）的数据
    const last300 = sliceLastMinutesFromKlines(ks, 300);
    
    // 2.3 计算5小时总成交量
    const vol5h = sumVolumes(last300);
    
    // 2.4 计算平均5分钟成交量
    const avg5m = vol5h / 60;  // 300分钟 / 5分钟 = 60个周期
    
    // 2.5 保存到数据库
    await upsertAvgVolHourly({ 
      ts_hour: tsHour, 
      symbol: sym, 
      avg_vol_5m_5h: avg5m 
    });
  }
}
```

### 2. 数据存储

**数据库表**: `market_avg_vol_5m_5h_hourly`

```sql
CREATE TABLE market_avg_vol_5m_5h_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_hour INTEGER,              -- 小时时间戳（整点）
  symbol TEXT,                  -- 币种符号
  avg_vol_5m_5h REAL,          -- 5小时平均5分钟成交量
  created_at TEXT,              -- 创建时间
  UNIQUE(ts_hour, symbol)       -- 每小时每币种一条记录
);
```

**示例数据**:
```
ts_hour: 1760943600000 (2025-10-22 17:00:00 UTC)
symbol: BTCUSDT
avg_vol_5m_5h: 1234567.89
```

### 3. 数据读取

**文件**: `market_state_calculator.js`  
**函数**: `getAvgVolMapForLatestHourBefore(tsMs)`

```javascript
// 第106-109行：缓存机制（每小时更新一次）
if (!cachedAvg.map || cachedAvg.ts_hour !== hourKey) {
  const { ts_hour, map } = getAvgVolMapForLatestHourBefore(tsMs);
  cachedAvg = { ts_hour: ts_hour || hourKey, map: map || {} };
}

// 第111行：获取均量数据
const avgMap = cachedAvg.map || {};

// 第161-162行：使用均量计算 volume_score
const preAvg = Number(avgMap[sym] || 0);
const avg5m = preAvg > 0 ? preAvg : 0;

// 第165行：计算 volume_score
const vol_score = scoreVolume(vol5, avg5m);
// vol_score = vol5 / avg5m  (当前5分钟成交量 / 平均5分钟成交量)
```

---

## 📈 计算公式详解

### 均量计算
```
avg_vol_5m_5h = (过去5小时总成交量) / 60

其中：
- 过去5小时 = 300分钟
- 60 = 300分钟 / 5分钟 = 60个5分钟周期
```

### Volume Score 计算
```
volume_score = vol5m / avg_vol_5m_5h

其中：
- vol5m = 当前5分钟的实际成交量
- avg_vol_5m_5h = 过去5小时的平均5分钟成交量
```

**含义**:
- `volume_score = 1.0` → 当前成交量等于历史平均
- `volume_score = 2.0` → 当前成交量是历史平均的2倍
- `volume_score = 0.5` → 当前成交量是历史平均的一半

---

## ⏰ 更新频率

### 均量数据更新
- **频率**: 每小时一次
- **时间**: 每小时整点（00:00, 01:00, 02:00, ...）
- **方式**: PM2 cron 定时任务
- **配置**: `ecosystem.config.cjs` 第56行

```javascript
{
  name: 'avgvol-hourly',
  script: 'avg_vol_hourly.js',
  cron_restart: '0 * * * *',  // 每小时整点运行
  autorestart: false
}
```

### 市场状态计算使用
- **频率**: 每分钟一次（或实时）
- **缓存**: 均量数据在内存中缓存1小时
- **更新**: 每小时自动从数据库加载最新均量

---

## 🔍 数据示例

### 假设场景
某币种在过去5小时的成交量分布：

| 时间段 | 成交量 |
|--------|--------|
| 12:00-12:05 | 1000 |
| 12:05-12:10 | 1200 |
| ... | ... |
| 16:55-17:00 | 1500 |

**计算过程**:
```
1. 5小时总成交量 = 1000 + 1200 + ... + 1500 = 72000
2. 5分钟周期数 = 300分钟 / 5分钟 = 60
3. avg_vol_5m_5h = 72000 / 60 = 1200
```

**使用示例**:
```
当前5分钟成交量 = 2400
volume_score = 2400 / 1200 = 2.0
含义：当前成交量是过去5小时平均的2倍
```

---

## 📊 数据查询

### 查看最新均量数据
```bash
sqlite3 data.sqlite "
SELECT ts_hour, symbol, avg_vol_5m_5h 
FROM market_avg_vol_5m_5h_hourly 
WHERE ts_hour = (SELECT MAX(ts_hour) FROM market_avg_vol_5m_5h_hourly)
ORDER BY symbol
LIMIT 10;
"
```

### 查看某个币种的历史均量
```bash
sqlite3 data.sqlite "
SELECT 
  datetime(ts_hour/1000, 'unixepoch') as hour,
  avg_vol_5m_5h 
FROM market_avg_vol_5m_5h_hourly 
WHERE symbol = 'BTCUSDT'
ORDER BY ts_hour DESC
LIMIT 24;
"
```

### 查看均量数据覆盖情况
```bash
sqlite3 data.sqlite "
SELECT 
  ts_hour,
  COUNT(DISTINCT symbol) as symbol_count
FROM market_avg_vol_5m_5h_hourly
GROUP BY ts_hour
ORDER BY ts_hour DESC
LIMIT 10;
"
```

---

## ⚠️ 注意事项

### 1. 冷启动问题
- 系统首次启动时，没有历史均量数据
- 需要等待第一次整点运行 `avg_vol_hourly.js`
- 在此之前，`avgMap[sym]` 为空，`avg5m = 0`，导致 `volume_score = 0`

### 2. 数据缺失处理
```javascript
// market_state_calculator.js 第161-162行
const preAvg = Number(avgMap[sym] || 0);
const avg5m = preAvg > 0 ? preAvg : 0;

// scoreVolume 函数第64行
if (!(avg5m > 0) || !(vol5m >= 0)) return 0;
```

如果均量为0，volume_score 也会是0。

### 3. 缓存机制
- 均量数据在内存中缓存1小时
- 每小时自动刷新（基于 `hourKey`）
- 避免频繁查询数据库

### 4. 币种覆盖
- 只计算监控列表中的币种（ETH/SOL + 排名51-130的80个币种）
- 如果币种不在列表中，不会有均量数据

---

## 🚀 手动触发计算

如果需要立即计算均量（不等待整点）：

```bash
# 方式1：直接运行脚本
node avg_vol_hourly.js

# 方式2：使用 npm script
npm run avgvol:hourly

# 方式3：通过 PM2 触发
pm2 restart avgvol-hourly
```

---

## 📝 相关文件

| 文件 | 作用 |
|------|------|
| `avg_vol_hourly.js` | 计算并保存均量数据 |
| `db.js` | 数据库操作（upsertAvgVolHourly, getAvgVolMapForLatestHourBefore） |
| `market_state_calculator.js` | 使用均量计算 volume_score |
| `ecosystem.config.cjs` | PM2 定时任务配置 |

---

## 总结

### 均量数据链路
```
1. PM2 定时任务（每小时整点）
   ↓
2. avg_vol_hourly.js 执行
   ↓
3. 从 Binance 获取最近320分钟K线
   ↓
4. 计算过去300分钟（5小时）总成交量
   ↓
5. 除以60得到平均5分钟成交量
   ↓
6. 保存到 market_avg_vol_5m_5h_hourly 表
   ↓
7. market_state_calculator.js 读取并缓存
   ↓
8. 用于计算 volume_score = vol5m / avg5m
```

### 关键数值
- **计算周期**: 每小时一次
- **数据窗口**: 过去5小时（300分钟）
- **基准单位**: 5分钟成交量
- **缓存时长**: 1小时

---

**均量数据是 volume_score 计算的基准，代表币种的"正常"成交量水平。**
