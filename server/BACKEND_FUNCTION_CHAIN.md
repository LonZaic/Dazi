# DZ 后端函数调用链全图谱

> 本文档完整梳理 `e:\DZ\server\src` 后端每一个文件的函数调用链、数据流、接口流向。
> 顺着看不会断，逻辑清晰，一看就懂。
>
> 风格约定：`函数名()` → 用树状图逐层展开，标注【谁调它】【它干啥】【它调谁】。

---

# 目录

- [第一部分：全景架构图](#第一部分全景架构图)
- [第二部分：项目目录结构](#第二部分项目目录结构)
- [第三部分：核心数据流（情景化）](#第三部分核心数据流情景化)
- [第四部分：各模块函数调用链](#第四部分各模块函数调用链)
  - [4.1 入口层 index.ts](#41-入口层-indexts)
  - [4.2 配置层 config/index.ts](#42-配置层-configindexts)
  - [4.3 路由层 routes/*](#43-路由层-routes)
  - [4.4 中间件层 middleware/auth.ts](#44-中间件层-middlewareauthts)
  - [4.5 服务层 services/*](#45-服务层-services)
  - [4.6 Agent 层 agents/*](#46-agent-层-agents)
  - [4.7 核心层 core/*](#47-核心层-core)
  - [4.8 数据层 db/*](#48-数据层-db)
  - [4.9 记忆层 memory/*](#49-记忆层-memory)
  - [4.10 Redis 层](#410-redis-层)
  - [4.11 压缩层 compress/*](#411-压缩层-compress)
  - [4.12 缓存层 cache/*](#412-缓存层-cache)
  - [4.13 MBTI 层](#413-mbti-层)
  - [4.14 集成层 integrations/*](#414-集成层-integrations)
  - [4.15 脚本层 scripts/*](#415-脚本层-scripts)
- [第五部分：API 接口数据流](#第五部分api-接口数据流)
- [第六部分：完整文件清单](#第六部分完整文件清单)

---

# 第一部分：全景架构图

```
                            ┌─────────────────────────────────────────────┐
                            │              前端 (5173 端口)                  │
                            │   React + SSE 长连接 + fetch 带 cookie       │
                            └───────────────────┬─────────────────────────┘
                                                │ HTTP / SSE
                                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Express 服务 (8787 端口) — index.ts                  │
│  中间件链：CORS → JSON → CookieParser → 安全头 → 路由 → 404 → 全局错误        │
└────────────────────────────────────┬─────────────────────────────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  routes/auth    │         │  routes/chat    │         │  routes/match   │
│  注册/登录/me   │         │  消息/SSE/会话  │         │  匹配/破冰/历史  │
└────────┬────────┘         └────────┬────────┘         └────────┬────────┘
         │                           │                           │
         ▼                           ▼                           ▼
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  routes/profile │         │  routes/dm      │         │  routes/privacy │
│  画像/历史/隐私 │         │  私信/SSE 长轮  │         │  导出/删账号    │
└────────┬────────┘         └────────┬────────┘         └────────┬────────┘
         │                           │                           │
         ▼                           ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          中间件层 middleware/auth.ts                          │
│   requireAuth / optionalAuth —— 从 cookie 取 JWT → 注入 req.user              │
└────────────────────────────────────┬─────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Agent 层（三大智能体）                                │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐                │
│   │ ProfileAgent │───▶│  MatchAgent  │───▶│ IceBreakerAgent  │                │
│   │ 抽画像+流式聊│    │ 向量召回+6维 │    │ 生成 3 条破冰话术│                │
│   └──────┬───────┘    └──────┬───────┘    └─────────┬────────┘                │
│          │                   │                      │                         │
│          └───────────────────┴──────────────────────┘                         │
│                              │                                                │
│                       通过 Blackboard 解耦通信                                 │
│                       通过 BaseAgent 模板方法复用                              │
└────────────────────────────────────┬─────────────────────────────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  services/      │         │  core/          │         │  integrations/  │
│  llmClient      │         │  orchestrator   │         │  agentMemory    │
│  embedding      │         │  blackboard     │         │  cacheLlm        │
│  auth           │         │  tokenBudget    │         │  lifecycle       │
│  rateLimiter    │         │  antiloop       │         │  matchAgentMbti  │
│  aiBotReplier   │         │  structuredOut  │         │  mbtiProfile     │
│  traceLogger    │         │  tracer         │         └─────────────────┘
└────────┬────────┘         └────────┬────────┘
         │                           │
         ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          四大增强模块（DZ 新增）                                │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│   │  memory/   │  │  redis/    │  │  compress/ │  │   cache/   │             │
│   │ 4 层记忆   │  │ 持久化     │  │ 上下文压缩 │  │ prefix 缓存│             │
│   └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘             │
│         │               │               │               │                    │
│         └───────────────┴───────────────┴───────────────┘                    │
│                         │                                                    │
│                         ▼                                                    │
│              ┌────────────────────┐                                          │
│              │   mbti/ 5 文件    │ ← MBTI 兼容度（第 6 维匹配因子）          │
│              └────────────────────┘                                          │
└────────────────────────────────────┬─────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          数据层 db/*                                           │
│   SQLite (WAL 模式) + 向量存储 + 余弦相似度                                    │
│   表：tenants / users / profiles / profile_patches / conversations /          │
│       matches / dm_rooms / dm_messages / rate_counters / tenants              │
└────────────────────────────────────────────────────────────────────────────────┘
```

**核心设计原则**：
1. **多 Agent + Blackboard** — 三 Agent 不互调，靠黑板贴便条解耦
2. **状态机编排** — SessionState 6 态：CHATTING→PROFILE_READY→MATCHING→MATCHED→ICEBREAKING→DONE
3. **双模式降级** — LLM 优先，无 Key/出错自动降级到规则模式（永远可用）
4. **四层记忆** — 短期/长期画像/匹配决策/交互，MemoryBus 统一总线 + 权限矩阵
5. **Token 预算** — 20 万阈值，75% 软提醒、90% 硬停
6. **隐私保护** — 传给 LLM 只传标签（兴趣/风格），不传对话原文

---

# 第二部分：项目目录结构

```
e:\DZ\server\
├── .env / .env.example          # 环境变量（LLM_API_KEY / REDIS_URL / DB_PATH）
├── package.json                 # 依赖：express / bcrypt / jsonwebtoken / better-sqlite3 / dotenv
├── tsconfig.json                # TS 配置（ESM + Node Next）
├── data/matchmate.db            # SQLite 数据库文件（WAL 模式）
├── logs/trace-*.ndjson          # traceLogger 写的追踪日志
├── reports/                     # 测试报告 HTML/PDF
├── scripts-test/                # 手工测试脚本（SSE/查询 bot）
├── websocket/                   # 独立 WebSocket 服务（私信用）
└── src/                         # ← 后端源码（本文档主角）
    ├── index.ts                 # ★ 启动文件（建 app、挂路由、监听端口）
    │
    ├── config/
    │   └── index.ts             # ★ 全局配置中心（从 .env 读，带默认值）
    │
    ├── middleware/
    │   └── auth.ts              # ★ requireAuth / optionalAuth（JWT 解 cookie）
    │
    ├── routes/                  # HTTP 路由层（8 个路由文件）
    │   ├── auth.ts              #   注册/登录/登出/me
    │   ├── chat.ts              #   消息/SSE 流式/会话管理 ★链路最热
    │   ├── match.ts             #   匹配/破冰/历史
    │   ├── profile.ts           #   画像查询/历史/隐私设置
    │   ├── dm.ts                #   私信房间/消息/SSE 长轮
    │   ├── privacy.ts           #   数据导出/删账号（合规）
    │   ├── health.ts            #   /health /info /stats 探活
    │   └── test.ts              #   AI 派发测试/追踪日志/报告
    │
    ├── agents/                  # Agent 层（智能体）
    │   ├── baseAgent.ts        #   ★ 抽象基类（模板方法 run + execute）
    │   ├── profileAgent.ts     #   ★ 画像 Agent（流式回复 + 异步抽画像）
    │   ├── matchAgent.ts       #   ★ 匹配 Agent（向量召回 + 6 维排序）
    │   ├── iceBreakerAgent.ts  #   ★ 破冰 Agent（生成 3 条开场白）
    │   └── profileSchema.ts    #   ★ 画像数据契约（applyPatch/computeConfidence）
    │
    ├── core/                   # 核心架构层
    │   ├── blackboard.ts       #   ★ 共享黑板（Agent 间解耦通信）
    │   ├── orchestrator.ts     #   ★ 编排器（状态机 + getSession）
    │   ├── tokenBudget.ts      #   ★ Token 预算（75% 提醒、90% 硬停）
    │   ├── antiloop.ts         #   ★ 反循环器（防 Agent 卡死循环）
    │   ├── structuredOutput.ts #   ★ JSON 三层修复（quickFix/extract/validate）
    │   └── tracer.ts           #   ★ 链路追踪器（飞机黑匣子）
    │
    ├── services/               # 服务层（外部调用封装）
    │   ├── llmClient.ts        #   ★ DeepSeek 客户端（chatStream/chatOnce）
    │   ├── embedding.ts        #   ★ 向量嵌入（API/本地双模式）
    │   ├── auth.ts             #   ★ 鉴权服务（bcrypt + JWT）
    │   ├── rateLimiter.ts      #   ★ 滑动窗口限流
    │   ├── aiBotReplier.ts     #   ★ AI Bot 人格回复（4 个 bot）
    │   └── traceLogger.ts      #   ★ ndjson 追踪日志写盘
    │
    ├── db/                     # 数据层
    │   ├── index.ts            #   ★ SQLite 连接（WAL 模式）
    │   ├── schema.ts           #   ★ 建表 SQL（含多租户/级联删除）
    │   └── vectorStore.ts      #   ★ 向量存储 + 余弦相似度召回
    │
    ├── memory/                 # 【DZ 新增】四层记忆
    │   ├── memoryBus.ts        #   ★ 统一总线（路由 + 权限矩阵）
    │   ├── memoryTypes.ts      #   类型 + 权限矩阵定义
    │   ├── shortTermMemory.ts  #   Layer 1：短期会话（滑动窗口）
    │   ├── longTermProfileMemory.ts  # Layer 2：长期画像（tags + vector）
    │   ├── matchDecisionMemory.ts    # Layer 3：匹配决策（去重 + 反馈）
    │   ├── interactionMemory.ts      # Layer 4：破冰交互（话题去重）
    │   └── index.ts            #   统一导出
    │
    ├── redis/                  # 【DZ 新增】Redis 持久化
    │   ├── redisClient.ts      #   ★ 可选单例（懒加载 + 失败降级）
    │   ├── stateStore.ts       #   ★ MemoryBus/Blackboard/Session 持久化
    │   └── index.ts            #   统一导出
    │
    ├── compress/               # 【DZ 新增】上下文压缩
    │   ├── autoCompact.ts      #   ★ 重型压缩（前 N 条摘要成 1 条）
    │   ├── microCompact.ts     #   轻型压缩（缩短旧 AI 回复）
    │   ├── boundary.ts         #   摘要边界消息（带标记）
    │   ├── summaryGenerator.ts #   调 LLM 生成摘要
    │   ├── compressTypes.ts    #   类型 + 配置
    │   └── index.ts            #   统一入口 compactLogIfNeeded
    │
    ├── cache/                  # 【DZ 新增】prefix 缓存（Reasonix 风格）
    │   ├── cacheClient.ts      #   ★ cache-first 流式客户端
    │   ├── appendLog.ts        #   append-only 日志类
    │   ├── prefixHash.ts       #   前缀指纹（自检稳定）
    │   ├── cacheStats.ts       #   命中 token 统计
    │   ├── cacheTypes.ts       #   类型 + CACHE_CONFIG
    │   └── index.ts            #   统一导出
    │
    ├── mbti/                   # 【DZ 新增】MBTI 模块（第 6 维匹配）
    │   ├── mbtiEngine.ts      #   ★ 引擎（4 维合成 + 功能栈派生）
    │   ├── mbtiExtractor.ts   #   从对话抽 4 维信号
    │   ├── mbtiCompat.ts      #   16 型两两兼容度评分
    │   ├── mbtiTypes.ts        #   类型 + MBTI_TYPE_STACKS 查表
    │   └── index.ts            #   统一导出
    │
    ├── integrations/           # 【DZ 新增】集成适配器
    │   ├── agentMemoryAdapter.ts     # ★ 3 Agent ↔ MemoryBus 桥
    │   ├── cacheLlmAdapter.ts        # ★ cache-first LLM 调用封装
    │   ├── matchAgentMbtiAdapter.ts  # ★ MatchAgent 调 MBTI 因子
    │   ├── mbtiProfileAdapter.ts     # ★ 抽 MBTI 信号 → 更新画像
    │   ├── lifecycleAdapter.ts       # ★ 启动 init / 关闭 shutdown
    │   └── index.ts                  #   统一导出
    │
    └── scripts/                # 运维脚本
        ├── seed.ts             #   种子数据（100 个假用户）
        ├── initBots.ts         #   初始化 4 个 AI bot
        ├── aiDispatchTest.ts   #   AI 派发测试（多用户模拟）
        └── generatePdfReport.ts #  HTML → PDF 转换
```

★ = 核心文件，链路必经

---

# 第三部分：核心数据流（情景化）

## 3.1 主热链路：用户发一条消息的完整数据流

```
用户在聊天框发"我最近开始跑步了"
     │
     ▼
【chat.ts】POST /api/chat/messages
     │
     ├── ① requireAuth(req) ──────────────────────────────────────────
     │   从 Cookie 取 token → jwt.verify() 解密
     │   → 把 userId/tenantId 写进 req.user
     │   → token 过期/伪造 → 401
     │   （位置：middleware/auth.ts → services/auth.ts）
     │
     ├── ② consumeRateLimit(userId) ──────────────────────────────────
     │   查 rate_counters 表，过去 1 小时发了几条
     │   超 30 条 → 429（太多请求）
     │   没超 → 记录这条时间戳
     │   （位置：services/rateLimiter.ts → db rate_counters）
     │
     ├── ③ INSERT INTO conversations ─────────────────────────────────
     │   存"我最近开始跑步了"：role='user', session_id='xxx'
     │   （位置：routes/chat.ts 内联 SQL）
     │
     ├── ④ SELECT 最近 20 条对话 ──────────────────────────────────────
     │   作为上下文喂给 AI（20 是 token/记忆的平衡点）
     │
     ├── ⑤ getSession(userId, tenantId) ──────────────────────────────
     │   没会话就建：state='CHATTING' + blackboard + budget + loopDetector
     │   （位置：core/orchestrator.ts）
     │
     ├── ⑥ profileAgent.streamReply(...) ───────── 同步流式回复 ──────
     │   │  【位置】agents/profileAgent.ts
     │   │
     │   ├── llmEnabled? ─── 判断 LLM_API_KEY 有没有配
     │   │   │
     │   │   ├── 有 Key → streamReplyLLM() ──────────────────────────
     │   │   │   │
     │   │   │   ├── profileToText(profile) ──── 画像转文字
     │   │   │   │   {interests:[{name:'跑步'}], socialStyle:{energy:'introvert'}}
     │   │   │   │   → "兴趣: 跑步  社交风格: introvert"
     │   │   │   │   （位置：agents/profileSchema.ts）
     │   │   │   │
     │   │   │   ├── 拼 system prompt ──── 人设 + 对话原则
     │   │   │   │
     │   │   │   └── 【sessionId?】
     │   │   │       ├── 有 → chatWithCache()  ★ cache 主路径（省钱）
     │   │   │       │   │  【位置】integrations/cacheLlmAdapter.ts
     │   │   │       │   │
     │   │   │       │   ├── getOrCreateConversation(userId, sessionId)
     │   │   │       │   │   → 从 Redis 拉 CachedConversation，没有就建
     │   │   │       │   │
     │   │   │       │   ├── appendUserMessage(conv, lastUserMsg)
     │   │   │       │   │
     │   │   │       │   ├── compactLogIfNeeded(conv.prefix, conv.log)
     │   │   │       │   │   │  【位置】compress/index.ts
     │   │   │       │   │   ├── shouldMicroCompact? → microCompactLog()
     │   │   │       │   │   │   缩短旧 AI 回复（prefix 不变）
     │   │   │       │   │   └── shouldAutoCompact? → autoCompactLog()
     │   │   │       │   │       调 generateSummary() 摘要前 N 条
     │   │   │       │   │       prefix 加 Summary 边界消息
     │   │   │       │   │
     │   │   │       │   ├── chatStreamCached(conv, cb, opts)
     │   │   │       │   │   │  【位置】cache/cacheClient.ts
     │   │   │       │   │   ├── verifyPrefixStable() 自检 hash
     │   │   │       │   │   ├── 拼 messages = prefix + log + scratch
     │   │   │       │   │   ├── POST DeepSeek /chat/completions (stream:true)
     │   │   │       │   │   ├── SSE 解析：delta.content → onDelta
     │   │   │       │   │   │                delta.reasoning_content → onReasoning
     │   │   │       │   │   │                usage.prompt_cache_hit_tokens → 统计
     │   │   │       │   │   ├── AI 回复 append 到 conv.log（append-only）
     │   │   │       │   │   ├── scratch 清空
     │   │   │       │   │   └── 返回 { text, reasoning, usage: CacheUsagePayload }
     │   │   │       │   │
     │   │   │       │   ├── saveCachedConversation() → Redis 持久化
     │   │   │       │   │
     │   │   │       │   ├── ★ profileAdapter.onMessage(user/assistant)
     │   │   │       │   │   → globalMemoryBus.appendShortTerm()  写 Layer 1
     │   │   │       │   │
     │   │   │       │   └── 返回 { text, reasoning }
     │   │   │       │
     │   │   │       └── 没 sessionId → chatStream()  降级路径（无缓存）
     │   │   │           │  【位置】services/llmClient.ts
     │   │   │           ├── POST DeepSeek，stream:true
     │   │   │           ├── SSE 解析（buf 处理跨块）
     │   │   │           └── 返回 { text, reasoning, usage: LLMUsage }
     │   │   │
     │   │   │   → chat.ts 把 text 通过 SSE 推给前端
     │   │   │   → reasoning 推到前端"思考框"
     │   │   │
     │   │   └── 没 Key → templateReply(profile)
     │   │       按画像阶段选模板：
     │   │       - 空 → "嗨，先随便聊聊～你周末怎么过？"
     │   │       - 1 个兴趣 → "听起来你对跑步挺感兴趣..."
     │   │       - 画像完整 → "我觉得可以帮你找搭子了"
     │   │       逐字符调 onDelta，每字停 8ms 模拟打字
     │   │
     │   └── 返回 { text, reasoning } 给 chat.ts
     │
     ├── ⑦ INSERT conversations (assistant 回复) ─────────────────────
     │   把 AI 回的"听起来挺棒！晨跑还是夜跑？"存进 DB
     │
     ├── ⑧ profileAgent.run(...) ───────────── 异步后台抽画像 ────────
     │   │  ★ 不阻塞用户看回复，后台跑
     │   │  【位置】agents/profileAgent.ts → execute()
     │   │
     │   ├── extractProfile(messages, ctx)
     │   │   ├── llmEnabled → extractViaLLM()
     │   │   │   ├── 拼 system prompt（"输出严格 JSON"）
     │   │   │   ├── chatOnce([sys, user], {maxTokens:2048, temperature:0.2})
     │   │   │   │   【位置】services/llmClient.ts → 非流式
     │   │   │   ├── budget.recordApiUsage(input, output)
     │   │   │   ├── quickFixJSON(text)  ── 修尾逗号/markdown 包裹
     │   │   │   ├── extractJSON(raw)    ── 抠 JSON
     │   │   │   ├── validateJSON(parsed, PATCH_SCHEMA) ── schema 校验
     │   │   │   └── 失败重试 1 次，再失败抛错降级
     │   │   └── LLM 失败/无 Key → extractViaKeywords()
     │   │       纯关键词匹配（免费但傻）
     │   │
     │   ├── loadProfile(userId) ── 从 DB profiles 表读旧画像
     │   ├── applyPatch(current, patch) ── 增量合并
     │   │   【位置】agents/profileSchema.ts
     │   │   - 同兴趣合并（confidence 取 max，evidence 拼接去重）
     │   │   - 字段非空覆盖
     │   │   - computeConfidence(next) ── 重算置信度
     │   │
     │   ├── persistProfile(userId, next) ── 存回 profiles 表
     │   ├── persistPatch(userId, patch) ── 存变更到 profile_patches（审计）
     │   │
     │   ├── 画像变化 → embed(profileToText(next))
     │   │   【位置】services/embedding.ts
     │   │   ├── API 模式：embedViaApi() 1536 维（高质量）
     │   │   └── 本地模式：embedLocal() 256 维（bigram + 哈希 + L2 归一化）
     │   ├── updateProfileEmbedding(userId, vec) ── 存 profiles.embedding
     │   │
     │   ├── blackboard.write('latest_profile', next, 'profile_patch')
     │   ├── blackboard.write('latest_patch', patch, 'profile_patch')
     │   │
     │   ├── ★ profileAdapter.onProfileExtracted(userId, patch)
     │   │   → globalMemoryBus.updateLongTermProfile()
     │   │     写 Layer 2 长期画像记忆
     │   │
     │   └── 返回 { profile, patch, confidence, profileText }
     │
     ├── ⑨ transition(ctx, { type:'profile_updated', confidence }) ──
     │   │  【位置】core/orchestrator.ts
     │   │  switch(signal.type)
     │   │   case 'profile_updated':
     │   │     if (state==='CHATTING' && confidence>=0.65)
     │   │       state = 'PROFILE_READY'  ← 按钮亮起
     │   │     else 保持 CHATTING
     │   │
     │   └── blackboard.write('orchestrator', 'state_transition', ...)
     │
     └── ⑩ SSE event 'done' → res.end() ── 前端结束打字动画
```

## 3.2 匹配链路：用户点"开始匹配"

```
用户点"开始匹配"（前端发 POST /api/match/run）
     │
     ▼
【match.ts】POST /api/match/run
     │
     ├── requireAuth → getSession
     ├── loadProfile(userId) ── 没画像/没兴趣 → 400 "先去聊几句"
     ├── transition(ctx, { type:'match_requested' })
     │   CHATTING/PROFILE_READY → MATCHING（loading 转圈）
     │
     ├── matchAgent.run({ limit: 5 }, ctx)
     │   │  【位置】agents/matchAgent.ts → execute()
     │   │
     │   ├── ① loadProfile(userId) ── 我自己的画像
     │   ├── ② profileToText(profile) ── 转文字
     │   ├── ③ embed(text) ── 1536 维向量
     │   │
     │   ├── ④ recallByVector(myVec, tenantId, excludeUserId, topK=20)
     │   │   │  【位置】db/vectorStore.ts
     │   │   ├── SELECT * FROM profiles WHERE embedding IS NOT NULL
     │   │   ├── 对每行 cosine(myVec, row.embedding)
     │   │   └── sort + slice(0, 20) → 20 个候选
     │   │
     │   ├── ⑤ ★ matchAdapter.getExcludedCandidates(userId)
     │   │   → globalMemoryBus.getRecentCandidates()  ← Layer 3 去重
     │   │   拿到过去推荐过的人，避免重复推
     │   │
     │   ├── ⑥ 对每个候选算 6 维因子：
     │   │   │  computeFactors(my, theirs, vectorScore, mbtiScore)
     │   │   │
     │   │   ├── computeMbtiFactor(myUserId, theirUserId)
     │   │   │   │  【位置】integrations/matchAgentMbtiAdapter.ts
     │   │   │   ├── getMbtiProfile(my) / getMbtiProfile(their)
     │   │   │   │   从 mbtiProfileAdapter 拿（stateStore 持久化）
     │   │   │   └── scoreCompat(mine, theirs)  ← mbti/mbtiCompat.ts
     │   │   │       查 MBTI_COMPAT_TABLE → 0-1 分 + reason + detail
     │   │   │
     │   │   ├── interestOverlap ── Jaccard：共同兴趣/较小集合
     │   │   ├── styleMatch ── energy/depth 匹配
     │   │   ├── scheduleOverlap ── 时段重合
     │   │   ├── goalComplement ── 目标词重叠
     │   │   └── vector ── 直接取余弦相似度
     │   │
     │   ├── ⑦ weightedScore(factors)
     │   │   = 0.35*vector + 0.20*interest + 0.15*style
     │   │   + 0.10*schedule + 0.05*goal + 0.15*mbti
     │   │
     │   ├── ⑧ candidates.sort((a,b)=>b.score-a.score)
     │   ├── ⑨ candidates.slice(0, 5)
     │   │
     │   ├── ⑩ blackboard.write('latest_matches', top, 'match_result')
     │   ├── ⑪ persistMatches(tenantId, userId, top)
     │   │   INSERT INTO matches (..., state='suggested')
     │   │
     │   ├── ⑫ ★ matchAdapter.recordMatch(userId, candidateId, ...)
     │   │   → globalMemoryBus.writeMatchDecision()
     │   │     写 Layer 3 匹配决策记忆（下次去重用）
     │   │
     │   └── 返回 { candidates, totalCount, myProfileText }
     │
     ├── transition(ctx, { type:'match_done' })
     │   MATCHING → MATCHED
     │
     └── res.json({ candidates: [...toPublicCandidate], state })
         → 前端展示 5 个候选卡片
```

## 3.3 破冰链路：用户点"生成破冰话术"

```
用户在某候选卡片点"生成破冰话术"
     │
     ▼
【match.ts】POST /api/match/icebreaker
     │  body: { targetUserId: '小李' }
     │
     ├── requireAuth → getSession
     ├── 校验 targetUserId 有效、不是自己
     ├── loadProfile(my) / loadProfile(target)
     ├── 算共同兴趣 commonInterests
     ├── transition(ctx, { type:'icebreak_requested' })
     │   MATCHED → ICEBREAKING（loading）
     │
     ├── iceBreakerAgent.run(input, ctx)
     │   │  【位置】agents/iceBreakerAgent.ts → execute()
     │   │
     │   ├── if (llmEnabled) → generateLLM(input)
     │   │   │
     │   │   ├── 拼 system prompt："3 条不同风格开场白，JSON 数组"
     │   │   ├── 拼 user prompt：只传标签！
     │   │   │   "我的兴趣：跑步、游戏
     │   │   │    对方兴趣：跑步、爬山
     │   │   │    共同兴趣：跑步
     │   │   │    对方社交风格：introvert/deep
     │   │   │    匹配度：77%"
     │   │   │   ✗ 不传对话原文（隐私！）
     │   │   │
     │   │   ├── chatOnce([sys, user], { maxTokens:256, temperature:0.8 })
     │   │   ├── quickFixJSON(text) + extractJSON(raw)
     │   │   ├── 校验是 string[] && length>0
     │   │   ├── slice(0, 3) + 每条 slice(0, 60)
     │   │   └── 失败 → 抛错降级
     │   │
     │   ├── 降级 → generateTemplate(input)
     │   │   ① 共同兴趣：common[0] → "看到你也喜欢跑步..."
     │   │   ② 轻松幽默（按对方 energy 调）：
     │   │      introvert → "两个 i 人的默契..."
     │   │      extrovert → "找到组织了！"
     │   │   ③ 真诚直接：用 goal → "我也在找这样的搭子"
     │   │
     │   ├── persistIcebreakers(tenantId, userA, userB, out)
     │   │   UPDATE matches SET icebreakers_json=?, state='icebroken'
     │   │
     │   ├── ★ iceBreakerAdapter.recordInteraction(...)
     │   │   → globalMemoryBus.writeInteraction()
     │   │     写 Layer 4 交互记忆（话题去重）
     │   │
     │   └── 返回 { icebreakers: string[3], source: 'llm' | 'template' }
     │
     ├── transition(ctx, { type:'icebreak_done' })
     │   ICEBREAKING → DONE
     │
     └── res.json({ icebreakers, source })
         → 前端展示 3 条话术，复制去私信
```

## 3.4 启动/关闭链路：进程生命周期

```
npm run dev 启动
     │
     ▼
【index.ts】
     │
     ├── initSchema()  ── 建表（IF NOT EXISTS 幂等）
     ├── getDB().prepare('SELECT 1').get()  ── 热身连接
     │
     ├── ★ initEnhancedSystem()  ── 异步不阻塞
     │   │  【位置】integrations/lifecycleAdapter.ts
     │   │
     │   ├── if (_initialized) return  ── 防重复
     │   ├── _initialized = true
     │   │
     │   ├── await globalRedisClient.connect()
     │   │   │  【位置】redis/redisClient.ts
     │   │   ├── 没配 REDIS_URL → 直接返回（降级内存模式）
     │   │   ├── 动态 import('redis')
     │   │   ├── createClient({ url }).connect()
     │   │   ├── 连上 → isAvailable=true
     │   │   └── 失败 → isAvailable=false（不抛错，降级）
     │   │
     │   ├── if (redisClient.isAvailable)
     │   │   ├── restoreMemoryFromRedis()
     │   │   │   │  【位置】redis/stateStore.ts
     │   │   │   ├── getJSON('memory:all')
     │   │   │   └── globalMemoryBus.restoreAll(data.memory)
     │   │   │       → 4 层记忆全恢复
     │   │   │
     │   │   └── startPeriodicSave(60)  ── 每 60 秒存一次
     │   │       setInterval(() => saveMemoryToRedis(), 60000)
     │   │
     │   └── process.on('SIGTERM', () => gracefulShutdown())
     │       process.on('SIGINT', ...)
     │
     ├── app = express()
     ├── 挂中间件（CORS / JSON / Cookie / 安全头）
     ├── 挂路由（8 个 Router）
     ├── app.listen(8787)
     └── console.log('MatchMate 服务已启动')


进程收到 Ctrl+C / kill
     │
     ▼
shutdown(sig)
     ├── server.close()  ── 等现有请求处理完
     ├── ★ gracefulShutdown()
     │   │  【位置】integrations/lifecycleAdapter.ts
     │   ├── stopPeriodicSave()  ── clearInterval
     │   ├── await saveMemoryToRedis()  ── 存最后一次状态
     │   └── await globalRedisClient.disconnect()
     │
     ├── closeDB()
     └── process.exit(0)
```

---

# 第四部分：各模块函数调用链

## 4.1 入口层 index.ts

```
index.ts — Express 应用启动
   │
   │  被谁调：npm run dev（package.json 的 main）
   │  干什么：建 app → 挂中间件 → 挂路由 → 监听 8787
   │
   ├── 模块级执行（import 即跑）：
   │   ├── initSchema()              ← db/schema.ts 建表
   │   ├── getDB().prepare('SELECT 1').get()  ← 热身
   │   └── initEnhancedSystem().catch(...)    ← 异步启 Redis + 恢复记忆
   │
   ├── const app = express()
   │
   ├── app.use(cors({ origin, credentials, methods }))   ← 跨域
   ├── app.use(express.json({ limit:'256kb' }))          ← JSON 解析
   ├── app.use(express.urlencoded({ extended:false }))   ← 表单解析
   ├── app.use(cookieParser())                            ← Cookie 解析
   ├── app.use(安全头：nosniff/DENY/Referrer/XSS)          ← 轻量 helmet
   │
   ├── app.use('/api', healthRouter)         ← /api/health /info /stats
   ├── app.use('/api/auth', authRouter)      ← /api/auth/register /login /me
   ├── app.use('/api/chat', chatRouter)      ← /api/chat/messages /sessions
   ├── app.use('/api/profile', profileRouter)← /api/profile /history
   ├── app.use('/api/match', matchRouter)    ← /api/match/run /icebreaker /history
   ├── app.use('/api/privacy', privacyRouter)← /api/privacy/export /account
   ├── app.use('/api/dm', dmRouter)          ← /api/dm/rooms /:id/messages /:id/stream
   ├── app.use('/api/test', testRouter)      ← /api/test/run /trace /report
   │
   ├── app.use(404 handler)                  ← 未匹配路由返 404
   ├── app.use(全局错误处理)                  ← 任何路由抛错 → 500
   │
   ├── const server = app.listen(PORT)
   │
   ├── function shutdown(sig)
   │   ├── server.close()
   │   ├── closeDB()
   │   └── process.exit(0)
   │
   ├── process.on('SIGINT', () => shutdown)
   ├── process.on('SIGTERM', () => shutdown)
   ├── process.on('uncaughtException', e => console.error)
   └── process.on('unhandledRejection', e => console.error)
```

## 4.2 配置层 config/index.ts

```
config/index.ts — 全局配置中心
   │
   │  被谁调：几乎所有文件都 import { config }
   │  干什么：从 .env 读环境变量，提供带默认值的 config 对象
   │
   ├── import 'dotenv/config'  ← 把 .env 加载到 process.env
   │
   ├── env(key, fallback)      ← 读字符串环境变量
   ├── envInt(key, fallback)   ← 读整数环境变量
   │
   └── export const config = {
         port: envInt('PORT', 8787),
         jwtSecret: env('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
         dbPath: env('DB_PATH', './data/matchmate.db'),
         webOrigin: env('WEB_ORIGIN', 'http://localhost:5173'),
         │
         llm: {
           apiBase, apiKey, model,
           enabled: !!env('LLM_API_KEY', '')  ← !! 双重否定转布尔
         },
         embed: { apiBase, apiKey, model, enabled, dim: 256 },
         rateLimitPerHour: envInt('RATE_LIMIT_PER_HOUR', 30),
         conversationRetentionDays: 30,
         │
         match: {
           topK: 20,           ← 向量召回候选数
           finalN: 5,          ← 最终返回数
           weights: {           ← 6 维权重（和=1.0）
             vector: 0.35, interest: 0.20, style: 0.15,
             schedule: 0.10, goal: 0.05, mbti: 0.15
           },
           minConfidence: 0.4
         },
         │
         profile: {
           matchTriggerConfidence: 0.65,  ← ≥0.65 触发 PROFILE_READY
           maxRoundsKept: 20             ← 发给 LLM 的最近对话轮数
         }
       } as const
```

## 4.3 路由层 routes/*

### 4.3.1 routes/auth.ts — 注册/登录/登出/me

```
authRouter (Router)
   │
   │  被谁调：index.ts 挂到 /api/auth
   │  干什么：用户账号管理
   │
   ├── POST /register
   │   ├── 解构 { username, password, displayName }
   │   ├── registerUser({ username, password, displayName })
   │   │   │  【位置】services/auth.ts
   │   │   ├── 校验用户名/密码长度
   │   │   ├── 查重（UNIQUE 约束）
   │   │   ├── hashPassword(plain) ← bcrypt 12 rounds
   │   │   ├── INSERT INTO users
   │   │   └── 返回 AuthUser
   │   ├── signToken({ sub, tenant, username })  ← JWT 7d
   │   ├── res.cookie(authCookieName, token, { httpOnly, sameSite, secure, maxAge })
   │   └── res.json({ user: toPublicUser(user) })
   │
   ├── POST /login
   │   ├── { username, password }
   │   ├── findUserByUsername(username)
   │   ├── verifyPassword(plain, hash)  ← bcrypt.compareSync
   │   ├── 失败 → 401 "用户名或密码错误"
   │   ├── signToken + res.cookie + res.json
   │   └── 成功 → { user }
   │
   ├── POST /logout
   │   └── res.clearCookie(authCookieName) + res.json({ ok: true })
   │
   └── GET /me
       ├── requireAuth 中间件
       └── res.json({ user: toPublicUser(req.user) })
```

### 4.3.2 routes/chat.ts — 消息/SSE/会话 ★链路最热

```
chatRouter (Router)
   │
   │  被谁调：index.ts 挂到 /api/chat
   │  干什么：聊天主链路
   │
   ├── POST /messages   ★ 最热接口
   │   │  body: { content, sessionId }
   │   │
   │   ├── requireAuth  ← middleware/auth.ts
   │   ├── consumeRateLimit(userId)  ← 超 30 条/小时 → 429
   │   ├── 校验 content 非空
   │   ├── INSERT INTO conversations (role='user', content, session_id)
   │   ├── SELECT 最近 20 条对话
   │   ├── getSession(userId, tenantId)  ← orchestrator
   │   ├── loadProfile(userId)  ← profileAgent.loadProfile
   │   │
   │   ├── 设置 SSE 响应头（text/event-stream + no-cache + keep-alive）
   │   ├── const abortCtrl = new AbortController()
   │   ├── res.on('close', () => { aborted=true; abortCtrl.abort() })
   │   │
   │   ├── profileAgent.streamReply(messages, profile, onDelta, ctx, signal, onReasoning, sessionId)
   │   │   │  onDelta = (text) => sse(res, 'delta', { text })   ← 推前端气泡
   │   │   │  onReasoning = (text) => sse(res, 'reasoning', { text })  ← 推思考框
   │   │   └── 见 4.6.2 profileAgent
   │   │
   │   ├── INSERT INTO conversations (role='assistant', text)  ← 存 AI 回复
   │   ├── sse(res, 'done', { text, reasoning })
   │   ├── res.end()
   │   │
   │   └── profileAgent.run({ recentMessages }, ctx).then(result =>  ★ 异步后台
   │       │  ★ 不 await，不阻塞 res.end()
   │       │
   │       ├── if (result.ok)
   │       │   └── transition(ctx, { type:'profile_updated', confidence })
   │       │       │  【位置】core/orchestrator.ts
   │       │       └── if (confidence >= 0.65) state CHATTING → PROFILE_READY
   │       │
   │       └── catch → 仅记录日志（不影响用户）
   │
   ├── GET /sessions
   │   ├── requireAuth
   │   ├── SELECT DISTINCT session_id FROM conversations WHERE user_id=?
   │   └── res.json({ sessions: [...] })
   │
   ├── GET /sessions/:sessionId/messages
   │   ├── requireAuth
   │   ├── SELECT * FROM conversations WHERE session_id=? ORDER BY id
   │   └── res.json({ messages })
   │
   └── DELETE /sessions/:sessionId
       ├── requireAuth
       ├── DELETE FROM conversations WHERE session_id=?
       └── res.json({ ok: true })
```

### 4.3.3 routes/match.ts — 匹配/破冰/历史

```
matchRouter (Router)
   │
   │  被谁调：index.ts 挂到 /api/match
   │  干什么：匹配主链路
   │
   ├── POST /run   ★ 开始匹配
   │   ├── requireAuth → getSession
   │   ├── loadProfile → 没画像/没兴趣 → 400
   │   ├── transition(ctx, { type:'match_requested' })
   │   ├── matchAgent.run({ limit }, ctx)
   │   │   └── 见 4.6.3 matchAgent
   │   ├── transition(ctx, { type:'match_done' })
   │   └── res.json({
   │         candidates: result.data.candidates.map(toPublicCandidate),
   │         totalCount, myProfileText, state: ctx.state
   │       })
   │
   ├── POST /icebreaker   ★ 生成破冰话术
   │   ├── requireAuth → getSession
   │   ├── { targetUserId } = req.body
   │   ├── 校验 targetUserId 有效、≠自己
   │   ├── loadProfile(my) + loadProfile(target)
   │   ├── commonInterests = 算共同兴趣
   │   ├── matchScore = 从 matches 表查
   │   ├── transition(ctx, { type:'icebreak_requested' })
   │   ├── iceBreakerAgent.run({ targetUserId, targetProfile, myInterests, commonInterests, matchScore }, ctx)
   │   │   └── 见 4.6.4 iceBreakerAgent
   │   └── res.json({ icebreakers, source })
   │
   ├── GET /history
   │   ├── requireAuth
   │   ├── SELECT * FROM matches WHERE user_a=? ORDER BY id DESC LIMIT 20
   │   └── res.json({ history })
   │
   ├── POST /feedback
   │   ├── requireAuth
   │   ├── { matchId, feedback } = req.body  ← feedback: 1/0/-1
   │   ├── UPDATE matches SET feedback=? WHERE id=?
   │   ├── ★ matchAdapter.updateMatchFeedback(userId, candidateId, feedback)
   │   │   → globalMemoryBus.updateMatchFeedback()  ← Layer 3 更新反馈
   │   └── res.json({ ok: true })
   │
   └── GET /candidates/:targetUserId/profile
       ├── requireAuth
       ├── loadProfile(targetUserId) → 只返回脱敏后的公开字段
       └── res.json({ profile: toPublicProfile })
```

### 4.3.4 routes/profile.ts — 画像查询/历史

```
profileRouter (Router)
   │
   │  被谁调：index.ts 挂到 /api/profile
   │  干什么：画像查看
   │
   ├── GET /
   │   ├── requireAuth
   │   ├── loadProfile(userId)
   │   ├── 没画像 → { profile:null, confidence:0, message:'还没有画像' }
   │   └── res.json({ profile, confidence, profileText: profileToText(profile) })
   │
   ├── GET /history
   │   ├── requireAuth
   │   ├── SELECT version, patch_json, created_at FROM profile_patches
   │   │   WHERE user_id=? ORDER BY id ASC
   │   └── res.json({ history: rows.map(r => ({ version, patch, createdAt })) })
   │
   ├── PATCH /privacy
   │   ├── requireAuth
   │   ├── { shareProfile } = req.body
   │   ├── UPDATE profiles SET share_profile=? WHERE user_id=?
   │   └── res.json({ ok: true })
   │
   └── DELETE /
       ├── requireAuth
       ├── DELETE FROM profiles WHERE user_id=?  ← 软删除（保留 patches）
       └── res.json({ ok: true })
```

### 4.3.5 routes/dm.ts — 私信房间/SSE 长轮

```
dmRouter (Router)
   │
   │  被谁调：index.ts 挂到 /api/dm
   │  干什么：用户间私信
   │
   ├── POST /rooms
   │   ├── requireAuth
   │   ├── { targetUserId } = req.body
   │   ├── 校验 target 存在
   │   ├── INSERT OR IGNORE INTO dm_rooms (user_a, user_b)  ← UNIQUE 约束
   │   └── res.json({ room })
   │
   ├── GET /rooms
   │   ├── requireAuth
   │   ├── SELECT * FROM dm_rooms WHERE user_a=? OR user_b=?
   │   │   JOIN users 拿对方 displayName
   │   └── res.json({ rooms })
   │
   ├── GET /rooms/:roomId/messages?limit=50&before=xxx
   │   ├── requireAuth + 校验是房间成员
   │   ├── SELECT * FROM dm_messages WHERE room_id=? AND id < ? LIMIT ?
   │   └── res.json({ messages })
   │
   ├── POST /rooms/:roomId/messages
   │   ├── requireAuth + 校验是房间成员
   │   ├── INSERT INTO dm_messages (room_id, sender_id, content)
   │   ├── UPDATE dm_rooms SET last_message_at=now
   │   ├── ★ 如果对方是 AI bot → aiBotReplier.replyToUser()
   │   │   │  【位置】services/aiBotReplier.ts
   │   │   │   异步触发 bot 回复（不阻塞 res）
   │   │   └── 见 4.5.5
   │   └── res.json({ ok: true })
   │
   └── GET /rooms/:roomId/stream   ★ SSE 长轮
       ├── requireAuth + 校验是房间成员
       ├── 设置 SSE 头
       ├── let sinceId = req.query.since || 0
       ├── let aborted = false; res.on('close', () => aborted=true)
       ├── setInterval(heartbeat, 25000)  ← 每 25s 发 ping 防超时
       ├── while (!aborted)
       │   ├── SELECT * FROM dm_messages WHERE room_id=? AND id>? AND sender_id!=?
       │   ├── for (r of rows) sse(res, 'message', {...}) + sinceId=r.id
       │   │        + UPDATE dm_messages SET read_at=now WHERE id=?
       │   └── await sleep(1500)  ← 每 1.5s 轮询一次
       └── clearInterval(heartbeat) + res.end()
```

### 4.3.6 routes/privacy.ts — 数据导出/删账号（合规）

```
privacyRouter (Router)
   │
   │  被谁调：index.ts 挂到 /api/privacy
   │  干什么：GDPR 合规
   │
   ├── GET /export
   │   ├── requireAuth
   │   ├── 拉用户全量数据：users + profiles + profile_patches +
   │   │                conversations + matches + dm_messages
   │   ├── res.setHeader('Content-Disposition', 'attachment; filename=...')
   │   └── res.json({ user, profile, patches, conversations, matches, messages })
   │
   └── DELETE /account
       ├── requireAuth
       ├── { confirm } = req.body  ← 要求输入用户名确认
       ├── 校验 confirm === username
       ├── DELETE FROM users WHERE id=?  ← ON DELETE CASCADE 级联删
       │   → profiles / conversations / matches / dm_messages 全删
       ├── res.clearCookie(authCookieName)
       ├── ★ globalMemoryBus.clearUser(userId)  ← 清 4 层记忆
       └── res.json({ ok: true })
```

### 4.3.7 routes/health.ts — 探活/能力/统计

```
healthRouter (Router)
   │
   │  被谁调：index.ts 挂到 /api
   │  干什么：运维监控 + 前端能力探测
   │
   ├── GET /health
   │   └── res.json({ ok:true, service:'matchmate', version:'1.0.0-beta' })
   │
   ├── GET /info
   │   └── res.json({
   │         llmEnabled,                    ← 前端据此显示"AI/降级模式"
   │         embedMode: 'api' | 'local',
   │         matchWeights: config.match.weights,  ← 前端展示"怎么算的"
   │         rateLimitPerHour
   │       })
   │
   └── GET /stats
       ├── db.prepare('SELECT COUNT(*) as c FROM users').get()
       ├── db.prepare('SELECT COUNT(*) FROM profiles WHERE confidence>0').get()
       ├── db.prepare('SELECT COUNT(*) FROM matches').get()
       └── res.json({ users, profiles, matches })
```

### 4.3.8 routes/test.ts — AI 派发测试/追踪/报告

```
testRouter (Router)
   │
   │  被谁调：index.ts 挂到 /api/test（仅开发环境）
   │  干什么：自动化测试 + 报告生成
   │
   ├── POST /run
   │   ├── { userCount, rounds } = req.body
   │   ├── aiDispatchTest({ userCount, rounds })
   │   │   │  【位置】scripts/aiDispatchTest.ts
   │   │   └── 见 4.15.3
   │   └── res.json({ traceId, started: true })
   │
   ├── GET /trace/:traceId
   │   ├── 读 logs/trace-{traceId}.ndjson
   │   └── res.json({ events: [...] })
   │
   ├── GET /trace
   │   ├── 列出所有 trace 文件
   │   └── res.json({ traces: [...] })
   │
   └── GET /report
       ├── 读 reports/latest-report.html
       └── res.sendFile(...)  ← 直接返回 HTML
```

## 4.4 中间件层 middleware/auth.ts

```
middleware/auth.ts — JWT 鉴权中间件
   │
   │  被谁调：所有需要登录的路由（requireAuth）
   │          公开接口（optionalAuth）
   │  干什么：从 cookie 取 JWT → 验证 → 注入 req.user
   │
   ├── declare global { namespace Express { interface Request { user?: AuthUser } } }
   │   ← 给 Express.Request 加 user 属性（TS 类型扩展）
   │
   ├── requireAuth(req, res, next)
   │   ├── token = req.cookies?.[authCookieName]
   │   ├── if (!token) → res.status(401).json({ error:'未登录' }) + return
   │   ├── payload = verifyToken(token)
   │   │   │  【位置】services/auth.ts
   │   │   └── jwt.verify(token, secret) → { sub, tenant, username }
   │   ├── if (!payload) → clearCookie + 401 '登录已过期'
   │   ├── user = getUserById(payload.sub)
   │   ├── if (!user) → 401 '用户不存在'
   │   ├── req.user = user  ← 注入
   │   └── next()  ← 放行给下一个中间件/路由
   │
   └── optionalAuth(req, res, next)
       ├── token = req.cookies?.[authCookieName]
       ├── if (token)
       │   ├── payload = verifyToken(token)
       │   └── if (payload)
       │       └── user = getUserById() → if (user) req.user = user
       │           （失败静默跳过，因为是"可选"鉴权）
       └── next()  ← 无论有没有 token 都放行
```

## 4.5 服务层 services/*

### 4.5.1 services/auth.ts — 鉴权服务

```
auth.ts — 密码哈希 + JWT + 用户增删查
   │
   │  被谁调：routes/auth.ts + middleware/auth.ts
   │
   ├── hashPassword(plain): string
   │   └── bcrypt.hashSync(plain, 12)  ← 12 rounds（安全强度）
   │
   ├── verifyPassword(plain, hash): boolean
   │   └── bcrypt.compareSync(plain, hash)
   │
   ├── signToken(payload: { sub, tenant, username }): string
   │   └── jwt.sign(payload, config.jwtSecret, { expiresIn:'7d' })
   │
   ├── verifyToken(token): JWTPayload | null
   │   └── try { jwt.verify(token, secret) } catch { null }
   │
   ├── registerUser(input, tenantId='default'): AuthUser
   │   ├── 校验 username 长度 3-20、password 长度 6-100
   │   ├── findUserByUsername(username) → 已存在 → throw '用户名已被占用'
   │   ├── id = randomUUID()
   │   ├── INSERT INTO users (id, tenant_id, username, password_hash, display_name)
   │   └── return { id, tenantId, username, displayName }
   │
   ├── findUserByUsername(username): AuthUser | null
   │   └── SELECT * FROM users WHERE username=? AND tenant_id=?
   │
   ├── getUserById(userId): AuthUser | null
   │   └── SELECT * FROM users WHERE id=?
   │
   └── toPublicUser(user)  ← 脱敏：去掉 password_hash
       └── return { id, tenantId, username, displayName }
```

### 4.5.2 services/llmClient.ts — DeepSeek 客户端

```
llmClient.ts — 和 DeepSeek API 对话的电话机
   │
   │  被谁调：profileAgent / iceBreakerAgent / cacheLlmAdapter
   │  干什么：封装 fetch 调用，统一鉴权/错误/SSE 解析
   │
   ├── export const llmEnabled = config.llm.enabled  ← 启动时算一次
   │
   ├── chatStream(messages, cb, opts): Promise<ChatResult>   ★ 流式
   │   │  被谁调：profileAgent.streamReplyLLM（降级路径）
   │   │  干什么：POST DeepSeek stream:true，SSE 解析
   │   │
   │   ├── if (!llmEnabled) → throw 'LLM 未配置 API Key'
   │   ├── url = `${apiBase}/chat/completions`
   │   ├── fetch(url, {
   │   │     method:'POST',
   │   │     headers: { Authorization: Bearer ${apiKey} },
   │   │     body: { model, messages, max_tokens, temperature, stream:true,
   │   │             stream_options: { include_usage: true } },
   │   │     signal: opts.signal
   │   │   })
   │   ├── if (!resp.ok) → throw
   │   ├── reader = resp.body.getReader()
   │   ├── decoder = new TextDecoder()
   │   ├── buf = ''  ← 跨块缓冲区
   │   ├── while (true)
   │   │   ├── { done, value } = await reader.read()
   │   │   ├── if (done) break
   │   │   ├── buf += decoder.decode(value, { stream:true })
   │   │   ├── lines = buf.split('\n')
   │   │   ├── buf = lines.pop()  ← 最后一行可能不完整
   │   │   └── for (line of lines)
   │   │       ├── if (!line.startsWith('data:')) continue
   │   │       ├── data = line.slice(5).trim()
   │   │       ├── if (data === '[DONE]') continue
   │   │       ├── json = JSON.parse(data)
   │   │       ├── delta = json.choices?.[0]?.delta?.content
   │   │       ├── if (delta) { full += delta; cb.onDelta(delta) }
   │   │       ├── reasoningDelta = json.choices?.[0]?.delta?.reasoning_content
   │   │       ├── if (reasoningDelta) { reasoning += ...; cb.onReasoning?.(...) }
   │   │       └── if (json.usage)
   │   │             usage = { inputTokens, outputTokens, cacheHitTokens, cacheMissTokens }
   │   │             cb.onUsage?.(usage)
   │   └── return { text: full, reasoning, usage }
   │
   └── chatOnce(messages, opts): Promise<ChatResult>   ★ 非流式
       │  被谁调：profileAgent.extractViaLLM / iceBreakerAgent.generateLLM
       │  干什么：一次性返回完整 JSON
       │
       ├── if (!llmEnabled) → throw
       ├── fetch(url, { ... stream:false })
       ├── json = await resp.json()
       ├── text = json.choices?.[0]?.message?.content
       ├── reasoning = json.choices?.[0]?.message?.reasoning_content
       └── return { text, reasoning, usage }
```

### 4.5.3 services/embedding.ts — 向量嵌入

```
embedding.ts — 文本转向量（双模式）
   │
   │  被谁调：profileAgent.execute（画像变 → 重算向量）
   │          matchAgent.execute（查询向量）
   │          scripts/seed.ts（种子数据预置）
   │
   ├── embedLocal(text): number[]   ★ 本地模式
   │   │  干什么：bigram + 哈希 + L2 归一化，256 维
   │   │
   │   ├── vec = new Float64Array(256)
   │   ├── if (!text) return [...vec]  ← 空文本返零向量
   │   ├── tokens = []
   │   ├── 中文 bigram：match(/[\u4e00-\u9fa5]/g) → 两两组合
   │   ├── 英文词 + trigram：match(/[a-z0-9]+/g)
   │   ├── for (tok of tokens)
   │   │   ├── h = hash(tok) % 256  ← 落到桶
   │   │   └── vec[h] += 1
   │   ├── L2 归一化：norm = sqrt(sum(v²))，每分量 /= norm
   │   └── return Array.from(vec)
   │
   ├── hash(s): number   ← FNV-1a 哈希
   │   ├── h = 2166136261
   │   ├── for (c of s) h ^= c.charCodeAt(i); h = Math.imul(h, 16777619)
   │   └── return h >>> 0  ← 转无符号 32 位
   │
   ├── embedViaApi(text): Promise<number[]>   ← API 模式
   │   └── POST /embeddings → 返回 1536 维
   │
   └── embed(text): Promise<number[]>   ★ 主入口
       ├── if (config.embed.enabled) → try embedViaApi
       └── catch / 未启用 → embedLocal
```

### 4.5.4 services/rateLimiter.ts — 滑动窗口限流

```
rateLimiter.ts — 按 hour bucket 限流
   │
   │  被谁调：routes/chat.ts 的 POST /messages
   │  干什么：每小时最多 30 条消息
   │
   └── consumeRateLimit(userId): { allowed, remaining, retryAfterSec }
       ├── now = Date.now()
       ├── hourBucket = Math.floor(now / 3600000)  ← 当前小时桶
       ├── key = `${userId}:hour:${hourBucket}`
       ├── expiresAt = (hourBucket + 1) * 3600000
       ├── DELETE FROM rate_counters WHERE expires_at < now  ← 清过期
       ├── current = SELECT count FROM rate_counters WHERE key=?
       ├── if (current >= config.rateLimitPerHour)
       │   └── return { allowed:false, remaining:0,
       │                retryAfterSec: Math.ceil((expiresAt-now)/1000) }
       ├── if (current === 0)
       │   └── INSERT INTO rate_counters (key, count=1, expires_at)
       ├── else
       │   └── UPDATE rate_counters SET count = count + 1
       └── return { allowed:true, remaining: limit-current-1, retryAfterSec:0 }
```

### 4.5.5 services/aiBotReplier.ts — AI Bot 人格回复

```
aiBotReplier.ts — 4 个内置 AI bot
   │
   │  被谁调：routes/dm.ts POST /rooms/:roomId/messages
   │          （发现接收方 userId ∈ BOT_USERNAMES → 异步触发，不阻塞响应）
   │  干什么：用 LLM 给 4 个常驻 AI bot 生成符合人设的回复
   │  它调谁：services/llmClient.ts:chatStream
   │         db/index.ts:getDB（读对话历史 + 写新回复）
   │
   ├── 【常量】BOT_USERNAMES = ['alice_intj','bob_enfp','carol_isfj','david_entp']
   │
   ├── 【常量】BOTS: Record<username, BotProfile>
   │   │  每个 BotProfile 字段：
   │   │  { username, displayName, mbti, systemPrompt, tagline, greeting(name) }
   │   │
   │   ├── alice_intj  (INTJ 战略家)  → 技术架构导师（debug/选型/学习路径）
   │   ├── bob_enfp    (ENFP 竞选者)  → 社交激励师（组局/活跃/暖场）
   │   ├── carol_isfj  (ISFJ 守卫者)  → 倾听陪伴者（情绪支持/日常陪伴）
   │   └── david_entp  (ENTP 辩论家)  → 创业军师（推演 idea/挑刺/启发）
   │
   ├── getBotIdCache(): Map<username, userId>
   │   │  懒加载缓存：首次调用时 SELECT username, id FROM users
   │   │  WHERE username IN (4 个 bot 用户名)
   │   └── 后续直接读 Map，O(1)
   │
   ├── isBotUser(userId): boolean
   │   └── 检查 userId 是否是 4 个 bot 之一（用于 dm.ts 决定要不要触发回复）
   │
   ├── getBotUserId(username): string | undefined
   │   └── 用 username 反查 userId（初始化房间时用）
   │
   ├── getBotProfileByUserId(userId): BotProfile | undefined
   │   └── 用 userId 反查人设（replyToUser 时拿 systemPrompt）
   │
   └── replyToUser(botUserId, senderName, roomId, tenantId): Promise<void>  ★核心
       │
       │  被谁调：routes/dm.ts 收到给 bot 的消息后异步触发
       │  干什么：让 bot 生成符合人设的回复 + 写入 DB
       │
       ├── getBotProfileByUserId(botUserId)  ← 取人设
       │   └── 没找到 → return（防御）
       │
       ├── 拉最近 10 条对话历史
       │   SELECT sender_id, content FROM dm_messages
       │   WHERE room_id=? ORDER BY id DESC LIMIT 10
       │
       ├── 构建 ChatMessage[]
       │   [{role:'system', content: profile.systemPrompt},
       │    {role:'user'|'assistant', content: ...}, ...]
       │   ← 自己发的 → assistant，对方发的 → user
       │
       ├── isFirstContact = history.length <= 1  ← 第一条消息 → 用 greeting 模板
       │
       ├── chatStream(messages, callbacks, opts)  ← services/llmClient.ts
       │   │  opts: { signal: AbortSignal.timeout(25s),
       │   │          maxTokens: first ? 512 : 256,
       │   │          temperature: 0.8 }
       │   │  callbacks.onDelta = (text) => replyText += text
       │   └── 流式拼接回复文本
       │
       ├── 写入 DB：
       │   INSERT INTO dm_messages (room_id, tenant_id, sender_id, content, created_at)
       │   ← SSE 长轮询会发现新消息推给前端
       │
       ├── 更新房间最近消息时间：
       │   UPDATE dm_rooms SET last_message_at=? WHERE id=?
       │
       └── catch → console.warn（不抛，避免拖垮 DM 路由）
```

### 4.5.6 services/traceLogger.ts — 全链路运行日志

```
traceLogger.ts — 函数调用 + 数据流 + token 消费三合一日志
   │
   │  被谁调：routes/test.ts、cacheLlmAdapter、lifecycleAdapter、各 Agent
   │  干什么：记录全过程（fn 调用/事件/token/数据流/缓存/状态），用于 HTML 报告
   │  它调谁：node:fs（appendFileSync 写 NDJSON 文件）
   │
   ├── 【类型】TraceEntry
   │   { ts, time, kind, level, name, userId?, traceId?,
   │     durationMs?, payload?, result?, error? }
   │
   ├── 【类型】TraceKind = 'fn'|'event'|'token'|'data'|'cache'|'state'
   │
   ├── 【常量】LOG_DIR = server/logs/  ← mkdirSync(recursive)
   ├── 【常量】LOG_FILE = trace-YYYYMMDD-HHmmss.ndjson  ← 按启动时间分文件
   ├── 【常量】MAX_ENTRIES = 5000  ← 内存缓冲上限
   │
   ├── 【内部】write(entry: TraceEntry): void
   │   ├── entries.push + 超 5000 截断（保留最新）
   │   ├── appendFileSync(LOG_FILE, JSON.stringify(entry)+'\n')
   │   └── console.log 彩色简短输出（按 kind 着色）
   │
   ├── 【内部】formatTime / formatFileTimestamp / colorize / safeSample
   │   ← safeSample：对象只留前 10 个 key + 字符串截 200 字（防过大）
   │
   └── 【对外】trace 对象
       │
       ├── trace.fn<T>(name, fn, opts?): Promise<T>  ★最常用
       │   │  包裹一个函数调用，自动记入参/返回/耗时/异常
       │   ├── 记录 start = Date.now()
       │   ├── try { result = await fn() }
       │   │   └── 写 info 级日志（含 result: safeSample(result)）
       │   └── catch (err)
       │       └── 写 error 级日志（含 error: err.message）+ rethrow
       │
       ├── trace.event(name, payload?, opts?): void
       │   ← 状态机转移、用户行为、Redis 读写事件
       │
       ├── trace.token(info): void
       │   │  info: { model, prompt, completion,
       │   │         cacheHit?, cacheMiss?, hitRate?, costYuan?,
       │   │         userId?, scenario? }
       │   └── name = `llm.${scenario||'call'}`（如 llm.chat / llm.extract）
       │
       ├── trace.data(name, data, opts?): void  ← 画像更新/匹配结果数据流
       ├── trace.cache(name, hit, payload?): void  ← 缓存命中/未命中
       ├── trace.state(name, from, to, payload?): void  ← 状态机变化
       │
       ├── trace.getEntries(filter?): TraceEntry[]
       │   ← filter: { kind?, userId?, since? }（用于 HTML 报告）
       │
       ├── trace.getLogFile(): string  ← 返回当前日志文件路径
       └── trace.clear(): void  ← 清空内存（不影响文件）
```

## 4.6 Agent 层 agents/*

> 三大智能体 + 基类 + 画像 Schema。Agent 之间通过 Blackboard 解耦，通过 BaseAgent 复用骨架。

### 4.6.1 agents/baseAgent.ts — Agent 基类（模板方法模式）

```
BaseAgent<TInput, TOutput> (abstract class)
   │
   │  被谁调：routes/chat.ts、routes/match.ts（通过子类实例 .run()）
   │  干什么：提供统一的 run() 骨架（计时+记账+兜底），子类只写 execute()
   │  它调谁：子类的 execute()、ctx.budget.getStatus()、ctx.loopDetector.recordError()
   │
   ├── 【接口】AgentContext — 工具箱
   │   { userId, tenantId, budget, blackboard, loopDetector, profileConfidence?, state? }
   │   ← budget: BudgetTracker（token 记账）
   │   ← blackboard: Blackboard（贴便条）
   │   ← loopDetector: LoopDetector（踩坑本）
   │
   ├── 【接口】AgentResult<T> — 工作汇报单
   │   { agentId, ok, data?, error?, tokensUsed, durationMs }
   │   ← 无论成功失败都有 tokensUsed 和 durationMs（可观测）
   │
   ├── abstract agentId: string         ← 子类必须给（如 'profile-agent'）
   ├── abstract description: string     ← 子类必须给（如 '抽取用户画像'）
   │
   ├── protected abstract execute(input, ctx): Promise<TOutput>
   │   ← 子类必须实现"具体干啥活"
   │
   └── async run(input, ctx): Promise<AgentResult<TOutput>>  ★模板方法
       │
       ├── start = Date.now()                    ← ① 开始计时
       ├── tokensBefore = ctx.budget.getStatus().used  ← ② 记账前余额
       │
       ├── try { data = await this.execute(input, ctx) }  ← ③ 调子类
       │   └── return { ok:true, data, tokensUsed, durationMs }
       │
       └── catch (e)
           ├── ctx.loopDetector.recordError(e.message)  ← 写踩坑本
           └── return { ok:false, error, tokensUsed, durationMs }
```

### 4.6.2 agents/profileAgent.ts — 画像采集 Agent ★链路核心 #1

```
ProfileAgent extends BaseAgent<ProfileAgentInput, ProfileAgentOutput>
   │
   │  被谁调：routes/chat.ts POST /messages
   │  干什么：① streamReply() 同步流式聊天回复（前端秒看）
   │         ② execute() 异步抽画像 → 存 DB → 算向量 → 写黑板
   │  它调谁：llmClient、embedding、structuredOutput、profileSchema、
   │         integrations/agentMemoryAdapter.profileAdapter、db
   │
   ├── agentId = 'profile-agent'
   ├── description = '从对话中抽取画像（兴趣/社交风格/目标）'
   │
   ├── protected async execute(input, ctx): Promise<ProfileAgentOutput>  ★核心
   │   │
   │   ├── ① patch = await this.extractProfile(recentMessages, ctx)
   │   │   ← LLM 优先，失败降级 extractViaKeywords()
   │   │
   │   ├── ② current = loadProfile(userId) || createEmptyProfile()
   │   │   next = applyPatch(current, patch)  ← 增量合并
   │   │
   │   ├── ③ persistProfile(userId, tenantId, next)
   │   │   ← UPDATE profiles SET profile_json=?, confidence=?, version=version+1
   │   │   if (hasPatchContent(patch)) persistPatch(...)  ← INSERT profile_patches（审计）
   │   │
   │   ├── ④ if (置信度提升 or 首次画像):
   │   │       text = profileToText(next)
   │   │       vec = await embed(text)              ← 算 256/1536 维向量
   │   │       updateProfileEmbedding(userId, vec)  ← 存 profiles.embedding
   │   │
   │   ├── ⑤ ctx.blackboard.write('latest_profile', next)
   │   │       ctx.blackboard.write('latest_patch', patch)
   │   │
   │   ├── ⑥ ★ profileAdapter.onProfileExtracted(userId, patch)
   │   │       ← 写 Layer 2 长期记忆（MatchAgent/IceBreaker 能读历史画像）
   │   │
   │   ├── ⑦ ctx.budget.recordInput(estimateTextTokens(...))
   │   └── return { profile: next, patch, confidence, profileText }
   │
   ├── async extractProfile(messages, ctx): Promise<ProfilePatch>
   │   │
   │   ├── if (llmEnabled):
   │   │   return await this.extractViaLLM(messages, ctx)
   │   └── else:
   │       return extractViaKeywords(messages)  ← 关键词匹配降级
   │
   ├── private async extractViaLLM(messages, ctx): Promise<ProfilePatch>
   │   │  ← 构造 systemPrompt（让 LLM 输出 JSON patch）
   │   │  ← 调 chatOnce（非流式，单次拿全结果）
   │   │  ← quickFixJSON + extractJSON + validateJSON 三层防护
   │   └── 返回 ProfilePatch（含 interests / socialStyle / schedule / goal）
   │
   ├── async streamReply(messages, profile, onDelta, ctx, signal, onReasoning, sessionId)
   │   │  ★同步流式回复入口
   │   │  被谁调：routes/chat.ts（先调这个，再异步调 run）
   │   │  干什么：让前端秒看到打字效果
   │   │
   │   ├── if (llmEnabled && config.cache.usePrefixCache):
   │   │   return await this.streamReplyLLM(...)   ← 用 chatWithCache 走 prefix cache
   │   └── else:
   │       return templateReply(profile)  ← 模板兜底（不调 LLM）
   │
   ├── private async streamReplyLLM(messages, profile, onDelta, ctx, signal, onReasoning, sessionId)
   │   │  ← 拼 systemPrompt（含画像 + 对话原则）
   │   │  ← chatWithCache(userId, sessionId, sys, userMsg, { onDelta, onReasoning }, opts)
   │   │  ← 拼 AssistantReplyResult 返回
   │   └── 如果对话历史里发现是给 AI Bot 发消息 → 也会调 aiBotReplier
   │
   └── 【模块级函数】
       ├── extractViaKeywords(messages): ProfilePatch
       │   ← 纯关键词匹配（跑步/读书/电影等），无 LLM
       ├── templateReply(profile): string  ← 模板回复（降级用）
       ├── hasPatchContent(p): boolean     ← 判空（防写无效 patch）
       ├── loadProfile(userId): Profile | null    ← SELECT * FROM profiles
       ├── persistProfile(userId, tenantId, p)     ← UPDATE profiles
       ├── persistPatch(userId, tenantId, version, patch)  ← INSERT profile_patches
       └── updateProfileEmbedding(userId, vec)     ← UPDATE profiles SET embedding=?
```

### 4.6.3 agents/matchAgent.ts — 匹配 Agent ★链路核心 #2

```
MatchAgent extends BaseAgent<MatchAgentInput, MatchAgentOutput>
   │
   │  被谁调：routes/match.ts POST /run
   │  干什么：向量召回 + 6 维评分 + 排序 → 返回 top N 候选
   │  它调谁：profileAgent.loadProfile、embedding.embed、
   │         db/vectorStore.recallByVector、integrations/matchAgentMbtiAdapter、
   │         integrations/agentMemoryAdapter.matchAdapter、db
   │
   ├── agentId = 'match-agent'
   ├── description = '向量召回 + 规则排序，输出可解释匹配候选'
   │
   ├── protected async execute(input, ctx): Promise<MatchAgentOutput>  ★核心
   │   │
   │   ├── ① myProfile = loadProfile(ctx.userId)
   │   │   if (!myProfile || interests.length === 0):
   │   │       return { candidates:[], totalCount:0, myProfileText:'' }  ← 没画像不匹配
   │   │
   │   ├── ② myVec = await embed(profileToText(myProfile))
   │   │   ← 把画像文本转 256/1536 维向量
   │   │
   │   ├── ③ recalled = recallByVector(myVec, tenantId, excludeUserId, topK=20)
   │   │   ← db/vectorStore.ts 的余弦相似度排序
   │   │   ← 返回 [{ userId, score, profile: ProfileSnapshot }, ...]
   │   │
   │   ├── ④ candidates = recalled.map(r => {
   │   │       mbtiCompat = computeMbtiFactor(ctx.userId, r.userId)  ← 6 维之一
   │   │       factors = computeFactors(myProfile, r.profile, r.score, mbtiCompat.score)
   │   │       score = weightedScore(factors)  ← 加权综合分
   │   │       common = commonInterests(myProfile, r.profile)
   │   │       return { userId, displayName, score, factors, commonInterests,
   │   │                explanation, snapshot, mbtiCompat }
   │   │   })
   │   │
   │   ├── ⑤ candidates.sort((a,b) => b.score - a.score)  ← 按综合分降序
   │   │   top = candidates.slice(0, input.limit ?? config.match.finalN)  ← 默认取 5
   │   │
   │   ├── ⑥ ctx.blackboard.write('latest_matches', top)
   │   │       ← IceBreakerAgent 后续可读
   │   │
   │   ├── ⑦ persistMatches(tenantId, userId, top)  ← 批量 INSERT matches 表
   │   │
   │   └── ⑧ ★ matchAdapter.recordMatch(userId, candidateId, score, factors, tagTrace)
   │       ← 写 Layer 3 匹配决策记忆（下次匹配避开已推荐过的）
   │
   └── 【模块级函数】
       ├── computeFactors(my, theirs, vectorScore, mbtiScore): MatchFactors
       │   ← 6 维：vector(0.35) + interest(0.20) + style(0.15)
       │          + schedule(0.10) + goal(0.05) + mbti(0.15)
       │
       ├── weightedScore(f): number  ← 6 维加权求和
       ├── interestOverlap(a, b): number  ← Jaccard 相似度
       ├── styleMatch(my, theirs): number  ← 社交风格匹配
       ├── scheduleOverlap(a, b): number   ← 时段重叠率
       ├── goalComplement(a, b): number    ← 目标互补度
       ├── commonInterests(my, theirs): string[]  ← 共同兴趣列表
       ├── buildExplanation(profile, factors, common, my, mbti): string
       │   ← 生成"为什么推荐"的可解释文本
       ├── persistMatches(tenantId, userId, candidates)
       │   ← INSERT INTO matches (tenant_id, user_id, target_id, score, factors_json)
       └── clamp01(x): number  ← 钳到 [0, 1]
```

### 4.6.4 agents/iceBreakerAgent.ts — 破冰 Agent ★链路核心 #3

```
IceBreakerAgent extends BaseAgent<IceBreakerInput, IceBreakerOutput>
   │
   │  被谁调：routes/match.ts POST /icebreaker
   │  干什么：基于双方画像 + 共同兴趣 → 生成 3 条破冰开场白
   │  它调谁：llmClient.chatOnce、db、integrations/agentMemoryAdapter.iceBreakerAdapter
   │
   ├── agentId = 'icebreaker-agent'
   ├── description = '生成个性化破冰话术'
   │
   ├── protected async execute(input, ctx): Promise<IceBreakerOutput>
   │   │
   │   ├── if (llmEnabled):
   │   │   try {
   │   │     out = await this.generateLLM(input, ctx)
   │   │     persistIcebreakers(...)  ← INSERT icebreakers 表
   │   │     return { icebreakers: out, source: 'llm' }
   │   │   } catch { /* 降级 */ }
   │   │
   │   ├── out = this.generateTemplate(input)  ← 模板兜底
   │   │   persistIcebreakers(...)
   │   │   return { icebreakers: out, source: 'template' }
   │   │
   │   └── ★ iceBreakerAdapter.recordInteraction(...)
   │       ← 写 Layer 4 互动记忆（用于优化下次破冰推荐）
   │
   ├── private async generateLLM(input, ctx): Promise<string[]>
   │   │  ← systemPrompt: "你是社交破冰话术专家。生成 3 条不超过 30 字的开场白。
   │   │                   一条基于共同兴趣、一条轻松幽默、一条真诚直接。
   │   │                   输出 JSON 数组：['话术1','话术2','话术3']"
   │   │  ← userMsg: 只传画像标签（隐私保护），不传对话原文
   │   │  ← chatOnce() → quickFixJSON → extractJSON
   │   └── 返回 string[3]
   │
   ├── private generateTemplate(input): string[]
   │   │  ← 不调 LLM，按模板拼装
   │   │  ← 模板 1：基于共同兴趣
   │   │  ← 模板 2：轻松幽默
   │   │  ← 模板 3：真诚直接
   │   └── 返回 string[3]
   │
   └── 【模块级函数】persistIcebreakers(tenantId, userId, targetUserId, icebreakers)
       ← INSERT INTO icebreakers 表
```

### 4.6.5 agents/profileSchema.ts — 画像数据结构 + 合并算法

```
profileSchema.ts — 画像的"数据契约" + 增量合并算法
   │
   │  被谁调：profileAgent、matchAgent、iceBreakerAgent
   │  干什么：定义画像类型 + applyPatch（合并）+ computeConfidence（算置信度）
   │
   ├── 【接口】Profile
   │   { basic: { userId, version, updatedAt },
   │     interests: [{ name, confidence, evidence? }],
   │     socialStyle: { depth, energy },
   │     schedule: string[],
   │     goal: string,
   │     confidence: number }
   │
   ├── 【接口】ProfilePatch  ← LLM/关键词抽取的增量
   │   { interests?, socialStyle?, schedule?, goal? }
   │
   ├── createEmptyProfile(userId): Profile
   │
   ├── applyPatch(current, patch): Profile  ★增量合并核心
   │   │  ← 兴趣列表：同名的合并 confidence 取高（不重复）
   │   │  ← socialStyle/schedule/goal：有就覆盖
   │   │  ← version++
   │   └── 调 computeConfidence() 算新置信度
   │
   ├── computeConfidence(profile): number  ← 0~1
   │   ← 兴趣数 × 权重 + 社交风格完整度 + 目标明确度
   │   ← 阈值 0.65 = "画像足够，可触发匹配"（routes/chat.ts 用这个判断）
   │
   └── profileToText(profile): string  ← 画像 → 纯文本（喂给 embedding）
       例: "兴趣: 跑步 爬山 社交能量: introvert 活跃时段: weekend 目标: 周末爬山搭子"
```

## 4.7 核心层 core/*

> 系统的"骨架"——状态机 + 黑板 + 预算 + 防循环 + 输出修复 + 追踪。

### 4.7.1 core/orchestrator.ts — 会话状态机（店长）

```
orchestrator.ts — 三 Agent 协作的"店长"，管工单 + 盯状态
   │
   │  被谁调：routes/chat.ts、routes/match.ts、routes/profile.ts、routes/privacy.ts
   │  干什么：getSession() 开/拿工单；transition() 推动状态机
   │
   ├── 【类型】SessionState（联合类型，6 个值）
   │   'CHATTING' → 'PROFILE_READY' → 'MATCHING' → 'MATCHED' → 'ICEBREAKING' → 'DONE'
   │   ① 初始聊天  ② 画像够用    ③ 匹配中    ④ 匹配完  ⑤ 破冰中  ⑥ 完成
   │
   ├── 【接口】SessionContext — 用户工单
   │   { userId, tenantId, state, blackboard, loopDetector, budget,
   │     profileConfidence, lastMatchedAt? }
   │
   ├── 【全局】sessions = new Map<userId, SessionContext>()
   │   ← 内存存储（进程重启归零，但 DB 数据还在，可重建）
   │   ← 生产可换 Redis 持久化
   │
   ├── getSession(userId, tenantId): SessionContext
   │   │  被谁调：所有需要状态的 route
   │   │  干什么：花名册里查工单，没有就开一张新的
   │   │  新工单初始化：
   │   │   state = 'CHATTING'
   │   │   blackboard = createBlackboard()
   │   │   loopDetector = createLoopDetector()
   │   │   budget = createBudgetTracker(200_000)
   │   └── 返回 SessionContext
   │
   ├── transition(ctx, signal): SessionState  ★状态机核心
   │   │
   │   │  signal.type 5 种之一：
   │   │   'profile_updated'    ← ProfileAgent 抽完画像发
   │   │   'match_requested'   ← 前端点匹配按钮
   │   │   'match_done'         ← MatchAgent 完成发
   │   │   'icebreak_requested' ← 前端点破冰按钮
   │   │   'icebreak_done'      ← IceBreaker 完成发
   │   │  signal.confidence? ← 只有 profile_updated 带
   │   │
   │   ├── case 'profile_updated':
   │   │   if (confidence !== undefined) ctx.profileConfidence = confidence
   │   │   if (state==='CHATTING' && confidence >= 0.65) state = 'PROFILE_READY'
   │   │   ← 前端看到 PROFILE_READY → "开始匹配"按钮亮起
   │   │
   │   ├── case 'match_requested':
   │   │   ← 守卫：只在 CHATTING / PROFILE_READY / MATCHED 状态允许
   │   │   ← MATCHING/ICEBREAKING 拒绝（防并发）
   │   │   if (state ∈ {CHATTING, PROFILE_READY, MATCHED}) state = 'MATCHING'
   │   │
   │   ├── case 'match_done':
   │   │   if (state === 'MATCHING') state = 'MATCHED'
   │   │       lastMatchedAt = Date.now()
   │   │
   │   ├── case 'icebreak_requested':
   │   │   if (state === 'MATCHED') state = 'ICEBREAKING'
   │   │
   │   └── case 'icebreak_done':
   │       if (state === 'ICEBREAKING') state = 'DONE'
   │
   └── resetSession(userId): void
       ← 用户删账号时调（routes/privacy.ts）
       ← sessions.delete(userId)
```

### 4.7.2 core/blackboard.ts — 共享黑板（Agent 解耦通信）

```
blackboard.ts — Agent 间的"公告板"（写便条 + 按标题读）
   │
   │  被谁调：ProfileAgent / MatchAgent / IceBreakerAgent 写读
   │  干什么：让三个 Agent 互不认识也能传话（防循环依赖）
   │  原理：每个用户一个 Blackboard 实例（在 orchestrator.getSession 里创建）
   │
   ├── 【类型】BBCategory = 'fact'|'decision'|'warning'|'profile_patch'|'match_result'
   │   ← 便条分类（debug 用 readCategory 过滤）
   │
   ├── 【接口】BlackboardEntry
   │   { agentId, key, value, category, timestamp }
   │
   ├── 【接口】Blackboard — 8 个方法
   │   write(agentId, key, value, category?)
   │   read(key): BlackboardEntry | undefined  ★按 key O(1) 读
   │   readAll(): BlackboardEntry[]            ← 返回副本
   │   readCategory(cat): BlackboardEntry[]
   │   has(key): boolean
   │   snapshot(): BlackboardSnapshot          ← debug + 持久化用
   │   clear(): void
   │   size(): number
   │
   └── createBlackboard(): Blackboard  ★工厂函数
       │  闭包封装：entries 数组 + keyIndex Map 私有
       │
       ├── write(agentId, key, value, category='decision')
       │   ├── idx = keyIndex.get(key)
       │   ├── if (idx !== undefined) entries[idx] = 新便条  ← 同 key 覆盖
       │   └── else entries.push(新便条) + keyIndex.set(key, 末尾位置)
       │   ← O(1) 写入
       │
       ├── read(key)
       │   ├── idx = keyIndex.get(key)
       │   └── return idx !== undefined ? entries[idx] : undefined
       │   ← O(1) 读取（用 Map 索引加速）
       │
       ├── readAll() → [...entries]  ← 浅拷贝防外部篡改
       ├── readCategory(cat) → entries.filter(e => e.category === cat)
       ├── has(key) → keyIndex.has(key)
       ├── snapshot() → { entries: [...], size, agentContributions }
       ├── clear() → entries.length=0; keyIndex.clear()
       └── size() → entries.length
```

### 4.7.3 core/antiloop.ts — 反循环检测器

```
antiloop.ts — Agent "防抽风器"
   │
   │  被谁调：BaseAgent.run()（catch 时调 recordError）
   │         各 Agent execute()（每轮调 recordAction + checkLoop）
   │  干什么：检测 3 种抽风（参数重复 / 连续报错 / 原地踏步）
   │
   ├── 【接口】LoopDetector
   │   recordAction(name, args, result): void
   │   recordError(msg: string): void
   │   checkLoop(): { isLoop: boolean; message: string }
   │   isStuck(): boolean
   │   reset(): void
   │
   └── createLoopDetector(): LoopDetector
       │  闭包变量：
       │   actionLog: ActionRecord[]  ← 操作日志
       │   consecutiveErrors: number ← 连续错误数
       │   roundsWithoutProgress: number ← 无进展轮数
       │
       ├── recordAction(name, args, result)
       │   ├── argsKey = `${name}:${JSON.stringify(args)}`  ← 操作指纹
       │   ├── 找到同 key → count++
       │   ├── 没找到 → push 新条目
       │   ├── if (result.length > 50) roundsWithoutProgress = 0  ← 有进展
       │   ├── else if (result.includes('Error')) consecutiveErrors++
       │   └── else roundsWithoutProgress++
       │
       ├── recordError(msg)
       │   ├── consecutiveErrors++
       │   └── roundsWithoutProgress++
       │
       ├── checkLoop()
       │   ├── 遍历 actionLog：
       │   │   if (count >= 3) return { isLoop:true,
       │   │                             message:`检测到循环：${name} 被连续调用 ${count} 次` }
       │   ├── if (consecutiveErrors >= 5) return { isLoop:true, message:`连续 5 次出错` }
       │   └── return { isLoop:false, message:'' }
       │
       ├── isStuck()
       │   └── return roundsWithoutProgress >= 10 || consecutiveErrors >= 10
       │
       └── reset() → 清空所有
```

### 4.7.4 core/tokenBudget.ts — Token 预算追踪器

```
tokenBudget.ts — Agent 的"钱包"
   │
   │  被谁调：BaseAgent.run()（执行前后调 getStatus 算消耗）
   │         ProfileAgent.execute()（调 LLM 前后调 recordInput/Output）
   │  干什么：累计 token 消耗，超 75% 软提醒，超 90% 硬停
   │
   ├── 【接口】BudgetStatus
   │   { used, remaining, pct, shouldNudge, shouldForceStop, diminishing, totalBudget }
   │
   ├── 【接口】BudgetTracker
   │   recordInput(tokens): void    ← 记 prompt token
   │   recordOutput(tokens): void   ← 记 completion token（同时算 diminishing）
   │   getStatus(): BudgetStatus
   │   getNudgeMessage(): string | null
   │   reset(): void
   │
   ├── estimateTextTokens(text): number  ← 模块级工具函数
   │   ← 估算文本 token 数（约 字符数 / 4）
   │   ← ProfileAgent 算 prompt 大小时用
   │
   └── createBudgetTracker(totalBudget = 200_000): BudgetTracker  ★工厂
       │  闭包变量：
       │   inputTokens: number = 0
       │   outputTokens: number = 0
       │   roundOutputs: number[] = []  ← 最近 5 轮输出（算 diminishing）
       │   NUDGE = 0.75, FORCE = 0.90
       │
       ├── recordInput(tokens)
       │   └── inputTokens += Math.max(0, Math.round(tokens))
       │
       ├── recordOutput(tokens)
       │   ├── outputTokens += t
       │   ├── roundOutputs.push(t); if (>5) shift
       │   └── （后面 getStatus 用 roundOutputs 算 diminishing）
       │
       ├── getStatus()
       │   ├── used = input + output
       │   ├── pct = used / totalBudget
       │   ├── shouldNudge = (pct >= 0.75 && pct < 0.90)
       │   ├── shouldForceStop = (pct >= 0.90)
       │   ├── diminishing = roundOutputs.length >= 3 && 全 < 200 && pct > 0.5
       │   └── return BudgetStatus
       │
       └── getNudgeMessage()
           ├── if (shouldForceStop) return "[系统] Token 预算耗尽 (90%)"
           ├── if (shouldNudge && diminishing) return "[系统] 预算 75%，产出递减"
           ├── if (shouldNudge) return "[系统] 预算 75%，聚焦核心字段"
           └── return null
```

### 4.7.5 core/structuredOutput.ts — LLM 输出修复三层防护

```
structuredOutput.ts — 把 LLM 的脏输出修成合法 JSON
   │
   │  被谁调：ProfileAgent.extractViaLLM、IceBreakerAgent.generateLLM
   │  干什么：LLM 经常输出"几乎对的 JSON"，这文件负责把它救回来
   │
   ├── quickFixJSON(text): string  ★第 1 层：文本预处理
   │   ├── .trim()
   │   ├── 去掉 ```json 和 ``` markdown 围栏
   │   ├── 修复尾逗号 ,\s*([\]}]) → $1
   │   ├── 单引号 → 双引号
   │   ├── 给无引号的 key 加引号
   │   └── NaN/Infinity → null
   │
   ├── extractJSON(text): unknown | null  ★第 2 层：抽取
   │   ├── try { JSON.parse(text) }  ← 先直接 parse
   │   ├── catch { 找第一个 { 到最后一个 } 的子串 }
   │   ├── try { JSON.parse(子串) }
   │   └── 都失败 → return null
   │
   ├── validateJSON(data, schema): { valid, errors }  ★第 3 层：Schema 校验
   │   ├── _validate(data, schema, path, errors)  ← 递归
   │   ├── 检查 type（object/array/string/number/boolean/null）
   │   ├── 检查 required 字段
   │   ├── 检查 properties（每个字段递归）
   │   ├── 检查 items（数组元素）
   │   └── 返回 errors 数组
   │
   └── 【类型】JsonSchema
       { type, properties?, required?, items?, additionalProperties? }
```

### 4.7.6 core/tracer.ts — Agent 执行追踪

```
tracer.ts — 函数调用 + 数据流的执行追踪（用于调试和报告）
   │
   │  被谁调：各 Agent 的 execute() 方法（startSpan / addStep / endSpan）
   │         routes/test.ts（getSpanHistory 生成 HTML 报告）
   │  干什么：记录每个 Agent 执行的过程（耗时、子步骤、元数据）
   │
   ├── 【接口】TraceStep — 单步记录
   │   { ts, name, metadata?, level? }
   │
   ├── 【接口】TraceSpan — 一次完整 Agent 执行
   │   { name, startTs, endTs?, durationMs?, metadata, steps[], status }
   │
   ├── 【全局】spans: TraceSpan[]、currentSpan: TraceSpan | null
   │
   ├── startSpan(name, metadata?): TraceSpan
   │   │  ← Agent.execute() 开头调
   │   ├── newSpan = { name, startTs: Date.now(), metadata, steps: [], status: 'running' }
   │   ├── spans.push(newSpan)
   │   ├── currentSpan = newSpan  ← 设置为当前活跃 span
   │   └── return newSpan
   │
   ├── endSpan(metadata?): TraceSpan | null
   │   ├── if (!currentSpan) return null
   │   ├── currentSpan.endTs = Date.now()
   │   ├── currentSpan.durationMs = endTs - startTs
   │   ├── currentSpan.status = 'completed'
   │   ├── 合并 metadata
   │   ├── currentSpan = null
   │   └── return 完成的 span
   │
   ├── addStep(name, metadata?, level?)
   │   ├── if (!currentSpan) return  ← 没 span 就不记
   │   └── currentSpan.steps.push({ ts: Date.now(), name, metadata, level })
   │
   ├── async trace<T>(name, fn, metadata?): Promise<T>
   │   │  ← 便捷包装：自动 startSpan + endSpan
   │   ├── startSpan(name, metadata)
   │   ├── try { result = await fn(); endSpan(); return result }
   │   └── catch { endSpan({ error }); throw }
   │
   ├── getCurrentSpan(): TraceSpan | null
   ├── getSpanHistory(): TraceSpan[]  ← 返回所有完成的 span
   ├── getTraceSummary()  ← 统计：每个 Agent 调用次数、平均耗时、错误率
   └── clearTraces(): void  ← 清空所有 span
```

## 4.8 数据层 db/*

> SQLite 连接管理 + Schema 定义 + 向量存储召回。

### 4.8.1 db/index.ts — SQLite 连接管理（单例 + WAL）

```
index.ts — better-sqlite3 单例连接
   │
   │  被谁调：几乎所有 services / agents / routes / scripts
   │  干什么：模块级单例变量 db，懒加载，整个进程共用一个连接
   │
   ├── getDB(): Database.Database  ★单例入口
   │   ├── if (db) return db  ← 已有连接直接返回
   │   ├── mkdirSync(dirname(config.dbPath), { recursive: true })
   │   │   ← 确保 data/ 目录存在
   │   ├── db = new Database(config.dbPath)  ← 打开/创建 SQLite 文件
   │   ├── db.pragma('journal_mode = WAL')     ← WAL 模式（写不阻塞读）
   │   ├── db.pragma('foreign_keys = ON')      ← 启用外键约束（删用户级联删关联）
   │   ├── db.pragma('synchronous = NORMAL')   ← 平衡安全与性能
   │   └── return db
   │
   └── closeDB(): void  ← 进程退出时调（lifecycleAdapter.gracefulShutdown）
       └── try { db?.close() } catch { /* 无视 */ }
```

### 4.8.2 db/schema.ts — 数据库 Schema 定义

```
schema.ts — 建表 + 索引（启动时跑一次）
   │
   │  被谁调：index.ts 启动时调 initSchema()
   │  干什么：CREATE TABLE IF NOT EXISTS（幂等，跑多次不报错）
   │
   └── initSchema(): void
       │  ← db.exec(多行 SQL)
       │
       ├── tenants (id, name, created_at)
       │   ← 多租户表（未来一家公司一个 tenant_id）
       │
       ├── users (id, tenant_id, username, password_hash, display_name, created_at)
       │   UNIQUE(tenant_id, username)  ← 同租户用户名唯一
       │
       ├── profiles (user_id, tenant_id, version, profile_json, confidence,
       │             embedding, updated_at)
       │   ← embedding 字段存 JSON 向量字符串
       │   ← profile_json 存合并后的完整画像
       │
       ├── profile_patches (user_id, version, patch_json, created_at)
       │   ← 审计：每次画像变更的增量 patch
       │
       ├── conversations (id, user_id, tenant_id, role, content,
       │                  session_id, created_at)
       │   ← 用户和 AI 的聊天记录
       │   ← role: 'user' / 'assistant' / 'system'
       │
       ├── matches (id, tenant_id, user_id, target_id, score,
       │           factors_json, created_at)
       │   ← 匹配历史（不重复推荐用）
       │
       ├── icebreakers (id, tenant_id, user_id, target_user_id,
       │               icebreaker_text, created_at)
       │   ← 破冰话术历史
       │
       ├── dm_rooms (id, tenant_id, user_a, user_b, created_at,
       │             last_message_at)
       │   UNIQUE(tenant_id, user_a, user_b)  ← 一对用户只有一个房间
       │
       ├── dm_messages (id, room_id, tenant_id, sender_id, content,
       │                 created_at, read_at)
       │   ← 私聊消息（含与 AI bot 的对话）
       │
       ├── rate_counters (key, count, expires_at)
       │   ← 滑动窗口限流计数器
       │
       └── audit_log (id, tenant_id, actor, action, target, payload_json, created_at)
           ← 管理员操作审计
```

### 4.8.3 db/vectorStore.ts — 向量存储与召回 ★向量核心

```
vectorStore.ts — SQLite 存向量 + 纯 JS 余弦相似度
   │
   │  被谁调：
   │   写：profileAgent.upsertVector / scripts/seed.ts
   │   读：matchAgent.recallByVector
   │  干什么：画像向量的存取 + topK 召回
   │  设计：接口已抽象，百万级可平滑迁移 pgvector（仅替换本文件）
   │
   ├── 【接口】VectorRecord
   │   { userId, tenantId, vector: number[], profile: ProfileSnapshot }
   │
   ├── 【接口】ProfileSnapshot  ← 召回时一并返回的画像快照
   │   { displayName, confidence, interests: string[],
   │     socialStyle: {depth, energy}, schedule: string[], goal }
   │
   ├── cosine(a, b): number  ★纯 JS 余弦相似度
   │   │  公式：cos(A, B) = (A·B) / (|A| × |B|)
   │   │  返回：-1 到 1，越接近 1 越相似
   │   ├── len = Math.min(a.length, b.length)  ← 防长度不一致
   │   ├── for 循环累加 dot(点积) + na(|A|²) + nb(|B|²)
   │   ├── if (na===0 || nb===0) return 0  ← 零向量不相似（防除 0）
   │   └── return dot / (Math.sqrt(na) * Math.sqrt(nb))
   │
   ├── upsertVector(userId, tenantId, vector, profile): void
   │   │  ★写入入口
   │   │  ← UPDATE profiles SET embedding = JSON.stringify(vector)
   │   │  ← profile_json 在 profileAgent 已更新，这里只同步向量
   │   └── void profile  ← 显式标记未用（避免 TS 警告）
   │
   └── recallByVector(queryVec, tenantId, excludeUserId, topK): Array<{userId, score, profile}>  ★召回入口
       │
       │  ★MatchAgent 调用：recallByVector(myVec, 'default', '小王ID', 20)
       │
       ├── ① SQL 查询：
       │   SELECT user_id, embedding, profile_json, confidence, display_name
       │   FROM profiles p JOIN users u ON u.id = p.user_id
       │   WHERE p.tenant_id = ?           ← 租户隔离
       │     AND p.user_id != ?            ← 排除自己
       │     AND p.embedding IS NOT NULL    ← 必须有向量
       │     AND p.confidence >= 0         ← 有画像即可
       │
       ├── ② 遍历候选：
       │   for (const r of rows) {
       │     vec = JSON.parse(r.embedding)        ← 向量 JSON → 数组
       │     prof = parseProfileSnapshot(r)       ← 容错解析（失败给空画像）
       │     score = cosine(queryVec, vec)        ← 算余弦相似度
       │     scored.push({ userId: r.user_id, score, profile: prof })
       │   }
       │
       ├── ③ scored.sort((a, b) => b.score - a.score)  ← 按分数降序
       │
       └── ④ return scored.slice(0, topK)  ← 取前 topK 个
```

### 4.8.4 services/embedding.ts — 向量嵌入服务 ★向量入口

```
embedding.ts — 把文本变成数字向量（画像指纹机）
   │
   │  被谁调：profileAgent.embed / scripts/seed.ts.embedLocal
   │  干什么：画像文本 → 256/1536 维向量
   │
   ├── 【双模式设计】
   │   ① API 模式（高质量）：配 EMBED_API_KEY → embedViaApi(text)
   │      POST /embeddings → 返回 1536 维向量
   │   ② 本地模式（零依赖）：默认 → embedLocal(text)
   │      bigram + FNV-1a hash → 256 维向量
   │
   ├── 【常量】DIM = config.embed.dim  ← 默认 256
   │
   ├── embedLocal(text): number[]  ★本地嵌入
   │   │  ← 中文字符 bigram："我喜欢" → ["我喜", "喜欢"]
   │   │  ← 英文 trigram："running" → ["run","unn","nni","nin","ing"]
   │   │  ← 每个 token 哈希到 256 维桶，桶值 +1
   │   │  ← L2 归一化（向量长度=1，余弦=点积）
   │   │
   │   ├── vec = new Float64Array(DIM)  ← 256 个 0
   │   ├── cjk = text.match(/[\u4e00-\u9fa5]/g)  ← 提取所有中文
   │   │   for (i=0; i<cjk.length-1; i++) tokens.push(cjk[i]+cjk[i+1])  ← bigram
   │   │   for (c of cjk) tokens.push(c)  ← 也加单字符
   │   ├── words = text.match(/[a-z0-9]+/g)  ← 提取所有英文/数字词
   │   │   for (w of words) {
   │   │     tokens.push(w)
   │   │     if (w.length > 3) for (i=0; i<w.length-2; i++)
       │   │       tokens.push(w.slice(i, i+3))  ← trigram
   │   │   }
   │   ├── for (tok of tokens) {
   │   │     h = hash(tok) % DIM  ← 哈希到 0-255 桶号
   │   │     vec[h] += 1          ← 桶值 +1
   │   │   }
   │   ├── L2 归一化：
   │   │   norm = sqrt(Σ vec[i]²)
   │   │   if (norm > 0) for (i) vec[i] /= norm
   │   └── return Array.from(vec)  ← Float64Array → 普通数组
   │
   ├── hash(s): number  ← FNV-1a 哈希（内部用）
   │   ├── h = 2166136261  ← FNV offset basis
   │   ├── for (i=0; i<s.length; i++) {
   │   │     h ^= s.charCodeAt(i)        ← XOR 当前字符
   │   │     h = Math.imul(h, 16777619)  ← 乘 FNV prime（32 位整数乘法）
   │   │   }
   │   └── return h >>> 0  ← 转无符号 32 位
   │
   ├── embedViaApi(text): Promise<number[]>  ← 远端 API
   │   ├── url = config.embed.apiBase + '/embeddings'
   │   ├── resp = await fetch(url, { method, headers, body: { model, input: text } })
   │   ├── if (!resp.ok) throw new Error(`embed API ${resp.status}`)
   │   ├── json = await resp.json()
   │   └── return json.data?.[0]?.embedding || embedLocal(text)  ← 失败降级
   │
   └── embed(text): Promise<number[]>  ★主入口
       ├── if (config.embed.enabled && config.embed.apiBase):
       │   try { return await embedViaApi(text) }
       │   catch { return embedLocal(text) }  ← 挂了降级
       └── return embedLocal(text)  ← 没配 Key 直接本地
```

> **向量功能总结**：本地嵌入（bigram + hash）默认开箱即跑，零依赖；配 `EMBED_API_KEY` 自动切远端 1536 维。ProfileAgent 算完向量 → upsertVector 存 SQLite；MatchAgent → recallByVector 算余弦召回。完整链路可用。

## 4.9 记忆层 memory/*

> 四层记忆架构 + 权限矩阵 + 总线统一调度。Agent 不直接访问记忆存储，全部走 MemoryBus。

### 4.9.1 memory/memoryTypes.ts — 类型与权限矩阵

```
memoryTypes.ts — 类型定义 + 权限矩阵 + 配置常量
   │
   │  被谁调：所有 memory/* 文件、agents/* 通过 MemoryBus 间接用
   │  干什么：定义 4 层记忆的类型 + Agent 访问权限矩阵
   │
   ├── 【类型】MemoryLayer = 'short_term' | 'long_term_profile' | 'match_decision' | 'interaction'
   │   ← 4 层记忆的标识
   │
   ├── 【类型】AgentId = 'profile' | 'match' | 'icebreaker'
   │   ← 3 个核心 Agent 的标识
   │
   ├── 【接口】MemoryEntry — 所有记忆条目的基类
   │   { id, userId, tenantId, layer, timestamp, metadata?, ttl? }
   │
   ├── 【接口】MemoryQuery
   │   { userId, tenantId?, layer?, startTime?, endTime?, limit?, tags? }
   │
   ├── 【接口】ShortTermEntry extends MemoryEntry
   │   { role: 'user'|'assistant'|'system', content: string, sessionId: string }
   │
   ├── 【接口】LongTermProfileEntry extends MemoryEntry
   │   { tags: ProfileTag[], version, confidence }
   │   ← ProfileTag = { key, value, confidence, source, timestamp }
   │
   ├── 【接口】MatchDecisionEntry extends MemoryEntry
   │   { targetUserId, score, factors: string[], status: 'recommended'|'accepted'|'rejected' }
   │
   ├── 【接口】InteractionEntry extends MemoryEntry
   │   { targetUserId, topic, channel: 'dm'|'icebreaker', outcome: 'positive'|'neutral'|'negative' }
   │
   ├── 【常量】MEMORY_PERMISSIONS  ★权限矩阵（行=Agent，列=Layer）
   │   profile:  short_term=write, long_term_profile=readwrite,
   │             match_decision=none, interaction=none
   │   match:    short_term=none, long_term_profile=read,
   │             match_decision=readwrite, interaction=read
   │   icebreaker: short_term=none, long_term_profile=read,
   │             match_decision=read, interaction=readwrite
   │   ← 设计原则：每个 Agent 只能访问它该看的层（最小权限）
   │
   └── 【常量】MEMORY_CONFIG
       shortTermWindowSize: 20          ← 短期记忆滑窗大小
       longTermConfidenceThreshold: 0.5  ← 写入长期画像的最低置信度
       matchDedupWindow: 20              ← 匹配去重窗口
       interactionTopicDedup: 10        ← 破冰话题去重窗口
```

### 4.9.2 memory/memoryBus.ts — 记忆总线（统一调度）

```
memoryBus.ts — 4 层记忆的"调度总机"
   │
   │  被谁调：agents/profileAgent、matchAgent、iceBreakerAgent
   │         integrations/agentMemoryAdapter（适配器层）
   │  干什么：Agent 不直接访问 4 层存储，全走 bus（统一鉴权 + 路由）
   │  设计：单例（globalMemoryBus = new MemoryBus()）
   │
   ├── 【属性】持有 4 层实例
   │   shortTerm: ShortTermMemory
   │   longTermProfile: LongTermProfileMemory
   │   matchDecision: MatchDecisionMemory
   │   interaction: InteractionMemory
   │
   ├── checkPermission(agent, layer, action): boolean  ← private
   │   ├── perm = MEMORY_PERMISSIONS[agent][layer]
   │   ├── 'readwrite' → true
   │   ├── 'read' && action==='read' → true
   │   ├── 'write' && action==='write' → true
   │   └── return false
   │
   ├── read(agent, layer, query): MemoryEntry[] | MemoryEntry | null
   │   │  ★统一读接口
   │   ├── if (!checkPermission) throw `权限拒绝：${agent} 无权读 ${layer}`
   │   └── switch(layer) → 路由到对应层的 read 方法
   │
   ├── write(agent, layer, entry): MemoryEntry | null
   │   │  ★统一写接口
   │   ├── if (!checkPermission) throw `权限拒绝`
   │   └── switch(layer) → 路由到对应层的 write 方法
   │
   ├── search(agent, layer, query): MemoryEntry[]
   │   ← 按条件查询（startTime/endTime/tags 过滤）
   │
   └── export const globalMemoryBus = new MemoryBus()  ★全局单例
```

### 4.9.3 memory/shortTermMemory.ts — Layer 1 短期会话记忆

```
shortTermMemory.ts — 当前会话的消息滑窗
   │
   │  被谁调：MemoryBus.read/write 路由过来（profile Agent 写）
   │  干什么：保留最近 N 条会话原文（默认 20）
   │  存储：内存 Map<userId, ShortTermEntry[]>
   │
   └── class ShortTermMemory
       ├── read(userId): ShortTermEntry[]
       │   ← 返回该用户最近的消息列表
       │
       ├── write(entry): ShortTermEntry
       │   ├── arr = map.get(userId) || []
       │   ├── arr.push(entry)
       │   ├── if (arr.length > 20) arr.shift()  ← 滑窗淘汰最老
       │   └── return entry
       │
       └── clear(userId): void  ← 会话结束时清空
```

### 4.9.4 memory/longTermProfileMemory.ts — Layer 2 长期画像记忆

```
longTermProfileMemory.ts — 用户画像标签库（跨会话）
   │
   │  被谁调：MemoryBus（profile Agent 读写，match/icebreaker 读）
   │  干什么：累积用户标签 + 版本号 + 置信度
   │  存储：内存 Map<userId, LongTermProfileEntry>（DB 持久化由 db/* 负责）
   │
   └── class LongTermProfileMemory
       ├── read(userId): LongTermProfileEntry | null
       │
       ├── write(entry): LongTermProfileEntry
       │   ├── 旧画像 = read(userId)
       │   ├── for tag in entry.tags:
       │   │   if (tag.confidence < 0.5) continue  ← 低于阈值不写
       │   │   旧 tag = 旧画像.tags.find(t => t.key === tag.key)
       │   │   if (旧 tag) 合并：取置信度高者 + 更新 timestamp
       │   │   else push 新 tag
       │   └── version++  ← 版本号自增
       │
       ├── addTag(userId, tag): void  ← 单独加一个标签
       └── getTags(userId): ProfileTag[]  ← 拿所有标签
```

### 4.9.5 memory/matchDecisionMemory.ts — Layer 3 匹配决策记忆

```
matchDecisionMemory.ts — 匹配历史（去重用）
   │
   │  被谁调：MemoryBus（match Agent 读写，icebreaker 读）
   │  干什么：记录推荐过谁、对方接受/拒绝、最近 N 次推荐列表
   │  存储：内存 Map<userId, MatchDecisionEntry[]>
   │
   └── class MatchDecisionMemory
       ├── read(userId): MatchDecisionEntry[]
       │   ← 返回该用户所有匹配决策历史
       │
       ├── write(entry): MatchDecisionEntry
       │   ├── arr = map.get(userId) || []
       │   ├── arr.push(entry)
       │   └── if (arr.length > 20) arr.shift()  ← 去重窗口
       │
       └── getRecentTargets(userId, n=20): string[]
           ← 返回最近推荐过的 targetUserId 列表（MatchAgent 去重用）
```

### 4.9.6 memory/interactionMemory.ts — Layer 4 撮合交互记忆

```
interactionMemory.ts — 破冰话术历史（话题去重用）
   │
   │  被谁调：MemoryBus（icebreaker Agent 读写，match 读）
   │  干什么：记录用过哪些破冰话题、对方反应如何
   │  存储：内存 Map<userId, InteractionEntry[]>
   │
   └── class InteractionMemory
       ├── read(userId): InteractionEntry[]
       │
       ├── write(entry): InteractionEntry
       │   ├── arr.push(entry)
       │   └── if (arr.length > 10) arr.shift()  ← 话题去重窗口
       │
       └── getRecentTopics(userId, n=10): string[]
           ← 返回最近用过的破冰话题（IceBreakerAgent 去重用）
```

### 4.9.7 memory/index.ts — 统一导出

```
index.ts — barrel 文件
   │
   └── export { globalMemoryBus } from './memoryBus'
       export type { MemoryEntry, ShortTermEntry, ... } from './memoryTypes'
       export { ShortTermMemory, LongTermProfileMemory,
                MatchDecisionMemory, InteractionMemory } from '...'
```

## 4.10 Redis 层 redis/*

> 内存层 → Redis 持久化（防重启丢数据）。没配 Redis 时自动降级，不影响主流程。

### 4.10.1 redis/redisClient.ts — Redis 客户端封装

```
redisClient.ts — Redis 异步客户端（带连接降级）
   │
   │  被谁调：redis/stateStore.ts、cache/cacheClient.ts、integrations/lifecycleAdapter.ts
   │  干什么：封装 setJSON/getJSON/incrWithTTL 等常用命令
   │  设计：单例（globalRedisClient = new RedisClient()）
   │       连接失败 → ready=false，所有方法返回 false/null（降级不抛错）
   │
   └── class RedisClient
       ├── 属性
       │   client: Redis | null    ← ioredis 实例
       │   ready: boolean = false  ← 连接状态
       │   url: string              ← config.redis.url
       │
       ├── connect(): Promise<void>
       │   ├── if (!config.redis.enabled) return  ← 没开 → 直接返回
       │   ├── this.client = new Redis(url)
       │   ├── client.on('connect', () => ready = true)
       │   ├── client.on('error', () => ready = false)
       │   └── await client.connect()
       │
       ├── disconnect(): Promise<void>
       │   └── if (client) await client.quit(); ready = false
       │
       ├── setJSON(key, value, ttlSec=0): Promise<boolean>
       │   ├── if (!ready) return false  ← 降级
       │   ├── json = JSON.stringify(value)
       │   ├── if (ttlSec > 0) await client.set(key, json, 'EX', ttlSec)
       │   └── else await client.set(key, json)
       │
       ├── getJSON<T>(key): Promise<T | null>
       │   ├── if (!ready) return null
       │   ├── json = await client.get(key)
       │   └── return json ? JSON.parse(json) : null
       │
       ├── del(key): Promise<boolean>
       │   └── if (!ready) return false; return (await client.del(key)) > 0
       │
       ├── exists(key): Promise<boolean>
       │   └── if (!ready) return false; return (await client.exists(key)) > 0
       │
       └── incrWithTTL(key, ttlSec): Promise<number>
           │  ← 限流计数器用（rateLimiter）
           ├── if (!ready) return -1
           ├── count = await client.incr(key)
           ├── if (count === 1) await client.expire(key, ttlSec)  ← 首次设过期
           └── return count
```

### 4.10.2 redis/stateStore.ts — 状态持久化

```
stateStore.ts — 把内存数据定时落盘到 Redis（防重启丢）
   │
   │  被谁调：
   │   - lifecycleAdapter.start → startPeriodicSave(60)
   │   - lifecycleAdapter.gracefulShutdown → gracefulShutdown() + stopPeriodicSave
   │   - core/orchestrator getSession → 启动时调 restoreMemoryFromRedis
   │  干什么：每 60 秒把 MemoryBus + Blackboard + Session 存 Redis
   │
   ├── 【常量】REDIS_KEYS
   │   memoryAll: 'memory:all'           ← 4 层记忆一起序列化
   │   blackboardPrefix: 'blackboard:'   ← 拼 userId
   │   sessionPrefix: 'session:'          ← 拼 sessionId
   │   cacheConvPrefix: 'cache:conv:'     ← 缓存的会话
   │
   ├── 【接口】PersistedState
   │   { memory: {shortTerm, longTermProfile, matchDecision, interaction},
   │     savedAt: number }
   │
   ├── saveMemoryToRedis(): Promise<boolean>
   │   │  ← 把 4 层记忆的内部 Map 序列化成 JSON 存
   │   ├── snapshot = {
   │   │   shortTerm: serializeMap(bus.shortTerm),
   │   │   longTermProfile: ...,
   │   │   matchDecision: ...,
   │   │   interaction: ...
   │   │ }
   │   └── return globalRedisClient.setJSON(REDIS_KEYS.memoryAll, snapshot)
   │
   ├── restoreMemoryFromRedis(): Promise<boolean>
   │   ← 启动时调，从 Redis 恢复内存数据
   │
   ├── saveBlackboard(userId, snapshot): Promise<boolean>
   │   ← key = `blackboard:${userId}`
   │
   ├── loadBlackboard(userId): Promise<BlackboardSnapshot | null>
   │
   ├── saveSession(sessionId, state): Promise<boolean>
   │   ← key = `session:${sessionId}`
   │
   ├── loadSession<T>(sessionId): Promise<T | null>
   │
   ├── saveCachedConversation(convId, conv): Promise<boolean>
   │   ← key = `cache:conv:${convId}`，ttl 1 小时
   │
   ├── loadCachedConversation(convId): Promise<... | null>
   │
   ├── startPeriodicSave(intervalSec=60): void  ★
   │   ├── _saveTimer = setInterval(async () => {
   │   │     await saveMemoryToRedis()
   │   │   }, intervalSec * 1000)
   │   └── ← 进程每 60 秒自动存一次
   │
   ├── stopPeriodicSave(): void
   │   └── if (_saveTimer) clearInterval(_saveTimer); _saveTimer = null
   │
   └── gracefulShutdown(): Promise<void>
       ├── await saveMemoryToRedis()  ← 退出前最后存一次
       └── stopPeriodicSave()
```

### 4.10.3 redis/index.ts — 统一导出

```
index.ts — barrel
   │
   └── export { RedisClient, globalRedisClient } from './redisClient.js'
       export { saveMemoryToRedis, restoreMemoryFromRedis, saveBlackboard,
                loadBlackboard, saveSession, loadSession,
                saveCachedConversation, loadCachedConversation,
                startPeriodicSave, stopPeriodicSave, gracefulShutdown,
                REDIS_KEYS } from './stateStore.js'
       export type { PersistedState } from './stateStore.js'
```

## 4.11 压缩层 compress/*

> 上下文窗口管理。把过长的对话历史压成摘要，留出 token 给新消息。

### 4.11.1 compress/compressTypes.ts — 类型与配置

```
compressTypes.ts — 压缩模块的类型和配置
   │
   │  被谁调：所有 compress/* 文件、cache/* 用
   │  干什么：定义压缩策略类型 + 配置 + 工具函数
   │
   ├── 【类型】CompactStrategy = 'micro' | 'auto' | 'none'
   │   ← micro: 微压缩（不调 LLM，只去掉冗余）
   │   ← auto: 全压缩（调 LLM 生成摘要）
   │   ← none: 不压缩
   │
   ├── 【接口】CompactResult
   │   { strategy, originalTokens, compactedTokens, savedTokens,
   │     messages: ChatMessage[], summary?: string, boundaryUsed?: boolean }
   │
   ├── 【接口】CompactConfig
   │   { maxTokens, microThreshold, autoThreshold,
   │     microKeepRecent, autoKeepRecent, microEnabled, autoEnabled }
   │
   ├── 【常量】DEFAULT_COMPACT_CONFIG
   │   maxTokens: 8000          ← 上下文窗口上限
   │   microThreshold: 0.6       ← 60% 触发微压缩
   │   autoThreshold: 0.85       ← 85% 触发全压缩
   │   microKeepRecent: 8        ← 微压缩保留最近 8 条
   │   autoKeepRecent: 4         ← 全压缩保留最近 4 条
   │
   ├── estimateTokens(messages, charsPerToken=1.5): number  ← 工具
   │   ← 估算消息列表占多少 token（字符数 / 1.5）
   │
   ├── createNoOpResult(messages, tokens): CompactResult  ← 工具
   │   ← 生成"啥也没干"的结果（strategy='none'）
   │
   └── computeContextUsage(messages, config): { tokens, pct, shouldMicro, shouldAuto }
       ├── tokens = estimateTokens(messages)
       ├── pct = tokens / config.maxTokens
       ├── shouldMicro = pct >= config.microThreshold && config.microEnabled
       └── shouldAuto = pct >= config.autoThreshold && config.autoEnabled
```

### 4.11.2 compress/microCompact.ts — 微压缩（不调 LLM）

```
microCompact.ts — 轻量压缩：删冗余保核心（不调 LLM，快）
   │
   │  被谁调：cache/cacheClient 写入前调
   │  干什么：60% 触发，保留最近 N 条 + 砍掉旧消息的冗余
   │
   ├── shouldMicroCompact(messages, config): boolean
   │   └── return computeContextUsage(messages, config).shouldMicro
   │
 ├── microCompactLog(messages, config): CompactResult  ★入口
   │   ├── ① recent = messages.slice(-keepRecent)  ← 最近 N 条原样留
   │   ├── ② old = messages.slice(0, -keepRecent)  ← 老消息要压缩
   │   ├── ③ compacted = old.map(m => compactAssistantMessage(m))
   │   │   ← 对 assistant 消息：去掉客套话、思考过程、只留结论
   │   │   ← 对 user 消息：保留原文（用户的话不能改）
   │   ├── ④ result.messages = [...compacted, ...recent]
   │   └── ⑤ result.savedTokens = originalTokens - newTokens
   │
   └── compactAssistantMessage(msg): ChatMessage  ← private
       ├── 去掉 "好的"/"明白了" 等客套前缀
       ├── 去掉 [思考过程] 标记
       ├── 限制长度（超过 500 字截断 + "..."）
       └── 返回精简后的消息
```

### 4.11.3 compress/autoCompact.ts — 全压缩（调 LLM 生成摘要）

```
autoCompact.ts — 重度压缩：调 LLM 把旧对话压成摘要
   │
   │  被谁调：cache/cacheClient 写入前调（micro 不够用时）
   │  干什么：85% 触发，旧消息 → LLM 摘要 → 用 boundary 包起来放最前
   │
   ├── shouldAutoCompact(messages, config): boolean
   │
   ├── autoCompactLog(messages, config): Promise<CompactResult>  ★入口
   │   ├── ① recent = messages.slice(-keepRecent)
   │   ├── ② old = messages.slice(0, -keepRecent)
   │   ├── ③ summary = await generateSummary(old)  ← 调 LLM 摘要
   │   ├── ④ boundary = createSummaryBoundary(summary)  ← 包系统标记
   │   └── ⑤ result.messages = [boundary, ...recent]
   │       result.summary = summary
   │       result.boundaryUsed = true
   │
   └── autoCompactIfNeeded(messages, config): Promise<CompactResult>
       ├── if (shouldAuto) return await autoCompactLog(...)
       ├── if (shouldMicro) return microCompactLog(...)
       └── return createNoOpResult(...)  ← 都不需要
```

### 4.11.4 compress/summaryGenerator.ts — 摘要生成

```
summaryGenerator.ts — 调 LLM 生成对话摘要
   │
   │  被谁调：autoCompact.autoCompactLog
   │  干什么：把一堆旧消息喂给 LLM → 输出结构化摘要
   │
   └── generateSummary(messages): Promise<string>  ★入口
       ├── ① 拼 prompt：
       │   "请把以下对话总结为关键信息（兴趣/性格/目标/偏好），
       │    不超过 200 字。\n\n对话：\n${serialize(messages)}"
       │
       ├── ② try { resp = await llmClient.chat([{role:'user', content: prompt}])
       │          return resp.content }
       │
       └── ③ catch { return fallbackSummary(messages) }  ← LLM 挂了降级
           ← fallbackSummary：取每条消息前 30 字拼接
```

### 4.11.5 compress/boundary.ts — 摘要边界标记

```
boundary.ts — 摘要和原文之间的"分隔符"
   │
   │  被谁调：autoCompact.autoCompactLog
   │  干什么：用系统消息包住摘要，让 LLM 知道这是摘要不是原文
   │
   ├── 【常量】BOUNDARY_PREFIX = '[系统：以下是之前对话的摘要，非原文]'
   ├── 【常量】BOUNDARY_SUFFIX = '[系统：摘要结束，以下是最近的真实对话]'
   │
   ├── createSummaryBoundary(summaryText): ChatMessage  ★
   │   ← 返回 role='system', content=`${PREFIX}\n${summaryText}\n${SUFFIX}`
   │
   ├── isSummaryBoundary(msg): boolean
   │   ← 检查 content 是否以 PREFIX 开头
   │
   └── extractSummaryText(msg): string
       ← 去掉 PREFIX/SUFFIX，返回纯摘要文本
```

### 4.11.6 compress/index.ts — 统一导出

```
index.ts — barrel
   │
   └── export { microCompactLog, shouldMicroCompact } from './microCompact.js'
       export { autoCompactLog, autoCompactIfNeeded, shouldAutoCompact } from './autoCompact.js'
       export { generateSummary } from './summaryGenerator.js'
       export { createSummaryBoundary, isSummaryBoundary, extractSummaryText,
                BOUNDARY_PREFIX, BOUNDARY_SUFFIX } from './boundary.js'
       export type { CompactStrategy, CompactResult, CompactConfig } from './compressTypes.js'
       export { DEFAULT_COMPACT_CONFIG, estimateTokens, computeContextUsage } from './compressTypes.js'
```

## 4.12 缓存层 cache/*

> 对话上下文缓存 + 前缀哈希（命中检测）+ 只追加日志 + 统计。

### 4.12.1 cache/cacheTypes.ts — 类型与配置

```
cacheTypes.ts — 缓存模块的类型和配置
   │
   │  被谁调：所有 cache/* 文件
   │  干什么：定义缓存消息 + 会话结构 + 统计
   │
   ├── 【类型】MessageRole = 'system' | 'user' | 'assistant'
   ├── 【类型】PrefixHash = string  ← 消息列表的指纹（前缀哈希）
   │
   ├── 【接口】CacheStats — 缓存命中统计
   │   { totalCalls, cacheHits, cacheMisses, prefixStable, prefixChanged,
   │     tokensSaved, tokensUsed, lastResetAt }
   │
   ├── 【接口】CachedConversation  ★缓存对象
   │   { id, tenantId, userId, messages: ChatMessage[],
   │     prefixHash: PrefixHash,           ← 当前消息列表的指纹
   │     compacted: boolean,                ← 是否被压缩过
   │     lastUsed: number,                  ← LRU 淘汰用
   │     stats: CacheStats,
   │     createdAt: number, updatedAt: number }
   │
   ├── 【接口】CacheStreamCallbacks
   │   { onToken?: (t: string) => void,  ← 流式 token 回调
   │     onDone?: (full: string) => void,  ← 完成回调
   │     onError?: (e: Error) => void }
   │
   ├── 【接口】CacheUsagePayload — 命中时上报的数据
   │   { conversationId, tokensSaved, prefixStable }
   │
   ├── 【常量】CACHE_CONFIG
   │   maxCachedConversations: 1000    ← LRU 上限
   │   maxMessagesPerConversation: 100 ← 单会话最多消息数
   │   autoCompactThreshold: 0.85       ← 触发自动压缩的阈值
   │   prefixStableWindow: 3           ← 检查前缀稳定性的窗口
   │
   └── createEmptyCacheStats(): CacheStats  ← 工厂
```

### 4.12.2 cache/prefixHash.ts — 前缀哈希（命中检测）

```
prefixHash.ts — 算消息列表的指纹（前缀哈希）
   │
   │  被谁调：cacheClient.appendUserMessage（写时算哈希）
   │         cacheClient.chatStreamCached（读时验证前缀稳定）
   │  干什么：把消息列表变成稳定哈希，相同前缀=相同哈希=可命中
   │
   ├── computePrefixHash(messages): PrefixHash  ★算哈希
   │   │  ← 算法：sha256(serialize(messages))
   │   │  ← 只取 role + content（不含 metadata）
   │   │  ← 前 N 条算哈希（prefixStableWindow）
   │   └── return hex 字符串
   │
   ├── verifyPrefixStable(conv, currentMessages): { stable: boolean, reason: string }
   │   │  ★检测前缀是否稳定
   │   ├── oldHash = conv.prefixHash
   │   ├── newHash = computePrefixHash(currentMessages)
   │   └── return { stable: oldHash === newHash,
   │                reason: stable ? '前缀稳定' : '前缀已变化（可能命中失败）' }
   │
   └── describeHashChange(oldHash, newHash): string  ← debug 用
       └── 返回人类可读的哈希变化描述
```

### 4.12.3 cache/appendLog.ts — 只追加日志

```
appendLog.ts — 会话操作日志（只追加不修改，便于审计 + 回放）
   │
   │  被谁调：cacheClient 写入时同步记日志
   │  干什么：把每个 append/compact 操作记成日志条目
   │
   └── class AppendOnlyLog
       ├── 属性
       │   entries: LogEntry[]  ← 日志条目数组
       │   maxSize: number      ← 最大条数（防止无限增长）
       │
       ├── append(entry): void
       │   ├── entries.push(entry)
       │   └── if (entries.length > maxSize) entries.shift()
       │
       ├── getEntries(): LogEntry[]  ← 返回副本
       │
       ├── replay(): LogEntry[]  ← 回放所有操作（重建状态用）
       │
       └── clear(): void
```

### 4.12.4 cache/cacheStats.ts — 统计模块

```
cacheStats.ts — 缓存命中/未命中统计
   │
   │  被谁调：cacheClient.chatStreamCached（每次调用后更新）
   │  干什么：累计统计 + 生成报告
   │
   ├── updateStatsWithUsage(stats, payload): void  ← 更新统计
   │   ├── stats.totalCalls++
   │   ├── if (payload.prefixStable) {
   │   │     stats.cacheHits++
   │   │     stats.tokensSaved += payload.tokensSaved
   │   │   } else {
   │   │     stats.cacheMisses++
   │   │     stats.tokensUsed += payload.tokensSaved
   │   │   }
   │   └── stats.prefixStable = payload.prefixStable
   │
   ├── formatStatsReport(stats): string  ← 人类可读报告
   │   ← "命中率 65% (195/300)，节省 token 45,000"
   │
   └── mergeStats(a, b): CacheStats  ← 合并多个统计
```

### 4.12.5 cache/cacheClient.ts — 缓存客户端主入口

```
cacheClient.ts — 对话缓存客户端（核心入口）
   │
   │  被谁调：agents/profileAgent、services/aiBotReplier
   │  干什么：缓存会话上下文，命中就跳过 LLM 调用
   │
   ├── createCachedConversation(userId, tenantId): CachedConversation  ★创建
   │   └── 返回空会话：messages=[], prefixHash='', stats=empty
   │
   ├── appendUserMessage(conv, content): void
   │   ├── conv.messages.push({ role:'user', content })
   │   ├── conv.prefixHash = computePrefixHash(conv.messages)  ← 重算哈希
   │   ├── conv.updatedAt = Date.now()
   │   └── appendLog.append({type:'append_user', content})
   │
   ├── appendToolResult(conv, content): void
   │   ├── conv.messages.push({ role:'assistant', content })
   │   └── conv.prefixHash = computePrefixHash(conv.messages)
   │
   ├── chatStreamCached(conv, prompt, callbacks): Promise<string>  ★核心
   │   │  ★带缓存优化的 LLM 调用
   │   │
   │   ├── ① 检查前缀稳定：
   │   │   if (conv.prefixHash === computePrefixHash(conv.messages)) {
   │   │     // 前缀稳定，可能命中缓存
   │   │     // → LLM 调用时带 cache_control 参数
   │   │   }
   │   │
   │   ├── ② appendUserMessage(conv, prompt)
   │   │
   │   ├── ③ 检查是否需要压缩：
   │   │   usage = computeContextUsage(conv.messages, DEFAULT_COMPACT_CONFIG)
   │   │   if (usage.shouldAuto) {
   │   │     result = await autoCompactLog(conv.messages, ...)
   │   │     conv.messages = result.messages
   │   │     conv.compacted = true
   │   │   }
   │   │
   │   ├── ④ 调 LLM 流式：
   │   │   fullText = await llmClient.streamChat(conv.messages, callbacks)
   │   │
   │   ├── ⑤ appendToolResult(conv, fullText)
   │   │
   │   └── ⑥ 更新统计：
   │       updateStatsWithUsage(conv.stats, {
   │         conversationId: conv.id,
   │         tokensSaved: prefixStable ? tokensSaved : 0,
   │         prefixStable: ...
   │       })
   │       return fullText
   │
   ├── getConversationStats(conv): CacheStats
   │   └── return conv.stats
   │
   ├── serializeConversation(conv): string  ← JSON 序列化
   │   ← 用于存 Redis（saveCachedConversation）
   │
   └── restoreConversation(serialized): CachedConversation | null
       ← 反序列化恢复（loadCachedConversation）
```

### 4.12.6 cache/index.ts — 统一导出

```
index.ts — barrel
   │
   └── export { createCachedConversation, appendUserMessage, appendToolResult,
                chatStreamCached, getConversationStats,
                serializeConversation, restoreConversation,
                AppendOnlyLog, computePrefixHash, verifyPrefixStable,
                updateStatsWithUsage, formatStatsReport, mergeStats } from '...'
       export type { CachedConversation, CacheStats, MessageRole, PrefixHash } from '...'
       export { CACHE_CONFIG, createEmptyCacheStats } from './cacheTypes.js'
```

## 4.13 MBTI 层 mbti/*

> MBTI 性格画像提取 + 类型推导 + 兼容性评分。纯算法层，不依赖 LLM 即可工作。

### 4.13.1 mbti/mbtiTypes.ts — 类型与常量

```
mbtiTypes.ts — MBTI 类型定义 + 认知功能栈
   │
   │  被谁调：所有 mbti/* 文件、integrations/mbtiProfileAdapter
   │  干什么：定义 16 型人格 + 8 维度 + 8 认知功能
   │
   ├── 【类型】MbtiDimension = 'EI' | 'SN' | 'TF' | 'JP'  ← 4 个维度
   ├── 【类型】MbtiPole = 'E'|'I'|'S'|'N'|'T'|'F'|'J'|'P'  ← 8 个极
   ├── 【类型】MbtiType = 'INTJ'|'INTP'|...|'ENFP' (共 16 种)
   ├── 【类型】CognitiveFunction = 'Se'|'Si'|'Ne'|'Ni'|'Te'|'Ti'|'Fe'|'Fi'  ← 8 认知功能
   ├── 【类型】FunctionStack = readonly [CognitiveFunction × 4]  ← 主辅三四功能
   │
   ├── 【接口】MbtiDimensionSignal — 单维度的信号
   │   { dimension, e_score, i_score, confidence, evidence: string[] }
   │
   ├── 【接口】MbtiProfile  ★完整 MBTI 画像
   │   { dimensions: Record<MbtiDimension, MbtiDimensionSignal>,
   │     type: MbtiType | 'UNKNOWN',
   │     stack: FunctionStack | null,           ← 认知功能栈
   │     updatedAt, confidence }
   │
   ├── 【接口】MbtiCompatResult — 兼容性评分结果
   │   { score: 0~100, level: 'low'|'medium'|'high'|'excellent',
   │     factors: { functionComplement, dimensionBalance, dominantHarmony },
   │     reasons: string[] }  ← 人类可读的解释
   │
   ├── 【常量】MBTI_TYPE_STACKS  ★16 型的功能栈表
   │   INTJ → ['Ni','Te','Fi','Se']   INTP → ['Ti','Ne','Si','Fe']
   │   ...（16 种类型的主辅三四功能）
   │
   ├── 【常量】DIMENSION_POLES  ← 每个维度的两极
   │   EI: ['E','I'], SN: ['S','N'], TF: ['T','F'], JP: ['J','P']
   │
   ├── 【常量】POLE_TO_DIMENSION  ← 极 → 维度反查
   │   E→'EI', I→'EI', S→'SN', ...
   │
   └── createEmptyMbtiProfile(): MbtiProfile  ← 工厂
```

### 4.13.2 mbti/mbtiEngine.ts — 类型推导引擎

```
mbtiEngine.ts — 从信号推导 MBTI 类型 + 合并画像
   │
   │  被谁调：integrations/mbtiProfileAdapter、matchAgentMbtiAdapter
   │  干什么：信号 → 类型 → 功能栈
   │
   ├── applyDimensionPatch(profile, signals): MbtiProfile  ★增量合并
   │   │  ← 把新信号合并进已有画像
   │   ├── for sig in signals:
   │   │   d = profile.dimensions[sig.dimension]
   │   │   d.e_score = round2(d.e_score * (1-w) + sig.e_score * w)
   │   │   d.i_score = round2(d.i_score * (1-w) + sig.i_score * w)
   │   │   d.confidence = round2(lerp(d.confidence, sig.confidence, w))
   │   │   d.evidence.push(...sig.evidence)
   │   │   ← w 是新信号权重（默认 0.3）
   │   ├── profile.type = deriveType(Object.values(profile.dimensions))
   │   ├── profile.stack = deriveStack(profile.type)
   │   └── profile.updatedAt = Date.now()
   │
   ├── deriveType(dimensions): MbtiType | 'UNKNOWN'  ★
   │   │  ← 4 维度投票 → 4 字母
   │   ├── e_sum = Σ dimensions['EI'].e_score
   │   ├── i_sum = Σ dimensions['EI'].i_score
   │   ├── dim_ei = e_sum > i_sum ? 'E' : 'I'
   │   ├── dim_sn = ...
   │   ├── dim_tf = ...
   │   ├── dim_jp = ...
   │   ├── if (any confidence < 0.3) return 'UNKNOWN'
   │   └── return `${dim_ei}${dim_sn}${dim_tf}${dim_jp}` as MbtiType
   │
   ├── deriveStack(type): FunctionStack  ★查表
   │   └── return MBTI_TYPE_STACKS[type]
   │
   ├── getDominantFunction(type): CognitiveFunction  ← 主功能
   │   └── return MBTI_TYPE_STACKS[type][0]
   │
   ├── getAuxiliaryFunction(type): CognitiveFunction  ← 辅功能
   │   └── return MBTI_TYPE_STACKS[type][1]
   │
   └── mergeProfileInto<T>(target: T, profile: MbtiProfile): T
       ← 把 MBTI 画像合并进任意对象（适配器用）
```

### 4.13.3 mbti/mbtiCompat.ts — 兼容性评分

```
mbtiCompat.ts — 两人 MBTI 兼容性评分
   │
   │  被谁调：integrations/matchAgentMbtiAdapter
   │  干什么：算两人 MBTI 兼容性分数 + 给出解释
   │
   └── scoreCompat(mine, theirs): MbtiCompatResult  ★主入口
       │
       │  ★MatchAgent 调用：scoreCompat(myProfile, candidateProfile)
       │
       ├── ① if (mine.type==='UNKNOWN' || theirs.type==='UNKNOWN')
       │       return { score: 50, level: 'medium', reasons: ['画像不足，给中性分'] }
       │
       ├── ② fc = computeFunctionComplement(mine.type, theirs.type)  ← 功能互补
       │   ← INTJ (Ni-Te-Fi-Se) ↔ ENFP (Ne-Fi-Te-Si) 互补强 → 高分
       │   ← 同型 INTJ ↔ INTJ 互补弱 → 中分
       │
       ├── ③ db = computeDimensionBalance(mine.type, theirs.type)  ← 维度平衡
       │   ← E-I 互补加分，同极减分（理论上能量互补更稳）
       │
       ├── ④ dh = computeDominantHarmony(mine.type, theirs.type)  ← 主功能和谐度
       │   ← 双方主功能是否形成"对话通道"（如 Ni ↔ Ne）
       │
       ├── ⑤ score = round2(0.5*fc + 0.3*db + 0.2*dh)  ← 加权合成
       │
       ├── ⑥ level = score>=85 ? 'excellent' : score>=70 ? 'high'
       │              : score>=50 ? 'medium' : 'low'
       │
       └── ⑦ reasons = buildReason(mine, theirs, fc, db, dh)
           ← "你们的主功能 Ni ↔ Ne 形成创意通道，互补度高"
```

### 4.13.4 mbti/mbtiExtractor.ts — 从对话提取 MBTI 信号

```
mbtiExtractor.ts — LLM + 关键词双模式提取 MBTI 信号
   │
   │  被谁调：integrations/mbtiProfileAdapter.extractFromConversation
   │  干什么：聊天记录 → MBTI 4 维度信号
   │
   └── extract(messages): Promise<MbtiDimensionSignal[]>  ★主入口
       │
       ├── ① try { return await extractViaLLM(messages) }
       │   ← 拼 prompt 喂给 LLM，让 LLM 输出结构化信号
       │   ← prompt: "分析用户在 EI/SN/TF/JP 4 个维度的偏好..."
       │
       └── ② catch { return extractWithKeywords(messages) }  ← LLM 挂了降级
           │  ← 纯关键词匹配
           │  ← "我喜欢聚会" → E 极 +1
           │  ← "我喜欢独处" → I 极 +1
           │  ← "我喜欢理论" → N 极 +1
           │  ← "我喜欢动手" → S 极 +1
           │  ...
           │  ← 累计每个极的分数 → 生成 4 个信号
           └── return signals
```

### 4.13.5 mbti/index.ts — 统一导出

```
index.ts — barrel
   │
   └── export { applyDimensionPatch, deriveType, deriveStack,
                getDominantFunction, getAuxiliaryFunction, mergeProfileInto,
                createEmptyMbtiProfile } from './mbtiEngine.js'
       export { scoreCompat } from './mbtiCompat.js'
       export { extract } from './mbtiExtractor.js'
       export { MBTI_TYPE_STACKS, DIMENSION_POLES, POLE_TO_DIMENSION } from './mbtiTypes.js'
       export type { MbtiDimension, MbtiPole, MbtiType, CognitiveFunction,
                    FunctionStack, MbtiDimensionSignal, MbtiProfile,
                    MbtiCompatResult } from './mbtiTypes.js'
```

## 4.14 集成层 integrations/*

> 把各模块粘合起来：Agent↔Memory 适配、Cache↔LLM 适配、MBTI 适配、生命周期管理。

### 4.14.1 integrations/agentMemoryAdapter.ts — Agent ↔ Memory 适配器

```
agentMemoryAdapter.ts — Agent 和 MemoryBus 之间的翻译官
   │
   │  被谁调：profileAgent / matchAgent / iceBreakerAgent
   │  干什么：把 Agent 的内部数据格式 ↔ Memory 的标准格式互转
   │  原理：3 个适配器对象，每个对应一个 Agent
   │
   ├── profileAdapter  ★ProfileAgent 专用
   │   ├── saveConversation(userId, messages): void
   │   │   ← 把 ChatMessage[] 转成 ShortTermEntry[] 存短期记忆
   │   │   ← messages.forEach(msg => globalMemoryBus.write('profile',
   │   │        'short_term', { role: msg.role, content: msg.content, sessionId }))
   │   │
   │   ├── loadConversation(userId): ChatMessage[]
   │   │   ← entries = globalMemoryBus.read('profile', 'short_term', { userId })
   │   │   ← 把 ShortTermEntry[] 转回 ChatMessage[]
   │   │
   │   ├── saveProfileTags(userId, tags): void
   │   │   ← 把 ProfileTag[] 存长期画像记忆
   │   │   ← globalMemoryBus.write('profile', 'long_term_profile', { tags, version })
   │   │
   │   └── loadProfileTags(userId): ProfileTag[]
   │       ← 从长期画像记忆读标签
   │
   ├── matchAdapter  ★MatchAgent 专用
   │   ├── loadUserProfile(userId): ProfileSnapshot | null
   │   │   ← 从长期画像读用户画像（match 只有读权限）
   │   │
   │   ├── saveMatchDecision(userId, targetId, score, factors): void
   │   │   ← 存匹配决策记忆（match 有读写权限）
   │   │
   │   └── getRecentMatchedTargets(userId): string[]
   │       ← 从匹配决策记忆读最近推荐过的（去重用）
   │
   └── iceBreakerAdapter  ★IceBreakerAgent 专用
       ├── loadBothProfiles(myUserId, targetUserId): [ProfileSnapshot, ProfileSnapshot]
       │   ← 读双方画像找共同点（icebreaker 有长期画像读权限）
       │
       ├── saveInteraction(userId, targetId, topic): void
       │   ← 存破冰交互记忆（icebreaker 有读写权限）
       │
       └── getRecentTopics(userId): string[]
           ← 从交互记忆读最近用过的话题（去重用）
```

### 4.14.2 integrations/cacheLlmAdapter.ts — Cache ↔ LLM 适配器

```
cacheLlmAdapter.ts — 把 cache 和 LLM 粘起来
   │
   │  被谁调：agents/profileAgent、services/aiBotReplier
   │  干什么：管理 CachedConversation 生命周期 + 透明调 LLM
   │
   ├── 【全局】conversations = new Map<userId, CachedConversation>()
   │   ← 内存中所有用户的会话缓存
   │
   ├── getOrCreateConversation(userId, tenantId): Promise<CachedConversation>  ← private
   │   ├── if (conversations.has(userId)) {
   │   │     conv = conversations.get(userId)
   │   │     conv.lastUsed = Date.now()
   │   │     return conv
   │   │   }
   │   ├── try { conv = await loadCachedConversation(userId) }  ← 先从 Redis 拿
   │   ├── if (conv) {
   │   │     conversations.set(userId, conv)
   │   │     return conv
   │   │   }
   │   └── conv = createCachedConversation(userId, tenantId)  ← 没有就新建
   │       conversations.set(userId, conv)
   │       return conv
   │
   ├── chatWithCache(userId, tenantId, prompt, callbacks): Promise<string>  ★主入口
   │   │  ★透明地调 LLM，背后自动管理缓存
   │   ├── conv = await getOrCreateConversation(userId, tenantId)
   │   ├── result = await chatStreamCached(conv, prompt, callbacks)
   │   ├── if (conversations.size > CACHE_CONFIG.maxCachedConversations) {
   │   │     evictLRU()  ← LRU 淘汰
   │   │   }
   │   ├── saveCachedConversation(conv.id, conv)  ← 落 Redis
   │   └── return result
   │
   ├── getConversationStats(userId): CacheStats
   │   ← 返回该用户的缓存统计
   │
   └── clearConversation(userId): void
       ← 注销用户时清掉缓存
```

### 4.14.3 integrations/lifecycleAdapter.ts — 生命周期管理

```
lifecycleAdapter.ts — 服务启动/退出的钩子
   │
   │  被谁调：index.ts 服务入口
   │  干什么：协调各模块的启动顺序 + 优雅退出
   │
   ├── initEnhancedSystem(): Promise<void>  ★启动
   │   │  ← 服务启动时调
   │   ├── ① await globalRedisClient.connect()
   │   │   ← 先连 Redis（其他模块依赖它）
   │   ├── ② await restoreMemoryFromRedis()
   │   │   ← 从 Redis 恢复 4 层记忆（防重启丢）
   │   ├── ③ initBots()  ← 初始化 AI bot（Alice/Bob/Carol/David）
   │   ├── ④ startPeriodicSave(60)  ← 启动定时存 Redis
   │   └── ⑤ console.log('增强系统启动完成')
   │
   ├── shutdownEnhancedSystem(): Promise<void>  ★退出
   │   │  ← 收到 SIGINT/SIGTERM 时调
   │   ├── ① await gracefulShutdown()  ← 最后存一次 Redis
   │   ├── ② await globalRedisClient.disconnect()
   │   ├── ③ closeDB()  ← 关 SQLite
   │   └── ④ console.log('增强系统已关闭')
   │
   ├── getSystemStatus(): { redis, memory, periodicSave, uptime }
   │   ← 返回各模块健康状态
   │
   └── export { redisGracefulShutdown as gracefulShutdown }
```

### 4.14.4 integrations/mbtiProfileAdapter.ts — MBTI 画像适配器

```
mbtiProfileAdapter.ts — 把 MBTI 模块和用户画像粘起来
   │
   │  被谁调：routes/profile.ts、agents/profileAgent
   │  干什么：管理用户的 MBTI 画像（提取 + 存储 + 查询）
   │
   ├── 【全局】profiles = new Map<userId, MbtiProfile>()  ← 内存缓存
   │
   ├── getMbtiProfile(userId): MbtiProfile  ★读
   │   ├── if (profiles.has(userId)) return profiles.get(userId)
   │   └── return createEmptyMbtiProfile()  ← 没有就给空画像
   │
   ├── updateMbtiFromMessages(userId, messages): Promise<MbtiProfile>  ★写
   │   │  ← 从对话提取 MBTI 信号并更新画像
   │   ├── profile = getMbtiProfile(userId)
   │   ├── signals = await extract(messages)  ← 调 mbti 模块提取信号
   │   ├── profile = applyDimensionPatch(profile, signals)  ← 合并信号
   │   ├── profiles.set(userId, profile)  ← 存内存
   │   └── return profile
   │
   └── resetMbtiProfile(userId): void
       ← 注销用户时清空 MBTI 画像
```

### 4.14.5 integrations/matchAgentMbtiAdapter.ts — MatchAgent 的 MBTI 适配器

```
matchAgentMbtiAdapter.ts — 把 MBTI 兼容性塞进 MatchAgent 评分
   │
   │  被谁调：agents/matchAgent.computeMbtiFactor
   │  干什么：算两人 MBTI 兼容性 → 转成 MatchAgent 能用的因子
   │
   ├── 【接口】MbtiCompatFactor — MatchAgent 用的格式
   │   { score: number,           ← 0~100
   │     level: string,           ← 'low'|'medium'|'high'|'excellent'
   │     reasons: string[],        ← 解释列表
   │     weight: number }          ← 在总评分中的权重
   │
   ├── computeMbtiFactor(myUserId, targetUserId): MbtiCompatFactor  ★
   │   │  ★MatchAgent 调用：computeMbtiFactor('小王ID', '小张ID')
   │   ├── myProfile = getMbtiProfile(myUserId)
   │   ├── theirProfile = getMbtiProfile(targetUserId)
   │   ├── result = scoreCompat(myProfile, theirProfile)  ← 调 mbti 模块
   │   └── return { score: result.score, level: result.level,
   │                reasons: result.reasons, weight: 0.25 }
   │                ← MBTI 在 MatchAgent 总评分中占 25% 权重
   │
   ├── mbtiTypeColorClass(type): string  ← UI 用
   │   ← 返回类型对应的 CSS 类名（INTJ → 'type-purple'）
   │
   └── mbtiTypeNickname(type): string  ← UI 用
       ← 返回类型昵称（INTJ → '建筑师'）
```

### 4.14.6 integrations/index.ts — 统一导出

```
index.ts — barrel
   │
   └── export { profileAdapter, matchAdapter, iceBreakerAdapter } from './agentMemoryAdapter.js'
       export { chatWithCache, getConversationStats, clearConversation } from './cacheLlmAdapter.js'
       export { initEnhancedSystem, shutdownEnhancedSystem, getSystemStatus } from './lifecycleAdapter.js'
       export { getMbtiProfile, updateMbtiFromMessages, resetMbtiProfile } from './mbtiProfileAdapter.js'
       export { computeMbtiFactor, mbtiTypeColorClass, mbtiTypeNickname } from './matchAgentMbtiAdapter.js'
```

## 4.15 脚本层 scripts/*

> 运维 + 测试 + 演示脚本。用 `npm run <script>` 执行。

### 4.15.1 scripts/initBots.ts — 初始化 AI Bot

```
initBots.ts — 注册 4 个内置 AI Bot + 互相匹配
   │
   │  被谁调：npm run init-bots / lifecycleAdapter.initEnhancedSystem
   │  干什么：注册 4 个 AI bot 让用户能在匹配结果里看到 + 能私信
   │
   ├── 【常量】BOTS
   │   [{ username: 'alice_intj', displayName: 'Alice', mbti: 'INTJ' },
   │    { username: 'bob_enfp',  displayName: 'Bob',   mbti: 'ENFP' },
   │    { username: 'carol_isfj', displayName: 'Carol', mbti: 'ISFJ' },
   │    { username: 'david_entp', displayName: 'David', mbti: 'ENTP' }]
   │
   ├── 流程：
   │   ① db = getDB()
   │   ② for b in BOTS:
   │      if (db.get('SELECT id FROM users WHERE username=?', b.username)) 跳过
   │      else registerUser({ username, password:'test12345', displayName })
   │   ③ 4 个 bot 互相插画像 → 算向量 → 让他们能出现在匹配列表
   │   ④ closeDB()
   │
   └── 特点：幂等（已存在就跳过，可重复跑）
```

### 4.15.2 scripts/seed.ts — 灌种子数据

```
seed.ts — 灌测试用户 + 画像 + 向量（演示用）
   │
   │  被谁调：npm run seed
   │  干什么：造 50 个虚拟用户，每个有画像 + 向量 + 兴趣
   │
   ├── makeProfile(userId, partial): Profile  ← 生成随机画像
   │   ← 随机选兴趣（跑步/读书/电影/爬山...）
   │   ← 随机选社交风格（introvert/extrovert）
   │   ← 随机选活跃时段
   │
 └── main(): Promise<void>  ★入口
     ├── ① for i in 1..50:
     │     u = registerUser({ username:`seed_user_${i}`, password, displayName })
     │     profile = makeProfile(u.id, randomAttrs)
     │     persistProfile(u.id, 'default', profile)
     │     vec = await embed(profileToText(profile))  ← 算向量
     │     upsertVector(u.id, 'default', vec, profile)  ← 存向量
     │   ← 50 个用户都有完整画像 + 向量，可被 MatchAgent 召回
     ├── ② console.log(`✅ 灌了 50 个用户`)
     └── ③ closeDB()
```

### 4.15.3 scripts/aiDispatchTest.ts — AI 调度测试

```
aiDispatchTest.ts — 测试 AI bot 回复质量 + 算 token 成本
   │
   │  被谁调：npm run ai-test / routes/test.ts
   │  干什么：跑一批 prompt 给 4 个 bot，统计质量 + 成本
   │
   ├── 【接口】TestReport
   │   { totalCases, results: TestCase[], totalCost, baselineCost,
   │     savingsPct, avgLatencyMs }
   │
   ├── runAiDispatchTest(): Promise<TestReport>  ★入口
   │   │  ← 跑预设的测试用例
   │   ├── ① for case in TEST_CASES:
   │   │     for bot in [Alice, Bob, Carol, David]:
   │   │       start = Date.now()
   │   │       resp = await aiBotReplier.reply(bot.id, case.prompt)
   │   │       latency = Date.now() - start
   │   │       results.push({ bot, prompt, response, latency, tokensUsed })
   │   ├── ② totalCost = Σ calcCost(case)  ← 实际花销
   │   ├── ③ baselineCost = Σ calcBaselineCost(inputTokens, outputTokens)  ← 无优化基线
   │   ├── ④ savingsPct = (baselineCost - totalCost) / baselineCost * 100
   │   └── ⑤ return report
   │
   ├── calcCost(case): number  ← 算单次成本
   ├── calcBaselineCost(inputTokens, outputTokens): number  ← 无优化的基线成本
   ├── generateHtmlReport(report): string  ← 生成 HTML 报告
   │   ← 每个 bot 的回复质量评分 + 成本对比图
   │
   └── mbtiGroup(type): string  ← 按 MBTI 分组（用于报告分组）
       INTJ/INTP/ISTJ/ISTP → 'analysts'
       ENFP/ENFJ/ESFP/ESFJ → 'diplomats'
       ...
```

### 4.15.4 scripts/generatePdfReport.ts — 生成 PDF 报告

```
generatePdfReport.ts — 把测试报告转 PDF（正式版）
   │
   │  被谁调：npm run pdf-report
   │  干什么：把 aiDispatchTest 的 HTML 报告转成正式 PDF
   │
 ├── cleanHtml(html): string  ← 清理 HTML（去掉动画、规范化样式）
   │
   ├── buildFormalHtml(originalHtml): string  ← 重新排版
   │   ← 加封面页、目录、页眉页脚
   │   ← 把动画图表换成静态图
   │   ← 加水印 "DZ MatchMate 内部报告"
   │
   └── main(): Promise<void>  ★入口
       ├── report = await runAiDispatchTest()
       ├── html = generateHtmlReport(report)
       ├── formalHtml = buildFormalHtml(html)
       ├── 写入 reports/ai-dispatch-report.html
       ├── 用 puppeteer 转 PDF：reports/ai-dispatch-report.pdf
       └── console.log('✅ 报告生成完成')
```

# 第五部分 API 接口数据流

> HTTP 接口到核心逻辑的完整数据流。每个接口标注"被谁调 → 干什么 → 调谁"。

## 5.1 鉴权 / 认证 routes/auth.ts

```
auth.ts — 用户注册/登录/登出/查询自己
   │
   │  全部用 requireAuth 中间件（除 register/login）
   │
 ├── POST /auth/register  ★注册
 │   │  请求：{ username, password, displayName? }
 │   │  流程：services/auth.registerUser
 │   │       → 密码 bcrypt 哈希 → INSERT users → 签发 JWT
 │   │  响应：{ token, user: { id, username, displayName } }
 │
 ├── POST /auth/login  ★登录
 │   │  请求：{ username, password }
 │   │  流程：services/auth.verifyUser
 │   │       → SELECT user → bcrypt.compare → 签 JWT
 │   │  响应：{ token, user }
 │
 ├── POST /auth/logout  ★登出
 │   │  ← 客户端清 token 即可（JWT 无状态）
 │   │  响应：{ ok: true }
 │
 └── GET /auth/me  ★查自己
     │  ← requireAuth
     │  响应：当前登录用户信息
```

## 5.2 聊天 routes/chat.ts — 核心入口

```
chat.ts — 用户和 AI Bot 聊天（画像采集主战场）
   │
   │  requireAuth 全局
   │
 ├── GET /chat/status
 │   │  ← 查当前会话状态
 │   │  → orchestrator.getSession(userId)
 │   │  响应：{ state, profileConfidence, lastMatchedAt }
 │
 ├── GET /chat/sessions
 │   ← 列出所有会话
 │   → db.prepare('SELECT * FROM conversations WHERE user_id=?')
 │
 ├── POST /chat/sessions
 │   ← 新建会话
 │   → INSERT conversations
 │
 ├── PATCH /chat/sessions/:id
 │   ← 改会话标题等
 │
 ├── DELETE /chat/sessions/:id
 │   ← 删会话（级联删消息）
 │
 ├── GET /chat/sessions/:id/messages
 │   ← 拿某会话所有消息
 │   → db.prepare('SELECT * FROM conversations WHERE session_id=? ORDER BY created_at')
 │
 ├── POST /chat/messages  ★★核心入口（流式）
 │   │  请求：{ sessionId, content }
 │   │  数据流：
 │   │
 │   │   ┌─────────────────────────────────────────────────┐
 │   │   │  ① 入口：用户发消息到 POST /chat/messages        │
 │   │   └─────────────────────┬───────────────────────────┘
 │   │                         │
 │   │                         ▼
 │   │   ② authMiddleware.verifyJWT  → 拿到 req.user
 │   │                         │
 │   │                         ▼
 │   │   ③ INSERT conversations  → 持久化用户消息
 │   │      (role='user', content, session_id, user_id, tenant_id)
 │   │                         │
 │   │                         ▼
 │   │   ④ orchestrator.getSession(userId, tenantId)
 │   │      → 拿 SessionContext（含 blackboard/loopDetector/budget）
 │   │      → 如果当前状态在 MATCHING/ICEBREAKING → 拒绝
 │   │                         │
 │   │                         ▼
 │   │   ⑤ chatStreamCached()  → 把消息塞给 cacheLlmAdapter
 │   │      → cacheLlmAdapter 调 cacheClient.chatStreamCached
 │   │      → 检查前缀哈希 + 自动压缩 + 调 llmClient.streamChat
 │   │      → 流式吐 token 给前端（SSE）
 │   │                         │
 │   │                         ▼
 │   │   ⑥ INSERT conversations  → 持久化 AI 回复（role='assistant'）
 │   │                         │
 │   │                         ▼
 │   │   ⑦ ProfileAgent.run()  → 异步触发画像提取（不阻塞响应）
 │   │      → extractProfile(messages)  → 调 LLM 抽画像
 │   │      → persistProfile  → UPDATE profiles
 │   │      → embed(profileToText)  → 算向量
 │   │      → upsertVector  → 存向量
 │   │      → blackboard.write('profile_patch', patch)
 │   │      → transition(ctx, {type:'profile_updated', confidence})
 │   │      → updateMbtiFromMessages  → 更新 MBTI 画像
 │   │                         │
 │   │                         ▼
 │   │   ⑧ 响应 SSE 流：
 │   │      data: { type:'token', content:'你' }
 │   │      data: { type:'token', content:'好' }
 │   │      ...
 │   │      data: { type:'done', tokensUsed: 1234 }
 │   │
 │   │  注意：⑦ 是异步的，前端立即拿到回复，画像在后台抽
 │   │
 │   └── 异常处理：
 │       if (state === MATCHING/ICEBREAKING) → 409 Conflict
 │       if (rate limit hit) → 429 Too Many Requests
 │       if (LLM fails) → 500 + 降级回复
 │
 └── GET /chat/history
     ← 拿所有会话历史（分页）
     → db.prepare('SELECT * FROM conversations WHERE user_id=? LIMIT ? OFFSET ?')
```

## 5.3 匹配 routes/match.ts

```
match.ts — 触发匹配 + 拿破冰话术
   │
   │  requireAuth 全局
   │
 ├── POST /match/run  ★触发匹配
 │   │  请求：{ topK?: number = 20 }
 │   │  数据流：
 │   │   ① orchestrator.getSession → transition(ctx, {type:'match_requested'})
 │   │      → 状态变 MATCHING
 │   │   ② MatchAgent.run({ userId, topK, tenantId })
 │   │      → recallByVector(myVec, tenantId, myUserId, topK)  ← 向量召回
 │   │      → 排除最近推荐过的（matchAdapter.getRecentMatchedTargets）
 │   │      → 算 MBTI 兼容性（computeMbtiFactor）
 │   │      → 多因子加权评分 → 排序
 │   │      → 存匹配历史（saveMatchDecision）
 │   │   ③ transition(ctx, {type:'match_done'})
 │   │      → 状态变 MATCHED
 │   │  响应：{ candidates: [{ userId, displayName, score, reasons }] }
 │
 ├── GET /match/history
 │   ← 拿匹配历史
 │   → db.prepare('SELECT * FROM matches WHERE user_id=?')
 │
 └── POST /match/icebreaker  ★生成破冰话术
     │  请求：{ targetUserId }
     │  数据流：
     │   ① getSession → transition(ctx, {type:'icebreak_requested'})
     │      → 状态变 ICEBREAKING
     │   ② IceBreakerAgent.run({ myUserId, targetUserId })
     │      → loadBothProfiles → 找共同点
     │      → getRecentTopics → 排除用过的话题
     │      → generateLLM → 调 LLM 生成破冰话术
     │      → saveInteraction → 存历史
     │   ③ transition(ctx, {type:'icebreak_done'})
     │      → 状态变 DONE
     │  响应：{ icebreaker: "..." }
```

## 5.4 画像 routes/profile.ts

```
profile.ts — 查/改用户画像
   │
   │  requireAuth 全局
   │
 ├── GET /profile/
 │   ← 拿自己完整画像（含 MBTI）
 │   → db.prepare('SELECT * FROM profiles WHERE user_id=?')
 │   → mbtiProfileAdapter.getMbtiProfile(userId)
 │
 ├── GET /profile/history
 │   ← 拿画像变更历史（patch 列表）
 │   → db.prepare('SELECT * FROM profile_patches WHERE user_id=? ORDER BY version')
 │
 ├── GET /profile/:userId/public
 │   ← 拿别人公开画像（脱敏版，不含隐私字段）
 │
 ├── PUT /profile/home
 │   ← 用户手填的偏好（地区、年龄范围等）
 │   → UPDATE profiles SET home_preferences=?
 │
 └── GET /profile/home/me
     ← 拿自己手填的偏好
```

## 5.5 私信 routes/dm.ts

```
dm.ts — 用户之间 / 用户和 AI bot 私信
   │
   │  requireAuth 全局
   │
 ├── GET /dm/rooms
 │   ← 列出所有私聊房间
 │   → db.prepare('SELECT * FROM dm_rooms WHERE user_a=? OR user_b=?')
 │
 ├── POST /dm/rooms
 │   ← 创建/拿已有房间
 │   → INSERT OR IGNORE dm_rooms
 │
 ├── GET /dm/rooms/:roomId/messages
 │   ← 拿房间消息（分页）
 │   → db.prepare('SELECT * FROM dm_messages WHERE room_id=? LIMIT ? OFFSET ?')
 │
 ├── POST /dm/rooms/:roomId/messages
 │   ← 发消息
 │   → INSERT dm_messages
 │   → 如果对方是 AI bot：触发 aiBotReplier.reply 异步回复
 │
 ├── POST /dm/rooms/:roomId/read
 │   ← 标记已读
 │   → UPDATE dm_messages SET read_at=? WHERE room_id=? AND sender_id!=?
 │
 └── GET /dm/rooms/:roomId/stream
     ← SSE 流式拿消息（实时推送）
     → 轮询 DB 或长连接
```

## 5.6 隐私 routes/privacy.ts

```
privacy.ts — GDPR/PIPL 合规
   │
   │  requireAuth 全局
   │
 ├── GET /privacy/export  ★数据导出
 │   │  ← 导出用户所有数据（JSON）
 │   │  → SELECT * FROM users WHERE id=?
 │   │  → SELECT * FROM profiles WHERE user_id=?
 │   │  → SELECT * FROM conversations WHERE user_id=?
 │   │  → SELECT * FROM matches WHERE user_id=?
 │   │  → SELECT * FROM dm_messages WHERE sender_id=?
 │   │  → 打包成 ZIP 返回
 │   │
 └── DELETE /privacy/account  ★删账号
     │  ← 删除用户所有数据（级联）
     │  → orchestrator.resetSession(userId)  ← 清内存
     │  → clearConversation(userId)  ← 清缓存
     │  → resetMbtiProfile(userId)  ← 清 MBTI
     │  → DELETE FROM users WHERE id=?  ← 外键级联删关联表
     │  → closeDB()
     │  响应：{ ok: true }
```

## 5.7 健康 / 测试 routes/health.ts, routes/test.ts

```
health.ts — 健康检查 + 系统信息
   │
 ├── GET /health
 │   ← 探活用（k8s/docker 健康检查）
 │   → 响应 200 { ok: true }
 │
 ├── GET /info
 │   ← 系统信息（版本、运行时长）
 │
 └── GET /stats
     ← 系统统计（缓存命中率、内存使用等）
     → getSystemStatus()
     → formatStatsReport(cacheStats)
```

```
test.ts — 测试接口（生产环境关闭）
   │
 ├── POST /test/run
 │   ← 跑 aiDispatchTest（用 LLM 测 bot 回复质量）
 │   → runAiDispatchTest()
 │
 ├── GET /test/trace
 │   ← 拿最近的 trace（getSpanHistory）
 │   → getSpanHistory()
 │
 └── GET /test/report
     ← 拿 HTML 报告
     → generateHtmlReport()
```

# 第六部分 完整文件清单

> 全部 TypeScript 源文件（66 个），按模块分组。

## 6.1 入口与配置

```
src/
├── index.ts                    ← 服务启动入口（Express + 中间件 + 路由挂载）
└── config/
    └── index.ts                ← 配置管理（环境变量 + 默认值）
```

## 6.2 中间件

```
src/middleware/
└── auth.ts                     ← JWT 鉴权中间件（requireAuth）
```

## 6.3 路由层 routes/*

```
src/routes/
├── auth.ts                     ← 鉴权（注册/登录/登出/me）
├── chat.ts                     ← 聊天（会话管理 + 消息流式）★核心
├── dm.ts                       ← 私信（房间 + 消息 + SSE）
├── health.ts                   ← 健康检查 + 系统信息
├── match.ts                    ← 匹配触发 + 破冰话术
├── privacy.ts                  ← 数据导出 + 删账号（GDPR）
├── profile.ts                  ← 画像查询 + 偏好设置
└── test.ts                     ← 测试接口（生产关闭）
```

## 6.4 服务层 services/*

```
src/services/
├── aiBotReplier.ts             ← 4 个 AI Bot 回复（带性格）
├── auth.ts                     ← 注册/登录（bcrypt + JWT）
├── embedding.ts                ★向量嵌入（本地 + API 双模式）
├── llmClient.ts                ← LLM 调用（流式 + 非流式）
├── rateLimiter.ts              ← 滑动窗口限流
└── traceLogger.ts              ← 函数调用追踪 + 日志
```

## 6.5 Agent 层 agents/*

```
src/agents/
├── baseAgent.ts                ← Agent 抽象基类（模板方法）
├── iceBreakerAgent.ts          ← 破冰话术生成
├── matchAgent.ts               ← 匹配（向量召回 + 多因子评分）
├── profileAgent.ts             ← 画像提取（LLM + 关键词）
└── profileSchema.ts           ← 画像 Schema 定义 + 工具函数
```

## 6.6 核心层 core/*

```
src/core/
├── antiloop.ts                 ← Agent 反循环检测
├── blackboard.ts               ← 共享黑板（Agent 解耦通信）
├── orchestrator.ts             ← 会话状态机
├── structuredOutput.ts         ← LLM 输出修复（三层防护）
├── tokenBudget.ts              ← Token 预算追踪
└── tracer.ts                   ← Agent 执行追踪
```

## 6.7 数据层 db/*

```
src/db/
├── index.ts                    ← SQLite 连接管理（单例 + WAL）
├── schema.ts                   ← 建表 + 索引
└── vectorStore.ts              ★向量存储与召回（余弦相似度）
```

## 6.8 记忆层 memory/*

```
src/memory/
├── index.ts                    ← barrel
├── interactionMemory.ts        ← Layer 4 破冰话术历史
├── longTermProfileMemory.ts    ← Layer 2 长期画像
├── matchDecisionMemory.ts      ← Layer 3 匹配决策
├── memoryBus.ts                ← 记忆总线（统一调度 + 鉴权）
├── memoryTypes.ts              ← 类型 + 权限矩阵 + 配置
└── shortTermMemory.ts          ← Layer 1 短期会话
```

## 6.9 Redis 层 redis/*

```
src/redis/
├── index.ts                    ← barrel
├── redisClient.ts              ← Redis 客户端封装（带降级）
└── stateStore.ts               ← 状态持久化（定时存 + 启动恢复）
```

## 6.10 压缩层 compress/*

```
src/compress/
├── autoCompact.ts              ← 全压缩（调 LLM 生成摘要）
├── boundary.ts                 ← 摘要边界标记
├── compressTypes.ts            ← 类型 + 配置 + 工具
├── index.ts                    ← barrel
├── microCompact.ts             ← 微压缩（不调 LLM）
└── summaryGenerator.ts         ← 调 LLM 生成摘要
```

## 6.11 缓存层 cache/*

```
src/cache/
├── appendLog.ts                ← 只追加日志
├── cacheClient.ts              ← 缓存客户端主入口
├── cacheStats.ts               ← 缓存命中统计
├── cacheTypes.ts               ← 类型 + 配置
├── index.ts                    ← barrel
└── prefixHash.ts               ← 前缀哈希（命中检测）
```

## 6.12 MBTI 层 mbti/*

```
src/mbti/
├── index.ts                    ← barrel
├── mbtiCompat.ts               ← 兼容性评分
├── mbtiEngine.ts               ← 类型推导 + 画像合并
├── mbtiExtractor.ts            ← 从对话提取信号
└── mbtiTypes.ts                ← 类型 + 常量
```

## 6.13 集成层 integrations/*

```
src/integrations/
├── agentMemoryAdapter.ts       ← Agent ↔ Memory 适配器
├── cacheLlmAdapter.ts          ← Cache ↔ LLM 适配器
├── index.ts                    ← barrel
├── lifecycleAdapter.ts         ← 生命周期管理（启动/退出）
├── matchAgentMbtiAdapter.ts    ← MatchAgent 的 MBTI 适配器
└── mbtiProfileAdapter.ts       ← MBTI 画像适配器
```

## 6.14 脚本层 scripts/*

```
src/scripts/
├── aiDispatchTest.ts           ← AI 调度测试（质量 + 成本）
├── generatePdfReport.ts        ← 生成 PDF 报告
├── initBots.ts                 ← 初始化 4 个 AI Bot
└── seed.ts                     ← 灌种子数据（50 用户）
```

---

# 文档统计

| 维度 | 数量 |
|------|------|
| TypeScript 源文件 | 66 个 |
| 路由模块 | 8 个 |
| 服务模块 | 6 个 |
| Agent | 3 个（Profile/Match/IceBreaker） |
| 核心模块 | 6 个 |
| 记忆层 | 4 层 |
| MBTI 类型 | 16 种 |
| AI Bot | 4 个（Alice/Bob/Carol/David） |
| 向量维度 | 256（本地）/ 1536（API） |
| 数据库表 | 10 张 |

---

> **文档完成**：覆盖所有 66 个源文件的函数调用链、参数、数据流、状态机、向量链路、API 流程。可作为后端架构参考手册。