// ============================================================
// dm.ts — 私信路由（Direct Message）
// 文件路径：server/src/routes/dm.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  两个用户匹配成功后，可以开私信房间 1 对 1 聊天。          ║
// ║  提供：房间列表、发消息、拉历史、SSE 实时推送。             ║
// ║                                                            ║
// ║  在整条链路里的位置：                                       ║
// ║   前端 DmRoomView → POST /api/dm/rooms/:roomId/messages    ║
// ║   前端 DmRoomView → GET  /api/dm/rooms/:roomId/stream → SSE ║
// ║   本路由 → 直接读写 dm_rooms / dm_messages 表               ║
// ║                                                            ║
// ║  为什么用 SSE 而不是 WebSocket？                            ║
// ║   1. 复用现有 sse.js 解析逻辑（前端零新增依赖）             ║
// ║   2. SSE 走 HTTP，nginx/CDN/家庭路由器天然穿透，跨网络稳    ║
// ║   3. 不需要 socket.io 服务端，单进程不崩                    ║
// ║   4. 浏览器自动重连（fetch 流要前端手动重连，但简单）       ║
// ╚══════════════════════════════════════════════════════════╝
//
// 【跨网络稳定性关键点】
//   1. 心跳：每 25 秒推 ping 事件，防 nginx/代理 60s 超时断连
//   2. 增量：客户端断线重连带 since=lastId，补齐漏掉的消息
//   3. 轮询 DB：服务端每 1.5s 查一次新消息，简单可靠（单进程够用）
//   4. aborted 标志：客户端断开立刻停轮询，避免内存泄漏
//
// 【SSE 事件协议】
//   event: message  → 新消息（data: { id, senderId, content, createdAt }）
//   event: ping     → 心跳（data: { ts }）
//   event: error    → 出错
// ============================================================
import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'crypto'
import { requireAuth } from '../middleware/auth.js'
import { consumeRateLimit } from '../services/rateLimiter.js'
import { getDB } from '../db/index.js'
import { isBotUser, replyToUser } from '../services/aiBotReplier.js'

// 文件路径：server/src/routes/dm.ts → dmRouter
export const dmRouter = Router()

/** SSE 事件封装（和 chat.ts 一致风格） */
// 文件路径：server/src/routes/dm.ts → sse()
function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

/** 把两个 userId 按字典序排序，保证 user_a < user_b，房间唯一 */
// 文件路径：server/src/routes/dm.ts → sortPair()
function sortPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

/** 判断当前用户是否是房间成员 */
// 文件路径：server/src/routes/dm.ts → isRoomMember()
function isRoomMember(roomRow: { user_a: string; user_b: string }, userId: string): boolean {
  return roomRow.user_a === userId || roomRow.user_b === userId
}

/** 拿房间另一个用户 id */
// 文件路径：server/src/routes/dm.ts → otherUserId()
function otherUserId(roomRow: { user_a: string; user_b: string }, userId: string): string {
  return roomRow.user_a === userId ? roomRow.user_b : roomRow.user_a
}

// ─────────────────────────────────────────────────────
// GET /rooms — 我的私信房间列表
// ─────────────────────────────────────────────────────
dmRouter.get('/rooms', requireAuth, (req, res) => {
  const db = getDB()
  const userId = req.user!.id
  const tenantId = req.user!.tenantId

  // 拉所有我参与的房间，附上最近一条消息和未读数
  const rows = db.prepare(`
    SELECT
      r.id, r.user_a, r.user_b, r.created_at, r.last_message_at,
      (SELECT content FROM dm_messages WHERE room_id = r.id ORDER BY id DESC LIMIT 1) AS last_content,
      (SELECT sender_id FROM dm_messages WHERE room_id = r.id ORDER BY id DESC LIMIT 1) AS last_sender_id,
      (SELECT COUNT(*) FROM dm_messages
         WHERE room_id = r.id AND sender_id != ? AND read_at IS NULL) AS unread_count,
      ua.display_name AS user_a_name,
      ub.display_name AS user_b_name
    FROM dm_rooms r
    JOIN users ua ON ua.id = r.user_a
    JOIN users ub ON ub.id = r.user_b
    WHERE r.tenant_id = ? AND (r.user_a = ? OR r.user_b = ?)
    ORDER BY r.last_message_at DESC
  `).all(userId, tenantId, userId, userId) as Array<{
    id: string; user_a: string; user_b: string
    created_at: number; last_message_at: number
    last_content: string | null; last_sender_id: string | null
    unread_count: number
    user_a_name: string | null; user_b_name: string | null
  }>

  res.json({
    rooms: rows.map(r => {
      const otherId = otherUserId(r, userId)
      const otherName = r.user_a === userId ? (r.user_b_name || '匿名用户') : (r.user_a_name || '匿名用户')
      return {
        roomId: r.id,
        otherUserId: otherId,
        otherDisplayName: otherName,
        lastContent: r.last_content || '',
        lastSenderId: r.last_sender_id || '',
        lastMessageAt: r.last_message_at,
        unreadCount: r.unread_count,
        createdAt: r.created_at,
      }
    }),
  })
})

