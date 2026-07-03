<template>
  <div class="ws-view">
    <!-- 顶栏：状态 + 控制按钮 -->
    <header class="ws-header">
      <div class="ws-title">
        <AppIcon name="zap" :size="20" />
        <div>
          <div class="t-name">WebSocket 实时测试</div>
          <div class="t-sub" :class="statusClass">{{ statusText }}</div>
        </div>
      </div>
      <div class="ws-controls">
        <span class="conn-info" v-if="connected">在线 {{ onlineUsers.length }} 人</span>
        <button class="btn" v-if="!connected" @click="onConnect">连接</button>
        <button class="btn btn-danger" v-else @click="onDisconnect">断开</button>
      </div>
    </header>

    <!-- 主体：左在线列表 + 右消息区 -->
    <div class="ws-body">
      <!-- 左：在线用户 -->
      <aside class="ws-sidebar">
        <div class="side-title">在线用户</div>
        <ul class="user-list">
          <li
            v-for="u in onlineUsers"
            :key="u.id"
            class="user-item"
            :class="{ 'is-me': u.id === me?.id, 'is-active': u.id === activePrivateId }"
            @click="openPrivate(u)"
          >
            <div class="u-avatar">{{ (u.name || '?').charAt(0).toUpperCase() }}</div>
            <div class="u-info">
              <div class="u-name">{{ u.name }}<span v-if="u.id === me?.id" class="u-me">（我）</span></div>
              <div class="u-id">@{{ u.id.slice(0, 8) }}</div>
            </div>
          </li>
          <li v-if="onlineUsers.length === 0" class="empty-hint">暂无在线用户</li>
        </ul>
        <div class="side-tip">点击用户发起私信（仅 ws 演示，不入库）</div>
      </aside>

      <!-- 右：消息区 -->
      <section class="ws-main">
        <!-- Tab 栏 -->
        <div class="tab-bar">
          <button
            class="tab"
            :class="{ active: activeTab === 'global' }"
            @click="activeTab = 'global'"
          >
            #全局聊天
          </button>
          <button
            v-for="p in privateTabs"
            :key="p.id"
            class="tab"
            :class="{ active: activeTab === p.id }"
            @click="activeTab = p.id"
          >
            <span class="tab-dot" :class="{ unread: p.unread }"></span>
            {{ p.name }}
            <span class="tab-close" @click.stop="closePrivate(p.id)">×</span>
          </button>
        </div>

        <!-- 消息列表 -->
        <div class="msg-list" ref="msgListRef">
          <template v-if="activeTab === 'global'">
            <div v-for="m in globalMsgs" :key="m.key" class="msg" :class="msgClass(m)">
              <div class="m-avatar">{{ (m.from.name || '?').charAt(0).toUpperCase() }}</div>
              <div class="m-content">
                <div class="m-meta">
                  <span class="m-name">{{ m.from.name }}<span v-if="m.from.id === me?.id" class="m-me">（我）</span></span>
                  <span class="m-time">{{ fmt(m.at) }}</span>
                </div>
                <div class="m-text">{{ m.text }}</div>
              </div>
            </div>
            <div v-if="globalMsgs.length === 0" class="empty-msg">还没有消息，发一条试试 👋</div>
          </template>
          <template v-else>
            <div v-for="m in privateMsgs(activeTab)" :key="m.key" class="msg" :class="msgClass(m, activeTab)">
              <div class="m-avatar">{{ (m.from.name || '?').charAt(0).toUpperCase() }}</div>
              <div class="m-content">
                <div class="m-meta">
                  <span class="m-name">{{ m.from.name }}<span v-if="m.from.id === me?.id" class="m-me">（我）</span></span>
                  <span class="m-time">{{ fmt(m.at) }}</span>
                </div>
                <div class="m-text">{{ m.text }}</div>
              </div>
            </div>
            <div v-if="privateMsgs(activeTab).length === 0" class="empty-msg">和 {{ privateName(activeTab) }} 的私信（仅 ws 演示）</div>
          </template>
        </div>

        <!-- 输入区 -->
        <div class="input-bar">
          <input
            class="input"
            v-model="draft"
            :placeholder="inputPlaceholder"
            :disabled="!connected"
            @keydown.enter.prevent="onSend"
            maxlength="2000"
          />
          <button class="btn btn-primary" :disabled="!connected || !draft.trim()" @click="onSend">
            <AppIcon name="send" :size="16" />
            发送
          </button>
        </div>
        <div class="input-hint">{{ serverError || 'Enter 发送 · 消息仅在 ws 连接内流转，不写数据库' }}</div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import AppIcon from '../components/common/AppIcon.vue'
