# K 线数据完整性检查工具使用指南

## 功能说明

`kline_check_all.js` 是一个独立的命令行工具，用于检查 Redis 中所有交易对的 K 线数据完整性，并可选择性地自动修复缺失的数据。

## 使用方法

### 1. 检查所有交易对（仅报告）

```bash
npm run kline:check-all
# 或
node kline_check_all.js
```

**输出示例**：
```
========== K 线数据完整性检查 ==========

找到 589 个已缓存的交易对
检查模式: 仅检查
检查范围: 最近 12 小时

[1/589] ✅ BTCUSDT: 数据完整 (720 条)
[2/589] ⚠️  ETHUSDT: 缺失 5 条 (0.69%)
[3/589] ✅ BNBUSDT: 数据完整 (720 条)
...

============================================================

检查完成:

总交易对数: 589
数据完整: 550 (93.38%)
数据缺失: 39 (6.62%)
总耗时: 45.23 秒

缺失数据最多的交易对 (前 10):

  ETHUSDT         缺失:    5 条 (0.69%) ⚠️  待修复
  BNBUSDT         缺失:    3 条 (0.42%) ⚠️  待修复
  ...

💡 提示: 使用 --repair 参数可以自动修复缺失的数据
```

### 2. 检查并自动修复所有交易对

```bash
npm run kline:repair-all
# 或
node kline_check_all.js --repair
```

**输出示例**：
```
[2/589] ⚠️  ETHUSDT: 缺失 5 条 (0.69%)
   正在修复...
   ✅ 已修复 5 条数据
```

### 3. 检查单个交易对

```bash
node kline_check_all.js --symbol BTCUSDT
```

### 4. 检查并修复单个交易对

```bash
node kline_check_all.js --symbol BTCUSDT --repair
```

### 5. 显示详细信息

```bash
node kline_check_all.js --verbose
```

显示所有交易对的检查结果，包括数据完整的交易对。

## 命令行参数

| 参数 | 简写 | 说明 |
|------|------|------|
| `--repair` | `-r` | 检查并自动修复缺失的数据 |
| `--symbol SYMBOL` | `-s` | 只检查指定的交易对 |
| `--verbose` | `-v` | 显示详细信息（包括完整的交易对） |
| `--help` | `-h` | 显示帮助信息 |

## 使用场景

### 场景 1: 定期检查数据完整性

```bash
# 每天运行一次，检查是否有缺失数据
npm run kline:check-all
```

### 场景 2: 发现数据缺失后修复

```bash
# 先检查
npm run kline:check-all

# 如果发现缺失，执行修复
npm run kline:repair-all

# 再次检查验证
npm run kline:check-all
```

### 场景 3: 排查特定交易对问题

```bash
# 检查单个交易对
node kline_check_all.js --symbol BTCUSDT --verbose

# 如果有问题，修复
node kline_check_all.js --symbol BTCUSDT --repair
```

### 场景 4: Redis 数据迁移后验证

```bash
# 迁移后检查所有数据
npm run kline:check-all --verbose

# 修复缺失的数据
npm run kline:repair-all
```

## 与其他工具的区别

| 工具 | 用途 | 运行方式 | 修复能力 |
|------|------|---------|---------|
| `kline_check_all.js` | **独立检查所有交易对** | 手动运行 | ✅ 可选 |
| `kline_integrity_checker.js` | 后台定时检查 | 在 monitor 中自动运行 | ✅ 自动 |
| `check_redis_duplicates.js` | 检查重复数据 | 手动运行 | ❌ 仅检查 |
| `clean_redis_duplicates.js` | 清理重复数据 | 手动运行 | ✅ 清理重复 |

## 工作原理

### 检查逻辑

1. 获取所有已缓存的交易对（或指定交易对）
2. 对每个交易对：
   - 计算应该存在的时间范围（最近 12 小时）
   - 查询 Redis 中实际存在的 K 线
   - 找出缺失的分钟桶
3. 统计并报告结果

### 修复逻辑

