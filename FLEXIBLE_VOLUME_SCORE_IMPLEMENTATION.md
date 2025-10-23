# 灵活的 Volume Score 计算方案实现

## 概述

实现了灵活的 Volume Score 计算方案，支持任意 Binance 支持的 K 线周期配置。

## 核心逻辑

### **配置参数**

```json
{
  "volumeScore": {
    "volume1": 5,      // 短期窗口（分钟）
    "volume2": 600,    // 长期窗口（分钟）
    "updateIntervalMs": 60000,
    "distributeMs": 55000
  }
}
```

- **volume1**: 短期窗口，单位为**分钟**，取最近一根完成的 K 线的成交量（总和）
- **volume2**: 长期窗口，单位为**分钟**，取最近 N 根 K 线的平均成交量

### **计算方式**

#### **1. volume1（短期，总和）**

```
配置: volume1 = 5（分钟）

执行:
1. 选择 K 线周期: 5m（5 分钟）
2. 获取 K 线数量: 2 根（用于去掉最新 1 根）
3. 去掉最新 1 根（未完成）
4. 取第 1 根的成交量
5. 结果: 5 分钟的成交量总和
```

#### **2. volume2（长期，平均）**

```
配置: volume2 = 600（分钟 = 10 小时）

执行:
1. 基准周期: volume1 = 5 分钟
2. 需要 K 线数: 600 / 5 = 120 根
3. 获取 121 根 5 分钟 K 线（+1 用于去掉最新）
4. 去掉最新 1 根（未完成）
5. 计算前 120 根的平均成交量
6. 结果: 120 根 5 分钟 K 线的平均成交量
```

#### **3. volume_score**

```
volume_score = volume1 / volume2
```

---

## 支持的 K 线周期

### **Binance 支持的周期**

| 分钟数 | K 线符号 | 说明 |
|--------|---------|------|
| 1 | 1m | 1 分钟 |
| 3 | 3m | 3 分钟 |
| 5 | 5m | 5 分钟 |
| 15 | 15m | 15 分钟 |
| 30 | 30m | 30 分钟 |
| 60 | 1h | 1 小时 |
| 120 | 2h | 2 小时 |
| 240 | 4h | 4 小时 |
| 360 | 6h | 6 小时 |
| 480 | 8h | 8 小时 |
| 720 | 12h | 12 小时 |
| 1440 | 1d | 1 天 |
| 4320 | 3d | 3 天 |
| 10080 | 1w | 1 周 |
| 43200 | 1M | 1 月 |

### **配置限制**

1. **volume1 必须是支持的周期**
   ```
   ✅ 正确: volume1 = 5 (5m)
   ✅ 正确: volume1 = 15 (15m)
   ✅ 正确: volume1 = 60 (1h)
   ❌ 错误: volume1 = 10 (不支持)
   ❌ 错误: volume1 = 20 (不支持)
   ```

2. **volume2 必须能被 volume1 整除**
   ```
   ✅ 正确: volume1 = 5, volume2 = 600 (600 / 5 = 120)
   ✅ 正确: volume1 = 15, volume2 = 900 (900 / 15 = 60)
   ✅ 正确: volume1 = 30, volume2 = 600 (600 / 30 = 20)
   ❌ 错误: volume1 = 5, volume2 = 601 (不能整除)
   ❌ 错误: volume1 = 15, volume2 = 500 (不能整除)
   ```

---

## 配置示例

### **示例 1：默认配置（5分钟 vs 10小时）**

```json
{
  "volumeScore": {
    "volume1": 5,      // 5 分钟
    "volume2": 600     // 10 小时（600 分钟）
  }
}
```

**执行**:
- K 线周期: 5m
- volume1: 最近 1 根 5 分钟 K 线的成交量
- volume2: 最近 120 根 5 分钟 K 线的平均成交量
- API 请求: `interval=5m&limit=121`

### **示例 2：15分钟 vs 15小时**

```json
{
  "volumeScore": {
    "volume1": 15,     // 15 分钟
    "volume2": 900     // 15 小时（900 分钟）
  }
}
```

**执行**:
- K 线周期: 15m
- volume1: 最近 1 根 15 分钟 K 线的成交量
- volume2: 最近 60 根 15 分钟 K 线的平均成交量
- API 请求: `interval=15m&limit=61`

### **示例 3：30分钟 vs 10小时**

