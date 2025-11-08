# K 线数据 Redis 缓存功能

## 功能概述

为了避免外部下单程序频繁调用 Binance REST API 导致限流，本系统将 WebSocket 接收的 1 分钟 K 线数据实时保存到 Redis，并提供 HTTP API 供外部程序查询。

### 核心特性

1. **实时缓存**：WebSocket 接收的 K 线数据实时写入 Redis（包括未关闭的 K 线）
2. **滑动窗口**：自动保留最近 12 小时的数据，过期数据自动清理
3. **数据完整性检查**：定期检查数据完整性，自动修复缺失或错误的数据
4. **限流保护**：REST API 调用带智能限流，避免触发 Binance 限制
5. **高可用性**：Redis 连接失败不影响主监控流程
6. **实时更新**：当前正在进行的 K 线也会实时更新到 Redis（通过 `x` 字段区分是否已关闭）

## 架构设计

```
WebSocket (Binance) 
    ↓
ws_rule3_monitor.js (实时写入)
    ↓
Redis (Sorted Set, 12小时滑动窗口)
    ↑
完整性检查器 (每5分钟) ← Binance REST API (修复缺失数据)
    ↑
HTTP API (server.js) → 外部下单程序
```

## 数据结构

### Redis Key 格式

```
kline:1m:{SYMBOL}
```

### 数据格式 (Sorted Set)

- **Score**: openTime (毫秒时间戳)
- **Value**: JSON 字符串

```json
{
  "t": 1699430400000,  // openTime (毫秒)
  "o": "35000.00",     // open price
  "h": "35100.00",     // high price
  "l": "34900.00",     // low price
  "c": "35050.00",     // close price
  "v": "123.45",       // volume (base asset)
  "q": "4320000.00",   // quote volume (USDT)
  "n": 1234,           // number of trades
  "x": true            // is closed (true=已关闭, false=进行中)
}
```

## 配置说明

在 `config.json` 中添加以下配置：

```json
{
  "redis": {
    "host": "localhost",
    "port": 6379,
    "password": "",
    "db": 0
  },
  
  "klineCache": {
    "enabled": true,
    "retentionHours": 12,
    "checkIntervalMinutes": 5,
    "restApiBaseUrl": "https://fapi.binance.com",
    "rateLimitWeight": 2000,
    "rateLimitWindowMs": 60000
  }
}
```

### 配置项说明

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `redis.host` | Redis 服务器地址 | localhost |
| `redis.port` | Redis 端口 | 6379 |
| `redis.password` | Redis 密码（可选） | "" |
| `redis.db` | Redis 数据库编号 | 0 |
| `klineCache.enabled` | 是否启用 K 线缓存 | true |
| `klineCache.retentionHours` | 数据保留时长（小时） | 12 |
| `klineCache.checkIntervalMinutes` | 完整性检查间隔（分钟） | 5 |
| `klineCache.restApiBaseUrl` | Binance REST API 地址 | https://fapi.binance.com |
| `klineCache.rateLimitWeight` | 限流权重上限 | 2000 |
| `klineCache.rateLimitWindowMs` | 限流时间窗口（毫秒） | 60000 |

## HTTP API 接口

### 1. 查询 K 线数据

```
GET /api/klines?symbol=BTCUSDT&from=1699430400000&to=1699433000000
```

**参数**：
- `symbol` (必填): 交易对符号，如 BTCUSDT
- `from` (可选): 开始时间戳（毫秒）
- `to` (可选): 结束时间戳（毫秒）

**响应**：
```json
{
  "data": [
    {
      "t": 1699430400000,
      "o": "35000.00",
      "h": "35100.00",
      "l": "34900.00",
      "c": "35050.00",
      "v": "123.45",
      "q": "4320000.00",
      "n": 1234
    }
  ]
}
```

### 2. 获取最新 K 线

```
GET /api/klines/latest?symbol=BTCUSDT
```

