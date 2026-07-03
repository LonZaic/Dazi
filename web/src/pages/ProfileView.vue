<template>
  <div class="profile-view">
    <header class="page-header">
      <div>
        <h2 class="page-title">我的画像</h2>
        <p class="page-subtitle">AI 从对话中隐式构建，每个字段都有证据可追溯</p>
      </div>
      <button class="refresh-btn" @click="loadAll" :disabled="profile.loading">
        <AppIcon name="refresh" :size="16" />
        <span>刷新</span>
      </button>
    </header>

    <div class="profile-body">
      <!-- 无画像 -->
      <div class="empty-state card" v-if="!profile.profile && !profile.loading">
        <AppIcon name="user" :size="40" />
        <h3>还没有画像</h3>
        <p>去对话采集页聊几句，AI 会自动构建你的画像</p>
        <RouterLink to="/chat" class="btn btn-primary">
          <AppIcon name="chat" :size="16" />
          去聊天
        </RouterLink>
      </div>

      <template v-else-if="profile.profile">
        <!-- 整体置信度 -->
        <div class="card confidence-card">
          <div class="conf-head">
            <span class="conf-label">整体置信度</span>
            <span class="conf-value" :class="confClass">{{ pct }}%</span>
          </div>
          <div class="conf-track">
            <div class="conf-fill" :class="confClass" :style="{ width: pct + '%' }"></div>
          </div>
          <div class="conf-meta">画像版本 v{{ profile.profile.basic.version }} · {{ profile.profile.interests.length }} 个兴趣</div>
        </div>

        <!-- 兴趣 -->
        <div class="card section-card">
          <div class="section-head">
            <AppIcon name="heart" :size="18" />
            <h3>兴趣偏好</h3>
          </div>
          <div class="interests" v-if="profile.profile.interests.length">
            <div class="interest-item" v-for="i in profile.profile.interests" :key="i.name">
              <div class="interest-top">
                <span class="interest-name">{{ i.name }}</span>
                <span class="interest-conf" :class="confClassOf(i.confidence)">{{ Math.round(i.confidence * 100) }}%</span>
              </div>
              <div class="interest-bar">
                <div class="interest-bar-fill" :class="confClassOf(i.confidence)" :style="{ width: (i.confidence * 100) + '%' }"></div>
              </div>
              <div class="interest-evidence" v-if="i.evidence && i.evidence.length">
                <span class="evidence-label">证据：</span>
                <span class="evidence-text" v-for="(e, idx) in i.evidence" :key="idx">"{{ e }}"</span>
              </div>
            </div>
          </div>
          <div class="empty-inline" v-else>暂无兴趣数据</div>
        </div>

        <!-- 社交风格 -->
        <div class="card section-card">
          <div class="section-head">
            <AppIcon name="users" :size="18" />
            <h3>社交风格</h3>
          </div>
          <div class="style-grid">
            <div class="style-item">
              <span class="style-key">社交能量</span>
              <span class="style-val">{{ styleLabel(profile.profile.socialStyle.energy) }}</span>
            </div>
            <div class="style-item">
              <span class="style-key">交流深度</span>
              <span class="style-val">{{ styleLabel(profile.profile.socialStyle.depth) }}</span>
            </div>
          </div>
        </div>

        <!-- 活跃时段 & 目标 -->
        <div class="card section-card">
          <div class="section-head">
            <AppIcon name="clock" :size="18" />
            <h3>活跃时段与目标</h3>
          </div>
          <div class="kv-row">
            <span class="kv-key">活跃时段</span>
            <div class="chips" v-if="profile.profile.schedule.length">
              <span class="chip chip-neutral" v-for="s in profile.profile.schedule" :key="s">{{ scheduleLabel(s) }}</span>
            </div>
            <span v-else class="empty-inline">未明确</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">找搭子目标</span>
            <span class="kv-val">{{ profile.profile.goal || '未明确' }}</span>
          </div>
          <div class="kv-row" v-if="profile.profile.constraints.length">
            <span class="kv-key">限制条件</span>
            <div class="chips">
              <span class="chip chip-neutral" v-for="c in profile.profile.constraints" :key="c">{{ c }}</span>
            </div>
          </div>
        </div>

        <!-- 画像文本（向量化用） -->
        <div class="card section-card">
          <div class="section-head">
            <AppIcon name="target" :size="18" />
            <h3>画像向量文本</h3>
          </div>
          <p class="vector-text">{{ profile.profileText || '（空）' }}</p>
          <p class="vector-hint">这段文本会被向量化，用于余弦相似度召回匹配候选</p>
        </div>

        <!-- 演进历史 -->
        <div class="card section-card" v-if="profile.history.length">
          <div class="section-head">
            <AppIcon name="refresh" :size="18" />
            <h3>画像演进历史</h3>
            <span class="head-count">{{ profile.history.length }} 次更新</span>
          </div>
          <div class="timeline">
            <div class="timeline-item" v-for="h in profile.history.slice().reverse()" :key="h.version">
              <div class="timeline-dot"></div>
              <div class="timeline-body">
                <div class="timeline-head">
                  <span class="timeline-ver">v{{ h.version }}</span>
                  <span class="timeline-time">{{ fmtTime(h.createdAt) }}</span>
                </div>
                <div class="timeline-patch">
                  <span v-if="h.patch.interests?.length" class="patch-tag">+{{ h.patch.interests.length }} 兴趣</span>
                  <span v-if="h.patch.socialStyle?.energy || h.patch.socialStyle?.depth" class="patch-tag">风格</span>
                  <span v-if="h.patch.schedule?.length" class="patch-tag">时段</span>
                  <span v-if="h.patch.goal" class="patch-tag">目标</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import AppIcon from '../components/common/AppIcon.vue'
