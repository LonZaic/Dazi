// ============================================================
// dmStore.js — 私信状态管理（Pinia）
// ============================================================
//
// 【这个文件干啥的？】
//   管理私信相关的状态：房间列表、当前房间、消息列表、SSE 连接。
//
// 【在整条链路里的位置】
//   DmListView → loadRooms() → 显示房间列表
//   DmRoomView → openRoom(roomId) → 拉历史 + 开 SSE 长连接
//            → sendMessage(content) → POST + 乐观插入
//            → onMessage SSE 回调 → 追加对方消息
//
// 【关键设计】
//   1. SSE 连接 lifecycle：进房间开，离开房间关（避免泄漏）
//   2. 乐观更新：自己发消息先塞列表（UI 秒显），后端失败再回滚
//   3. 增量游标 lastMsgId：断线重连带 since=lastMsgId 补齐漏掉的
// ============================================================
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { dmApi } from '../api/index.js'
import { streamDm } from '../api/sse.js'

export const useDmStore = defineStore('dm', () => {
  // ─── 响应式状态 ───
  const rooms = ref([])                  // 私信房间列表
  const currentRoomId = ref('')          // 当前打开的房间
  const currentOtherUser = ref({})       // 当前房间对方用户信息 { id, displayName }
  const messages = ref([])               // 当前房间消息列表
  const loading = ref(false)             // 拉历史中
  const sending = ref(false)             // 发送中
  const error = ref('')                  // 错误信息
  const connected = ref(false)           // SSE 是否连上
  let streamHandle = null                // SSE 连接句柄（不响应式）
  let lastMsgId = 0                      // 已收到最新消息 id（增量游标）

  const totalUnread = computed(() =>
    rooms.value.reduce((s, r) => s + (r.unreadCount || 0), 0)
  )

  /**
   * loadRooms() — 刷新房间列表
   *   DmListView onMounted 调一次；发完消息/收到消息也刷新
   */
  async function loadRooms() {
    try {
      const res = await dmApi.rooms()
      rooms.value = res.rooms || []
    } catch (e) {
      error.value = e.message || '加载房间列表失败'
    }
  }

  /**
   * openRoom(roomId, otherUser) — 打开某房间
   *   1. 关闭上一个房间的 SSE
   *   2. 拉历史消息
   *   3. 开 SSE 长连接
   *   4. 标记已读
   */
  async function openRoom(roomId, otherUser) {
    // 关闭旧连接
    if (streamHandle) {
      streamHandle.close()
      streamHandle = null
    }

    currentRoomId.value = roomId
    currentOtherUser.value = otherUser || {}
    messages.value = []
    loading.value = true
    error.value = ''
    lastMsgId = 0

    try {
      const res = await dmApi.messages(roomId, 0, 200)
      messages.value = (res.messages || []).map(normalizeMsg)
      if (messages.value.length > 0) {
        lastMsgId = Number(messages.value[messages.value.length - 1].id)
      }
      // 标记已读
      await dmApi.markRead(roomId).catch(() => {})
      // 房间列表里把未读清零
      const r = rooms.value.find(x => x.roomId === roomId)
      if (r) r.unreadCount = 0
    } catch (e) {
      error.value = e.message || '加载消息失败'
    } finally {
      loading.value = false
    }

    // 开 SSE 长连接
    connected.value = false
    streamHandle = streamDm(`/dm/rooms/${roomId}/stream?since=${lastMsgId}`, {
      onMessage: (msg) => {
        messages.value.push(normalizeMsg(msg))
        const idNum = Number(msg.id)
        if (idNum > lastMsgId) lastMsgId = idNum
      },
      onReconnect: () => {
        connected.value = false
      },
    })
    connected.value = true
  }

  /**
   * closeRoom() — 离开当前房间（关 SSE）
   *   DmRoomView onUnmounted 调用，避免连接泄漏
   */
  function closeRoom() {
    if (streamHandle) {
      streamHandle.close()
      streamHandle = null
    }
    currentRoomId.value = ''
    messages.value = []
    connected.value = false
  }

  /**
   * sendMessage(content) — 发消息
   *   乐观更新：先塞列表（UI 秒显），后端失败回滚
   */
  async function sendMessage(content) {
    if (!currentRoomId.value || !content.trim() || sending.value) return
    sending.value = true
    error.value = ''

    // 乐观插入（tempId 防止 SSE 回推时重复）
    const tempId = `temp-${Date.now()}`
    const optimistic = {
      id: tempId,
      senderId: 'me',
      content: content.trim(),
      createdAt: Math.floor(Date.now() / 1000),
      read: false,
      pending: true,
    }
    messages.value.push(optimistic)

    try {
      const res = await dmApi.send(currentRoomId.value, content.trim())
      // 替换 tempId 为真实 id
      const idx = messages.value.findIndex(m => m.id === tempId)
      if (idx >= 0) {
        messages.value[idx] = {
          ...optimistic,
          id: res.message.id,
          senderId: res.message.senderId,
          createdAt: res.message.createdAt,
          pending: false,
        }
      }
      // 刷新房间列表的 lastContent/lastMessageAt
      const r = rooms.value.find(x => x.roomId === currentRoomId.value)
      if (r) {
        r.lastContent = content.trim()
        r.lastSenderId = 'me'
        r.lastMessageAt = res.message.createdAt
      }
    } catch (e) {
      // 回滚：删掉乐观消息
      const idx = messages.value.findIndex(m => m.id === tempId)
      if (idx >= 0) messages.value.splice(idx, 1)
      error.value = e.message || '发送失败'
    } finally {
      sending.value = false
    }
  }

  /**
   * startRoomWith(targetUserId, displayName) — 从 MatchCard 点"发私信"
   *   1. POST /dm/rooms 创建/拿房间
   *   2. 跳转到 /dm/:roomId
   *   3. 由 DmRoomView onMounted 调 openRoom()
   *   返回 roomId 供路由跳转
   */
  async function startRoomWith(targetUserId, displayName) {
    try {
      const res = await dmApi.createRoom(targetUserId)
      // 房间列表里加一条（如果还没有）
      if (!rooms.value.find(r => r.roomId === res.roomId)) {
        rooms.value.unshift({
          roomId: res.roomId,
          otherUserId: targetUserId,
          otherDisplayName: displayName || '对方',
          lastContent: '',
          lastSenderId: '',
          lastMessageAt: 0,
          unreadCount: 0,
          createdAt: Math.floor(Date.now() / 1000),
        })
      }
      return res.roomId
    } catch (e) {
      error.value = e.message || '创建房间失败'
      throw e
    }
  }

  function clearError() {
    error.value = ''
  }

  return {
    rooms, currentRoomId, currentOtherUser, messages,
    loading, sending, error, connected, totalUnread,
    loadRooms, openRoom, closeRoom, sendMessage, startRoomWith, clearError,
  }
})

function normalizeMsg(m) {
  return {
    id: String(m.id),
    senderId: m.senderId,
    content: m.content,
    createdAt: m.createdAt,
    read: !!m.read,
  }
}