// ─────────────────────────────────────────────────────
// POST /rooms — 创建/获取与某用户的私信房间
//   前置条件：双方必须在 matches 表里有过匹配记录（避免被陌生人骚扰）
// ─────────────────────────────────────────────────────
dmRouter.post('/rooms', requireAuth, (req, res) => {
  const { targetUserId } = req.body || {}
  if (!targetUserId || typeof targetUserId !== 'string') {
    res.status(400).json({ error: '缺少目标用户' })
    return
  }
  const me = req.user!.id
  const tenantId = req.user!.tenantId
  if (targetUserId === me) {
    res.status(400).json({ error: '不能和自己私信' })
    return
  }

  const db = getDB()

  // 权限：必须先匹配过（matches 表里任一方向存在记录）
  const matched = db.prepare(`
    SELECT 1 FROM matches
    WHERE tenant_id = ? AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))
    LIMIT 1
  `).get(tenantId, me, targetUserId, targetUserId, me)
  if (!matched) {
    res.status(403).json({ error: '需要先匹配成功才能私信' })
    return
  }

  // 校验目标用户存在
  const targetExists = db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').get(targetUserId, tenantId)
  if (!targetExists) {
    res.status(404).json({ error: '目标用户不存在' })
    return
  }

  // 字典序保证唯一
  const [a, b] = sortPair(me, targetUserId)

  // 已存在则直接返回，不存在则新建
  let room = db.prepare(`
    SELECT id FROM dm_rooms WHERE tenant_id = ? AND user_a = ? AND user_b = ?
  `).get(tenantId, a, b) as { id: string } | undefined

  if (!room) {
    const id = randomUUID()
    db.prepare(`
      INSERT INTO dm_rooms (id, tenant_id, user_a, user_b) VALUES (?, ?, ?, ?)
    `).run(id, tenantId, a, b)
    room = { id }
  }

  res.json({ roomId: room.id })
})

// ─────────────────────────────────────────────────────
// GET /rooms/:roomId/messages — 拉历史/增量消息
//   ?since=N：只拉 id > N 的消息（增量补齐）；不传则拉最近 50 条
// ─────────────────────────────────────────────────────
dmRouter.get('/rooms/:roomId/messages', requireAuth, (req, res) => {
  const db = getDB()
  const roomId = req.params.roomId
  const userId = req.user!.id

  // 权限校验：必须是房间成员
  const room = db.prepare('SELECT user_a, user_b FROM dm_rooms WHERE id = ?').get(roomId) as
    { user_a: string; user_b: string } | undefined
  if (!room || !isRoomMember(room, userId)) {
    res.status(403).json({ error: '无权访问此房间' })
    return
  }

  const since = Number(req.query.since) || 0
  const limit = Math.min(Number(req.query.limit) || 50, 200)

  const rows = db.prepare(`
    SELECT id, sender_id, content, created_at, read_at
    FROM dm_messages
    WHERE room_id = ? AND id > ?
    ORDER BY id ASC LIMIT ?
  `).all(roomId, since, limit) as Array<{
    id: number; sender_id: string; content: string; created_at: number; read_at: number | null
  }>

  res.json({
    messages: rows.map(r => ({
      id: String(r.id),
      senderId: r.sender_id,
      content: r.content,
      createdAt: r.created_at,
      read: r.read_at !== null,
    })),
  })
})