import { wsClient } from '../ws/client.js'

const connected = ref(false)
const reconnectInfo = ref(null)
const onlineUsers = ref([])
const me = ref(null)
const globalMsgs = ref([])
const privateTabs = reactive([])   // [{ id, name, unread, msgs: [] }]
const activeTab = ref('global')
const draft = ref('')
const serverError = ref('')
const msgListRef = ref(null)

let offFns = []

onMounted(() => {
  offFns.push(wsClient.on('open', () => { connected.value = true; serverError.value = '' }))
  offFns.push(wsClient.on('close', () => { connected.value = false }))
  offFns.push(wsClient.on('error', () => { serverError.value = '连接异常，正在重连…' }))
  offFns.push(wsClient.on('reconnect', (info) => { reconnectInfo.value = info; serverError.value = `第 ${info.attempt} 次重连中（${info.delayMs}ms 后）` }))
  offFns.push(wsClient.on('server-error', (m) => { serverError.value = m.message || '服务器错误' }))

  offFns.push(wsClient.on('hello', (m) => { me.value = m.me }))
  offFns.push(wsClient.on('online', (users) => { onlineUsers.value = users }))
  offFns.push(wsClient.on('presence', (m) => {
    if (m.kind === 'join') {
      if (!onlineUsers.value.find(u => u.id === m.user.id)) {
        onlineUsers.value.push(m.user)
      }
    } else {
      onlineUsers.value = onlineUsers.value.filter(u => u.id !== m.user.id)
      // 关闭对应私信 tab
      const idx = privateTabs.findIndex(t => t.id === m.user.id)
      if (idx >= 0) privateTabs.splice(idx, 1)
      if (activeTab.value === m.user.id) activeTab.value = 'global'
    }
  }))

  offFns.push(wsClient.on('chat', (m) => {
    globalMsgs.value.push({ ...m, key: `g${m.at}-${Math.random().toString(36).slice(2, 6)}` })
    if (activeTab.value === 'global') nextTick(scrollToBottom)
  }))

  offFns.push(wsClient.on('private', (m) => {
    const otherId = m.from.id === me.value?.id ? m.to : m.from.id
    let tab = privateTabs.find(t => t.id === otherId)
    if (!tab) {
      const u = onlineUsers.value.find(u => u.id === otherId)
      tab = { id: otherId, name: u?.name || otherId.slice(0, 8), unread: false, msgs: [] }
      privateTabs.push(tab)
    }
    tab.msgs.push({ ...m, key: `p${m.at}-${Math.random().toString(36).slice(2, 6)}` })
    if (activeTab.value !== otherId) tab.unread = true
    else nextTick(scrollToBottom)
  }))

  // 自动连接
  wsClient.connect()
})

onBeforeUnmount(() => {
  offFns.forEach(off => off())
  offFns = []
  wsClient.disconnect()
})

const statusText = computed(() => {
  if (connected.value) return '已连接'
  if (reconnectInfo.value) return `重连中（第 ${reconnectInfo.value.attempt} 次）`
  return '未连接'
})
const statusClass = computed(() => connected.value ? 'ok' : 'warn')

const inputPlaceholder = computed(() => {
  if (!connected.value) return '未连接'
  if (activeTab.value === 'global') return '在全局聊天室说点什么…'
  return `私信给 ${privateName(activeTab.value)}`
})

function onConnect() { wsClient.connect() }
function onDisconnect() { wsClient.disconnect() }

function onSend() {
  const text = draft.value.trim()
  if (!text || !connected.value) return
  if (activeTab.value === 'global') {
    wsClient.sendChat(text)
  } else {
    wsClient.sendPrivate(activeTab.value, text)
  }
  draft.value = ''
}

function openPrivate(u) {
  if (u.id === me.value?.id) return
  let tab = privateTabs.find(t => t.id === u.id)
  if (!tab) {
    tab = { id: u.id, name: u.name, unread: false, msgs: [] }
    privateTabs.push(tab)
  }
  activeTab.value = u.id
  tab.unread = false
  nextTick(scrollToBottom)
}

function closePrivate(id) {
  const idx = privateTabs.findIndex(t => t.id === id)
  if (idx >= 0) privateTabs.splice(idx, 1)
  if (activeTab.value === id) activeTab.value = 'global'
}

function privateMsgs(id) {
  return privateTabs.find(t => t.id === id)?.msgs || []
}
function privateName(id) {
  return privateTabs.find(t => t.id === id)?.name || id.slice(0, 8)
}

function msgClass(m, tabId) {
  if (tabId) {
    return m.from.id === me.value?.id ? 'mine' : 'theirs'
  }
  return m.from.id === me.value?.id ? 'mine' : 'theirs'
}

