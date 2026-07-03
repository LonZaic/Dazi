// ============================================================
// sse.js — 前端 SSE 流式客户端（接收后端事件）
// ============================================================
//
// 【这个文件干啥的？】
//   前端发 POST 请求到后端，后端用 SSE 流式返回事件。
//   本文件负责：读流 → 按 \n\n 分块 → 解析 event/data → 回调分发。
//
// 【在整条链路里的位置】
//   chatStore.send() → streamChat() → 后端 POST /chat/messages
//                                        ↓ SSE 流
//   chatStore.send() ← onDelta/onReasoning/onMeta/onDone 回调
//
// 【谁调用它】
//   - chatStore.js: streamChat('/chat/messages', { content }, handlers)
//
// 【它调用谁】
//   - 全局 fetch（浏览器内置）
//   - ReadableStream API（resp.body.getReader）
//
// 【SSE 协议对应关系】
//   后端发：event: delta\ndata: {"text":"你好"}\n\n
//   前端收：按 \n\n 分块 → 解析出 event=delta, data={text:"你好"}
//   → 调 handlers.onDelta("你好")
//
// 【关键 JS 语法点】
//   - export function：ES Module 导出
//   - AbortController：可中止的 fetch（用户离开页面时取消）
//   - async/await：异步读流
//   - TextDecoder：字节 → 字符串
// ============================================================

/**
 * streamChat() — 发起流式对话请求
 *
 * @param {string} url    - API 路径（如 '/chat/messages'）
 * @param {object} body   - 请求体（如 { content: '你好' }）
 * @param {object} handlers - 事件回调集合
 *   - onDelta(text)     - AI 正文增量
 *   - onReasoning(text) - 推理模型思考过程增量
 *   - onMeta(data)      - 会话元信息
 *   - onDone(data)      - 流式结束
 *   - onError(msg)      - 出错
 * @param {AbortSignal} [signal] - 外部传入的中止信号（用户点"停止生成"时 abort）
 * @returns {Promise<void>} 完成/出错时 resolve
 *
 * 【为什么 signal 由外部传入？】
 *   旧版本在函数内部 new AbortController 并 `return controller`，
 *   但 return 写在 Promise 构造函数里，返回值被 Promise 吞掉，外部拿不到 controller，
 *   导致无法停止生成。现在由调用方（chatStore）创建 controller 并传入，store 持有引用可随时 abort。
 */
export function streamChat(url, body, handlers, signal) {
  return new Promise((resolve) => {
    fetch(`/api${url}`, {
      method: 'POST',
      credentials: 'include',                   // 带上 cookie（鉴权）
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,                                   // 外部传入的中止信号
    })
      .then(async (resp) => {
        if (!resp.ok) {
          // HTTP 错误（如 429 限流、401 未登录）
          const t = await resp.text().catch(() => '')
          let msg = `请求失败 (${resp.status})`
          try { msg = JSON.parse(t).error || msg } catch { /* */ }
          handlers.onError?.(msg)               // ?. 可选链：handlers.onError 不存在不报错
          resolve()
          return
        }

        // ── SSE 流解析 ──
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''            // 缓冲区：跨块的不完整事件暂存
        let curEvent = 'message' // 当前事件类型（默认 message）

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buf += decoder.decode(value, { stream: true })
          // 按 \n\n 分块（SSE 协议：两个 \n 表示一个事件结束）
          const parts = buf.split('\n\n')
          buf = parts.pop() || ''   // 最后一块可能不完整，留到下次

          for (const part of parts) {
            const lines = part.split('\n')
            let dataStr = ''
            for (const line of lines) {
              if (line.startsWith('event:')) {
                curEvent = line.slice(6).trim()    // 提取事件名
              } else if (line.startsWith('data:')) {
                dataStr += line.slice(5).trim()     // 提取数据（可能多行）
              }
            }
            if (!dataStr) continue
            let data
            try { data = JSON.parse(dataStr) } catch { data = { raw: dataStr } }
            dispatch(curEvent, data, handlers)      // 分发给对应回调
            curEvent = 'message'                    // 重置事件类型
          }
        }
        resolve()
      })
      .catch((e) => {
        // 网络错误或用户中止
        if (e.name !== 'AbortError') {
          handlers.onError?.(e.message || '网络错误')
        }
        resolve()
      })
  })
}

