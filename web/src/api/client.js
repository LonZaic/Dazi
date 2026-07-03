// ============================================================
// API 客户端 — fetch 封装，自动带 cookie，统一错误处理
// 前端绝不直接展示 JSON，所有返回都是结构化对象，由组件渲染
// ============================================================

const BASE = '/api'

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

async function request(path, opts = {}) {
  const { body, ...rest } = opts
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...rest,
  })
  const text = await res.text()
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!res.ok) {
    const msg = (data && data.error) || `请求失败 (${res.status})`
    throw new ApiError(msg, res.status, data)
  }
  return data
}

export const api = {
  get: (p) => request(p, { method: 'GET' }),
  post: (p, body) => request(p, { method: 'POST', body }),
  put: (p, body) => request(p, { method: 'PUT', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p) => request(p, { method: 'DELETE' }),
}