import { useProfileStore } from '../stores/profileStore.js'

const profile = useProfileStore()

const pct = computed(() => Math.round(profile.confidence * 100))
const confClass = computed(() => {
  if (pct.value >= 65) return 'high'
  if (pct.value >= 40) return 'mid'
  return 'low'
})

function confClassOf(c) {
  if (c >= 0.7) return 'high'
  if (c >= 0.5) return 'mid'
  return 'low'
}

function styleLabel(v) {
  const map = {
    introvert: '内向型', extrovert: '外向型', ambivert: '中间型', unknown: '未明确',
    surface: '轻松社交', deep: '深度交流', mixed: '看场合', '': '未明确',
  }
  return map[v] || '未明确'
}
function scheduleLabel(s) {
  const map = {
    morning: '早晨', afternoon: '下午', evening: '晚上',
    weekday: '工作日', weekend: '周末', night: '深夜',
  }
  return map[s] || s
}
function fmtTime(t) {
  const d = new Date(t * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function loadAll() {
  await Promise.all([profile.load(), profile.loadHistory()])
}

onMounted(loadAll)
</script>

<style scoped>
.profile-view {
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
.refresh-btn {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
}
.refresh-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

.profile-body {
  max-width: 760px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-6) var(--space-12);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.empty-state.card {
  margin-top: var(--space-12);
  gap: var(--space-3);
}
.empty-state .btn { margin-top: var(--space-3); }

.confidence-card { padding: var(--space-5); }
.conf-head { display: flex; justify-content: space-between; align-items: baseline; }
.conf-label { font-size: var(--fs-sm); color: var(--text-secondary); }
.conf-value { font-size: var(--fs-2xl); font-weight: 700; }
.conf-value.high { color: var(--success); }
.conf-value.mid { color: var(--warning); }
.conf-value.low { color: var(--text-tertiary); }
.conf-track {
  height: 8px;
  background: var(--bg-active);
  border-radius: var(--radius-full);
  margin: var(--space-3) 0 var(--space-2);
  overflow: hidden;
}
.conf-fill { height: 100%; border-radius: var(--radius-full); transition: width var(--dur-slow) var(--ease-out); }
.conf-fill.high { background: linear-gradient(90deg, var(--success), #5fd97a); }
.conf-fill.mid { background: linear-gradient(90deg, var(--warning), #e8b450); }
.conf-fill.low { background: var(--border-strong); }
.conf-meta { font-size: var(--fs-xs); color: var(--text-tertiary); }

.section-card { padding: var(--space-5); }
.section-head {
  display: flex; align-items: center; gap: var(--space-2);
  margin-bottom: var(--space-4);
  color: var(--text-primary);
}
.section-head h3 { font-size: var(--fs-md); font-weight: 600; }
.head-count { margin-left: auto; font-size: var(--fs-xs); color: var(--text-tertiary); }

.interests { display: flex; flex-direction: column; gap: var(--space-4); }
.interest-top { display: flex; justify-content: space-between; margin-bottom: var(--space-2); }
.interest-name { font-size: var(--fs-md); font-weight: 500; color: var(--text-primary); }
.interest-conf { font-size: var(--fs-sm); font-weight: 600; }
.interest-conf.high { color: var(--success); }
.interest-conf.mid { color: var(--warning); }
.interest-conf.low { color: var(--text-tertiary); }
.interest-bar { height: 4px; background: var(--bg-active); border-radius: var(--radius-full); overflow: hidden; }
.interest-bar-fill { height: 100%; border-radius: var(--radius-full); }
.interest-bar-fill.high { background: var(--success); }
.interest-bar-fill.mid { background: var(--warning); }
.interest-bar-fill.low { background: var(--border-strong); }
.interest-evidence { margin-top: var(--space-2); font-size: var(--fs-xs); }
.evidence-label { color: var(--text-tertiary); margin-right: var(--space-1); }
.evidence-text { color: var(--text-secondary); margin-right: var(--space-2); }

.style-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
.style-item { display: flex; flex-direction: column; gap: var(--space-1); }
.style-key { font-size: var(--fs-xs); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.5px; }
.style-val { font-size: var(--fs-md); color: var(--text-primary); font-weight: 500; }

.kv-row { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-2) 0; }
.kv-row + .kv-row { border-top: 1px solid var(--border-subtle); }
.kv-key { width: 90px; flex-shrink: 0; font-size: var(--fs-sm); color: var(--text-tertiary); }
.kv-val { font-size: var(--fs-md); color: var(--text-primary); }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.empty-inline { color: var(--text-tertiary); font-size: var(--fs-sm); }

.vector-text {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  background: var(--bg-elevated);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  line-height: 1.6;
}
.vector-hint { font-size: var(--fs-xs); color: var(--text-tertiary); margin-top: var(--space-2); }

.timeline { display: flex; flex-direction: column; gap: var(--space-3); }
.timeline-item { display: flex; gap: var(--space-3); }
.timeline-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--accent-primary);
  margin-top: 6px;
  flex-shrink: 0;
  box-shadow: 0 0 0 3px var(--accent-primary-soft);
}
.timeline-body { flex: 1; }
.timeline-head { display: flex; gap: var(--space-3); align-items: baseline; }
.timeline-ver { font-size: var(--fs-sm); font-weight: 600; color: var(--text-primary); }
.timeline-time { font-size: var(--fs-xs); color: var(--text-tertiary); }
.timeline-patch { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-1); }
.patch-tag {
  font-size: var(--fs-xs);
  padding: 1px var(--space-2);
  background: var(--bg-elevated);
  border-radius: var(--radius-full);
  color: var(--text-secondary);
}
</style>
