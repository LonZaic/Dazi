<template>
  <!-- ═══ 移动端汉堡按钮 ═══ -->
  <button class="hamburger-btn" @click="mobileOpen = !mobileOpen" title="菜单">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  </button>

  <!-- 移动端遮罩 -->
  <div :class="['sidebar-overlay', { show: mobileOpen }]" @click="mobileOpen = false"></div>

  <!-- ═══ 72px 窄侧边栏（DeepSeek-Super 风格）═══ -->
  <aside :class="['sidebar', { open: mobileOpen }]">
    <!-- Logo 区（保留原 logo-mark）-->
    <div class="sidebar-header">
      <div class="logo-mark" title="搭子匹配官">
        <AppIcon name="sparkles" :size="20" />
      </div>
    </div>

    <!-- 顶部导航图标列（无对话入口，对话管理已下沉到底部 dock）-->
    <nav class="nav-dock">
      <RouterLink to="/home/me" class="dock-btn" active-class="active" title="我的主页" @click="mobileOpen = false">
        <AppIcon name="user" :size="18" />
        <span class="dock-label">主页</span>
      </RouterLink>
      <RouterLink to="/profile" class="dock-btn" active-class="active" title="AI 画像详情" @click="mobileOpen = false">
        <AppIcon name="sparkles" :size="18" />
        <span class="dock-label">画像</span>
      </RouterLink>
      <RouterLink to="/match" class="dock-btn" active-class="active" title="智能匹配" @click="mobileOpen = false">
        <AppIcon name="heart" :size="18" />
        <span class="dock-label">匹配</span>
      </RouterLink>
      <RouterLink to="/dm" class="dock-btn" active-class="active" title="私信" @click="mobileOpen = false">
        <AppIcon name="message" :size="18" />
        <span class="dock-label">私信</span>
        <span v-if="dm.totalUnread > 0" class="dock-badge">{{ dm.totalUnread }}</span>
      </RouterLink>
      <RouterLink to="/privacy" class="dock-btn" active-class="active" title="隐私中心" @click="mobileOpen = false">
        <AppIcon name="shield" :size="18" />
        <span class="dock-label">隐私</span>
      </RouterLink>
    </nav>

    <!-- 间隔推到底部 -->
    <div class="sidebar-spacer"></div>

    <!-- ═══ 底部图标坞（对话管理 + 主题 + 用户）═══ -->
    <div class="sidebar-dock">
      <!-- 对话管理按钮（点击滑出面板）-->
      <button
        class="dock-btn"
        :class="{ active: convPanelOpen }"
        @click="convPanelOpen = !convPanelOpen"
        title="对话管理"
      >
        <AppIcon name="chat" :size="18" />
        <span class="dock-label">对话</span>
        <span v-if="chat.sessions.length" class="dock-badge">{{ chat.sessions.length }}</span>
      </button>

      <!-- 主题切换（暂留暗色，预留切换钩子）-->
      <button class="dock-btn" title="主题" @click="toggleTheme">
        <AppIcon name="moon" :size="18" />
        <span class="dock-label">主题</span>
      </button>

      <!-- 用户头像/退出 -->
      <button class="dock-btn" title="账户" @click="userMenuOpen = !userMenuOpen">
        <div class="avatar-mini">{{ initial }}</div>
        <span class="dock-label">我</span>
      </button>
    </div>

    <!-- ═══ 对话管理滑出面板（DeepSeek-Super 风格）═══ -->
    <transition name="conv-panel">
      <div v-if="convPanelOpen" class="conv-panel">
        <div class="conv-panel-header">
          <span class="conv-panel-title">对话管理</span>
          <button class="conv-panel-close" @click="convPanelOpen = false" title="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <!-- 新建对话按钮 -->
        <button class="btn-new-conv" @click="onNewConversation">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>新对话</span>
        </button>

        <!-- 搜索框 -->
        <div class="conv-search">
          <svg class="conv-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="1.8"/>
            <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
          <input v-model="searchQuery" class="conv-search-input" placeholder="搜索对话..." />
          <button v-if="searchQuery" class="conv-search-clear" @click="searchQuery = ''" title="清除">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <!-- 对话列表（搜索过滤）-->
        <div class="conv-panel-list">
          <div v-if="!filteredSessions.length" class="conv-empty">
            {{ searchQuery ? '未找到匹配的对话' : '暂无对话' }}
          </div>
          <div
            v-for="s in filteredSessions"
            :key="s.id"
            :class="['conv-item', { active: s.id === chat.currentSessionId }]"
            @click="onSelectSession(s.id)"
          >
            <span class="conv-title" :title="s.title || '新对话'">{{ s.title || '新对话' }}</span>
            <button class="btn-rename" @click.stop="onRename(s)" title="改名">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="btn-delete" @click.stop="onDelete(s)" title="删除">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-.867 12.142A2 2 0 0 1 16.138 20H7.862a2 2 0 0 1-1.995-1.858L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- 画像置信度小卡（底部）-->
        <div class="conv-panel-footer" v-if="auth.isLoggedIn">
          <div class="conf-label">画像置信度</div>
          <div class="conf-bar">
            <div class="conf-fill" :class="confClass" :style="{ width: pct + '%' }"></div>
          </div>
          <div class="conf-text">
            <span class="conf-pct" :class="confClass">{{ pct }}%</span>
            <span class="conf-hint">{{ hint }}</span>
          </div>
        </div>
      </div>
    </transition>

    <!-- ═══ 用户菜单浮层（退出登录）═══ -->
    <transition name="fade">
      <div v-if="userMenuOpen" class="user-menu" @click.stop>
        <div class="user-menu-header">
          <div class="avatar">{{ initial }}</div>
          <div class="user-info">
            <div class="user-name">{{ auth.displayName }}</div>
            <div class="user-id">@{{ auth.user?.username }}</div>
          </div>
        </div>
        <button class="user-menu-item danger" @click="onLogout">
          <AppIcon name="logout" :size="14" />
          <span>退出登录</span>
        </button>
      </div>
    </transition>
  </aside>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '../common/AppIcon.vue'
