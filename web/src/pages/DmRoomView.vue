<template>
  <div class="dm-room-view">
    <!-- 顶栏：返回 + 对方头像（可点） + 对方名字（可点） + 连接状态 -->
    <header class="dm-header">
      <button class="back-btn" @click="goBack">
        <AppIcon name="chevron-left" :size="20" />
      </button>
      <button
        v-if="otherUserId"
        class="header-avatar"
        @click="goToOtherHome"
        :title="`查看 ${otherName} 的主页`"
      >
        {{ otherName.charAt(0).toUpperCase() }}
      </button>
      <div class="header-info">
        <div class="header-name" :class="{ clickable: otherUserId }" @click="goToOtherHome">
          {{ otherName }}
        </div>
        <div class="header-status">
          <span class="status-dot" :class="dm.connected ? 'on' : 'off'"></span>
          <span>{{ dm.connected ? '已连接' : '连接中…' }}</span>
        </div>
      </div>
    </header>

    <!-- 消息列表 -->
    <div class="messages-scroll" ref="scrollRef">
      <div class="messages-inner">
        <!-- 加载中 -->
        <div class="loading-tip" v-if="dm.loading">
          <div class="spinner small"></div>
          <span>加载消息中…</span>
        </div>

        <!-- 空状态 -->
        <div class="welcome" v-else-if="dm.messages.length === 0">
          <div class="welcome-icon">
            <AppIcon name="sparkles" :size="28" />
          </div>
          <h3>打个招呼吧</h3>
          <p>你们已经匹配成功，发条消息认识一下</p>
        </div>

        <!-- 消息气泡（复用 MessageBubble，统一风格） -->
        <div class="msg-row" v-for="m in dm.messages" :key="m.id">
          <MessageBubble
            :role="m.senderId === auth.user?.id ? 'user' : 'assistant'"
            :text="m.content"
            :streaming="false"
            :created-at="m.createdAt"
            :user-initial="otherName"
          />
        </div>
        <div style="height: 16px"></div>
      </div>
    </div>

    <!-- 错误条 -->
    <transition name="slide-down">
      <div class="error-bar" v-if="dm.error">
        <AppIcon name="x" :size="14" />
        <span>{{ dm.error }}</span>
        <button @click="dm.clearError()">关闭</button>
      </div>
    </transition>

    <!-- 输入框（复用 InputBar） -->
    <InputBar
      :is-running="dm.sending"
      :placeholder="`给 ${otherName} 发消息...`"
      :rate-remaining="0"
      :rate-limit="0"
      @send="onSend"
    />
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '../components/common/AppIcon.vue'
import MessageBubble from '../components/MessageBubble.vue'
import InputBar from '../components/layout/InputBar.vue'
import { useDmStore } from '../stores/dmStore.js'
import { useAuthStore } from '../stores/authStore.js'

const route = useRoute()
const router = useRouter()
const dm = useDmStore()
const auth = useAuthStore()

const scrollRef = ref(null)

const otherName = computed(() => route.query.name || '对方')
const otherUserId = computed(() => route.query.uid || '')
const roomId = computed(() => route.params.roomId)

function goToOtherHome() {
  if (!otherUserId.value) return
  router.push(`/home/${otherUserId.value}`)
}

onMounted(async () => {
  await dm.openRoom(roomId.value, {
    id: route.query.uid,
    displayName: otherName.value,
  })
  nextTick(scrollToBottom)
})

onUnmounted(() => {
  dm.closeRoom()
})

// 消息列表变化时自动滚到底
watch(() => dm.messages.length, () => nextTick(scrollToBottom))
watch(() => dm.messages[dm.messages.length - 1]?.content, () => nextTick(scrollToBottom), { flush: 'post' })

function scrollToBottom() {
  const el = scrollRef.value
  if (el) el.scrollTop = el.scrollHeight
}

async function onSend(payload) {
  const text = typeof payload === 'string' ? payload : (payload?.text ?? '')
  if (!text) return
  await dm.sendMessage(text)
  nextTick(scrollToBottom)
}

function goBack() {
  router.push('/dm')
}
</script>

<style scoped>
.dm-room-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-base);
}
.dm-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-base);
  flex-shrink: 0;
}
.back-btn {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
}
.back-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.header-avatar {
  width: 36px; height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent, #8b5cf6), #6366f1);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  border: none;
  transition: transform .2s, box-shadow .2s;
  flex-shrink: 0;
}
.header-avatar:hover {
  transform: scale(1.06);
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4);
}
.header-info { flex: 1; min-width: 0; }
.header-name {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-name.clickable {
  cursor: pointer;
  transition: color .2s;
}
.header-name.clickable:hover {
  color: var(--accent, #8b5cf6);
}
.header-status {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  margin-top: 2px;
}
.status-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
}
.status-dot.on { background: var(--success); }
.status-dot.off { background: var(--text-tertiary); }

.messages-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4) 0;
}
.messages-inner {
  max-width: var(--max-content);
  margin: 0 auto;
  padding: 0 var(--space-5);
}

.loading-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  color: var(--text-tertiary);
  font-size: var(--fs-sm);
}
.spinner {
  border: 2px solid var(--border-default);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.spinner.small { width: 14px; height: 14px; }
@keyframes spin { to { transform: rotate(360deg); } }

.welcome {
  text-align: center;
  padding: var(--space-12) var(--space-4);
  color: var(--text-tertiary);
}
.welcome-icon {
  width: 56px; height: 56px;
  margin: 0 auto var(--space-3);
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-primary-soft);
  color: var(--accent-primary);
  border-radius: var(--radius-lg);
}
.welcome h3 {
  color: var(--text-primary);
  font-size: var(--fs-md);
  margin: 0 0 var(--space-1);
}
.welcome p { font-size: var(--fs-sm); margin: 0; }

.msg-row { margin-bottom: var(--space-3); }

.error-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-sm);
  border-top: 1px solid var(--danger);
}
.error-bar button {
  margin-left: auto;
  padding: 2px var(--space-2);
  font-size: var(--fs-xs);
  color: var(--danger);
}
.slide-down-enter-active, .slide-down-leave-active {
  transition: all var(--dur-fast) var(--ease-out);
}
.slide-down-enter-from, .slide-down-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
