// ============================================================
// chat.ts — 对话路由（链路枢纽，SSE 流式，整条链路最核心入口）
// 文件路径：server/src/routes/chat.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是"项目枢纽"——前端聊天消息全打这过。                  ║
// ║  它的工作：                                                 ║
// ║  1. 接前端消息                                              ║
// ║  2. 限流检查                                                ║
// ║  3. 存用户消息到 DB                                         ║
// ║  4. 调 ProfileAgent 流式生成 AI 回复                        ║
// ║  5. 通过 SSE 推给前端（边生成边推，秒回）                    ║
// ║  6. 回复完异步抽画像（后台跑，不阻塞）                       ║
// ║                                                            ║
// ║  核心设计：                                                 ║
// ║  - 先回复后抽画像（推理抽取慢 10-20s，先让用户秒看回复）      ║
// ║  - AbortController 支持停止生成（用户点"停止"或断网）        ║
// ║  - SSE 流式协议（event/data 双行格式，前端按事件类型分发）   ║
// ║  - 多会话管理（一个用户多话题，画像跨会话累积）              ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王发"我想找周末爬山搭子"，全链路 ▼▼▼
//
//   小王在前端输入"我想找周末爬山搭子"，点发送
//        │
//        ▼
//   POST /api/chat/messages  body: { content: '我想找周末爬山搭子', sessionId: 'sess_xxx' }
//        │
//        ▼
//   ① requireAuth 中间件 → 验 JWT → req.user = { id: '小王ID', tenantId, ... }
//        │
//        ▼
//   ② 限流：consumeRateLimit('小王ID')
//     → { allowed: true, remaining: 29 }（第 1 条，允许）
//        │
//        ▼
//   ③ 存用户消息：INSERT INTO conversations (role='user', content='我想找周末爬山搭子', session_id='sess_xxx')
//        │
//        ▼
//   ④ 加载最近 20 条对话（含本轮）作上下文
//        │
//        ▼
//   ⑤ 设置 SSE 响应头：
//     Content-Type: text/event-stream
//     Cache-Control: no-cache, no-transform
//     Connection: keep-alive
//        │
//        ▼
//   ⑥ 推 meta 事件（前端更新置信度/状态/剩余次数）：
//     event: meta
//     data: {"profileConfidence": 0.3, "state": "INIT", "rateLimit": {"remaining": 29, "limit": 30}}
//        │
//        ▼
//   ⑦ 调 ProfileAgent.streamReply()（核心）：
//     - LLM 模式：chatStream → 边生成边回调
//       onReasoning("用户想找...") → 推 reasoning 事件（前端展示思考框）
//       onDelta("周末") → 推 delta 事件（前端追加到气泡）
//       onDelta("爬山") → 推 delta 事件
//       onDelta("好搭子...") → 推 delta 事件
//     - 降级模式：模板生成 → 推 delta 事件
//        │
//        ▼
//   ⑧ 存 AI 消息：INSERT INTO conversations (role='assistant', content='周末爬山好搭子...', meta_json=...)
//        │
//        ▼
//   ⑨ 推 done 事件（前端结束流式状态）：
//     event: done
//     data: {"messageId": 1234567890, "profileConfidence": 0.35, "canMatch": false}
//        │
//        ▼
//   ⑩ 异步抽画像（不阻塞已结束的 SSE）：
//     profileAgent.run() → LLM 抽取画像 patch → confidence 0.3 → 0.45
//     transition(ctx, { type: 'profile_updated', confidence: 0.45 })
//   下次小王打开页面 → 置信度已更新到 0.45
//
// ════════════════════════════════════════════════════════════
//  【SSE 事件协议】（前端按 event 类型分发）
// ════════════════════════════════════════════════════════════
//   event: meta      → 会话元信息（置信度/状态/限流）
//   event: reasoning → 推理模型思考过程（前端展示在"思考框"）
//   event: delta     → AI 正文增量（前端追加到气泡）
//   event: done      → 流式结束（前端关闭流式状态）
//   event: error     → 出错（前端显示错误）
//
// ════════════════════════════════════════════════════════════
//  【关键优化点】
// ════════════════════════════════════════════════════════════
//   1. 先回复后抽画像：推理模型抽取慢（10-20s），先让用户秒看回复
//   2. res.on('close') 而非 req.on('close')：避免误判客户端断开
//   3. aborted 标志：客户端真断开时跳过 SSE 写入（避免写已关闭的流）
//   4. AbortController：用户点"停止生成"→ abort → LLM 流中断（省钱）
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - 前端 sse.js: streamChat('/chat/messages', ...)（流式发消息）
//   - 前端 fetch: /sessions, /history（会话管理）
//   - index.ts: app.use('/api/chat', chatRouter)（路由注册）
//
//   它调用：
//   - profileAgent.ts → streamReply（流式回复）、run（抽画像）
//   - orchestrator.ts → getSession（拿会话状态）、transition（状态机）
//   - rateLimiter.ts → consumeRateLimit, peekRateLimit（限流）
//   - db/index.js → 存用户消息、存 AI 消息
//   - middleware/auth.js → requireAuth（鉴权）
// ============================================================
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { consumeRateLimit, peekRateLimit } from '../services/rateLimiter.js'
import { ProfileAgent, loadProfile, type RecentMessage } from '../agents/profileAgent.js'
import { getSession, transition } from '../core/orchestrator.js'
import { getDB } from '../db/index.js'
import { llmEnabled } from '../services/llmClient.js'
import { clearTraces, getTraceSummary } from '../core/tracer.js'
import { profileAdapter } from '../integrations/agentMemoryAdapter.js'
import { cacheFile } from '../tools/readFile.js'
import { ALL_TOOLS } from '../tools/index.js'

