# Market State 更新 - 快速启动指南

## 修改摘要

✅ **每秒计算并更新到数据库（准实时）**
✅ **动态币种池（市值 < 5亿美元）**
✅ **实时价格 × 流通供应量计算市值排序**
✅ **市值加权（替代固定权重）**
✅ **集成到 ws-rule3 进程（替代独立进程）**

---

## 快速启动步骤

### 1. 测试修改（可选）
```bash
# 运行测试脚本验证逻辑
node test_market_state.js
```

### 2. 停止旧进程
```bash
# 停止并删除旧的 market-state 进程
pm2 stop market-state
pm2 delete market-state
```

### 3. 启动新进程
```bash
# 启动 ws-rule3 进程（包含市场状态计算）
pm2 start ecosystem.config.cjs --only ws-rule3

# 或启动所有进程
pm2 start ecosystem.config.cjs
```

### 4. 查看日志
```bash
# 实时查看日志
pm2 logs ws-rule3

# 查看最近100行
pm2 logs ws-rule3 --lines 100

# 只看错误日志
pm2 logs ws-rule3 --err
```

### 5. 验证运行
```bash
# 查看进程状态
pm2 status

# 查看数据库最新记录
sqlite3 data.sqlite "SELECT datetime(ts_minute/1000, 'unixepoch') as time, price_score, volume_score FROM market_state_minute ORDER BY ts_minute DESC LIMIT 5;"
```

---

## 关键日志信息

**正常启动日志**:
```
更新币种供应量缓存 {"count": 250}
筛选市值<5亿的币种 {"total": 180, "selected": 180}
市场状态已更新到数据库 {"ts_minute": ..., "price_score": "12.34", "volume_score": "45.67", "symbols_count": 180}
```

**预期行为**:
- 启动后5秒开始首次计算
- 每秒计算一次并更新到数据库（日志级别 debug 可见）
- 同一分钟内的计算结果会覆盖更新（UPSERT 机制）
- 查询时始终获取最新的准实时数据

---

## 配置调整（可选）

编辑 `config.json`:

```json
{
  "rule3ws": {
    "marketCapMaxUsd": 500000000,  // 5亿美元上限
    "maxSymbols": 500,              // 最多500个币种
    "logLevel": "info"              // 日志级别
  }
}
```

修改后重启:
```bash
pm2 restart ws-rule3
```

---

## 故障排查

### 问题1: 没有市场状态日志
**检查**:
```bash
pm2 logs ws-rule3 | grep "市场状态"
```
**可能原因**: WS 连接未建立，等待更长时间

### 问题2: 币种数量为0
**检查**:
```bash
sqlite3 data.sqlite "SELECT COUNT(*) FROM supplies WHERE circulating_supply > 0;"
```
**解决**: 运行 `pm2 start ecosystem.config.cjs --only supply-sync-binance`

### 问题3: 权重总和异常
**检查**: 查看 debug 日志
```bash
LOG_LEVEL=debug pm2 restart ws-rule3
pm2 logs ws-rule3 --lines 200
```

---

## 回滚方案

如需回滚到旧版本:

```bash
# 1. 停止新进程
pm2 stop ws-rule3
pm2 delete ws-rule3

# 2. 恢复 ecosystem.config.cjs（取消注释 market-state）
# 3. 启动旧进程
pm2 start ecosystem.config.cjs --only market-state
```

---

## 完成！

系统现在使用新的市场状态计算逻辑：
- ✅ 实时市值排序
- ✅ 动态币种池
- ✅ 市值加权
- ✅ 每秒更新
