<template>
  <div class="dm-room-view">
    <!-- 顶栏 -->
    <header class="dm-header">
      <button class="back-btn" @click="goBack">
        <AppIcon name="chevron-left" :size="20" />
      </button>
      <button
        v-if="otherUserId"
        class="header-avatar"
        :style="otherAvatarUrl ? {} : { background: otherAvatarColor }"
        @click="goToOtherHome"
        :title="`查看 ${otherName} 的主页`"
      >
        <img v-if="otherAvatarUrl" :src="otherAvatarUrl" class="header-avatar-img" alt="" />
        <span v-else>{{ otherName.charAt(0).toUpperCase() }}</span>
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
        <div class="loading-tip" v-if="dm.loading">
          <div class="spinner small"></div>
          <span>加载消息中…</span>
        </div>

        <div class="welcome" v-else-if="dm.messages.length === 0">
          <div class="welcome-icon">
            <AppIcon name="sparkles" :size="28" />
          </div>
          <h3>打个招呼吧</h3>
          <p>你们已经匹配成功，发条消息认识一下</p>
        </div>

        <!-- 私信气泡：我发的→右边，对方回复→左边 -->
        <div
          class="dm-msg-row"
          :class="{ me: m.senderId === auth.user?.id, pending: m.pending }"
          v-for="m in dm.messages"
          :key="m.id"
        >
          <!-- 对方的头像（左边） -->
          <img
            v-if="m.senderId !== auth.user?.id && otherAvatarUrl"
            :src="otherAvatarUrl"
            class="dm-avatar"
            alt=""
          />
          <div
            v-else-if="m.senderId !== auth.user?.id"
            class="dm-avatar dm-avatar-initial"
            :style="{ background: otherAvatarColor }"
          >{{ otherName.charAt(0).toUpperCase() }}</div>
          <div class="dm-bubble">
            <!-- 文件卡片 -->
            <div v-if="m.files && m.files.length" class="dm-files">
              <div
                class="dm-file-card"
                v-for="(f, i) in m.files"
                :key="'f-' + i"
                @click="downloadFile(f)"
                :title="'点击下载 ' + f.name"
              >
                <AppIcon name="download" :size="14" />
                <span class="dm-file-name">{{ f.name }}</span>
                <span class="dm-file-size">{{ formatFileSize(f.size) }}</span>
              </div>
            </div>
            <!-- 图片网格（可点击放大） -->
            <div v-if="m.images && m.images.length" class="dm-images" :class="'dm-img-count-' + Math.min(m.images.length, 4)">
              <img
                v-for="(src, i) in m.images"
                :key="'img-' + i"
                :src="src"
                class="dm-image"
                loading="eager"
                @click.stop="previewImage(src)"
                @error="onDmImgError($event)"
              />
            </div>
            <div v-if="m.content" class="dm-bubble-text">{{ m.content }}</div>
          </div>
          <!-- 我的头像（右边） -->
          <img
            v-if="m.senderId === auth.user?.id && auth.avatarUrl"
            :src="auth.avatarUrl"
            class="dm-avatar"
            alt=""
          />
          <div
            v-else-if="m.senderId === auth.user?.id"
            class="dm-avatar dm-avatar-initial"
            :style="{ background: myInitialColor }"
          >{{ auth.displayName.charAt(0).toUpperCase() }}</div>
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

    <!-- 输入框 -->
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
const otherAvatarUrl = computed(() => route.query.avatar || '')
const otherAvatarColor = computed(() => route.query.avatarColor || '#6366f1')
const myInitialColor = computed(() => auth.avatarColor || '#6366f1')
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

watch(() => dm.messages.length, () => nextTick(scrollToBottom))
watch(() => dm.messages[dm.messages.length - 1]?.content, () => nextTick(scrollToBottom), { flush: 'post' })

function scrollToBottom() {
  const el = scrollRef.value
  if (el) el.scrollTop = el.scrollHeight
}

async function onSend(payload) {
  const text = typeof payload === 'string' ? payload : (payload?.text ?? '')
  const images = typeof payload === 'string' ? [] : (payload?.images || [])
  const files = typeof payload === 'string' ? [] : (payload?.files || [])
  if (!text.trim() && images.length === 0 && files.length === 0) return
  await dm.sendMessage({ text, images, files })
  nextTick(scrollToBottom)
}

function previewImage(src) {
  if (!src) return
  window.open(src, '_blank')
}