export const chatRouter = Router()
const profileAgent = new ProfileAgent()

/**
 * sse() — SSE 事件封装工具函数
 * 文件路径：server/src/routes/chat.ts → sse()
 *
 * SSE 协议格式：
 *   event: 事件名\n
 *   data: JSON字符串\n\n
 * （两个 \n 表示一个事件结束）
 *
 * 前端 sse.js 按 \n\n 分块，再解析 event/data 行
 */
function sse(res: any, event: string, data: unknown): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

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

// ============================================================
// 会话管理（多会话：新建/列表/重命名/删除/加载消息）
// ============================================================
// 一个用户可有多个会话（话题分组）。画像仍 per-user 跨会话累积，
// 会话只做消息分组，方便用户开新话题、切换、清理。

/** 生成会话 ID：sess_时间戳_随机 */
// 文件路径：server/src/routes/chat.ts → newSessionId()
function newSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 默认会话标题：取首条用户消息前 16 字，否则"新对话" */
// 文件路径：server/src/routes/chat.ts → deriveTitle()
function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t ? (t.length > 16 ? t.slice(0, 16) + '…' : t) : '新对话'
}

// GET /sessions — 列出当前用户的所有会话（按最近更新倒序）
chatRouter.get('/sessions', requireAuth, (req, res) => {
  const db = getDB()
  const rows = db.prepare(`
    SELECT id, title, created_at, updated_at FROM chat_sessions
    WHERE user_id = ? ORDER BY updated_at DESC
  `).all(req.user!.id) as Array<{ id: string; title: string; created_at: number; updated_at: number }>
  res.json({ sessions: rows.map(r => ({
    id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at,
  }))})
})

// POST /sessions — 新建会话（可传 title，默认"新对话"）
chatRouter.post('/sessions', requireAuth, (req, res) => {
  const db = getDB()
  const id = newSessionId()
  const title = (req.body?.title && typeof req.body.title === 'string' && req.body.title.trim())
    ? req.body.title.trim().slice(0, 40) : '新对话'
  db.prepare(`
    INSERT INTO chat_sessions (id, user_id, tenant_id, title)
    VALUES (?, ?, ?, ?)
  `).run(id, req.user!.id, req.user!.tenantId, title)
  res.json({ id, title, createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000) })
})

