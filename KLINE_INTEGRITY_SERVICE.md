# K 线完整性检查服务

## 概述

`kline_integrity_service.js` 是一个独立的常驻进程，专门负责检查和修复 Redis 中所有交易对的 K 线数据完整性。

## 特性

- ✅ **独立运行**：不依赖 `ws_rule3_monitor.js`，可单独启动
- ✅ **自动修复**：定期检查并自动修复缺失的 K 线数据
- ✅ **智能缓存**：记录无法修复的时间戳，避免重复尝试
- ✅ **优雅退出**：支持 SIGTERM/SIGINT 信号，安全关闭
- ✅ **PM2 管理**：集成 PM2 配置，支持自动重启和监控
- ✅ **状态报告**：每小时输出运行状态

## 启动方式

### 方式 1: 直接运行（开发/测试）

```bash
# 直接启动
npm run kline:integrity

# 或
node kline_integrity_service.js
```

### 方式 2: PM2 管理（生产环境推荐）

```bash
# 启动所有服务（包括 K 线完整性检查）
pm2 start ecosystem.config.cjs

# 只启动 K 线完整性检查服务
pm2 start ecosystem.config.cjs --only kline-integrity

# 查看服务状态
pm2 status

# 查看日志
pm2 logs kline-integrity

# 实时日志
pm2 logs kline-integrity --lines 100

# 重启服务
pm2 restart kline-integrity

# 停止服务
pm2 stop kline-integrity

# 删除服务
pm2 delete kline-integrity
```

## 配置说明

服务从 `config.json` 读取配置：

```json
{
  "redis": {
    "host": "your-redis-host",
    "port": 6379,
    "password": "your-password",
    "db": 0
  },
  "klineCache": {
    "enabled": true,
    "checkIntervalMinutes": 5,
    "retentionHours": 12,
    "restApiBaseUrl": "https://fapi.binance.com"
  },
  "symbolWhitelist": [
    "BTCUSDT",
    "ETHUSDT"
  ]
}
```

### 配置项说明

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `checkIntervalMinutes` | 检查间隔（分钟） | 5 |
| `retentionHours` | 保留时长（小时） | 12 |
| `restApiBaseUrl` | Binance REST API 地址 | https://fapi.binance.com |
| `symbolWhitelist` | 交易对白名单（可选） | 从 Redis 获取 |

## 工作流程

```
1. 启动服务
   ↓
2. 连接 Redis
   ↓
3. 获取交易对列表
   ├─ 优先使用 symbolWhitelist
   └─ 否则从 Redis 获取所有已缓存的交易对
   ↓
4. 创建并启动完整性检查器
   ↓
5. 立即执行第一次检查 ⚡
   ├─ 检查每个交易对的 K 线数据
   ├─ 发现缺失数据
   ├─ 从 Binance API 拉取
   └─ 写入 Redis
   ↓
6. 定期检查（每 5 分钟）
   ├─ 检查每个交易对的 K 线数据
   ├─ 发现缺失数据
   ├─ 从 Binance API 拉取
   └─ 写入 Redis
   ↓
7. 持续运行，直到收到退出信号
```

**注意**：服务启动后会**立即执行第一次检查**，然后按照配置的间隔（默认 5 分钟）定期检查。

## 日志示例

### 启动日志

```
[2025-11-08 13:00:00.000 +0800] INFO: K 线完整性检查服务启动中...
[2025-11-08 13:00:00.100 +0800] INFO: Redis 连接成功
[2025-11-08 13:00:00.200 +0800] INFO: 从 Redis 获取交易对列表
    count: 589
[2025-11-08 13:00:00.300 +0800] INFO: 交易对列表加载完成
    count: 589
[2025-11-08 13:00:00.400 +0800] INFO: K 线完整性检查器配置
    checkIntervalMinutes: 5
    retentionHours: 12
    restBaseUrl: "https://fapi.binance.com"
[2025-11-08 13:00:00.500 +0800] INFO: K 线完整性检查启动
    symbols: 589
    checkIntervalMinutes: 5
    retentionHours: 12
[2025-11-08 13:00:00.600 +0800] INFO: K 线完整性检查服务已启动
```

### 检查日志

```
[2025-11-08 13:05:00.000 +0800] INFO: 开始 K 线完整性检查
    symbols: 589
[2025-11-08 13:05:01.000 +0800] INFO: K 线数据有缺失，逐个修复
    symbol: "BTCUSDT"
    missing: 3
[2025-11-08 13:05:02.000 +0800] INFO: 批量获取 K 线完成
    symbol: "BTCUSDT"
    interval: "1m"
    count: 3
    from: 1762577220000
    to: 1762577460000
[2025-11-08 13:05:03.000 +0800] INFO: K 线数据批量保存到 Redis
    symbol: "BTCUSDT"
    count: 3
[2025-11-08 13:05:04.000 +0800] INFO: K 线数据逐个修复完成
    symbol: "BTCUSDT"
    repairedCount: 3
    ranges: 1
[2025-11-08 13:10:00.000 +0800] INFO: K 线完整性检查完成
    checkedCount: 589
    repairedCount: 15
    errorCount: 0
    durationMs: 300000
```

