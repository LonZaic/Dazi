# 功能链路文档（带代码逻辑+函数）

> 这篇文档把项目的每条功能链路从"用户点按钮"讲到"数据库写完"，
> 每一步都带具体文件、函数、代码片段，看完能照着改。
> 配套阅读：[`AGENTS_DESIGN.md`](AGENTS_DESIGN.md)（agent 设计要点大白话版）

---

## 目录

1. [链路 1：用户发消息 → AI 流式回复](#链路-1用户发消息--ai-流式回复)
2. [链路 2：异步抽取画像（后台）](#链路-2异步抽取画像后台)
3. [链路 3：用户点"开始匹配" → 召回+排序](#链路-3用户点开始匹配--召回排序)
4. [链路 4：用户点"要破冰话术" → 生成 3 条开场白](#链路-4用户点要破冰话术--生成-3-条开场白)
5. [链路 5：注册/登录/鉴权](#链路-5注册登录鉴权)
6. [链路 6：加载历史消息+会话状态](#链路-6加载历史消息会话状态)
7. [链路 7：隐私导出/删号（GDPR/PIPL）](#链路-7隐私导出删号gdprpipl)
8. [链路 8：单人测试（seed 脚本）](#链路-8单人测试seed-脚本)
9. [链路 9：停止生成（AbortController 全链路）](#链路-9停止生成abortcontroller-全链路)
10. [链路 10：多会话管理（新建/切换/重命名/删除）](#链路-10多会话管理新建切换重命名删除)
11. [链路 11：用户发图 + AI 生图返问](#链路-11用户发图--ai-生图返问)

---

## 链路 1：用户发消息 → AI 流式回复

> 这是项目最核心、最热路径。用户在 [ChatView.vue](web/src/pages/ChatView.vue) 输入框打字回车，到屏幕上看到 AI 一个字一个字吐字，全流程。

### 时序图

```
用户回车
   │
   ▼
[ChatView.vue] onSend(text)
   │
   ▼
[chatStore.js] send(content)
   │ ① 用户消息立刻入列表（UI 秒显）
   │ ② 占位 AI 消息（streaming:true）
   ▼
[sse.js] streamChat('/chat/messages', {content}, handlers)
   │ POST /api/chat/messages
   ▼
[chat.ts] POST /messages 路由
   │ ③ 校验+限流+存用户消息
   │ ④ 加载最近 20 条对话
   │ ⑤ 设置 SSE 头
   │ ⑥ 推 meta 事件
   ▼
[profileAgent.ts] streamReply(recent, profile, onDelta, ctx, signal, onReasoning)
   │ ⑦ LLM 模式 → streamReplyLLM()
   │    └─ [llmClient.ts] chatStream([sys,...history], cb, opts)
   │         └─ fetch DeepSeek /chat/completions (stream:true)
   │              └─ SSE 流：每来一块调 onDelta/onReasoning
   │ ⑧ 降级模式 → templateReply() 逐字符模拟流式
   ▼
[chat.ts] onDelta → sse(res, 'delta', {text})
            onReasoning → sse(res, 'reasoning', {text})
   │
   ▼
[sse.js] 按 \n\n 分块 → 解析 event/data → dispatch
   │ onDelta(text) → chatStore: aiMsg.text += text
   │ onReasoning(text) → chatStore: aiMsg.reasoning += text
   ▼
[MessageBubble.vue] props 变化 → 重渲染
   │ reasoning 显示在可折叠"思考框"
   │ text markdown 渲染在主气泡，末尾流式光标
   ▼
用户看到 AI 一个字一个字打出来
```

### 关键代码（按顺序）

#### ① chatStore.js — 用户消息+占位 AI 消息

文件：[`web/src/stores/chatStore.js`](web/src/stores/chatStore.js) `send()` 方法

```javascript
async function send(content) {
  if (streaming.value || !content.trim()) return   // 流式中或空消息不发
  error.value = ''

  // 1. 用户消息立刻塞进列表（不等后端，UI 秒显）
  const userMsg = {
    id: `u-${Date.now()}`,
    role: 'user',
    text: content.trim(),
    createdAt: Math.floor(Date.now() / 1000),
  }
  messages.value.push(userMsg)

  // 2. 占位 AI 消息（streaming:true，边收边填）
  const aiMsg = {
    id: `a-${Date.now()}`,
    role: 'assistant',
    text: '',                // 正文（onDelta 累加）
    reasoning: '',           // 推理过程（onReasoning 累加）
    streaming: true,         // 标记流式中（UI 显示光标）
    createdAt: Math.floor(Date.now() / 1000),
  }
  messages.value.push(aiMsg)
  streaming.value = true

  // 3. 调 streamChat，注册 5 个回调（见下）
  await streamChat('/chat/messages', { content: content.trim() }, { onReasoning, onDelta, onMeta, onDone, onError })

  streaming.value = false
}
```

#### ② sse.js — POST + SSE 流解析

文件：[`web/src/api/sse.js`](web/src/api/sse.js) `streamChat()` 函数

```javascript
export function streamChat(url, body, handlers) {
  return new Promise((resolve) => {
    const controller = new AbortController()   // 支持中止

    fetch(`/api${url}`, {
      method: 'POST',
      credentials: 'include',                   // 带 cookie 鉴权
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).then(async (resp) => {
      if (!resp.ok) { /* HTTP 错误处理 */ resolve(); return }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let curEvent = 'message'

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE 协议：两个 \n 表示一个事件结束
        const parts = buf.split('\n\n')
        buf = parts.pop() || ''   // 最后一块可能不完整，留到下次

        for (const part of parts) {
          const lines = part.split('\n')
          let dataStr = ''
          for (const line of lines) {
            if (line.startsWith('event:')) curEvent = line.slice(6).trim()
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
          }
          if (!dataStr) continue
          let data; try { data = JSON.parse(dataStr) } catch { data = { raw: dataStr } }
          dispatch(curEvent, data, handlers)   // 按事件名分发
          curEvent = 'message'
        }
      }
      resolve()
    })
  })
}

function dispatch(event, data, handlers) {
  switch (event) {
    case 'delta': handlers.onDelta?.(data.text || ''); break
    case 'reasoning': handlers.onReasoning?.(data.text || ''); break
    case 'meta': handlers.onMeta?.(data); break
    case 'done': handlers.onDone?.(data); break
    case 'error': handlers.onError?.(data.message || '未知错误'); break
  }
}
```

#### ③ chat.ts 路由 — 校验+限流+存消息

文件：[`server/src/routes/chat.ts`](server/src/routes/chat.ts) `POST /messages`

```typescript
chatRouter.post('/messages', requireAuth, async (req, res) => {
  const { content } = req.body || {}
  if (!content || content.trim().length === 0) { res.status(400).json({ error: '消息不能为空' }); return }
  if (content.length > 2000) { res.status(400).json({ error: '消息过长' }); return }

  // 限流（防滥用）
  const rl = consumeRateLimit(req.user!.id)
  if (!rl.allowed) { res.status(429).json({ error: '对话太频繁', retryAfter: rl.retryAfterSec }); return }

  const userId = req.user!.id, tenantId = req.user!.tenantId// 从 cookie 取用户 ID 和租户 ID

  // 存用户消息到 conversations 表
  db.prepare(`INSERT INTO conversations (user_id, tenant_id, role, content) VALUES (?, ?, 'user', ?)`)
    .run(userId, tenantId, content.trim())// 存用户消息到 conversations 表

  // 加载最近 20 条对话（含本轮），给 LLM 当上下文
  const rows = db.prepare(`SELECT role, content FROM conversations WHERE user_id = ? ORDER BY id DESC LIMIT 20`)
    .all(userId)
  const recent: RecentMessage[] = rows.reverse().map(r => ({ role: r.role, content: r.content }))// 取最近 20 条对话（含本轮）

  // SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')   // 防 nginx 缓冲
  res.flushHeaders?.()

  const ctx = getSession(userId, tenantId)   // 拿会话状态机
  let aborted = false
  res.on('close', () => { aborted = true })  // 客户端断开检测

  // ... 见 ④
})
```

#### ④ chat.ts — 推 meta + 流式回复

```typescript
// 推 meta 事件（会话元信息）
sse(res, 'meta', {
  profileConfidence: ctx.profileConfidence,
  state: ctx.state,
  rateLimit: { remaining: rl.remaining, limit: peek.limit },
})

// 调 ProfileAgent.streamReply()，传 onDelta/onReasoning 回调
const result = await profileAgent.streamReply(
  recent,
  profile || createEmptyFor(userId),
  (delta) => { if (!aborted) sse(res, 'delta', { text: delta }) },          // → 前端 onDelta
  ctx,
  undefined,
  (reasoningDelta) => { if (!aborted) sse(res, 'reasoning', { text: reasoningDelta }) },  // → 前端 onReasoning
)
const replyText = result.text

// 存 AI 消息
db.prepare(`INSERT INTO conversations (user_id, tenant_id, role, content, meta_json) VALUES (?, ?, 'assistant', ?, ?)`)
  .run(userId, tenantId, replyText, JSON.stringify({ confidence: ctx.profileConfidence, trace: getTraceSummary() }))

// 推 done 事件
sse(res, 'done', { messageId: Date.now(), profileConfidence: ctx.profileConfidence, state: ctx.state, canMatch: ctx.profileConfidence >= 0.5 })

res.end()
```

#### ⑤ profileAgent.ts — streamReply() 双模式

文件：[`server/src/agents/profileAgent.ts`](server/src/agents/profileAgent.ts)

```typescript
async streamReply(messages, profile, onDelta, ctx, signal?, onReasoning?): Promise<{ text, reasoning }> {
  if (llmEnabled) {
    try {
      return await this.streamReplyLLM(messages, profile, onDelta, ctx, signal, onReasoning)
    } catch (e) {
      addStep('info', { event: 'llm_reply_failed', error: e.message })
      // LLM 失败降级到模板，保证用户总有回复
    }
  }
  // 降级模式：逐字符调 onDelta，模拟流式体验
  const reply = templateReply(profile)
  for (const ch of reply) {
    onDelta(ch)
    if (ch !== ' ') await sleep(8)
  }
  return { text: reply, reasoning: '' }
}

private async streamReplyLLM(messages, profile, onDelta, ctx, signal, onReasoning?) {
  const sys: ChatMessage = {
    role: 'system',
    content: `你是"搭子匹配官"，一个温暖、专业的社交匹配助手...
当前已知的用户画像：${profileToText(profile)}
对话原则：1.像朋友聊天 2.每轮聚焦1个方向 3.不要复述用户的话 ...`,
  }
  const history: ChatMessage[] = messages.slice(-12).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }))
  // 调 chatStream，传 onDelta/onReasoning 回调
  const { text, reasoning, usage } = await chatStream([sys, ...history], {
    onDelta,        // ← 每来一块正文 delta，链路一路传到前端
    onReasoning,    // ← 每来一块 reasoning_content，传到前端思考框
    onUsage: (u) => ctx.budget.recordApiUsage(u.inputTokens, u.outputTokens),
  }, { maxTokens: 2048, temperature: 0.7, signal })
  return { text, reasoning }
}
```

#### ⑥ llmClient.ts — chatStream 解析 DeepSeek SSE

文件：[`server/src/services/llmClient.ts`](server/src/services/llmClient.ts)

```typescript
export async function chatStream(messages, cb, opts): Promise<ChatResult> {
  if (!llmEnabled) throw new Error('LLM 未配置 API Key')

  const url = `${config.llm.apiBase.replace(/\/$/, '')}/chat/completions`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.model,                       // deepseek-v4-flash
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.6,
      stream: true,                                  // 关键：开启流式
      stream_options: { include_usage: true },
    }),
    signal: opts.signal,
  })

  // SSE 流解析
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = '', full = '', reasoning = '', usage = { inputTokens: 0, outputTokens: 0 }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''

    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const json = JSON.parse(data)
        const delta = json.choices?.[0]?.delta?.content       // 正文增量
        if (delta) { full += delta; cb.onDelta(delta) }       // → 一路传到前端
        const reasoningDelta = json.choices?.[0]?.delta?.reasoning_content  // 推理模型思考过程
        if (reasoningDelta) { reasoning += reasoningDelta; cb.onReasoning?.(reasoningDelta) }
        if (json.usage) {
          usage = { inputTokens: json.usage.prompt_tokens || 0, outputTokens: json.usage.completion_tokens || 0 }
          cb.onUsage?.(usage)
        }
      } catch { /* 单块解析失败跳过 */ }
    }
  }
  return { text: full, reasoning, usage }
}
```

#### ⑦ MessageBubble.vue — 渲染流式内容

文件：[`web/src/components/MessageBubble.vue`](web/src/components/MessageBubble.vue)

```vue
<template>
  <div class="msg" :class="role === 'user' ? 'user' : 'ai'">
    <div class="body" :class="{ streaming: streaming && role !== 'user' }">
      <!-- 用户：纯文本灰泡 -->
      <div v-if="role === 'user'" class="bubble">{{ text }}</div>

      <!-- AI：先思考框（reasoning），再正文（text） -->
      <template v-else>
        <div v-if="reasoning" class="thinking-box">
          <div class="thinking-head" @click="thinkingOpen = !thinkingOpen">
            <svg class="thinking-arrow-svg" :class="{ open: thinkingOpen }">...</svg>
            <span class="thinking-label">{{ streaming && !text ? '思考中…' : '已思考' }}</span>
          </div>
          <div v-show="thinkingOpen" class="thinking-body">{{ reasoning }}</div>
        </div>
        <div class="bubble markdown-body" :class="{ streaming }" v-html="renderedText"></div>
      </template>
    </div>
  </div>
</template>

<script setup>
const renderedText = computed(() => {
  if (!props.text) return props.streaming ? '<span class="streaming-cursor"></span>' : ''
  const html = marked.parse(props.text)
  return props.streaming ? `${html}<span class="streaming-cursor"></span>` : html
})
</script>
```

---

## 链路 2：异步抽取画像（后台）

> 用户已经看到 AI 回复并离开了页面，但后台还在跑画像抽取。这是 chat.ts 里 `profileAgent.run().then()` 那段，**fire-and-forget**。

### 时序图

```
[chat.ts] SSE 推完 done 事件后
   │
   ▼
profileAgent.run({ recentMessages: recent }, ctx)   ← 不 await！fire-and-forget
   │
   ▼
[baseAgent.ts] run() 包装：计时+try/catch+预算记账
   │
   ▼
[profileAgent.ts] execute(input, ctx)
   │ ① extractProfile(recent, ctx)
   │    ├─ LLM 模式 → extractViaLLM() → chatOnce() → DeepSeek
   │    └─ 降级模式 → extractViaKeywords() → 关键词匹配
   │ ② applyPatch(current, patch) → 合并到现有画像
   │ ③ persistProfile() → 存 profiles 表
   │    persistPatch()  → 存 profile_patches 表（审计）
   │ ④ 画像变化时重算向量
   │    profileToText(next) → embed(text) → updateProfileEmbedding()
   │ ⑤ blackboard.write('latest_profile', next)
   ▼
.then((result) => transition(ctx, { type: 'profile_updated', confidence }))
   │
   ▼
[orchestrator.ts] confidence ≥ 0.65 → state = PROFILE_READY
   │
   ▼
下次用户进 chat 页面，loadStatus() 返回 canMatch:true，UI 显示"开始匹配"按钮
```

### 关键代码

#### ① extractProfile — LLM 抽取 + JSON Schema 校验

文件：[`server/src/agents/profileAgent.ts`](server/src/agents/profileAgent.ts)

```typescript
private async extractViaLLM(messages, ctx): Promise<ProfilePatch> {
  const sys: ChatMessage = {
    role: 'system',
    content: `你是用户画像抽取器。从对话中提取用户的社交匹配画像，输出严格 JSON。
字段：interests[]、socialStyle{energy,depth}、schedule[]、goal、constraints[]
只输出 JSON，无新信息则输出 {}。`,
  }
  const user: ChatMessage = {
    role: 'user',
    content: '对话记录：\n' + messages.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n'),
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, usage } = await chatOnce([sys, user], { maxTokens: 2048, temperature: 0.2 })
    ctx.budget.recordApiUsage(usage.inputTokens, usage.outputTokens)

    // LLM 输出经常不老实，要"抢救"一下
    const raw = quickFixJSON(text)                    // 修尾逗号、未闭合括号
    const parsed = extractJSON(raw)                   // 从文本里抠出 JSON
    if (parsed) {
      const { valid, errors } = validateJSON(parsed, PATCH_SCHEMA)   // schema 校验
      if (valid) return parsed as ProfilePatch
      if (attempt === 1) throw new Error(`schema 校验失败: ${errors.join('; ')}`)
    } else if (attempt === 1) throw new Error('JSON 解析失败')
  }
  throw new Error('画像抽取重试耗尽')
}
```

#### ② applyPatch — 增量合并画像

文件：[`server/src/agents/profileSchema.ts`](server/src/agents/profileSchema.ts)

```typescript
export function applyPatch(profile: Profile, patch: ProfilePatch): Profile {
  const next: Profile = {
    ...profile,
    basic: { ...profile.basic, version: profile.basic.version + 1 },  // 版本号+1
    interests: [...profile.interests],
    // 非空字段覆盖
    schedule: patch.schedule ? [...patch.schedule] : [...profile.schedule],
    goal: patch.goal ?? profile.goal,
  }

  // 兴趣：同名合并（confidence 取 max，evidence 累加去重）
  if (patch.interests) {
    for (const ni of patch.interests) {
      const existing = next.interests.find(i => i.name.toLowerCase() === ni.name.toLowerCase())
      if (existing) {
        existing.confidence = Math.min(1, Math.max(existing.confidence, ni.confidence))
        if (ni.evidence && !existing.evidence.includes(ni.evidence)) {
          existing.evidence.push(ni.evidence)
          if (existing.evidence.length > 5) existing.evidence.shift()   // 最多留 5 条证据
        }
      } else {
        next.interests.push({ name: ni.name, confidence: ni.confidence, evidence: ni.evidence ? [ni.evidence] : [] })
      }
    }
  }

  next.confidence = computeConfidence(next)   // 重算整体置信度
  return next
}

export function computeConfidence(p: Profile): number {
  let score = 0
  score += Math.min(0.5, p.interests.filter(i => i.confidence >= 0.5).length * 0.15)  // 强兴趣
  if (p.interests.length > 0) score += (p.interests.reduce((s, i) => s + i.confidence, 0) / p.interests.length) * 0.2
  if (p.socialStyle.energy !== 'unknown') score += 0.15
  if (p.socialStyle.depth !== 'unknown') score += 0.1
  if (p.goal) score += 0.1
  if (p.schedule.length > 0) score += 0.05
  return Math.min(1, score)
}
```

#### ③ 重算向量 + 写黑板

```typescript
// 画像变化时重算向量
if (next.confidence > current.confidence || next.basic.version === 1) {
  const text = profileToText(next)        // 画像 → 纯文本
  const vec = await embed(text)            // 文本 → 1536 维向量（embed 是 embedding.ts）
  updateProfileEmbedding(ctx.userId, vec)  // 存回 profiles.embedding 字段
}

// 写黑板（其他 Agent 可读）
ctx.blackboard.write(this.agentId, 'latest_profile', next, 'profile_patch')
ctx.blackboard.write(this.agentId, 'latest_patch', patch, 'profile_patch')
```

#### ④ embed — 双模式嵌入

文件：[`server/src/services/embedding.ts`](server/src/services/embedding.ts)

```typescript
export async function embed(text: string): Promise<number[]> {
  if (config.embed.enabled && config.embed.apiBase) {
    try { return await embedViaApi(text) }   // API 嵌入（高质量）
    catch { return embedLocal(text) }
  }
  return embedLocal(text)                     // 本地嵌入（零依赖）
}

// 本地嵌入：char-bigram + 词哈希混合，L2 归一化
export function embedLocal(text: string): number[] {
  const vec = new Float64Array(DIM)   // DIM=256
  // 中文按字符 bigram 切，英文按词切
  const cjk = text.match(/[\u4e00-\u9fa5]/g) || []
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk[i]! + cjk[i + 1]!)
  // 哈希落入 DIM 维桶
  for (const tok of tokens) vec[hash(tok) % DIM] += 1
  // L2 归一化（cosine 直接点积）
  let norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  if (norm > 0) for (let i = 0; i < DIM; i++) vec[i] /= norm
  return Array.from(vec)
}
```

#### ⑤ 状态机转换

文件：[`server/src/core/orchestrator.ts`](server/src/core/orchestrator.ts)

```typescript
export function transition(ctx, signal): SessionState {
  switch (signal.type) {
    case 'profile_updated':
      if (signal.confidence !== undefined) ctx.profileConfidence = signal.confidence
      if (ctx.state === 'CHATTING' && ctx.profileConfidence >= 0.65) {
        ctx.state = 'PROFILE_READY'   // 画像够了，可匹配
      }
      break
    // ...
  }
}
```

---

## 链路 3：用户点"开始匹配" → 召回+排序

> 用户在 [MatchView.vue](web/src/pages/MatchView.vue) 点"重新匹配"按钮，到屏幕上看到 5 张候选卡片。

### 时序图

```
[MatchView.vue] onRun()
   │
   ▼
[matchStore.js] run(limit)
   │ POST /api/match/run
   ▼
[match.ts] POST /run 路由
   │ ① getSession() 拿会话状态
   │ ② loadProfile() 查我的画像（没画像 400 拒绝）
   │ ③ transition('match_requested') → state=MATCHING
   ▼
[matchAgent.ts] run({ limit }, ctx)
   │ ④ execute() 6 步流程
   │    a. loadProfile() 加载我的画像
   │    b. embed(myText) 我的画像 → 向量
   │    c. recallByVector() 向量召回 topK=20
   │       └─ [vectorStore.ts] cosine() 余弦相似度排序
   │    d. computeFactors() × 20 → 5 维因子
   │       weightedScore() × 20 → 综合分
   │    e. sort + slice → top 5
   │    f. blackboard.write('latest_matches', top)
   │       persistMatches() 存 matches 表
   │ ⑤ transition('match_done') → state=MATCHED
   ▼
[match.ts] res.json({ candidates, totalCount, myProfileText, state })
   │
   ▼
[matchStore.js] candidates.value = res.candidates
   │
   ▼
[MatchView.vue] v-for 渲染 MatchCard 列表
   │ 每张卡片显示：排名、姓名、综合分、5 维雷达图、共同兴趣、解释文本
   ▼
用户看到 5 个候选
```

### 关键代码

#### ① match.ts 路由

文件：[`server/src/routes/match.ts`](server/src/routes/match.ts)

```typescript
matchRouter.post('/run', requireAuth, async (req, res) => {
  const ctx = getSession(req.user!.id, req.user!.tenantId)
  const profile = loadProfile(req.user!.id)
  if (!profile || profile.interests.length === 0) {
    res.status(400).json({ error: '画像还不够，先去聊几句再匹配' }); return
  }

  transition(ctx, { type: 'match_requested' })   // state → MATCHING
  const result = await matchAgent.run({ limit: req.body?.limit }, ctx)
  if (!result.ok) { res.status(500).json({ error: result.error }); return }
  transition(ctx, { type: 'match_done' })        // state → MATCHED

  res.json({
    candidates: result.data!.candidates.map(toPublicCandidate),
    totalCount: result.data!.totalCount,
    myProfileText: result.data!.myProfileText,
    state: ctx.state,
  })
})
```

#### ② matchAgent.execute — 6 步流程

文件：[`server/src/agents/matchAgent.ts`](server/src/agents/matchAgent.ts)

```typescript
protected async execute(input, ctx): Promise<MatchAgentOutput> {
  // 1. 加载我的画像
  const myProfile = loadProfile(ctx.userId)
  if (!myProfile || myProfile.interests.length === 0) {
    return { candidates: [], totalCount: 0, myProfileText: '' }
  }

  // 2. 画像文本 → 向量
  const myVec = await embed(profileToText(myProfile))

  // 3. 向量召回 topK=20（同租户内，排除自己）
  const recalled = recallByVector(myVec, ctx.tenantId, ctx.userId, config.match.topK)
  if (recalled.length === 0) return { candidates: [], totalCount: 0, myProfileText: myText }

  // 4. 多因子排序
  const candidates = recalled.map(r => {
    const factors = computeFactors(myProfile, r.profile, r.score)
    const score = weightedScore(factors)
    const common = commonInterests(myProfile, r.profile)
    return {
      userId: r.userId,
      displayName: r.profile.displayName,
      score,
      factors,
      commonInterests: common,
      explanation: buildExplanation(r.profile, factors, common, myProfile),
      snapshot: r.profile,
    }
  })

  // 按综合分降序，取前 N=5
  candidates.sort((a, b) => b.score - a.score)
  const top = candidates.slice(0, input.limit ?? config.match.finalN)

  // 5. 写黑板
  ctx.blackboard.write(this.agentId, 'latest_matches', top, 'match_result')

  // 6. 存 matches 表（含因子 JSON，可审计）
  persistMatches(ctx.tenantId, ctx.userId, top)

  return { candidates: top, totalCount: candidates.length, myProfileText: myText }
}
```

#### ③ recallByVector — 余弦相似度召回

文件：[`server/src/db/vectorStore.ts`](server/src/db/vectorStore.ts)

```typescript
export function recallByVector(queryVec, tenantId, excludeUserId, topK) {
  const db = getDB()
  // 拉同租户内所有有向量的用户（排除自己）
  const rows = db.prepare(`
    SELECT user_id, embedding, profile_json, confidence, display_name
    FROM profiles p JOIN users u ON u.id = p.user_id
    WHERE p.tenant_id = ? AND p.user_id != ? AND p.embedding IS NOT NULL
  `).all(tenantId, excludeUserId)

  // 算每个候选的余弦相似度
  const scored = rows.map(r => {
    const vec = JSON.parse(r.embedding)
    const prof = parseProfileSnapshot(r)
    return { userId: r.user_id, score: cosine(queryVec, vec), profile: prof }
  })

  scored.sort((a, b) => b.score - a.score)   // 按相似度降序
  return scored.slice(0, topK)                // 取前 topK
}

export function cosine(a, b): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
```

#### ④ computeFactors + weightedScore — 5 维加权

```typescript
function computeFactors(my, theirs, vectorScore): MatchFactors {
  return {
    vector:   clamp01(vectorScore),                              // 向量相似度
    interest: interestOverlap(my.interests.map(i => i.name), theirs.interests),  // 兴趣 Jaccard
    style:    styleMatch(my.socialStyle, theirs.socialStyle),    // 风格匹配
    schedule: scheduleOverlap(my.schedule, theirs.schedule),     // 时段重合
    goal:     goalComplement(my.goal, theirs.goal),              // 目标互补
  }
}

function weightedScore(f: MatchFactors): number {
  const w = config.match.weights   // {vector:0.45, interest:0.25, style:0.15, schedule:0.10, goal:0.05}
  return clamp01(
    w.vector   * f.vector   +
    w.interest * f.interest +
    w.style    * f.style    +
    w.schedule * f.schedule +
    w.goal     * f.goal
  )
}

function interestOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const setB = new Set(b.map(s => s.toLowerCase()))
  const overlap = a.filter(x => setB.has(x.toLowerCase())).length
  return overlap / Math.min(a.length, b.length)   // Jaccard 风格
}
```

#### ⑤ buildExplanation — 可解释文本

```typescript
function buildExplanation(theirs, f, common, my): string {
  const parts: string[] = []
  if (common.length > 0) parts.push(`你们都对${common.slice(0, 3).join('、')}感兴趣`)
  if (f.vector > 0.6) parts.push('整体画像高度相似')
  else if (f.vector > 0.4) parts.push('画像有一定相似度')
  if (f.style > 0.7) parts.push('社交风格很合拍')
  if (f.schedule > 0.5) parts.push('活跃时段重合')
  if (theirs.goal) parts.push(`TA的目标是"${theirs.goal}"`)
  if (parts.length === 0) return '系统基于整体相似度推荐，建议聊聊看是否合拍。'
  return parts.join('，') + '。'
}
```

---

## 链路 4：用户点"要破冰话术" → 生成 3 条开场白

> 用户在 [MatchCard.vue](web/src/components/MatchCard.vue) 上点"要破冰话术"按钮。

### 时序图

```
[MatchCard.vue] @icebreaker 点击
   │
   ▼
[MatchView.vue] onIcebreaker(userId)
   │
   ▼
[matchStore.js] generateIcebreaker(targetUserId)
   │ POST /api/match/icebreaker { targetUserId }
   ▼
[match.ts] POST /icebreaker 路由
   │ ① 查最近一次匹配该目标的记录（拿因子+共同兴趣）
   │ ② loadTargetProfile() 加载目标用户画像
   │ ③ transition('icebreak_requested') → state=ICEBREAKING
   ▼
[iceBreakerAgent.ts] run({ targetUserId, targetProfile, myInterests, commonInterests, matchScore }, ctx)
   │ ④ execute() 双模式
   │    ├─ LLM 模式 → generateLLM()
   │    │    └─ chatOnce([sys, user]) → DeepSeek → 解析 JSON 数组
   │    └─ 降级模式 → generateTemplate() 基于共同兴趣模板
   │ ⑤ persistIcebreakers() 存 matches.icebreakers_json, state='icebroken'
   │ ⑥ transition('icebreak_done') → state=DONE
   ▼
[match.ts] res.json({ icebreakers, source, factors })
   │
   ▼
[matchStore.js] icebreakers.value[userId] = { list, source, factors }
   │
   ▼
[MatchCard.vue] 展示 3 条话术 + source 标签（LLM/模板）
```

### 关键代码

#### ① match.ts 路由

```typescript
matchRouter.post('/icebreaker', requireAuth, async (req, res) => {
  const { targetUserId } = req.body || {}
  if (!targetUserId) { res.status(400).json({ error: '缺少目标用户' }); return }

  const ctx = getSession(req.user!.id, req.user!.tenantId)
  const myProfile = loadProfile(req.user!.id)
  if (!myProfile) { res.status(400).json({ error: '你还没有画像' }); return }

  // 查最近一次匹配该目标的记录
  const matchRow = db.prepare(`
    SELECT factors_json, score FROM matches
    WHERE tenant_id = ? AND user_a = ? AND user_b = ?
    ORDER BY id DESC LIMIT 1
  `).get(ctx.tenantId, ctx.userId, targetUserId)
  if (!matchRow) { res.status(404).json({ error: '未找到匹配记录' }); return }

  const factors = JSON.parse(matchRow.factors_json)
  const targetProfile = await loadTargetProfile(targetUserId, ctx.tenantId)

  transition(ctx, { type: 'icebreak_requested' })
  const result = await iceBreakerAgent.run({
    targetUserId,
    targetProfile,
    myInterests: myProfile.interests.map(i => i.name),
    commonInterests: targetProfile.interests.filter(i =>
      myProfile.interests.some(mi => mi.name.toLowerCase() === i.toLowerCase())),
    matchScore: matchRow.score,
  }, ctx)
  transition(ctx, { type: 'icebreak_done' })

  res.json({ icebreakers: result.data!.icebreakers, source: result.data!.source, factors })
})
```

#### ② iceBreakerAgent.execute — 双模式

文件：[`server/src/agents/iceBreakerAgent.ts`](server/src/agents/iceBreakerAgent.ts)

```typescript
protected async execute(input, ctx): Promise<IceBreakerOutput> {
  if (llmEnabled) {
    try {
      const out = await this.generateLLM(input, ctx)
      persistIcebreakers(ctx.tenantId, ctx.userId, input.targetUserId, out)
      return { icebreakers: out, source: 'llm' }
    } catch (e) {
      addStep('info', { event: 'llm_icebreaker_failed', error: e.message })
      // LLM 失败降级模板
    }
  }
  const out = this.generateTemplate(input)
  persistIcebreakers(ctx.tenantId, ctx.userId, input.targetUserId, out)
  return { icebreakers: out, source: 'template' }
}

private async generateLLM(input, ctx): Promise<string[]> {
  const sys: ChatMessage = {
    role: 'system',
    content: `你是社交破冰话术专家。根据双方画像生成3条破冰开场白。
要求：1.每条≤30字 2.3条风格不同（共同兴趣/轻松幽默/真诚直接）3.不要"你好""在吗"
输出 JSON 数组：["话术1","话术2","话术3"]`,
  }
  const user: ChatMessage = {
    role: 'user',
    content: `我的兴趣：${input.myInterests.join('、')}
TA的兴趣：${input.targetProfile.interests.join('、')}
共同兴趣：${input.commonInterests.join('、')}
TA的目标：${input.targetProfile.goal}`,
  }
  const { text, usage } = await chatOnce([sys, user], { maxTokens: 512, temperature: 0.8 })
  ctx.budget.recordApiUsage(usage.inputTokens, usage.outputTokens)
  const raw = quickFixJSON(text)
  const parsed = extractJSON(raw)
  if (Array.isArray(parsed)) return parsed.slice(0, 3).map(String)
  throw new Error('破冰话术 JSON 解析失败')
}
```

#### ③ 隐私保护：只传画像标签，不传对话原文

```typescript
// IceBreakerInput 只含画像摘要，没有 conversations 表的原文
export interface IceBreakerInput {
  targetUserId: string
  targetProfile: ProfileSnapshot   // 只有 interests/socialStyle/goal 标签
  myInterests: string[]            // 我的兴趣标签
  commonInterests: string[]        // 共同兴趣标签
  matchScore: number
}
```

---

## 链路 5：注册/登录/鉴权

### 时序图

```
[LoginView.vue] 用户填表 → 提交
   │
   ▼
[authStore.js] login(username, password)
   │ POST /api/auth/login
   ▼
[auth.ts] POST /login 路由
   │ ① loginUser(username, password)
   │    └─ [services/auth.ts] bcrypt.compareSync(password, hash)
   │ ② signToken({ sub, tenant, username })
   │    └─ jwt.sign(payload, secret, { expiresIn: '7d' })
   │ ③ res.cookie('mm_token', token, { httpOnly: true, sameSite: 'lax' })
   ▼
浏览器自动存 cookie（JS 读不到，防 XSS）
   │
   ▼ 后续请求自动带 cookie
   │
[requireAuth 中间件] 每个 /api/* 请求都过这关
   │ ① req.cookies.mm_token 取 token
   │ ② verifyToken(token) → jwt.verify
   │ ③ getUserById(payload.sub) 查用户
   │ ④ req.user = user 注入到请求对象
   │ ⑤ next() 放行
   ▼
路由处理函数（chat.ts/match.ts 等）通过 req.user 拿到当前用户
```

### 关键代码

#### auth.ts 路由

文件：[`server/src/routes/auth.ts`](server/src/routes/auth.ts)

```typescript
authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) { res.status(400).json({ error: '用户名和密码必填' }); return }
  try {
    const user = loginUser(username, password)   // bcrypt 校验
    const token = signToken({ sub: user.id, tenant: user.tenantId, username: user.username })
    res.cookie(authCookieName, token, {
      httpOnly: true,                            // JS 读不到，防 XSS
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 3600 * 1000,              // 7 天
    })
    res.json({ user: toPublicUser(user) })
  } catch {
    res.status(401).json({ error: '用户名或密码错误' })   // 统一错误防枚举
  }
})
```

#### services/auth.ts — bcrypt + JWT

文件：[`server/src/services/auth.ts`](server/src/services/auth.ts)

```typescript
export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 12)   // cost=12，永不存明文
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash)
}

export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '7d' })
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return '密码至少 8 位'
  if (!/[a-zA-Z]/.test(pw)) return '密码需包含字母'
  if (!/\d/.test(pw)) return '密码需包含数字'
  return null
}
```

#### middleware/auth.ts — requireAuth

文件：[`server/src/middleware/auth.ts`](server/src/middleware/auth.ts)

```typescript
export function requireAuth(req, res, next): void {
  const token = req.cookies?.[authCookieName]
  if (!token) { res.status(401).json({ error: '未登录' }); return }
  const payload = verifyToken(token)
  if (!payload) { res.clearCookie(authCookieName); res.status(401).json({ error: '登录已过期' }); return }
  const user = getUserById(payload.sub)
  if (!user) { res.status(401).json({ error: '用户不存在' }); return }
  req.user = user   // 注入到请求对象，后续路由用 req.user!.id
  next()
}
```

---

## 链路 6：加载历史消息+会话状态

> 用户进入 [ChatView.vue](web/src/pages/ChatView.vue) 时，先拉会话列表、确保有当前会话、加载该会话历史消息和会话状态。
> **Beta 迭代变更**：原来直接拉全量历史，现在按会话加载（多会话管理）。

### 时序图

```
[ChatView.vue] onMounted
   │
   ├─ await chat.loadSessions()
   │    └─ GET /api/chat/sessions
   │         └─ [chat.ts] SELECT * FROM chat_sessions WHERE user_id=? ORDER BY updated_at DESC
   │              → sessions.value = res.sessions
   │
   ├─ await chat.ensureSession()
   │    └─ 若无 currentSessionId → 取 sessions[0] 或新建一个
   │
   ├─ await chat.loadHistory()
   │    └─ GET /api/chat/sessions/:id/messages
   │         └─ [chat.ts] SELECT * FROM conversations WHERE session_id=? ORDER BY id ASC
   │              → messages.value = res.messages
   │
   ├─ await chat.loadStatus()
   │    └─ GET /api/chat/status
   │         └─ [chat.ts] peekRateLimit() + getSession()
   │              → profileConfidence/sessionState/rateLimit/canMatch 更新
   │
   └─ await infoApi.info()
        └─ GET /api/info
             → llmOn 标签（AI 模式/规则模式）
```

### 关键代码

#### chat.ts — /sessions、/sessions/:id/messages、/status

```typescript
// 会话列表（多会话管理）
chatRouter.get('/sessions', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, title, created_at, updated_at FROM chat_sessions
    WHERE user_id = ? ORDER BY updated_at DESC
  `).all(req.user!.id)
  res.json({ sessions: rows.map(r => ({
    id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at,
  })) })
})

// 某会话的消息（按 session_id 查，不再查全量）
chatRouter.get('/sessions/:id/messages', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, role, content, created_at FROM conversations
    WHERE session_id = ? ORDER BY id ASC
  `).all(req.params.id)
  res.json({ messages: rows.map(r => ({
    id: String(r.id), role: r.role, content: r.content, createdAt: r.created_at,
  })) })
})

chatRouter.get('/status', requireAuth, (req, res) => {
  const rl = peekRateLimit(req.user!.id)
  const ctx = getSession(req.user!.id, req.user!.tenantId)
  res.json({
    llmEnabled,
    state: ctx.state,
    profileConfidence: ctx.profileConfidence,
    rateLimit: rl,
  })
})
```

---

## 链路 7：隐私导出/删号（GDPR/PIPL）

### 时序图

```
[PrivacyView.vue] 用户点"导出我的数据"或"删除账号"
   │
   ▼
[privacyStore] export() / deleteAccount()
   │ GET /api/privacy/export  或  DELETE /api/privacy/account
   ▼
[privacy.ts] 路由
   │ ① export: SELECT * FROM conversations/profiles/matches WHERE user_id=?
   │           → JSON 打包下载
   │ ② deleteAccount: DELETE FROM users WHERE id=? (CASCADE 级联删)
   │           → profiles/conversations/matches 全部级联删除
   │           → res.clearCookie('mm_token')
   ▼
浏览器下载 JSON / 跳回登录页
```

### 关键设计

- **单表存对话**：[`db/schema.ts`](server/src/db/schema.ts) 的 `conversations` 表，一键 `DELETE FROM users WHERE id=?` 就能级联删干净
- **审计表保留**：`profile_patches` 也级联删，但 `audit_log` 保留（合规要求）
- **导出格式**：标准 JSON，用户能拿到自己所有数据

---

## 链路 8：单人测试（seed 脚本）

> 一个人怎么玩？跑 seed 脚本造一批假用户，让你的画像能匹配到他们。

### 时序图

```
[终端] npm run seed
   │
   ▼
[scripts/seed.ts] main()
   │ ① initSchema() 建表
   │ ② 清空旧数据
   │ ③ 循环造 20 个假用户
   │    └─ 注册（bcrypt 哈希密码）
   │    └─ 给每个用户造画像（profiles 表）
   │    └─ profileToText(profile) → embed() → 存 embedding 字段
   ▼
现在你注册登录，聊几句，点"开始匹配"
   │
   ▼
[matchAgent] recallByVector() 从 20 个假用户里召回 top 5
   │
   ▼
你能看到 5 张候选卡片，整个匹配链路跑通
```

### 用法

```bash
cd server
npm run seed        # 造 20 个假用户
npm run dev         # 启动服务
```

然后浏览器打开 `http://localhost:5173`，注册登录，聊几句，点"开始匹配"，就能看到匹配结果。

---

## 全链路一图流

```
┌─────────────────────────────────────────────────────────────────────┐
│                          浏览器（前端）                              │
│  ChatView.vue ── chatStore.js ── sse.js ── fetch POST /api/chat/...  │
│      │              │              │                                │
│      │              │              │  SSE 流（event: delta/reasoning/done）
│      │              ▼              ▼                                │
│      │       MessageBubble.vue  按 \n\n 分块 → dispatch             │
│      │              ↑                                                │
│      └──── props 传 text/reasoning/streaming                         │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTP + Cookie
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Express 服务（后端）                           │
│  requireAuth 中间件 → chat.ts 路由                                   │
│      │                                                              │
│      ├─ consumeRateLimit()  限流                                    │
│      ├─ INSERT conversations  存用户消息                            │
│      ├─ SELECT conversations  加载最近 20 条                        │
│      ├─ SSE 头                                                       │
│      ├─ sse(res, 'meta', {...})                                     │
│      │                                                              │
│      ├─ profileAgent.streamReply()  ← 链路 1（前台流式回复）         │
│      │    └─ streamReplyLLM() → chatStream() → DeepSeek API         │
│      │         └─ onDelta → sse('delta')                            │
│      │         └─ onReasoning → sse('reasoning')                    │
│      │                                                              │
│      ├─ INSERT conversations 存 AI 消息                             │
│      ├─ sse(res, 'done', {...})                                     │
│      │                                                              │
│      └─ profileAgent.run().then()  ← 链路 2（后台异步抽画像）       │
│           └─ execute() → extractProfile() → applyPatch()            │
│                └─ embed() → updateProfileEmbedding()                │
│                └─ blackboard.write('latest_profile')                │
│                └─ transition('profile_updated') → PROFILE_READY     │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ 用户点"开始匹配"
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  match.ts POST /run  →  matchAgent.run()  ← 链路 3                  │
│      ├─ embed(myProfile)                                            │
│      ├─ recallByVector() → cosine() 排序 → top 20                   │
│      ├─ computeFactors() × 20 → weightedScore() × 20                │
│      ├─ sort + slice → top 5                                        │
│      ├─ persistMatches() 存 matches 表                              │
│      └─ res.json({ candidates, totalCount })                        │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ 用户点"要破冰话术"
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  match.ts POST /icebreaker  →  iceBreakerAgent.run()  ← 链路 4      │
│      ├─ generateLLM() → chatOnce() → DeepSeek → JSON 数组           │
│      ├─ persistIcebreakers() 存 matches.icebreakers_json            │
│      └─ res.json({ icebreakers, source, factors })                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 性能与成本数据

| 链路 | 延迟 | LLM token | 备注 |
|---|---|---|---|
| 链路 1（流式回复） | 首 token ~800ms | ~500 in + ~200 out | DeepSeek-v4-flash |
| 链路 2（抽画像） | 10-20s（后台） | ~800 in + ~400 out | 推理模型慢，后台跑不阻塞 |
| 链路 3（匹配） | <100ms | 0 | 纯计算，不调 LLM |
| 链路 4（破冰） | ~1-2s | ~400 in + ~150 out | 一次性调用 |
| 链路 5（登录） | <50ms | 0 | bcrypt + JWT |
| 链路 6（加载历史） | <50ms | 0 | 纯 DB 查询 |

**单用户完整链路成本**（注册→聊 5 轮→匹配→破冰）：

- LLM token：约 5000 in + 1500 out ≈ 0.05 元（DeepSeek 价格）
- DB 操作：约 30 次 INSERT/SELECT
- 向量计算：约 6 次 embed（本地零成本）

**结论**：项目非常省钱，单用户完整体验成本 < 0.1 元。

---

## 链路 9：停止生成（AbortController 全链路）

> Beta 迭代新增。用户在 AI 流式回复中途点"停止生成"按钮，全链路中断：前端 fetch → 后端 SSE → LLM 流式调用三层都收到 abort 信号。
> 配套代码：[`chatStore.js`](web/src/stores/chatStore.js)、[`sse.js`](web/src/api/sse.js)、[`chat.ts`](server/src/routes/chat.ts)、[`profileAgent.ts`](server/src/agents/profileAgent.ts)。

### 时序图

```
[InputBar.vue] 用户点"停止生成"按钮
   │
   ▼
[ChatView.vue] @stop="chat.stopGeneration()"
   │
   ▼
[chatStore.js] stopGeneration()
   ├─ _streamController.abort()           ← 中断 fetch
   ├─ 找最后一条 streaming 的 AI 消息
   │   └─ _patchAi(i, { streaming: false })  ← 关闭流式光标，保留已生成内容
   └─ streaming.value = false
   │
   ▼
[sse.js] fetch 收到 abort → 抛 AbortError → catch 忽略 → resolve()
   │
   ▼  （SSE 连接断开）
[chat.ts] res.on('close') 触发
   ├─ aborted = true                      ← 后续 SSE 事件不再推
   └─ abortCtrl.abort()                   ← 中断 LLM 调用
   │
   ▼
[profileAgent.ts] streamReply() 收到 abort
   └─ chatStream 的 OpenAI SDK 流式请求被中断
   │
   ▼
[chat.ts] 不保存被中断的 AI 消息（if (!aborted) 才存 DB）
```

### 关键代码

#### 前端 chatStore.js — 持有 AbortController

```javascript
let _streamController = null

async function send(content, images = []) {
  // ...
  _streamController = new AbortController()
  await streamChat('/chat/messages', body, handlers, _streamController.signal)
  _streamController = null
}

function stopGeneration() {
  if (_streamController) {
    _streamController.abort()
    _streamController = null
  }
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'assistant' && messages.value[i].streaming) {
      _patchAi(i, { streaming: false })
      break
    }
  }
  streaming.value = false
}
```

#### 前端 sse.js — 接收外部 signal

```javascript
export function streamChat(url, body, handlers, signal) {
  return new Promise((resolve) => {
    fetch(`/api${url}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,   // ← 外部传入的 AbortSignal
    })
    // ... SSE 解析逻辑，catch 里忽略 AbortError
  })
}
```

#### 后端 chat.ts — 监听 close + 传 signal 给 LLM

```typescript
chatRouter.post('/messages', requireAuth, async (req, res) => {
  // ...
  const abortCtrl = new AbortController()
  let aborted = false
  res.on('close', () => { aborted = true; abortCtrl.abort() })

  // ... SSE 头设置 ...

  const result = await profileAgent.streamReply(
    recent, profile || createEmptyFor(userId),
    (delta) => { if (!aborted) sse(res, 'delta', { text: delta }) },
    ctx,
    abortCtrl.signal,   // ← 传给 LLM 调用
    (reasoningDelta) => { if (!aborted) sse(res, 'reasoning', { text: reasoningDelta }) },
  )

  if (!aborted) {
    // 只有没被中断时才存 DB
    db.prepare(`INSERT INTO conversations ...`).run(...)
  }
})
```

### 关键设计点

| 设计点 | 解释 |
|---|---|
| 三层 signal 传递 | 前端 fetch → 后端 res.on('close') → LLM SDK，确保全链路中断，不留僵尸请求 |
| AbortError 静默处理 | sse.js 的 catch 判断 `e.name === 'AbortError'` 直接 resolve，不报错 |
| 保留已生成内容 | stopGeneration 不删消息，只把 streaming 标记改成 false，用户能看到已吐出的部分 |
| 中断不存 DB | 后端 `if (!aborted)` 包裹存库逻辑，避免存半截 AI 消息 |
| 前端按钮切换 | InputBar 流式时发送按钮变停止按钮（`v-if="isRunning"`） |

---

## 链路 10：多会话管理（新建/切换/重命名/删除）

> Beta 迭代新增。用户可以开多个会话（话题分组），切换、重命名、删除。画像仍 per-user 跨会话累积。
> 配套代码：[`SessionSidebar.vue`](web/src/components/chat/SessionSidebar.vue)、[`chatStore.js`](web/src/stores/chatStore.js)、[`chat.ts`](server/src/routes/chat.ts)、[`schema.ts`](server/src/db/schema.ts)。

### 时序图

```
┌─────────────────────────────────────────────────────────────┐
│  会话管理 4 个操作                                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  【新建】SessionSidebar @create                              │
│     → ChatView onCreateSession()                            │
│     → chat.createSession()                                  │
│        └─ POST /api/chat/sessions                           │
│           └─ INSERT INTO chat_sessions ...                  │
│        → sessions.value.unshift(s)                          │
│        → currentSessionId = s.id                            │
│        → messages.value = []   ← 清空，开新话题            │
│                                                              │
│  【切换】SessionSidebar @select(id)                          │
│     → ChatView onSelectSession(id)                          │
│     → chat.switchSession(id)                                │
│        → currentSessionId = id                              │
│        → await loadHistory()  ← 加载该会话消息             │
│                                                              │
│  【重命名】双击标题 → inline input → 回车                   │
│     → SessionSidebar @rename(id, title)                     │
│     → ChatView onRenameSession(id, title)                   │
│     → chat.renameSession(id, title)                         │
│        └─ PATCH /api/chat/sessions/:id                      │
│           └─ UPDATE chat_sessions SET title=? ...           │
│        → 本地 sessions 同步                                 │
│                                                              │
│  【删除】点删除按钮 → confirm → @delete                      │
│     → ChatView onDeleteSession(id)                          │
│     → chat.deleteSession(id)                                │
│        └─ DELETE /api/chat/sessions/:id                     │
│           └─ DELETE FROM chat_sessions ...                  │
│              （外键 CASCADE 自动删该会话所有消息）          │
│        → 若删的是当前会话 → 切到 sessions[0] 或新建空会话  │
└─────────────────────────────────────────────────────────────┘
```

### 关键代码

#### schema.ts — chat_sessions 表 + conversations 迁移

```typescript
// 新表：会话分组
CREATE TABLE chat_sessions (
  id          TEXT PRIMARY KEY,             -- 'sess_' + timestamp + random
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '新对话',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

// 迁移：conversations 加 session_id 列（幂等，检查列是否存在）
const cols = db.prepare('PRAGMA table_info(conversations)').all()
if (!cols.some(c => c.name === 'session_id')) {
  db.exec('ALTER TABLE conversations ADD COLUMN session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE')
}
```

#### chat.ts — 5 个会话 API

```typescript
// 列表
chatRouter.get('/sessions', requireAuth, (req, res) => { ... })

// 新建
chatRouter.post('/sessions', requireAuth, (req, res) => {
  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  db.prepare('INSERT INTO chat_sessions (id, user_id, tenant_id, title) VALUES (?, ?, ?, ?)')
    .run(id, req.user!.id, req.user!.tenantId, title)
  res.json({ id, title, ... })
})

// 重命名
chatRouter.patch('/sessions/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE chat_sessions SET title=?, updated_at=unixepoch() WHERE id=? AND user_id=?')
    .run(title, req.params.id, req.user!.id)
})

// 删除（CASCADE 删消息）
chatRouter.delete('/sessions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM chat_sessions WHERE id=? AND user_id=?').run(...)
})

// 加载某会话消息
chatRouter.get('/sessions/:id/messages', requireAuth, (req, res) => {
  db.prepare('SELECT ... FROM conversations WHERE session_id=? ORDER BY id ASC').all(...)
})
```

#### POST /messages — 带 sessionId + 首条消息自动命名

```typescript
chatRouter.post('/messages', requireAuth, async (req, res) => {
  const { content, sessionId, imageCount } = req.body

  // 校验会话归属当前用户（防越权）
  const sess = db.prepare('SELECT id, title FROM chat_sessions WHERE id=? AND user_id=?')
    .get(sessionId, userId)
  if (!sess) { res.status(404).json({ error: '会话不存在' }); return }

  // 存用户消息（带 session_id）
  db.prepare('INSERT INTO conversations (user_id, tenant_id, session_id, role, content) VALUES (...)')
    .run(userId, tenantId, sessionId, 'user', storedContent)

  // 首条消息：标题从"新对话"改成消息摘要（前 16 字）
  if (sess.title === '新对话' && textPart) {
    db.prepare('UPDATE chat_sessions SET title=?, updated_at=unixepoch() WHERE id=?')
      .run(deriveTitle(textPart), sessionId)
  }

  // 加载当前会话最近 20 条（按 session_id 查，保证对话连贯）
  const rows = db.prepare('SELECT role, content FROM conversations WHERE session_id=? ORDER BY id DESC LIMIT 20')
    .all(sessionId)
  // ...
})
```

### 关键设计点

| 设计点 | 解释 |
|---|---|
| 画像 per-user 不 per-session | 用户在 A 会话聊跑步、B 会话聊音乐，画像 patch 都合并到同一份用户画像。会话只分组消息 |
| 首条消息自动命名 | 标题默认"新对话"，首条消息后取前 16 字更新，前端 onDone 本地同步 |
| 外键 ON DELETE CASCADE | 删会话自动删该会话所有消息，不用手动清，DB 层保证一致性 |
| 防越权校验 | 所有会话操作都带 `AND user_id=?`，用户只能操作自己的会话 |
| 至少保留一个会话 | 前端删最后一个时自动新建空会话，避免用户进入"无会话"死状态 |
| PC 折叠 / 移动浮层 | 侧栏 PC 端可折叠成 48px 窄条；移动端默认收起，点按钮浮层展开 |

---

## 链路 11：用户发图 + AI 生图返问

> Beta 迭代新增，融合 DeepSeek-Super 的图片能力。① 用户能发图给 AI（晒活动现场）；② AI 能生图返问用户（用图片问"喜欢去哪玩"，助力找搭子）。
> 配套代码：[`InputBar.vue`](web/src/components/layout/InputBar.vue)、[`MessageBubble.vue`](web/src/components/MessageBubble.vue)、[`chatStore.js`](web/src/stores/chatStore.js)、[`chat.ts`](server/src/routes/chat.ts)、[`profileAgent.ts`](server/src/agents/profileAgent.ts)。

### 时序图 A：用户发图

```
[InputBar.vue] 点图片按钮 → 隐藏 file input 触发 click
   │
   ▼
[InputBar] onFileChange → FileReader.readAsDataURL → 转 base64
   ├─ pendingImages.push({ name, data: dataURL })
   └─ 渲染图片预览 chip（可点 × 删除）
   │
   ▼
[InputBar] 用户点发送 → $emit('send', { text, images: pendingImages })
   │
   ▼
[ChatView] onSend({ text, images })
   → chat.send(text, images)
   │
   ▼
[chatStore] send()
   ├─ userMsg.images = images.map(i => i.data)   ← dataURL 存进消息
   ├─ messages.value.push(userMsg)               ← MessageBubble 渲染缩略图
   └─ streamChat('/chat/messages', {
        content: text,
        sessionId,
        imageCount: images.length,               ← 只传数量，不传 dataURL
      }, ...)
   │
   ▼
[chat.ts] POST /messages
   ├─ imageHint = `[用户发送了${imageCount}张图片]`
   ├─ storedContent = `${text} ${imageHint}`     ← AI 知道用户发了图
   └─ INSERT INTO conversations ... (存拼接后的 content)
   │
   ▼
[profileAgent] AI 收到带 [用户发送了N张图片] 的上下文
   └─ 可追问"这张图是在哪拍的？"（AI 看不到图内容，但知道用户发了图）
```

### 时序图 B：AI 生图返问

```
[profileAgent] AI 想了解用户活动偏好
   └─ 输出 markdown 含 [gen:山顶日出 写实 风景] 标记
   │
   ▼  （SSE delta 事件流式推给前端）
[chatStore] onDelta → streamingText += delta → _patchAi({ text })
   │
   ▼
[MessageBubble] 渲染 AI 消息
   ├─ expandGenMarkers(md)  ← 把 [gen:描述] 替换成 Pollinations.ai URL
   │   └─ `![描述](https://image.pollinations.ai/prompt/${encodeURIComponent(描述)}?width=512&height=512&seed=随机&model=flux&nologo=true)`
   └─ marked() 渲染 markdown → <img> 标签
   │
   ▼
[浏览器] <img> 触发 HTTP GET → Pollinations.ai 生成图片（首次 3-8s）→ 显示
   │
   ▼
用户看到 3 张真实图片（山顶/咖啡馆/图书馆），点选一个回答
```

### 关键代码

#### InputBar.vue — 图片上传 + 预览 chip

```vue
<template>
  <div class="image-preview-row" v-if="pendingImages.length">
    <div class="image-chip" v-for="(img, i) in pendingImages" :key="i">
      <img :src="img.data" :alt="img.name" />
      <button class="image-chip-remove" @click="removeImage(i)">
        <AppIcon name="x" :size="12" />
      </button>
    </div>
  </div>

  <button v-if="!isRunning" class="image-btn"
          :disabled="pendingImages.length >= 4"
          @click="pickImage">
    <AppIcon name="image" :size="18" />
  </button>
  <input ref="fileInputRef" type="file" accept="image/*" multiple
         style="display:none" @change="onFileChange" />
</template>

<script setup>
function onFileChange(e) {
  const files = Array.from(e.target.files || [])
  files.slice(0, 4 - pendingImages.value.length).forEach(file => {
    const reader = new FileReader()
    reader.onload = () => {
      pendingImages.value.push({ name: file.name, data: reader.result })
    }
    reader.readAsDataURL(file)
  })
  e.target.value = ''   // 允许重复选同一文件
}
</script>
```

#### MessageBubble.vue — 用户图片渲染 + AI 生图标记展开

```javascript
// 用户消息：渲染图片网格
<template v-if="role === 'user'">
  <div v-if="images && images.length" class="user-images">
    <img v-for="(src, i) in images" :key="i" :src="src"
         class="user-image" @click="$emit('preview', src)" />
  </div>
  <div v-if="text" class="bubble">{{ text }}</div>
</template>

// AI 消息：[gen:描述] → Pollinations.ai URL
function expandGenMarkers(md) {
  return md.replace(/\[gen:\s*([^\]]+)\]/g, (_, desc) => {
    const prompt = desc.trim()
    const seed = Math.floor(Math.random() * 1000000)
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&seed=${seed}&model=flux&nologo=true`
    return `![${prompt}](${url})`
  })
}

const renderedHtml = computed(() => {
  const expanded = role.value === 'assistant' ? expandGenMarkers(props.text) : props.text
  return marked.parse(expanded)
})
```

#### profileAgent.ts — system prompt 教 AI 用 [gen:] 标记

```typescript
content: `你是"搭子匹配官"...

场景图片返问（助力找搭子）：
- 当想了解用户偏好的活动场景（如爬山/咖啡/图书馆/健身房/露营等）时，
  可以输出 [gen:图片描述] 标记，前端会把它渲染成一张 AI 生成的真实图片。
- 一次最多输出 3 个 [gen:...] 标记，配上一句引导，如：
  "周末想怎么过？选个感觉：" 然后换行列出 [gen:山顶日出 写实 风景] [gen:咖啡馆 温馨 室内] [gen:图书馆 安静 室内]
- 图片描述用中文+风格词（写实/动漫/水彩），描述越具体出图越准。
- 不要每轮都用，只在需要了解活动偏好时用，避免刷屏。
- 用户发了图片（content 里带 [用户发送了N张图片]）时，可以温和追问图里的活动。`
```

### 关键设计点

| 设计点 | 解释 |
|---|---|
| 用户图只存前端 dataURL | 图片不传后端（太大 + DeepSeek 不识图），只传 imageCount，后端在 content 附提示 |
| AI 知道用户发了图 | content 后附 `[用户发送了N张图片]`，AI 可据此追问，但看不到图内容 |
| [gen:描述] 标记前端展开 | AI 输出标记，前端用正则替换成 Pollinations.ai URL，浏览器懒加载生成图片 |
| Pollinations.ai 免费免 key | 直接拼 URL 即可生图，无需 API key、无需后端中转，零成本 |
| 随机 seed 防缓存 | 每次生成 seed 随机，避免相同描述出同一张图 |
| 一次最多 3 张 | prompt 限制 AI 不要刷屏，避免图片加载拖慢体验 |
| 图片加载占位 | CSS 给 img 设 min-height + 浅灰底，避免 Pollinations 生成时（3-8s）空白跳动 |
