# K 线时间周期对比分析

## 问题

当前使用 5 分钟 K 线，最大延迟 5 分钟。是否改用 1 分钟 K 线更优？

## 详细对比

### 方案 1：5 分钟 K 线（当前方案）

#### 配置
```json
{
  "volumeScore": {
    "volume1": 5,    // MA5 = 5根 × 5分钟 = 25分钟
    "volume2": 120   // MA120 = 120根 × 5分钟 = 10小时
  }
}
```

#### API 请求
```javascript
// 单个币种
GET /fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=130

// 500 个币种
总数据点: 500 × 130 = 65,000
在 55 秒内分布: 65,000 / 55 ≈ 1,182 数据点/秒
```

#### 优点
- ✅ **API 效率高**: 数据量小，请求快
- ✅ **计算速度快**: 处理 130 根 vs 610 根
- ✅ **稳定性好**: 5 分钟 K 线更平滑，噪音少
- ✅ **限流风险低**: 请求量小，不易触发 Binance 限流
- ✅ **带宽占用小**: 网络传输量小

#### 缺点
- ❌ **延迟较大**: 最大延迟 5 分钟
- ❌ **粒度较粗**: 无法捕捉 1-5 分钟内的快速变化

#### 性能指标
| 指标 | 值 |
|------|-----|
| 单币种数据点 | 130 |
| 总数据点（500币种） | 65,000 |
| API 请求 Weight | 低 |
| 计算耗时（估算） | ~50ms/币种 |
| 总耗时（500币种） | ~25秒 |
| 最大延迟 | 5 分钟 |

---

### 方案 2：1 分钟 K 线

#### 配置
```json
{
  "volumeScore": {
    "volume1": 25,   // MA25 = 25根 × 1分钟 = 25分钟（保持相同）
    "volume2": 600   // MA600 = 600根 × 1分钟 = 10小时（保持相同）
  }
}
```

#### API 请求
```javascript
// 单个币种
GET /fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=610

// 500 个币种
总数据点: 500 × 610 = 305,000
在 55 秒内分布: 305,000 / 55 ≈ 5,545 数据点/秒
```

#### 优点
- ✅ **延迟小**: 最大延迟仅 1 分钟
- ✅ **粒度细**: 可以捕捉更细微的变化
- ✅ **实时性强**: 对市场变化反应更快

#### 缺点
- ❌ **API 压力大**: 数据量是 5 分钟的 4.7 倍
- ❌ **计算量大**: 处理 610 根 K 线，耗时增加
- ❌ **限流风险高**: 更容易触发 Binance API 限流
- ❌ **带宽占用大**: 网络传输量大
- ❌ **噪音多**: 1 分钟 K 线波动更大，可能产生误判

#### 性能指标
| 指标 | 值 |
|------|-----|
| 单币种数据点 | 610 |
| 总数据点（500币种） | 305,000 |
| API 请求 Weight | 高 |
| 计算耗时（估算） | ~200ms/币种 |
| 总耗时（500币种） | ~100秒 ⚠️ |
| 最大延迟 | 1 分钟 |

---

### 方案 3：混合方案（不推荐）

短期用 1 分钟，长期用 5 分钟：

```json
{
  "volumeScore": {
    "volume1": 25,     // MA25 (1分钟)
    "volume1Interval": "1m",
    "volume2": 120,    // MA120 (5分钟)
    "volume2Interval": "5m"
  }
}
```

#### 优点
- ✅ 短期指标更实时
- ✅ 长期指标保持稳定

#### 缺点
- ❌ **两次 API 请求**: 效率降低一半
- ❌ **逻辑复杂**: 需要维护两套 K 线数据
- ❌ **不一致性**: 两个 MA 基于不同时间粒度，可比性差

---

### 方案 4：1 分钟 K 线 + 缩短长期窗口

```json
{
  "volumeScore": {
    "volume1": 25,   // MA25 = 25根 × 1分钟 = 25分钟
    "volume2": 300   // MA300 = 300根 × 1分钟 = 5小时（从 10 小时缩短）
  }
}
```

#### API 请求
```javascript
GET /fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=310

// 500 个币种
总数据点: 500 × 310 = 155,000
在 55 秒内分布: 155,000 / 55 ≈ 2,818 数据点/秒
```

#### 优点
- ✅ 延迟降低到 1 分钟
- ✅ 数据量减半（相比方案 2）
- ✅ 计算量可控

#### 缺点
- ❌ 长期趋势判断能力下降（5小时 vs 10小时）
- ❌ 仍然比 5 分钟方案慢 2 倍

---

## 实际影响分析

### 延迟对指标的影响

#### MA25 (25 分钟)
- 5 分钟延迟 = 25 分钟的 20%
- **影响**: 中等

#### MA120 (10 小时)
- 5 分钟延迟 = 10 小时的 0.83%
- **影响**: 几乎可以忽略

### 结论
对于 10 小时这样的长周期指标，5 分钟的延迟**完全可以接受**。

---

## Binance API 限流

### 限流规则
- **Weight 限制**: 每分钟 2400
- **订单限制**: 每 10 秒 300 个订单
- **IP 限制**: 每分钟 1200 请求

### K 线请求 Weight
| 请求 | Weight |
|------|--------|
| limit ≤ 100 | 1 |
| 100 < limit ≤ 500 | 2 |
| 500 < limit ≤ 1000 | 5 |
| limit > 1000 | 10 |

