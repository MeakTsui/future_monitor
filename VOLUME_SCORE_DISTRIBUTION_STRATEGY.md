# Volume Score 均匀分布更新策略

## 问题背景

原实现中，500+ 个币种的 volume score 计算采用批量并发处理：
- 每分钟开始时一次性发起大量并发请求
- 瞬时请求压力大，可能触发 API 限流
- 资源使用不均匀，有明显的峰谷

## 优化方案：均匀分布更新

将 500+ 个币种的更新请求在 1 分钟内均匀分布，平滑请求压力。

### 核心思路

```
时间轴（60秒）:
0s -------- 10s -------- 20s -------- 30s -------- 40s -------- 50s -------- 60s
|           |            |            |            |            |            |
币1         币100        币200        币300        币400        币500        下一轮
|           |            |            |            |            |            |
每个币种在固定的时间点更新，间隔 = 55秒 / 500 ≈ 110ms
```

### 实现细节

#### 1. 均匀分布函数

```javascript
async function processDistributed(symbols, tsMinute, config, distributeMs = 60000) {
  // 计算每个币种之间的时间间隔
  const intervalMs = distributeMs / symbols.length;
  
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const startTime = Date.now();
    
    // 计算并保存
    await calculateSymbolVolumeScore(symbol, tsMinute, config);
    
    // 计算下一个币种应该在什么时候开始
    const nextScheduledTime = startTime + intervalMs;
    const now = Date.now();
    const waitMs = Math.max(0, nextScheduledTime - now);
    
    // 等待到预定时间
    if (i < symbols.length - 1 && waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}
```

#### 2. 时间参数

- **updateIntervalMs**: 更新周期（默认 60000ms = 1分钟）
- **distributeMs**: 分布时间窗口（默认 55000ms = 55秒）
  - 留 5 秒缓冲时间，避免跨分钟边界

#### 3. 计算示例

假设有 500 个币种，distributeMs = 55000ms：

```
间隔时间 = 55000 / 500 = 110ms

币种1:  0ms 开始
币种2:  110ms 开始
币种3:  220ms 开始
...
币种500: 54890ms 开始

总耗时: 约 55 秒
缓冲时间: 5 秒（用于处理延迟和准备下一轮）
```

## 配置参数

在 `config.json` 中配置：

```json
{
  "volumeScore": {
    "volume1": 5,
    "volume2": 120,
    "updateIntervalMs": 60000,    // 更新周期：1分钟
    "distributeMs": 55000,        // 分布窗口：55秒
    "marketCalcIntervalMs": 5000,
    "marketCapThreshold": 500000000
  }
}
```

### 参数说明

| 参数 | 说明 | 默认值 | 推荐值 |
|------|------|--------|--------|
| `updateIntervalMs` | 更新周期（毫秒） | 60000 | 60000 (1分钟) |
| `distributeMs` | 分布时间窗口（毫秒） | 55000 | 50000-58000 |
| `marketCalcIntervalMs` | 市场整体计算间隔 | 5000 | 5000-10000 |
| `marketCapThreshold` | 市值阈值（美元） | 500000000 | 500000000 (5亿) |

### 调优建议

1. **distributeMs 设置**
   - 太小：处理不完，会延迟到下一分钟
   - 太大：缓冲时间不足，可能跨分钟边界
   - 推荐：`updateIntervalMs * 0.9` 到 `updateIntervalMs * 0.95`

2. **币种数量变化**
   - 500 个币种，55 秒分布：每个间隔 110ms
   - 600 个币种，55 秒分布：每个间隔 92ms
   - 自动适应，无需手动调整

## 优势对比

### 修改前（批量并发）

```
请求分布:
0-5s:   ████████████████████ (500个请求)
5-60s:  ░░░░░░░░░░░░░░░░░░░░ (空闲)

问题:
- 瞬时压力大
- 容易触发限流
- 资源利用不均
```

### 修改后（均匀分布）

```
请求分布:
0-55s:  ████████████████████ (每110ms一个请求)
55-60s: ░░░░░ (缓冲)

优势:
- 请求平滑
- 避免限流
- 资源利用均衡
```

## 性能指标

### 理论值（500个币种，55秒分布）

- **平均 QPS**: 500 / 55 ≈ 9.1 请求/秒
- **峰值 QPS**: 约 10 请求/秒（考虑处理时间）
- **间隔时间**: 110ms
- **总耗时**: 55 秒 + 处理时间

### 实际监控

可通过日志观察：

```javascript
logger.debug({ 
  processed: 250, 
  total: 500, 
  progress: '50.0%'
}, '处理进度');
```

每处理 50 个币种输出一次进度。

## 容错机制

### 1. 处理时间超时

如果单个币种处理时间过长：

```javascript
const waitMs = Math.max(0, nextScheduledTime - now);
```

- 如果已经超时（waitMs < 0），立即处理下一个
- 自动跳过等待，追赶进度

### 2. 跨分钟边界

通过 5 秒缓冲时间避免：

```
分钟 N:   0s ----------- 55s | 缓冲 5s |
分钟 N+1:                      | 0s ----------- 55s
```

### 3. API 失败

单个币种失败不影响其他币种：

```javascript
await calculateSymbolVolumeScore(symbol, tsMinute, config);
// 内部有 try-catch，失败只记录日志
```

## 监控建议

### 关键指标

1. **处理进度**: 每 50 个币种输出一次
2. **总耗时**: 每轮结束时记录
3. **失败数量**: 统计 API 失败的币种数
4. **时间偏移**: 检查是否有跨分钟情况

### 日志示例

```
[INFO] 启动单币种 volume score 计算循环（均匀分布模式）
       { updateIntervalMs: 60000, distributeMs: 55000 }

[INFO] 开始计算单币种 volume score
       { tsMinute: '2025-10-23T14:00:00.000Z' }

[INFO] 开始均匀分布处理
       { totalSymbols: 523, distributeMs: 55000, intervalMs: '105.17' }

[DEBUG] 处理进度
        { processed: 50, total: 523, progress: '9.6%' }

[DEBUG] 处理进度
        { processed: 100, total: 523, progress: '19.1%' }

...

[INFO] 均匀分布处理完成
       { totalSymbols: 523 }

[INFO] 单币种 volume score 计算完成
       { count: 523 }
```

## 注意事项

1. **首次启动**: 立即执行一次，可能在非整分钟开始
2. **时间同步**: 使用 `Math.floor(Date.now() / 60000) * 60000` 对齐分钟
3. **数据一致性**: 所有币种使用同一个 `ts_minute`
4. **资源占用**: 串行处理，CPU 和内存占用平稳

## 未来优化方向

1. **动态调整**: 根据实际处理时间动态调整 distributeMs
2. **优先级队列**: 重要币种优先更新
3. **失败重试**: 对失败的币种在下一轮优先处理
4. **并发控制**: 在均匀分布基础上，允许少量并发（如 2-3 个）

## 修改日期

2025-10-23
