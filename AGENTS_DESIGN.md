# Agent 设计大白话版（哄小孩版）

> 这篇文档不讲黑话，全部用"找搭子"这个事儿打比方。
> 看完你就懂：每个 Agent 是干啥的、为啥这么设计、好处在哪。
> 配套代码在 [`server/src/agents/`](server/src/agents/) 和 [`server/src/core/`](server/src/core/)。

---

## 一、先看大图：三个 Agent 像三个同事

想象你开了一家"找搭子介绍所"，店里有 **3 个员工**：

```
┌─────────────────────────────────────────────────────────────┐
│  找搭子介绍所（MatchMate）                                   │
│                                                               │
│  👨‍💼 同事A：ProfileAgent（画像师）                            │
│      "陪聊 + 偷偷记你喜好"                                    │
│                                                               │
│  👩‍💼 同事B：MatchAgent（匹配师）                              │
│      "按你的喜好从人堆里挑 5 个最合拍的"                       │
│                                                               │
│  🧑‍💼 同事C：IceBreakerAgent（破冰师）                         │
│      "挑完人后，帮你想 3 句开场白"                             │
│                                                               │
│  📋 公告板：Blackboard（黑板）                                │
│      "三人不直接对话，全靠往公告板上贴便条"                    │
│                                                               │
│  👔 店长：Orchestrator（编排器）                              │
│      "看店里的进度，决定现在该谁干活"                          │
└─────────────────────────────────────────────────────────────┘
```

**核心理念**：三个人 **不互相打电话**（不直接函数调用），全靠往 **公告板（Blackboard）** 上贴便条。这样有啥好处？

- ✅ **解耦**：A 不用等 B 干完活，B 不用知道 A 是谁
- ✅ **异步**：A 写完便条就去吃饭，B 啥时候来看都行
- ✅ **可重放**：哪天出 bug，把公告板翻出来就能复盘
- ✅ **可扩展**：明天招个新同事 D，让他读公告板就行，不用改 ABC 的代码

代码里对应：[`server/src/core/blackboard.ts`](server/src/core/blackboard.ts) 的 `blackboard.write()` / `blackboard.read()`。

---

## 二、BaseAgent：三个同事的"共同工作手册"

> 文件：[`server/src/agents/baseAgent.ts`](server/src/agents/baseAgent.ts)

### 大白话

每个新员工入职，店长都发一本《工作手册》，规定：

1. **每次干活前**，先按秒表（计时）
2. **每次干活前**，记一下钱包余额（token 预算）
3. **干完活**，按秒表算耗时，算花了多少钱
4. **出错了**，写到"踩坑本"上（反循环器），下次别再踩
5. **不管成败**，统一交一张《工作汇报单》（AgentResult）

ABC 三个员工 **不用各自重写这套流程**，只要在手册里写"我具体干啥活"（`execute()` 方法）就行。

### 为啥这么设计

| 设计点 | 用大白话解释 |
|---|---|
| `abstract class`（抽象类） | "工作手册是模板，不能直接拿手册去干活，必须让员工照着手册写自己的版本" |
| `abstract execute()` | "手册里说『具体干啥活』这一页是空的，员工必须自己填" |
| `<TInput, TOutput>` 泛型 | "每个员工收到的任务单子和交的作业格式不一样，A 收对话交画像，B 收画像交候选名单" |
| `try/catch` 在基类 | "员工只管干活，闯祸了店长来兜底" |
| `tokensUsed` / `durationMs` | "每张汇报单都自带成本和耗时，方便月底算账" |

### 关键代码片段

```typescript
// baseAgent.ts —— "工作手册"的骨架
export abstract class BaseAgent<TInput = unknown, TOutput = unknown> {
  abstract readonly agentId: string         // "我是谁"
  abstract readonly description: string     // "我干啥的"

  // 统一入口：店长只调这个方法（模板方法模式）
  async run(input: TInput, ctx: AgentContext): Promise<AgentResult<TOutput>> {
    const start = Date.now()
    const tokensBefore = ctx.budget.getStatus().used
    try {
      const data = await this.execute(input, ctx)   // ← 调子类的具体实现
      return { agentId: this.agentId, ok: true, data,
               tokensUsed: ctx.budget.getStatus().used - tokensBefore,
               durationMs: Date.now() - start }
    } catch (e) {
      ctx.loopDetector.recordError((e as Error).message)   // 踩坑本
      return { agentId: this.agentId, ok: false, error: (e as Error).message, ... }
    }
  }

  // 子类必须实现："具体干啥活"
  protected abstract execute(input: TInput, ctx: AgentContext): Promise<TOutput>
}
```

