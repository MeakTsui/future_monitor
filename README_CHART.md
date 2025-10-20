# 图表页面使用指南

## 问题：图表初始化失败

如果遇到"图表初始化失败"的错误，请按以下步骤排查：

## 快速解决方案

### 方案 1: 使用简化版页面（推荐）

打开 `chart_simple.html`，这个版本：
- ✅ 不依赖时间适配器
- ✅ 使用简单的标签而非时间轴
- ✅ 包含表格视图作为备选
- ✅ 更好的错误提示

```bash
open chart_simple.html
```

### 方案 2: 检查数据是否存在

图表需要数据才能显示。确保 `market_state_cron.js` 正在运行：

```bash
# 检查进程
ps aux | grep market_state_cron

# 如果没有运行，启动它
node market_state_cron.js &

# 或使用 PM2
pm2 start ecosystem.config.cjs
pm2 logs market-state
```

等待 2-3 分钟让系统积累数据，然后刷新页面。

### 方案 3: 测试 API 是否正常

```bash
# 测试服务器是否运行
curl http://localhost:8080/market/state/latest

# 测试 TradingView 接口
curl "http://localhost:8080/tradingview/history?symbol=MARKET_PRICE&resolution=5&from=$(date -u -v-1H +%s)&to=$(date -u +%s)"
```

如果返回 `{"s":"no_data"}`，说明数据库中没有数据。

## 常见错误及解决方案

### 错误 1: "Chart.js 未加载"

**原因**: CDN 无法访问

**解决方案**:
1. 检查网络连接
2. 或下载 Chart.js 到本地：
```bash
mkdir -p public/js
curl -o public/js/chart.js https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js
```

然后修改 HTML 中的引用：
```html
<script src="./public/js/chart.js"></script>
```

### 错误 2: "找不到 canvas 元素"

**原因**: HTML 结构问题或页面未完全加载

**解决方案**: 使用 `chart_simple.html`，它有更好的加载时序控制

### 错误 3: "暂无数据"

**原因**: 数据库中没有数据

**解决方案**:
```bash
# 1. 确保 market_state_cron.js 正在运行
node market_state_cron.js

# 2. 等待至少 2 分钟

# 3. 检查数据库
sqlite3 data.sqlite "SELECT COUNT(*) FROM market_state_minute;"

# 4. 查看最新数据
sqlite3 data.sqlite "SELECT datetime(ts_minute/1000, 'unixepoch'), price_score, volume_score FROM market_state_minute ORDER BY ts_minute DESC LIMIT 5;"
```

### 错误 4: Node.js 版本不匹配

**错误信息**: `NODE_MODULE_VERSION 127 vs 131`

**解决方案**:
```bash
npm rebuild better-sqlite3
# 或
npm install better-sqlite3 --build-from-source
```

## 页面对比

| 功能 | chart_test.html | chart_simple.html |
|------|----------------|-------------------|
| 时间轴 | ✓ (需要适配器) | ✗ (使用简单标签) |
| 多分辨率 | ✓ | ✗ |
| 表格视图 | ✗ | ✓ |
| 错误处理 | 基础 | 增强 |
| 推荐使用 | 高级用户 | **所有用户** |

## 完整启动流程

```bash
# 1. 重新安装依赖（如果需要）
npm rebuild better-sqlite3

# 2. 启动数据采集（如果还没运行）
pm2 start ecosystem.config.cjs
pm2 logs market-state

# 3. 等待 2-3 分钟积累数据

# 4. 启动 HTTP 服务器（如果还没运行）
node server.js

# 5. 打开简化版页面
open chart_simple.html
```

## 浏览器控制台调试

打开浏览器开发者工具（F12），在 Console 中运行：

```javascript
// 检查 Chart.js
console.log('Chart.js:', typeof Chart);

// 检查 canvas 元素
console.log('Canvas:', document.getElementById('priceChart'));

// 手动测试 API
fetch('http://localhost:8080/tradingview/history?symbol=MARKET_PRICE&resolution=5&from=' + (Math.floor(Date.now()/1000) - 3600) + '&to=' + Math.floor(Date.now()/1000))
  .then(r => r.json())
  .then(d => console.log('API Response:', d));
```

## 获取帮助

如果以上方法都无法解决问题，请提供：
1. 浏览器控制台的完整错误信息
2. `node server.js` 的日志输出
3. `pm2 logs market-state` 的输出
4. 数据库中的数据量：`sqlite3 data.sqlite "SELECT COUNT(*) FROM market_state_minute;"`