import { useAuthStore } from '../../stores/authStore.js'
import { useChatStore } from '../../stores/chatStore.js'
import { useDmStore } from '../../stores/dmStore.js'

const auth = useAuthStore()
const chat = useChatStore()
const dm = useDmStore()
const router = useRouter()

// ─── 本地 UI 状态 ───
const mobileOpen = ref(false)
const convPanelOpen = ref(false)
const userMenuOpen = ref(false)
const searchQuery = ref('')

// ─── 计算属性 ───
const initial = computed(() => (auth.displayName || 'U').charAt(0).toUpperCase())
const pct = computed(() => Math.round(chat.profileConfidence * 100))
const confClass = computed(() => {
  if (pct.value >= 65) return 'high'
  if (pct.value >= 40) return 'mid'
  return 'low'
})
const hint = computed(() => {
  if (pct.value >= 65) return '可以开始匹配了'
  if (pct.value >= 40) return '再聊几句更精准'
  return '去对话采集画像'
})

// 搜索过滤的会话列表
const filteredSessions = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return chat.sessions
  return chat.sessions.filter(s => (s.title || '新对话').toLowerCase().includes(q))
})

// ─── 事件处理 ───
function toggleTheme() {
  // 预留主题切换钩子（当前固定暗色）
  document.documentElement.toggleAttribute('data-theme-light', false)
}

async function onNewConversation() {
  await chat.createSession()
  convPanelOpen.value = false
  mobileOpen.value = false
  router.push('/chat')
}

async function onSelectSession(id) {
  await chat.switchSession(id)
  convPanelOpen.value = false
  mobileOpen.value = false
  router.push('/chat')
}

function onRename(s) {
  const newTitle = prompt('修改标题:', s.title || '')
  if (newTitle && newTitle.trim() && newTitle.trim() !== s.title) {
    chat.renameSession(s.id, newTitle.trim())
  }
}