### 好处

- 🪶 **省代码**：3 个 Agent 共用一段 30 行的 try/catch+计时+记账，不重复
- 🛡️ **稳**：子类再怎么写都不会让整个店崩溃，基类兜底
- 📊 **可观测**：每次 run 都自动留痕（耗时、token、成败），便于优化

---

## 三、ProfileAgent：陪聊画像师

> 文件：[`server/src/agents/profileAgent.ts`](server/src/agents/profileAgent.ts)

### 大白话

顾客一进店，画像师就陪他唠嗑。唠嗑的过程中 **偷偷记**：

- "这哥们儿喜欢跑步、爬山" → 兴趣
- "说话挺短，可能内向" → 社交风格
- "周末才有空" → 时段
- "想找个一起跑半马的" → 目标

**关键**：不让顾客填表！没人爱填表。聊天自然就把信息榨出来了。

### 双模式设计（省钱 + 可跑）

```
有 API Key？  →  是 → 调 DeepSeek-v4-flash（智能抽取+智能回复）
              →  否 → 关键词匹配+模板回复（免费但傻）
```

代码入口：[`profileAgent.ts`](server/src/agents/profileAgent.ts) 的 `extractProfile()` 和 `streamReply()`。

### 为啥这么设计

| 设计点 | 用大白话解释 |
|---|---|
| **隐式抽取**（不让用户填表） | "填表像体检，聊天像约朋友——后者信息质量更高，用户也不烦" |
| **流式回复** `streamReply()` | "AI 一个字一个字往外吐，用户秒看到，不用干等 10 秒" |
| **异步抽画像**（chat.ts 里 `.then()`） | "画像师先回答用户问题（前台），再回头记笔记（后台）。让用户等就是大忌" |
| **降级模式** `extractViaKeywords()` | "API 挂了店还得开，关键词匹配虽然傻但能跑，匹配功能照样用" |
| **JSON Schema 校验** | "LLM 有时候抽风输出乱七八糟的东西，必须用 schema 卡一道，否则脏数据进库" |
| **画像增量合并** `applyPatch()` | "用户每次说一点，画像就加一点，不是覆盖。今天聊到跑步，明天聊到音乐，两条都留" |
| **画像变 → 重算向量** | "画像变了，画像的"指纹"也得重算，否则匹配师拿旧指纹找人就错位了" |
| **写黑板** `blackboard.write('latest_profile', ...)` | "画像师不直接打电话给匹配师，把画像贴公告板上，匹配师自己来看" |

### 关键代码片段

```typescript
// profileAgent.ts —— execute() 的 5 步流程
protected async execute(input, ctx): Promise<ProfileAgentOutput> {
  // 1. 从对话里挖画像 patch（LLM 优先，降级关键词）
  const patch = await this.extractProfile(input.recentMessages, ctx)

  // 2. 拿旧画像 + 合并 patch（增量更新）
  const current = loadProfile(ctx.userId) || createEmptyProfile(ctx.userId)
  const next = applyPatch(current, patch)   // ← 在 profileSchema.ts 里

  // 3. 存 DB（profiles 主表 + profile_patches 审计表）
  persistProfile(ctx.userId, ctx.tenantId, next)
  if (hasPatchContent(patch)) persistPatch(ctx.userId, ctx.tenantId, next.basic.version, patch)

  // 4. 画像变了 → 重算 1536 维向量（MatchAgent 召回用）
  if (next.confidence > current.confidence || next.basic.version === 1) {
    const vec = await embed(profileToText(next))
    updateProfileEmbedding(ctx.userId, vec)
  }

  // 5. 贴公告板（其他 Agent 可读）
  ctx.blackboard.write(this.agentId, 'latest_profile', next, 'profile_patch')
  return { profile: next, patch, confidence: next.confidence, profileText: profileToText(next) }
}
```

### 流式回复的双通道（DeepSeek-v4-flash 专属）

DeepSeek-v4-flash 是 **推理模型**，回复里有两种内容：

- `reasoning_content`：AI 的"内心独白"（思考过程）
- `content`：AI 真正要对用户说的话

`streamReplyLLM()` 调 [`llmClient.ts`](server/src/services/llmClient.ts) 的 `chatStream`，注册两个回调：

```typescript
const { text, reasoning, usage } = await chatStream([sys, ...history], {
  onDelta,           // ← content 来了，推前端 SSE 'delta' 事件（用户秒看到正文）
  onReasoning,       // ← reasoning_content 来了，推前端 SSE 'reasoning' 事件（思考框）
  onUsage: (u) => ctx.budget.recordApiUsage(u.inputTokens, u.outputTokens),
}, { maxTokens: 2048, temperature: 0.7, signal })
```