### 状态报告（每小时）

```
[2025-11-08 14:00:00.000 +0800] INFO: K 线完整性检查服务运行状态
    uptime: 3600
    memory: {
      rss: 52428800,
      heapTotal: 20971520,
      heapUsed: 15728640,
      external: 1048576
    }
    symbols: 589
```

## PM2 配置详解

```javascript
{
  name: 'kline-integrity',           // 服务名称
  script: 'kline_integrity_service.js', // 启动脚本
  instances: 1,                       // 单实例运行
  exec_mode: 'fork',                  // fork 模式
  autorestart: true,                  // 自动重启
  watch: false,                       // 不监听文件变化
  max_memory_restart: '200M',         // 内存超过 200M 自动重启
  env: {
    LOG_LEVEL: 'info'                 // 日志级别
  }
}
```

## 监控和维护

### 查看服务状态

```bash
# PM2 状态
pm2 status kline-integrity

# 详细信息
pm2 show kline-integrity

# 监控面板
pm2 monit
```

### 查看日志

```bash
# 实时日志
pm2 logs kline-integrity --lines 100

# 错误日志
pm2 logs kline-integrity --err

# 输出日志
pm2 logs kline-integrity --out
```

### 性能监控

```bash
# 内存使用
pm2 show kline-integrity | grep memory

# CPU 使用
pm2 show kline-integrity | grep cpu

# 重启次数
pm2 show kline-integrity | grep restart
```

## 故障排查

### 服务无法启动

1. **检查 Redis 连接**
   ```bash
   # 测试 Redis 连接
   redis-cli -h your-host -p 6379 -a your-password ping
   ```

2. **检查配置文件**
   ```bash
   # 验证 config.json 格式
   node -e "console.log(JSON.parse(require('fs').readFileSync('config.json')))"
   ```

3. **查看启动日志**
   ```bash
   pm2 logs kline-integrity --lines 50
   ```

### 服务频繁重启

1. **检查内存使用**
   ```bash
   pm2 show kline-integrity | grep memory
   ```
   - 如果接近 200M，考虑增加 `max_memory_restart`

2. **检查错误日志**
   ```bash
   pm2 logs kline-integrity --err --lines 100
   ```

3. **检查 Redis 连接稳定性**
   - 查看是否有连接超时或断开

### 数据修复失败

1. **检查 Binance API 可用性**
   ```bash
   curl https://fapi.binance.com/fapi/v1/ping
   ```

2. **查看详细日志**
   - 设置 `LOG_LEVEL=debug` 重启服务

3. **手动检查特定交易对**
   ```bash
   node kline_check_all.js --symbol BTCUSDT --verbose
   ```

## 与其他服务的关系

| 服务 | 关系 | 说明 |
|------|------|------|
| `ws_rule3_monitor.js` | 独立 | 不再包含完整性检查器，专注于实时监控 |
| `kline_check_all.js` | 互补 | 手动检查工具，可用于验证和排查 |
| `kline_init.js` | 互补 | 初始化工具，用于首次导入数据 |
| `server.js` | 独立 | HTTP API 服务，读取 Redis 数据 |

## 最佳实践

1. **生产环境使用 PM2**
   - 自动重启
   - 日志管理
   - 监控告警

2. **定期检查服务状态**
   ```bash
   # 每天检查一次
   pm2 status kline-integrity
   ```

3. **监控日志中的警告**
   - 关注 "拉取 K 线返回 0 条数据" 的警告
   - 关注 "修复失败" 的错误

4. **配合手动检查**
   ```bash
   # 每周运行一次全面检查
   npm run kline:check-all
   ```

5. **备份配置**
   - 定期备份 `config.json`
   - 记录重要的配置变更

## 升级和维护

### 更新代码

```bash
# 拉取最新代码
git pull

# 重启服务
pm2 restart kline-integrity
```

### 修改配置

```bash
# 编辑配置文件
vim config.json

# 重启服务使配置生效
pm2 restart kline-integrity
```

### 清理日志

```bash
# 清空 PM2 日志
pm2 flush kline-integrity

# 或清空所有日志
pm2 flush
```

## 常见问题

**Q: 服务占用多少内存？**  
A: 正常情况下 50-100MB，最大不超过 200MB（超过会自动重启）。

**Q: 检查间隔可以调整吗？**  
A: 可以，修改 `config.json` 中的 `checkIntervalMinutes`，建议 3-10 分钟。

**Q: 可以同时运行多个实例吗？**  
A: 不建议。多个实例会重复检查和修复，浪费资源。

**Q: 如何临时停止检查？**  
A: `pm2 stop kline-integrity`，需要时再 `pm2 start kline-integrity`。

**Q: 服务会影响 monitor 性能吗？**  
A: 不会。现在是独立进程，互不影响。

**Q: 如何验证服务正常工作？**  
A: 查看日志中的 "K 线完整性检查完成" 消息，确认 `repairedCount` 和 `errorCount`。

## 技术支持

如有问题，请：
1. 查看日志：`pm2 logs kline-integrity`
2. 检查服务状态：`pm2 show kline-integrity`
3. 运行手动检查：`npm run kline:check-all`
4. 查看 Redis 连接：`redis-cli ping`
