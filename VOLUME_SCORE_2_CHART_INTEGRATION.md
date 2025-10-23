# Volume Score 2 图表集成说明

## 概述

已成功将 `market_volume_score_minute` 表的数据集成到 TradingView 图表页面中，用户可以实时查看市场整体的 Volume Score 2 指标。

## 实现内容

### 1. 后端 API 接口 (server.js)

新增两个 API 接口：

#### `/market/volume_score/latest`
获取最新的 market volume score 记录

**请求示例:**
```
GET /market/volume_score/latest
```

**响应示例:**
```json
{
  "data": {
    "ts_minute": 1729670400000,
    "total_volume_ma1": 12345678.90,
    "total_volume_ma2": 10234567.89,
    "market_volume_score_2": 1.2063,
    "symbols_count": 523,
    "created_at": "2025-10-23T14:00:00.000Z"
  }
}
```

#### `/market/volume_score/history`
获取历史 market volume score 数据

**请求参数:**
- `from`: 起始时间戳（毫秒）
- `to`: 结束时间戳（毫秒）
- `limit`: 最大返回数量（默认 1000）

**请求示例:**
```
GET /market/volume_score/history?from=1729584000000&to=1729670400000&limit=1000
```

**响应示例:**
```json
{
  "data": [
    {
      "ts_minute": 1729584060000,
      "total_volume_ma1": 12345678.90,
      "total_volume_ma2": 10234567.89,
      "market_volume_score_2": 1.2063,
      "symbols_count": 523,
      "created_at": "2025-10-23T00:01:00.000Z"
    },
    ...
  ]
}
```

### 2. 前端图表集成 (chart_tradingview.html)

#### 新增统计卡片

在页面顶部的统计区域新增了 "当前 Volume Score 2" 卡片：

```html
<div class="stat-card">
  <h3>当前 Volume Score 2</h3>
  <div class="value" id="currentVolumeScore2">--</div>
</div>
```

- 显示最新的 Volume Score 2 值（保留 4 位小数）
- 颜色指示：
  - 绿色：> 1.0（成交量活跃度高于平均）
  - 红色：< 1.0（成交量活跃度低于平均）

#### 新增图表

在页面底部新增了独立的 Volume Score 2 图表：

```html
<div class="chart-container">
  <h2>Market Volume Score 2 (MA Ratio)</h2>
  <div id="volumeScore2Chart" class="chart-wrapper"></div>
</div>
```

**图表特性:**
- 橙色线条（#FF9800）
- 添加了 1.0 参考线（虚线）
- 自动调整时间轴
- 响应式布局

#### 数据加载流程

```javascript
// 1. 并行请求三个数据源
const requests = [
  fetch(`/tradingview/history?symbol=MARKET_PRICE&...`),
  fetch(`/tradingview/history?symbol=MARKET_VOLUME&...`),
  fetch(`/market/volume_score/history?from=${fromMs}&to=${toMs}`)  // 新增
];

// 2. 转换数据格式
const volumeScore2ChartData = (volumeScore2Data || []).map(item => ({
  time: Math.floor(item.ts_minute / 1000) + TIMEZONE_OFFSET,
  value: item.market_volume_score_2
}));

// 3. 更新图表
volumeScore2Series.setData(volumeScore2ChartData);
```

## 数据说明

### Volume Score 2 计算逻辑

```
market_volume_score_2 = total_volume_ma1 / total_volume_ma2

其中:
- total_volume_ma1: 所有市值 < 5亿币种的 MA5 总和
- total_volume_ma2: 所有市值 < 5亿币种的 MA120 总和
- MA5: 最近 5 根 5 分钟 K 线的平均成交量（25 分钟）
- MA120: 最近 120 根 5 分钟 K 线的平均成交量（10 小时）
```

### 指标含义

| Volume Score 2 值 | 含义 |
|------------------|------|
| > 1.5 | 成交量显著高于平均水平，市场非常活跃 |
| 1.0 - 1.5 | 成交量高于平均水平，市场活跃 |
| 0.8 - 1.0 | 成交量接近平均水平，市场正常 |
| < 0.8 | 成交量低于平均水平，市场清淡 |

## 页面布局

