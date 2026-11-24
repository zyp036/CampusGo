# AI 智能规划功能启用指南

本文档说明如何为拾光 CampusGo 项目启用 AI 智能规划功能（基于阿里云百炼 API）。

---

## 一、功能概述

AI 智能规划功能允许用户通过自然语言描述需求（时间、预算、心情、兴趣等），由 AI 生成个性化的校园生活规划。

**核心特性：**
- 使用阿里云百炼（DashScope）OpenAI 兼容协议
- 模型：`qwen4-max`
- 每日限额：每用户 5 次（可配置）
- 并发控制：每用户同时 1 个请求
- 超时降级：30 秒超时后自动降级到规则引擎
- 费用保护：API Key 仅存后端，前端无任何密钥

**降级机制：**
当 AI 不可用（未配置/超时/失败/配额用尽）时，系统自动降级到规则引擎生成规划，用户体验不受影响。

---

## 二、环境配置

### 2.1 配置文件位置

后端环境变量配置文件：`apps/server/.env`

### 2.2 必填配置项

```bash
# AI 功能开关（默认 false，设为 true 启用）
AI_ENABLED=true

# 百炼 API Key（从阿里云控制台获取，格式：sk-ws-xxxxxxxx）
AI_API_KEY=sk-ws-your-actual-key-here

# 以下配置有默认值，通常无需修改
AI_PROVIDER=bailian
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_MODEL=qwen4-max
AI_TIMEOUT_MS=30000
AI_MAX_OUTPUT_TOKENS=1500
AI_DAILY_LIMIT=5
```

### 2.3 配置说明

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `AI_ENABLED` | 否 | `false` | AI 功能总开关 |
| `AI_API_KEY` | 是（启用时） | 空 | 百炼 API Key |
| `AI_PROVIDER` | 否 | `bailian` | AI 提供商（目前仅支持 bailian） |
| `AI_BASE_URL` | 否 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | API 端点 |
| `AI_MODEL` | 否 | `qwen4-max` | 使用的模型 |
| `AI_TIMEOUT_MS` | 否 | `30000` | 请求超时（毫秒），范围 5000-120000 |
| `AI_MAX_OUTPUT_TOKENS` | 否 | `1500` | 单次最大输出 Token，范围 100-8000 |
| `AI_DAILY_LIMIT` | 否 | `5` | 每用户每日调用次数上限 |

---

## 三、启动后端

### 3.1 安装依赖（首次）

```bash
cd apps/server
npm install
```

### 3.2 启动开发服务器

```bash
npm run dev
```

后端将在 `http://localhost:3000` 启动。

### 3.3 验证配置

启动时查看控制台输出，应看到：

```
[CampusGo] AI 服务已启用（provider=bailian, model=qwen4-max）
```

如果未看到此消息，检查：
1. `AI_ENABLED=true` 是否正确设置
2. `AI_API_KEY` 是否填写
3. `.env` 文件是否位于 `apps/server/` 目录下

---

## 四、验证 AI 服务状态

### 4.1 查询服务状态接口

```bash
curl http://localhost:3000/api/ai/status
```

**预期响应（AI 已启用）：**

```json
{
  "success": true,
  "message": "AI 服务状态",
  "data": {
    "enabled": true,
    "provider": "bailian",
    "model": "qwen4-max",
    "configured": true
  }
}
```

**预期响应（AI 未启用）：**

```json
{
  "success": true,
  "message": "AI 服务状态",
  "data": {
    "enabled": false,
    "provider": "bailian",
    "model": "qwen4-max",
    "configured": false
  }
}
```

### 4.2 前端验证

1. 启动前端：`cd apps/web && npm run dev`
2. 访问首页，查看「今日推荐」卡片
3. AI 已启用时显示「AI 智能规划」+ Sparkles 图标
4. AI 未启用时显示「生活规划」+ Compass 图标

---

## 五、真实 API 测试

**重要：** 以下测试会真实调用百炼 API，产生费用。请确认已配置 API Key 并理解费用风险。

### 5.1 准备测试用户

需要先注册一个用户并登录获取会话 Cookie：

```bash
# 注册
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"userCode":"TEST001","nickname":"测试用户","password":"Test123456!"}'

# 登录（保存返回的 Set-Cookie）
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"userCode":"TEST001","password":"Test123456!"}' \
  -c cookies.txt
```

### 5.2 调用 AI 规划接口

```bash
curl -X POST http://localhost:3000/api/ai/plan \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "time": "t-1h",
    "mood": "m-relax",
    "budget": "b-low",
    "interests": ["阅读", "咖啡"],
    "company": "alone"
  }'
```

**预期响应（AI 成功）：**

```json
{
  "success": true,
  "message": "AI 规划生成成功",
  "data": {
    "source": "ai",
    "plan": {
      "title": "...",
      "summary": "...",
      "steps": [...],
      "reasons": [...],
      "tips": [...],
      "suggestions": [...]
    },
    "tokens": {
      "input": 123,
      "output": 456
    },
    "latencyMs": 2500
  }
}
```

**预期响应（AI 失败，降级到规则引擎）：**

```json
{
  "success": true,
  "message": "AI 不可用，已使用规则引擎生成规划",
  "data": {
    "source": "rule",
    "plan": {...},
    "fallback": true,
    "fallbackReason": "AI_QUOTA_EXCEEDED"
  }
}
```

### 5.3 查询配额状态

```bash
curl http://localhost:3000/api/ai/quota \
  -b cookies.txt
```

**预期响应：**

```json
{
  "success": true,
  "message": "AI 配额状态",
  "data": {
    "quota": {
      "dailyLimit": 5,
      "usedToday": 1,
      "remainingToday": 4,
      "hasQuota": true,
      "enabled": true
    },
    "status": {
      "enabled": true,
      "provider": "bailian",
      "model": "qwen4-max",
      "configured": true
    }
  }
}
```