// PATCH /sessions/:id — 重命名会话
chatRouter.patch('/sessions/:id', requireAuth, (req, res) => {
  const db = getDB()
  const title = (req.body?.title && typeof req.body.title === 'string') ? req.body.title.trim().slice(0, 40) : ''
  if (!title) { res.status(400).json({ error: '标题不能为空' }); return }
  const result = db.prepare(`
    UPDATE chat_sessions SET title = ?, updated_at = unixepoch()
    WHERE id = ? AND user_id = ?
  `).run(title, req.params.id, req.user!.id)
  if (result.changes === 0) { res.status(404).json({ error: '会话不存在' }); return }
  res.json({ id: req.params.id, title })
})

// DELETE /sessions/:id — 删除会话（外键 ON DELETE CASCADE 自动删消息）
chatRouter.delete('/sessions/:id', requireAuth, (req, res) => {
  const db = getDB()
  const result = db.prepare(`DELETE FROM chat_sessions WHERE id = ? AND user_id = ?`)
    .run(req.params.id, req.user!.id)
  if (result.changes === 0) { res.status(404).json({ error: '会话不存在' }); return }
  res.json({ ok: true })
})

// GET /sessions/:id/messages — 加载某会话的消息
chatRouter.get('/sessions/:id/messages', requireAuth, (req, res) => {
  const db = getDB()
  // 先校验会话归属当前用户
  const sess = db.prepare(`SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?`)
    .get(req.params.id, req.user!.id)
  if (!sess) { res.status(404).json({ error: '会话不存在' }); return }
  const rows = db.prepare(`
    SELECT id, role, content, created_at, meta_json FROM conversations
    WHERE session_id = ? ORDER BY id ASC
  `).all(req.params.id) as Array<{ id: number; role: string; content: string; created_at: number; meta_json: string | null }>
  res.json({
    messages: rows.map(r => {
      let meta = null
      if (r.meta_json) {
        try { meta = JSON.parse(r.meta_json) } catch { /* ignore */ }
      }
      return { id: String(r.id), role: r.role, content: r.content, createdAt: r.created_at, meta }
    }),
  })
})

/**
 * POST /messages — 发送消息（SSE 流式回复）
 *
 * 这是整个项目最核心的路由，链路如下：
 *   1. 校验消息内容（非空、长度限制）
 *   2. 限流检查（防滥用，每用户每分钟 N 条）
 *   3. 用户消息存 DB
 *   4. 加载最近 20 条对话历史（给 LLM 当上下文）
 *   5. 设置 SSE 响应头
 *   6. 推 meta 事件（会话元信息）
 *   7. 调 ProfileAgent.streamReply() 流式生成回复
 *      - onDelta 回调 → 推 delta 事件（AI 正文）
 *      - onReasoning 回调 → 推 reasoning 事件（思考过程）
 *   8. AI 回复存 DB
 *   9. 推 done 事件（前端结束流式状态）
 *  10. 异步调 ProfileAgent.run() 抽画像（不阻塞，后台跑）
 */