前端 [`MessageBubble.vue`](web/src/components/MessageBubble.vue) 把 `reasoning` 显示在可折叠的"思考框"里，`text` 显示在主气泡里，**和 DeepSeek-Super 聊天模式完全一致**。

### 好处

- 💬 **用户体验好**：流式 + 推理过程可见，像看 AI 思考
- 💰 **省钱**：抽画像异步后台跑，不阻塞回复；推理模型抽取 token 比对话还多，必须分开
- 🔄 **可降级**：API 挂了照常营业，画像靠关键词，回复靠模板
- 📈 **画像越聊越准**：增量更新，置信度 `computeConfidence()` 累积到 0.65 就触发匹配

---

## 四、MatchAgent：纯计算匹配师

> 文件：[`server/src/agents/matchAgent.ts`](server/src/agents/matchAgent.ts)

### 大白话

画像师把画像准备好后，匹配师登场。他的活儿是：

1. 把我的画像变成一个"指纹"（向量）
2. 在人堆里按指纹相似度挑 20 个（**召回 topK**）
3. 对这 20 个再算 5 维细因子，加权打分（**多因子排序**）
4. 取前 5 个交还给用户

### 为啥匹配师 **不调 LLM**？

| 原因 | 解释 |
|---|---|
| **快** | 50ms 内出结果，LLM 要 2-5 秒 |
| **稳** | 不依赖网络/外部 API，永远不会因 API 故障挂掉 |
| **可解释** | 每个因子分数透明，能告诉用户"为啥推荐 TA" |
| **省钱** | 不花一分 token，纯算力 |
| **可审计** | 算法是确定的，复盘时能算出"为啥是 A 不是 B" |

### 5 维因子（多因子排序）

```
vector   向量相似度  ←  整体画像"指纹"有多像
interest 兴趣重合    ←  共同爱好多不多（Jaccard）
style    社交风格    ←  内向/外向、深度/表面 匹配度
schedule 时段重合    ←  周末党 vs 工作日党
goal     目标互补    ←  都想跑半马？那合拍
```

加权综合分（权重在 [`config/index.ts`](server/src/config/index.ts) 的 `config.match.weights`）：

```typescript
function weightedScore(f: MatchFactors): number {
  const w = config.match.weights
  return clamp01(
    w.vector   * f.vector   +
    w.interest * f.interest +
    w.style    * f.style    +
    w.schedule * f.schedule +
    w.goal     * f.goal
  )
}
```

### 关键代码片段

```typescript
// matchAgent.ts —— 6 步流程
protected async execute(input, ctx): Promise<MatchAgentOutput> {
  // 1. 加载我的画像（画像师之前存的）
  const myProfile = loadProfile(ctx.userId)
  if (!myProfile || myProfile.interests.length === 0) {
    return { candidates: [], totalCount: 0, myProfileText: '' }   // 没画像不匹配
  }

  // 2. 画像文本 → 1536 维向量
  const myVec = await embed(profileToText(myProfile))

  // 3. 向量召回 topK（vectorStore 里用余弦相似度排，取前 20）
  const recalled = recallByVector(myVec, ctx.tenantId, ctx.userId, config.match.topK)

  // 4. 多因子排序：每个候选取 5 维因子，加权算综合分
  const candidates = recalled.map(r => {
    const factors = computeFactors(myProfile, r.profile, r.score)
    const score = weightedScore(factors)
    return { userId: r.userId, displayName: r.profile.displayName,
             score, factors, commonInterests: commonInterests(myProfile, r.profile),
             explanation: buildExplanation(r.profile, factors, common, myProfile),
             snapshot: r.profile }
  })

  // 按综合分降序，取前 5
  candidates.sort((a, b) => b.score - a.score)
  const top = candidates.slice(0, input.limit ?? config.match.finalN)

  // 5. 贴公告板（IceBreaker 之后会读）
  ctx.blackboard.write(this.agentId, 'latest_matches', top, 'match_result')

  // 6. 存 matches 表（含因子 JSON，可审计/复盘）
  persistMatches(ctx.tenantId, ctx.userId, top)

  return { candidates: top, totalCount: candidates.length, myProfileText: myText }
}
```

### 可解释文本（不调 LLM 的妙处）

