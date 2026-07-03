// ============================================================
// chatStore.js — 对话状态管理（Pinia store）
// ============================================================
//
// 【这个文件干啥的？】
//   管理聊天界面的所有状态：消息列表、流式状态、画像置信度、会话状态。
//   是前端聊天功能的"大脑"，UI 组件只管显示，状态都在这里。
//
// 【在整条链路里的位置】
//   ChatView.vue → chatStore.send() → streamChat() → 后端
//                                        ↓ SSE 回调
//   ChatView.vue ← chatStore.messages（响应式更新）
//
// 【谁调用它】
//   - ChatView.vue: useChatStore() 拿到 store
//   - MessageBubble.vue: 通过 props 拿 messages 里的单条消息
//
// 【它调用谁】
//   - api/index.js → chatApi.history/status（加载历史、状态）
//   - api/sse.js → streamChat（流式发消息）
//
// 【关键状态说明】
//   - messages: 消息列表（用户+AI 交替）
//   - streaming: 是否正在流式接收
//   - streamingText: 当前流式正文（累加）
//   - streamingReasoning: 当前流式思考过程（累加）
//   - profileConfidence: 画像置信度（0-1，≥0.5 可匹配）
//   - canMatch: 是否可以点"开始匹配"
//
// 【关键 Vue/Pinia 语法点】
//   - defineStore: 定义 store
//   - ref: 响应式引用（值变了 UI 自动更新）
//   - computed: 计算属性（派生状态）
//
// 【响应式坑点（重要）】
//   旧版本直接改消息对象属性：`aiMsg.reasoning = newText`。
//   但 aiMsg 是 push 进 ref 数组前的普通对象引用，Vue 的 ref 数组虽会代理元素，
//   直接改代理对象的属性其实也能触发更新——但这里 aiMsg 拿的是原始引用而非代理，
//   导致改了不更新。修复方式：通过 `messages.value[index] = { ...old, patch }`
//   整体替换数组元素，保证响应式触发。这是本次迭代修"思考过程不显示"的核心。
// ============================================================
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { chatApi } from '../api/index.js'
import { streamChat } from '../api/sse.js'