```json
{
  "volumeScore": {
    "volume1": 30,     // 30 分钟
    "volume2": 600     // 10 小时（600 分钟）
  }
}
```

**执行**:
- K 线周期: 30m
- volume1: 最近 1 根 30 分钟 K 线的成交量
- volume2: 最近 20 根 30 分钟 K 线的平均成交量
- API 请求: `interval=30m&limit=21`

### **示例 4：1小时 vs 24小时**

```json
{
  "volumeScore": {
    "volume1": 60,     // 1 小时
    "volume2": 1440    // 24 小时（1440 分钟）
  }
}
```

**执行**:
- K 线周期: 1h
- volume1: 最近 1 根 1 小时 K 线的成交量
- volume2: 最近 24 根 1 小时 K 线的平均成交量
- API 请求: `interval=1h&limit=25`

### **示例 5：1天 vs 30天**

```json
{
  "volumeScore": {
    "volume1": 1440,   // 1 天
    "volume2": 43200   // 30 天（43200 分钟）
  }
}
```

**执行**:
- K 线周期: 1d
- volume1: 最近 1 根 1 天 K 线的成交量
- volume2: 最近 30 根 1 天 K 线的平均成交量
- API 请求: `interval=1d&limit=31`

---

## 代码实现

### **1. 支持的周期定义**

```javascript
const SUPPORTED_INTERVALS = [
  { minutes: 1, symbol: '1m' },
  { minutes: 3, symbol: '3m' },
  { minutes: 5, symbol: '5m' },
  { minutes: 15, symbol: '15m' },
  { minutes: 30, symbol: '30m' },
  { minutes: 60, symbol: '1h' },
  { minutes: 120, symbol: '2h' },
  { minutes: 240, symbol: '4h' },
  { minutes: 360, symbol: '6h' },
  { minutes: 480, symbol: '8h' },
  { minutes: 720, symbol: '12h' },
  { minutes: 1440, symbol: '1d' },
  { minutes: 4320, symbol: '3d' },
  { minutes: 10080, symbol: '1w' },
  { minutes: 43200, symbol: '1M' },
];
```

### **2. 配置验证**

```javascript
function validateMinutes(minutes, paramName) {
  const supported = SUPPORTED_INTERVALS.find(i => i.minutes === minutes);
  if (!supported) {
    const supportedList = SUPPORTED_INTERVALS.map(i => i.minutes).join(', ');
    throw new Error(`${paramName}=${minutes} 不被支持。支持的值: ${supportedList}`);
  }
  return supported.symbol;
}
```

### **3. K 线获取**

```javascript
async function fetchKlines(symbol, interval, limit) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const resp = await fetch(url);
  const data = await resp.json();
  return data;
}
```

### **4. 计算逻辑**

```javascript
async function calculateSymbolVolumeScore(symbol, tsMinute, config) {
  const volumeCfg = config.volumeScore || {};
  const volume1Minutes = volumeCfg.volume1 || 5;
  const volume2Minutes = volumeCfg.volume2 || 600;

  // 验证配置
  const interval = validateMinutes(volume1Minutes, 'volume1');
  
  // 检查 volume2 是否能被 volume1 整除
  if (volume2Minutes % volume1Minutes !== 0) {
    throw new Error('volume2 必须能被 volume1 整除');
  }
  
  // 计算需要的 K 线数量
  const volume2Count = volume2Minutes / volume1Minutes;
  const limit = volume2Count + 1;  // +1 用于去掉最新未完成的
  
  // 获取 K 线
  const klines = await fetchKlines(symbol, interval, limit);
  
  // 去掉最新一根
  const completedKlines = klines.slice(0, -1);
  
  // volume1: 取第一根的成交量
  const volumeMa1 = parseFloat(completedKlines[0][7]);
  
  // volume2: 计算平均
  let sum = 0;
  for (let i = 0; i < volume2Count; i++) {
    sum += parseFloat(completedKlines[i][7]);
  }
  const volumeMa2 = sum / volume2Count;
  
  // 计算得分
  const volumeScore = volumeMa2 > 0 ? volumeMa1 / volumeMa2 : 0;
  
  return { volumeMa1, volumeMa2, volumeScore };
}
```

---

## 数据流程

### **完整流程图**

