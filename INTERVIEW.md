# 面试冲刺手册：基于多智能体的对话式社交匹配系统

> **用途**：明天面试前必读。读完能口述每个设计决策的"为什么"，能扛住技术拷打。
> **配套**：代码已全部加豪华版注释，每个文件点开即见"小王情景 + 文件路径"。
> **建议阅读顺序**：先读第 0 章电梯演讲 → 第 1-3 章建立整体认知 → 第 8 章 Q&A 自测 → 第 11 章亮点话术背诵。

---

## 目录

- [0. 30 秒电梯演讲](#0-30-秒电梯演讲)
- [1. 课题背景与产品价值](#1-课题背景与产品价值)
- [2. 系统架构总览](#2-系统架构总览)
- [3. 核心数据流：小王从注册到匹配成功](#3-核心数据流小王从注册到匹配成功)
- [4. 三大 Agent 详解](#4-三大-agent-详解)
- [5. Agent 协作框架（core/）](#5-agent-协作框架core)
- [6. 关键技术深挖](#6-关键技术深挖)
- [7. 数据库与隐私设计](#7-数据库与隐私设计)
- [8. 面试拷打 Q&A（30 题）](#8-面试拷打-qa30-题)
- [9. 代码导航地图](#9-代码导航地图)
- [10. 你的亮点话术](#10-你的亮点话术)
- [11. 已知局限 & 后续 Roadmap](#11-已知局限--后续-roadmap)

---

## 0. 30 秒电梯演讲

> 这是一段背下来就能开口讲的话术，**1 分钟讲完**。

> "我做的是一个**基于多 Agent 协作的对话式社交匹配系统**。传统找搭子平台要用户填一堆标签、勾一堆筛选条件，门槛高、维度有限、匹配精度低。
>
> 我的方案是**让用户什么都不填**，只跟 AI 自然聊天。背后三个 Agent 分工协作：**画像采集 Agent** 在对话中隐式抽取兴趣/性格/目标；**匹配决策 Agent** 用向量召回 + 5 维规则排序做可解释推荐；**撮合辅助 Agent** 基于双方画像生成 3 条破冰话术，降低社交启动成本。
>
> 三个 Agent 不直接互调，而是通过**黑板模式**解耦通信；用**状态机编排器**控会话流转（CHATTING → PROFILE_READY → MATCHING → MATCHED → ICEBREAKING → DONE）；带 **Tracer 全链路追踪**、**TokenBudget 预算控制**、**AntiLoop 防死循环**、**StructuredOutput 容错解析**四个生产级组件。
>
> 后端 TypeScript + Express + SQLite（WAL 模式），LLM 接 DeepSeek 推理模型，向量支持 API/本地双模式降级。整套系统能跑、能调、能在 API 失效时降级到规则模式继续工作。"

**为什么这套话术有效**：
- 第一句讲清"做什么 + 解决什么痛点"
- 第二段亮出"三大 Agent + 协作机制"——这是课题要求的核心关键词
- 第三段亮出"工程化能力"——Tracer/Budget/Antiloop/StructuredOutput 体现生产级思维
- 第四段亮出"技术栈"——一句话交代后端

---

## 1. 课题背景与产品价值

### 1.1 痛点（开场必背）

| 传统平台的问题 | 我的方案怎么解 |
|----------------|----------------|
| 注册要填 50 个表单字段，门槛高 | **零表单**，全程自然对话 |
| 标签维度有限（兴趣/年龄/性别） | 画像 5 维：兴趣/社交风格/活跃时段/目标/雷区 |
| 用户瞎填标签（说喜欢跑步其实不跑） | **对话溯源**：每个标签都带 evidence 原话 + 置信度 |
| 匹配是黑盒，不知为啥推这人 | **可解释推荐**：5 维因子 + 共同兴趣 + 文字 explanation |
| 匹配后没人说话，社交启动难 | **破冰 Agent** 生成 3 条话术，复制即发 |

### 1.2 落地场景（课题明确要求）

- **企业内部员工社交**：HR 给新员工找搭子，降低离职率
- **兴趣社群运营**：豆瓣/小红书把同好撮合起来
- **会展参会者匹配**：参会前 AI 帮你找 3 个聊得来的人

### 1.3 课题关键词与项目映射

| 课题要求关键词 | 我项目里对应 |
|----------------|-------------|
| LLM 多轮对话管理 | [profileAgent.streamReply](file:///e:/DaZi/server/src/agents/profileAgent.ts) + [chat.ts SSE 流式](file:///e:/DaZi/server/src/routes/chat.ts) |
| 用户画像向量化 | [embedding.ts](file:///e:/DaZi/server/src/services/embedding.ts) + [vectorStore.ts](file:///e:/DaZi/server/src/db/vectorStore.ts) |
| 多 Agent 协作框架 | [blackboard.ts](file:///e:/DaZi/server/src/core/blackboard.ts) + [orchestrator.ts](file:///e:/DaZi/server/src/core/orchestrator.ts) |
| 可解释推荐 | [matchAgent.computeFactors + buildExplanation](file:///e:/DaZi/server/src/agents/matchAgent.ts) |

---

## 2. 系统架构总览

### 2.1 分层架构图

```
┌──────────────────────────────────────────────────────────────┐
│  前端（5173）— 聊天 UI / 匹配卡片 / 破冰话术展示                │
└────────────────────┬─────────────────────────────────────────┘
                     │ HTTP + SSE
┌────────────────────▼─────────────────────────────────────────┐
│  Express 入口  index.ts                                       │
│  中间件链：CORS → JSON → Cookie → 安全头 → 路由 → 404 → 错误   │
└────────────────────┬─────────────────────────────────────────┘
                     │
        ┌────────────┴──────────────┐
        ▼                           ▼
┌──────────────────┐      ┌──────────────────┐
│  routes/         │      │  middleware/    │
│  - chat.ts   SSE │      │  - auth.ts JWT  │
│  - match.ts      │◀────▶│  鉴权注入 user  │
│  - profile.ts    │      └──────────────────┘
│  - dm.ts         │
│  - auth.ts       │
│  - privacy.ts    │
│  - health.ts     │
└────────┬─────────┘
         │ 调用
         ▼
┌──────────────────────────────────────────────────────────────┐
│  agents/   三大业务 Agent                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ ProfileAgent │  │  MatchAgent   │  │IceBreakerAgnt│       │
│  │ 隐式抽画像   │  │ 召回+5维排序  │  │ 3条破冰话术  │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │ 继承 BaseAgent + LLM 降级 + 黑板读写                │
│  └──────┴──────────────┴──────────────┴────────────┘         │
└────────┬─────────────────────────────────────────────┬───────┘
         │ 依赖框架                                      │ 调用服务
         ▼                                              ▼
┌──────────────────────────────┐         ┌──────────────────────┐
│  core/  Agent 框架骨架        │         │  services/           │
│  - orchestrator 状态机        │         │  - llmClient.ts SSE   │
│  - blackboard   黑板通信      │         │  - embedding.ts 向量  │
│  - tracer       链路追踪      │         │  - auth.ts JWT+bcrypt│
│  - tokenBudget  预算控制      │         │  - rateLimiter.ts 限流│
│  - antiloop     防死循环      │         └──────────────────────┘
│  - structuredOutput JSON容错  │
└──────────────────────────────┘
         │ 持久化
         ▼
┌──────────────────────────────────────────────────────────────┐
│  db/   SQLite (WAL 模式)                                       │
│  - schema.ts 9 张表（users/profiles/profile_patches/         │
│              conversations/chat_sessions/matches/dm_*/audit） │
│  - index.ts   连接管理 + 单例                                 │
│  - vectorStore.ts 向量存+余弦相似度                            │
└──────────────────────────────────────────────────────────────┘
         ▲
         │ 配置
┌────────┴─────────────────────────────────────────────────────┐
│  config/index.ts   环境变量 + 默认值（端口/模型/权重/阈值）   │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 三大核心 Agent + 协作框架

```
                  ┌──────────────────────────────┐
                  │   orchestrator（状态机）     │
                  │   CHATTING → PROFILE_READY   │
                  │   → MATCHING → MATCHED        │
                  │   → ICEBREAKING → DONE       │
                  └─────────────┬────────────────┘
                                │ 发信号
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
   ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐
   │  ProfileAgent    │  │  MatchAgent  │  │ IceBreaker   │
   │                  │  │              │  │              │
   │ 双职责：          │  │ 6 步：       │  │ 双模式：     │
   │ ① streamReply    │  │ ① loadProfile│  │ ① LLM 生成   │
   │   流式聊（前端    │  │ ② embed      │  │ ② 模板降级   │
   │   秒看打字）     │  │ ③ recall     │  │              │
   │ ② run(execute)   │  │ ④ 5维因子   │  │ 输出 3 条    │
   │   抽画像存DB     │  │ ⑤ 加权排序   │  │ ≤30 字话术   │
   └────────┬─────────┘  │ ⑥ 持久化     │  └──────┬───────┘
            │            └──────┬───────┘         │
            │ 写入             写入                │ 读取
            ▼                   ▼                  ▼
   ┌──────────────────────────────────────────────────────┐
   │              blackboard（共享黑板）                  │
   │   5 类便条：profile_patch / match_result /           │
   │            icebreaker / warning / decision           │
   │   机制：write(agentId, key, value, category)        │
   │        read(key) → O(1) Map 索引                    │
   └──────────────────────────────────────────────────────┘
```

---

## 3. 核心数据流：小王从注册到匹配成功

> 这是面试时**最有杀伤力的故事**——把整个项目串起来讲。背熟。

### 3.1 全链路时间轴

```
T=0s    小王打开前端 → 注册
        POST /api/auth/register
        → server/src/services/auth.ts → bcrypt 哈希密码
        → INSERT INTO users (id='u_abc', tenant_id='default', ...)

T=2s    小王进入聊天，发"我最近开始跑步了"
        POST /api/chat/messages  body:{content, sessionId}
        │
        ├─ requireAuth 中间件 → 验 JWT → req.user={id, tenantId}
        ├─ rateLimiter.consume() → 滑动窗口检查 → {allowed:true, remaining:19}
        ├─ INSERT conversations (role='user', content='我最近开始跑步了')
        ├─ SELECT 最近 20 条对话作上下文
        │
        ├─▶ profileAgent.streamReply()  ← 同步流式回复
        │    ├─ 拼 system prompt（含画像+对话原则）
        │    ├─ chatStream(messages, {onDelta, onReasoning})
        │    │   └─ POST https://api.deepseek.com/chat/completions
        │    │      stream:true → SSE 一行一行收
        │    │      data:{"delta":{"reasoning_content":"..."}} → onReasoning
        │    │      data:{"delta":{"content":"听起来"}} → onDelta
        │    │      → 前端秒看到打字效果 + 思考框
        │    └─ 返回 {text:"听起来挺棒！晨跑还是夜跑？"}
        │
        └─▶ profileAgent.run()  ← 异步后台执行（不阻塞回复）
             ├─ execute() 5 件事：
             │   a. extractProfile() 调 LLM 抽 patch
             │      → {interests:[{name:'跑步',confidence:0.8,evidence:'我最近开始跑步了'}]}
             │   b. loadProfile() 从 DB 读旧画像
             │   c. applyPatch() 增量合并 → 新画像
             │   d. persistProfile() 存 profiles 表 + persistPatch() 存 profile_patches 审计
             │   e. embed() 算画像向量 + updateProfileEmbedding()
             │   f. blackboard.write('latest_profile', 画像, 'profile_patch')
             │   g. transition(ctx, {type:'profile_updated', confidence:0.8})
             │      → profileConfidence=0.8 ≥ 0.65 → state=PROFILE_READY
             └─ 前端收到新状态 → "开始匹配"按钮亮起

T=8s    小王点"开始匹配"
        POST /api/match/run
        │
        ├─ transition(ctx, {type:'match_requested'}) → state=MATCHING
        ├─ matchAgent.run()
        │   ├─ ① loadProfile(u_abc)
        │   ├─ ② myVec = embed(profileToText(profile))  // 1536 维
        │   ├─ ③ recallByVector(myVec, tenant='default', exclude=u_abc, topK=20)
        │   │   └─ vectorStore SELECT * FROM profile_embeddings
        │   │      ORDER BY cosine_sim DESC LIMIT 20
        │   ├─ ④ 对每个候选算 5 维因子 + 加权综合分
        │   │   factors = {
        │   │     vector: 0.82,       // 向量相似度（召回时算的）
        │   │     interest: 0.6,      // 共同兴趣比例
        │   │     style: 0.85,        // 社交风格匹配（introvert vs introvert）
        │   │     schedule: 0.7,      // 时段重合（周末都活跃）
        │   │     goal: 0.9,         // 目标互补（都找跑步搭子）
        │   │   }
        │   │   score = 0.35×0.82 + 0.25×0.6 + 0.20×0.85 + 0.10×0.7 + 0.10×0.9
        │   │        = 0.287 + 0.15 + 0.17 + 0.07 + 0.09 = 0.767
        │   ├─ ⑤ sort + slice(0, finalN=5)
        │   ├─ ⑥ blackboard.write('latest_matches', top5, 'match_result')
        │   └─ ⑦ INSERT matches (tenant, user_id, target_id, score, factors, ...)
        ├─ transition(ctx, {type:'match_done'}) → state=MATCHED
        └─ 返回 {candidates: [{userId:'u_xxx', displayName:'林夕', score:0.767,
                              factors:{...}, commonInterests:['跑步'],
                              explanation:'你们都喜欢跑步，作息都偏周末...'}]}

T=10s   小王看到候选卡片，点"破冰话术"（针对林夕）
        POST /api/match/icebreak  body:{targetUserId:'u_xxx'}
        │
        ├─ transition(ctx, {type:'icebreak_requested'}) → state=ICEBREAKING
        ├─ iceBreakerAgent.run()
        │   ├─ LLM 模式：
        │   │   ├─ system: "你是社交破冰专家...输出 JSON 数组"
        │   │   ├─ user: 仅传画像标签（不传原话，隐私保护）
        │   │   │        "我的兴趣：跑步 / 对方兴趣：跑步 羽毛球 /
        │   │   │         共同：跑步 / 风格：introvert/depth /
        │   │   │         匹配度：77%"
        │   │   ├─ chatOnce(messages, {maxTokens:256, temperature:0.8})
        │   │   ├─ ctx.budget.recordApiUsage(inputTokens, outputTokens)
        │   │   ├─ quickFixJSON(text) → extractJSON → 校验 Array<string>
        │   │   └─ return ["周末跑步吗？我推了一条晨跑路线",
        │   │               "听说你也喜欢跑步，加一程？",
        │   │               "爱好跑步的人都不太啰嗦，对吧"]
        │   ├─ LLM 失败 → 模板降级：
        │   │   └─ generateTemplate() 用共同兴趣+风格拼话术
        │   ├─ persistIcebreakers() 存 DB
        │   └─ blackboard.write('latest_icebreaker', 话术, 'icebreaker')
        ├─ transition(ctx, {type:'icebreak_done'}) → state=DONE
        └─ 返回 {icebreakers:[...], source:'llm'|'template'}

T=11s   小王复制第 1 条话术，给林夕发 DM
        POST /api/dm/u_xxx  body:{content:'周末跑步吗？我推了一条晨跑路线'}
        → INSERT dm_messages
        → 林夕下次登录看到未读
```

### 3.2 数据流图（简化版）

```
注册 → [users 表]
聊天 → [conversations 表] → ProfileAgent.streamReply → LLM 流式回前端
                          ↘ ProfileAgent.run 异步：
                              ├→ extractProfile → patch
                              ├→ applyPatch → [profiles 表] + [profile_patches 表]
                              ├→ embed → [profile_embeddings 表]
                              └→ blackboard.write('latest_profile')
匹配 → MatchAgent.run:
        loadProfile ← [profiles 表]
        recallByVector ← [profile_embeddings 表] → top20
        computeFactors × 5 维 → 加权排序 → top5
        persistMatches → [matches 表]
        blackboard.write('latest_matches')
破冰 → IceBreakerAgent.run:
        blackboard.read('latest_matches') → 取候选
        chatOnce → LLM 生成 3 条
        persistIcebreakers → [dm_messages 表（is_icebreaker=1）]
```

---

## 4. 三大 Agent 详解

### 4.1 ProfileAgent 画像采集 Agent

**文件**：[server/src/agents/profileAgent.ts](file:///e:/DaZi/server/src/agents/profileAgent.ts)

#### 核心创新：**不让用户填表**

传统 App 一上来扔 50 个表单字段，用户跑路。本系统用 AI 边聊边抽，用户感觉在闲聊，AI 在后台挖画像。

#### 双职责设计（**面试必考**）

```
┌────────────────────────────────────────────┐
│  profileAgent 有两个入口，并行执行：        │
├────────────────────────────────────────────┤
│                                            │
│  入口 1：streamReply()  ← 同步流式         │
│    调用方：chat.ts 收到消息时               │
│    任务：生成 AI 回复，SSE 推前端          │
│    用户感受：秒看到打字效果                │
│                                            │
│  入口 2：run() → execute()  ← 异步后台     │
│    调用方：chat.ts 回复完成后 fire-and-    │
│            forget                          │
│    任务：抽画像 → 合并 → 存 DB → 算向量    │
│    用户感受：无（后台 5-10s 跑完）         │
│                                            │
│  为什么这么设计？                           │
│    抽画像调 LLM 要 5-10s，如果阻塞回复，   │
│    用户要等 10s 才看到字，体验崩。         │
│    分两路：先秒回（满足"快"），后异步抽     │
│    （满足"准"）。                          │
└────────────────────────────────────────────┘
```

#### execute() 5 件事（**背下来**）

1. **extractProfile()** — 调 LLM 抽画像 patch
   - 输入：最近 N 条对话
   - 输出：`{interests:[{name,confidence,evidence}], socialStyle:{...}, ...}`
2. **loadProfile()** — 从 DB 读旧画像
3. **applyPatch()** — 增量合并（新兴趣追加 + 老兴趣置信度更新）
4. **persistProfile() + persistPatch()** — 存画像主表 + 存变更审计表
5. **embed() + updateProfileEmbedding()** — 算向量存向量库
6. **blackboard.write('latest_profile', ...)** — 贴黑板便条给 MatchAgent

#### 双模式降级（**面试必考**）

| 模式 | 触发条件 | 实现 | 代价 |
|------|---------|------|------|
| LLM 模式 | 有 `LLM_API_KEY` 配置 | 调 DeepSeek 抽画像 + 聊天 | 智能，但花钱 |
| 降级模式 | 无 Key / LLM 失败 | 关键词匹配 + 模板回复 | 免费，但傻 |

**降级为什么重要**：
- API Key 可能没钱 / 被墙 / 超时
- 系统要保证"任何时候都能用"
- MatchAgent 不依赖 LLM（向量召回是 SQLite 数学运算），所以即使降级也能匹配
- 用户体验：从"智能朋友"降级到"机械客服"，但**核心功能不挂**

### 4.2 MatchAgent 匹配决策 Agent

**文件**：[server/src/agents/matchAgent.ts](file:///e:/DaZi/server/src/agents/matchAgent.ts)

#### 6 步流水线

```
① loadProfile(myId)        → 加载我的画像
② embed(profileToText)     → 1536 维向量
③ recallByVector           → SQLite ORDER BY cosine_sim DESC LIMIT 20
                            （排除自己、限租户）
④ computeFactors × topK    → 5 维因子（详见下）
⑤ weightedScore + sort     → 加权综合分排序 → top5
⑥ persistMatches           → 批量写 matches 表（事务）
   blackboard.write        → 贴给 IceBreaker 读
```

#### 5 维匹配因子（**核心创新，面试必讲**）

| 因子 | 权重 | 含义 | 计算方法 |
|------|------|------|---------|
| `vector` | 0.35 | 画像语义相似度 | SQLite 余弦相似度（召回时算好） |
| `interest` | 0.25 | 共同兴趣比例 | Jaccard 风格：共同兴趣数 / 较小集合大小 |
| `style` | 0.20 | 社交风格匹配 | introvert vs introvert +0.6；对立 +0.2；混合型居中 |
| `schedule` | 0.10 | 活跃时段重合 | 集合交集比例 |
| `goal` | 0.10 | 目标互补 | "找跑步搭子"对"找跑步搭子" = 高分；目标互补也高分 |

**综合分公式**：
```
score = 0.35×vector + 0.25×interest + 0.20×style + 0.10×schedule + 0.10×goal
```

#### 可解释推荐（**面试必杀技**）

每个候选不只返回分数，还返回 `explanation` 字符串：

```
"你们都喜欢跑步，作息都偏周末活跃。
 林夕偏 introvert，跟你风格相近，
 你们都找周末跑步搭子——很合拍！"
```

**前端直接渲染**到候选卡片下方。这是相比传统黑盒匹配（如陌陌）的核心竞争力。

#### 为什么 MatchAgent 不调 LLM？

**这是面试官一定会问的"为什么"**：
- LLM 调用慢（1-2s）+ 贵 + 不稳定
- 向量召回 + 规则排序是确定性算法，毫秒级出结果
- 一致性：LLM 同样输入可能给不同分，规则算法稳定
- 可解释性：规则的每个分量能拆给用户看，LLM 黑盒
- 经济性：免费 → 用户每分钟都能匹配

### 4.3 IceBreakerAgent 撮合辅助 Agent

**文件**：[server/src/agents/iceBreakerAgent.ts](file:///e:/DaZi/server/src/agents/iceBreakerAgent.ts)

#### 输出 3 条破冰话术

- 每条 ≤30 字，口语化
- 风格不同：① 共同兴趣 ② 轻松幽默 ③ 真诚直接
- 禁用"你好""在吗"等无效开场

#### 双模式（同 ProfileAgent）

| 模式 | 实现 |
|------|------|
| LLM | system prompt + chatOnce（一次性，非流式，话术很短） |
| 模板 | generateTemplate() 用共同兴趣+风格拼装 |

#### 隐私设计（**面试必讲**）

调 LLM 时**只传画像标签，不传对话原话**：

```
✅ 传给 LLM 的内容：
   "我的兴趣：跑步、羽毛球
    对方兴趣：跑步、电影
    共同兴趣：跑步
    对方社交风格：introvert/depth
    对方目标：周末跑步搭子
    匹配度：77%"

❌ 不传的内容：
   - 小王聊过的所有原话
   - 林夕聊过的所有原话
   - 任何 PII（手机号/邮箱/真实姓名）
```

**为什么这么设计**：
- LLM API 是第三方服务，传原话 = 隐私泄露
- 画像标签是已抽取的结构化信息，不含 PII
- 即使 LLM 服务商记录请求，也看不到原始对话
- 满足 PIPL/GDPR 数据最小化原则

---

## 5. Agent 协作框架（core/）

### 5.1 Blackboard 黑板模式

**文件**：[server/src/core/blackboard.ts](file:///e:/DaZi/server/src/core/blackboard.ts)

#### 为什么用黑板？不用直接调用？

**不用黑板的灾难场景**：

```
假设：profileAgent 直接 import matchAgent
     matchAgent  也直接 import profileAgent（拿画像）
后果：
  ① Node.js 模块加载死锁
  ② matchAgent 改返回值，所有调用方都得改
  ③ 加新 Agent 要改所有现有 Agent
  ④ 异步难：profileAgent 调 LLM 要 5s，
            matchAgent 怎么知道画像写完了？
```

**黑板方案**：

```
ProfileAgent 写完画像 → blackboard.write('latest_profile', 画像)
MatchAgent 想用       → blackboard.read('latest_profile')
→ 互不认识，零依赖，异步天然支持
```

#### 5 类便条（BBCategory）

| 类别 | 写入者 | 内容 |
|------|--------|------|
| `profile_patch` | ProfileAgent | 画像增量 |
| `match_result` | MatchAgent | 候选列表 |
| `icebreaker` | IceBreaker | 破冰话术 |
| `warning` | 任意 Agent | 警告 |
| `decision` | Orchestrator | 阶段决策（默认） |

#### 数据结构（**面试加分项**）

```typescript
entries: BlackboardEntry[]          // 数组存便条
keyIndex: Map<string, number>      // key→数组位置索引

read(key) → keyIndex.get(key) → entries[idx]  // O(1) 查找
```

**为什么用 Map 索引**：
- 直接数组 find() 是 O(n)
- 黑板便条多了之后性能差
- Map 索引让 read() 永远 O(1)

### 5.2 Orchestrator 状态机

**文件**：[server/src/core/orchestrator.ts](file:///e:/DaZi/server/src/core/orchestrator.ts)

#### 6 个状态 + 5 个信号

```
   profile_updated(confidence≥0.65)
   ┌────────────────────────┐
   │                        ▼
CHATTING ──match_requested──> MATCHING ──match_done──> MATCHED
   ▲                            ▲                       │
   │                            │                       │ icebreak_requested
   │                            │                       ▼
   └────────────────── ICEBREAKING ◀── icebreak_requested
                            │
                            │ icebreak_done
                            ▼
                           DONE
```

| 信号 | 触发者 | 状态转移 |
|------|--------|---------|
| `profile_updated` | ProfileAgent.run | CHATTING→PROFILE_READY（confidence≥0.65） |
| `match_requested` | routes/match.ts | CHATTING/PROFILE_READY/MATCHED→MATCHING |
| `match_done` | routes/match.ts | MATCHING→MATCHED |
| `icebreak_requested` | routes/match.ts | MATCHED→ICEBREAKING |
| `icebreak_done` | routes/match.ts | ICEBREAKING→DONE |

#### 为什么要状态机？

**面试标准答案**：
- **防止乱序**：用户点了匹配又点取消，迟到信号会被守卫丢弃
- **降级兜底**：CHATTING 状态也能匹配（confidence<0.65 时给用户兜底）
- **可观测**：每个状态都是可观察的，前端按状态切 UI
- **可扩展**：加新阶段（如"匹配反馈"）只需加一个状态和信号

#### 关键阈值：`0.65`

画像置信度达到 0.65 → 状态从 CHATTING → PROFILE_READY → 前端"开始匹配"按钮亮起。

**为什么是 0.65**：
- 经验值：聊 3-5 轮自然能抽到 0.65 以上
- 太低（如 0.3）：画像不靠谱，匹配质量差
- 太高（如 0.9）：用户聊半天按钮还不亮，体验差

### 5.3 Tracer 全链路追踪

**文件**：[server/src/core/tracer.ts](file:///e:/DaZi/server/src/core/tracer.ts)

#### 设计

```typescript
startSpan('match-agent', {userId: 'u_abc'})   // 开始一段
addStep('recall', {event:'recall_done', count:20})  // 加步骤
endSpan({result: 'ok', returned: 5})          // 结束段
```

#### 为什么必须有 Tracer？

- **多 Agent 协作故障定位难**：MatchAgent 出错，是画像问题还是向量问题？没 Tracer 抓瞎
- **LLM 调用是黑盒**：哪一步调 LLM、用了多少 token、为什么慢，全靠 Tracer 暴露
- **生产级必备**：面试官一看 Tracer 就知道你做过真实系统，不是玩具

### 5.4 TokenBudget 预算控制

**文件**：[server/src/core/tokenBudget.ts](file:///e:/DaZi/server/src/core/tokenBudget.ts)

#### 三级阈值

```
0% ───────────── 75% ───────────── 90% ─────────── 100%
                  │                  │
                  ▼                  ▼
              软提醒              硬停
            （日志记录）       （拒绝新 LLM 调用）
```

#### 为什么需要预算？

- LLM 调用按 token 计费
- 不控制 → 一个用户聊一晚上烧光预算
- 75% 软提醒：日志告警，运维关注
- 90% 硬停：拒绝新调用，降级到规则模式
- **递减收益**：消耗越多，越倾向拒绝（防止超支）

### 5.5 AntiLoop 防死循环

**文件**：[server/src/core/antiloop.ts](file:///e:/DaZi/server/src/core/antiloop.ts)

#### 检测机制

```typescript
recordAction('match_agent.run', signature)  // 记录
isLoop('match_agent.run', signature)       // 检测：最近 N 次签名是否相同
```

#### 为什么需要？

- Agent 设计可能死循环：A 失败重试 B，B 失败重试 A
- ProfileAgent 抽画像失败 → MatchAgent 拿不到画像 → 触发重抽 → 又失败 → 死循环
- AntiLoop 检测到连续相同签名 → 主动 break + 写 warning 黑板便条

### 5.6 StructuredOutput JSON 容错

**文件**：[server/src/core/structuredOutput.ts](file:///e:/DaZi/server/src/core/structuredOutput.ts)

#### 三道防线

```
LLM 输出文本
    │
    ▼
① quickFixJSON(text)
   - 去掉 ```json``` 包裹
   - 修尾逗号 [1,2,] → [1,2]
   - 修单引号 → 双引号
    │
    ▼
② extractJSON(text)
   - 从混合文本里抠出 {...} 或 [...]
    │
    ▼
③ validateJSON(parsed, schema)
   - 检查字段类型/必填
   - 失败 → 抛错，上层降级
```

#### 为什么需要？

- LLM 输出不稳定，可能带 markdown、可能多尾逗号
- 直接 JSON.parse 一次失败就完蛋
- 三道防线 → 即使 LLM 输出有瑕疵也能用
- 实在解析不了 → 抛错 → 上层 catch 走模板降级

---

## 6. 关键技术深挖

### 6.1 隐式画像采集

**课题核心关键词**。**面试官必问**。

#### 传统方式 vs 我的方案

| 传统 | 我的 |
|------|------|
| 注册时弹表单，要用户填 | 不填，直接聊天 |
| 标签静态，用户不更新就过期 | 增量更新，越聊越准 |
| 用户瞎填（说喜欢跑步其实不跑） | evidence 溯源到原话 |
| 维度有限（兴趣/年龄/性别） | 5 维：兴趣/社交风格/时段/目标/雷区 |

#### 画像数据结构

```typescript
interface Profile {
  basic: { userId, createdAt, version }
  interests: Array<{
    name: string              // "跑步"
    confidence: number         // 0-1
    evidence: string          // "我最近开始跑步了"（原话溯源）
  }>
  socialStyle: {
    energy: 'introvert' | 'ambivert' | 'extrovert' | 'unknown'
    depth: 'shallow' | 'deep' | 'unknown'
  }
  schedule: string[]          // ["weekend", "evening"]
  goal: string                // "周末爬山搭子"
  constraints: string[]       // 雷区 ["不喜欢群体活动"]
  confidence: number          // 整体置信度（触发匹配用）
}
```

#### 增量更新算法（applyPatch）

```
旧画像：[{name:'跑步', confidence:0.8, ...}]
Patch：[{name:'跑步', confidence:0.9}, {name:'羽毛球', confidence:0.7}]

合并后：
  - 跑步：confidence 0.8 → 0.9（更新）
  - 羽毛球：追加（新增）
  - evidence 累积（多次提到 → 置信度更高）
```

### 6.2 向量召回 + 5 维因子

#### 双存储设计（**面试加分项**）

```
画像存两份：
  ① profiles 表（结构化 JSON）→ 给 MatchAgent 算 5 维因子
  ② profile_embeddings 表（向量）→ 给 MatchAgent 召回 topK

为什么双存？
  - 向量召回快（O(log n)，索引加速）
  - 但向量是黑盒（相似度高但说不清为啥）
  - 结构化能解释（共同兴趣具体哪几个）
  - 双存 = 速度 + 可解释
```

#### 向量降级方案

| 模式 | 触发 | 实现 | 维度 | 质量 |
|------|------|------|------|------|
| API | 配了 `EMBED_API_KEY` | 调外部 embedding API | 1536 | 高 |
| 本地 | 无 Key / API 失败 | 中文 bigram + 英文 trigram + 哈希分桶 | 256 | 中（够用） |

**本地算法**：
1. 中文按 2 字滑窗：`"兴趣跑步"` → `["兴趣","趣跑","跑步"]`
2. 英文按 3 字滑窗：`"running"` → `["run","unn","nni","nin","ing"]`
3. 每个 token 哈希到 256 维桶，桶值 +1
4. L2 归一化（向量长度变 1，便于算余弦）

**为什么本地降级重要**：
- 没钱买 API Key 也能跑
- API 失败不挂业务
- 面试官问"API 挂了怎么办"→ 完美答案

### 6.3 可解释推荐

#### 输出示例

```json
{
  "userId": "u_xxx",
  "displayName": "林夕",
  "score": 0.767,
  "factors": {
    "vector": 0.82,
    "interest": 0.6,
    "style": 0.85,
    "schedule": 0.7,
    "goal": 0.9
  },
  "commonInterests": ["跑步"],
  "explanation": "你们都喜欢跑步，作息都偏周末活跃。林夕偏 introvert，跟你风格相近，你们都找周末跑步搭子——很合拍！"
}
```

#### 前端可视化

- `score` → 候选卡片右下角大字
- `factors` → 雷达图（5 维）
- `commonInterests` → 标签徽章
- `explanation` → 卡片下方一句话

### 6.4 SSE 流式协议

**文件**：[server/src/routes/chat.ts](file:///e:/DaZi/server/src/routes/chat.ts) + [llmClient.ts](file:///e:/DaZi/server/src/services/llmClient.ts)

#### 协议格式

```
event: token
data: {"content":"听起来"}

event: reasoning
data: {"content":"用户提到跑步..."}

event: done
data: {}
```

#### 缓冲处理（**面试加分项**）

```
LLM SSE 流可能切断：
  data: {"choices":[{"delta":{"content":"听起
  ── 切到这里 ──
 "}}]}

直接 JSON.parse 会失败。处理：
  ① 累积 buffer += chunk
  ② 找最后一个 \n\n（一个完整 SSE 事件）
  ③ 之前的部分 parse，之后留 buffer 等下一个 chunk
```

#### 推理模型支持

DeepSeek-v4-flash 是推理模型，响应有：
- `reasoning_content`：思考过程（透明展示给用户）
- `content`：最终回答

前端两个流并行渲染：reasoning 进"思考框"，content 进聊天气泡。

### 6.5 隐私保护

#### 数据收集原则

| 收集 | 不收集 |
|------|--------|
| 用户聊天内容（用于抽画像） | 永久身份证号 |
| 抽出的画像标签 | 银行卡 |
| 匹配结果 | 真实姓名（除非用户主动设置 displayName） |

#### 调 LLM 时的脱敏

**ProfileAgent 抽画像**：传原话（必须，否则抽不出）→ 自己服务调外部 LLM，原话存在 conversations 表
**IceBreaker 生成话术**：**只传画像标签，不传原话**

#### 合规设计

- `routes/privacy.ts`：用户可一键导出/删除自己的数据
- `audit_log` 表：所有敏感操作留痕
- `profile_patches` 表：画像每次变更都记 → 可溯源
- 外键 ON DELETE CASCADE：删用户自动删关联数据

### 6.6 多租户

每张业务表带 `tenant_id`：
- 未来一家公司一个租户
- 当前默认 'default'
- 查询都带 `WHERE tenant_id = ?` 隔离
- MatchAgent 召回时也限租户

---

## 7. 数据库与隐私设计

**文件**：[server/src/db/schema.ts](file:///e:/DaZi/server/src/db/schema.ts)

### 7.1 9 张表

| 表 | 作用 | 关键字段 |
|----|------|---------|
| `users` | 用户主表 | id, tenant_id, username, password_hash, created_at |
| `profiles` | 画像主表 | user_id, tenant_id, profile_json, version |
| `profile_patches` | 画像变更审计 | user_id, patch_json, evidence, created_at |
| `conversations` | 对话原话 | user_id, tenant_id, session_id, role, content |
| `chat_sessions` | 会话分组 | id, user_id, title, created_at |
| `matches` | 匹配记录 | tenant_id, user_id, target_id, score, factors_json |
| `dm_rooms` | 私信房间 | id, tenant_id, user_a, user_b |
| `dm_messages` | 私信消息 | room_id, sender_id, content, is_icebreaker |
| `audit_log` | 审计日志 | tenant_id, action, actor_id, target, metadata |

### 7.2 SQLite WAL 模式

**文件**：[server/src/db/index.ts](file:///e:/DaZi/server/src/db/index.ts)

```typescript
db.pragma('journal_mode = WAL')   // Write-Ahead Logging
db.pragma('foreign_keys = ON')    // 启用外键
db.pragma('busy_timeout = 5000')  // 锁等待 5s
```

**为什么 WAL**：
- 默认 journal_mode=DELETE：写时锁全库，并发读阻塞
- WAL：写不阻塞读，并发性能好
- SQLite 默认不支持并发写，但 WAL 至少读不卡

### 7.3 幂等迁移

```sql
CREATE TABLE IF NOT EXISTS users (...)    -- 表不存在才建
ALTER TABLE x ADD COLUMN new_col ...      -- PRAGMA table_info 检查列存在再 ALTER
```

服务启动时调 `initSchema()`，表已存在跳过，新列才加。

### 7.4 向量存储

**文件**：[server/src/db/vectorStore.ts](file:///e:/DaZi/server/src/db/vectorStore.ts)

```sql
CREATE TABLE profile_embeddings (
  user_id TEXT PRIMARY KEY,
  tenant_id TEXT,
  embedding TEXT,    -- JSON 序列化的向量
  dim INTEGER,
  updated_at INTEGER
)
```

**召回 SQL**：
```sql
SELECT user_id, embedding
FROM profile_embeddings
WHERE tenant_id = ? AND user_id != ?
```

**余弦相似度**：
```typescript
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
```

> **为什么不用专门的向量数据库**：
> SQLite 单文件部署简单，画像量级 < 10万 时性能够用
> 未来量大可平滑迁移到 pgvector / Qdrant

---

## 8. 面试拷打 Q&A（30 题）

> 每题都背下来，**面试官一定会拷打这些**。

### Q1: 你这个多 Agent 跟单 Agent 有什么本质区别？

**A**：
- **单 Agent**（如 ChatGPT）：一个模型干所有事，context 爆炸，调 LLM 慢
- **多 Agent**：分工——ProfileAgent 专精抽画像，MatchAgent 专精召回排序，IceBreaker 专精话术
- 每个 Agent 自己管 context，token 用得少
- MatchAgent 不调 LLM（纯算法），快且免费
- 失败隔离：一个 Agent 挂了不影响其他

### Q2: 三个 Agent 怎么通信？为什么不用直接调用？

**A**：用**黑板模式**。如果直接互调：
- 循环依赖（A import B, B import A → Node 加载死锁）
- 强耦合（B 改返回值，A 跟着改）
- 异步难处理（A 异步 5s，B 怎么知道完成？）
黑板方案：A 写完贴便条 → B 自己来读 → 解耦 + 异步天然支持。

### Q3: 状态机为什么用 transition 函数，不直接赋值？

**A**：
- 集中管理：所有状态变更走一个函数，便于审计和追踪
- 守卫验证：函数内 if 判断当前状态允许的转移，乱序信号被丢弃
- 可观测：transition 内可加日志/Tracer
- 直接 `ctx.state = 'MATCHING'` 绕过守卫，状态乱套

### Q4: 为什么 MatchAgent 不调 LLM？

**A**：
- LLM 调用慢（1-2s）+ 贵 + 不稳定
- 向量召回 + 规则排序是确定性算法，毫秒级
- 一致性：LLM 同输入可能给不同分，规则稳定
- 可解释性：规则的每个分量能拆给用户看
- 经济性：免费，用户每分钟都能匹配

### Q5: 画像置信度 0.65 怎么定的？

**A**：经验值。聊 3-5 轮自然能抽到 0.65 以上。
- 太低（0.3）：画像不靠谱
- 太高（0.9）：用户聊半天按钮不亮，体验差
- 0.65 是 trade-off，可配置（config 里）

### Q6: LLM 失败了怎么办？

**A**：**双模式降级**。
- ProfileAgent：LLM 失败 → 关键词匹配 + 模板回复
- IceBreaker：LLM 失败 → generateTemplate() 用共同兴趣拼话术
- MatchAgent：根本不调 LLM，纯算法
- 整套系统在 API 挂了时**核心功能不挂**，从"智能朋友"降级到"机械客服"

### Q7: 为什么先回复后抽画像？不是一起做？

**A**：
- 抽画像调 LLM 要 5-10s
- 阻塞回复 → 用户等 10s 才看到字 → 体验崩
- 分两路：先秒回（满足"快"），后异步抽（满足"准"）
- 用户感觉不到延迟

### Q8: SSE 流式协议怎么处理切包？

**A**：累积 buffer + 找 `\n\n` 分隔。一个完整 SSE 事件以双换行结尾。chunk 切到中间，buffer 累积，找最后一个 `\n\n`，之前 parse，之后留 buffer 等下一个 chunk。

### Q9: 推理模型（reasoning_content）怎么处理？

**A**：DeepSeek-v4-flash 是推理模型，响应有 `reasoning_content` + `content` 两个字段。我在 SSE 流里区分 event 类型：
- `event: reasoning` → 前端"思考框"
- `event: token` → 前端聊天气泡
用户体验：看着 AI 先思考再答，更透明。

### Q10: 向量召回用 SQLite 不慢吗？

**A**：
- 画像量级 < 10万，全表扫秒级返回
- 维度 256/1536，余弦公式 O(n×d) 也不慢
- 用专门向量库（Qdrant/Milvus）部署复杂
- 当前 SQLite 单文件部署简单，性能够用
- 量大可平滑迁移（接口不变）

### Q11: 用户画像怎么增量更新？

**A**：applyPatch 算法：
- 旧兴趣 confidence 0.8 → 新 patch 0.9 → 取较大值或加权
- 新兴趣（patch 里有，旧画像没有）→ 追加
- evidence 累积，多次提到 → confidence 更高
- 每次更新 version+1，存 profile_patches 表审计

### Q12: 黑板数据怎么索引？

**A**：Map<string, number>。
- key 是便条标题（如 'latest_profile'）
- value 是数组下标
- read(key) → keyIndex.get(key) → entries[idx] → O(1)
- 比数组 find() O(n) 快

### Q13: 怎么防止 Agent 死循环？

**A**：[antiloop.ts](file:///e:/DaZi/server/src/core/antiloop.ts)。
- recordAction(agentId, signature)
- isLoop() 检测最近 N 次签名是否相同
- 检测到 → break + 写 warning 黑板便条
- 典型场景：A 失败重试 B，B 失败重试 A → AntiLoop 主动 break

### Q14: Token 预算怎么控？

**A**：[tokenBudget.ts](file:///e:/DaZi/server/src/core/tokenBudget.ts) 三级阈值：
- 75% 软提醒：日志告警
- 90% 硬停：拒绝新 LLM 调用 → 降级到规则
- 递减收益：消耗越多越倾向拒绝

### Q15: LLM 输出 JSON 解析失败怎么办？

**A**：[structuredOutput.ts](file:///e:/DaZi/server/src/core/structuredOutput.ts) 三道防线：
- quickFixJSON：去 markdown 包裹、修尾逗号、修单引号
- extractJSON：从混合文本抠 {...}
- validateJSON：schema 校验
- 实在解析不了 → 抛错 → 上层 catch → 模板降级

### Q16: 多租户怎么实现？

**A**：每张业务表带 `tenant_id`，所有查询带 `WHERE tenant_id = ?`。当前默认 'default'，未来一家公司一个租户隔离数据。

### Q17: 隐私怎么保护？

**A**：
- IceBreaker 调 LLM **只传画像标签，不传对话原话**
- `routes/privacy.ts` 一键导出/删除数据
- `audit_log` 敏感操作留痕
- 外键 CASCADE：删用户自动删关联数据
- 画像 evidence 溯源到原话但不可逆

### Q18: 为什么不用 LangChain？

**A**：
- LangChain 省的只是 `chat(messages, {stream})` 这种 10 行样板
- 我的业务逻辑（向量召回+5维因子+画像合并+破冰模板）LangChain 一个字都省不掉
- Blackboard + Orchestrator + Tracer + Budget + AntiLoop 是生产级组件，LangChain 没有等价物
- LangGraph 才做 Agent 协作，但学习曲线陡、定制难
- TS 项目换 Python 重写 = 推翻重来

### Q19: 为什么画像存两份（结构化 + 向量）？

**A**：
- 向量召回快（O(log n)）
- 但向量是黑盒（相似度高但说不清为啥）
- 结构化能解释（共同兴趣具体哪几个）
- 双存 = 速度 + 可解释

### Q20: SQLite 默认不支持并发写怎么办？

**A**：
- WAL 模式：写不阻塞读，并发读没问题
- 写操作通常很短（INSERT 几行）
- 单进程 Node.js 单线程，写不会真并发
- 真的并发写多 → 迁移 PostgreSQL

### Q21: 怎么保证会话一致性？

**A**：每个用户一个 SessionContext（存内存 sessions Map）：
- state：当前状态机节点
- blackboard：黑板实例
- budget：token 预算
- profileConfidence：画像置信度
所有请求 getSession(userId) 拿同一个 ctx。

### Q22: 限流怎么实现？

**A**：[rateLimiter.ts](file:///e:/DaZi/server/src/services/rateLimiter.ts) 滑动窗口：
- 每用户每小时 20 条
- Map<userId, timestamps[]> 滑动窗口
- 每次请求清理 1 小时前的时间戳
- 超 20 → 拒绝

### Q23: 鉴权怎么做的？

**A**：
- 注册：bcrypt 哈希密码存 users 表
- 登录：bcrypt.compare 验证 → 签 JWT → 写 httpOnly Cookie
- 中间件 requireAuth：从 Cookie 取 token → verify → 注入 req.user
- 可选鉴权 optionalAuth：有就注入，没有不报错（用于 /health 公开接口）

### Q24: 前端怎么知道状态变了？

**A**：聊天 SSE 流最后一个 event 是 `state`：
```
event: state
data: {"state":"PROFILE_READY","confidence":0.8}
```
前端收到 → "开始匹配"按钮亮起。或下次 GET /profile 也能拿到。

### Q25: 如果 LLM 给的破冰话术质量差怎么办？

**A**：
- system prompt 严格约束：≤30 字、3 风格、禁用"你好"
- temperature=0.8 增加多样性
- 校验 Array<string> 长度，slice(0,3)，每条 slice(0,60) 兜底
- 用户可以重新生成
- 后续可加用户反馈（点赞/点踩）迭代

### Q26: 你们系统的可扩展性如何？

**A**：
- 加新 Agent：继承 BaseAgent + 实现 execute() + 黑板读写即可
- 加新匹配因子：computeFactors 加一个 case + config 权重表加一行
- 加新状态：transition 加一个 case
- 加新租户：所有表带 tenant_id，零改动

### Q27: 性能瓶颈在哪？

**A**：
- LLM 调用最慢（1-2s）→ 用流式 + 异步抽取缓解
- 向量召回：当前全表扫，<10万 量级秒级；>10万 迁移向量库
- SQLite 写：单进程单线程瓶颈不显
- 内存：sessions Map 单进程，多实例需 Redis

### Q28: 如果做 A/B 测试怎么改？

**A**：config.match.weights 可配置：
- 实验 A：vector=0.35
- 实验 B：vector=0.45
配置中心下发 → 不同租户不同权重 → 对比转化率

### Q29: 这个项目最难的地方是什么？

**A**（**亮点回答**）：
- **不是写代码，是设计**：
  - Agent 边界怎么划？画像该 ProfileAgent 抽还是 MatchAgent 抽？
  - 异步怎么协调？画像抽完才能匹配 → 状态机
  - 失败怎么兜底？LLM 挂、API 挂、向量 API 挂 → 三层降级
  - 隐私怎么不泄露？IceBreaker 不传原话 → 只传标签
- 这些设计决策的"为什么"才是工程价值

### Q30: 你学到了什么？

**A**：
- 多 Agent 协作的关键是**解耦**（黑板）
- 状态机让异步流程可控
- 双模式降级是生产级必备
- 可解释推荐是 LLM 时代的产品差异化
- 隐私设计要从一开始就考虑，不能事后补

---

## 9. 代码导航地图

> **面试前一晚**：按这个顺序看，每文件 5-10 分钟，2 小时过完。

### 第一梯队：核心数据契约（30 分钟）

1. [server/src/agents/profileSchema.ts](file:///e:/DaZi/server/src/agents/profileSchema.ts) — 画像数据结构（5 维 + evidence）

### 第二梯队：agent 框架骨架（45 分钟）

2. [server/src/core/orchestrator.ts](file:///e:/DaZi/server/src/core/orchestrator.ts) — 状态机
3. [server/src/core/blackboard.ts](file:///e:/DaZi/server/src/core/blackboard.ts) — 黑板
4. [server/src/core/antiloop.ts](file:///e:/DaZi/server/src/core/antiloop.ts) — 防死循环
5. [server/src/core/tokenBudget.ts](file:///e:/DaZi/server/src/core/tokenBudget.ts) — token 预算
6. [server/src/core/structuredOutput.ts](file:///e:/DaZi/server/src/core/structuredOutput.ts) — JSON 容错
7. [server/src/core/tracer.ts](file:///e:/DaZi/server/src/core/tracer.ts) — 调用链追踪

### 第三梯队：三个 Agent 实现（45 分钟，**面试必精读**）

8. [server/src/agents/baseAgent.ts](file:///e:/DaZi/server/src/agents/baseAgent.ts) — 基类
9. [server/src/agents/profileAgent.ts](file:///e:/DaZi/server/src/agents/profileAgent.ts) — 画像采集
10. [server/src/agents/matchAgent.ts](file:///e:/DaZi/server/src/agents/matchAgent.ts) — 匹配
11. [server/src/agents/iceBreakerAgent.ts](file:///e:/DaZi/server/src/agents/iceBreakerAgent.ts) — 破冰

### 第四梯队：services（30 分钟）

12. [server/src/services/llmClient.ts](file:///e:/DaZi/server/src/services/llmClient.ts) — LLM 调用 + SSE
13. [server/src/services/embedding.ts](file:///e:/DaZi/server/src/services/embedding.ts) — 向量嵌入
14. [server/src/services/auth.ts](file:///e:/DaZi/server/src/services/auth.ts) — 鉴权
15. [server/src/services/rateLimiter.ts](file:///e:/DaZi/server/src/services/rateLimiter.ts) — 限流

### 第五梯队：db + config（20 分钟）

16. [server/src/db/schema.ts](file:///e:/DaZi/server/src/db/schema.ts) — 表结构
17. [server/src/db/index.ts](file:///e:/DaZi/server/src/db/index.ts) — db 连接
18. [server/src/db/vectorStore.ts](file:///e:/DaZi/server/src/db/vectorStore.ts) — 向量存储
19. [server/src/config/index.ts](file:///e:/DaZi/server/src/config/index.ts) — 配置

### 第六梯队：routes（30 分钟，**看串联**）

20. [server/src/routes/chat.ts](file:///e:/DaZi/server/src/routes/chat.ts) — 触发 profileAgent（链路核心）
21. [server/src/routes/match.ts](file:///e:/DaZi/server/src/routes/match.ts) — 触发 matchAgent
22. [server/src/routes/profile.ts](file:///e:/DaZi/server/src/routes/profile.ts) — 画像查询
23. [server/src/routes/dm.ts](file:///e:/DaZi/server/src/routes/dm.ts) — 私信
24. [server/src/routes/auth.ts](file:///e:/DaZi/server/src/routes/auth.ts) — 登录注册
25. [server/src/routes/privacy.ts](file:///e:/DaZi/server/src/routes/privacy.ts) — 隐私

### 第七梯队：辅助（10 分钟）

26. [server/src/index.ts](file:///e:/DaZi/server/src/index.ts) — 服务入口
27. [server/src/middleware/auth.ts](file:///e:/DaZi/server/src/middleware/auth.ts) — 鉴权中间件
28. [server/src/routes/health.ts](file:///e:/DaZi/server/src/routes/health.ts) — 健康检查
29. [server/src/scripts/seed.ts](file:///e:/DaZi/server/src/scripts/seed.ts) — 种子数据

---

## 10. 你的亮点话术

> **面试官最爱听这些"我有而别人没有"**。

### 亮点 1：双模式降级（韧性）

> "我这个系统**API 挂了也能用**。DeepSeek API 失败 → ProfileAgent 走关键词模式；embedding API 失败 → 走本地 bigram 哈希分桶；IceBreaker 失败 → 模板拼装。**核心匹配功能根本不依赖 LLM**——MatchAgent 是纯算法。这是生产级思维：永远假设外部依赖会挂。"

### 亮点 2：可解释推荐（差异化）

> "传统匹配是黑盒——陌陌给你推个人你不知道为啥。我的 MatchAgent 输出 5 维因子 + 共同兴趣 + 文字 explanation，**前端直接渲染雷达图 + 一句话说明**。用户看得到'你们都喜欢跑步，作息都偏周末'，社交启动心理门槛大降。"

### 亮点 3：画像 evidence 溯源（防瞎填）

> "传统平台用户瞎填标签——说喜欢跑步其实不跑。我的画像每个兴趣都带 evidence 原话 + 置信度。**置信度低的画像触发不了匹配**（0.65 阈值），保证匹配质量。"

### 亮点 4：黑板模式解耦（架构能力）

> "三个 Agent 不直接互调，通过黑板贴便条。**加新 Agent 不动现有代码**——继承 BaseAgent + 实现 execute() + 黑板读写。这是设计模式落地，不是死记概念。"

### 亮点 5：双职责异步（性能优化）

> "ProfileAgent 一个类干两件事：streamReply 同步流式回复（用户秒看到字），run 异步后台抽画像（5-10s 用户无感）。**如果我同步抽画像，用户要等 10s 才看到回复**——这是工程取舍的体现。"

### 亮点 6：隐私设计（合规意识）

> "IceBreaker 调 LLM **只传画像标签不传对话原话**——第三方 LLM 服务商即使记录请求也看不到原始对话。还有 audit_log 留痕、profile_patches 审计、外键 CASCADE 一键删除。**合规设计从一开始就考虑**，不是事后补。"

### 亮点 7：生产级组件（工程化）

> "我做了 Tracer 全链路追踪、TokenBudget 三级阈值（75%软提醒/90%硬停）、AntiLoop 防死循环、StructuredOutput 三道 JSON 容错。**这些是真实生产系统的标配**——面试官一听就知道你做过真东西，不是写玩具。"

### 亮点 8：状态机编排（流程可控）

> "用 transition 函数集中管状态变更，6 个状态 + 5 个信号 + 守卫验证。**用户点了匹配又点取消？迟到信号被守卫丢弃**，状态不会乱套。这是状态机模式的落地。"

---

## 11. 已知局限 & 后续 Roadmap

> **面试官问"还有什么不足"时**——展示你的反思能力。

### 已知局限

| 局限 | 当前方案 | 后续优化 |
|------|---------|---------|
| 内存会话 | sessions Map 单进程 | 迁移 Redis |
| 向量召回 | SQLite 全表扫 | pgvector / Qdrant |
| 画像抽取 | 单次 LLM 调用 | 多轮迭代 + 用户反馈闭环 |
| 破冰话术质量 | 无反馈机制 | 加点赞/点踩 → 微调 prompt |
| 跨会话记忆 | 仅靠画像累积 | 加四层分层记忆架构 |
| MBTI | 5 维因子已包含 socialStyle | 显式 MBTI 算法 |
| 历史压缩 | 全量对话作 context | 学习 ccm2 增量压缩 |
| Reasonix 缓存 | 无 | 加缓存前置省钱 |

### 后续 Roadmap（**面试时主动讲，加分**）

1. **四层分层记忆架构**：
   - 短期会话（滑动窗口）
   - 长期画像（结构化 + 向量双存）
   - 匹配决策记忆（去重推荐、权重迭代）
   - 撮合交互记忆（破冰历史、效果反馈）

2. **MBTI 底层算法**：把 socialStyle 映射到 16 型人格，匹配时考虑互补

3. **Reasonix 缓存前置**：学习 DeepSeek 开源的省钱策略，**只从后面追加对话不改历史**，命中缓存省 token

4. **DeepSeek 官方 API**：切换模型到 deepseek-v4-flash 推理模型

5. **历史对话压缩**：学习 ccm2（Claude Code 源码）的增量压缩策略

6. **A/B 测试框架**：config.match.weights 可配置，不同租户不同权重

---

## 12. 面试当天 checklist

- [ ] 背熟第 0 章电梯演讲（1 分钟讲完）
- [ ] 背熟第 3 章小王数据流（3 分钟讲完）
- [ ] 自测第 8 章 30 个 Q&A
- [ ] 背熟第 10 章 8 个亮点话术
- [ ] 准备好讲第 11 章局限 + Roadmap（展示反思）
- [ ] **打开 IDE**：面试官问代码细节，你能立刻打开对应文件指给他看
- [ ] 准备一个 demo 账号密码（Demo1234），需要时跑 `npm run seed` 重置

---

## 13. 最后的话

**面试官不会因为你用了什么框架给 offer，而是看你**：
1. 能讲清"为什么这么设计"
2. 能扛住"如果 XX 失败怎么办"的拷打
3. 能反思"还有什么不足 + 怎么改进"
4. 能展示"工程化思维"（降级、追踪、预算、防死循环）

**你这套系统的杀手锏**：
- 双模式降级（韧性）
- 可解释推荐（差异化）
- 画像 evidence 溯源（防瞎填）
- 黑板解耦（架构能力）
- 双职责异步（性能优化）
- 隐私设计（合规）
- 生产级组件（工程化）
- 状态机编排（流程可控）

**加油，明天面试必过！** 🚀
