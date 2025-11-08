# K 线数据初始化工具使用指南

## 快速开始

### 1. 确保 Redis 已启动

```bash
# macOS
brew services start redis

# Linux
sudo systemctl start redis

# Docker
docker run -d -p 6379:6379 redis:7-alpine
```

### 2. 配置 config.json

确保配置文件中包含 Redis 和 K 线缓存配置：

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
    "initConcurrency": 3
  }
}
```

### 3. 初始化数据

```bash
# 方式 1: 使用 npm 脚本（推荐）
npm run kline:init

# 方式 2: 直接运行
node kline_init.js init
```

## 命令详解

### 初始化所有交易对

```bash
npm run kline:init
# 或
node kline_init.js init
```

- 从 `config.json` 的 `symbolWhitelist` 读取交易对列表
- 如果未配置白名单，则从 Binance 获取所有 USDT 永续合约
- 每个交易对拉取最近 12 小时的 K 线数据
- 默认并发数为 3，避免触发限流

**预计耗时**: 60 个交易对约 3-5 分钟

### 初始化单个交易对

```bash
node kline_init.js init-symbol BTCUSDT
```

适用场景：
- 新增交易对
- 单个交易对数据损坏需要重新初始化

### 查看统计信息

```bash
npm run kline:stats
# 或
node kline_init.js stats
```

输出示例：
```
[INFO] 已缓存的交易对数量: count=60
```

查看详细信息（前 10 个交易对）：
```bash
node kline_init.js stats --detail
```

输出示例：
```
[INFO] 交易对详情: symbol=BTCUSDT count=720 latestTime=2024-11-08T03:49:00.000Z
[INFO] 交易对详情: symbol=ETHUSDT count=720 latestTime=2024-11-08T03:49:00.000Z
...
```

### 清空数据

清空所有交易对：
```bash
npm run kline:clear
# 或
node kline_init.js clear
```

清空单个交易对：
```bash
node kline_init.js clear-symbol BTCUSDT
```

### 帮助信息

```bash
node kline_init.js help
```

## 配置参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `klineCache.retentionHours` | 数据保留时长（小时） | 12 |
| `klineCache.initConcurrency` | 初始化并发数 | 3 |
| `klineCache.restApiBaseUrl` | Binance API 地址 | https://fapi.binance.com |
| `symbolWhitelist` | 交易对白名单（可选） | [] |

## 使用场景

### 场景 1: 首次部署

```bash
# 1. 配置 config.json
# 2. 初始化所有数据
npm run kline:init

# 3. 启动监控服务
node ws_rule3_monitor.js

# 4. 启动 API 服务
node server.js
```

### 场景 2: Redis 数据丢失

```bash
# 重新初始化所有数据
npm run kline:init
```

### 场景 3: 新增交易对

```bash
# 初始化单个交易对
node kline_init.js init-symbol NEWUSDT
```

### 场景 4: 数据验证

```bash
# 查看统计信息
npm run kline:stats

# 查看详细信息
node kline_init.js stats --detail

# 通过 HTTP API 验证
curl "http://localhost:8080/api/klines/stats?symbol=BTCUSDT"
```

## 注意事项

### 1. 限流控制

- 初始化会调用大量 Binance REST API
- 内置限流器控制请求频率（每分钟 2000 权重）
- 默认并发数为 3，可通过 `initConcurrency` 调整
- 如果触发限流，程序会自动等待

### 2. 数据量估算

- 每个交易对 12 小时 = 720 条 K 线
- 每条 K 线约 70 字节
- 60 个交易对约 3MB 内存

### 3. 初始化时间

- 单个交易对: 约 3-5 秒
- 60 个交易对（并发 3）: 约 3-5 分钟
- 时间取决于网络速度和 API 响应

### 4. 错误处理

- 单个交易对失败不影响其他交易对
- 失败的交易对会在日志中标记
- 可以单独重新初始化失败的交易对

### 5. 与监控服务的关系

- 初始化工具与监控服务独立运行
- 可以在监控服务运行时执行初始化
- Redis 数据会被自动合并（相同时间戳会覆盖）

## 常见问题

**Q: 初始化需要多长时间？**  
A: 60 个交易对约 3-5 分钟，取决于网络速度。

**Q: 可以在监控服务运行时初始化吗？**  
A: 可以，两者互不影响。相同时间戳的数据会被覆盖。

**Q: 初始化失败怎么办？**  
A: 查看日志找到失败的交易对，使用 `init-symbol` 单独初始化。

**Q: 如何验证数据是否正确？**  
A: 使用 `npm run kline:stats` 查看统计，或通过 HTTP API 查询数据。

**Q: 可以调整并发数吗？**  
A: 可以，在 `config.json` 中设置 `klineCache.initConcurrency`。建议不超过 5。

**Q: 初始化会覆盖现有数据吗？**  
A: 会。相同时间戳的 K 线会被覆盖。如果不想覆盖，先执行 `clear`。

## 日志示例

成功初始化：
```
[INFO] Redis 连接成功
[INFO] 开始批量初始化 K 线数据: symbols=60 retentionHours=12 concurrency=3
[INFO] 开始初始化 K 线数据: symbol=BTCUSDT retentionHours=12
[INFO] K 线数据初始化完成: symbol=BTCUSDT count=720
[INFO] 初始化进度: 3/60
...
[INFO] 批量初始化完成: total=60 success=60 failed=0 totalKlines=43200 durationMin=4.23
```

部分失败：
```
[ERROR] K 线数据初始化失败: symbol=NEWUSDT err=HTTP 400: Invalid symbol
[INFO] 批量初始化完成: total=60 success=59 failed=1 totalKlines=42480
```

## 进阶用法

### 自定义交易对列表

在 `config.json` 中配置：
```json
{
  "symbolWhitelist": ["BTCUSDT", "ETHUSDT", "BNBUSDT"]
}
```

然后运行：
```bash
npm run kline:init
```

### 定时重新初始化

使用 cron 定时任务（不推荐，因为有完整性检查器）：
```bash
# 每天凌晨 4 点重新初始化
0 4 * * * cd /path/to/future_monitor && npm run kline:init
```

### 监控初始化状态

```bash
# 实时查看日志
tail -f logs/app.log | grep "初始化"

# 查看 Redis 数据
redis-cli
> KEYS kline:1m:*
> ZCARD kline:1m:BTCUSDT
```

## 与完整性检查器的区别

| 特性 | 初始化工具 | 完整性检查器 |
|------|-----------|-------------|
| 运行方式 | 手动执行 | 自动定时运行 |
| 使用场景 | 首次部署、数据丢失 | 日常维护 |
| 数据来源 | Binance REST API | Binance REST API |
| 覆盖策略 | 完全覆盖 | 仅补全缺失 |
| 运行时间 | 3-5 分钟 | 持续运行 |

**建议**：
- 首次部署使用初始化工具
- 日常运行依赖完整性检查器
- 数据丢失时使用初始化工具恢复