**响应**：
```json
{
  "data": {
    "t": 1699430400000,
    "o": "35000.00",
    "h": "35100.00",
    "l": "34900.00",
    "c": "35050.00",
    "v": "123.45",
    "q": "4320000.00",
    "n": 1234
  }
}
```

### 3. 获取统计信息

```
GET /api/klines/stats?symbol=BTCUSDT
```

**响应**：
```json
{
  "data": {
    "symbol": "BTCUSDT",
    "count": 720,
    "latestTime": 1699430400000
  }
}
```

### 4. 获取所有已缓存的交易对

```
GET /api/klines/symbols
```

**响应**：
```json
{
  "data": ["BTCUSDT", "ETHUSDT", "BNBUSDT"]
}
```

### 5. 手动触发完整性检查

```
POST /api/klines/check?symbol=BTCUSDT
```

**响应**：
```json
{
  "data": {
    "success": true,
    "symbol": "BTCUSDT",
    "repairedCount": 5,
    "durationMs": 1234
  }
}
```

## 安装部署

### 1. 安装依赖

```bash
npm install
```

这会自动安装 `redis` 包（版本 ^4.6.0）。

### 2. 配置 Redis

确保 Redis 服务已启动：

```bash
# macOS (Homebrew)
brew services start redis

# Linux (systemd)
sudo systemctl start redis

# Docker
docker run -d -p 6379:6379 redis:7-alpine
```

### 3. 配置文件

复制示例配置并修改：

```bash
cp config.example.json config.json
```

编辑 `config.json`，填入 Redis 连接信息。

### 4. 启动服务

```bash
# 启动 WebSocket 监控（会自动启动 K 线缓存和完整性检查）
node ws_rule3_monitor.js

# 启动 HTTP API 服务
node server.js
```

## 数据完整性保障

### 自动检查机制

完整性检查器每 5 分钟（可配置）自动执行以下操作：

1. **检查数据完整性**：扫描最近 12 小时的数据，查找缺失的分钟桶
2. **智能修复策略**：
   - 缺失 < 50%：逐个区间修复（减少 API 调用）
   - 缺失 >= 50%：批量拉取整个时间范围
3. **限流保护**：自动控制 REST API 调用频率，避免触发限制
4. **指数退避重试**：失败时自动重试（最多 3 次）

### 手动检查

可通过 HTTP API 手动触发检查：

```bash
curl -X POST "http://localhost:8080/api/klines/check?symbol=BTCUSDT"
```

## 监控与调试

### 日志输出

系统会输出以下关键日志：

```
[INFO] Redis 客户端初始化成功
[INFO] K 线完整性检查器已启动
[DEBUG] K 线数据已保存到 Redis: symbol=BTCUSDT openTime=1699430400000
[INFO] K 线完整性检查完成: checkedCount=60 repairedCount=3
```

### Redis 数据查看

```bash
# 连接 Redis
redis-cli

# 查看某个交易对的数据量
ZCARD kline:1m:BTCUSDT

# 查看最新 10 条数据
ZREVRANGE kline:1m:BTCUSDT 0 9

# 查看指定时间范围的数据
ZRANGEBYSCORE kline:1m:BTCUSDT 1699430400000 1699433000000
```

## 性能指标

- **写入延迟**: < 5ms (异步写入，不阻塞主流程)
- **查询延迟**: < 10ms (Redis Sorted Set 范围查询)
- **内存占用**: 约 50KB/交易对 (720 条 K 线数据)
- **修复速度**: 约 100 条/秒 (受 Binance API 限流影响)

## 故障处理

### Redis 连接失败

- **现象**: 日志显示 "Redis 初始化失败"
- **影响**: K 线缓存功能不可用，但主监控流程正常运行
- **处理**: 检查 Redis 服务状态和配置

### 数据缺失