function downloadFile(f) {
  if (!f) return
  // 如果有文本内容 → 创建 Blob 下载
  if (f.content) {
    const blob = new Blob([f.content], { type: f.type || 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = f.name || 'file'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    return
  }
  // 没有内容 → 尝试通过 API 下载（或文件名提示）
  alert('文件 "' + f.name + '" 仅存储了名称信息，无法下载内容。')
}

function formatFileSize(bytes) {
  if (!bytes || bytes < 1024) return (bytes || 0) + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

function onDmImgError(e) {
  const img = e.target
  if (img) {
    img.style.background = 'var(--bg-hover, #333)'
    img.style.minHeight = '48px'
  }
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
  display: flex; align-items: center; gap: var(--space-3);
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
.back-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
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
  overflow: hidden;
}
.header-avatar-img {
  width: 100%; height: 100%;
  object-fit: cover;
}
.header-avatar:hover {
  transform: scale(1.06);
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4);
}
.header-info { flex: 1; min-width: 0; }
.header-name {
  font-size: var(--fs-md); font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.header-name.clickable { cursor: pointer; transition: color .2s; }
.header-name.clickable:hover { color: var(--accent, #8b5cf6); }
.header-status {
  display: flex; align-items: center; gap: var(--space-1);
  font-size: var(--fs-xs); color: var(--text-tertiary); margin-top: 2px;
}
.status-dot { width: 6px; height: 6px; border-radius: 50%; }
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
  display: flex; align-items: center; justify-content: center;
  gap: var(--space-2); padding: var(--space-6);
  color: var(--text-tertiary); font-size: var(--fs-sm);
}
.spinner {
  border: 2px solid var(--border-default);
  border-top-color: var(--accent-primary);
  border-radius: 50%; animation: spin 0.7s linear infinite;
}
.spinner.small { width: 14px; height: 14px; }
@keyframes spin { to { transform: rotate(360deg); } }

.welcome {
  text-align: center; padding: var(--space-12) var(--space-4);
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
.welcome h3 { color: var(--text-primary); font-size: var(--fs-md); margin: 0 0 var(--space-1); }
.welcome p { font-size: var(--fs-sm); margin: 0; }

/* ─── 私信气泡 ─── */
.dm-msg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: var(--space-3);
  max-width: 82%;
}
/* 我发的 → 右边 */
.dm-msg-row.me {
  margin-left: auto;
  justify-content: flex-end;
}
/* 对方发的 → 左边 */
.dm-msg-row:not(.me) {
  margin-right: auto;
  justify-content: flex-start;
}
/* ─── 头像 ─── */
.dm-avatar {
  width: 32px; height: 32px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.dm-avatar-initial {
  width: 32px; height: 32px;
  border-radius: 50%;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.dm-bubble {
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
  position: relative;
}
/* 我的气泡：蓝色主题（右边），和 AI 对话用户气泡外观一致 */
.dm-msg-row.me .dm-bubble {
  background: var(--accent, #5b8def);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.1);
}
/* 对方的气泡：浅灰 + 边框（左边），和 AI 对话用户气泡外观一致 */
.dm-msg-row:not(.me) .dm-bubble {
  background: var(--bg-elevated, #f5f5f5);
  color: var(--text-primary);
  border: 1px solid var(--border-subtle, #e5e5e5);
}
.dm-msg-row.pending .dm-bubble {
  opacity: 0.6;
}
.dm-bubble-text {
  white-space: pre-wrap;
}

/* ─── DM 图片网格 ─── */
.dm-images {
  display: grid;
  gap: 4px;
  margin-bottom: 6px;
}
.dm-images.dm-img-count-1 { grid-template-columns: 120px; }
.dm-images.dm-img-count-2 { grid-template-columns: repeat(2, 80px); }
.dm-images.dm-img-count-3 { grid-template-columns: repeat(3, 64px); }
.dm-images.dm-img-count-4 { grid-template-columns: repeat(2, 90px); }

.dm-image {
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid rgba(255,255,255,0.2);
  background: var(--bg-hover, #333);
  transition: transform 0.15s ease;
}
.dm-image:hover { transform: scale(1.06); }

/* ─── DM 文件卡片 ─── */
.dm-files {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
}
.dm-file-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255,255,255,0.12);
  cursor: pointer;
  transition: background 0.15s;
  color: inherit;
  font-size: 12px;
}
.dm-file-card:hover {
  background: rgba(255,255,255,0.22);
}
.dm-file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.dm-file-size {
  opacity: 0.7;
  flex-shrink: 0;
}

.error-bar {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--danger-soft); color: var(--danger);
  font-size: var(--fs-sm); border-top: 1px solid var(--danger);
}
.error-bar button {
  margin-left: auto; padding: 2px var(--space-2);
  font-size: var(--fs-xs); color: var(--danger);
}
.slide-down-enter-active, .slide-down-leave-active {
  transition: all var(--dur-fast) var(--ease-out);
}
.slide-down-enter-from, .slide-down-leave-to {
  opacity: 0; transform: translateY(-8px);
}
</style>
