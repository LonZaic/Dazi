<template>
  <div class="dm-list-view">
    <header class="page-header">
      <div>
        <h2 class="page-title">私信</h2>
        <p class="page-subtitle">和匹配成功的搭子 1 对 1 聊天</p>
      </div>
      <button class="refresh-btn" @click="dm.loadRooms()">
        <AppIcon name="refresh" :size="16" />
        <span>刷新</span>
      </button>
    </header>

    <div class="dm-body">
      <!-- 空状态 -->
      <div class="empty-state card" v-if="!dm.loading && dm.rooms.length === 0">
        <AppIcon name="chat" :size="40" />
        <h3>还没有私信</h3>
        <p>去"智能匹配"页，匹配成功后可以给对方发私信</p>
        <RouterLink to="/match" class="btn btn-primary">
          <AppIcon name="heart" :size="16" />
          去匹配
        </RouterLink>
      </div>

      <!-- 加载中 -->
      <div class="loading-state" v-else-if="dm.loading">
        <div class="spinner"></div>
      </div>

      <!-- 房间列表 -->
      <div class="room-list" v-else>
        <div
          class="room-item card"
          v-for="room in dm.rooms"
          :key="room.roomId"
        >
          <div class="avatar clickable" @click.stop="goToUser(room.otherUserId)">{{ initial(room.otherDisplayName) }}</div>
          <div class="room-main" @click="enterRoom(room)">
            <div class="room-top">
              <span class="room-name">
                {{ room.otherDisplayName }}
              </span>
              <span class="room-time">{{ formatTime(room.lastMessageAt) }}</span>
            </div>
            <div class="room-bottom">
              <span class="room-preview" :class="{ unread: room.unreadCount > 0 }">
                {{ room.lastContent || '还没有消息，去打个招呼吧' }}
              </span>
              <span class="unread-badge" v-if="room.unreadCount > 0">{{ room.unreadCount }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '../components/common/AppIcon.vue'
import { useDmStore } from '../stores/dmStore.js'

const dm = useDmStore()
const router = useRouter()

onMounted(() => {
  dm.loadRooms()
})

function initial(name) {
  return (name || 'U').charAt(0).toUpperCase()
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    // 今天：HH:MM
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  // 非今天：MM-DD
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function enterRoom(room) {
  router.push({
    name: 'dm-room',
    params: { roomId: room.roomId },
    query: { name: room.otherDisplayName, uid: room.otherUserId, avatar: room.otherAvatarUrl || '', avatarColor: room.otherAvatarColor || '#6366f1' },
  })
}

function goToUser(userId) {
  if (userId) router.push(`/home/${userId}`)
}
</script>

<style scoped>
.dm-list-view {
  height: 100vh;
  overflow-y: auto;
  background: var(--bg-base);
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: var(--space-5) var(--space-8);
  border-bottom: 1px solid var(--border-subtle);
  position: sticky;
  top: 0;
  background: var(--bg-base);
  z-index: 5;
}
.page-title { font-size: var(--fs-xl); font-weight: 600; color: var(--text-primary); margin: 0; }
.page-subtitle { font-size: var(--fs-sm); color: var(--text-tertiary); margin: 4px 0 0; }
.refresh-btn {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.refresh-btn:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}

.dm-body {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--space-5) var(--space-6) var(--space-12);
}

.empty-state.card {
  margin-top: var(--space-12);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  text-align: center;
  color: var(--text-tertiary);
}
.empty-state h3 { color: var(--text-primary); margin: 0; }
.empty-state .btn { margin-top: var(--space-3); }

.loading-state {
  display: flex;
  justify-content: center;
  padding-top: var(--space-12);
}
.spinner {
  width: 28px; height: 28px;
  border: 3px solid var(--border-default);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.room-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.room-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.room-item:hover {
  border-color: var(--accent-primary);
  background: var(--accent-primary-soft);
}
.avatar {
  width: 44px; height: 44px;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--accent-primary), var(--match-warm));
  color: white;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600;
  font-size: var(--fs-md);
  flex-shrink: 0;
}
.avatar.clickable { cursor: pointer; }
.avatar.clickable:hover { opacity: 0.85; transform: scale(1.05); transition: all .15s; }
.room-main { flex: 1; min-width: 0; }
.room-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 4px;
}
.room-name {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.room-time { font-size: var(--fs-xs); color: var(--text-tertiary); flex-shrink: 0; }
.room-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
}
.room-preview {
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.room-preview.unread { color: var(--text-primary); font-weight: 500; }
.unread-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  background: var(--match-warm);
  color: white;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
</style>
