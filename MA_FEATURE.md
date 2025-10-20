# ✅ 均线功能已完成

## 功能说明

现在图表页面支持显示**可定制的移动平均线（MA）**，与 `rule3_default.js` 中使用的逻辑一致：
- 计算指定时间窗口内的 `price_score` 和 `volume_score` 平均值
- 支持同时显示 2 条均线
- 可以自由选择窗口大小：5分钟、10分钟、15分钟、30分钟、60分钟

## 实现细节

### 1. 数据库层 (`db.js`)
新增函数：
```javascript
calculateMovingAverage(windowMinutes, from, to)
```
- 计算滑动窗口平均值
- 对每个时间点，向前取 `windowMinutes` 分钟的数据计算均值
- 返回包含 `ts_minute`, `price_score`, `volume_score`, `sample_count` 的数组

### 2. API 层 (`server.js`)
新增接口：
```
GET /market/state/ma?window=5&from=1729000000000&to=1729100000000
```

**参数**：
- `window`: 窗口大小（分钟），默认 5
- `from`: 开始时间（毫秒）
- `to`: 结束时间（毫秒）

**返回**：
```json
{
  "data": [
    {
      "ts_minute": 1729000000000,
      "price_score": -12.34,
      "volume_score": 45.67,
      "sample_count": 5
    }
  ],
  "window": 5
}
```

### 3. 前端层 (`chart_tradingview.html`)

**UI 控件**：
- 两个均线选择器（ma1, ma2）
- 可选值：不显示、MA5、MA10、MA15、MA30、MA60
- 默认：MA5 + MA60（与 rule3_default.js 一致）

**图表显示**：
- MA1: 红色线 (#FF6B6B)
- MA2: 青色线 (#4ECDC4)
- 同时在 Price 和 Volume 图表上显示

**动态更新**：
- 切换均线选择器时自动重新加载数据
- 支持选择相同窗口（会复用数据）
- 支持不显示某条均线

## 使用方法

### 1. 重启服务器
```bash
node server.js
```

### 2. 访问图表页面
```bash
open http://localhost:8080
```

### 3. 选择均线
- **均线 1**: 选择 MA5（5分钟均值）
- **均线 2**: 选择 MA60（1小时均值）
- 点击"刷新数据"或等待自动刷新

### 4. 自定义均线
例如显示 10分钟 + 30分钟：
- **均线 1**: 选择 MA10
- **均线 2**: 选择 MA30
- 图表会自动更新

## 与 rule3_default.js 的对应关系

`rule3_default.js` 中的逻辑：
```javascript
const avgState = getMarketStateMinuteLast5Min();     // 5分钟均值
const avgState1h = getMarketStateMinuteLast1Hour();  // 1小时均值
```

图表中的对应：
- **MA5** = `getMarketStateMinuteLast5Min()` 的可视化
- **MA60** = `getMarketStateMinuteLast1Hour()` 的可视化

## 计算逻辑

对于每个时间点 `t`，MA(n) 的计算方式：
```
MA(n) = AVG(score[t-n+1], score[t-n+2], ..., score[t])
```

例如 MA5 在 10:05 的值：
```
MA5(10:05) = AVG(score[10:01], score[10:02], score[10:03], score[10:04], score[10:05])
```

这与 `rule3_default.js` 中的计算逻辑完全一致。

## 示例场景

### 场景 1: 查看短期和长期趋势
- MA5: 捕捉短期波动
- MA60: 反映长期趋势
- 当 MA5 上穿 MA60 → 可能的上涨信号
- 当 MA5 下穿 MA60 → 可能的下跌信号

### 场景 2: 自定义分析周期
- MA10 + MA30: 中期分析
- MA15 + MA60: 混合周期分析

### 场景 3: 单均线分析
- 只显示 MA5: 专注短期
- 只显示 MA60: 专注长期

## 技术特点

1. **高性能**: 均线在数据库层计算，避免前端重复计算
2. **实时更新**: 支持自动刷新（每分钟）
3. **灵活配置**: 可以任意组合不同周期的均线
4. **视觉清晰**: 使用不同颜色区分不同均线
5. **数据一致性**: 与策略代码使用相同的计算逻辑

## 注意事项

1. **数据要求**: 需要足够的历史数据才能计算均线
   - MA5 需要至少 5 分钟的数据
   - MA60 需要至少 60 分钟的数据

2. **边界处理**: 数据不足时，均线会从有足够样本的时间点开始显示

3. **性能考虑**: 长时间范围 + 大窗口可能需要较多计算
   - 建议：24小时内使用 MA60 以下
   - 7天范围可以使用任意窗口

4. **颜色说明**:
   - 主数据线: 蓝色（Price）/ 绿色（Volume）
   - MA1: 红色
   - MA2: 青色
