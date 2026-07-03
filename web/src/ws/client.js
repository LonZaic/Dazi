// ============================================================
// WebSocket 客户端封装（内测用，可随时删 web/src/ws/ 目录）
// ───────────────────────────────────────────────────────────
// 通过 vite proxy 连 /ws（开发态），生产态直连 8788。
// 浏览器自动带 mm_token cookie，服务端验 JWT。
//
// 功能：自动重连 / 心跳保活 / 事件订阅 / 全局聊天 / 私信
// ============================================================

const HEARTBEAT_MS = 25000

function buildUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // 开发态走 vite proxy（/ws → 8788），生产态直连后端
  if (import.meta.env.DEV) {
    return `${proto}//${location.host}/ws`
  }
  return `${proto}//${location.hostname}:8788/ws`
}

export class WsClient {
  constructor() {
    this.ws = null
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.closedByUser = false
    this.reconnectAttempts = 0
    this.listeners = new Map() // event -> Set<fn>
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(fn)
    return () => this.off(event, fn)
  }

  off(event, fn) {
    this.listeners.get(event)?.delete(fn)
  }

  emit(event, payload) {
    this.listeners.get(event)?.forEach(fn => {
      try { fn(payload) } catch (e) { console.error('[ws listener]', e) }
    })
  }

  connect() {
    this.closedByUser = false
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return

    const url = buildUrl()
    try {
      this.ws = new WebSocket(url)
    } catch (e) {
      this.emit('error', { message: '无法创建 WebSocket 连接' })
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
      this.emit('open')
      this.startHeartbeat()
    }

    this.ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      this.emit('message', msg)
      // 按 type 分发
      switch (msg.type) {
        case 'hello': this.emit('hello', msg); break
        case 'online': this.emit('online', msg.users); break
        case 'presence': this.emit('presence', msg); break
        case 'chat': this.emit('chat', msg); break
        case 'private': this.emit('private', msg); break
        case 'pong': /* 心跳响应 */ break
        case 'error': this.emit('server-error', msg); break
      }
    }

    this.ws.onerror = () => {
      this.emit('error', { message: '连接异常' })
    }

    this.ws.onclose = (ev) => {
      this.stopHeartbeat()
      this.emit('close', { code: ev.code, reason: ev.reason })
      if (!this.closedByUser) this.scheduleReconnect()
    }
  }

  disconnect() {
    this.closedByUser = true
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close(1000, '用户主动断开') } catch {}
      this.ws = null
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj))
      return true
    }
    return false
  }

  sendChat(text) {
    return this.send({ type: 'chat', text })
  }

  sendPrivate(toUserId, text) {
    return this.send({ type: 'private', to: toUserId, text })
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' })
    }, HEARTBEAT_MS)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return
    // 指数退避，上限 30s
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000)
    this.reconnectAttempts++
    this.emit('reconnect', { attempt: this.reconnectAttempts, delayMs: delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}

// 单例
export const wsClient = new WsClient()
