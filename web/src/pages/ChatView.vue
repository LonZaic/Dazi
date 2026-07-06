<template>
  <div class="chat-view">
    <div class="chat-main">
    <!-- 顶栏 -->
    <header class="chat-header">
      <div class="header-left">
        <h2 class="header-title">对话采集</h2>
        <span class="header-tag" v-if="llmOn">AI 模式</span>
        <span class="header-tag tag-fallback" v-else>规则模式</span>
      </div>
      <div class="header-right">
        <button class="match-cta" :class="{ ready: chat.canMatch }" @click="goMatch">
          <AppIcon name="heart" :size="16" />
          <span>{{ chat.canMatch ? '开始匹配' : '聊够再匹配' }}</span>
        </button>
      </div>
    </header>

    <!-- 消息列表 -->
    <div class="messages-scroll" ref="scrollRef">
      <div class="messages-inner">
        <!-- 空状态 -->
        <div class="welcome" v-if="chat.messages.length === 0">
          <div class="welcome-icon">
            <AppIcon name="sparkles" :size="32" />
          </div>
          <h3>开始聊聊，AI 帮你画像</h3>
          <p>不用填表单，像朋友一样聊天。系统会从对话中理解你的兴趣、社交风格和找搭子目标。</p>
          <div class="suggest-row">
            <button class="suggest-chip" v-for="s in suggestions" :key="s" @click="useSuggest(s)">{{ s }}</button>
          </div>
        </div>

        <div class="msg-row" v-for="m in chat.visibleMessages" :key="m.id">
          <MessageBubble
            :role="m.role"
            :text="m.text"
            :reasoning="m.reasoning"
            :streaming="m.streaming"
            :created-at="m.createdAt"
            :images="m.images"
            :files="m.files"
            :user-avatar="auth.avatarUrl"
            :user-initial="auth.displayName"
            :avatar-color="auth.avatarColor"
          />
        </div>
        <div style="height: 16px"></div>
      </div>
    </div>

    <!-- 错误条 -->
    <transition name="slide-down">
      <div class="error-bar" v-if="chat.error">
        <AppIcon name="x" :size="14" />
        <span>{{ chat.error }}</span>
        <button @click="chat.clearError()">关闭</button>
      </div>
    </transition>

    <!-- 输入 -->
    <div class="input-toolbar">
      <button
        class="think-toggle"
        :class="{ active: chat.deepThinking }"
        @click="chat.deepThinking = !chat.deepThinking"
        title="开启后 AI 会深度思考再回答"
      >
        <AppIcon name="sparkles" :size="14" />
        <span>深度思考</span>
      </button>
    </div>
    <InputBar
      :is-running="chat.streaming"
      :rate-remaining="chat.rateRemaining"
      :rate-limit="chat.rateLimit"
      @send="onSend"
      @stop="chat.stopGeneration()"
    />
    </div>

    <!-- 右侧推荐面板：边聊边推荐 -->
    <aside class="chat-sidebar" :class="{ open: sidebarOpen, glow: sidebarGlow }">
      <button class="sidebar-toggle" @click="onToggleSidebar()" title="推荐">
        <AppIcon name="heart" :size="18" />
      </button>
      <template v-if="sidebarOpen">
        <div class="sidebar-hint" v-if="!candidates.length && !matchLoading">
          <p>聊几句后这里会自动推荐合适的搭子</p>
        </div>
        <div class="sidebar-loading" v-else-if="matchLoading">
          <div class="spinner small"></div>
          <span>推荐中...</span>
        </div>
        <div class="candidate-list" v-else>
          <div class="candidate-item" v-for="c in candidates.slice(0, 5)" :key="c.userId">
            <div class="cand-name">{{ c.displayName }}</div>
            <div class="cand-score">{{ Math.round(c.score * 100) }}%</div>
            <div class="cand-interests" v-if="c.commonInterests?.length">
              <span class="tag" v-for="t in c.commonInterests.slice(0, 2)" :key="t">{{ t }}</span>
            </div>
          </div>
          <button class="go-match-btn" @click="router.push('/match')">查看全部匹配</button>
        </div>
      </template>
    </aside>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '../components/common/AppIcon.vue'
import MessageBubble from '../components/MessageBubble.vue'
import InputBar from '../components/layout/InputBar.vue'
import { useChatStore } from '../stores/chatStore.js'
import { useAuthStore } from '../stores/authStore.js'
import { useMatchStore } from '../stores/matchStore.js'
import { useProfileStore } from '../stores/profileStore.js'
import { infoApi } from '../api/index.js'
import { ocrForContext } from '../utils/ocr.js'

const chat = useChatStore()
const auth = useAuthStore()
const match = useMatchStore()
const profile = useProfileStore()
const router = useRouter()

const scrollRef = ref(null)
const llmOn = ref(true)
const sidebarOpen = ref(false)
const sidebarGlow = ref(false)
const candidates = ref([])
const matchLoading = ref(false)
let pollTimer = null
let lastConfidence = 0

function onToggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
  // 展开时立即停止发光
  if (sidebarOpen.value && sidebarGlow.value) {
    sidebarGlow.value = false
  }
}

// ★ 边聊边推荐：每 10 秒检测画像变化，自动拉匹配候选
function startRecommendPoll() {
  stopRecommendPoll()
  pollTimer = setInterval(() => checkRecommend(), 10_000)
}
function stopRecommendPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

// 执行一次推荐检测
async function checkRecommend() {
  if (matchLoading.value) return
  try {
    await profile.load()
    const hasProfile = !!profile.profile && profile.profile.interests?.length > 0
    if (!hasProfile) return
    if (Math.abs(profile.confidence - lastConfidence) > 0.02) {
      matchLoading.value = true
      const res = await match.run()
      candidates.value = res?.candidates || []
      lastConfidence = profile.confidence
      match.lastConfidence = profile.confidence
      if (candidates.value.length > 0 && !sidebarOpen.value) {
        sidebarGlow.value = true
        setTimeout(() => { sidebarGlow.value = false }, 5000)
      }
      matchLoading.value = false
    }
  } catch { /* */ }
}

const suggestions = [
  '我周末喜欢爬山和摄影',
  '想找个一起学英语的搭子',
  '我比较内向，喜欢深度交流',
]

onMounted(async () => {
  // 多会话：先拉会话列表，确保有当前会话，再加载该会话消息
  await chat.loadSessions()
  await chat.ensureSession()
  if (chat.messages.length === 0) {
    await chat.loadHistory()
  }
  await chat.loadStatus()
  try {
    const info = await infoApi.info()
    llmOn.value = info.llmEnabled
  } catch { /* */ }
  scrollToBottom()
  // 立即检测一次推荐
  checkRecommend()
  startRecommendPoll()
})

onUnmounted(() => {
  stopRecommendPoll()
})

watch(() => chat.messages.length, () => nextTick(scrollToBottom))
watch(() => chat.streamingText, () => nextTick(scrollToBottom), { flush: 'post' })

function scrollToBottom() {
  const el = scrollRef.value
  if (el) el.scrollTop = el.scrollHeight
}

async function onSend(payload) {
  // InputBar 传 { text, images, files }；兼容旧调用（字符串）
  const text = typeof payload === 'string' ? payload : (payload.text || '')
  const images = typeof payload === 'string' ? [] : (payload.images || [])
  const files = typeof payload === 'string' ? [] : (payload.files || [])

  // ★ 1. 立即显示用户泡泡（图片/文件秒出现，不等 OCR）
  const imageDataUrls = images.map(i => i.data).filter(Boolean)
  const filesMeta = files.map(f => ({ name: f.name, size: f.size || 0 }))
  chat.pushUserMsg(text, imageDataUrls, filesMeta)
  scrollToBottom()
  await nextTick()  // 强制浏览器先渲染泡泡，再跑 OCR

  // ★ 2. OCR 后台运行（不阻塞 UI）
  let ocrContext = ''
  if (images.length > 0) {
    const ocrResults = await Promise.all(
      images.map(img => ocrForContext(img.data, img.name))
    )
    ocrContext = ocrResults.filter(Boolean).join('\n')
  }

  // 合并：文字 + OCR结果
  const finalText = [
    text,
    ocrContext ? `\n---\n图片识别内容:\n${ocrContext}` : '',
  ].filter(Boolean).join('\n')

  // 文件内容直接传给后端，供 AI read_file 工具调用
  const fileContents = files.map(f => ({
    name: f.name,
    content: f.content || '',
    size: f.size || 0,
  }))

  // ★ 3. 发到服务器（不重复推用户消息）
  await chat.sendStream(finalText, images.length, fileContents)
  await chat.loadStatus()
  scrollToBottom()
}

function useSuggest(s) {
  onSend(s)
}

function goMatch() {
  if (chat.canMatch) router.push('/match')
}
</script>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: row;
  height: 100vh;
  background: var(--bg-base);
  position: relative;
}
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;   /* 允许收缩，避免内容撑爆侧栏 */
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-base);
  flex-shrink: 0;
}
.header-left { display: flex; align-items: center; gap: var(--space-3); }
.header-title { font-size: var(--fs-lg); font-weight: 600; color: var(--text-primary); }
.header-tag {
  font-size: var(--fs-xs);
  padding: 2px var(--space-2);
  background: var(--accent-primary-soft);
  color: var(--accent-primary);
  border-radius: var(--radius-full);
  font-weight: 500;
}
.header-tag.tag-fallback {
  background: var(--warning-soft);
  color: var(--warning);
}

.match-cta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--bg-hover);
  color: var(--text-tertiary);
  font-size: var(--fs-sm);
  border: 1px solid var(--border-default);
  transition: all var(--dur-fast) var(--ease-out);
}
.match-cta.ready {
  background: linear-gradient(135deg, var(--accent-primary), var(--match-warm));
  color: white;
  border-color: transparent;
  box-shadow: var(--shadow-glow);
}
.match-cta.ready:hover {
  transform: translateY(-1px);
}

