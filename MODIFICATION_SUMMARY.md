# Market State 计算修改总结

## 修改时间
2025-10-22 17:38

---

## 📋 修改内容

### 1. Volume Score 计算方式变更
- **从**: ReLU方式（3倍封顶）
- **到**: 直接比值（无上限）

### 2. 总分计算方式变更
- **从**: 市值加权平均
- **到**: 简单算术平均

### 3. Volume Score 缩放变更
- **从**: 乘以100（0~100范围）
- **到**: 不乘以100（保持原始倍数）

---

## 📊 最终数值范围

| 指标 | 范围 | 含义 | 示例 |
|------|------|------|------|
| **price_score** | -100 ~ 100 | 平均价格变化百分比×100 | `10.0` = 平均上涨0.1% |
| **volume_score** | 0 ~ ∞ | 平均成交量倍数 | `2.3` = 成交量是平均的2.3倍 |
| | 实际 0.5 ~ 5 | 正常市场范围 | `1.0` = 成交量等于平均 |
| | 极端 10+ | 极度活跃市场 | `10.0` = 成交量是平均的10倍 |

---

## 🔧 修改的代码

### 文件：`market_state_calculator.js`

#### 1. scoreVolume() 函数（第63-67行）
```javascript
// 旧代码
function scoreVolume(vol5m, avg5m) {
  const ratio = vol5m / avg5m;
  return Math.min(ratio / 3, 1.0);  // ReLU，3倍封顶
}

// 新代码
function scoreVolume(vol5m, avg5m) {
  const ratio = vol5m / avg5m;
  return ratio;  // 直接返回比值
}
```

#### 2. 移除市值权重计算（第147-178行）
```javascript
// 旧代码（已删除）
let totalMarketCap = 0;
for (const item of selectedSymbols) {
  totalMarketCap += item.marketCap;
}
const weight = totalMarketCap > 0 ? item.marketCap / totalMarketCap : 0;

// 新代码
// 不再计算市值权重，直接计算每个币种得分
```

#### 3. 总分计算改为简单平均（第180-191行）
```javascript
// 旧代码
let total_price = 0;
let total_volume = 0;
for (const r of rows) {
  total_price += r.price_score * r.weight;   // 加权
  total_volume += r.vol_score * r.weight;    // 加权
}
const price_score = total_price * 100;
const volume_score = total_volume * 100;

// 新代码
let total_price = 0;
let total_volume = 0;
for (const r of rows) {
  total_price += r.price_score;   // 直接累加
  total_volume += r.vol_score;    // 直接累加
}
const count = rows.length;
const price_score = count > 0 ? (total_price / count) * 100 : 0;  // 乘以100
const volume_score = count > 0 ? (total_volume / count) : 0;      // 不乘以100
```

---

## 📈 数值对比示例

### 示例数据
3个币种的数据：

| 币种 | 市值 | Price Score | Volume Ratio |
|------|------|-------------|--------------|
| A | 4亿 | 0.5 | 2.4 |
| B | 3亿 | -0.3 | 1.5 |
| C | 1亿 | 0.1 | 3.0 |

### 旧逻辑结果
```
price_score = 15.0    (市值加权)
volume_score = 71.25  (ReLU + 市值加权 + ×100)
```

### 新逻辑结果
```
price_score = 10.0    (简单平均 + ×100)
volume_score = 2.3    (直接比值 + 简单平均)
```

---

## ⚠️ 重要变化

### 1. Volume Score 含义变化
- **旧**: 0~100的得分，需要换算才知道实际倍数
- **新**: 直接就是成交量倍数，更直观

### 2. 权重影响消失
- **旧**: 市值大的币种主导市场状态
- **新**: 每个币种平等对待

### 3. 数值级别变化
- **旧**: volume_score 通常在 20~80 范围
- **新**: volume_score 通常在 0.5~5 范围

---

## 🔄 策略阈值调整建议

如果策略中有基于 volume_score 的判断，需要调整阈值：

```javascript
// 旧阈值 → 新阈值（换算公式：旧值 / 100 × 3）
if (volume_score > 60)  →  if (volume_score > 1.8)
if (volume_score > 80)  →  if (volume_score > 2.4)
if (volume_score > 100) →  if (volume_score > 3.0)
```

---

## 📝 更新的文档

1. ✅ `MARKET_STATE_CALCULATION_UPDATE.md` - 详细修改说明
2. ✅ `MARKET_STATE_AGGREGATOR_README.md` - API文档更新
3. ✅ `MODIFICATION_SUMMARY.md` - 本文档

---

## 🚀 部署验证

### 1. 重启服务
```bash
pm2 restart ws-rule3
```

### 2. 查看日志
```bash
pm2 logs ws-rule3 | grep "市场状态已更新"
```

### 3. 检查数据库
```bash
sqlite3 data.sqlite "SELECT price_score, volume_score FROM market_state_minute ORDER BY ts_minute DESC LIMIT 5;"
```

### 4. 预期结果
- `price_score`: -20 ~ 20 范围（正常市场）
- `volume_score`: 0.5 ~ 5 范围（不再是0~100）

---

## ✅ 修改完成清单

- [x] 修改 `scoreVolume()` 函数
- [x] 移除市值权重计算
- [x] 改为简单平均计算
- [x] volume_score 不乘以100
- [x] 更新相关文档
- [x] 创建修改说明文档

---

## 📞 后续工作

### 需要检查的策略文件
1. `strategies/rule3_default.js`
2. `strategies/rule3_tier_bypass.js`

### 需要调整的内容
- 检查是否有基于 volume_score 的阈值判断
- 如果有，需要将阈值从 0~100 范围调整到 0~5 范围

---

**修改完成** ✅

所有代码修改已完成，文档已更新。请重启服务并验证结果。