```typescript
function buildExplanation(theirs, f, common, my): string {
  const parts: string[] = []
  if (common.length > 0) parts.push(`你们都对${common.slice(0, 3).join('、')}感兴趣`)
  if (f.vector > 0.6) parts.push('整体画像高度相似')
  if (f.style > 0.7) parts.push('社交风格很合拍')
  if (f.schedule > 0.5) parts.push('活跃时段重合')
  if (theirs.goal) parts.push(`TA的目标是"${theirs.goal}"`)
  return parts.join('，') + '。'
}
```

用户看到的："你们都对运动、音乐感兴趣，整体画像高度相似，社交风格很合拍。"

### 好处

- ⚡ **快**：50ms 内出 5 个候选，用户秒看结果
- 🔍 **可解释**：每个推荐都附带"为什么是 TA"，不是黑盒
- 💵 **零成本**：永不花 LLM token
- 🧪 **可调优**：改 [`config.match.weights`](server/src/config/index.ts) 就能调推荐风格，重新跑就行

---

## 五、IceBreakerAgent：破冰师

> 文件：[`server/src/agents/iceBreakerAgent.ts`](server/src/agents/iceBreakerAgent.ts)

### 大白话

匹配师给用户挑了 5 个候选，用户指着其中一个说"就 TA 了"。这时候破冰师递上 3 句开场白：

1. "你也喜欢周末爬山？最近想去哪座？"（共同兴趣路线）
2. "我看你也是夜猫子搭子，求一个晚上 10 点还能聊天的"（轻松幽默路线）
3. "我想找个一起跑半马的搭子，看你目标也一样，要不要加个微信聊？"（真诚直接路线）

为啥要破冰师？因为社交启动成本高——大多数人 **不是不想聊**，是 **不知道第一句说啥**。给 3 条话术，用户复制粘贴就行。

### 为啥这么设计

| 设计点 | 用大白话解释 |
|---|---|
| **3 条不同风格** | "用户口味不一样，给 3 个选项总有一个能用" |
| **基于画像摘要，不基于原话** | "画像师抽出来的兴趣标签是脱过敏的，破冰师看不到用户聊过啥隐私。即使用户聊过抑郁症，破冰话术里也不会出现" |
| **降级模板** | "LLM 挂了也得给话术，模板虽然糙但能用" |
| **存 DB 状态 `icebroken`** | "破过冰的匹配后面可以推消息提醒『TA 回你了』，状态机驱动" |

### 关键代码片段

```typescript
// iceBreakerAgent.ts —— execute() 双模式
protected async execute(input, ctx): Promise<IceBreakerOutput> {
  if (llmEnabled) {
    try {
      const out = await this.generateLLM(input, ctx)   // LLM 生成 3 条
      persistIcebreakers(ctx.tenantId, ctx.userId, input.targetUserId, out)
      return { icebreakers: out, source: 'llm' }
    } catch (e) {
      addStep('info', { event: 'llm_icebreaker_failed', error: e.message })
      // 失败不致命，降级模板
    }
  }
  const out = this.generateTemplate(input)              // 模板兜底
  persistIcebreakers(ctx.tenantId, ctx.userId, input.targetUserId, out)
  return { icebreakers: out, source: 'template' }
}
```

### 隐私保护细节

```typescript
// IceBreakerInput 只传画像摘要，不传对话原文
export interface IceBreakerInput {
  targetUserId: string
  targetProfile: ProfileSnapshot   // 只有兴趣/风格/目标，没有原话
  myInterests: string[]
  commonInterests: string[]        // 共同兴趣标签
  matchScore: number
}
```

LLM prompt 里也只放标签级别信息，所以即使用户聊了"我最近抑郁"，破冰话术也只会基于"喜欢音乐"这种标签生成，不会泄露隐私。

### 好处

- 🤝 **降低社交启动成本**：用户不用纠结第一句说啥
- 🛡️ **隐私安全**：LLM 看不到用户对话原文，只看画像标签
- 🔄 **可降级**：LLM 挂了模板顶上，用户永远有话术可用
- 📊 **状态可追踪**：`matches.state = 'icebroken'` 后续可做"消息提醒"等功能

---

## 六、Blackboard：三人共用的公告板

> 文件：[`server/src/core/blackboard.ts`](server/src/core/blackboard.ts)

### 大白话

三个人不直接对话，全靠一块公告板：

```
┌─────────────── 公告板（Blackboard）───────────────┐
│                                                    │
│  📌 latest_profile   ← ProfileAgent 写              │
│                      ← MatchAgent 读               │
│                                                    │
│  📌 latest_matches   ← MatchAgent 写                │
│                      ← IceBreakerAgent 读          │
│                                                    │
│  📌 latest_patch     ← ProfileAgent 写              │
│                      ← 任何 Agent 读（审计用）      │
│                                                    │
└────────────────────────────────────────────────────┘
```