chatRouter.post('/messages', requireAuth, async (req, res) => {
  const { content } = req.body || {}
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : ''
  const imageCount = Math.min(Number(req.body?.imageCount) || 0, 4)
  const deepThinking = !!req.body?.deepThinking
  const fileContents: Array<{ name: string; content: string; size: number }> = req.body?.fileContents || []

  // 有图片或文件时允许空文字
  const hasText = content && typeof content === 'string' && content.trim().length > 0
  if (!hasText && imageCount === 0 && fileContents.length === 0) {
    res.status(400).json({ error: '消息不能为空' })
    return
  }
  // 必须带 sessionId（多会话管理）
  if (!sessionId) {
    res.status(400).json({ error: '缺少会话 ID' })
    return
  }

  // 限流
  const rl = consumeRateLimit(req.user!.id)
  if (!rl.allowed) {
    res.status(429).json({ error: '对话太频繁，稍后再试', retryAfter: rl.retryAfterSec })
    return
  }

  const db = getDB()
  const userId = req.user!.id
  const tenantId = req.user!.tenantId

  // 校验会话归属当前用户（防越权）
  const sess = db.prepare(`SELECT id, title FROM chat_sessions WHERE id = ? AND user_id = ?`)
    .get(sessionId, userId) as { id: string; title: string } | undefined
  if (!sess) {
    res.status(404).json({ error: '会话不存在' })
    return
  }

  // 拼接存 DB 的 content：文字 + [图片×N] 提示 + 文件信息
  //   DeepSeek 不识图，但 [图片×N] 让 AI 知道用户发了图（活动记录），
  //   AI 可据此追问，或调用 read_file 工具读取文件内容
  const textPart = (content || '').trim()
  const imageHint = imageCount > 0 ? `[用户发送了${imageCount}张图片]` : ''
  const fileList = fileContents.length > 0 ? `[用户上传了${fileContents.length}个文件: ${fileContents.map(f => f.name).join(', ')}]` : ''

  // ★ 缓存文件内容 → 供 AI read_file 工具调用
  for (const f of fileContents) {
    if (f.content && f.content.trim()) {
      cacheFile(userId, f.name, f.content)
      console.log(`[chat] 缓存文件: ${f.name} (${f.content.length} 字符)`)
    } else {
      console.log(`[chat] 文件无内容，跳过缓存: ${f.name}`)
    }
  }

  // ★ 把文件内容拼到 user message，AI 直接读到（不依赖 function calling）
  // 小文件（≤ 8000 字符）直接内联全文；大文件给前 8000 字符预览，并提示用 read_file 工具读取完整内容
  const INLINE_MAX = 8000
  const fileContentHint = fileContents.length > 0
    ? fileContents.map(f => {
        if (f.content && f.content.trim()) {
          if (f.content.length <= INLINE_MAX) {
            return `\n---\n[文件内容: ${f.name}]\n${f.content}`
          }
          const preview = f.content.slice(0, INLINE_MAX)
          return `\n---\n[文件内容: ${f.name}（共${f.content.length}字符，下面是前${INLINE_MAX}字符预览，完整内容请用 read_file 工具读取）]\n${preview}`
        }
        return `\n[文件: ${f.name}，无法读取文本内容]`
      }).join('\n')
    : ''

  const storedContent = [textPart, imageHint, fileList, fileContentHint].filter(Boolean).join(' ') || '[用户发送了消息]'

  // 保存用户消息（带 session_id + meta_json 持久化文件气泡）
  const userMeta = fileContents.length > 0
    ? JSON.stringify({ 
        files: fileContents.map(f => ({ name: f.name, size: f.size || 0 })),
      })
    : null
  db.prepare(`
    INSERT INTO conversations (user_id, tenant_id, session_id, role, content, meta_json)
    VALUES (?, ?, ?, 'user', ?, ?)
  `).run(userId, tenantId, sessionId, storedContent, userMeta)

  // ★ 写 Layer 1（短期会话记忆）：ProfileAgent 下次读历史不用查 DB
  //   cache 模块管理对话上下文（发给 LLM），Layer 1 管理任务上下文（画像抽取）
  try { profileAdapter.onMessage(userId, sessionId, 'user', storedContent) } catch { /* 非关键 */ }

  // 首条消息：把会话标题从"新对话"更新为消息摘要
  if (sess.title === '新对话' && textPart) {
    db.prepare(`UPDATE chat_sessions SET title = ?, updated_at = unixepoch() WHERE id = ?`)
      .run(deriveTitle(textPart), sessionId)
  } else {
    db.prepare(`UPDATE chat_sessions SET updated_at = unixepoch() WHERE id = ?`).run(sessionId)
  }

  // 对话历史由缓存模块（cacheLlmAdapter）维护，无需从DB加载上下文

  // SSE 头
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const ctx = getSession(userId, tenantId)
  clearTraces()

  // ─── 停止生成的关键：AbortController ───
  // 客户端断开（用户点"停止生成"或关页面）→ res 'close' → ctrl.abort()
  // → signal 传给 profileAgent.streamReply → chatStream 收到 abort → LLM 流中断
  // 不中断的话 LLM 会继续算 token 烧钱，且后端还在往已关闭的流写（aborted 标志兜底跳过写入）
  const abortCtrl = new AbortController()
  let aborted = false
  // 关键：用 res.on('close') 而非 req.on('close')
  // req.on('close') 在 POST body 读完后立刻触发（Express 已解析），会误判为客户端断开
  // res.on('close') 只在响应连接真正关闭时触发（客户端断开或 res.end()）
  res.on('close', () => { aborted = true; abortCtrl.abort() })

  try {
    // ── 关键优化：先流式回复（用户立刻看到 AI 思考+正文），后异步抽取画像 ──
    // 原来先抽取再回复，推理模型抽取慢（10-20s），客户端超时断开 → 0 事件
    // 现在调换顺序：用户秒看流式，抽取在回复结束后后台跑
    let profile = loadProfile(userId)

    // 1. 先推 meta + 流式回复
    if (!aborted) {
      const peek = peekRateLimit(userId)
      sse(res, 'meta', {
        profileConfidence: ctx.profileConfidence,
        state: ctx.state,
        rateLimit: { remaining: rl.remaining, limit: peek.limit },
      })

      const result = await profileAgent.streamReply(
        [{ role: 'user', content: textPart }],
        profile || createEmptyFor(userId),
        (delta) => { if (!aborted) sse(res, 'delta', { text: delta }) },
        ctx,
        abortCtrl.signal,
        (reasoningDelta) => { if (!aborted) sse(res, 'reasoning', { text: reasoningDelta }) },
        sessionId,
        deepThinking,
        fileContents.length > 0 ? ALL_TOOLS : undefined,
      )
      const replyText = result.text

      if (!aborted) {
        // 2. 保存 AI 消息（带 session_id，和用户消息同会话）
        db.prepare(`
          INSERT INTO conversations (user_id, tenant_id, session_id, role, content, meta_json)
          VALUES (?, ?, ?, 'assistant', ?, ?)
        `).run(userId, tenantId, sessionId, replyText, JSON.stringify({
          confidence: ctx.profileConfidence,
          trace: getTraceSummary(),
        }))

        // ★ 写 Layer 1：AI 回复也进短期记忆（画像抽取 + 破冰去重都要读）
        try { profileAdapter.onMessage(userId, sessionId, 'assistant', replyText) } catch { /* 非关键 */ }

        // 3. 推 done 事件（前端结束流式状态）
        sse(res, 'done', {
          messageId: Date.now(),
          profileConfidence: ctx.profileConfidence,
          state: ctx.state,
          canMatch: ctx.profileConfidence >= 0.5 || ctx.state === 'PROFILE_READY',
        })
      }
    }

    // 4. 异步抽取画像 patch（不阻塞已结束的 SSE，失败不影响回复）
    //    推理模型慢，这里 fire-and-forget，下次对话时画像已更新
    profileAgent.run({ recentMessages: [{ role: 'user', content: textPart }] }, ctx)
      .then((result) => {
        if (result.ok && result.data) {
          transition(ctx, { type: 'profile_updated', confidence: result.data.confidence })
        }
      })
      .catch(() => { /* 抽取失败不影响主流程 */ })
  } catch (e) {
    if (!aborted) sse(res, 'error', { message: (e as Error).message })
  } finally {
    res.end()
  }
})

chatRouter.get('/history', requireAuth, (req, res) => {
  const db = getDB()
  const rows = db.prepare(`
    SELECT id, role, content, created_at, meta_json FROM conversations
    WHERE user_id = ? ORDER BY id ASC LIMIT 200
  `).all(req.user!.id) as Array<{ id: number; role: string; content: string; created_at: number; meta_json: string | null }>
  res.json({
    messages: rows.map(r => {
      let meta = null
      if (r.meta_json) {
        try { meta = JSON.parse(r.meta_json) } catch { /* ignore */ }
      }
      return {
        id: String(r.id),
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
        meta,
      }
    }),
  })
})

function createEmptyFor(userId: string) {
  return loadProfile(userId) || {
    basic: { userId, createdAt: Date.now(), version: 0 },
    interests: [],
    socialStyle: { energy: 'unknown' as const, depth: 'unknown' as const },
    schedule: [], goal: '', constraints: [], confidence: 0,
  }
}