```
┌─────────────────────────────────────────────────────┐
│ 📊 Market State Monitor - TradingView Charts       │
├─────────────────────────────────────────────────────┤
│ [时间范围] [分辨率] [显示原始数据] [均线] [刷新]      │
├─────────────────────────────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐       │
│ │价格  │ │成交量│ │VS2   │ │数据点│ │更新  │       │
│ │得分  │ │得分  │ │      │ │数量  │ │时间  │       │
│ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘       │
├─────────────────────────────────────────────────────┤
│ Market Price Score (-100 ~ 100)                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │         [价格得分图表]                           │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ Market Volume Score (0 ~ 100)                       │
│ ┌─────────────────────────────────────────────────┐ │
│ │         [成交量得分图表]                         │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ Market Volume Score 2 (MA Ratio)  ← 新增            │
│ ┌─────────────────────────────────────────────────┐ │
│ │         [Volume Score 2 图表]                    │ │
│ │         橙色线条 + 1.0 参考线                     │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

## 使用方法

### 1. 启动服务

确保以下进程正在运行：

```bash
# 启动所有服务
pm2 start ecosystem.config.cjs

# 或单独启动
pm2 start volume_score_calculator.js --name volume-score-calc
pm2 start server.js --name server
```

### 2. 访问页面

```
http://localhost:8080/chart
```

### 3. 查看数据

- **统计卡片**: 页面顶部显示当前 Volume Score 2 值
- **图表**: 页面底部显示历史趋势
- **时间范围**: 可选择 1小时、6小时、24小时、3天、7天
- **自动刷新**: 点击 "启用自动刷新" 按钮，每分钟自动更新

## 调试

### 检查数据是否正常

```bash
# 1. 检查数据库是否有数据
sqlite3 data.sqlite "SELECT COUNT(*) FROM market_volume_score_minute;"

# 2. 查看最新记录
sqlite3 data.sqlite "SELECT * FROM market_volume_score_minute ORDER BY ts_minute DESC LIMIT 5;"

# 3. 测试 API
curl "http://localhost:8080/market/volume_score/latest"
curl "http://localhost:8080/market/volume_score/history?limit=10"
```

### 浏览器控制台日志

打开浏览器开发者工具（F12），查看控制台输出：

```
加载数据...
Price data: ok 1440 points
Volume data: ok 1440 points
Volume Score 2 data: 1440 points
✓ 图表更新成功 { showRawData: false, volumeScore2Points: 1440 }
```

## 常见问题

### Q1: Volume Score 2 图表显示为空

**可能原因:**
1. `volume_score_calculator.js` 未运行
2. 数据库中没有数据（首次运行需要等待 1 分钟）

**解决方法:**
```bash
# 检查进程状态
pm2 status

# 查看日志
pm2 logs volume-score-calc

# 重启进程
pm2 restart volume-score-calc
```

### Q2: 统计卡片显示 "--"

**可能原因:**
数据还未生成或 API 请求失败

**解决方法:**
1. 等待 1-2 分钟让数据生成
2. 检查浏览器控制台是否有错误
3. 手动刷新页面

### Q3: 图表时间不对

**说明:**
图表已自动转换为东8区时间（UTC+8），无需手动调整。

## 修改的文件

1. ✅ **server.js**
   - 导入 `getLatestMarketVolumeScore`, `getMarketVolumeScoreHistory`
   - 新增 `/market/volume_score/latest` 接口
   - 新增 `/market/volume_score/history` 接口

2. ✅ **chart_tradingview.html**
   - 新增 Volume Score 2 统计卡片
   - 新增 Volume Score 2 图表容器
   - 初始化第三个图表
   - 加载和显示 Volume Score 2 数据
   - 更新统计信息显示

## 性能考虑

- **数据量**: 默认最多返回 1000 条记录
- **更新频率**: 每分钟更新一次
- **并行请求**: 三个数据源并行加载，提高响应速度
- **响应式**: 图表自动适应窗口大小

## 未来优化

1. **数据聚合**: 支持按小时/天聚合显示
2. **对比分析**: 添加多个时间段的对比
3. **告警阈值**: 当 Volume Score 2 超过/低于阈值时高亮显示
4. **导出功能**: 支持导出图表数据为 CSV

## 修改日期

2025-10-23