### 为啥用公告板而不是直接函数调用？

```
❌ 直接调用：ProfileAgent → MatchAgent.earlyRecall()
   问题：ProfileAgent 必须等 MatchAgent 干完才能继续
        MatchAgent 必须知道 ProfileAgent 的接口
        想加新 Agent 必须改老 Agent 代码

✅ 公告板：ProfileAgent 写完 latest_profile 就走人
        MatchAgent 想啥时候读就啥时候读
        新增 Agent D 只要读 latest_profile 就行
```

### 关键 API

```typescript
ctx.blackboard.write(agentId, key, value, tag)   // 写便条
ctx.blackboard.read(key)                          // 读便条
ctx.blackboard.snapshot()                         // 拍快照（debug 用）
```

### 好处

- 🔓 **解耦**：Agent 之间不知道彼此存在
- ⏱️ **异步**：写的不用等读的，读的可以反复读
- 🪶 **易扩展**：加新 Agent 不用改老代码
- 🐛 **可调试**：snapshot() 一打就知道哪个 Agent 写错了

---

## 七、Orchestrator：店长状态机

> 文件：[`server/src/core/orchestrator.ts`](server/src/core/orchestrator.ts)

### 大白话

店长手里一张流程图：

```
CHATTING → PROFILE_READY → MATCHING → MATCHED → ICEBREAKING → DONE
   ↑           ↑              ↑          ↑           ↑
   │           │              │          │           │
   │     confidence ≥ 0.65    │          │           │
   │           │         user 点匹配    user 点破冰   │
   └───────────┴──────────────┴──────────┴───────────┘
                  （信号驱动，不是函数调用）
```

### 状态机定义

```typescript
export type SessionState =
  | 'CHATTING'       // 和 ProfileAgent 聊天中
  | 'PROFILE_READY'  // 画像够了，可匹配
  | 'MATCHING'       // MatchAgent 召回中
  | 'MATCHED'        // 已出候选
  | 'ICEBREAKING'    // IceBreaker 生成破冰中
  | 'DONE'
```

### 信号驱动转换

```typescript
export function transition(ctx: SessionContext, signal: {
  type: 'profile_updated' | 'match_requested' | 'match_done' | 'icebreak_requested' | 'icebreak_done'
  confidence?: number
}): SessionState {
  switch (signal.type) {
    case 'profile_updated':
      if (ctx.profileConfidence >= 0.65) ctx.state = 'PROFILE_READY'
      break
    case 'match_requested':
      ctx.state = 'MATCHING'
      break
    // ...
  }
}
```

### 为啥用状态机？

| 原因 | 大白话 |
|---|---|
| **避免乱序** | "画像没好不能匹配，匹配没好不能破冰——状态机强制按顺序来" |
| **可恢复** | "服务挂了重启，从 DB 加载状态接着干，不用重头来" |
| **可观测** | "前端永远知道当前在哪个阶段，UI 能正确显示按钮" |
| **防并发** | "用户狂点匹配按钮，状态机保证只触发一次 MATCHING" |

### 好处

- 🚦 **流程可控**：不会出现"画像没好就匹配"这种乱套情况
- 🔄 **可恢复**：服务重启从 DB 加载状态接着干
- 📊 **可观测**：前端 [`chatStore.js`](web/src/stores/chatStore.js) 的 `sessionState` 直接来自这里

---

## 八、配套基础设施（不发便条但很重要）

### 1. BudgetTracker（预算追踪器）

> 文件：[`server/src/core/tokenBudget.ts`](server/src/core/tokenBudget.ts)

**大白话**：店长给每个员工每天发 1000 token 零花钱，超支了就得降级（LLM → 模板）。

```typescript
ctx.budget.recordApiUsage(inputTokens, outputTokens)   // 花了多少
ctx.budget.recordInput(textTokens)                     // 输入花了多少
ctx.budget.getStatus().used                            // 总共花了多少
```

**好处**：防止 LLM 调用失控烧钱，超支自动降级。

### 2. LoopDetector（反循环器）

> 文件：[`server/src/core/antiloop.ts`](server/src/core/antiloop.ts)

**大白话**：踩坑本。Agent 闯祸了记一笔，下次同样的坑就避开。

```typescript
ctx.loopDetector.recordAction('extract_profile', { attempt }, 'ok')
ctx.loopDetector.recordError('JSON 解析失败')
```

