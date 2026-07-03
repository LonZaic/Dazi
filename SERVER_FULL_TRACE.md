# Dazi 后端全函数调用链 + 架构全景图

> 项目根目录：`e:\DZ`
> 范围：`server/src/**`
> 格式：每个函数都标注【谁调它】【它干啥】【它调谁】

---

## 一、项目全景架构图

```
═══════════════════════════════════════════════════════════════════════
                      DAZI 后端系统全景图
═══════════════════════════════════════════════════════════════════════

                          【用户浏览器】
                              │ HTTP/SSE
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  入口层  server/src/index.ts                                        │
│  Express App + 全局中间件 + 路由挂载                                 │
└─────────────────────────────────────────────────────────────────────┘
        │            │            │           │           │
        ▼            ▼            ▼           ▼           ▼
   /api/auth    /api/chat    /api/match  /api/dm    /api/profile
   (auth.ts)   (chat.ts)    (match.ts)  (dm.ts)     (profile.ts)
        │            │            │           │           │
        │            │            │           │           │
        ▼            ▼            ▼           ▼           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  中间件层  middleware/auth.ts  → requireAuth                        │
│  服务层    services/  auth.ts, rateLimiter.ts, llmClient.ts,        │
│                       aiBotReplier.ts, traceLogger.ts, embedding.ts │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Agent 编排层（核心）                              │
│  core/orchestrator.ts     ← 会话状态机（6 个状态）                    │
│  core/blackboard.ts       ← 黑板模式（Agent 间通信）                  │
│  core/tokenBudget.ts      ← Token 预算（75%/90% 阈值）               │
│  core/antiloop.ts         ← 防止 Agent 死循环                        │
│  core/structuredOutput.ts ← LLM 输出 3 层修复                         │
│  core/tracer.ts           ← 执行追踪                                  │
└─────────────────────────────────────────────────────────────────────┘
        │                                           │
        ▼                                           ▼
┌──────────────────────────┐         ┌──────────────────────────────┐
│  Agents (三个核心)         │         │   集成层 integrations/         │
│  profileAgent.ts          │◀────────│  agentMemoryAdapter.ts        │
│  matchAgent.ts            │         │  cacheLlmAdapter.ts           │
│  iceBreakerAgent.ts       │         │  lifecycleAdapter.ts          │
│  baseAgent.ts             │         │  matchAgentMbtiAdapter.ts     │
│  profileSchema.ts         │         │  mbtiProfileAdapter.ts        │
└──────────────────────────┘         └──────────────────────────────┘
        │                                           │
        ▼                                           ▼
┌──────────────────────────┐         ┌──────────────────────────────┐
│  Memory 记忆层（4 层）     │         │  Redis 状态层                │
│  shortTermMemory         │◀───────│  redisClient.ts              │
│  longTermProfileMemory   │         │  stateStore.ts               │
│  matchDecisionMemory     │         └──────────────────────────────┘
│  interactionMemory       │                      │
│  memoryBus.ts (总线)     │                      ▼
└──────────────────────────┘         ┌──────────────────────────────┐
                                     │  Cache 缓存层（前缀缓存）      │
┌──────────────────────────┐         │  cacheClient.ts              │
│  Compress 压缩层          │         │  appendLog.ts                │
│  autoCompact.ts (重)     │         │  prefixHash.ts                │
│  microCompact.ts (轻)    │         │  cacheStats.ts                │
└──────────────────────────┘         └──────────────────────────────┘

┌──────────────────────────┐         ┌──────────────────────────────┐
│  MBTI 层                  │         │  数据库层 db/                  │
│  mbtiEngine.ts            │         │  index.ts (SQLite+WAL)        │
│  mbtiCompat.ts            │         │  schema.ts (建表 SQL)         │
│  mbtiExtractor.ts         │         │  vectorStore.ts (向量检索)    │
└──────────────────────────┘         └──────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  脚本层 scripts/  aiDispatchTest, initBots, seed, generatePdfReport │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、模块依赖关系图（谁引用谁）

```
routes/* ───→ middleware/auth ───→ services/auth
    │
    ├──→ services/rateLimiter
    ├──→ services/llmClient ────→ integrations/cacheLlmAdapter ──→ cache/*
    ├──→ agents/* ────→ core/orchestrator ──→ core/blackboard
    │                  │                  ──→ core/tokenBudget
    │                  │                  ──→ core/antiloop
    │                  │                  ──→ core/tracer
    │                  │
    │                  ├──→ integrations/agentMemoryAdapter ──→ memory/*
    │                  ├──→ integrations/matchAgentMbtiAdapter ──→ mbti/*
    │                  └──→ integrations/mbtiProfileAdapter ──→ mbti/*
    │
    ├──→ db/index ──→ db/schema
    ├──→ db/vectorStore
    ├──→ services/aiBotReplier
    └──→ services/traceLogger

integrations/lifecycleAdapter ──→ redis/* ──→ memory/*
                              ──→ memory/memoryBus

compress/* ──→ cacheLlmAdapter ──→ llmClient
           ──→ services/llmClient

config/index ──→ 所有模块都依赖
```

---

## 三、入口层 `server/src/index.ts`

```
bootstrap()
  │
  │  被谁调：进程启动时 node 调（package.json scripts "dev"/"start"）
  │  干什么：创建 Express App，挂载中间件 + 路由 + 启动 HTTP 服务
  │
  ├─ ① getDB()
  │     初始化数据库（建表）
  │     （位置：db/index.ts）
  │
  ├─ ② initEnhancedSystem()
  │     初始化增强系统：连 Redis、恢复记忆、注册关闭钩子
  │     （位置：integrations/lifecycleAdapter.ts）
  │
  ├─ ③ app.use(express.json())
  │     解析 JSON body
  │
  ├─ ④ app.use(cookieParser())
  │     解析 Cookie（用于 JWT 认证）
  │
  ├─ ⑤ app.use('/api/auth', authRouter)
  │     挂载认证路由
  │
  ├─ ⑥ app.use('/api/chat', chatRouter)
  │     挂载聊天路由
  │
  ├─ ⑦ app.use('/api/match', matchRouter)
  │     挂载匹配路由
  │
  ├─ ⑧ app.use('/api/dm', dmRouter)
  │     挂载私聊路由
  │
  ├─ ⑨ app.use('/api/profile', profileRouter)
  │     挂载画像路由
  │
  ├─ ⑩ app.use('/api/health', healthRouter)
  │     挂载健康检查路由
  │
  ├─ ⑪ app.use('/api/privacy', privacyRouter)
  │     挂载隐私路由
  │
  ├─ ⑫ app.use('/api/test', testRouter)
  │     挂载测试路由（仅开发环境）
  │
  └─ ⑬ app.listen(config.port)
        监听端口，开始接收请求
        → console.log(`🚀 服务跑在 ${config.port}`)
```

---

## 四、配置层 `config/index.ts`

```
config 对象（单例）
  │
  │  被谁调：几乎所有文件都 import config
  │  干什么：集中管理所有环境变量，给默认值
  │
  ├─ port           process.env.PORT || 3000
  ├─ jwtSecret      process.env.JWT_SECRET || 'dev-secret'
  ├─ dbPath          process.env.DB_PATH || './data/dazi.db'
  ├─ rateLimitPerHour process.env.RATE_LIMIT || 20
  ├─ llm.apiKey      process.env.LLM_API_KEY
  ├─ llm.baseURL     'https://api.deepseek.com'
  ├─ llm.model       'deepseek-chat'
  ├─ redis.url       process.env.REDIS_URL
  └─ isProd          process.env.NODE_ENV === 'production'
```

---

## 五、核心层 `core/*`

### 5.1 `core/blackboard.ts`

```
createBlackboard()
   │
   │  被谁调：getSession（orchestrator）→ 每个用户一个黑板
   │  干什么：造一个黑板，返回一个对象（闭包！外部只能调方法，改不了内部数据）
   │
   ├─ 内部变量（外部看不到）：
   │   entries: BlackboardEntry[] = []       ← 便条数组
   │   keyIndex: Map<string, number>         ← key→数组位置（O(1) 查找加速器）
   │
   └─ 返回的对象有 7 个方法：

   write(agentId, key, value, category='decision')
     │
     │  被谁调：Agent execute() 内部，写完结果贴黑板
     │  比如：ctx.blackboard.write('profile-agent', 'latest_profile', 画像, 'profile_patch')
     │  覆盖语义：同一个 key 后写覆盖先写（'latest_profile' 只需最新值）
     │
     ├─ ① keyIndex.has(key) 查：这个便条标题之前贴过没？
     │   │
     │   ├─ 贴过：
     │   │   idx = keyIndex.get(key)           ← 拿到旧位置
     │   │   entries[idx] = 新便条              ← 覆盖旧便条
     │   │
     │   └─ 没贴过：
     │       idx = entries.length               ← 新位置（数组末尾）
     │       keyIndex.set(key, idx)             ← 建索引
     │       entries.push(新便条)                ← 塞进数组
     │
     └─ ② 便条对象 = { agentId, key, value, category, timestamp: Date.now() }

   read(key)
     │
     │  被谁调：Agent 需要读别人贴的便条时
     │  比如：MatchAgent 调 blackboard.read('latest_profile')
     │
     ├─ keyIndex.get(key) → 数字位置（没找到返回 undefined）
     │   有 → entries[idx] → 返回便条对象
     │   没有 → undefined
     └─ 时间复杂度：O(1)（直接 Map 查）

   readAll()
     │
     │  干什么：返回全部便条（调试用）
     └─ return [...entries]  ← 拷贝一份（不暴露内部引用）

   readCategory(cat)
     │
     │  干什么：按分类返回便条
     │  比如：readCategory('profile_patch') → 所有画像相关便条
     └─ return entries.filter(e => e.category === cat)

   has(key)
     │
     │  被谁调：Agent 先问"有这个便条吗？"再读
     │  比如：MatchAgent 先 has('latest_profile') → 有才 read
     └─ return entries.some(e => e.key === key)

   snapshot()
     │
     │  干什么：给当前所有便条拍个"快照"（用于跨请求传递）
     └─ 返回 { entries: [...entries] }

   clear()
     │
     │  被谁调：resetSession 时清理
     ├─ entries.length = 0
     └─ keyIndex.clear()

   size()
     │
     └─ return entries.length
```

**接口定义（给别的文件 import type 用）：**

```
BBCategory         便条分类（5 种）
                   'profile_patch' | 'match_result' | 'icebreaker' | 'warning' | 'decision'

BlackboardEntry    一条便条
                   { agentId, key, value, category, timestamp }

BlackboardSnapshot 黑板快照
                   { entries: BlackboardEntry[] }

Blackboard         黑板接口（规定了 7 个方法签名）
                   { write, read, readAll, readCategory, has, snapshot, clear, size }
```

### 5.2 `core/orchestrator.ts`

```
全局变量：
  sessions = new Map<string, SessionContext>()   ← 所有用户的工单都在这里（内存存储）

getSession(userId, tenantId)
   │
   │  被谁调：所有路由进来第一件事（chat/match/dm/profile）
   │  干什么：拿当前用户的会话，没有就建一个（建会话逻辑直接写在这里，不拆函数）
   │
   ├─ let ctx = sessions.get(userId)
   │   有 → 直接返回 ctx
   │
   │   没有 → 现场建一个 ctx：
   │     ctx = {
   │       userId,                          ← 谁的用户
   │       tenantId,                        ← 哪个租户
   │       state: 'CHATTING',               ← 初始状态
   │       blackboard: createBlackboard(),  ← 配一块黑板
   │       loopDetector: createLoopDetector(),  ← 配防死循环器
   │       budget: createBudgetTracker(),       ← 配 token 账本（默认 20 万）
   │       profileConfidence: 0,                ← 画像置信度从 0 开始
   │       // lastMatchedAt 不写 → undefined
   │     }
   │     sessions.set(userId, ctx)  ← 存进花名册
   │
   └─ return ctx（旧的或刚建的）

resetSession(userId)
   │
   │  被谁调：routes/privacy.ts 的 DELETE /privacy/account
   │  干什么：用户删账号时，把工单从内存里删掉
   │
   └─ sessions.delete(userId)  ← 直接删掉，下次再来会重建

transition(ctx, signal)
   │
   │  被谁调：profileAgent 抽完画像、routes/match.ts 收到按钮点击 / Agent 跑完
   │  干什么：状态机核心 — 用 switch-case 根据信号类型直接改 ctx.state
   │  返回值：SessionState（转换后的新状态字符串，如 'PROFILE_READY'）
   │
   │  状态机（6 个状态）：
   │   CHATTING → PROFILE_READY → MATCHING → MATCHED → ICEBREAKING → DONE
   │
   │  ── 实际转移规则（switch-case 实现）──
   │
   │  case 'profile_updated':
   │    ├─ 更新 ctx.profileConfidence（如果信号带了 confidence）
   │    └─ 如果 ctx.state === 'CHATTING' 且 confidence ≥ 0.65
   │       → ctx.state = 'PROFILE_READY'
   │
   │  case 'match_requested':
   │    如果 ctx.state ∈ {CHATTING, PROFILE_READY, MATCHED}
   │    → ctx.state = 'MATCHING'
   │    （CHATTING 也允许：画像不够也给兜底匹配）
   │
   │  case 'match_done':
   │    如果 ctx.state === 'MATCHING'
   │    → ctx.state = 'MATCHED'，同时记 ctx.lastMatchedAt = Date.now()
   │
   │  case 'icebreak_requested':
   │    如果 ctx.state === 'MATCHED'
   │    → ctx.state = 'ICEBREAKING'
   │
   │  case 'icebreak_done':
   │    如果 ctx.state === 'ICEBREAKING'
   │    → ctx.state = 'DONE'
   │
   │  ⚠️ 非法信号直接静默忽略（不报错，不跳状态）
   │     如 MATCHING 中再收到 match_requested → 什么都不做
   │
   └─ 最后 return ctx.state（调用方拿到新状态决定后续做什么）
```

### 5.3 `core/tokenBudget.ts`

```
createBudgetTracker(totalBudget = 200_000)
   │
   │  被谁调：getSession() 给每个会话配一个
   │  干什么：追踪 Token 用量，到阈值给提醒
   │
   ├─ 内部变量：
   │   inputTokens: 0           ← 累计输入 token
   │   outputTokens: 0          ← 累计输出 token
   │   roundOutputs: number[]   ← 最近 5 轮的输出（看产出是否递减）
   │   NUDGE = 0.75             ← 75% 软提醒
   │   FORCE = 0.90             ← 90% 强制停
   │
   └─ 返回的方法：

   recordInput(tokens)
     │  被谁调：llmClient/chatStream 收到 usage 后调
     └─ inputTokens += Math.max(0, Math.round(tokens))

   recordOutput(tokens)
     │  被谁调：llmClient/chatStream 收到 usage 后调
     ├─ outputTokens += t
     ├─ roundOutputs.push(t)
     └─ if (roundOutputs.length > 5) roundOutputs.shift()  ← 只留最近 5 轮

   getStatus()
     │  被谁调：Agent 每轮决策前查
     │
     ├─ used = inputTokens + outputTokens
     ├─ pct = used / totalBudget
     ├─ shouldNudge = pct ∈ [0.75, 0.90)
     ├─ shouldForceStop = pct ≥ 0.90
     ├─ diminishing = roundOutputs.length ≥ 3
     │                 && roundOutputs.every(t => t < 200)
     │                 && pct > 0.5
     │  （含义：连续 3 轮输出少于 200 字 → AI 在水）
     │
     └─ return { used, remaining, pct, shouldNudge, shouldForceStop, diminishing, totalBudget }

   getNudgeMessage()
     │  被谁调：Agent 决策循环里查"该不该提醒用户"
     │
     ├─ shouldForceStop → "[系统] Token 预算耗尽 (90%)"
     ├─ shouldNudge && diminishing → "[系统] 预算 X%，产出递减"
     ├─ shouldNudge → "[系统] 预算 X%，聚焦核心字段"
     └─ 否则 → null
```

### 5.4 `core/antiloop.ts`

```
createLoopDetector()
   │
   │  被谁调：getSession() 给每个会话配一个
   │  干什么：监控 Agent 是否陷入死循环
   │
   ├─ 内部变量：
   │   actionLog: ActionRecord[]    ← 工具调用历史
   │   consecutiveErrors: 0         ← 连续报错次数
   │   roundsWithoutProgress: 0     ← 没进展的轮数
   │
   └─ 返回的方法：

   recordAction(toolName, args, result)
     │  被谁调：Agent 每次调 LLM 前后记录
     │
     ├─ key = `${toolName}:${makeArgsKey(args)}`
     │   （把参数 hash 一下做 key，相同参数 = 相同调用）
     │
     ├─ 已存在 → existing.count++
     │  不存在 → actionLog.push({toolName, argsKey:key, count:1})
     │
     └─ 根据 result 更新计数器：
        - result.length > 50（产出正常）→ 重置计数
        - result.includes('Error') → consecutiveErrors++, roundsWithoutProgress++
        - 其他 → roundsWithoutProgress++

   checkLoop()
     │  被谁调：Agent 每轮循环开头查
     │
     ├─ 遍历 actionLog：
     │   任何 count ≥ 3 → { isLoop: true, message: "检测到循环：xxx 被连续调用 3 次" }
     │
     ├─ consecutiveErrors ≥ 5 → { isLoop: true, message: "连续 5 次出错" }
     │
     └─ 否则 → { isLoop: false, message: '' }

   isStuck()
     │  被谁调：Agent 决定要不要放弃当前任务
     └─ return roundsWithoutProgress >= 10 || consecutiveErrors >= 10
```

### 5.5 `core/structuredOutput.ts`

```
quickFixJSON(text)
   │
   │  被谁调：extractJSON() 内部先调它修一遍
   │  干什么：修 LLM 输出常见的 JSON 格式错误
   │
   ├─ .trim()                                ← 去首尾空白
   ├─ 去掉 ```json ... ``` 包裹               ← LLM 爱用 markdown 包 JSON
   ├─ 去掉尾随逗号 ,} → }                     ← JSON 不允许尾逗号
   ├─ 单引号 ' → 双引号 "                     ← JSON 只认双引号
   ├─ 给无引号的 key 加引号                    ← LLM 偶尔输出 {name: "x"}
   └─ NaN/Infinity → null                    ← JSON 没这俩

extractJSON(text)
   │
   │  被谁调：profileAgent/matchAgent 解析 LLM 输出
   │  干什么：从一坨文本里抠出 JSON 对象
   │
   ├─ 直接 JSON.parse(quickFixJSON(text))     ← 优先尝试整体解析
   │   成功 → 返回
   │
   ├─ 失败 → 用正则 /\{[\s\S]*\}/ 抠出 {...} 那段
   │   再 JSON.parse
   │   成功 → 返回
   │
   └─ 都失败 → 返回 null

validateJSON(data, schema)
   │
   │  被谁调：profileAgent/matchAgent 验证结构
   │  干什么：按 schema 验证 data 是否符合
   │
   ├─ errors: string[] = []
   ├─ _validate(data, schema, '$', errors)
   │   递归检查：
   │   - type 是否匹配（string/number/object/array/boolean）
   │   - required 字段是否存在
   │   - 字段值是否符合约束
   │
   └─ return { valid: errors.length === 0, errors }
```

### 5.6 `core/tracer.ts`

```
createTracer()
   │
   │  被谁调：orchestrator 给每个会话配一个
   │  干什么：记录 Agent 执行过程，写 trace.jsonl
   │
   └─ 返回：

   start(name, opts)
     │  被谁调：Agent.run() 开头
     │  干什么：开始一段追踪
     ├─ spanId = randomUUID()
     ├─ 记录 { startTime, name, opts }
     └─ return spanId

   end(spanId, result)
     │  被谁调：Agent.run() 结尾
     ├─ 算 duration = now - startTime
     └─ 写一行到 trace 日志

   event(name, payload)
     │  被谁调：状态转移、关键节点
     └─ 写一行事件日志
```

---

## 六、数据库层 `db/*`

### 6.1 `db/index.ts`

```
getDB()
   │
   │  被谁调：所有要操作数据库的文件
   │  干什么：拿 SQLite 连接（单例！整个进程一个）
   │
   ├─ if (db) return db   ← 单例
   │
   ├─ mkdirSync(dirname(dbPath), { recursive: true })
   │  （确保数据目录存在）
   │
   ├─ db = new Database(config.dbPath)
   │  （打开 SQLite 文件）
   │
   ├─ db.pragma('journal_mode = WAL')      ← 写前日志（并发性能↑）
   ├─ db.pragma('foreign_keys = ON')       ← 开外键约束
   └─ db.pragma('synchronous = NORMAL')    ← 平衡安全和性能

closeDB()
   │  被谁调：gracefulShutdown()
   └─ db.close()
```

### 6.2 `db/schema.ts`

```
initSchema(db)
   │
   │  被谁调：bootstrap() 启动时
   │  干什么：建表（IF NOT EXISTS，已存在不重建）
   │
   └─ 执行建表 SQL：

   tenants             多租户表
     id TEXT PK
     name TEXT

   users               用户表
     id TEXT PK
     tenant_id TEXT → tenants.id
     username TEXT
     password_hash TEXT              ← bcrypt 哈希存
     display_name TEXT
     created_at INTEGER              ← unixepoch()
     UNIQUE(tenant_id, username)     ← 同租户用户名唯一

   profiles            用户画像表
     user_id TEXT PK → users.id CASCADE
     tenant_id TEXT
     version INTEGER DEFAULT 0      ← 乐观锁用
     profile_json TEXT DEFAULT '{}' ← 画像 JSON
     confidence REAL DEFAULT 0
     embedding TEXT                 ← 向量（JSON 数字数组）
     updated_at INTEGER

   profile_patches     画像变更历史
     id INTEGER PK AUTOINCREMENT
     user_id TEXT → users.id
     version INTEGER
     patch_json TEXT                ← 这次的增量
     created_at INTEGER

   conversations       聊天记录
     id INTEGER PK AUTOINCREMENT
     session_id TEXT
     tenant_id TEXT
     user_id TEXT → users.id
     role TEXT                     ← 'user' | 'assistant' | 'system'
     content TEXT
     reasoning TEXT                ← AI 思考过程
     tokens_in INTEGER
     tokens_out INTEGER
     created_at INTEGER

   dm_rooms             私聊房间
     id TEXT PK
     tenant_id TEXT
     user_a TEXT → users.id
     user_b TEXT → users.id
     created_at INTEGER
     last_message_at INTEGER DEFAULT 0
     UNIQUE(tenant_id, user_a, user_b)

   dm_messages          私聊消息
     id INTEGER PK AUTOINCREMENT
     room_id TEXT → dm_rooms.id
     tenant_id TEXT
     sender_id TEXT → users.id
     content TEXT
     read_at INTEGER              ← 是否已读
     created_at INTEGER

   rate_counters         限流计数表
     key TEXT PK                  ← "userId:hour:bucket"
     count INTEGER
     expires_at INTEGER

   mbti_profiles         MBTI 画像表
     user_id TEXT PK → users.id
     type TEXT                     ← 'INTJ' / 'UNKNOWN'
     confidence REAL
     dimensions_json TEXT          ← 4 维度详情
     updated_at INTEGER

   trace_logs            追踪日志表
     id INTEGER PK AUTOINCREMENT
     ts INTEGER
     kind TEXT
     name TEXT
     level TEXT
     payload_json TEXT
     result_json TEXT
     duration_ms INTEGER
     user_id TEXT
     trace_id TEXT
```

### 6.3 `db/vectorStore.ts`

```
cosine(a, b)
   │
   │  被谁调：recallByVector() 算相似度
   │  干什么：余弦相似度（两个向量的夹角余弦）
   │
   ├─ len = min(a.length, b.length)  ← 长度对齐
   ├─ dot = Σ a[i]*b[i]              ← 点积
   ├─ na  = Σ a[i]²                  ← a 的模长平方
   ├─ nb  = Σ b[i]²                  ← b 的模长平方
   ├─ if (na===0 || nb===0) return 0 ← 零向量返回 0
   └─ return dot / (sqrt(na) * sqrt(nb))
       范围 [-1, 1]，越接近 1 越相似

recallByVector(queryVec, tenantId, excludeUserId, topK)
   │
   │  被谁调：matchAgent.execute() 找候选
   │  干什么：向量召回，找 top-K 个最相似用户
   │
   ├─ SELECT user_id, embedding, profile_json, confidence, display_name
   │   FROM profiles p JOIN users u ON u.id = p.user_id
   │   WHERE p.tenant_id = ? AND p.user_id != ? AND p.embedding IS NOT NULL
   │   （拉出同租户、排除自己、有向量的所有用户）
   │
   ├─ rows.map(r => {
   │     vec = JSON.parse(r.embedding)         ← 字符串转数组
   │     score = cosine(queryVec, vec)          ← 算相似度
   │     return { userId: r.user_id, score, profile: JSON.parse(r.profile_json) }
   │   })
   │
   ├─ .sort((a, b) => b.score - a.score)        ← 按相似度降序
   │
   └─ .slice(0, topK)                           ← 只取前 K 个

saveVector(userId, vec)
   │
   │  被谁调：profileAgent 写入画像后更新向量
   └─ UPDATE profiles SET embedding = ?, updated_at = ? WHERE user_id = ?
       （把向量序列化成 JSON 存进去）
```

---

## 七、Agent 层 `agents/*`

### 7.1 `agents/baseAgent.ts`

```
class BaseAgent {
   │
   │  被谁调：profileAgent/matchAgent/iceBreakerAgent 都继承它
   │  干什么：通用 Agent 模板，规定 execute/run/validate 接口
   │
   ├─ name: string                    ← Agent 名字（如 'profile-agent'）

   async run(input, ctx): Promise<Result>
     │  被谁调：路由（chat.ts/match.ts）
     │  干什么：Agent 入口，包了 try/catch + tracing
     │
     ├─ spanId = ctx.tracer.start(`agent:${this.name}`)
     │
     ├─ try:
     │   ├─ validate(input)               ← 子类实现，校验输入
     │   ├─ result = await execute(input, ctx)  ← 子类实现，真正的活
     │   ├─ ctx.tracer.end(spanId, result)
     │   └─ return { ok: true, data: result }
     │
     └─ catch (err):
         ctx.tracer.end(spanId, { error: err.message })
         return { ok: false, error: err.message }

   abstract validate(input): void    ← 子类必须实现
   abstract async execute(input, ctx): any   ← 子类必须实现
}
```

### 7.2 `agents/profileAgent.ts`

```
class ProfileAgent extends BaseAgent {
   │
   │  name = 'profile-agent'
   │
   │  被谁调：
   │   - chat.ts: profileAgent.streamReply()（聊天回复）
   │   - chat.ts: profileAgent.run()（异步抽画像）
   │
   ├─ validate(input)
   │     检查 input.recentMessages 是数组且非空
   │
   ├─ async execute(input, ctx) → ProfilePatch
   │     │
   │     │  干什么：从对话里抽出用户画像
   │     │
   │     ├─ ① 检查 ctx.budget.shouldForceStop → 直接返回空 patch
   │     │   （预算耗尽就别调 LLM 了）
   │     │
   │     ├─ ② 检查 ctx.loop.checkLoop().isLoop → 抛 LoopError
   │     │   （陷入循环就停）
   │     │
   │     ├─ ③ 选择路径：
   │     │   config.llm.apiKey 存在 → extractProfileLLM()
   │     │   不存在 → extractProfileRules()（规则兜底）
   │     │
   │     ├─ ④ ctx.loop.recordAction('extractProfile', input, result)
   │     │
   │     ├─ ⑤ ctx.blackboard.write('profile-agent', 'latest_profile',
   │     │                          patch, 'profile_patch')
   │     │   （贴黑板，给别的 Agent 看）
   │     │
   │     ├─ ⑥ profileAdapter.onProfileExtracted(ctx.userId, patch)
   │     │   （同步到 MemoryBus）
   │     │
   │     ├─ ⑦ saveProfilePatch(ctx.userId, patch)
   │     │   （存数据库）
   │     │
   │     └─ ⑧ return patch

   extractProfileLLM(messages)
     │  干什么：调 LLM 抽画像
     │
     ├─ 拼 system prompt：
     │   "你是画像抽取器，输出 JSON: {interests:[{name,weight}], socialStyle:{...}}"
     │
     ├─ profileTagsToText() 把当前画像塞进 prompt 当上下文
     │
     ├─ 调 chatStream([
     │     {role:'system', content: systemPrompt},
     │     ...messages.slice(-10)   ← 只取最近 10 条，省 token
     │   ], { maxTokens: 1024, temperature: 0.3 })
     │   （温度低，输出稳定）
     │
     ├─ extractJSON(result.text)   ← 三层修复解析
     │
     ├─ validateJSON(data, profileSchema)  ← 验证结构
     │   失败 → 抛 ParseError
     │
     └─ ctx.budget.recordInput(result.usage.inputTokens)
        ctx.budget.recordOutput(result.usage.outputTokens)

   extractProfileRules(messages)
     │  干什么：规则兜底，从消息里抠关键词
     │
     ├─ for msg in messages:
     │   ├─ 匹配"我喜欢/我爱/最近在玩" → 加兴趣
     │   ├─ 匹配"内向/外向/独处" → 设 socialStyle
     │   └─ 匹配"周末/晚上/早上" → 设时间段
     │
     └─ return patch

   async streamReply(messages, profile, onDelta, ctx, signal, onReasoning, sessionId)
     │  被谁调：chat.ts 流式回复
     │  干什么：生成 AI 回复，边生成边推前端
     │
     ├─ llmEnabled?
     │   │
     │   ├── 有 Key → streamReplyLLM()
     │   │   │
     │   │   ├─ profileToText(profile) 把画像变文字
     │   │   │   {interests:[{name:'跑步'}], socialStyle:{energy:'introvert'}}
     │   │   │   → "兴趣: 跑步  社交风格: introvert"
     │   │   │
     │   │   ├─ 拼 system prompt：
     │   │   │   "你是搭子匹配官，像朋友聊天，不要审问，
     │   │   │    每轮只问一个方向，当前已知画像：xxx"
     │   │   │
     │   │   └─ chatStream([system, ...messages], {onDelta, onReasoning})
     │   │       │
     │   │       └─ 真的调 DeepSeek API，SSE 流式收字
     │   │          → onDelta("听") → 推前端聊天气泡
     │   │          → onReasoning("用户在分享...") → 推前端思考框
     │   │          → 收到 [DONE] 结束
     │   │
     │   └── 没 Key → templateReply(profile)
     │       │
     │       ├─ 根据画像阶段选模板：
     │       │   - 画像空 → "嗨，先随便聊聊～你平时周末怎么过？"
     │       │   - 1 个兴趣 → "听起来你对跑步挺感兴趣，最近还在做吗？"
     │       │   - 3 个兴趣但不知风格 → "喜欢一个人还是有人一起？"
     │       │   - 完整 → "我觉得可以点开始匹配了"
     │       │
     │       └─ 逐字符 onDelta，每个字停 8ms 模拟打字
     │
     └─ return { text, reasoning }
}
```

### 7.3 `agents/matchAgent.ts`

```
class MatchAgent extends BaseAgent {
   │
   │  name = 'match-agent'
   │  被谁调：match.ts: matchRouter.post('/run')
   │
   ├─ validate(input)
   │     检查 input.limit 是正整数
   │
   ├─ async execute(input, ctx)
   │     │
   │     │  干什么：找搭子
   │     │
   │     ├─ ① myProfile = profileAdapter.getUserProfile(ctx.userId)
   │     │   从 MemoryBus 拿当前用户画像
   │     │
   │     ├─ ② myVec = await embedProfile(myProfile)
   │     │   把画像转向量（services/embedding.ts）
   │     │
   │     ├─ ③ excluded = profileAdapter.getExcludedCandidates(ctx.userId)
   │     │   拿最近匹配过的，避免重复推
   │     │
   │     ├─ ④ candidates = recallByVector(
   │     │     myVec, ctx.tenantId, ctx.userId, input.limit * 3
   │     │   )
   │     │   向量召回，多召回 3 倍，后面再筛
     │     │
     │     ├─ ⑤ excluded.filter → 排除最近匹配过的
     │     │
     │     ├─ ⑥ for each candidate:
     │     │   算 6 维分数：
     │     │   ├─ interestScore     兴趣重合度（cosine 兴趣向量）
     │     │   ├─ scheduleScore    时间段重合
     │     │   ├─ socialStyleScore 社交风格匹配
     │     │   ├─ energyScore      内/外向匹配
     │     │   ├─ mbtiScore        MBTI 相性（matchAgentMbtiAdapter）
     │     │   └─ distanceScore    距离分（如果有位置）
     │     │
     │     │   overallScore = Σ weight[i] * score[i]
     │     │
     │     ├─ ⑦ candidates.sort(overallScore desc).slice(0, input.limit)
     │     │
     │     ├─ ⑧ for each candidate:
     │     │   profileAdapter.recordMatch(ctx.userId, candidate.userId,
     │     │                              overallScore, dimScores, tagTrace)
     │     │   记进 MemoryBus（避免重复推）
     │     │
     │     ├─ ⑨ ctx.blackboard.write('match-agent', 'match_result',
     │     │                          candidates, 'match_result')
     │     │
     │     └─ ⑩ return {
     │           candidates: [...],
     │           totalCount: N,
     │           myProfileText: profileToText(myProfile)
     │         }

   embedProfile(profile)
     │  被谁调：execute() 内部
     └─ 调 services/embedding.ts 的 embed 函数
        把画像对象转成 64 维向量
}
```

### 7.4 `agents/iceBreakerAgent.ts`

```
class IceBreakerAgent extends BaseAgent {
   │
   │  name = 'icebreaker-agent'
   │  被谁调：match.ts: matchRouter.post('/icebreaker')
   │
   ├─ validate(input)
   │     检查 targetUserId 存在
   │
   ├─ async execute(input, ctx)
   │     │
   │     │  干什么：给俩人生成破冰话题
   │     │
   │     ├─ ① myProfile = ctx.blackboard.read('latest_profile')
   │     │   peerProfile = profileAdapter.getPeerProfile(input.targetUserId)
   │     │
   │     ├─ ② commonInterests = input.commonInterests
   │     │   （匹配时算好的共同兴趣）
   │     │
   │     ├─ ③ llmEnabled?
     │     │   ├─ 有 Key → generateLLM()
     │     │   └── 没 Key → generateRules()
     │     │
     │     ├─ ④ ctx.blackboard.write('icebreaker-agent', 'icebreakers',
     │     │                          result, 'icebreaker')
     │     │
     │     ├─ ⑤ iceBreakerAdapter.recordInteraction(...)
     │     │   记进 MemoryBus
     │     │
     │     └─ ⑥ return { icebreakers: [...], source: 'llm'|'rules' }

   generateLLM(myProfile, peerProfile, commonInterests)
     │  干什么：调 LLM 生成破冰
     │
     ├─ 拼 prompt：
     │   "为这俩人生成 3 个破冰话题，
     │    我的兴趣: [...], 对方的兴趣: [...],
     │    共同兴趣: [...],
     │    输出 JSON: [{topic, opener, why}]"
     │
     ├─ chatStream([system, user], { maxTokens: 512, temperature: 0.8 })
     │   （温度高，更发散）
     │
     └─ extractJSON + validateJSON

   generateRules(myProfile, peerProfile, commonInterests)
     │  干什么：规则兜底
     │
     ├─ for interest in commonInterests:
     │   push { topic: interest, opener: `你也喜欢${interest}？`, why: '共同兴趣' }
     │
     └─ return top 3
}
```

### 7.5 `agents/profileSchema.ts`

```
profileSchema
   │  干什么：画像的 JSON Schema 定义
   │  被谁调：validateJSON() 校验 LLM 输出
   │
   └─ {
       type: 'object',
       properties: {
         interests: {
           type: 'array',
           items: { type: 'object', properties: { name, weight } }
         },
         socialStyle: { properties: { energy, communication } },
         schedule: { properties: { weekday, weekend } },
         location: { type: 'string' }
       }
     }

profileToText(profile)
   │  被谁调：profileAgent.streamReply、matchAgent.execute
   │  干什么：把画像对象变成一句话给 LLM 看
   │
   ├─ "兴趣: 跑步, 看书  社交风格: introvert  时间: 周末"
   └─ 没有 → "（暂无画像）"

profileTagsToText(tags)
   │  被谁调：memoryBus 读出来的标签转文字
   └─ "标签: #跑步 #夜猫子 #内向"
```

---

## 八、服务层 `services/*`

### 8.1 `services/auth.ts`

```
hashPassword(plain)
   │  被谁调：registerUser()
   └─ bcrypt.hashSync(plain, 12)   ← 12 轮 bcrypt 哈希

verifyPassword(plain, hash)
   │  被谁调：loginUser()
   └─ bcrypt.compareSync(plain, hash)

signToken(payload)
   │  被谁调：registerUser()、loginUser()
   │  payload = { sub: userId, tenant, username }
   └─ jwt.sign(payload, config.jwtSecret, { expiresIn: '7d' })

verifyToken(token)
   │  被谁调：middleware/auth.ts requireAuth
   └─ jwt.verify(token, config.jwtSecret)
       失败 → 抛错（过期/伪造）

registerUser(input, tenantId='default')
   │  被谁调：routes/auth.ts /register
   │  干什么：注册新用户
   │
   ├─ 校验 username/password 长度
   ├─ 查重：SELECT * FROM users WHERE tenant_id=? AND username=?
   │   有 → 抛 "用户名已存在"
   ├─ id = randomUUID()
   ├─ INSERT INTO users (id, tenant_id, username, password_hash, display_name)
   │   VALUES (?, ?, ?, ?, ?)
   └─ return { id, tenantId, username, displayName }

loginUser(input, tenantId='default')
   │  被谁调：routes/auth.ts /login
   │
   ├─ SELECT * FROM users WHERE tenant_id=? AND username=?
   │   没有 → 抛 "用户名或密码错误"
   ├─ verifyPassword(input.password, row.password_hash)
   │   不对 → 抛 "用户名或密码错误"
   └─ return { id, tenantId, username, displayName }

toPublicUser(user)
   │  被谁调：routes/auth.ts 返回给前端
   └─ return { id, username, displayName }
       （去掉 password_hash，不暴露）
```

### 8.2 `services/rateLimiter.ts`

```
consumeRateLimit(userId)
   │
   │  被谁调：chat.ts 每次发消息前
   │  干什么：限流，每小时 20 条
   │
   ├─ now = Date.now()
   ├─ hourBucket = floor(now / 3600000)     ← 当前小时桶
   ├─ key = `${userId}:hour:${hourBucket}`
   ├─ expiresAt = (hourBucket + 1) * 3600000
   │
   ├─ DELETE FROM rate_counters WHERE expires_at < now
   │   （清理过期桶）
   │
   ├─ current = SELECT count FROM rate_counters WHERE key=?
   │
   ├─ if (current >= config.rateLimitPerHour):
   │   return { allowed: false, remaining: 0,
   │            retryAfterSec: ceil((expiresAt - now)/1000) }
   │
   ├─ if (current === 0):
   │   INSERT INTO rate_counters (key, count, expires_at) VALUES (?, 1, ?)
   │  else:
   │   UPDATE rate_counters SET count = count+1 WHERE key = ?
   │
   └─ return { allowed: true, remaining: 20-current-1, retryAfterSec: 0 }
```

### 8.3 `services/llmClient.ts`

```
chatStream(messages, callbacks, opts)
   │
   │  被谁调：profileAgent、iceBreakerAgent、aiBotReplier
   │  干什么：调 DeepSeek API，SSE 流式收字
   │
   ├─ POST `${config.llm.baseURL}/chat/completions`
   │   body: {
   │     model: config.llm.model,
   │     messages,           ← 完整对话
   │     stream: true,       ← 流式
   │     max_tokens: opts.maxTokens || 8192,
   │     temperature: opts.temperature || 0.7
   │   }
   │   headers: {
   │     Authorization: `Bearer ${config.llm.apiKey}`,
   │     'Content-Type': 'application/json'
   │   }
   │
   ├─ response.body 是 ReadableStream
   │
   ├─ buffer = ''
   │
   ├─ for await (chunk of response.body):
   │   │
   │   ├─ buffer += chunk.toString()
   │   │
   │   ├─ 找最后一个 \n\n 分隔
   │   │   之前：完整 SSE 事件，解析
   │   │   之后：留在 buffer 等下个 chunk
   │   │   （防 chunk 切断！）
   │   │
   │   └─ for each event:
   │       ├─ 解析 data: {...}
   │       │
   │       ├─ if (delta.reasoning_content):
   │       │   callbacks.onReasoning(delta.reasoning_content)
   │       │   → 推前端"思考框"
   │       │
   │       ├─ if (delta.content):
   │       │   text += delta.content
   │       │   callbacks.onDelta(delta.content)
   │       │   → 推前端聊天气泡
   │       │
   │       └─ if (data === '[DONE]') break
   │
   └─ return {
       text,
       reasoning,
       usage: { inputTokens, outputTokens }
     }
```

### 8.4 `services/embedding.ts`

```
embed(text)
   │
   │  被谁调：matchAgent.embedProfile()
   │  干什么：把文本转成向量
   │
   ├─ 有 OPENAI_API_KEY → 调 OpenAI embeddings API
   │   POST https://api.openai.com/v1/embeddings
   │   body: { model: 'text-embedding-3-small', input: text }
   │   → data[0].embedding (1536 维)
   │
   └─ 没 Key → localHashEmbed(text)
       本地 hash 嵌入（伪向量，64 维）
       把 text 分词后 hash 到 64 个桶，做 TF-IDF
       → 64 维向量

embedProfile(profile)
   │  被谁调：matchAgent.execute()
   └─ 把 profile 转文字 → embed() → 向量
```

### 8.5 `services/aiBotReplier.ts`

```
BOTS
   │
   │  干什么：4 个 AI 机器人，不同 MBTI 性格
   │
   ├─ alice_intj  Alice  INTJ  战略家  "你是 Alice，资深软件架构师..."
   ├─ bob_enfp    Bob    ENFP  唤启者  "你是 Bob，热情的创业者..."
   ├─ carol_isfj  Carol  ISFJ  守护者  "你是 Carol，温柔的护士..."
   └─ david_entp  David  ENTP  辩论家  "你是 David，犀利的律师..."

getBotProfileByUserId(userId)
   │  被谁调：dm.ts 判断消息是否来自 bot
   └─ 遍历 BOTS 找匹配的

replyToUser(botUserId, senderName, roomId, tenantId)
   │
   │  被谁调：dm.ts 收到用户消息后异步触发
   │  干什么：让 bot 回复用户
   │
   ├─ ① profile = getBotProfileByUserId(botUserId)
   │   没有 → return（不是 bot）
   │
   ├─ ② history = SELECT sender_id, content FROM dm_messages
   │     WHERE room_id = ? ORDER BY id DESC LIMIT 10
   │   拉最近 10 条对话
   │
   ├─ ③ 拼 messages = [{role:'system', content: profile.systemPrompt}, ...history]
   │
   ├─ ④ chatStream(messages, {
   │     onDelta: (text) => replyText += text
   │   }, { maxTokens: 256, temperature: 0.8 })
   │   （bot 回复温度高一点，更生动）
   │
   └─ ⑤ INSERT INTO dm_messages (room_id, tenant_id, sender_id, content, created_at)
       VALUES (?, ?, ?, ?, ?)
       把 bot 的回复存数据库
```

### 8.6 `services/traceLogger.ts`

```
trace.fn(name, fn, opts)
   │
   │  被谁调：包装异步函数，记日志
   │
   ├─ start = Date.now()
   ├─ try:
   │   result = await fn()
   │   write({
   │     ts: start, kind: 'fn', level: 'info', name,
   │     userId: opts.userId, traceId: opts.traceId,
   │     durationMs: Date.now() - start,
   │     payload: opts.payload, result: safeSample(result)
   │   })
   │   return result
   │
   └─ catch (err):
       write({ kind: 'fn', level: 'error', name, error: err.message })
       throw err

trace.event(name, payload, opts)
   │  被谁调：状态转移、关键节点
   └─ write({ kind: 'event', name, payload, level: opts.level || 'info' })

trace.token(info)
   │  被谁调：llmClient 收到 usage
   └─ write({
       kind: 'token',
       model: info.model,
       prompt: info.prompt,
       completion: info.completion,
       costYuan: info.costYuan
     })

write(entry)
   │  干什么：把 trace 写到 trace_logs 表 + stdout
   ├─ INSERT INTO trace_logs (ts, kind, name, level, payload_json, ...)
   └─ console.log(JSON.stringify(entry))

safeSample(value)
   │  干什么：截断超长值，避免日志爆炸
   └─ JSON.stringify(value).slice(0, 500)
```

---

## 九、中间件 `middleware/auth.ts`

```
requireAuth(req, res, next)
   │
   │  被谁调：所有需要登录的路由都挂它
   │  干什么：从 Cookie 取 JWT 验证，注入 req.user
   │
   ├─ ① token = req.cookies[authCookieName]
   │   （从 Cookie 取名为 'dazi_token' 的 JWT）
   │   没有 → return res.status(401).json({ error: '未登录' })
   │
   ├─ ② try:
   │     payload = verifyToken(token)
   │     （jwt.verify 解密，过期/伪造会抛）
   │   catch:
   │     return res.status(401).json({ error: 'token 无效或已过期' })
   │
   ├─ ③ req.user = {
   │     id: payload.sub,
   │     tenantId: payload.tenant,
   │     username: payload.username
   │   }
   │   （挂到 req 上，后续路由能直接 req.user.id 用）
   │
   └─ ④ next()  ← 放行
```

---

## 十、路由层 `routes/*`（API 接口数据流）

### 10.1 `routes/auth.ts`

```
POST /api/auth/register
   │
   │  被谁调：前端注册页
   │  入参：{ username, password, displayName }
   │  返回：{ user: {id, username, displayName} } + Set-Cookie
   │
   ├─ registerUser({ username, password, displayName })
   │   → 校验 + 存库
   ├─ token = signToken({ sub: user.id, tenant, username })
   ├─ res.cookie('dazi_token', token, {
   │     httpOnly: true,        ← JS 读不到（防 XSS）
   │     sameSite: 'lax',       ← 防 CSRF
   │     secure: isProd,        ← 生产强制 HTTPS
   │     maxAge: 7*24*3600*1000 ← 7 天
   │   })
   └─ res.json({ user: toPublicUser(user) })

POST /api/auth/login
   │
   │  被谁调：前端登录页
   │  入参：{ username, password }
   │  返回：{ user } + Set-Cookie
   │
   ├─ user = loginUser({ username, password })
   │   → 校验密码
   ├─ token = signToken(...)
   ├─ res.cookie(...)
   └─ res.json({ user: toPublicUser(user) })

POST /api/auth/logout
   │
   │  被谁调：前端退出
   ├─ res.clearCookie('dazi_token')
   └─ res.json({ ok: true })

GET /api/auth/me
   │
   │  被谁调：前端进首页时验证登录态
   ├─ requireAuth
   └─ res.json({ user: toPublicUser(req.user) })
```

### 10.2 `routes/chat.ts`

```
POST /api/chat/messages
   │
   │  被谁调：前端聊天框发消息
   │  入参：{ content, sessionId }
   │  返回：SSE 流（边收 AI 字边推）
   │
   ├─ ① requireAuth(req)
   │   → req.user = { id, tenantId, username }
   │
   ├─ ② consumeRateLimit(req.user.id)
   │   超过 20 条/小时 → 429
   │
   ├─ ③ INSERT INTO conversations (session_id, tenant_id, user_id, role, content)
   │   VALUES (?, ?, ?, 'user', ?)
   │   存用户消息
   │
   ├─ ④ SELECT * FROM conversations
   │   WHERE session_id = ? ORDER BY id DESC LIMIT 20
   │   拉最近 20 条当上下文
   │
   ├─ ⑤ profile = loadProfile(req.user.id)
   │   从 profiles 表拿画像
   │
   ├─ ⑥ 设置 SSE 响应头
   │   Content-Type: text/event-stream
   │   Cache-Control: no-cache, no-transform
   │   Connection: keep-alive
   │
   ├─ ⑦ abortCtrl = new AbortController()
   │   res.on('close', () => { aborted = true; abortCtrl.abort() })
   │   （前端断开 → 取消请求）
   │
   ├─ ⑧ result = await profileAgent.streamReply(
   │     recentMessages,
   │     profile,
   │     (delta) => sse(res, 'delta', { text: delta }),     ← 推聊天气泡
   │     ctx,
   │     abortCtrl.signal,
   │     (reasoning) => sse(res, 'reasoning', { text: reasoning })  ← 推思考框
   │   )
   │
   ├─ ⑨ INSERT INTO conversations (..., role='assistant', content=result.text,
   │   reasoning=result.reasoning, tokens_in=usage.input, tokens_out=usage.output)
   │   存 AI 回复
   │
   ├─ ⑩ sse(res, 'done', { text: result.text })
   │
   ├─ ⑪ res.end()
   │
   └─ ⑫ 异步：profileAgent.run({ recentMessages }, ctx).then(result => {
         if (result.ok) transition(ctx, {
           type: 'profile_updated',
           confidence: result.data.confidence
         })
       })
       （异步抽画像，不阻塞回复）

GET /api/chat/history?sessionId=&limit=
   │
   │  被谁调：前端进聊天页加载历史
   ├─ requireAuth
   ├─ SELECT * FROM conversations WHERE session_id=? AND user_id=?
   │   ORDER BY id DESC LIMIT ?
   └─ res.json({ messages: [...].reverse() })

POST /api/chat/reset
   │
   │  被谁调：前端"重新开始"按钮
   ├─ requireAuth
   ├─ ctx = getSession(...)
   ├─ resetSession(ctx.userId, ctx.tenantId)
   └─ res.json({ ok: true })
```

### 10.3 `routes/match.ts`

```
POST /api/match/run
   │
   │  被谁调：前端"开始匹配"按钮
   │  入参：{ limit?: number }（默认 5）
   │  返回：{ candidates, totalCount, myProfileText, state }
   │
   ├─ ① requireAuth
   ├─ ② ctx = getSession(req.user.id, req.user.tenantId)
   ├─ ③ profile = loadProfile(req.user.id)
   │   没有/空 → 400 "画像还不够，先去聊几句再匹配"
   │
   ├─ ④ transition(ctx, { type: 'match_requested' })
   │   状态 PROFILE_READY → MATCHING
   │   非法状态 → 400
   │
   ├─ ⑤ result = await matchAgent.run({ limit: req.body.limit || 5 }, ctx)
   │   调 Agent 跑匹配
   │
   ├─ ⑥ transition(ctx, { type: 'match_done' })
   │   状态 MATCHING → MATCHED
   │
   └─ ⑦ res.json({
       candidates: result.data.candidates.map(toPublicCandidate),
       totalCount: result.data.totalCount,
       myProfileText: result.data.myProfileText,
       state: ctx.state
     })

POST /api/match/icebreaker
   │
   │  被谁调：前端点候选人卡片"要破冰话题"
   │  入参：{ targetUserId }
   │  返回：{ icebreakers, source }
   │
   ├─ ① requireAuth
   ├─ ② ctx = getSession(...)
   ├─ ③ targetUser = SELECT * FROM users WHERE id = ?
   │   没有 → 404
   ├─ ④ myProfile = loadProfile(req.user.id)
   │   peerProfile = loadProfile(targetUserId)
   │   commonInterests = intersect(myProfile.interests, peerProfile.interests)
   │
   ├─ ⑤ transition(ctx, { type: 'icebreaker_requested' })
   │   MATCHED → ICEBREAKING
   │
   ├─ ⑥ result = await iceBreakerAgent.run({
   │     targetUserId, targetProfile: peerProfile,
   │     myInterests: myProfile.interests.map(i => i.name),
   │     commonInterests, matchScore
   │   }, ctx)
   │
   ├─ ⑦ transition(ctx, { type: 'icebreaker_done' })
   │   ICEBREAKING → DONE
   │
   └─ ⑧ res.json({
       icebreakers: result.data.icebreakers,
       source: result.data.source
     })

GET /api/match/excluded
   │  被谁调：前端看"最近推过谁"
   ├─ profileAdapter.getExcludedCandidates(req.user.id)
   └─ res.json({ excluded: [...] })
```

### 10.4 `routes/dm.ts`

```
POST /api/dm/rooms
   │
   │  被谁调：前端"私聊 Ta"
   │  入参：{ targetUserId }
   │  返回：{ roomId }
   │
   ├─ requireAuth
   ├─ 查/建 dm_rooms（UNIQUE(user_a, user_b) 保证一对一）
   └─ res.json({ roomId })

GET /api/dm/rooms
   │  被谁调：前端私聊列表页
   ├─ SELECT r.*, u.display_name as peer_name
   │   FROM dm_rooms r JOIN users u ON u.id = IF(user_a=?, user_b, user_a)
   │   WHERE user_a = ? OR user_b = ?
   │   ORDER BY last_message_at DESC
   └─ res.json({ rooms: [...] })

GET /api/dm/rooms/:roomId/messages?limit=50
   │  被谁调：进私聊房间拉历史消息
   ├─ 校验用户在房间里
   ├─ SELECT * FROM dm_messages WHERE room_id=? ORDER BY id DESC LIMIT ?
   └─ res.json({ messages: [...].reverse() })

POST /api/dm/rooms/:roomId/messages
   │
   │  被谁调：前端发私聊消息
   │  入参：{ content }
   │
   ├─ requireAuth
   ├─ 校验在房间里
   ├─ INSERT INTO dm_messages (room_id, tenant_id, sender_id, content)
   │   VALUES (?, ?, ?, ?)
   ├─ UPDATE dm_rooms SET last_message_at = ? WHERE id = ?
   │
   ├─ 异步：if (peer 是 bot) replyToUser(botUserId, ...)
   │  （如果是 AI bot，触发回复）
   │
   └─ res.json({ ok: true })

GET /api/dm/rooms/:roomId/stream
   │
   │  被谁调：前端 SSE 长连接，实时收新消息
   │  返回：SSE 流（message 事件）
   │
   ├─ requireAuth
   ├─ 校验在房间里
   ├─ 设置 SSE 头
   │
   ├─ heartbeat = setInterval(() => {
   │   sse(res, 'ping', { ts: Date.now() })
   │ }, 25000)                       ← 25 秒心跳，防代理超时
   │
   ├─ while (!aborted):
   │   ├─ SELECT * FROM dm_messages
   │   │   WHERE room_id=? AND id > ? AND sender_id != ?
   │   │   （拉新消息，排除自己发的）
   │   │
   │   ├─ for each msg:
   │   │   sse(res, 'message', { id, senderId, content, createdAt })
   │   │   UPDATE dm_messages SET read_at = ? WHERE id = ?
   │   │
   │   └─ await sleep(1500)          ← 1.5 秒轮询一次
   │
   └─ finally: clearInterval(heartbeat); res.end()
```

### 10.5 `routes/profile.ts`

```
GET /api/profile/
   │
   │  被谁调：前端画像页
   │  返回：{ profile, confidence, profileText }
   │
   ├─ requireAuth
   ├─ profile = loadProfile(req.user.id)
   │   没有 → res.json({ profile: null, confidence: 0, profileText: '', message: '还没有画像' })
   └─ res.json({
       profile,
       confidence: profile.confidence,
       profileText: profileToText(profile)
     })

GET /api/profile/history
   │
   │  被谁调：前端看画像演变历史
   │
   ├─ requireAuth
   ├─ SELECT version, patch_json, created_at
   │   FROM profile_patches WHERE user_id=? ORDER BY id ASC
   └─ res.json({
       history: rows.map(r => ({
         version: r.version,
         patch: JSON.parse(r.patch_json),
         createdAt: r.created_at
       }))
     })

PUT /api/profile/privacy
   │
   │  被谁调：前端改隐私设置
   │  入参：{ hideLocation, hideSchedule }
   │
   ├─ requireAuth
   ├─ UPDATE profiles SET privacy_json = ? WHERE user_id = ?
   └─ res.json({ ok: true })

DELETE /api/profile/
   │  被谁调：前端"清空画像"
   ├─ requireAuth
   ├─ UPDATE profiles SET profile_json='{}', confidence=0, embedding=NULL
   │   WHERE user_id = ?
   └─ res.json({ ok: true })
```

### 10.6 `routes/health.ts`

```
GET /api/health
   │
   │  被谁调：运维/前端探活
   └─ res.json({
       status: 'ok',
       uptime: process.uptime(),
       timestamp: Date.now(),
       db: 'connected',
       redis: redisClient.isAvailable ? 'connected' : 'fallback'
     })

GET /api/health/version
   └─ res.json({
       version: '1.0.0',
       node: process.version,
       env: process.env.NODE_ENV
     })
```

### 10.7 `routes/privacy.ts`

```
GET /api/privacy/export
   │
   │  被谁调：前端"导出我的数据"
   │  返回：JSON 包含用户所有数据
   │
   ├─ requireAuth
   ├─ SELECT * FROM users WHERE id = ?
   ├─ SELECT * FROM profiles WHERE user_id = ?
   ├─ SELECT * FROM conversations WHERE user_id = ?
   ├─ SELECT * FROM dm_messages WHERE sender_id = ?
   ├─ SELECT * FROM profile_patches WHERE user_id = ?
   ├─ SELECT * FROM mbti_profiles WHERE user_id = ?
   └─ res.json({ user, profile, conversations, messages, patches, mbti })

DELETE /api/privacy/account
   │
   │  被谁调：前端"注销账号"
   │  干什么：彻底删除用户所有数据
   │
   ├─ requireAuth
   ├─ DELETE FROM users WHERE id = ?   ← 外键 CASCADE 自动删其他表
   ├─ clearMemoryForUser(userId)        ← 清 MemoryBus 缓存
   └─ res.json({ ok: true })
```

### 10.8 `routes/test.ts`

```
POST /api/test/dispatch
   │
   │  被谁调：开发环境模拟多用户
   ├─ aiDispatchTest.run({ userCount, rounds })
   └─ res.json({ traceId })

GET /api/test/logs?traceId=
   │
   │  被谁调：查看测试日志
   ├─ SELECT * FROM trace_logs WHERE trace_id = ?
   └─ res.json({ logs: [...] })

POST /api/test/reset
   │  被谁调：重置所有会话状态
   ├─ 清空 sessions Map
   └─ res.json({ ok: true })
```

---

## 十一、记忆层 `memory/*`（4 层架构）

### 11.1 `memory/memoryTypes.ts`

```
ProfileTag           标签结构
                     { key, value, weight, source, ts }
                     比如 { key:'interest', value:'跑步', weight:0.8, source:'llm' }

MatchDecisionEntry   匹配决策记录
                     { userId, peerId, overallScore, dimensionScores, tagTrace, ts }

InteractionEntry     互动记录
                     { userId, peerId, iceBreakerType, iceBreakerText, topicsUsed, effect, ts }
                     effect: 1（好）/0（一般）/-1（差）

ShortTermEntry        短期记忆条目
                     { role, content, ts }
```

### 11.2 `memory/shortTermMemory.ts`

```
class ShortTermMemory {
   │
   │  被谁调：memoryBus.appendShortTerm()
   │  干什么：会话内最近 N 条消息（滑动窗口）
   │
   ├─ MAX = 20
   ├─ entries: ShortTermEntry[] = []
   │
   ├─ append(role, content)
   │   ├─ entries.push({ role, content, ts: Date.now() })
   │   └─ if (entries.length > MAX) entries.shift()
   │
   ├─ getAll()
   │   └─ return [...entries]
   │
   └─ clear()
       └─ entries.length = 0
}
```

### 11.3 `memory/longTermProfileMemory.ts`

```
class LongTermProfileMemory {
   │
   │  被谁调：memoryBus.updateLongTermProfile() / readLongTermProfile()
   │  干什么：跨会话的画像标签 + 向量
   │
   ├─ tags: Map<userId, ProfileTag[]>
   ├─ vectors: Map<userId, number[]>
   │
   ├─ update(userId, newTags, vector?)
   │   │
   │   │  干什么：合并新标签（同 key 覆盖旧的，weight 取大）
   │   ├─ old = tags.get(userId) || []
   │   ├─ for tag in newTags:
   │   │   找到同 key 的 → 覆盖
   │   │   没有 → push
   │   ├─ tags.set(userId, merged)
   │   └─ if (vector) vectors.set(userId, vector)
   │
   ├─ read(userId)
   │   └─ return { tags: tags.get(userId) || [], vector: vectors.get(userId) }
   │
   └─ clear(userId?)
       └─ 不传 → 清所有；传 → 删该用户
}
```

### 11.4 `memory/matchDecisionMemory.ts`

```
class MatchDecisionMemory {
   │
   │  被谁调：memoryBus.writeMatchDecision() / getRecentCandidates()
   │  干什么：记历史匹配，避免重复推
   │
   ├─ decisions: Map<userId, MatchDecisionEntry[]>
   ├─ recentCandidates: Map<userId, Set<string>>
   │
   ├─ write(entry)
   │   ├─ decisions.get(userId).push(entry)
   │   ├─ recentCandidates.get(userId).add(peerId)
   │   └─ 只保留最近 50 个 candidate
   │
   ├─ getRecent(userId)
   │   └─ return [...recentCandidates.get(userId)]
   │
   └─ getAll(userId)
       └─ return decisions.get(userId) || []
}
```

### 11.5 `memory/interactionMemory.ts`

```
class InteractionMemory {
   │
   │  被谁调：memoryBus.writeInteraction()
   │  干什么：记破冰话题效果，优化下次推荐
   │
   ├─ interactions: Map<userId, InteractionEntry[]>
   │
   ├─ write(entry)
   │   ├─ interactions.get(userId).push(entry)
   │   └─ 只留最近 100 条
   │
   └─ getRecent(userId, peerId)
       └─ 返回该用户对某 peer 用过的话题
}
```

### 11.6 `memory/memoryBus.ts`

```
globalMemoryBus
   │
   │  被谁调：所有 Agent 都通过它访问记忆（统一入口）
   │  干什么：路由记忆操作到对应层
   │
   ├─ shortTerm: ShortTermMemory
   ├─ longTerm: LongTermProfileMemory
   ├─ matchDecisions: MatchDecisionMemory
   └─ interactions: InteractionMemory

   appendShortTerm(scope, userId, sessionId, entry)
     │  被谁调：profileAdapter.onMessage
     └─ shortTerm.append(entry)

   updateLongTermProfile(scope, userId, tags, vector?)
     │  被谁调：profileAdapter.onProfileExtracted
     └─ longTerm.update(userId, tags, vector)

   readLongTermProfile(scope, userId)
     │  被谁调：profileAdapter.getUserProfile、matchAdapter.getUserProfile
     └─ return longTerm.read(userId)

   writeMatchDecision(scope, entry)
     │  被谁调：matchAdapter.recordMatch
     └─ matchDecisions.write(entry)

   getRecentCandidates(scope, userId)
     │  被谁调：matchAdapter.getExcludedCandidates
     └─ return matchDecisions.getRecent(userId)

   writeInteraction(scope, entry)
     │  被谁调：iceBreakerAdapter.recordInteraction
     └─ interactions.write(entry)

   settleSession(userId, sessionId)
     │  被谁调：profileAdapter.onSessionEnd
     │  干什么：会话结束时把短期记忆沉淀到长期
     ├─ shortTerm.getAll() → 提炼关键标签
     ├─ longTerm.update() 合并
     └─ shortTerm.clear()

   snapshotAll() / restoreFromSnapshot(data)
     │  被谁调：lifecycleAdapter 启动恢复 / 关闭保存
     └─ 序列化 4 层记忆 → 给 Redis 存
```

---

## 十二、Redis 层 `redis/*`

### 12.1 `redis/redisClient.ts`

```
class RedisClient {
   │
   │  被谁调：lifecycleAdapter、stateStore
   │  干什么：Redis 连接管理（懒加载 + fallback）
   │
   ├─ client: Redis | null
   ├─ isAvailable: boolean
   ├─ fallbackStore: Map<string, string>   ← 没 Redis 用内存兜底
   │
   ├─ async connect()
   │   ├─ if (!config.redis.url) → isAvailable=false, 用 fallback
   │   ├─ client = new Redis(config.redis.url)
   │   ├─ try: await client.ping()
   │   │   成功 → isAvailable = true
   │   │   失败 → isAvailable = false（降级到内存）
   │   └─ console.log('[redis] 状态：' + (isAvailable ? '连接' : '降级'))
   │
   ├─ async disconnect()
   │   └─ if (client) await client.quit()
   │
   ├─ async get(key)
   │   ├─ if (isAvailable) return await client.get(key)
   │   └─ else return fallbackStore.get(key)
   │
   ├─ async set(key, value, ttl?)
   │   ├─ if (isAvailable):
   │   │   if (ttl) await client.set(key, value, 'EX', ttl)
   │   │   else await client.set(key, value)
   │   └─ else fallbackStore.set(key, value)
   │
   └─ async del(key)
       ├─ if (isAvailable) await client.del(key)
       └─ else fallbackStore.delete(key)
}
```

### 12.2 `redis/stateStore.ts`

```
saveMemoryToRedis()
   │
   │  被谁调：lifecycleAdapter 定时任务 + 关闭钩子
   │  干什么：把 MemoryBus 4 层全部序列化存 Redis
   │
   ├─ snapshot = globalMemoryBus.snapshotAll()
   ├─ await redisClient.set('memory:snapshot', JSON.stringify(snapshot))
   └─ console.log('[stateStore] 记忆已保存')

restoreMemoryFromRedis()
   │
   │  被谁调：lifecycleAdapter.initEnhancedSystem 启动时
   │  干什么：从 Redis 恢复 4 层记忆
   │
   ├─ data = await redisClient.get('memory:snapshot')
   ├─ if (!data) return  ← 没数据就空启动
   ├─ snapshot = JSON.parse(data)
   └─ globalMemoryBus.restoreFromSnapshot(snapshot)

saveSessionState(userId, state)
   │  被谁调：transition() 后异步存
   └─ await redisClient.set(`session:${userId}`, JSON.stringify(state))

loadSessionState(userId)
   │  被谁调：getSession() 启动恢复
   └─ return JSON.parse(await redisClient.get(`session:${userId}`))
```

---

## 十三、压缩层 `compress/*`

### 13.1 `compress/compressTypes.ts`

```
CompactResult
   { compacted: boolean, newPrefix: string, newLog: LogEntry[], savedTokens: number }

LogEntry
   { role, content, ts, tokens? }
```

### 13.2 `compress/autoCompact.ts`

```
compactLogIfNeeded(prefix, log)
   │
   │  被谁调：cacheLlmAdapter.chatWithCache
   │  干什么：超阈值时自动压缩（重）
   │
   ├─ totalTokens = log.reduce((s,e) => s + (e.tokens||0), 0)
   ├─ if (totalTokens < THRESHOLD) return { compacted: false }
   │   （没到阈值不压）
   │
   ├─ ① 把 log 拆两段：
   │   oldPart = log.slice(0, -6)        ← 旧消息（保留最近 6 条不压）
   │   recentPart = log.slice(-6)         ← 最近的保留
   │
   ├─ ② 调 summaryGenerator.summarize(oldPart)
   │   让 LLM 总结旧消息 → "用户喜欢跑步、夜猫子、内向..."
   │   （省 token，但 AI 知道历史）
   │
   ├─ ③ newPrefix = prefix + "\n[历史摘要]\n" + summary
   │   newLog = recentPart
   │
   ├─ ④ savedTokens = totalTokens - 新 token 数
   │
   └─ ⑤ return { compacted: true, newPrefix, newLog, savedTokens }
```

### 13.3 `compress/microCompact.ts`

```
microCompact(log)
   │
   │  被谁调：chatWithCache 内部，轻量压缩
   │  干什么：旧 AI 回复截断（不调 LLM，纯文本处理）
   │
   ├─ for i, entry in log:
   │   if (entry.role === 'assistant' && i < log.length - 4):
   │     # 旧的 AI 回复截断到 100 字
   │     if (entry.content.length > 100):
   │       entry.content = entry.content.slice(0, 100) + '...'
   │
   └─ return log
```

### 13.4 `compress/summaryGenerator.ts`

```
summarize(messages)
   │
   │  被谁调：autoCompact.compactLogIfNeeded
   │  干什么：调 LLM 总结
   │
   ├─ 拼 prompt：
   │   "把以下对话总结成 3-5 条关键信息：\n${messages}"
   ├─ chatStream([{role:'user', content: prompt}], { maxTokens: 256 })
   └─ return result.text
```

### 13.5 `compress/boundary.ts`

```
detectBoundary(log)
   │  干什么：检测话题边界（用户换话题了）
   │
   ├─ 简单启发式：如果用户消息含"对了"、"换个话题"、"另外"
   │   → 标记为新边界
   └─ return { hasBoundary: boolean, boundaryIndex?: number }
```

---

## 十四、缓存层 `cache/*`（前缀缓存）

### 14.1 `cache/cacheTypes.ts`

```
Conversation
   { id, prefix, prefixHash, log: LogEntry[] }

LogEntry
   { role, content, ts, tokens? }

ChatResult
   { text, reasoning, usage: {inputTokens, outputTokens, cacheHit?: number} }
```

### 14.2 `cache/prefixHash.ts`

```
computePrefixHash(prefix)
   │
   │  被谁调：chatWithCache 建/校验 prefix
   │  干什么：算 prefix 的哈希（用于缓存命中判断）
   │
   ├─ crypto.createHash('sha256').update(prefix).digest('hex')
   └─ 取前 16 位做 hash
```

### 14.3 `cache/appendLog.ts`

```
appendUserMessage(conv, userMessage)
   │
   │  被谁调：chatWithCache
   │  干什么：往会话追加一条用户消息（不改 prefix）
   ├─ conv.log.push({ role:'user', content: userMessage, ts: Date.now() })
   └─ return conv

appendAssistantMessage(conv, text, reasoning)
   │  被谁调：chatWithCache 收到 LLM 回复后
   └─ conv.log.push({ role:'assistant', content: text, reasoning, ts: Date.now() })

getOrCreateConversation(userId, sessionId, systemPrompt)
   │
   │  被谁调：chatWithCache
   │  干什么：拿/建会话对象
   │
   ├─ 先从 Redis 查 cached key=`${userId}:${sessionId}`
   │   有 → 反序列化返回
   │
   └─ 没有 → 新建：
       {
         id: randomUUID(),
         prefix: systemPrompt,
         prefixHash: computePrefixHash(systemPrompt),
         log: []
       }
```

### 14.4 `cache/cacheClient.ts`

```
chatStreamCached(conv, callbacks, opts)
   │
   │  被谁调：cacheLlmAdapter.chatWithCache
   │  干什么：带前缀缓存地调 DeepSeek（省 token！）
   │
   ├─ messages = [{role:'system', content: conv.prefix}, ...conv.log]
   │
   ├─ POST chat/completions
   │   body: {
   │     model, messages, stream: true,
   │     max_tokens: opts.maxTokens,
   │     temperature: opts.temperature,
   │     // DeepSeek 会自动识别前缀缓存命中
   │   }
   │
   ├─ 收 SSE 流，和 llmClient.chatStream 一样
   │   onDelta、onReasoning 推给 callbacks
   │
   ├─ 检查 response 里的 cached_tokens 字段
   │   命中 → cacheHit++
   │
   └─ return { text, reasoning, usage: {inputTokens, outputTokens, cacheHit} }

saveCachedConversation(key, conv)
   │  被谁调：chatWithCache 用完异步存
   └─ redisClient.set(`conv:${key}`, JSON.stringify(conv))

serializeConversation(conv) / deserializeConversation(str)
   │  序列化/反序列化
```

### 14.5 `cache/cacheStats.ts`

```
recordCacheHit(prefixHash, hitTokens)
   │  被谁调：chatStreamCached
   └─ 累计统计：命中次数、节省 token

getCacheStats()
   │  被谁调：/api/test/logs 看缓存效果
   └─ return { totalCalls, totalCacheHits, savedTokens, hitRate }
```

---

## 十五、MBTI 层 `mbti/*`

### 15.1 `mbti/mbtiTypes.ts`

```
MbtiType           'INTJ' | 'ENFP' | ... 16 种 | 'UNKNOWN'

MbtiDimension      'E' | 'I' | 'N' | 'S' | 'T' | 'F' | 'J' | 'P'

MbtiDimensionSignal
   { dimension: MbtiDimension, score: number, evidence: string }
   （从对话抽出的信号，比如 dimension:'I', score:0.7, evidence:'喜欢独处'）

MbtiProfile
   { type, confidence, dimensions: { E_I, S_N, T_F, J_P }, updatedAt }
   dimensions 4 维度，每维 [-1, 1]，正负代表倾向

MbtiCompatResult
   { score: number, reason: string, detail: {...} }
```

### 15.2 `mbti/mbtiEngine.ts`

```
class MbtiEngine {
   │
   │  被谁调：mbtiProfileAdapter
   │  干什么：MBTI 状态管理（每用户一份）
   │
   ├─ state: Map<userId, MbtiProfile>
   │
   ├─ getProfile(userId)
   │   ├─ 内存有 → 返回
   │   └─ 没有 → 从 DB 加载 / 返回 UNKNOWN
   │
   ├─ setProfile(userId, profile)
   │   ├─ state.set(userId, profile)
   │   └─ UPDATE mbti_profiles SET ... WHERE user_id = ?
   │
   └─ applyDimensionPatch(current, signals)
       │  干什么：把新信号合并进现有画像
       │
       ├─ for signal in signals:
       │   ├─ 找到对应维度（E_I/S_N/T_F/J_P）
       │   ├─ 新值 = current * 0.7 + signal * 0.3  ← 加权融合
       │   └─ 累计 evidence
       │
       └─ 重新判定 type：
           E_I > 0 → E，否则 I
           S_N > 0 → N，否则 S
           ... 拼成 4 字母
}

getMbtiProfile(userId)   ← 全局导出
   └─ mbtiEngine.getProfile(userId)
```

### 15.3 `mbti/mbtiExtractor.ts`

```
extractMbtiSignals(messages)
   │
   │  被谁调：mbtiProfileAdapter.updateMbtiFromMessages
   │  干什么：从对话里抽 MBTI 信号
   │
   ├─ llmEnabled?
   │   ├─ 有 → 调 LLM
   │   │   prompt: "分析用户的 MBTI 倾向，输出 JSON:
   │   │           [{dimension, score, evidence}]"
   │   │   → extractJSON + validateJSON
   │   │
   │   └── 没 → 规则
   │       匹配关键词：
   │       "独处/一个人/安静" → I +0.3
   │       "聚会/热闹/朋友多" → E +0.3
   │       "逻辑/分析/原理" → T +0.3
   │       "感觉/情感/关系" → F +0.3
   │       "计划/安排/目标" → J +0.3
   │       "灵活/即兴/突然" → P +0.3
   │
   └─ return signals
```

### 15.4 `mbti/mbtiCompat.ts`

```
scoreCompat(mine, theirs)
   │
   │  被谁调：matchAgentMbtiAdapter.computeMbtiFactor
   │  干什么：算两个 MBTI 的相性分数
   │
   │  经典 MBTI 相性表：
   │   - 同类型 → 0.9
   │   - 完全相反 → 0.3
   │   - 互补（如 INTJ + ENFP）→ 0.85
   │   - 共享 2-3 字母 → 0.7
   │
   ├─ 维度相性：每个维度算一个分
   │   E_I: 相同 → 1.0，相反 → 0.5（不一定坏）
   │   S_N: 相同 → 1.0，相反 → 0.3（差异大）
   │   T_F: 相同 → 1.0，相反 → 0.6
   │   J_P: 相同 → 1.0，相反 → 0.7
   │
   ├─ overallScore = 加权平均
   │
   └─ return {
       score: overallScore,
       reason: '完全相同类型' | '互补关系' | ...,
       detail: { E_I, S_N, T_F, J_P }
     }
```

---

## 十六、集成层 `integrations/*`

### 16.1 `integrations/agentMemoryAdapter.ts`

```
profileAdapter
   │
   │  被谁调：profileAgent.execute / chat.ts
   │  干什么：ProfileAgent 和 MemoryBus 之间的桥梁
   │
   ├─ onMessage(userId, sessionId, role, content)
   │   ├─ if (!content.trim()) return
   │   └─ globalMemoryBus.appendShortTerm('profile', userId, sessionId, { role, content })
   │
   ├─ onProfileExtracted(userId, patch)
   │   ├─ 把 patch 转成 ProfileTag[]（兴趣、社交风格、时间段都变标签）
   │   ├─ if (tags.length > 0):
   │   │   globalMemoryBus.updateLongTermProfile('profile', userId, tags)
   │   └─ 异步：updateMbtiFromMessages（顺带抽 MBTI）
   │
   └─ onSessionEnd(userId, sessionId)
       └─ globalMemoryBus.settleSession(userId, sessionId)

matchAdapter
   │
   │  被谁调：matchAgent.execute
   │
   ├─ getUserProfile(userId)
   │   └─ return globalMemoryBus.readLongTermProfile('match', userId)
   │
   ├─ getExcludedCandidates(userId)
   │   └─ return globalMemoryBus.getRecentCandidates('match', userId)
   │
   └─ recordMatch(userId, candidateId, overallScore, dimensionScores, tagTrace)
       ├─ entry: MatchDecisionEntry = { userId, peerId, overallScore, ... }
       └─ globalMemoryBus.writeMatchDecision('match', entry)

iceBreakerAdapter
   │
   │  被谁调：iceBreakerAgent.execute
   │
   ├─ getPeerProfile(peerId)
   │   └─ return globalMemoryBus.readLongTermProfile('icebreaker', peerId)
   │
   └─ recordInteraction(userId, peerId, iceBreakerType, iceBreakerText, topicsUsed, effect)
       ├─ entry: InteractionEntry = { ... }
       └─ globalMemoryBus.writeInteraction('icebreaker', entry)
```

### 16.2 `integrations/cacheLlmAdapter.ts`

```
chatWithCache(userId, sessionId, systemPrompt, userMessage, callbacks, opts)
   │
   │  被谁调：cacheLlmAdapter 暴露的统一入口（替代直接调 llmClient）
   │  干什么：缓存优先的 LLM 调用
   │
   ├─ ① conv = await getOrCreateConversation(userId, sessionId, systemPrompt)
   │   （从 Redis 拿/建会话）
   │
   ├─ ② appendUserMessage(conv, userMessage)
   │   （追加用户消息到 log）
   │
   ├─ ③ compactResult = await compactLogIfNeeded(conv.prefix, conv.log)
   │   if (compactResult.compacted):
   │     conv.prefix = compactResult.newPrefix
   │     conv.log = compactResult.newLog
   │     conv.prefixHash = computePrefixHash(conv.prefix)
   │   （超阈值自动压缩）
   │
   ├─ ④ result = await chatStreamCached(conv, {
   │     onDelta: callbacks.onText,
   │     onReasoning: callbacks.onReasoning,
   │     onUsage: callbacks.onUsage
   │   }, opts)
   │
   ├─ ⑤ appendAssistantMessage(conv, result.text, result.reasoning)
   │
   ├─ ⑥ saveCachedConversation(`${userId}:${sessionId}`, serializeConversation(conv))
   │   .catch(() => {})  ← 异步存 Redis，失败不阻塞
   │
   └─ ⑦ return result
```

### 16.3 `integrations/lifecycleAdapter.ts`

```
initEnhancedSystem()
   │
   │  被谁调：bootstrap() 启动时
   │  干什么：初始化增强系统
   │
   ├─ if (_initialized) return
   ├─ _initialized = true
   │
   ├─ ① await globalRedisClient.connect()
   │   （连 Redis，失败降级到内存）
   │
   ├─ ② if (redisClient.isAvailable):
   │   ├─ await restoreMemoryFromRedis().catch(err => {
   │   │   console.warn(`[lifecycle] 恢复记忆失败：${err.message}`)
   │   │ })
   │   └─ startPeriodicSave(60)   ← 每 60 秒存一次
   │
   ├─ ③ process.on('SIGTERM', async () => {
   │     await gracefulShutdown()
   │     process.exit(0)
   │   })
   │
   ├─ ④ process.on('SIGINT', async () => {
   │     await gracefulShutdown()
   │     process.exit(0)
   │   })
   │
   └─ ⑤ process.on('uncaughtException', (err) => {
       console.error('[lifecycle] 未捕获异常：', err)
     })

gracefulShutdown()
   │
   │  被谁调：SIGTERM/SIGINT
   │  干什么：优雅关闭
   │
   ├─ stopPeriodicSave()
   ├─ await saveMemoryToRedis().catch(() => {})
   ├─ await globalRedisClient.disconnect()
   └─ console.log('[lifecycle] 已优雅关闭')

startPeriodicSave(intervalSec)
   │  干什么：启动定时任务
   └─ setInterval(() => saveMemoryToRedis(), intervalSec * 1000)

stopPeriodicSave()
   └─ clearInterval(timer)
```

### 16.4 `integrations/matchAgentMbtiAdapter.ts`

```
computeMbtiFactor(myUserId, theirUserId)
   │
   │  被谁调：matchAgent.execute 算第 6 维分数
   │  干什么：算两个用户的 MBTI 相性
   │
   ├─ mine = getMbtiProfile(myUserId)
   ├─ theirs = getMbtiProfile(theirUserId)
   │
   ├─ if (mine.type === 'UNKNOWN' || theirs.type === 'UNKNOWN'):
   │   return { score: 0.5, reason: 'MBTI 未知，默认中性', ... }
   │   （不知道就给 0.5，不偏不倚）
   │
   ├─ result = scoreCompat(mine, theirs)
   │
   └─ return {
       score: result.score,
       reason: result.reason,
       detail: result.detail,
       mineType: mine.type,
       theirsType: theirs.type,
       mineConfidence: mine.confidence,
       theirsConfidence: theirs.confidence
     }

mbtiTypeColorClass(type)
   │
   │  被谁调：前端展示 MBTI 颜色
   │  干什么：根据 MBTI 类型返回 CSS 类名
   │
   ├─ 'UNKNOWN' → 'mbti-unknown'
   ├─ second='N' && third='T' → 'mbti-nt'   紫色（理性者）
   ├─ second='N' && third='F' → 'mbti-nf'   绿色（理想主义者）
   ├─ second='S' && third='J' → 'mbti-sj'   蓝色（守护者）
   ├─ second='S' && third='P' → 'mbti-sp'   橙色（艺术家）
   └─ else → 'mbti-unknown'
```

### 16.5 `integrations/mbtiProfileAdapter.ts`

```
updateMbtiFromMessages(userId, messages)
   │
   │  被谁调：profileAdapter.onProfileExtracted 内部
   │  干什么：从对话抽 MBTI 信号并更新画像
   │
   ├─ try:
   │   signals = await extractMbtiSignals(messages)
   │  catch (err):
   │   console.warn(`[mbtiProfileAdapter] 抽取失败：${err.message}`)
   │   return getMbtiProfile(userId)
   │
   ├─ current = getMbtiProfile(userId)
   ├─ updated = applyDimensionPatch(current, signals)
   │   （加权融合 + 重新判定 type）
   │
   ├─ mbtiState.set(userId, updated)
   │
   ├─ try:
   │   globalMemoryBus.updateLongTermProfile('profile', userId, [], undefined)
   │   （同步到 MemoryBus，让别的 Agent 能读到）
   │  catch (err):
   │   console.warn(`写 MemoryBus 失败：${err.message}`)
   │
   └─ return updated
```

---

## 十七、脚本层 `scripts/*`

### 17.1 `scripts/aiDispatchTest.ts`

```
run({ userCount = 5, rounds = 3 })
   │
   │  被谁调：/api/test/dispatch
   │  干什么：模拟 N 个用户各发 M 条消息，跑端到端
   │
   ├─ traceId = randomUUID()
   ├─ users = 创建 userCount 个测试用户
   │
   ├─ for round in range(rounds):
   │   for user in users:
   │     ├─ 发消息："我喜欢跑步、看书"
   │     ├─ 调 /api/chat/messages → 收 SSE
   │     ├─ 等 streamReply 完成
   │     └─ traceLogger.event('dispatch_msg', {userId, round})
   │
   ├─ 调 /api/match/run → 看匹配结果
   ├─ 调 /api/match/icebreaker → 看破冰
   │
   └─ 写测试报告 → HTML → PDF
```

### 17.2 `scripts/initBots.ts`

```
initBots()
   │
   │  被谁调：bootstrap() 启动一次 / 手动 npm run init:bots
   │  干什么：把 4 个 AI bot 写进 users 表
   │
   ├─ for bot in BOTS (alice/bob/carol/david):
   │   ├─ SELECT * FROM users WHERE username = bot.username
   │   │   已存在 → skip
   │   │   没有 → INSERT
   │   └─ 给 bot 一个 mbti_profiles 记录
   │
   └─ console.log('bots 初始化完成')
```

### 17.3 `scripts/seed.ts`

```
seed()
   │
   │  被谁调：npm run seed
   │  干什么：灌测试数据
   │
   ├─ 创建 50 个假用户（user1~user50）
   ├─ 给每个用户随机画像：
   │   interests: 从池子里随机 3 个（跑步/看书/游戏/电影/旅行...）
   │   socialStyle: 随机
   │   schedule: 随机
   ├─ INSERT INTO profiles
   ├─ 给每个用户算 embedding 存进去
   └─ console.log('seed 完成')
```

### 17.4 `scripts/generatePdfReport.ts`

```
generatePdf(htmlPath, pdfPath)
   │
   │  被谁调：aiDispatchTest 跑完生成报告
   │  干什么：HTML → PDF
   │
   ├─ 用 puppeteer 打开 htmlPath
   ├─ page.pdf({ path: pdfPath, format: 'A4' })
   └─ console.log(`PDF 生成于 ${pdfPath}`)
```

---

## 十八、完整 API 数据流图

```
═══════════════════════════════════════════════════════════════════════
                    全部 API 接口 & 数据流向
═══════════════════════════════════════════════════════════════════════

┌─ 认证类 ───────────────────────────────────────────────────────────┐
│ POST   /api/auth/register                                          │
│   前端注册页 → registerUser() → users 表                           │
│   → signToken() → Set-Cookie                                      │
│   → 返回 { user }                                                 │
│                                                                    │
│ POST   /api/auth/login                                             │
│   前端登录页 → loginUser() → 验密码 → signToken() → Set-Cookie      │
│   → 返回 { user }                                                 │
│                                                                    │
│ POST   /api/auth/logout                                            │
│   → 清 Cookie → { ok: true }                                       │
│                                                                    │
│ GET    /api/auth/me                                                │
│   → requireAuth → 返回当前用户                                     │
└────────────────────────────────────────────────────────────────────┘

┌─ 聊天类 ───────────────────────────────────────────────────────────┐
│ POST   /api/chat/messages   ← 核心接口                              │
│   前端聊天框 → requireAuth                                         │
│   → consumeRateLimit  ← 限流                                       │
│   → INSERT conversations（存用户消息）                              │
│   → SELECT 最近 20 条                                              │
│   → profileAgent.streamReply()                                     │
│       ├─ 有 LLM Key → streamReplyLLM                              │
│       │   └→ chatStream() → DeepSeek API                          │
│       │      └→ SSE 流推前端（delta + reasoning）                   │
│       └─ 没 Key → templateReply（模板 + 假打字）                    │
│   → INSERT conversations（存 AI 回复）                              │
│   → 异步 profileAgent.run() → 抽画像                               │
│       ├─ extractProfileLLM/Rules                                   │
│       ├─ blackboard.write('latest_profile')                       │
│       ├─ profileAdapter.onProfileExtracted                        │
│       │   ├─ memoryBus.updateLongTermProfile                      │
│       │   └─ updateMbtiFromMessages → mbtiEngine                  │
│       ├─ saveProfilePatch（DB）                                   │
│       └─ transition(profile_updated)                              │
│           if (confidence ≥ 0.65): CHATTING → PROFILE_READY        │
│                                                                    │
│ GET    /api/chat/history?sessionId=                               │
│   → SELECT conversations WHERE session_id                          │
│                                                                    │
│ POST   /api/chat/reset                                             │
│   → resetSession() → blackboard.clear()                           │
└────────────────────────────────────────────────────────────────────┘

┌─ 匹配类 ───────────────────────────────────────────────────────────┐
│ POST   /api/match/run       ← 核心                                 │
│   前端"开始匹配"按钮                                              │
│   → requireAuth                                                   │
│   → loadProfile（画像不够 → 400）                                  │
│   → transition(match_requested): PROFILE_READY → MATCHING         │
│   → matchAgent.run()                                              │
│       ├─ profileAdapter.getUserProfile（从 MemoryBus）              │
│       ├─ embedProfile → 向量                                       │
│       ├─ profileAdapter.getExcludedCandidates                     │
│       ├─ recallByVector（DB 向量检索）                             │
│       ├─ for each candidate:                                      │
│       │   ├─ interestScore（cosine 兴趣）                          │
│       │   ├─ scheduleScore（时间重合）                              │
│       │   ├─ socialStyleScore                                     │
│       │   ├─ energyScore                                          │
│       │   ├─ mbtiScore ← computeMbtiFactor                        │
│       │   │   ├─ getMbtiProfile(mine)                            │
│       │   │   ├─ getMbtiProfile(theirs)                          │
│       │   │   └─ scoreCompat → MBTI 相性表                        │
│       │   └─ distanceScore                                        │
│       ├─ sort + slice top-K                                       │
│       ├─ profileAdapter.recordMatch → MemoryBus                  │
│       └─ blackboard.write('match_result')                        │
│   → transition(match_done): MATCHING → MATCHED                   │
│   → 返回 { candidates, totalCount, myProfileText, state }         │
│                                                                    │
│ POST   /api/match/icebreaker                                      │
│   前端点候选人"破冰"                                                │
│   → loadProfile（双方）                                            │
│   → 算 commonInterests                                            │
│   → transition(icebreaker_requested)                              │
│   → iceBreakerAgent.run()                                         │
│       ├─ llmEnabled? generateLLM / generateRules                  │
│       │   └→ chatStream → DeepSeek                               │
│       ├─ blackboard.write('icebreakers')                         │
│       └─ iceBreakerAdapter.recordInteraction → MemoryBus          │
│   → transition(icebreaker_done): ICEBREAKING → DONE              │
│   → 返回 { icebreakers, source }                                  │
│                                                                    │
│ GET    /api/match/excluded                                        │
│   → profileAdapter.getExcludedCandidates                          │
└────────────────────────────────────────────────────────────────────┘

┌─ 私聊类 ───────────────────────────────────────────────────────────┐
│ POST   /api/dm/rooms                                              │
│   → 查/建 dm_rooms                                                │
│                                                                    │
│ GET    /api/dm/rooms                                              │
│   → 列出我的所有私聊房间                                            │
│                                                                    │
│ GET    /api/dm/rooms/:roomId/messages                             │
│   → 拉历史消息                                                     │
│                                                                    │
│ POST   /api/dm/rooms/:roomId/messages                             │
│   → 存用户消息                                                     │
│   → 更新 last_message_at                                          │
│   → if (peer 是 bot) → replyToUser() 异步触发                      │
│       ├→ chatStream → DeepSeek                                    │
│       └→ INSERT dm_messages（bot 回复）                            │
│                                                                    │
│ GET    /api/dm/rooms/:roomId/stream      ← SSE 长连接              │
│   → 25 秒心跳 + 1.5 秒轮询新消息                                   │
│   → 推 message 事件给前端                                          │
│   → 标记 read_at                                                  │
└────────────────────────────────────────────────────────────────────┘

┌─ 画像类 ───────────────────────────────────────────────────────────┐
│ GET    /api/profile/                                              │
│   → loadProfile → profileToText                                   │
│                                                                    │
│ GET    /api/profile/history                                       │
│   → SELECT profile_patches                                        │
│                                                                    │
│ PUT    /api/profile/privacy                                        │
│   → UPDATE profiles SET privacy_json                              │
│                                                                    │
│ DELETE /api/profile/                                              │
│   → 清空画像                                                       │
└────────────────────────────────────────────────────────────────────┘

┌─ 隐私类 ───────────────────────────────────────────────────────────┐
│ GET    /api/privacy/export                                        │
│   → 拉用户所有数据 → JSON 返回                                      │
│                                                                    │
│ DELETE /api/privacy/account                                        │
│   → DELETE users CASCADE → 清所有                                 │
│   → clearMemoryForUser → 清 MemoryBus                              │
└────────────────────────────────────────────────────────────────────┘

┌─ 健康检查 ─────────────────────────────────────────────────────────┐
│ GET    /api/health         → { status, uptime, db, redis }        │
│ GET    /api/health/version → { version, node, env }               │
└────────────────────────────────────────────────────────────────────┘

┌─ 测试类（仅开发） ─────────────────────────────────────────────────┐
│ POST   /api/test/dispatch  → aiDispatchTest.run()                 │
│ GET    /api/test/logs      → SELECT trace_logs                    │
│ POST   /api/test/reset     → 清所有 sessions                      │
└────────────────────────────────────────────────────────────────────┘
```

---

## 十九、接口清单表（谁调用谁）

```
═══════════════════════════════════════════════════════════════════
                  完整调用关系矩阵
═══════════════════════════════════════════════════════════════════

【前端】 ──HTTP──→ 【路由 routes/】
                       │
                       ├─→ requireAuth (middleware/auth)
                       │       └→ verifyToken (services/auth)
                       │           └→ jwt.verify
                       │
                       ├─→ consumeRateLimit (services/rateLimiter)
                       │       └→ rate_counters 表
                       │
                       ├─→ agents/*
                       │       ├─→ core/orchestrator (transition/getSession)
                       │       │       └→ core/blackboard (createBlackboard)
                       │       │       └→ core/tokenBudget
                       │       │       └→ core/antiloop
                       │       │       └→ core/tracer
                       │       │
                       │       ├─→ services/llmClient (chatStream)
                       │       │       └→ DeepSeek API (HTTP)
                       │       │
                       │       ├─→ services/embedding (embedProfile)
                       │       │       └→ OpenAI API / 本地 hash
                       │       │
                       │       ├─→ db/vectorStore (recallByVector)
                       │       │       └→ cosine 算相似度
                       │       │
                       │       ├─→ integrations/agentMemoryAdapter
                       │       │       └→ memory/memoryBus
                       │       │           ├→ shortTermMemory
                       │       │           ├→ longTermProfileMemory
                       │       │           ├→ matchDecisionMemory
                       │       │           └→ interactionMemory
                       │       │
                       │       ├─→ integrations/matchAgentMbtiAdapter
                       │       │       └→ mbti/mbtiEngine
                       │       │       └→ mbti/mbtiCompat (scoreCompat)
                       │       │
                       │       ├─→ integrations/mbtiProfileAdapter
                       │       │       └→ mbti/mbtiExtractor
                       │       │       └→ mbti/mbtiEngine (applyDimensionPatch)
                       │       │
                       │       ├─→ core/structuredOutput
                       │       │       ├→ quickFixJSON
                       │       │       ├→ extractJSON
                       │       │       └→ validateJSON
                       │       │
                       │       └─→ agents/profileSchema
                       │
                       ├─→ db/* (直接 SQL)
                       │       ├→ conversations 表
                       │       ├→ profiles 表
                       │       ├→ dm_rooms / dm_messages 表
                       │       └→ mbti_profiles 表
                       │
                       ├─→ services/aiBotReplier (私聊触发)
                       │       └→ chatStream → DeepSeek
                       │
                       └→ services/traceLogger
                               └→ trace_logs 表 + stdout


【启动时】bootstrap (index.ts)
              ├→ getDB() → initSchema()
              ├→ initEnhancedSystem (integrations/lifecycleAdapter)
              │     ├→ redisClient.connect()
              │     ├→ restoreMemoryFromRedis() (从 Redis 恢复 4 层记忆)
              │     ├→ startPeriodicSave(60) (每 60 秒存一次)
              │     └→ process.on(SIGTERM/SIGINT) → gracefulShutdown
              └→ initBots() (scripts/initBots)


【关闭时】gracefulShutdown
              ├→ stopPeriodicSave()
              ├→ saveMemoryToRedis() (4 层记忆存盘)
              └→ redisClient.disconnect()
```

---

## 二十、完整数据流：用户发"我最近开始跑步了"

```
用户在聊天框发"我最近开始跑步了"
     │
     ▼
【chat.ts】POST /api/chat/messages
     │
     ├── ① requireAuth(req) ──────────────────────────
     │   从 Cookie 里取 token → jwt.verify() 解密
     │   → 把 userId/tenantId 写进 req.user
     │   → 如果 token 过期/伪造 → 直接返回 401
     │   （位置：middleware/auth.ts）
     │
     ├── ② consumeRateLimit(userId) ──────────────────
     │   去一个 Map 里查这个用户过去 1 小时发了多少条
     │   超过 20 条 → 返回 429（太多请求了）
     │   没超 → 记录这条时间戳，返回 allowed:true
     │   （位置：services/rateLimiter.ts）
     │
     ├── ③ INSERT INTO conversations ─────────────────
     │   把你说的"我最近开始跑步了"存进数据库
     │   role='user', content='我最近开始跑步了', session_id='xxx'
     │
     ├── ④ SELECT 最近 20 条对话 ─────────────────────
     │   从 conversations 表拉出这个会话最近 20 条记录
     │   作为上下文喂给 AI（为什么 20？太多烧 token，太少记不住）
     │
     ├── ⑤ profileAgent.streamReply() ────────────────
     │   │
     │   │  【干啥的】生成 AI 回复，边生成边推给前端
     │   │  【位置】agents/profileAgent.ts → streamReply()
     │   │
     │   ├── llmEnabled? ─── 判断环境变量有没有配 LLM_API_KEY
     │   │   │
     │   │   ├── 有 Key → streamReplyLLM() ──────────
     │   │   │   │
     │   │   │   ├── profileToText(profile) ──────────
     │   │   │   │   把画像对象变成一句话：
     │   │   │   │   {interests:[{name:'跑步'}], socialStyle:{energy:'introvert'}}
     │   │   │   │   → "兴趣: 跑步  社交风格: introvert"
     │   │   │   │   （位置：agents/profileSchema.ts）
     │   │   │   │
     │   │   │   ├── 拼 system prompt ────────────────
     │   │   │   │   一大段文字告诉 AI："你是搭子匹配官，像朋友聊天，
     │   │   │   │   不要审问，每轮只问一个方向，当前已知画像：xxx"
     │   │   │   │   （位置：profileAgent.ts → streamReplyLLM 内部）
     │   │   │   │
     │   │   │   └── chatStream([system, ...历史消息], {onDelta, onReasoning})
     │   │   │       │
     │   │   │       │  【干啥的】真的去调 DeepSeek API，通过 SSE 流式收字
     │   │   │       │  【位置】services/llmClient.ts → chatStream()
     │   │   │       │
     │   │   │       ├── POST https://api.deepseek.com/chat/completions
     │   │   │       │   body: {model, messages, stream:true, max_tokens:8192}
     │   │   │       │   headers: {Authorization: "Bearer sk-xxx"}
     │   │   │       │
     │   │   │       ├── 收 SSE 流，一行一行解析：
     │   │   │       │   data: {"choices":[{"delta":{"reasoning_content":"xxx"}}]}
     │   │   │       │   → 调 onReasoning("xxx") → 推前端"思考框"
     │   │   │       │   data: {"choices":[{"delta":{"content":"听"}}]}
     │   │   │       │   → 调 onDelta("听") → 推前端聊天气泡
     │   │   │       │   data: [DONE]
     │   │   │       │   → 结束
     │   │   │       │
     │   │   │       ├── 如果 chunk 切断了怎么办？
     │   │   │       │   用 buffer 暂存不完整的行
     │   │   │       │   找最后一个 \n\n → 之前 parse，之后留着等下个 chunk
     │   │   │       │   （llmClient.ts 内部有 buffer 处理逻辑）
     │   │   │       │
     │   │   │       └── 返回 {text:"听起来挺棒！晨跑还是夜跑？",
     │   │   │                   reasoning:"用户在分享运动习惯...",
     │   │   │                   usage:{inputTokens:612, outputTokens:318}}
     │   │   │
     │   │   └── 没 Key → templateReply(profile) ────────
     │   │       根据画像阶段选一个模板回复：
     │   │       - 画像为空 → "嗨，先随便聊聊～你平时周末怎么过？"
     │   │       - 有 1 个兴趣 → "听起来你对跑步挺感兴趣的，最近还在做吗？"
     │   │       - 有 3 个兴趣但不知风格 → "想了解下，你喜欢一个人还是有人一起？"
     │   │       - 画像完整 → "我觉得可以点开始匹配了"
     │   │       然后逐字符调 onDelta，每个字停 8ms 模拟打字效果
     │   │       （位置：profileAgent.ts → templateReply()）
     │   │
     │   └── 返回 {text, reasoning} 给 chat.ts
     │        → chat.ts 把 text 存进 conversations 表（role='assistant'）
     │        → chat.ts 拼 SSE event 推给前端
     │
     ├── ⑥ INSERT INTO conversations ─────────────────
     │   存 AI 回复：role='assistant', content=result.text,
     │   reasoning=result.reasoning, tokens_in/out
     │
     ├── ⑦ sse(res, 'done', { text: result.text }) ──
     │   推结束事件给前端
     │
     ├── ⑧ res.end() ────────────────────────────────
     │   关闭 SSE 连接
     │
     └── ⑨ 异步：profileAgent.run({ recentMessages }, ctx).then(result => {
           if (result.ok) transition(ctx, {
             type: 'profile_updated',
             confidence: result.data.confidence
           })
         })
         ─────────────────────────────────────────────
         不阻塞回复，后台慢慢抽画像

         profileAgent.run() 内部：
           ├─ extractProfileLLM(messages)
           │   拼 prompt → chatStream → extractJSON → validateJSON
           │   → 返回 patch = { interests:[{name:'跑步',weight:0.8}], ... }
           │
           ├─ ctx.loop.recordAction('extractProfile', input, result)
           │   （防循环：如果同样的输入连续 3 次出同样结果就报警）
           │
           ├─ ctx.blackboard.write('profile-agent', 'latest_profile',
           │                        patch, 'profile_patch')
           │   （贴黑板，给 MatchAgent 看）
           │
           ├─ profileAdapter.onProfileExtracted(ctx.userId, patch)
           │   ├─ 把 patch 转成 ProfileTag[]：
           │   │   { key:'interest', value:'跑步', weight:0.8, source:'llm' }
           │   │   { key:'socialStyle', value:'introvert', weight:0.6 }
           │   │
           │   ├─ globalMemoryBus.updateLongTermProfile('profile', userId, tags)
           │   │   → longTermProfileMemory.update(userId, tags)
           │   │   → 跨会话画像更新（下次用户回来还记得）
           │   │
           │   └─ updateMbtiFromMessages(userId, messages)
           │       ├─ extractMbtiSignals(messages)
           │       │   "独处/一个人/安静" → I +0.3
           │       │   → signals = [{dimension:'I', score:0.3, evidence:'喜欢独处'}]
           │       │
           │       └─ applyDimensionPatch(current, signals)
           │           加权融合：新值 = 旧值*0.7 + 信号*0.3
           │           重新判定 type：E_I<0 → I，S_N>0 → N...
           │           → mbti_profiles 表 UPDATE
           │
           ├─ saveProfilePatch(ctx.userId, patch)
           │   INSERT INTO profile_patches (user_id, version, patch_json)
           │   → 画像变更历史（前端能看"我画像怎么演变的"）
           │
           └─ transition(ctx, { type:'profile_updated', confidence: patch.confidence })
               ├─ ① 查转移表：CHATTING + profile_updated → PROFILE_READY
               ├─ ② 检查 guard：confidence ≥ 0.65？
               │   够 → ctx.state = 'PROFILE_READY'
               │   → 前端下次 GET /api/profile/ 会拿到 state=PROFILE_READY
               │   → 前端"开始匹配"按钮亮起 ✨
               │   不够 → 状态不变，继续 CHATTING
               └─ ③ 返回 { ok: true, from:'CHATTING', to:'PROFILE_READY' }

用户看到 AI 回复"听起来挺棒！晨跑还是夜跑？"
     │
     ▼ 此时状态：PROFILE_READY（前端按钮亮起）
     │
     ▼ 用户点"开始匹配"按钮
     │
【match.ts】POST /api/match/run
     │
     ├─ ① requireAuth → req.user
     ├─ ② ctx = getSession(userId, tenantId)
     │   → 状态 = PROFILE_READY ✓
     │
     ├─ ③ profile = loadProfile(userId)
     │   SELECT profile_json, confidence FROM profiles WHERE user_id=?
     │   画像不够 → 400 "画像还不够"
     │
     ├─ ④ transition(ctx, { type:'match_requested' })
     │   PROFILE_READY → MATCHING
     │
     ├─ ⑤ result = await matchAgent.run({ limit:5 }, ctx)
     │   │
     │   │  matchAgent.execute() 内部：
     │   │
     │   ├─ A. myProfile = profileAdapter.getUserProfile(userId)
     │   │      ← globalMemoryBus.readLongTermProfile('match', userId)
     │   │      → { tags:[{key:'interest',value:'跑步'},...], vector:[0.1,0.3,...] }
     │   │
     │   ├─ B. myVec = await embedProfile(myProfile)
     │   │      services/embedding.ts → embed(profileToText)
     │   │      → 64 维向量
     │   │
     │   ├─ C. excluded = profileAdapter.getExcludedCandidates(userId)
     │   │      ← memoryBus.getRecentCandidates('match', userId)
     │   │      → ['user-abc','user-xyz']（最近推过的不再推）
     │   │
     │   ├─ D. candidates = recallByVector(myVec, tenantId, userId, 15)
     │   │      db/vectorStore.ts
     │   │      SELECT user_id, embedding, profile_json FROM profiles
     │   │      WHERE tenant_id=? AND user_id!=? AND embedding IS NOT NULL
     │   │      → rows.map(r => ({userId, score: cosine(myVec, r.vec), profile}))
     │   │      → sort by score desc → slice(0, 15)
     │   │      （向量召回 15 个候选）
     │   │
     │   ├─ E. candidates = candidates.filter(c => !excluded.has(c.userId))
     │   │      （排除最近推过的）
     │   │
     │   ├─ F. for each candidate: 算 6 维分数
     │   │      │
     │   │      ├─ interestScore = cosine(myInterests, theirInterests)
     │   │      │   兴趣向量重合度
     │   │      │
     │   │      ├─ scheduleScore = 时间段重合
     │   │      │   "周末晚上" vs "周末晚上" → 1.0
     │   │      │   "工作日早上" vs "周末晚上" → 0.2
     │   │      │
     │   │      ├─ socialStyleScore = 社交风格匹配
     │   │      │   introvert + introvert → 0.9（同类型合得来）
     │   │      │   introvert + extrovert → 0.5（互补也行）
     │   │      │
     │   │      ├─ energyScore = 能量水平匹配
     │   │      │
     │   │      ├─ mbtiScore = computeMbtiFactor(myId, theirId)
     │   │      │   integrations/matchAgentMbtiAdapter.ts
     │   │      │   ├─ mine = getMbtiProfile(myId)   'INTJ'
     │   │      │   ├─ theirs = getMbtiProfile(theirId)  'ENFP'
     │   │      │   ├─ result = scoreCompat(mine, theirs)
     │   │      │   │   互补关系 → score: 0.85
     │   │      │   └─ return { score:0.85, reason:'互补关系', mineType:'INTJ', theirsType:'ENFP' }
     │   │      │
     │   │      └─ distanceScore = 1.0（暂未实现位置）
     │   │
     │   │      overallScore = w1*interest + w2*schedule + ... + w6*mbti
     │   │      （权重在 matchAgent 内部配置）
     │   │
     │   ├─ G. candidates.sort(by overallScore desc).slice(0, 5)
     │   │      取前 5 个
     │   │
     │   ├─ H. for each winner:
     │   │      profileAdapter.recordMatch(userId, candidate.userId, ...)
     │   │      → memoryBus.writeMatchDecision
     │   │      → matchDecisionMemory.write(entry)
     │   │      → recentCandidates.add(peerId)（下次不重复推）
     │   │
     │   ├─ I. ctx.blackboard.write('match-agent', 'match_result', candidates, 'match_result')
     │   │      （贴黑板，给 IceBreakerAgent 看）
     │   │
     │   └─ J. return { candidates, totalCount, myProfileText }
     │
     ├─ ⑥ transition(ctx, { type:'match_done' })
     │   MATCHING → MATCHED
     │
     └─ ⑦ res.json({
         candidates: result.data.candidates.map(toPublicCandidate),
         totalCount, myProfileText, state: ctx.state
     })

用户看到匹配列表，点候选人"破冰"
     │
【match.ts】POST /api/match/icebreaker
     │
     ├─ ① requireAuth
     ├─ ② ctx = getSession(...)
     ├─ ③ targetUser = SELECT * FROM users WHERE id = ?
     ├─ ④ myProfile = loadProfile(myId), peerProfile = loadProfile(targetId)
     ├─ ⑤ commonInterests = intersect(my.interests, peer.interests)
     │   → ['跑步','看书']
     ├─ ⑥ transition(ctx, { type:'icebreaker_requested' })
     │   MATCHED → ICEBREAKING
     │
     ├─ ⑦ result = await iceBreakerAgent.run({
     │     targetUserId, targetProfile: peerProfile,
     │     myInterests: myProfile.interests.map(i => i.name),
     │     commonInterests, matchScore
     │   }, ctx)
     │   │
     │   │  iceBreakerAgent.execute() 内部：
     │   │
     │   ├─ myProfile = ctx.blackboard.read('latest_profile')
     │   ├─ peerProfile = iceBreakerAdapter.getPeerProfile(targetUserId)
     │   │   ← memoryBus.readLongTermProfile('icebreaker', peerId)
     │   │
     │   ├─ llmEnabled?
     │   │   ├─ 有 Key → generateLLM()
     │   │   │   拼 prompt：
     │   │   │   "为这俩人生成 3 个破冰话题，
     │   │   │    我的兴趣: [跑步,看书], 对方的兴趣: [跑步,旅行],
     │   │   │    共同兴趣: [跑步],
     │   │   │    输出 JSON: [{topic, opener, why}]"
     │   │   │   → chatStream → extractJSON → validateJSON
     │   │   │   → [{topic:'跑步', opener:'听说你也爱跑步，最远跑过几公里？', why:'共同兴趣'}]
     │   │   │
     │   │   └─ 没 Key → generateRules()
     │   │       for interest in commonInterests:
     │   │         push { topic:interest, opener:`你也喜欢${interest}？`, why:'共同兴趣' }
     │   │
     │   ├─ ctx.blackboard.write('icebreaker-agent', 'icebreakers', result, 'icebreaker')
     │   │
     │   └─ iceBreakerAdapter.recordInteraction(...)
     │       → memoryBus.writeInteraction
     │       → interactionMemory.write(entry)
     │       → 记下"用了跑步破冰"，下次换别的
     │
     ├─ ⑧ transition(ctx, { type:'icebreaker_done' })
     │   ICEBREAKING → DONE
     │
     └─ ⑨ res.json({ icebreakers, source: 'llm'|'rules' })
```

---

## 二十一、会话状态机完整流程图

```
                    用户注册/登录
                         │
                         ▼
                   ┌─────────────┐
                   │  CHATTING   │ ← 初始状态
                   │  (聊天中)   │
                   └─────────────┘
                         │
                    profile_updated
                    confidence ≥ 0.65
                         │
                         ▼
                ┌──────────────────┐
                │  PROFILE_READY   │ ← 前端"开始匹配"按钮亮起
                │  (画像已就绪)    │
                └──────────────────┘
                         │
                    match_requested
                         │
                         ▼
                   ┌─────────────┐
                   │  MATCHING   │ ← 匹配中（loading）
                   │  (匹配中)   │
                   └─────────────┘
                         │
                    match_done
                         │
                         ▼
                   ┌─────────────┐
                   │   MATCHED   │ ← 显示候选人列表
                   │  (已匹配)   │
                   └─────────────┘
                         │
                    icebreaker_requested
                         │
                         ▼
                 ┌─────────────────┐
                 │  ICEBREAKING    │ ← 生成破冰话题中
                 │  (破冰中)       │
                 └─────────────────┘
                         │
                    icebreaker_done
                         │
                         ▼
                   ┌─────────────┐
                   │    DONE     │ ← 完成（可开始新会话）
                   │   (已完成)  │
                   └─────────────┘
                         │
                    reset
                         │
                         ▼
                   回到 CHATTING

  任意状态 + reset 事件 → 回到 CHATTING（清黑板）
```

---

## 二十二、关键时序图：完整一次用户旅程

```
用户          前端            后端            DeepSeek        SQLite         Redis         MemoryBus
 │             │               │               │              │             │             │
 │  发消息     │               │               │              │             │             │
 ├────────────►│  POST /chat   │               │              │             │             │
 │             ├──────────────►│               │              │             │             │
 │             │               │  存用户消息    │              │             │             │
 │             │               ├──────────────────────────────►│             │             │
 │             │               │  拉历史 20 条  │              │             │             │
 │             │               ├──────────────────────────────►│             │             │
 │             │               │  streamReply  │              │             │             │
 │             │               ├──────────────►│  chatStream │             │             │
 │             │               │               │  SSE 流     │             │             │
 │             │  SSE delta    │◄──────────────┤  onDelta    │             │             │
 │             │◄──────────────┤               │              │             │             │
 │  看到字      │               │               │              │             │             │
 │◄────────────┤               │               │              │             │             │
 │             │               │  存 AI 回复    │              │             │             │
 │             │               ├──────────────────────────────►│             │             │
 │             │               │  异步抽画像    │              │             │             │
 │             │               ├──────────────►│  chatStream │             │             │
 │             │               │               │  返回 JSON  │             │             │
 │             │               │◄──────────────┤              │             │             │
 │             │               │  写黑板        │              │             │             │
 │             │               │  存 profile    │              │             │             │
 │             │               ├──────────────────────────────►│             │             │
 │             │               │  存 patch      │              │             │             │
 │             │               ├──────────────────────────────►│             │             │
 │             │               │  更新 MemoryBus│             │             │             │
 │             │               ├─────────────────────────────────────────────────────────►│
 │             │               │  更新 MBTI    │              │             │             │
 │             │               ├──────────────►│  抽 MBTI    │             │             │
 │             │               │  transition   │              │             │             │
 │             │               │  (状态→PROFILE_READY)        │             │             │
 │             │               │               │              │             │             │
 │  点匹配     │               │               │              │             │             │
 ├────────────►│  POST /match  │               │              │             │             │
 │             ├──────────────►│               │              │             │             │
 │             │               │  loadProfile  │              │             │             │
 │             │               ├──────────────────────────────►│             │             │
 │             │               │  transition   │              │             │             │
 │             │               │  matchAgent   │              │             │             │
 │             │               │  recallByVec  │              │             │             │
 │             │               ├──────────────────────────────►│             │             │
 │             │               │  computeMbti  │              │             │             │
 │             │               │  recordMatch → MemoryBus    │             │             │
 │             │               ├─────────────────────────────────────────────────────────►│
 │             │               │  transition   │              │             │             │
 │             │  candidates   │◄──────────────┤              │             │             │
 │             │◄──────────────┤               │              │             │             │
 │  看候选人    │               │               │              │             │             │
 │◄────────────┤               │               │              │             │             │
```

---

## 二十三、文件大小与重要性分级

```
═══════════════════════════════════════════════════════════════════
                    文件重要性分级
═══════════════════════════════════════════════════════════════════

【S 级 - 核心业务逻辑】
   agents/profileAgent.ts        用户聊天 + 画像抽取
   agents/matchAgent.ts          匹配算法
   agents/iceBreakerAgent.ts     破冰生成
   core/orchestrator.ts          会话状态机
   core/blackboard.ts            Agent 间通信
   routes/chat.ts                聊天主接口
   routes/match.ts               匹配主接口
   services/llmClient.ts         LLM 调用
   db/vectorStore.ts              向量检索

【A 级 - 增强能力】
   memory/memoryBus.ts           4 层记忆总线
   integrations/agentMemoryAdapter.ts  Agent↔Memory 桥
   integrations/cacheLlmAdapter.ts     缓存优先 LLM
   compress/autoCompact.ts             自动压缩
   mbti/mbtiEngine.ts                  MBTI 引擎
   integrations/matchAgentMbtiAdapter.ts  MBTI 匹配桥
   services/embedding.ts              向量嵌入
   services/auth.ts                   认证
   middleware/auth.ts                 鉴权中间件

【B 级 - 基础设施】
   db/index.ts, db/schema.ts         数据库
   redis/redisClient.ts              Redis
   integrations/lifecycleAdapter.ts  生命周期
   core/tokenBudget.ts               预算控制
   core/antiloop.ts                  防循环
   core/structuredOutput.ts          LLM 输出修复
   services/rateLimiter.ts           限流

【C 级 - 辅助】
   routes/dm.ts                     私聊
   routes/profile.ts                画像查看
   routes/privacy.ts                隐私
   routes/health.ts                 健康检查
   routes/test.ts                   测试
   services/aiBotReplier.ts         AI bot
   services/traceLogger.ts          日志
   scripts/*                        脚本
```

---

## 二十四、技术亮点总结

```
═══════════════════════════════════════════════════════════════════
                       8 大技术亮点
═══════════════════════════════════════════════════════════════════

1. 多 Agent 黑板模式
   - ProfileAgent、MatchAgent、IceBreakerAgent 三个 Agent
   - 通过 blackboard.write/read 解耦，没有循环依赖
   - 同 key 覆盖语义：'latest_profile' 始终是最新值

2. 状态机驱动会话
   - 6 个状态：CHATTING → PROFILE_READY → MATCHING → MATCHED
              → ICEBREAKING → DONE
   - transition() 集中校验，禁止非法跳转
   - guard 保护：confidence ≥ 0.65 才能进 PROFILE_READY

3. 双模式兜底
   - 每个 Agent 都有 LLM 路径 + 规则路径
   - LLM_API_KEY 没配也能跑（templateReply + generateRules）
   - 开发环境无感切换

4. Token 预算管控
   - 75% 软提醒："聚焦核心字段"
   - 90% 强制停："预算耗尽"
   - 检测产出递减：连续 3 轮 < 200 字 → "产出递减"

5. LLM 输出三层修复
   - quickFixJSON：修格式（尾逗号、单引号、未引用 key）
   - extractJSON：从文本抠 JSON
   - validateJSON：按 schema 校验

6. 4 层记忆架构
   - 短期（会话内 20 条）
   - 长期画像（标签 + 向量）
   - 匹配决策（避免重复推）
   - 互动记录（优化破冰）
   - MemoryBus 统一入口，Redis 持久化

7. 前缀缓存省 token
   - 维护稳定 prefix + 增量 log
   - DeepSeek 自动识别前缀缓存命中
   - 超阈值自动压缩（autoCompact）

8. MBTI 6 维匹配
   - 兴趣 + 时间 + 社交风格 + 能量 + MBTI + 距离
   - MBTI 经典相性表（互补如 INTJ+ENFP → 0.85）
   - 抽取信号：加权融合（旧值*0.7 + 信号*0.3）

═══════════════════════════════════════════════════════════════════
                  完整文档结束（共 24 章）
═══════════════════════════════════════════════════════════════════
```