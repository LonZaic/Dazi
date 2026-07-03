<template>
  <!--
    SessionSidebar.vue — 对话会话侧栏
    ─────────────────────────────────────────
    【干啥的】多会话管理：新建/切换/重命名/删除会话
    【谁调它】ChatView.vue 把它放左侧
    【调谁】chatStore 的 sessions/currentSessionId + 会话管理方法
    【交互】点击切换；双击标题进入重命名；hover 显示删除
  -->
  <aside class="session-sidebar" :class="{ collapsed }">
    <div class="sidebar-head">
      <button class="new-btn" @click="$emit('create')">
        <AppIcon name="plus" :size="16" />
        <span>新建对话</span>
      </button>
      <button class="collapse-btn" @click="$emit('toggle')" :title="collapsed ? '展开' : '收起'">
        <AppIcon :name="collapsed ? 'chevronRight' : 'chevronLeft'" :size="16" />
      </button>
    </div>

    <div class="session-list" v-if="!collapsed">
      <div
        v-for="s in sessions"
        :key="s.id"
        class="session-item"
        :class="{ active: s.id === currentId }"
        @click="$emit('select', s.id)"
      >
        <!-- 重命名态 -->
        <input
          v-if="renamingId === s.id"
          class="rename-input"
          v-model="renameVal"
          ref="renameInputRef"
          @click.stop
          @keyup.enter="commitRename(s.id)"
          @keyup.esc="cancelRename"
          @blur="commitRename(s.id)"
        />
        <!-- 正常态 -->
        <template v-else>
          <AppIcon name="message" :size="14" class="item-icon" />
          <span class="item-title" @dblclick.stop="startRename(s)">{{ s.title || '新对话' }}</span>
          <div class="item-actions" @click.stop>
            <button class="icon-btn" title="重命名" @click="startRename(s)">
              <AppIcon name="edit" :size="12" />
            </button>
            <button
              class="icon-btn danger"
              title="删除"
              :disabled="sessions.length <= 1"
              @click="onDelete(s)"
            >
              <AppIcon name="trash" :size="12" />
            </button>
          </div>
        </template>
      </div>

      <div class="empty-hint" v-if="sessions.length === 0">
        还没有对话，点上面"新建对话"开始吧
      </div>
    </div>
  </aside>
</template>

<script setup>
import { ref, nextTick } from 'vue'
import AppIcon from '../common/AppIcon.vue'

const props = defineProps({
  sessions: { type: Array, default: () => [] },
  currentId: { type: String, default: '' },
  collapsed: { type: Boolean, default: false },
})

const emit = defineEmits(['create', 'select', 'toggle', 'rename', 'delete'])

// ─── 重命名 inline 编辑 ───
const renamingId = ref('')
const renameVal = ref('')
const renameInputRef = ref(null)

function startRename(s) {
  renamingId.value = s.id
  renameVal.value = s.title || '新对话'
  nextTick(() => {
    const el = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value
    el?.focus()
    el?.select()
  })
}

function commitRename(id) {
  const v = renameVal.value.trim()
  if (v && v !== props.sessions.find(s => s.id === id)?.title) {
    emit('rename', id, v)
  }
  renamingId.value = ''
}

function cancelRename() {
  renamingId.value = ''
}

function onDelete(s) {
  if (props.sessions.length <= 1) return   // 至少保留一个会话
  if (confirm(`删除对话"${s.title || '新对话'}"？该对话所有消息将清除。`)) {
    emit('delete', s.id)
  }
}
</script>

<style scoped>
.session-sidebar {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface, #fafafa);
  border-right: 1px solid var(--border-subtle, #eee);
  transition: width var(--dur-base, 0.2s) var(--ease-out, ease);
  overflow: hidden;
}
.session-sidebar.collapsed {
  width: 48px;
}

.sidebar-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--border-subtle, #eee);
}
.new-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: var(--radius-md, 8px);
  background: var(--accent-primary, #4f7cff);
  color: #fff;
  font-size: var(--fs-sm, 13px);
  font-weight: 500;
  transition: opacity var(--dur-fast, 0.15s);
}
.new-btn:hover { opacity: 0.9; }
.collapsed .new-btn span { display: none; }
.collapsed .new-btn { flex: 0; width: 32px; padding: 7px; }

.collapse-btn {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius-sm, 6px);
  color: var(--text-tertiary, #999);
  flex-shrink: 0;
}
.collapse-btn:hover { background: var(--bg-hover, #f0f0f0); }

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  color: var(--text-secondary, #666);
  font-size: var(--fs-sm, 13px);
  transition: background var(--dur-fast, 0.15s);
  position: relative;
}
.session-item:hover { background: var(--bg-hover, #f0f0f0); }
.session-item.active {
  background: var(--accent-primary-soft, #e8efff);
  color: var(--accent-primary, #4f7cff);
  font-weight: 500;
}
.item-icon { flex-shrink: 0; opacity: 0.7; }
.item-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--dur-fast, 0.15s);
}
.session-item:hover .item-actions { opacity: 1; }

.icon-btn {
  width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius-sm, 6px);
  color: var(--text-tertiary, #999);
}
.icon-btn:hover { background: var(--bg-base, #fff); color: var(--text-primary, #333); }
.icon-btn.danger:hover { color: var(--danger, #e5484d); }
.icon-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.rename-input {
  flex: 1;
  padding: 4px 6px;
  border: 1px solid var(--accent-primary, #4f7cff);
  border-radius: var(--radius-sm, 6px);
  font-size: var(--fs-sm, 13px);
  background: var(--bg-base, #fff);
  outline: none;
  min-width: 0;
}

.empty-hint {
  padding: 20px 12px;
  text-align: center;
  color: var(--text-tertiary, #aaa);
  font-size: var(--fs-xs, 12px);
  line-height: 1.6;
}

/* 小屏：侧栏默认收起成窄条，点击展开浮层 */
@media (max-width: 768px) {
  .session-sidebar { width: 48px; }
  .session-sidebar .new-btn span { display: none; }
  .session-sidebar .new-btn { flex: 0; width: 32px; padding: 7px; }
  .session-sidebar .session-list { display: none; }
  .session-sidebar.expanded {
    position: absolute;
    z-index: 50;
    height: 100%;
    width: 240px;
    box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.15));
  }
  .session-sidebar.expanded .new-btn span { display: inline; }
  .session-sidebar.expanded .new-btn { flex: 1; }
  .session-sidebar.expanded .session-list { display: block; }
}
</style>
