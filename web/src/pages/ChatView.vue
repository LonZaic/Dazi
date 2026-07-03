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
            :user-initial="auth.displayName"
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
    <InputBar
      :is-running="chat.streaming"
      :rate-remaining="chat.rateRemaining"
      :rate-limit="chat.rateLimit"
      @send="onSend"
      @stop="chat.stopGeneration()"
    />
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '../components/common/AppIcon.vue'
import MessageBubble from '../components/MessageBubble.vue'
import InputBar from '../components/layout/InputBar.vue'
import { useChatStore } from '../stores/chatStore.js'
import { useAuthStore } from '../stores/authStore.js'
import { infoApi } from '../api/index.js'

const chat = useChatStore()
const auth = useAuthStore()
const router = useRouter()

const scrollRef = ref(null)
const llmOn = ref(true)

const suggestions = [
  '我周末喜欢爬山和摄影',
  '想找个一起学英语的搭子',
  '我比较内向，喜欢深度交流',
]

onMounted(async () => {
  // 多会话：先拉会话列表，确保有当前会话，再加载该会话消息
  await chat.loadSessions()
  await chat.ensureSession()
  // 关键：切页再切回时 store 的 messages/currentSessionId 仍在，
  // 不要重新 loadHistory 覆盖（否则切页回来对话"没了"）
  // 只在首次进入（messages 为空）或 currentSessionId 刚切换时才拉
  if (chat.messages.length === 0) {
    await chat.loadHistory()
  }
  await chat.loadStatus()
  try {
    const info = await infoApi.info()
    llmOn.value = info.llmEnabled
  } catch { /* */ }
  scrollToBottom()
})

watch(() => chat.messages.length, () => nextTick(scrollToBottom))
watch(() => chat.streamingText, () => nextTick(scrollToBottom), { flush: 'post' })

function scrollToBottom() {
  const el = scrollRef.value
  if (el) el.scrollTop = el.scrollHeight
}

async function onSend(payload) {
  // InputBar 传 { text, images }；兼容旧调用（字符串）
  const text = typeof payload === 'string' ? payload : payload.text
  const images = typeof payload === 'string' ? [] : (payload.images || [])
  await chat.send(text, images)
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
.slide-down-enter-from, .slide-down-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