**好处**：Agent 不会在同一个错误上反复摔，最多重试 2 次就降级。

### 3. Tracer（链路追踪）

> 文件：[`server/src/core/tracer.ts`](server/src/core/tracer.ts)

**大白话**：每个 Agent 干的每一步都打点，方便复盘。

```typescript
addStep('extract', { event: 'embedding_updated', dim: vec.length })
startSpan('profile-agent', { userId, mode })
endSpan({ confidence, version })
```

**好处**：出 bug 时一眼看到哪步崩了，不用打 console.log。

### 4. StructuredOutput（结构化输出）

> 文件：[`server/src/core/structuredOutput.ts`](server/src/core/structuredOutput.ts)

**大白话**：LLM 经常输出半截 JSON 或者带注释的 JSON，这套工具负责"抢救"：

```typescript
extractJSON(rawText)    // 从 LLM 输出里抠出 JSON
quickFixJSON(text)      // 修掉尾逗号、未闭合括号等小毛病
validateJSON(obj, schema)  // 按校验 schema 卡
```

**好处**：LLM 不老实也没关系，工具兜底。

---

## 九、整体协作流程（一张图说清）

```
用户发消息 "我周末喜欢爬山"
    ↓
[chat.ts 路由]
    ↓ SSE 头 + meta 事件
    ↓
[ProfileAgent.streamReply()]  ← 流式回复（前台，秒级）
    ↓ onDelta / onReasoning → SSE delta/reasoning 事件 → 前端
    ↓
用户看到 AI 一个字一个字打："听起来你很享受户外活动～除了爬山，还喜欢做什么？"
    ↓
[ProfileAgent.run()]          ← 异步抽画像（后台，10-20s）
    ↓ extractProfile() → patch = { interests: [{name:'运动', ...}] }
    ↓ applyPatch() → 合并到现有画像
    ↓ embed() → 1536 维向量 → 存 DB
    ↓ blackboard.write('latest_profile', ...)
    ↓
[Orchestrator] transition('profile_updated')
    ↓ confidence ≥ 0.65 → state = PROFILE_READY
    ↓
用户点"开始匹配"
    ↓
[match.ts 路由] POST /match/run
    ↓
[MatchAgent.run()]
    ↓ recallByVector() → 20 个候选
    ↓ computeFactors() × 20 → 5 维因子
    ↓ weightedScore() × 20 → 综合分
    ↓ sort + slice → top 5
    ↓ blackboard.write('latest_matches', ...)
    ↓
前端展示 5 张候选卡片，每张带"为什么推荐 TA"的解释
    ↓
用户点某个候选的"要破冰话术"
    ↓
[match.ts 路由] POST /match/icebreaker
    ↓
[IceBreakerAgent.run()]
    ↓ generateLLM() → 3 条破冰话术
    ↓ persistIcebreakers() → matches.state = 'icebroken'
    ↓
前端展示 3 条话术，用户复制粘贴
    ↓
[Orchestrator] state = DONE
    ↓
🎉 完整链路结束
```

---

## 十、面试能用上的"卖点"总结

| 设计点 | 卖点 |
|---|---|
| 多 Agent 架构 + 公告板 | "用 Blackboard 模式解耦 Agent 间通信，支持异步、可重放、易扩展" |
| 状态机驱动编排 | "用 finite state machine 管理用户生命周期，避免乱序、可恢复、可观测" |
| 双模式降级 | "LLM + 规则双轨，API 故障时自动降级保证可用性" |
| 流式 + 推理双通道 | "复用 DeepSeek-Super 的 SSE 协议，分离 reasoning_content 与 content" |
| 异步抽画像 | "前台流式回复，后台异步抽取画像，避免客户端超时" |
| 向量召回 + 多因子排序 | "用 cosine 相似度粗筛 topK，再用 5 维加权细排，兼顾召回率和精度" |
| 隐私保护设计 | "IceBreaker 只看画像标签，不看对话原文，从架构层面防泄露" |
| 预算+反循环+追踪 | "生产级 Agent 必备：预算防烧钱、反循环防死循环、追踪可调试" |

面试时一句话总结："这是个 **多 Agent 协作** 的社交匹配系统，用 **黑板模式** 解耦 Agent，用 **状态机** 编排流程，**LLM + 规则双轨** 保证可用性，**向量召回 + 多因子排序** 兼顾精度和可解释性，配套 **预算/反循环/追踪** 三件套保证生产级稳定。"

---

## 十一、Beta 迭代新增：对话体验三件套（思考/停止/多会话）