```
1. 加载配置
   ↓
   volume1 = 5 分钟
   volume2 = 600 分钟

2. 验证配置
   ↓
   ✓ volume1 = 5 在支持列表中
   ✓ volume2 % volume1 = 0

3. 选择 K 线周期
   ↓
   interval = 5m

4. 计算需要的数量
   ↓
   volume2Count = 600 / 5 = 120
   limit = 120 + 1 = 121

5. 获取 K 线
   ↓
   GET /fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=121

6. 去掉最新一根
   ↓
   completedKlines = klines.slice(0, -1)
   剩余 120 根完整 K 线

7. 计算 volume1
   ↓
   volumeMa1 = completedKlines[0][7]
   结果: 最近 5 分钟的成交量

8. 计算 volume2
   ↓
   sum = completedKlines[0..119] 的成交量总和
   volumeMa2 = sum / 120
   结果: 120 根 5 分钟 K 线的平均成交量

9. 计算得分
   ↓
   volumeScore = volumeMa1 / volumeMa2

10. 保存到数据库
    ↓
    upsertSymbolVolumeScore(...)
```

---

## 性能分析

### **不同配置的性能对比**

| 配置 | K线周期 | 请求数量 | 数据量 | 处理时间 |
|------|---------|---------|--------|---------|
| volume1=5, volume2=600 | 5m | 121 | 中 | ~50ms |
| volume1=15, volume2=900 | 15m | 61 | 小 | ~40ms |
| volume1=30, volume2=600 | 30m | 21 | 很小 | ~30ms |
| volume1=60, volume2=1440 | 1h | 25 | 很小 | ~30ms |

### **500 个币种的总耗时**

| 配置 | 单币种耗时 | 总耗时（串行） | 是否可行 |
|------|-----------|---------------|---------|
| 5m, 600min | ~50ms | ~25秒 | ✅ 可行 |
| 15m, 900min | ~40ms | ~20秒 | ✅ 可行 |
| 30m, 600min | ~30ms | ~15秒 | ✅ 可行 |
| 1h, 1440min | ~30ms | ~15秒 | ✅ 可行 |

**结论**: 所有配置都能在 55 秒内完成，满足 60 秒更新周期的要求。

---

## 错误处理

### **配置错误**

#### **1. volume1 不被支持**

```
错误配置:
{
  "volume1": 10,  // 10 分钟不被 Binance 支持
  "volume2": 600
}

错误信息:
volume1=10 不被支持。支持的值: 1, 3, 5, 15, 30, 60, 120, 240, 360, 480, 720, 1440, 4320, 10080, 43200

解决方案:
改为支持的值，如 5, 15, 30 等
```

#### **2. volume2 不能被 volume1 整除**

```
错误配置:
{
  "volume1": 5,
  "volume2": 601  // 601 / 5 = 120.2（不能整除）
}

错误信息:
volume2 必须能被 volume1 整除

解决方案:
改为 600（600 / 5 = 120）
```

### **运行时错误**

#### **1. K 线数据不足**

```
场景: 新上线的币种，历史数据不足

日志:
[DEBUG] K线数据不足，跳过计算
        { symbol: 'NEWCOIN', interval: '5m', required: 121, actual: 50 }

处理: 自动跳过，等待数据积累
```

#### **2. API 请求失败**

```
场景: 网络问题或 API 限流

日志:
[WARN] 获取K线失败
       { symbol: 'BTCUSDT', interval: '5m', status: 429 }

处理: 自动跳过，下一轮重试
```

---

## 日志示例

### **正常运行**

```
[INFO] 启动单币种 volume score 计算循环（均匀分布模式）
       { updateIntervalMs: 60000, distributeMs: 55000 }

[INFO] 开始计算单币种 volume score
       { tsMinute: '2025-10-23T08:00:00.000Z' }

[INFO] 开始均匀分布处理
       { totalSymbols: 523, distributeMs: 55000, intervalMs: '105.17' }

[DEBUG] 单币种 volume score 计算完成
        { 
          symbol: 'BTCUSDT', 
          interval: '5m',
          volume1Minutes: 5,
          volume2Minutes: 600,
          volume2Count: 120,
          volumeMa1: '12345678.90', 
          volumeMa2: '10234567.89', 
          volumeScore: '1.2063' 
        }

[DEBUG] 处理进度
        { processed: 50, total: 523, progress: '9.6%' }

[INFO] 均匀分布处理完成
       { totalSymbols: 523 }

[INFO] 单币种 volume score 计算完成
       { count: 523 }
```

### **配置错误**