### 对比
| 方案 | Limit | Weight | 500币种总Weight |
|------|-------|--------|----------------|
| 5分钟 K 线 | 130 | 2 | 1000 |
| 1分钟 K 线 | 610 | 5 | 2500 ⚠️ |

**结论**: 1 分钟 K 线方案会超过每分钟 2400 的 Weight 限制！

---

## 性能测试（估算）

### 5 分钟 K 线方案

```
单币种处理时间: ~50ms
- API 请求: ~30ms
- 数据处理: ~10ms
- 数据库写入: ~10ms

500 个币种（串行，均匀分布）:
- 总时间: 55 秒
- 平均间隔: 110ms
- CPU 占用: 低
- 内存占用: ~50MB
```

### 1 分钟 K 线方案

```
单币种处理时间: ~200ms
- API 请求: ~120ms
- 数据处理: ~50ms
- 数据库写入: ~30ms

500 个币种（串行，均匀分布）:
- 总时间: 100 秒 ⚠️ 超过 1 分钟周期！
- 平均间隔: 200ms
- CPU 占用: 中等
- 内存占用: ~200MB
```

**问题**: 1 分钟 K 线方案需要 100 秒才能完成一轮，但更新周期是 60 秒，会导致**积压**！

---

## 推荐方案

### 🏆 推荐：保持 5 分钟 K 线（方案 1）

**理由**:

1. **性能可控**: 55 秒内完成，有 5 秒缓冲
2. **API 友好**: 不会触发限流
3. **延迟可接受**: 对 10 小时指标影响 < 1%
4. **稳定性好**: 5 分钟 K 线噪音少，更可靠
5. **资源占用低**: CPU、内存、带宽都很低

### 如果确实需要更实时

可以考虑**方案 4**（1 分钟 + 缩短长期窗口），但需要：

1. **增加服务器资源**
2. **优化均匀分布时间**: `distributeMs` 改为 58000（58秒）
3. **监控 API 限流**: 添加重试和退避机制
4. **接受长期指标缩短**: 从 10 小时改为 5 小时

---

## 实现方案 4 的代码修改

如果你决定使用方案 4，需要修改以下内容：

### 1. 修改 K 线获取函数

```javascript
// volume_score_calculator.js

// 重命名函数
async function fetch1mKlines(symbol, limit) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn({ symbol, status: resp.status }, '获取K线失败');
      return null;
    }
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn({ symbol, len: data?.length }, 'K线数据为空');
      return null;
    }
    return data;
  } catch (e) {
    logger.error({ symbol, err: e.message }, '获取K线异常');
    return null;
  }
}
```

### 2. 修改配置

```json
// config.json
{
  "volumeScore": {
    "volume1": 25,              // MA25 (1分钟 × 25 = 25分钟)
    "volume2": 300,             // MA300 (1分钟 × 300 = 5小时)
    "updateIntervalMs": 60000,
    "distributeMs": 58000       // 增加到 58 秒
  }
}
```

### 3. 修改计算函数

```javascript
// volume_score_calculator.js

async function calculateSymbolVolumeScore(symbol, tsMinute, config) {
  const volumeCfg = config.volumeScore || {};
  const ma1Window = (typeof volumeCfg.volume1 === 'number' && volumeCfg.volume1 > 0) ? volumeCfg.volume1 : 25;  // 改为 25
  const ma2Window = (typeof volumeCfg.volume2 === 'number' && volumeCfg.volume2 > 0) ? volumeCfg.volume2 : 300; // 改为 300
  const klineLimit = Math.max(ma1Window, ma2Window) + 10;

  const klines = await fetch1mKlines(symbol, klineLimit); // 改为 1 分钟
  if (!klines) return;

  // 去掉最新的一根K线（未完成的K线）
  const completedKlines = klines.slice(0, -1);
  if (completedKlines.length < Math.max(ma1Window, ma2Window)) {
    logger.debug({ symbol, availableKlines: completedKlines.length, required: Math.max(ma1Window, ma2Window) }, 'K线数据不足，跳过计算');
    return;
  }

  const volumeMa1 = calculateMA(completedKlines, ma1Window);
  const volumeMa2 = calculateMA(completedKlines, ma2Window);
  const volumeScore = volumeMa2 > 0 ? volumeMa1 / volumeMa2 : 0;

  upsertSymbolVolumeScore({
    ts_minute: tsMinute,
    symbol,
    volume_ma1: volumeMa1,
    volume_ma2: volumeMa2,
    volume_score: volumeScore,
  });

  logger.debug({ symbol, volumeMa1: volumeMa1.toFixed(2), volumeMa2: volumeMa2.toFixed(2), volumeScore: volumeScore.toFixed(4) }, '单币种 volume score 计算完成');
}
```

### 4. 更新文档

```javascript
// 注释说明
// MA1: 最近 25 根 1 分钟 K 线的平均成交量（25 分钟）
// MA2: 最近 300 根 1 分钟 K 线的平均成交量（5 小时）
```

---

## 监控建议

如果改用 1 分钟 K 线，需要监控：

1. **API 限流**: 监控 429 错误
2. **处理时间**: 确保在 60 秒内完成
3. **数据积压**: 检查是否有币种被跳过
4. **内存占用**: 1 分钟 K 线数据量大

---

## 最终建议

### 保持 5 分钟 K 线 ✅

除非你有以下明确需求：
- 需要捕捉 1-5 分钟内的快速变化
- 有足够的服务器资源
- 可以接受长期指标从 10 小时缩短到 5 小时

否则，**5 分钟 K 线是最优选择**。

---

## 修改日期

2025-10-23