async function onDelete(s) {
  if (!confirm(`确定删除「${s.title || '新对话'}」？`)) return
  await chat.deleteSession(s.id)
}

async function onLogout() {
  userMenuOpen.value = false
  await auth.logout()
  router.push('/login')
}

// 点击外部关闭用户菜单
function onDocClick(e) {
  const menu = document.querySelector('.user-menu')
  const btn = document.querySelector('.dock-btn:last-child')
  if (menu && !menu.contains(e.target) && !btn?.contains(e.target)) {
    userMenuOpen.value = false
  }
}

onMounted(() => {
  chat.loadStatus()
  chat.loadSessions()
  dm.loadRooms()
  setInterval(() => dm.loadRooms(), 30_000)
  document.addEventListener('click', onDocClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
})
</script>

<style scoped>
/* ═══ 72px 窄侧边栏（DeepSeek-Super 玻璃质感）═══ */
.sidebar {
  width: 72px;
  min-width: 72px;
  height: 100vh;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--bg2) 80%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  transition: transform 0.25s ease, background var(--dur-base);
  position: relative;
  z-index: 100;
}

.sidebar-header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid var(--border);
}
.logo-mark {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, var(--accent), var(--accent-hover));
  border-radius: var(--radius);
  color: white;
  box-shadow: var(--shadow-glow);
}

/* ─── 顶部导航图标列 ─── */
.nav-dock {
  padding: var(--space-3) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* ─── 通用 dock-btn（DeepSeek-Super 折叠侧栏样式）─── */
.dock-btn {
  position: relative;
  width: 56px;
  margin: 0 auto;
  height: 56px;
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--text3);
  transition: background .12s, color .12s;
  cursor: pointer;
  background: transparent;
}
.dock-btn:hover {
  background: var(--bg3);
  color: var(--text);
}
.dock-btn.active {
  background: transparent;
  color: var(--text);
}
.dock-btn.active::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}
.dock-label {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.3px;
  color: inherit;
}
.dock-badge {
  position: absolute;
  top: 6px;
  right: 8px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: var(--match-warm);
  color: white;
  font-size: 10px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sidebar-spacer { flex: 1; }

/* ─── 底部图标坞 ─── */
.sidebar-dock {
  padding: var(--space-3) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border-top: 1px solid var(--border);
}

.avatar-mini {
  width: 24px; height: 24px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent), var(--match-warm));
  color: white;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600;
  font-size: 11px;
}

/* ═══ 对话管理滑出面板（DeepSeek-Super 浮动玻璃卡）═══ */
.conv-panel {
  position: fixed;
  top: 12px;
  bottom: 12px;
  left: 80px;
  width: 320px;
  background: color-mix(in srgb, var(--bg2) 72%, transparent);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 18px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.40), 0 0 0 0.5px rgba(255,255,255,0.05) inset;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 99;
}
.conv-panel-header {
  height: 48px;
  padding: 0 16px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
}
.conv-panel-title {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.2px;
}
.conv-panel-close {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px;
  color: var(--text3);
  transition: all .15s;
}
.conv-panel-close:hover { background: rgba(255,255,255,0.08); color: var(--text); }

/* 新对话按钮（工具栏样式） */
.btn-new-conv {
  margin: 10px 14px;
  padding: 6px 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.04);
  color: var(--text2);
  font-size: 11px;
  font-weight: 500;
  transition: all var(--dur-fast) var(--ease-out);
  flex-shrink: 0;
}
.btn-new-conv:hover {
  background: rgba(255,255,255,0.10);
  color: var(--text);
  border-color: var(--border2);
}