```
[ERROR] 单币种 volume score 计算失败
        { 
          symbol: 'BTCUSDT', 
          err: 'volume1=10 不被支持。支持的值: 1, 3, 5, 15, 30, 60, 120, 240, 360, 480, 720, 1440, 4320, 10080, 43200' 
        }
```

### **数据不足**

```
[DEBUG] K线数据不足，跳过计算
        { symbol: 'NEWCOIN', interval: '5m', required: 121, actual: 50 }
```

---

## 迁移指南

### **从旧版本迁移**

#### **旧版本配置**

```json
{
  "volumeScore": {
    "volume1": 5,      // 5 根 5 分钟 K 线
    "volume2": 120     // 120 根 5 分钟 K 线
  }
}
```

#### **新版本配置**

```json
{
  "volumeScore": {
    "volume1": 5,      // 5 分钟（1 根 5 分钟 K 线）
    "volume2": 600     // 600 分钟（120 根 5 分钟 K 线）
  }
}
```

#### **对应关系**

| 旧配置 | 新配置 | 说明 |
|--------|--------|------|
| volume1=5 (根) | volume1=5 (分钟) | 5 根 5 分钟 → 1 根 5 分钟 |
| volume2=120 (根) | volume2=600 (分钟) | 120 根 5 分钟 → 600 分钟 |

**注意**: 
- 旧版本的 volume1 是"根数"，新版本是"分钟数"
- 旧版本的 volume2 是"根数"，新版本是"分钟数"
- 需要根据实际需求调整配置值

---

## 最佳实践

### **1. 选择合适的周期**

```
短期监控（分钟级）:
- volume1 = 5 或 15 分钟
- volume2 = 300 - 900 分钟（5-15 小时）

中期监控（小时级）:
- volume1 = 30 或 60 分钟
- volume2 = 1440 - 4320 分钟（1-3 天）

长期监控（天级）:
- volume1 = 1440 分钟（1 天）
- volume2 = 43200 分钟（30 天）
```

### **2. 确保整除关系**

```javascript
// 检查配置是否合理
function checkConfig(volume1, volume2) {
  if (volume2 % volume1 !== 0) {
    console.error(`volume2 (${volume2}) 必须能被 volume1 (${volume1}) 整除`);
    return false;
  }
  const count = volume2 / volume1;
  console.log(`需要 ${count} 根 K 线`);
  return true;
}

checkConfig(5, 600);   // ✅ 需要 120 根 K 线
checkConfig(15, 900);  // ✅ 需要 60 根 K 线
checkConfig(5, 601);   // ❌ 不能整除
```

### **3. 监控性能**

```javascript
// 监控单币种处理时间
const start = Date.now();
await calculateSymbolVolumeScore(symbol, tsMinute, config);
const duration = Date.now() - start;

if (duration > 100) {
  logger.warn({ symbol, duration }, '处理时间过长');
}
```

---

## 常见问题

### **Q1: 为什么要限制配置值？**

**A**: Binance API 只支持特定的 K 线周期。使用不支持的周期会导致 API 请求失败。

### **Q2: 可以使用 10 分钟周期吗？**

**A**: 不可以。Binance 不支持 10 分钟 K 线。最接近的是 5 分钟或 15 分钟。

### **Q3: volume2 必须能被 volume1 整除吗？**

**A**: 是的。因为 volume2 是基于 volume1 周期的 K 线计算的。例如：
- volume1 = 5, volume2 = 600 → 需要 120 根 5 分钟 K 线
- volume1 = 5, volume2 = 601 → 需要 120.2 根（不可能）

### **Q4: 如何选择合适的配置？**

**A**: 根据监控目标：
- 捕捉短期波动：使用较小的 volume1（如 5, 15 分钟）
- 平滑长期趋势：使用较大的 volume2（如 1440, 4320 分钟）
- 平衡实时性和稳定性：推荐 volume1=5, volume2=600

### **Q5: 修改配置后需要重启吗？**

**A**: 是的。配置在启动时加载，修改后需要重启进程：
```bash
pm2 restart volume-score-calc
```

---

## 修改日期

2025-10-23

## 相关文档

- `KLINE_INCOMPLETE_FIX.md` - K 线数据完整性修复
- `VOLUME_SCORE_DISTRIBUTION_STRATEGY.md` - 均匀分布更新策略
- `KLINE_INTERVAL_COMPARISON.md` - K 线时间周期对比分析