// ─────────────────────────────────────────────────────
// POST /rooms/:roomId/messages — 发消息
// ─────────────────────────────────────────────────────
dmRouter.post('/rooms/:roomId/messages', requireAuth, async (req, res) => {
  const { content } = req.body || {}
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    res.status(400).json({ error: '消息不能为空' })
    return
  }
  if (content.length > 1000) {
    res.status(400).json({ error: '消息过长（上限 1000 字）' })
    return
  }

  const db = getDB()
  const roomId = req.params.roomId
  const userId = req.user!.id
  const tenantId = req.user!.tenantId

  // 权限校验
  const room = db.prepare('SELECT user_a, user_b FROM dm_rooms WHERE id = ?').get(roomId) as
    { user_a: string; user_b: string } | undefined
  if (!room || !isRoomMember(room, userId)) {
    res.status(403).json({ error: '无权访问此房间' })
    return
  }

  // 限流（防滥发）
  const rl = consumeRateLimit(userId)
  if (!rl.allowed) {
    res.status(429).json({ error: '发消息太频繁，稍后再试', retryAfter: rl.retryAfterSec })
    return
  }

  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(`
    INSERT INTO dm_messages (room_id, tenant_id, sender_id, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(roomId, tenantId, userId, content.trim(), now)

  // 更新房间最近消息时间（列表排序用）
  db.prepare('UPDATE dm_rooms SET last_message_at = ? WHERE id = ?').run(now, roomId)

  // ★ 如果接收方是 Bot，异步触发 AI 回复（不阻塞响应）
  const otherId = otherUserId(room, userId)
  if (isBotUser(otherId)) {
    replyToUser(otherId, req.user!.displayName, roomId, tenantId).catch(() => {})
  }

  res.json({
    message: {
      id: String(info.lastInsertRowid),
      senderId: userId,
      content: content.trim(),
      createdAt: now,
      read: false,
    },
  })
})

// ─────────────────────────────────────────────────────
// POST /rooms/:roomId/read — 标记对方发来的未读消息全部已读
// ─────────────────────────────────────────────────────
dmRouter.post('/rooms/:roomId/read', requireAuth, (req, res) => {
  const db = getDB()
  const roomId = req.params.roomId
  const userId = req.user!.id

  const room = db.prepare('SELECT user_a, user_b FROM dm_rooms WHERE id = ?').get(roomId) as
    { user_a: string; user_b: string } | undefined
  if (!room || !isRoomMember(room, userId)) {
    res.status(403).json({ error: '无权访问此房间' })
    return
  }

  const now = Math.floor(Date.now() / 1000)
  // 把对方发来的、未读的消息全部标记已读
  db.prepare(`
    UPDATE dm_messages SET read_at = ?
    WHERE room_id = ? AND sender_id != ? AND read_at IS NULL
  `).run(now, roomId, userId)

  res.json({ ok: true })
})

// ─────────────────────────────────────────────────────
// GET /rooms/:roomId/stream — SSE 长连接，实时推送新消息
//
// 工作原理：
//   1. 客户端打开连接，传 since=lastId（增量补齐）
//   2. 服务端每 1.5s 查一次 DB：SELECT WHERE id > since AND sender_id != me
//   3. 有新消息 → 推 message 事件 → 客户端累加到列表
//   4. 每 25s 推 ping 心跳 → 防 nginx/代理 60s 超时断连
//   5. 客户端断开（res.on('close')）→ 停轮询，释放资源
// ─────────────────────────────────────────────────────
dmRouter.get('/rooms/:roomId/stream', requireAuth, async (req: Request, res: Response) => {
  const db = getDB()
  const roomId = req.params.roomId
  const userId = req.user!.id

  // 权限校验
  const room = db.prepare('SELECT user_a, user_b FROM dm_rooms WHERE id = ?').get(roomId) as
    { user_a: string; user_b: string } | undefined
  if (!room || !isRoomMember(room, userId)) {
    res.status(403).json({ error: '无权访问此房间' })
    return
  }

  // SSE 头（和 chat.ts 一致）
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')   // 防 nginx 缓冲
  res.flushHeaders?.()

  // 起始 since：客户端传的 ?since=N，默认 0（拉所有）
  let sinceId = Number(req.query.since) || 0
  let aborted = false
  res.on('close', () => { aborted = true })

  // 心跳定时器：每 25s 推 ping，防代理超时
  const heartbeat = setInterval(() => {
    if (aborted) return
    try { sse(res, 'ping', { ts: Date.now() }) } catch { /* 写失败说明连接已断 */ }
  }, 25_000)

  // 标记对方发来的消息已读（一进房间就清未读）
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    UPDATE dm_messages SET read_at = ?
    WHERE room_id = ? AND sender_id != ? AND read_at IS NULL
  `).run(now, roomId, userId)

  try {
    // 轮询循环：每 1.5s 查一次新消息
    while (!aborted) {
      const rows = db.prepare(`
        SELECT id, sender_id, content, created_at
        FROM dm_messages
        WHERE room_id = ? AND id > ? AND sender_id != ?
        ORDER BY id ASC
      `).all(roomId, sinceId, userId) as Array<{
        id: number; sender_id: string; content: string; created_at: number
      }>

      for (const r of rows) {
        if (aborted) break
        sse(res, 'message', {
          id: String(r.id),
          senderId: r.sender_id,
          content: r.content,
          createdAt: r.created_at,
        })
        sinceId = r.id   // 推进游标
        // 标记已读
        db.prepare('UPDATE dm_messages SET read_at = ? WHERE id = ? AND read_at IS NULL')
          .run(now, r.id)
      }

      // 等 1.5s 再查（用 Promise + abort 信号提前退出）
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500)
        // 如果连接断开，立刻 resolve 退出循环
        res.on('close', () => { clearTimeout(t); resolve() })
      })
    }
  } catch {
    // 出错静默退出，不向已关闭的流写
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
})