> 本次迭代解决三个用户体验痛点：① AI 思考过程不显示；② 无法中途停止生成；③ 对话混在一个流里没法管理。
> 配套代码：[`chatStore.js`](web/src/stores/chatStore.js)、[`MessageBubble.vue`](web/src/components/MessageBubble.vue)、[`chat.ts`](server/src/routes/chat.ts)、[`SessionSidebar.vue`](web/src/components/chat/SessionSidebar.vue)。

### 11.1 思考过程显示（修 Vue 响应式坑）

**问题**：前端只看到正文气泡，reasoning（推理模型内心独白）死活不出来，只有个蓝条蹦跶。

**根因**：chatStore 直接改消息对象属性：

```javascript
// ❌ 错误写法：aiMsg 是 push 前的原始对象引用
aiMsg.reasoning += delta    // Vue 的 ref 数组代理检测不到属性级修改
```

`aiMsg` 拿的是 push 进 `messages.value` 之前的普通对象引用，而 Vue 的 `ref([])` 虽会代理数组元素，但直接改代理对象属性 **在某些场景** 触发不了更新（尤其跨闭包持有原始引用时）。

**修复**：用整体替换数组元素，强制触发响应式：

```javascript
// ✅ 正确写法：整体替换元素，Vue 捕获数组变化
function _patchAi(index, patch) {
  if (index < 0 || index >= messages.value.length) return
  messages.value[index] = { ...messages.value[index], ...patch }
}

// onReasoning 回调里
streamingReasoning.value += delta
_patchAi(aiIndex, { reasoning: streamingReasoning.value })
```

**蓝条重叠 bug**：根因同上——两个 streaming 指示器（一个在思考框、一个在正文）同时跑，因为响应式没触发，旧的没关掉。修了响应式后自然只剩一个。

### 11.2 停止生成（AbortController 全链路）

**问题**：AI 一开聊就停不下来，用户只能等它说完。

**方案**：用 `AbortController` 打通前端 fetch → 后端 SSE → LLM 调用三层。

```
[前端] chatStore.stopGeneration()
   ↓ _streamController.abort()
[fetch] signal 传入 streamChat()，fetch 抛 AbortError
   ↓ SSE 流断开
[后端] res.on('close') 触发 → abortCtrl.abort()
   ↓ signal 传入 profileAgent.streamReply()
[LLM] chatStream 收到 abort，中断 OpenAI SDK 的流式请求
```

关键代码（三层 signal 传递）：

```javascript
// 前端 chatStore.js
_streamController = new AbortController()
await streamChat('/chat/messages', body, handlers, _streamController.signal)

function stopGeneration() {
  if (_streamController) {
    _streamController.abort()
    _streamController = null
  }
  // 把最后一条 streaming 的 AI 消息标记完成（保留已生成内容）
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'assistant' && messages.value[i].streaming) {
      _patchAi(i, { streaming: false })
      break
    }
  }
  streaming.value = false
}
```

```typescript
// 后端 chat.ts
const abortCtrl = new AbortController()
res.on('close', () => { aborted = true; abortCtrl.abort() })

const result = await profileAgent.streamReply(
  recent, profile,
  (delta) => { if (!aborted) sse(res, 'delta', { text: delta }) },
  ctx,
  abortCtrl.signal,   // ← 传给 LLM 调用
  (reasoningDelta) => { if (!aborted) sse(res, 'reasoning', { text: reasoningDelta }) },
)
```

UI 层 [`InputBar.vue`](web/src/components/layout/InputBar.vue) 流式时把发送按钮换成停止按钮：

```vue
<button v-if="isRunning" class="stop-btn" @click="$emit('stop')">
  <AppIcon name="stop" :size="16" />
  <span>停止生成</span>
</button>
<button v-else class="send-btn" @click="onSend">...</button>
```

### 11.3 多会话管理（chat_sessions 表 + 侧栏）

**问题**：原来所有对话挤在一条流里，用户想开新话题、回看旧话题都没法做。

**设计**：加 `chat_sessions` 表做消息分组，画像仍 per-user 跨会话累积。

```sql
-- schema.ts 新增
CREATE TABLE chat_sessions (
  id          TEXT PRIMARY KEY,             -- 'sess_' + timestamp + random
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '新对话',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- conversations 加 session_id 列（迁移）
ALTER TABLE conversations ADD COLUMN session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE;
```

