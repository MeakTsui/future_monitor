# Market State 更新 - 部署检查清单

## 修改完成 ✅

所有代码修改已完成，请按以下步骤部署。

---

## 前置条件检查

### 1. Node.js 模块
```bash
# 如果遇到 better-sqlite3 版本问题，需要重新编译
npm rebuild better-sqlite3
```

### 2. 数据库完整性
```bash
# 检查 supplies 表是否有数据
sqlite3 data.sqlite "SELECT COUNT(*) FROM supplies WHERE circulating_supply > 0;"

# 如果返回 0，需要先运行供应量同步
pm2 start ecosystem.config.cjs --only supply-sync-binance
```

### 3. 配置文件
```bash
# 确保 config.json 存在
ls -la config.json

# 如果不存在，从示例复制
cp config.json.example config.json
```

---

## 部署步骤

### Step 1: 备份当前状态
```bash
# 备份数据库
cp data.sqlite data.sqlite.backup.$(date +%Y%m%d_%H%M%S)

# 备份配置
cp config.json config.json.backup.$(date +%Y%m%d_%H%M%S)

# 查看当前运行的进程
pm2 list
```

### Step 2: 停止旧进程
```bash
# 停止独立的 market-state 进程
pm2 stop market-state

# 删除进程配置
pm2 delete market-state

# 确认已停止
pm2 list | grep market-state
```

### Step 3: 启动新进程
```bash
# 启动 ws-rule3 进程（包含市场状态计算）
pm2 start ecosystem.config.cjs --only ws-rule3

# 或启动所有进程
pm2 start ecosystem.config.cjs

# 保存 PM2 配置
pm2 save
```

### Step 4: 验证运行
```bash
# 查看进程状态
pm2 status

# 实时查看日志（等待至少1分钟）
pm2 logs ws-rule3 --lines 50

# 应该看到类似日志：
# "更新币种供应量缓存 {"count": 250}"
# "筛选市值<5亿的币种 {"total": 180, "selected": 180}"
# "市场状态已保存到数据库 {"ts_minute": ..., "price_score": "12.34", "volume_score": "45.67"}"
```

### Step 5: 数据库验证
```bash
# 检查最新的市场状态记录
sqlite3 data.sqlite "
SELECT 
  datetime(ts_minute/1000, 'unixepoch', 'localtime') as time,
  price_score, 
  volume_score,
  state
FROM market_state_minute 
ORDER BY ts_minute DESC 
LIMIT 5;
"

# 检查币种详情
sqlite3 data.sqlite "
SELECT 
  COUNT(*) as symbol_count
FROM market_state_symbol_minute 
WHERE ts_minute = (SELECT MAX(ts_minute) FROM market_state_minute);
"
```

---

## 验证清单

### ✅ 进程状态
- [ ] `ws-rule3` 进程状态为 `online`
- [ ] `market-state` 进程已删除
- [ ] 其他进程正常运行

### ✅ 日志检查
- [ ] 看到 "更新币种供应量缓存" 日志
- [ ] 看到 "筛选市值<5亿的币种" 日志
- [ ] 看到 "市场状态已保存到数据库" 日志（每分钟一次）
- [ ] 无错误日志或异常堆栈

### ✅ 数据库检查
- [ ] `market_state_minute` 表有新记录（每分钟增加一条）
- [ ] `market_state_symbol_minute` 表有详细数据
- [ ] 币种数量在合理范围（100-500）
- [ ] `price_score` 和 `volume_score` 有数值

### ✅ 功能验证
- [ ] 告警功能正常（如果有触发）
- [ ] 前端展示正常（如果有）
- [ ] API 接口正常（如果有）

---

## 监控指标

### 关键日志模式
```bash
# 每分钟应该看到一次
pm2 logs ws-rule3 | grep "市场状态已保存"

# 检查币种数量
pm2 logs ws-rule3 | grep "symbols_count"

# 检查是否有错误
pm2 logs ws-rule3 --err
```

### 数据库增长
```bash
# 每小时应该增加 60 条记录
sqlite3 data.sqlite "
SELECT COUNT(*) 
FROM market_state_minute 
WHERE ts_minute >= strftime('%s', 'now', '-1 hour') * 1000;
"
```

---

## 常见问题

### Q1: 日志中没有 "市场状态已保存" 消息
**原因**: WS 连接未建立或供应量数据缺失
**解决**:
```bash
# 检查 WS 连接
pm2 logs ws-rule3 | grep "WS 已连接"

# 检查供应量数据
sqlite3 data.sqlite "SELECT COUNT(*) FROM supplies WHERE circulating_supply > 0;"

# 如果为 0，运行同步
pm2 start ecosystem.config.cjs --only supply-sync-binance
```

### Q2: 币种数量为 0
**原因**: 供应量数据缺失或价格数据未就绪
**解决**:
```bash
# 等待更长时间（至少2分钟）
# 或查看详细日志
LOG_LEVEL=debug pm2 restart ws-rule3
pm2 logs ws-rule3 --lines 200
```

### Q3: 进程频繁重启
**原因**: 代码异常或内存不足
**解决**:
```bash
# 查看错误日志
pm2 logs ws-rule3 --err --lines 100

# 检查内存使用
pm2 monit
```

---

## 回滚步骤

如果出现严重问题，可以回滚：

```bash
# 1. 停止新进程
pm2 stop ws-rule3
pm2 delete ws-rule3

# 2. 恢复数据库（如果需要）
cp data.sqlite.backup.YYYYMMDD_HHMMSS data.sqlite

# 3. 恢复配置（如果需要）
cp config.json.backup.YYYYMMDD_HHMMSS config.json

# 4. 手动编辑 ecosystem.config.cjs，取消注释 market-state 配置

# 5. 启动旧进程
pm2 start ecosystem.config.cjs --only market-state
pm2 save
```

---

## 性能基准

### 预期指标
- **计算频率**: 1次/秒（日志级别 debug 可见）
- **保存频率**: 1次/分钟（日志级别 info 可见）
- **单次耗时**: < 100ms
- **币种数量**: 100-500 个
- **内存占用**: +5-10MB

### 异常阈值
- 计算耗时 > 500ms → 需要优化
- 币种数量 > 500 → 触发限制
- 内存增长 > 50MB/小时 → 可能有内存泄漏

---

## 成功标准

部署成功的标志：
1. ✅ `ws-rule3` 进程稳定运行 > 1小时
2. ✅ 每分钟有新的数据库记录
3. ✅ 日志无错误信息
4. ✅ 币种数量在合理范围
5. ✅ 告警功能正常（如果有触发）

---

## 后续工作

部署成功后：
1. 观察运行24小时
2. 收集性能数据
3. 对比新旧算法的告警质量
4. 根据反馈调整参数
5. 更新前端展示（如果需要）

---

## 联系与支持

- **日志位置**: `~/.pm2/logs/`
- **数据库位置**: `./data.sqlite`
- **配置文件**: `./config.json`

**部署完成后，请在此打勾** ✅

---

**祝部署顺利！** 🚀