export const useChatStore = defineStore('chat', () => {
  // ─── 响应式状态 ───
  const messages = ref([])                  // 消息列表
  const streaming = ref(false)              // 是否正在流式
  const streamingText = ref('')             // 当前流式正文累加
  const streamingReasoning = ref('')        // 推理模型思考过程累加
  const profileConfidence = ref(0)          // 画像置信度
  const sessionState = ref('CHATTING')      // 会话状态机
  const canMatch = ref(false)               // 是否可匹配
  const rateRemaining = ref(0)              // 剩余配额
  const rateLimit = ref(0)                  // 总配额
  const error = ref('')                     // 错误信息

  // ─── 会话管理（多会话）───
  const sessions = ref([])                  // 用户的会话列表（{id,title,createdAt,updatedAt}）
  const currentSessionId = ref('')          // 当前打开的会话 ID

  // ─── 流式中止控制器（非响应式，存模块级变量即可）───
  // 用户点"停止生成"时调 _streamController.abort()，
  // fetch 抛 AbortError，SSE 流断开，前端 UI 停在当前内容。
  let _streamController = null

  /** 本地生成会话标题摘要（取前16字，与后端 deriveTitle 对齐） */
  function _deriveTitle(text) {
    const t = text.trim().replace(/\s+/g, ' ')
    return t ? (t.length > 16 ? t.slice(0, 16) + '…' : t) : '新对话'
  }

  // visibleMessages：模板里 v-for 用这个（未来可加过滤逻辑）
  const visibleMessages = computed(() => messages.value)

  /**
   * loadHistory() — 加载当前会话的历史消息
   * 后端 GET /api/chat/sessions/:id/messages 返回该会话全部消息
   */
  async function loadHistory() {
    if (!currentSessionId.value) { messages.value = []; return }
    try {
      const res = await chatApi.sessionMessages(currentSessionId.value)
      messages.value = res.messages.map(m => ({
        id: m.id,
        role: m.role,
        text: m.content,
        createdAt: m.createdAt,
      }))
    } catch { /* 忽略 */ }
  }

  // ============================================================
  // 会话管理（多会话：列表/新建/切换/重命名/删除）
  // ============================================================

  /** loadSessions() — 拉取用户的会话列表（按 updated_at 倒序） */
  async function loadSessions() {
    try {
      const res = await chatApi.sessions()
      sessions.value = res.sessions || []
    } catch { /* */ }
  }

  /**
   * ensureSession() — 确保有一个可用的当前会话
   * 进入聊天页时调：若没有会话则新建一个，若有则选最近的。
   * 返回 currentSessionId。
   */
  async function ensureSession() {
    if (!sessions.value.length) await loadSessions()
    if (!currentSessionId.value) {
      if (sessions.value.length === 0) {
        // 一个会话都没有 → 新建
        const s = await chatApi.createSession()
        sessions.value.unshift(s)
        currentSessionId.value = s.id
      } else {
        currentSessionId.value = sessions.value[0].id
      }
    }
    return currentSessionId.value
  }

  /** createSession() — 新建会话并切换过去 */
  async function createSession() {
    const s = await chatApi.createSession()
    sessions.value.unshift(s)
    currentSessionId.value = s.id
    messages.value = []
    return s
  }

  /** switchSession(id) — 切换到指定会话，加载其消息 */
  async function switchSession(id) {
    if (id === currentSessionId.value) return
    currentSessionId.value = id
    await loadHistory()
  }

  /** renameSession(id, title) — 重命名会话（本地同步 + 后端） */
  async function renameSession(id, title) {
    await chatApi.renameSession(id, title)
    const s = sessions.value.find(x => x.id === id)
    if (s) s.title = title
  }

  /**
   * deleteSession(id) — 删除会话
   * 删当前会话时，自动切到列表里的下一个会话（或新建空会话）
   */
  async function deleteSession(id) {
    await chatApi.deleteSession(id)
    sessions.value = sessions.value.filter(x => x.id !== id)
    if (currentSessionId.value === id) {
      if (sessions.value.length > 0) {
        currentSessionId.value = sessions.value[0].id
        await loadHistory()
      } else {
        // 全删光了 → 新建一个空会话
        const s = await chatApi.createSession()
        sessions.value.unshift(s)
        currentSessionId.value = s.id
        messages.value = []
      }
    }
  }

  /**
   * loadStatus() — 加载会话状态（画像置信度/限流/是否可匹配）
   * 后端 GET /api/chat/status
   */
  async function loadStatus() {
    try {
      const res = await chatApi.status()
      profileConfidence.value = res.profileConfidence
      sessionState.value = res.state
      rateRemaining.value = res.rateLimit.remaining
      rateLimit.value = res.rateLimit.limit
      canMatch.value = res.profileConfidence >= 0.5
    } catch { /* */ }
  }

  /**
   * _patchAi(index, patch) — 响应式更新指定 AI 消息
   *
   * 【为什么需要这个？】
   *   直接 `aiMsg.reasoning = newText` 改的是原始对象引用，
   *   Vue 的 ref 数组代理检测不到属性级修改，UI 不刷新。
   *   通过整体替换数组元素 `messages.value[index] = { ...old, ...patch }`，
   *   Vue 才能捕获变化触发重渲染。这是修"思考过程不显示"的关键。
   */
  function _patchAi(index, patch) {
    if (index < 0 || index >= messages.value.length) return
    messages.value[index] = { ...messages.value[index], ...patch }
  }

  /**
   * send() — 发送消息（核心方法）
   *
   * 流程：
   *   1. 先把用户消息塞进列表（UI 立刻显示）
   *   2. 占位一条 AI 消息（streaming:true，边收边填）
   *   3. 调 streamChat，注册 5 个回调，传入 AbortSignal
   *   4. onReasoning → 累加并通过 _patchAi 响应式更新 reasoning（思考框）
   *   5. onDelta → 累加并通过 _patchAi 响应式更新 text（正文气泡）
   *   6. onMeta → 更新置信度/限流
   *   7. onDone → 关闭流式状态
   *   8. onError → 显示错误
   *
   * 【停止生成】
   *   store 持有 _streamController，stopGeneration() 调 .abort() 即可中断。
   *   fetch 收到 abort 后抛 AbortError，sse.js 的 catch 会忽略它并 resolve。
   */
  async function send(content, images = []) {
    if (streaming.value || (!content.trim() && images.length === 0)) return   // 流式中或空消息不发
    error.value = ''
    // 确保有当前会话（多会话管理）
    if (!currentSessionId.value) await ensureSession()
    if (!currentSessionId.value) { error.value = '会话未就绪，请刷新重试'; return }

    const hasImages = images.length > 0

    // 1. 用户消息立刻塞进列表（不等后端）
    //    图片只在前端展示（dataURL），不发给后端（太大 + DeepSeek 不识图）
    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: content.trim(),
      images: hasImages ? images.map(i => i.data) : [],   // 存 dataURL 数组供 MessageBubble 渲染
      createdAt: Math.floor(Date.now() / 1000),
    }
    messages.value.push(userMsg)

    // 2. 占位 AI 消息（流式填充），记录索引便于响应式更新
    const aiId = `a-${Date.now()}`
    const aiIndex = messages.value.length       // push 前的索引 = push 后该元素的位置
    messages.value.push({
      id: aiId,
      role: 'assistant',
      text: '',                // 正文（onDelta 累加）
      reasoning: '',           // 推理过程（onReasoning 累加）
      streaming: true,         // 标记流式中（UI 显示光标）
      createdAt: Math.floor(Date.now() / 1000),
    })
    streaming.value = true
    streamingText.value = ''
    streamingReasoning.value = ''

    // 3. 创建 AbortController 并传给 streamChat（支持停止生成）
    //    body 带 sessionId（多会话）+ imageCount（图片提示 AI 上下文）
    _streamController = new AbortController()
    await streamChat('/chat/messages', {
      content: content.trim(),
      sessionId: currentSessionId.value,
      imageCount: images.length,
    }, {
      // 推理模型思考过程：累加到 reasoning 字段（响应式更新）
      onReasoning: (delta) => {
        streamingReasoning.value += delta
        _patchAi(aiIndex, { reasoning: streamingReasoning.value })
      },
      // AI 正文：累加到 text 字段（响应式更新）
      onDelta: (delta) => {
        streamingText.value += delta
        _patchAi(aiIndex, { text: streamingText.value })
      },
      // 会话元信息：更新置信度/限流
      onMeta: (data) => {
        if (data.profileConfidence !== undefined) profileConfidence.value = data.profileConfidence
        if (data.state) sessionState.value = data.state
        if (data.rateLimit) {
          rateRemaining.value = data.rateLimit.remaining
          rateLimit.value = data.rateLimit.limit
        }
      },
      // 流式结束：关闭流式状态，更新最终置信度
      onDone: (data) => {
        _patchAi(aiIndex, { streaming: false })
        if (data.profileConfidence !== undefined) profileConfidence.value = data.profileConfidence
        if (data.state) sessionState.value = data.state
        if (data.canMatch !== undefined) canMatch.value = data.canMatch
        // 首条消息后端会把会话标题从"新对话"改成摘要，前端本地同步
        const cur = sessions.value.find(s => s.id === currentSessionId.value)
        if (cur && cur.title === '新对话' && content.trim()) {
          cur.title = _deriveTitle(content.trim())
        }
      },
      // 出错：关闭流式，显示错误
      onError: (msg) => {
        _patchAi(aiIndex, { streaming: false })
        const cur = messages.value[aiIndex]
        if (cur && !cur.text) _patchAi(aiIndex, { text: '（出错了，请重试）' })
        error.value = msg
      },
    }, _streamController.signal)

    // 流式结束，清理临时状态
    _streamController = null
    streaming.value = false
    streamingText.value = ''
    streamingReasoning.value = ''
  }

  /**
   * stopGeneration() — 停止生成
   *
   * 用户点"停止生成"按钮时调。
   *   1. abort 掉 fetch（SSE 流断开，sse.js 的 catch 忽略 AbortError）
   *   2. 关闭当前 AI 消息的流式状态（光标消失，已生成内容保留）
   *   3. 重置 store 的流式标志
   */
  function stopGeneration() {
    if (_streamController) {
      _streamController.abort()
      _streamController = null
    }
    // 把最后一条 streaming 的 AI 消息标记为完成（保留已生成内容）
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'assistant' && messages.value[i].streaming) {
        _patchAi(i, { streaming: false })
        break
      }
    }
    streaming.value = false
  }

  function clearError() {
    error.value = ''
  }

  // 导出给组件用
  return {
    messages, visibleMessages, streaming, streamingText,
    profileConfidence, sessionState, canMatch,
    rateRemaining, rateLimit, error,
    sessions, currentSessionId,
    loadHistory, loadStatus, send, stopGeneration, clearError,
    loadSessions, ensureSession, createSession, switchSession, renameSession, deleteSession,
  }
})