/* 搜索框（DeepSeek-Super 内嵌式） */
.conv-search {
  position: relative;
  margin: 0 14px 10px;
  flex-shrink: 0;
}
.conv-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text3);
  pointer-events: none;
}
.conv-search-input {
  width: 100%;
  padding: 8px 28px 8px 32px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: rgba(0,0,0,0.20);
  color: var(--text);
  font-size: var(--fs-sm);
  font-family: inherit;
  outline: none;
  transition: all .15s;
  box-sizing: border-box;
}
.conv-search-input:focus {
  border-color: var(--accent);
  background: rgba(0,0,0,0.30);
}
.conv-search-input::placeholder { color: var(--text3); }
.conv-search-clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px;
  color: var(--text3);
}
.conv-search-clear:hover { background: rgba(255,255,255,0.08); color: var(--text); }

/* 对话列表 */
.conv-panel-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 6px 8px;
}
.conv-panel-list::-webkit-scrollbar { width: 4px; }
.conv-panel-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.10); border-radius: 4px; }

.conv-empty {
  padding: 32px 12px;
  text-align: center;
  color: var(--text3);
  font-size: var(--fs-sm);
}
.conv-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--text2);
  font-size: var(--fs-sm);
  font-weight: 300;
  cursor: pointer;
  transition: background .12s, color .12s;
}
.conv-item:hover { background: var(--bg3); color: var(--text); }
.conv-item.active { background: var(--bg3); color: var(--text); }
.conv-title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.btn-rename, .btn-delete {
  width: 22px; height: 22px;
  display: none;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--text3);
}
.conv-item:hover .btn-rename,
.conv-item:hover .btn-delete { display: flex; }
.btn-rename:hover { background: rgba(255,255,255,0.10); color: var(--text); }
.btn-delete:hover { background: var(--red-muted); color: var(--red); }

/* 底部置信度卡 */
.conv-panel-footer {
  padding: 12px 14px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.conf-label {
  font-size: var(--fs-xs);
  color: var(--text3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--space-2);
}
.conf-bar {
  height: 5px;
  background: rgba(255,255,255,0.06);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.conf-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width var(--dur-slow) var(--ease-out);
}
.conf-fill.high { background: linear-gradient(90deg, var(--green), #5fd97a); }
.conf-fill.mid { background: linear-gradient(90deg, var(--yellow), #e8b450); }
.conf-fill.low { background: linear-gradient(90deg, var(--text3), var(--border2)); }
.conf-text {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: var(--space-2);
}
.conf-pct { font-size: var(--fs-sm); font-weight: 600; }
.conf-pct.high { color: var(--green); }
.conf-pct.mid { color: var(--yellow); }
.conf-pct.low { color: var(--text3); }
.conf-hint { font-size: var(--fs-xs); color: var(--text3); }

/* ═══ 用户菜单 ═══ */
.user-menu {
  position: absolute;
  bottom: 16px;
  left: 76px;
  width: 220px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  z-index: 200;
}
.user-menu-header {
  padding: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}
.avatar {
  width: 32px; height: 32px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent-primary), var(--match-warm));
  color: white;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600;
  font-size: var(--fs-sm);
}
.user-info { flex: 1; min-width: 0; }
.user-name {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user-id {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}
.user-menu-item {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  text-align: left;
}
.user-menu-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.user-menu-item.danger:hover { background: var(--danger-soft); color: var(--danger); }

/* ═══ 移动端汉堡按钮 ═══ */
.hamburger-btn {
  display: none;
  position: fixed;
  top: var(--space-3);
  left: var(--space-3);
  width: 36px; height: 36px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  align-items: center;
  justify-content: center;
  z-index: 101;
}
.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 99;
}
.sidebar-overlay.show { display: block; }

/* ═══ 响应式：窄屏切换 ═══ */
@media (max-width: 768px) {
  .hamburger-btn { display: flex; }
  .sidebar {
    position: fixed;
    left: 0; top: 0;
    transform: translateX(-100%);
  }
  .sidebar.open { transform: translateX(0); }
  .conv-panel { left: 0; width: 100vw; max-width: 320px; }
}

/* ═══ 动画 ═══ */
.conv-panel-enter-active, .conv-panel-leave-active {
  transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s;
}
.conv-panel-enter-from, .conv-panel-leave-to {
  transform: translateX(-12px);
  opacity: 0;
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