function fmt(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function scrollToBottom() {
  const el = msgListRef.value
  if (el) el.scrollTop = el.scrollHeight
}
</script>

<style scoped>
.ws-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
}

.ws-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}
.ws-title { display: flex; align-items: center; gap: var(--space-3); color: var(--text-primary); }
.t-name { font-size: var(--fs-md); font-weight: 600; }
.t-sub { font-size: var(--fs-xs); color: var(--text-tertiary); margin-top: 2px; }
.t-sub.ok { color: var(--success); }
.t-sub.warn { color: var(--warning); }
.ws-controls { display: flex; align-items: center; gap: var(--space-3); }
.conn-info { font-size: var(--fs-xs); color: var(--text-tertiary); }

.ws-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.ws-sidebar {
  width: 220px;
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  padding: var(--space-3);
}
.side-title { font-size: var(--fs-xs); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.5px; padding: var(--space-2) var(--space-3); }
.user-list { list-style: none; margin: 0; padding: 0; flex: 1; overflow-y: auto; }
.user-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.user-item:hover { background: var(--bg-hover); }
.user-item.is-active { background: var(--accent-primary-soft); }
.user-item.is-me { cursor: default; opacity: 0.7; }
.user-item.is-me:hover { background: transparent; }
.u-avatar {
  width: 32px; height: 32px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent-primary), var(--match-warm));
  color: white;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600;
  font-size: var(--fs-sm);
  flex-shrink: 0;
}
.u-info { flex: 1; min-width: 0; }
.u-name { font-size: var(--fs-sm); color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.u-me { color: var(--text-tertiary); font-size: var(--fs-xs); }
.u-id { font-size: var(--fs-xs); color: var(--text-tertiary); }
.empty-hint { padding: var(--space-3); font-size: var(--fs-xs); color: var(--text-tertiary); text-align: center; }
.side-tip { padding: var(--space-2) var(--space-3); font-size: var(--fs-xs); color: var(--text-tertiary); line-height: 1.5; }

.ws-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg-base);
}

.tab-bar {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  overflow-x: auto;
}
.tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  background: transparent;
  white-space: nowrap;
  transition: all var(--dur-fast) var(--ease-out);
}
.tab:hover { background: var(--bg-hover); }
.tab.active { background: var(--accent-primary-soft); color: var(--accent-primary); }
.tab-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-tertiary); }
.tab-dot.unread { background: var(--match-warm); }
.tab-close { padding: 0 4px; color: var(--text-tertiary); border-radius: var(--radius-sm); }
.tab-close:hover { background: var(--danger-soft); color: var(--danger); }

.msg-list { flex: 1; overflow-y: auto; padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.msg { display: flex; gap: var(--space-3); max-width: 80%; }
.msg.mine { flex-direction: row-reverse; margin-left: auto; }
.m-avatar {
  width: 32px; height: 32px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent-primary), #6b83fe);
  color: white;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600;
  font-size: var(--fs-sm);
  flex-shrink: 0;
}
.msg.mine .m-avatar { background: linear-gradient(135deg, var(--match-warm), #ff8a5b); }
.m-content { display: flex; flex-direction: column; gap: 4px; }
.msg.mine .m-content { align-items: flex-end; }
.m-meta { display: flex; gap: var(--space-2); align-items: baseline; font-size: var(--fs-xs); color: var(--text-tertiary); }
.m-name { color: var(--text-secondary); font-weight: 500; }
.m-me { color: var(--text-tertiary); }
.m-text {
  padding: var(--space-2) var(--space-3);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  font-size: var(--fs-base);
  color: var(--text-primary);
  word-break: break-word;
}
.msg.mine .m-text { background: var(--accent-primary-soft); border-color: transparent; }
.empty-msg { margin: auto; color: var(--text-tertiary); font-size: var(--fs-sm); }

.input-bar {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}
.input {
  flex: 1;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--fs-base);
}
.input:focus { outline: none; border-color: var(--accent-primary); }
.input:disabled { opacity: 0.5; }
.input-hint { padding: 0 var(--space-4) var(--space-2); font-size: var(--fs-xs); color: var(--text-tertiary); }

.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  transition: all var(--dur-fast) var(--ease-out);
}
.btn:hover:not(:disabled) { background: var(--bg-hover); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent-primary); color: white; border-color: transparent; }
.btn-primary:hover:not(:disabled) { background: var(--accent-primary-hover, #4a6cf7); }
.btn-danger { color: var(--danger); border-color: var(--danger); }
.btn-danger:hover { background: var(--danger-soft); }
</style>