---

## 六、查看 Token 用量

### 6.1 数据库查询

AI 调用日志存储在 `cg_ai_call_log` 表中：

```sql
-- 查看今日调用统计
SELECT 
  user_id,
  COUNT(*) as call_count,
  SUM(input_tokens) as total_input_tokens,
  SUM(output_tokens) as total_output_tokens,
  SUM(total_tokens) as total_tokens
FROM cg_ai_call_log
WHERE DATE(created_at) = CURDATE()
GROUP BY user_id;

-- 查看调用详情
SELECT 
  id,
  user_id,
  status,
  input_tokens,
  output_tokens,
  total_tokens,
  latency_ms,
  error_code,
  created_at
FROM cg_ai_call_log
ORDER BY created_at DESC
LIMIT 20;
```

### 6.2 阿里云控制台查看

1. 登录 [阿里云百炼控制台](https://bailian.console.aliyun.com/)
2. 进入「模型广场」→「我的模型」
3. 查看「调用统计」→「Token 用量」
4. 可按模型、时间范围筛选

---

## 七、费用保护机制

### 7.1 项目侧保护（已实现）

1. **每日限额**：`AI_DAILY_LIMIT=5`（每用户每天最多 5 次调用）
2. **并发控制**：每用户同时只能有 1 个 AI 请求在进行
3. **超时降级**：30 秒超时后自动降级，不会无限等待
4. **输出限制**：`AI_MAX_OUTPUT_TOKENS=1500`，限制单次输出长度
5. **失败快速降级**：API 错误时立即降级，不重试

### 7.2 阿里云侧保护（建议配置）

1. **设置用量上限**：
   - 登录百炼控制台
   - 进入「费用中心」→「资源包管理」
   - 设置「日用量上限」和「月用量上限」
   - 建议：日限 100 次，月限 3000 次（根据实际用户数调整）

2. **开通短信告警**：
   - 在「费用中心」→「费用告警」中配置
   - 设置当费用达到 10 元、50 元、100 元时发送短信

3. **使用资源包**：
   - 百炼提供预付费资源包，比按量付费更便宜
   - 根据预期用量购买合适的资源包

### 7.3 费用估算

以 `qwen4-max` 为例（价格以阿里云官网为准）：

- 输入 Token：0.02 元 / 千 Token
- 输出 Token：0.06 元 / 千 Token

**单次调用估算：**
- 输入：约 500 Token → 0.01 元
- 输出：约 1000 Token → 0.06 元
- 合计：约 0.07 元 / 次

**每日费用估算（100 个活跃用户）：**
- 100 用户 × 5 次/用户 × 0.07 元/次 = 35 元/天
- 月费用：约 1050 元

**建议：** 根据实际用户规模和预算，调整 `AI_DAILY_LIMIT` 或在阿里云控制台设置用量上限。

---

## 八、常见问题

### Q1: AI 接口返回 401 Unauthorized

**原因：** 未登录或会话过期。

**解决：** 先调用 `/api/auth/login` 登录，确保请求携带有效的会话 Cookie。

### Q2: AI 接口返回 503 AI_UNAVAILABLE

**原因：** AI 服务未启用或配置错误。

**解决：**
1. 检查 `AI_ENABLED=true` 是否设置
2. 检查 `AI_API_KEY` 是否填写正确
3. 重启后端服务
4. 查看 `/api/ai/status` 接口返回的 `configured` 字段

### Q3: AI 接口返回 429 AI_QUOTA_EXCEEDED

**原因：** 今日调用次数已达上限。

**解决：** 等待次日重置，或临时调高 `AI_DAILY_LIMIT`（不推荐，会产生更多费用）。

### Q4: 前端显示「规则引擎」而非「AI 智能规划」

**原因：** 前端查询 `/api/ai/status` 发现 AI 未启用。

**解决：** 参考 Q2 检查后端配置。

### Q5: AI 调用超时，自动降级

**原因：** 百炼 API 响应时间超过 30 秒。

**解决：**
1. 检查网络连接
2. 查看百炼服务状态页
3. 如经常超时，可调高 `AI_TIMEOUT_MS`（最大 120000）

---

## 九、安全注意事项

1. **API Key 保密**：
   - 绝不将 `AI_API_KEY` 提交到 Git 仓库
   - 绝不在前端代码中硬编码 API Key
   - `.env` 文件已加入 `.gitignore`

2. **日志脱敏**：
   - 后端日志会自动脱敏 API Key（显示为 `***AI_API_KEY***`）
   - 错误响应不会包含 API Key

3. **访问控制**：
   - POST `/api/ai/plan` 和 GET `/api/ai/quota` 需要登录
   - GET `/api/ai/status` 公开访问（仅返回配置状态，不含敏感信息）

4. **输入验证**：
   - 所有用户输入都经过严格校验
   - 防止注入攻击（用户输入会经过 SHA256 哈希后再发送给 AI）

---

## 十、技术支持

如遇到问题，请检查：

1. 后端启动日志
2. `/api/ai/status` 接口返回
3. 数据库 `cg_ai_call_log` 表记录
4. 阿里云百炼控制台调用统计

**项目代码位置：**
- 后端 AI 服务：`apps/server/src/services/ai/`
- 后端 AI 路由：`apps/server/src/routes/ai.routes.ts`
- 后端 AI 控制器：`apps/server/src/controllers/ai.controller.ts`
- 前端 AI API：`apps/web/src/api/modules/ai.api.ts`
- 前端规划页面：`apps/web/src/views/PlanView.vue`

---

**文档版本：** 1.0  
**最后更新：** 2026-11-24  
**维护者：** 拾光 CampusGo 开发团队
