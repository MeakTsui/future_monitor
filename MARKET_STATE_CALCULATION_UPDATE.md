# Market State 计算方式更新

## 更新时间
2025-10-22 17:38

---

## 核心变更

### 1. Volume Score 计算方式
**旧逻辑（ReLU方式）**:
```javascript
function scoreVolume(vol5m, avg5m) {
  const ratio = vol5m / avg5m;
  return Math.min(ratio / 3, 1.0);  // 3倍时得满分，范围 0 ~ 1
}
```

**新逻辑（直接比值）**:
```javascript
function scoreVolume(vol5m, avg5m) {
  const ratio = vol5m / avg5m;
  return ratio;  // 直接返回比值，范围 0 ~ ∞
}
```

### 2. 总分计算方式
**旧逻辑（市值加权）**:
```javascript
// 计算市值权重
const weight = marketCap / totalMarketCap;

// 加权求和
total_price += price_score * weight;
total_volume += vol_score * weight;

// 乘以100
const price_score = total_price * 100;
const volume_score = total_volume * 100;
```

**新逻辑（简单平均）**:
```javascript
// 直接累加
total_price += price_score;
total_volume += vol_score;

// 简单平均
const count = rows.length;
const price_score = (total_price / count) * 100;  // 乘以100
const volume_score = (total_volume / count);      // 不乘以100
```

---

## 数值范围变化

### Price Score
| 项目 | 旧逻辑 | 新逻辑 | 变化 |
|------|--------|--------|------|
| 单币种范围 | -1 ~ 1 | -1 ~ 1 | 无变化 |
| 总分范围 | -100 ~ 100 | -100 ~ 100 | 无变化 |
| 计算方式 | 市值加权 | 简单平均 | ✅ 改变 |

### Volume Score
| 项目 | 旧逻辑 | 新逻辑 | 变化 |
|------|--------|--------|------|
| 单币种范围 | 0 ~ 1 | 0 ~ ∞ | ✅ 改变 |
| 总分范围 | 0 ~ 100 | 0 ~ ∞ | ✅ 改变 |
| 实际范围 | 0 ~ 100 | 0.5 ~ 5 | ✅ 改变 |
| 计算方式 | ReLU + 市值加权 | 直接比值 + 简单平均 | ✅ 改变 |
| 缩放 | ×100 | 不×100 | ✅ 改变 |

---

## 实际数值示例

### 示例场景
假设有3个币种：

| 币种 | 市值 | Price Score | Volume Ratio |
|------|------|-------------|--------------|
| A | 4亿 | 0.5 | 2.4 |
| B | 3亿 | -0.3 | 1.5 |
| C | 1亿 | 0.1 | 3.0 |

### 旧逻辑计算
```javascript
// 市值权重
weight_A = 4/8 = 0.5
weight_B = 3/8 = 0.375
weight_C = 1/8 = 0.125

// Volume Score (ReLU)
vol_A = min(2.4/3, 1.0) = 0.8
vol_B = min(1.5/3, 1.0) = 0.5
vol_C = min(3.0/3, 1.0) = 1.0

// 加权求和
price_score = (0.5×0.5 + (-0.3)×0.375 + 0.1×0.125) × 100 = 15.0
volume_score = (0.8×0.5 + 0.5×0.375 + 1.0×0.125) × 100 = 71.25
```

### 新逻辑计算
```javascript
// 简单平均（无权重）
price_score = (0.5 + (-0.3) + 0.1) / 3 × 100 = 10.0
volume_score = (2.4 + 1.5 + 3.0) / 3 = 2.3

// 注意：volume_score 不乘以100
```

---

## 数值含义

### Price Score
- **范围**: -100 ~ 100
- **含义**: 平均价格变化百分比（×100后）
- **示例**: 
  - `10.0` = 平均上涨0.1%
  - `-5.0` = 平均下跌0.05%

### Volume Score
- **范围**: 0 ~ ∞（实际 0.5 ~ 5）
- **含义**: 平均成交量倍数（相对于历史平均）
- **示例**:
  - `1.0` = 成交量等于历史平均
  - `2.3` = 成交量是历史平均的2.3倍
  - `0.5` = 成交量是历史平均的0.5倍

---

## 影响分析

### 1. 权重影响消失
- **旧逻辑**: 市值大的币种主导市场状态
- **新逻辑**: 每个币种平等对待

### 2. Volume Score 更直观
- **旧逻辑**: 需要换算（71.25 / 100 × 3 = 2.14倍）
- **新逻辑**: 直接就是倍数（2.3 = 2.3倍）

### 3. 数值范围变化
- **旧逻辑**: price_score 和 volume_score 都在 -100~100 范围
- **新逻辑**: price_score 在 -100~100，volume_score 在 0~5 范围

### 4. 策略阈值需要调整
```javascript
// 旧逻辑的阈值
if (volume_score > 80) {  // 成交量约2.4倍
  // 激进操作
}

// 新逻辑需要改为
if (volume_score > 2.4) {  // 成交量2.4倍
  // 激进操作
}
```

---

## 修改的文件

### 1. `market_state_calculator.js`
- ✅ 第63-67行：`scoreVolume()` 改为直接返回比值
- ✅ 第147-178行：移除市值权重计算，移除 `weight` 字段
- ✅ 第180-191行：改为简单平均，volume_score 不乘以100

---

## 数据库影响

### `market_state_symbol_minute` 表
- `vol_score` 字段：范围从 0~1 变为 0~∞
- `weight` 字段：不再写入（但字段仍存在）

### `market_state_minute` 表
- `volume_score` 字段：范围从 0~100 变为 0~∞（实际 0.5~5）

---

## 部署步骤

```bash
# 1. 确认修改已应用
git diff market_state_calculator.js

# 2. 重启服务
pm2 restart ws-rule3

# 3. 查看日志验证
pm2 logs ws-rule3 | grep "市场状态已更新"

# 4. 检查数值范围
sqlite3 data.sqlite "SELECT price_score, volume_score FROM market_state_minute ORDER BY ts_minute DESC LIMIT 5;"

# 预期看到：
# price_score: -20 ~ 20 范围
# volume_score: 0.5 ~ 5 范围（不再是0~100）
```

---

## 监控建议

### 关键指标
1. **price_score**: 应在 -100 ~ 100 范围（实际 -20 ~ 20）
2. **volume_score**: 应在 0.5 ~ 5 范围（正常市场）
3. **volume_score**: 如果超过 10，表示市场极度活跃

### 告警阈值调整
如果策略中有基于 volume_score 的判断，需要调整：

```javascript
// 旧阈值 → 新阈值
volume_score > 60  →  volume_score > 1.8
volume_score > 80  →  volume_score > 2.4
volume_score > 100 →  volume_score > 3.0
```

---

## 总结

### ✅ 主要变化
1. Volume Score 从 ReLU 方式改为直接比值
2. 总分计算从市值加权改为简单平均
3. Volume Score 不再乘以100，直接表示成交量倍数

### 📊 数值范围
- **price_score**: -100 ~ 100（无变化）
- **volume_score**: 0 ~ ∞（实际 0.5 ~ 5）

### 🎯 优势
- ✅ Volume Score 更直观（直接就是倍数）
- ✅ 每个币种平等对待（不受市值影响）
- ✅ 计算更简单（无需权重计算）

---

**修改完成** ✅