1. 发现缺失数据后
2. 从 Binance REST API 拉取缺失的 K 线
3. 写入 Redis
4. 报告修复结果

### 限流保护

- 使用内置的限流器，避免触发 Binance API 限制
- 每 10 个交易对延迟 100ms
- 批量拉取时自动分页

## 性能指标

- **检查速度**: 约 10-15 个交易对/秒
- **修复速度**: 约 3-5 个交易对/秒（取决于缺失数量）
- **内存占用**: < 100MB
- **API 调用**: 仅在修复时调用

## 注意事项

### 1. 时间范围

- 默认检查最近 12 小时的数据
- 不检查当前正在进行的分钟（避免误报）
- 可在 `config.json` 中调整 `retentionHours`

### 2. 修复模式

- 修复模式会调用 Binance REST API
- 注意 API 限流（每分钟 2400 权重）
- 大量缺失时建议分批修复

### 3. 数据一致性

- 修复的数据会覆盖 Redis 中的旧数据
- 使用与初始化相同的去重机制
- 确保数据唯一性

### 4. 与后台检查器的关系

- 本工具是**手动执行**的独立程序
- 后台检查器（`kline_integrity_checker.js`）在 `ws_rule3_monitor.js` 中**自动运行**
- 两者可以同时使用，互不影响

## 常见问题

**Q: 检查需要多长时间？**  
A: 取决于交易对数量。589 个交易对约需 45-60 秒。

**Q: 修复需要多长时间？**  
A: 取决于缺失数据量。如果缺失 < 10%，约 2-5 分钟。

**Q: 会影响正在运行的监控服务吗？**  
A: 不会。这是独立程序，不影响 `ws_rule3_monitor.js`。

**Q: 可以在监控服务运行时执行吗？**  
A: 可以。两者使用相同的 Redis，数据会自动同步。

**Q: 修复失败怎么办？**  
A: 查看日志找到失败原因，可以单独修复失败的交易对。

**Q: 如何定时执行检查？**  
A: 使用 cron 定时任务：
```bash
# 每天凌晨 3 点检查并修复
0 3 * * * cd /path/to/future_monitor && npm run kline:repair-all
```

## 输出说明

### 符号含义

- ✅ 数据完整
- ⚠️  数据缺失（待修复）
- ✅ 已修复
- ❌ 检查/修复失败

### 统计指标

- **总交易对数**: Redis 中缓存的交易对总数
- **数据完整**: 没有缺失数据的交易对数量
- **数据缺失**: 有缺失数据的交易对数量
- **已修复**: 成功修复的交易对数量（仅修复模式）
- **检查失败**: 检查过程中出错的交易对数量

## 最佳实践

1. **定期检查**: 每天运行一次检查，确保数据完整性
2. **先检查后修复**: 先运行检查模式，评估缺失情况，再决定是否修复
3. **验证修复结果**: 修复后再次运行检查，确保数据已完整
4. **监控日志**: 关注失败的交易对，手动排查问题
5. **配合后台检查器**: 手动检查作为补充，后台检查器作为主要保障

## 示例脚本

### 每日检查和修复脚本

```bash
#!/bin/bash
# daily_kline_check.sh

cd /path/to/future_monitor

echo "开始 K 线数据检查..."
npm run kline:check-all > /tmp/kline_check.log 2>&1

# 检查是否有缺失数据
if grep -q "数据缺失:" /tmp/kline_check.log; then
  echo "发现缺失数据，开始修复..."
  npm run kline:repair-all
  
  echo "修复完成，再次验证..."
  npm run kline:check-all
else
  echo "数据完整，无需修复"
fi
```

### 单个交易对快速检查

```bash
#!/bin/bash
# check_symbol.sh

SYMBOL=$1

if [ -z "$SYMBOL" ]; then
  echo "用法: ./check_symbol.sh BTCUSDT"
  exit 1
fi

node kline_check_all.js --symbol $SYMBOL --repair --verbose
```

## 技术支持

如有问题，请查看：
1. 日志文件
2. Redis 连接状态
3. Binance API 可用性
4. 网络连接状况