/* ─── 深度思考开关 ─── */
.input-toolbar {
  display: flex;
  justify-content: flex-start;
  max-width: var(--max-content);
  margin: 0 auto;
  width: 100%;
  padding: 6px var(--space-5) 0;
}
.think-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  color: var(--text2);
  border: 1px solid var(--border);
  background: var(--bg2);
  cursor: pointer;
  transition: all .15s;
}
.think-toggle:hover { border-color: var(--accent); color: var(--text); }
.think-toggle.active {
  background: var(--accent-muted);
  border-color: var(--accent);
  color: var(--accent);
}

.messages-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4) 0;
}
.messages-inner {
  min-height: 100%;
  max-width: var(--max-content);
  margin: 0 auto;
  padding: 0 var(--space-5);
  display: flex;
  flex-direction: column;
}
.msg-row {
  width: 100%;
}

.welcome {
  max-width: var(--max-content);
  margin: 0 auto;
  padding: var(--space-12) var(--space-6);
  text-align: center;
}
.welcome-icon {
  width: 64px; height: 64px;
  margin: 0 auto var(--space-4);
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-primary-soft);
  border-radius: var(--radius-xl);
  color: var(--accent-primary);
}
.welcome h3 { font-size: var(--fs-xl); color: var(--text-primary); margin-bottom: var(--space-2); }
.welcome p { color: var(--text-secondary); font-size: var(--fs-md); max-width: 440px; margin: 0 auto var(--space-5); }
.suggest-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: center;
}
.suggest-chip {
  padding: var(--space-2) var(--space-4);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-full);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  transition: all var(--dur-fast) var(--ease-out);
}
.suggest-chip:hover {
  background: var(--accent-primary-soft);
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}

.error-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 var(--space-5) var(--space-2);
  max-width: var(--max-content);
  margin-left: auto;
  margin-right: auto;
  padding: var(--space-2) var(--space-4);
  background: var(--danger-soft);
  color: var(--danger);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
}
.error-bar button { margin-left: auto; color: var(--danger); font-size: var(--fs-xs); }

.slide-down-enter-active, .slide-down-leave-active {
  transition: all var(--dur-base) var(--ease-out);
}

/* 右侧推荐面板 */
.chat-sidebar {
  width: 42px;
  flex-shrink: 0;
  border-left: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  display: flex;
  flex-direction: column;
  transition: width var(--dur-base) var(--ease-out);
  overflow: hidden;
  position: relative;
}
.chat-sidebar.open {
  width: 240px;
}
.chat-sidebar.glow {
  border-left: 2px solid var(--accent-primary);
  animation: sidebar-glow 1s ease-in-out infinite alternate;
}
@keyframes sidebar-glow {
  from { box-shadow: inset 0 0 8px rgba(59, 130, 246, 0.15); }
  to   { box-shadow: inset 0 0 18px rgba(59, 130, 246, 0.4); }
}

.sidebar-toggle {
  display: flex; align-items: center; justify-content: center;
  width: 42px; height: 48px;
  cursor: pointer;
  color: var(--accent-primary);
  background: none;
  border: none;
  border-radius: 0;
  flex-shrink: 0;
  transition: color var(--dur-fast);
}
.chat-sidebar.open .sidebar-toggle {
  width: 100%;
  justify-content: flex-end;
  padding-right: var(--space-4);
}
.sidebar-toggle:hover { color: var(--accent-primary-hover); background: var(--bg-hover); }
.sidebar-hint {
  padding: var(--space-6) var(--space-3);
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  line-height: 1.5;
}
.sidebar-loading {
  display: flex; align-items: center; justify-content: center; gap: var(--space-2);
  padding: var(--space-4);
  font-size: var(--fs-xs); color: var(--text-tertiary);
}
.spinner.small {
  width: 14px; height: 14px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.candidate-list {
  display: flex; flex-direction: column;
  padding: var(--space-2);
  gap: 1px;
  overflow-y: auto;
}
.candidate-item {
  padding: var(--space-3) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}
.candidate-item:hover { background: var(--bg-hover); }
.cand-name {
  font-size: var(--fs-sm); font-weight: 500; color: var(--text-primary);
}
.cand-score {
  font-size: var(--fs-xs); color: var(--accent-primary); font-weight: 600;
}
.cand-interests {
  display: flex; gap: 4px; margin-top: 2px;
}
.tag {
  font-size: 10px; padding: 1px 6px;
  background: var(--accent-primary-soft);
  color: var(--accent-primary);
  border-radius: var(--radius-full);
}
.go-match-btn {
  margin-top: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--accent-primary);
  color: white;
  font-size: var(--fs-xs);
  font-weight: 500;
  text-align: center;
}
.go-match-btn:hover { background: var(--accent-primary-hover); }

.slide-down-enter-from, .slide-down-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