**关键决策**：
- **画像 per-user，不 per-session**：用户在 A 会话聊跑步、B 会话聊音乐，两个画像 patch 都该合并到同一份用户画像。会话只做消息分组，不影响画像累积。
- **首条消息自动命名**：会话标题默认"新对话"，用户发首条消息后，后端取前 16 字更新标题（`deriveTitle()`），前端 `onDone` 本地同步。
- **外键 ON DELETE CASCADE**：删会话自动删该会话所有消息，不用手动清。

**API 设计**（[`chat.ts`](server/src/routes/chat.ts)）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/chat/sessions` | 列出用户所有会话（按 updated_at 倒序） |
| POST | `/chat/sessions` | 新建会话 |
| PATCH | `/chat/sessions/:id` | 重命名 |
| DELETE | `/chat/sessions/:id` | 删除（CASCADE 删消息） |
| GET | `/chat/sessions/:id/messages` | 加载某会话消息 |
| POST | `/chat/messages` | 发消息（body 带 sessionId） |

**前端侧栏**（[`SessionSidebar.vue`](web/src/components/chat/SessionSidebar.vue)）：
- 新建/切换/重命名（双击标题 inline 编辑）/删除（带确认）
- PC 端可折叠成窄条；移动端默认收起，点按钮浮层展开
- 至少保留一个会话（删最后一个时自动新建空会话）

**chatStore 状态扩展**：

```javascript
const sessions = ref([])              // 会话列表
const currentSessionId = ref('')      // 当前会话

async function ensureSession() {
  if (!sessions.value.length) await loadSessions()
  if (!currentSessionId.value) {
    currentSessionId.value = sessions.value[0]?.id
      || (await chatApi.createSession()).id
  }
  return currentSessionId.value
}
```

### 11.4 图片发送 + AI 生图（融合 DeepSeek-Super）

**用户发图**：[`InputBar.vue`](web/src/components/layout/InputBar.vue) 加图片上传按钮（最多 4 张），用 FileReader 转 dataURL 预览。发送时：
- **前端**：dataURL 存进用户消息 `images` 字段，MessageBubble 渲染缩略图网格
- **后端**：只传 `imageCount`（不传 dataURL，太大 + DeepSeek 不识图），后端在 content 后附 `[用户发送了N张图片]` 提示 AI

```javascript
// chatStore.send()
const userMsg = {
  id: `u-${Date.now()}`,
  role: 'user',
  text: content.trim(),
  images: images.map(i => i.data),   // dataURL 数组
  createdAt: Math.floor(Date.now() / 1000),
}

await streamChat('/chat/messages', {
  content: content.trim(),
  sessionId: currentSessionId.value,
  imageCount: images.length,          // 只传数量
}, handlers, _streamController.signal)
```

**AI 生图返问**（助力找搭子的杀手锏）：AI 想了解用户偏好活动场景时，输出 `[gen:图片描述]` 标记，前端 [`MessageBubble.vue`](web/src/components/MessageBubble.vue) 把它替换成 Pollinations.ai 的真实图片 URL：

```javascript
function expandGenMarkers(md) {
  return md.replace(/\[gen:\s*([^\]]+)\]/g, (_, desc) => {
    const prompt = desc.trim()
    const seed = Math.floor(Math.random() * 1000000)
    return `![${prompt}](https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&seed=${seed}&model=flux&nologo=true)`
  })
}
```

**使用场景**：AI 问"周末想怎么过？"，然后换行列出 `[gen:山顶日出 写实 风景]` `[gen:咖啡馆 温馨 室内]` `[gen:图书馆 安静 室内]`，用户看到 3 张真实图片选一个，比纯文字问"你喜欢爬山还是咖啡"直观 10 倍。

**ProfileAgent 的 system prompt 已教 AI 用这个标记**（[`profileAgent.ts`](server/src/agents/profileAgent.ts)）：

```
场景图片返问（助力找搭子）：
- 当想了解用户偏好的活动场景时，可以输出 [gen:图片描述] 标记
- 一次最多输出 3 个 [gen:...] 标记，配上一句引导
- 图片描述用中文+风格词（写实/动漫/水彩），描述越具体出图越准
- 不要每轮都用，只在需要了解活动偏好时用，避免刷屏
```

### 11.5 本次迭代的好处

| 改进点 | 好处 |
|---|---|
| 修响应式坑 | 思考过程可见，用户能看到 AI"怎么想的"，信任感+ |
| 停止生成 | 用户掌控节奏，不想听完可以随时打断，省 token |
| 多会话 | 话题分组管理，回看方便，画像跨会话累积不丢 |
| 用户发图 | 用户能晒活动现场图，AI 据此追问了解偏好 |
| AI 生图返问 | 用图片替代文字问"喜欢啥"，直观高效，助力精准找搭子 |
