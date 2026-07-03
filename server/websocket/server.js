// ============================================================
// 独立 WebSocket 服务（可选，内测用）
// ───────────────────────────────────────────────────────────
// 这个文件是【独立目录】server/websocket/ 的入口。
// 不依赖主 server 代码，只复用同一份 sqlite 数据库做鉴权。
//
// 启动：  node server/websocket/server.js
// 端口：  8788（可通过 WS_PORT 覆盖）
// 删除：  直接删整个 server/websocket/ 目录即可，主功能不受影响
//
// 功能：在线列表 / 全局聊天室 / 私信推送 / 心跳保活 / 限频防崩
// 鉴权：浏览器连接时自动带 mm_token cookie，服务端验 JWT
// ============================================================
import { WebSocketServer } from 'ws'
import Database from 'better-sqlite3'
import jwt from 'jsonwebtoken'
import 'dotenv/config'

const PORT = Number(process.env.WS_PORT) || 8788
const DB_PATH = process.env.DB_PATH || '../data/matchmate.db'
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me'
const COOKIE_NAME = 'mm_token'

// ── 性能保护阈值（校园网内测，避免被刷崩） ──
const MAX_TOTAL_CONNS = 1000        // 全局连接上限
const MAX_CONNS_PER_USER = 5        // 单用户连接上限（多端登录）
const MAX_MSG_LEN = 2000            // 单条消息字符上限
const RATE_WINDOW_MS = 1000         // 限频窗口
const RATE_MAX = 5                  // 窗口内最大消息数
const HEARTBEAT_MS = 30000          // 心跳间隔
const ALIVE_TIMEOUT_MS = 60000      // 超过此时间没 pong 视为死连接

// ── 共享状态 ──
// online: userId -> Set<ws>  （一个用户可能多端在线）
const online = new Map()
let totalConns = 0

// ── 直接连同一个 sqlite 库（只读用户表拿 displayName） ──
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
const stmtUser = db.prepare('SELECT display_name, tenant_id FROM users WHERE id = ?')

const wss = new WebSocketServer({ port: PORT }, () => {
  console.log(`\n  WS 服务已启动（独立进程）`)
  console.log(`  → ws://localhost:${PORT}`)
  console.log(`  → 鉴权: cookie ${COOKIE_NAME} (JWT)`)
  console.log(`  → 上限: 总连接 ${MAX_TOTAL_CONNS} / 单用户 ${MAX_CONNS_PER_USER} / 单条 ${MAX_MSG_LEN} 字`)
  console.log(`  → 心跳: ${HEARTBEAT_MS}ms / 死连接超时 ${ALIVE_TIMEOUT_MS}ms\n`)
})

