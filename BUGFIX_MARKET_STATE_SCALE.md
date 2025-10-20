# Market State 数值缩放问题修复

## 修复时间
2025-10-20 15:32

---

## 问题描述

用户发现新的市场状态聚合器返回的值变得很小（0.01, 0.02），怀疑计算公式有问题。

---

## 根本原因

### 数据源差异

**旧逻辑** 使用 `market_state_minute` 表：
- 该表存储的是**已经加权合并并乘以100**的总体市场状态
- 数值范围：`price_score: -100 ~ 100`, `volume_score: 0 ~ 100`
- 示例值：`price_score: -4.56, volume_score: 3.23`

**新逻辑** 使用 `market_state_symbol_minute` 表：
- 该表存储的是**每个币种的原始得分（未乘以100）**
- 数值范围：`price_score: -1 ~ 1`, `volume_score: 0 ~ 1`
- 示例值：`price_score: -0.056, vol_score: 0.020`

### 计算逻辑

在 `market_state_calculator.js` 中：

```javascript
// 第49-55行：价格得分使用 sigmoid 归一化到 -1 ~ 1
function scorePrice(latest, open5m, k = 100) {
  const x = (latest - open5m) / open5m;
  const score = 2 / (1 + Math.exp(-k * x)) - 1;  // 范围 -1 ~ 1
  return score;
}

// 第63-68行：成交量得分使用 ReLU 归一化到 0 ~ 1
function scoreVolume(vol5m, avg5m) {
  const ratio = vol5m / avg5m;
  return Math.min(ratio / 3, 1.0);  // 范围 0 ~ 1
}

// 第199-200行：存入 market_state_minute 表时乘以100
const price_score = total_price * 100;  // -100 ~ 100
const volume_score = total_volume * 100; // 0 ~ 100
```

### 问题所在

新的聚合器 `market_state_aggregator.js` 直接对 `market_state_symbol_minute` 表中的原始得分（-1~1 范围）进行平均，**忘记乘以100**，导致返回值是 0.01~0.02 这样的小数。

---

## 修复方案

在 `market_state_aggregator.js` 第127-138行，将聚合结果乘以100：

```javascript
const result = {
  ma5: {
    price_score: count5 > 0 ? (totalPriceScore5 / count5) * 100 : 0,  // 乘以100，范围 -100 ~ 100
    volume_score: count5 > 0 ? (totalVolScore5 / count5) * 100 : 0,   // 乘以100，范围 0 ~ 100
    symbols_count: count5
  },
  ma60: {
    price_score: count60 > 0 ? (totalPriceScore60 / count60) * 100 : 0,  // 乘以100，范围 -100 ~ 100
    volume_score: count60 > 0 ? (totalVolScore60 / count60) * 100 : 0,   // 乘以100，范围 0 ~ 100
    symbols_count: count60
  }
};
```

---

## 验证数据

### 数据库实际值

**market_state_symbol_minute 表**（原始得分）:
```sql
SELECT AVG(price_score), AVG(vol_score), COUNT(*) 
FROM market_state_symbol_minute 
WHERE ts_minute = (SELECT MAX(ts_minute) FROM market_state_symbol_minute);

-- 结果: -0.056, 0.020, 417
```

**market_state_minute 表**（已乘以100）:
```sql
SELECT price_score, volume_score 
FROM market_state_minute 
ORDER BY ts_minute DESC LIMIT 5;

-- 结果示例:
-- -4.56, 3.23
-- -5.36, 3.21
-- -1.02, 2.90
```

### 修复后预期值

- **修复前**: `ma5.price_score: -0.056, ma5.volume_score: 0.020`
- **修复后**: `ma5.price_score: -5.6, ma5.volume_score: 2.0`

数值范围与旧逻辑保持一致。

---

## 影响范围

### 受影响的文件
1. `market_state_aggregator.js` - 核心修复
2. `MARKET_STATE_AGGREGATOR_README.md` - 文档更新

### 受影响的策略
1. `strategies/rule3_default.js` - 使用新聚合器
2. `strategies/rule3_tier_bypass.js` - 使用新聚合器

---

## 部署步骤

```bash
# 1. 确认修复已应用
git diff market_state_aggregator.js

# 2. 重启服务
pm2 restart ws-rule3

# 3. 查看日志验证
pm2 logs ws-rule3 | grep "ma5_price"

# 预期看到类似：
# ma5_price: -5.60, ma5_volume: 2.00
```

---

## 总结

### ✅ 问题确认
- 用户观察到的小数值（0.01, 0.02）是由于计算公式缺少 *100 的缩放步骤

### ✅ 根本原因
- 新旧逻辑使用不同的数据表，数值范围不同
- 新逻辑忘记将 -1~1 范围的原始得分缩放到 -100~100

### ✅ 修复方案
- 在聚合结果中乘以100，保持与旧逻辑的数值范围一致

### ✅ 验证方法
- 查看日志中的 `ma5_price` 和 `ma5_volume` 值
- 应该在 -100~100 和 0~100 范围内

---

**修复完成** ✅