- **现象**: 查询返回的数据不完整
- **处理**: 
  1. 等待下一次自动检查（5 分钟内）
  2. 或手动触发检查：`POST /api/klines/check?symbol=SYMBOL`

### API 限流

- **现象**: 日志显示 "限流等待中"
- **影响**: 数据修复速度变慢
- **处理**: 正常现象，系统会自动控制请求频率

## 注意事项

1. **Redis 内存管理**：每个交易对约占用 50KB，60 个交易对约 3MB
2. **网络稳定性**：WebSocket 断线会导致数据缺失，但会被自动修复
3. **时区问题**：所有时间戳均为 UTC 毫秒时间戳
4. **数据精度**：价格和成交量保持原始字符串格式，避免精度丢失

## 外部程序调用示例

### Python 示例

```python
import requests
import time

# 查询最近 1 小时的 K 线数据
symbol = "BTCUSDT"
to_ts = int(time.time() * 1000)
from_ts = to_ts - 3600 * 1000

response = requests.get(
    f"http://localhost:8080/api/klines",
    params={"symbol": symbol, "from": from_ts, "to": to_ts}
)

data = response.json()
klines = data["data"]

print(f"获取到 {len(klines)} 条 K 线数据")

# 区分已关闭和进行中的 K 线
for kline in klines[-5:]:  # 打印最新 5 条
    status = "已关闭" if kline.get('x', True) else "进行中"
    print(f"时间: {kline['t']}, 收盘价: {kline['c']}, 成交量: {kline['q']}, 状态: {status}")

# 仅使用已关闭的 K 线（用于策略计算）
closed_klines = [k for k in klines if k.get('x', True)]
print(f"已关闭的 K 线: {len(closed_klines)} 条")
```

### JavaScript 示例

```javascript
const axios = require('axios');

async function getKlines(symbol, minutes = 60) {
  const to = Date.now();
  const from = to - minutes * 60 * 1000;
  
  const response = await axios.get('http://localhost:8080/api/klines', {
    params: { symbol, from, to }
  });
  
  return response.data.data;
}

// 使用示例
(async () => {
  const klines = await getKlines('BTCUSDT', 60);
  console.log(`获取到 ${klines.length} 条 K 线数据`);
  
  // 获取最新 K 线（可能是进行中的）
  const latest = klines[klines.length - 1];
  console.log('最新价格:', latest.c, '状态:', latest.x ? '已关闭' : '进行中');
  
  // 仅使用已关闭的 K 线（用于策略计算）
  const closedKlines = klines.filter(k => k.x !== false);
  console.log(`已关闭的 K 线: ${closedKlines.length} 条`);
})();
```

## 常见问题

**Q: 为什么不直接调用 Binance API？**  
A: Binance API 有严格的限流限制（每分钟 2400 权重），频繁调用会被限流甚至封禁。使用本地缓存可以无限制查询。

**Q: 数据会丢失吗？**  
A: WebSocket 断线可能导致短暂数据缺失，但完整性检查器会在 5 分钟内自动修复。

**Q: 可以缓存其他时间周期的 K 线吗？**  
A: 当前仅支持 1 分钟 K 线。如需其他周期，可在查询后自行聚合。

**Q: Redis 内存不足怎么办？**  
A: 可以减少 `retentionHours` 或减少监控的交易对数量。

**Q: `x` 字段是什么意思？**  
A: `x` 表示 K 线是否已关闭（`true`=已关闭，`false`=进行中）。当前正在进行的 K 线会实时更新，`x=false`。

**Q: 为什么要保存未关闭的 K 线？**  
A: 为了获取最新的实时价格和成交量。外部程序可以根据 `x` 字段判断是否使用该 K 线。

**Q: 策略计算时应该使用哪些 K 线？**  
A: 建议仅使用已关闭的 K 线（`x=true` 或 `x` 字段不存在），以确保数据完整性。

## 技术支持

如有问题，请查看日志文件或联系开发团队。