wss.on('connection', (ws, req) => {
  // ── 1. 鉴权：解析 cookie → 验 JWT → 查用户 ──
  const token = parseCookie(req.headers.cookie || '')[COOKIE_NAME]
  if (!token) return ws.close(4001, '未登录')

  let payload
  try {
    payload = jwt.verify(token, JWT_SECRET)
  } catch {
    return ws.close(4001, 'token 无效或已过期')
  }
  const userId = payload.sub
  const username = payload.username
  if (!userId) return ws.close(4001, 'token 缺少 sub')

  const row = stmtUser.get(userId)
  const displayName = row?.display_name || username

  // ── 2. 连接数保护 ──
  if (totalConns >= MAX_TOTAL_CONNS) return ws.close(4029, '服务器繁忙，稍后再试')
  const userConns = online.get(userId)
  if (userConns && userConns.size >= MAX_CONNS_PER_USER) {
    return ws.close(4029, '该账号连接数已达上限')
  }

  // ── 3. 注册在线 ──
  totalConns++
  ws.userId = userId
  ws.username = username
  ws.displayName = displayName
  ws.tenantId = row?.tenant_id || payload.tenant
  ws.lastPong = Date.now()
  ws.rateWindow = []

  if (!online.has(userId)) online.set(userId, new Set())
  online.get(userId).add(ws)

  // ── 4. 通知其他人「我上线了」 + 给自己发在线列表 ──
  broadcast({
    type: 'presence',
    kind: 'join',
    user: { id: userId, name: displayName },
  }, userId)
  send(ws, { type: 'hello', me: { id: userId, name: displayName, username } })
  sendOnlineList(ws)

  // ── 5. 收消息 ──
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    // 限频
    const now = Date.now()
    ws.rateWindow = ws.rateWindow.filter(t => now - t < RATE_WINDOW_MS)
    if (ws.rateWindow.length >= RATE_MAX) {
      return send(ws, { type: 'error', message: '发太快了，歇 1 秒' })
    }
    ws.rateWindow.push(now)

    if (msg.type === 'ping') {
      ws.lastPong = now
      return send(ws, { type: 'pong' })
    }

    if (msg.type === 'chat') {
      const text = String(msg.text || '').slice(0, MAX_MSG_LEN)
      if (!text.trim()) return
      return broadcast({
        type: 'chat',
        from: { id: userId, name: displayName },
        text,
        at: now,
      })
    }

    if (msg.type === 'private') {
      const to = String(msg.to || '')
      const text = String(msg.text || '').slice(0, MAX_MSG_LEN)
      if (!to || !text.trim()) return
      const targetConns = online.get(to)
      const envelope = {
        type: 'private',
        from: { id: userId, name: displayName },
        to,
        text,
        at: now,
      }
      if (targetConns) {
        for (const c of targetConns) send(c, envelope)
      }
      // 回执给发送者自己（多端同步）
      return send(ws, envelope)
    }
  })

  // 浏览器原生 pong 帧
  ws.on('pong', () => { ws.lastPong = Date.now() })

  ws.on('close', () => {
    totalConns--
    const conns = online.get(userId)
    if (conns) {
      conns.delete(ws)
      if (conns.size === 0) {
        online.delete(userId)
        broadcast({
          type: 'presence',
          kind: 'leave',
          user: { id: userId, name: displayName },
        })
      }
    }
  })

  ws.on('error', () => { /* 静默，close 会跟进清理 */ })
})

// ── 心跳：踢死连接 ──
setInterval(() => {
  const now = Date.now()
  for (const [, conns] of online) {
    for (const ws of conns) {
      if (now - ws.lastPong > ALIVE_TIMEOUT_MS) {
        try { ws.terminate() } catch {}
      } else {
        try { ws.ping() } catch {}
      }
    }
  }
}, HEARTBEAT_MS).unref()

// ── 工具函数 ──
function send(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj))
  }
}

function broadcast(obj, exceptUserId) {
  const data = JSON.stringify(obj)
  for (const [uid, conns] of online) {
    if (uid === exceptUserId) continue
    for (const ws of conns) {
      if (ws.readyState === 1) ws.send(data)
    }
  }
}

function sendOnlineList(ws) {
  const users = []
  for (const [uid, conns] of online) {
    const any = conns.values().next().value
    if (any) users.push({ id: uid, name: any.displayName })
  }
  send(ws, { type: 'online', users })
}

function parseCookie(str) {
  const obj = {}
  for (const pair of str.split(';')) {
    const idx = pair.indexOf('=')
    if (idx < 0) continue
    const k = pair.slice(0, idx).trim()
    const v = pair.slice(idx + 1).trim()
    if (k) obj[k] = v
  }
  return obj
}

// ── 优雅关闭 ──
function shutdown(sig) {
  console.log(`\n收到 ${sig}，WS 服务关闭中...`)
  for (const [, conns] of online) {
    for (const ws of conns) {
      try { ws.close(1001, '服务器关闭') } catch {}
    }
  }
  wss.close(() => {
    db.close()
    console.log('已关闭。')
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 3000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', (e) => console.error('[uncaught]', e))
process.on('unhandledRejection', (e) => console.error('[unhandled]', e))
