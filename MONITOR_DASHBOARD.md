# 监控面板使用说明

## 功能概述

交互式监控面板提供以下功能：

1. **左侧币种列表**
   - 显示所有合约币种
   - 实时搜索筛选
   - 显示告警数量徽章
   - 区分默认策略（红色）和档位策略（深红色）

2. **右侧 TradingView 图表**
   - 实时 K 线图
   - 东8区时间显示
   - 策略告警点标记
   - 鼠标悬浮显示详情

3. **告警标记**
   - **‼️ 红色圆点**: 默认策略 (rule3_default.js)
   - **🔥 深红色圆点**: 档位策略 (rule3_tier_bypass.js)

## 访问地址

```
http://localhost:8080/monitor
```

## 使用步骤

### 1. 启动服务

```bash
# 启动 HTTP 服务器
pm2 start ecosystem.config.cjs --only server

# 或者直接运行
node server.js
```

### 2. 打开页面

在浏览器中访问：`http://localhost:8080/monitor`

### 3. 选择币种

- 在左侧列表中点击任意币种
- 或使用搜索框快速筛选
- 币种旁边的数字表示最近24小时的告警次数

### 4. 查看告警

- 图表上的标记点表示策略触发的告警
- 鼠标悬浮在标记点上查看详细信息：
  - 触发时间
  - 策略类型
  - 成交额
  - 市值
  - 倍数
  - 涨跌幅

## API 接口

### 1. 获取所有币种

```
GET /api/symbols
```

**响应**:
```json
{
  "symbols": ["BTCUSDT", "ETHUSDT", ...]
}
```

### 2. 获取告警统计

```
GET /api/alerts/stats?hours=24
```

**参数**:
- `hours`: 统计时间范围（小时），默认 24

**响应**:
```json
{
  "bySymbol": {
    "BTCUSDT": {
      "total": 10,
      "type1": 6,
      "type2": 4
    }
  }
}
```

### 3. 获取单个币种的告警历史

```
GET /api/alerts/symbol/BTCUSDT?hours=24
```

**参数**:
- `hours`: 查询时间范围（小时），默认 24

**响应**:
```json
{
  "alerts": [
    {
      "id": "alert_0",
      "symbol": "BTCUSDT",
      "timestamp": 1729000000000,
      "kline_close": 1729000060000,
      "type": "1",
      "reason": "BTCUSDT:ws_rule3_5m_10000000"
    }
  ]
}
```

## 数据说明

### 告警类型

- **type1**: 默认策略 (rule3_default.js)
  - 成交额阈值触发
  - 市值过滤
  - 均量检查

- **type2**: 档位策略 (rule3_tier_bypass.js)
  - 基于市值区间和5分钟成交额
  - 档位匹配
  - 绕过均量检查

### 时间显示

- 所有时间均为**东8区（Asia/Shanghai）**
- TradingView 图表自动转换为本地时区

## 技术细节

### 前端技术栈

- 原生 JavaScript
- TradingView Charting Library
- 响应式布局

### 后端 API

- Node.js HTTP Server
- SQLite 数据库
- 实时数据查询

### 数据流

```
alerts_state 表 (SQLite)
    ↓
API 查询 (/api/alerts/*)
    ↓
前端渲染 (monitor_dashboard.html)
    ↓
TradingView 图表标记
```

## 注意事项

1. **数据来源**: 告警数据来自 `alerts_state` 表，由 `ws_rule3_monitor.js` 写入

2. **性能**: 默认查询最近24小时的数据，如需更长时间范围，请使用 `hours` 参数

3. **实时性**: 页面不会自动刷新，需要手动刷新或重新选择币种

4. **浏览器兼容性**: 建议使用 Chrome、Firefox、Edge 等现代浏览器

## 故障排查

### 1. 页面无法加载

**检查**:
```bash
# 确认服务器运行
pm2 status

# 查看日志
pm2 logs server
```

### 2. 币种列表为空

**原因**: `supplies` 表无数据

**解决**:
```bash
# 运行供给数据同步
node supply_sync_binance.js
```

### 3. 没有告警数据

**原因**: `alerts_state` 表无数据

**解决**:
```bash
# 确认 ws_rule3_monitor 运行
pm2 status ws-rule3-monitor

# 查看日志
pm2 logs ws-rule3-monitor
```

### 4. 图表无法显示

**原因**: TradingView 数据接口问题

**检查**:
```bash
# 测试 TradingView 配置接口
curl http://localhost:8080/tradingview/config

# 测试历史数据接口
curl "http://localhost:8080/tradingview/history?symbol=BTCUSDT&resolution=1&from=1729000000&to=1729100000"
```

## 未来改进

- [ ] 实时 WebSocket 推送新告警
- [ ] 告警详情弹窗
- [ ] 多币种对比视图
- [ ] 导出告警数据
- [ ] 自定义时间范围选择
- [ ] 策略过滤器
- [ ] 告警通知设置

## 相关文件

- `monitor_dashboard.html` - 前端页面
- `server.js` - HTTP 服务器
- `db.js` - 数据库查询函数
- `strategies/rule3_default.js` - 默认策略
- `strategies/rule3_tier_bypass.js` - 档位策略
