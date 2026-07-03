// 各业务 API 聚合
import { api } from './client.js'

export const authApi = {
  register: (username, password, displayName) =>
    api.post('/auth/register', { username, password, displayName }),
  login: (username, password) =>
    api.post('/auth/login', { username, password }),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
}

export const chatApi = {
  status: () => api.get('/chat/status'),
  history: () => api.get('/chat/history'),
  // ─── 会话管理（多会话）───
  sessions: () => api.get('/chat/sessions'),
  createSession: (title) => api.post('/chat/sessions', { title }),
  renameSession: (id, title) => api.patch(`/chat/sessions/${id}`, { title }),
  deleteSession: (id) => api.del(`/chat/sessions/${id}`),
  sessionMessages: (id) => api.get(`/chat/sessions/${id}/messages`),
}

export const profileApi = {
  get: () => api.get('/profile'),
  history: () => api.get('/profile/history'),
}

export const matchApi = {
  run: (limit) => api.post('/match/run', { limit }),
  history: () => api.get('/match/history'),
  icebreaker: (targetUserId) => api.post('/match/icebreaker', { targetUserId }),
}

export const dmApi = {
  // 拉我的私信房间列表
  rooms: () => api.get('/dm/rooms'),
  // 创建/获取与某用户的房间（必须先匹配过）
  createRoom: (targetUserId) => api.post('/dm/rooms', { targetUserId }),
  // 拉某房间的消息历史（增量：since=N 表示 id > N）
  messages: (roomId, since = 0, limit = 50) =>
    api.get(`/dm/rooms/${roomId}/messages?since=${since}&limit=${limit}`),
  // 发消息
  send: (roomId, content) => api.post(`/dm/rooms/${roomId}/messages`, { content }),
  // 标记已读
  markRead: (roomId) => api.post(`/dm/rooms/${roomId}/read`),
}

export const privacyApi = {
  export: () => api.get('/privacy/export'),
  deleteAccount: () => api.del('/privacy/account'),
}

export const infoApi = {
  info: () => api.get('/info'),
  stats: () => api.get('/stats'),
}