/**
 * dispatch() — 事件分发器（按 event 类型调对应回调）
 *
 * 后端发的 event 类型在这里对应到 handlers 的方法
 */
function dispatch(event, data, handlers) {
  switch (event) {
    case 'delta': handlers.onDelta?.(data.text || ''); break
    // 推理模型的思考过程（DeepSeek-v4-flash 等 reasoning 模型专用）
    case 'reasoning': handlers.onReasoning?.(data.text || ''); break
    case 'meta': handlers.onMeta?.(data); break
    case 'done': handlers.onDone?.(data); break
    case 'error': handlers.onError?.(data.message || '未知错误'); break
    default: break
  }
}

/**
 * streamDm() — GET 版 SSE 长连接（私信专用，支持断线重连）
 *
 * 和 streamChat 区别：
 *   - GET 而非 POST（只接收，不发数据）
 *   - 返回 controller + close()，外部可主动关
 *   - 自动重连：网络断开后 2s 自动重连，带 since=lastId 增量补齐
 *
 * @param {string} url    - 完整路径（如 '/dm/rooms/xxx/stream?since=0'）
 * @param {object} handlers
 *   - onMessage(msg)   - 新消息 { id, senderId, content, createdAt }
 *   - onError(msg)     - 出错（非断线）
 *   - onReconnect(attempt) - 重连中（可选，UI 可提示）
 * @returns {{ close: () => void }} close() 主动断开
 */
export function streamDm(url, handlers) {
  let controller = null
  let closed = false
  let lastId = 0      // 已收到的最新消息 id（重连时作 since 用）

  // 从 URL 里取当前 since 作为初始 lastId
  const m = url.match(/since=(\d+)/)
  if (m) lastId = Number(m[1]) || 0

  async function connect() {
    if (closed) return
    controller = new AbortController()

    try {
      const resp = await fetch(`/api${url}${url.includes('?') ? '&' : '?'}since=${lastId}`, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'text/event-stream' },
        signal: controller.signal,
      })

      if (!resp.ok) {
        const t = await resp.text().catch(() => '')
        let msg = `请求失败 (${resp.status})`
        try { msg = JSON.parse(t).error || msg } catch { /* */ }
        handlers.onError?.(msg)
        scheduleReconnect()
        return
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let curEvent = 'message'

      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break

        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() || ''

        for (const part of parts) {
          const lines = part.split('\n')
          let dataStr = ''
          for (const line of lines) {
            if (line.startsWith('event:')) curEvent = line.slice(6).trim()
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
          }
          if (!dataStr) continue
          let data
          try { data = JSON.parse(dataStr) } catch { data = { raw: dataStr } }

          if (curEvent === 'message' && data.id) {
            const idNum = Number(data.id)
            if (idNum > lastId) lastId = idNum   // 推进游标
            handlers.onMessage?.(data)
          }
          // ping/error/其他事件忽略（心跳不需要处理）
          curEvent = 'message'
        }
      }

      // 流正常结束（服务器关闭），尝试重连
      if (!closed) scheduleReconnect()
    } catch (e) {
      if (e.name === 'AbortError') return   // 主动关，不重连
      if (!closed) scheduleReconnect()
    }
  }

  let reconnectTimer = null
  let attempt = 0
  function scheduleReconnect() {
    if (closed) return
    attempt++
    handlers.onReconnect?.(attempt)
    reconnectTimer = setTimeout(() => {
      if (closed) return
      connect()
    }, 2000)   // 2s 后重连
  }

  connect()

  return {
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (controller) controller.abort()
    },
  }
}
