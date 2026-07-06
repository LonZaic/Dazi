<template>
  <div class="match-view">
    <header class="page-header">
      <div>
        <h2 class="page-title">智能匹配</h2>
        <p class="page-subtitle">向量召回 + 多因子规则排序 · 每个推荐都可解释</p>
      </div>
      <div class="header-actions">
        <label class="auto-toggle" title="画像变化时自动刷新推荐">
          <input type="checkbox" v-model="autoRefresh" />
          <span class="toggle-label">自动推荐</span>
        </label>
        <button class="run-btn" :disabled="match.loading" @click="onRun">
          <AppIcon name="refresh" :size="16" :class="{ spin: match.loading }" />
          <span>{{ match.loading ? '匹配中...' : '重新匹配' }}</span>
        </button>
      </div>
    </header>

    <div class="match-body">
      <!-- 无画像提示 -->
      <div class="empty-state card" v-if="!hasProfile && !match.loading">
        <AppIcon name="heart" :size="40" />
        <h3>还没有画像，无法匹配</h3>
        <p>先去对话采集页聊几句，画像置信度 ≥ 50% 即可匹配</p>
        <RouterLink to="/chat" class="btn btn-primary">
          <AppIcon name="chat" :size="16" />
          去聊天
        </RouterLink>
      </div>

      <!-- 加载中 -->
      <div class="loading-state" v-else-if="match.loading">
        <div class="loading-card card">
          <div class="spinner large"></div>
          <p>正在向量召回与多因子排序...</p>
          <div class="loading-steps">
            <span class="step">1. 画像向量化</span>
            <span class="arrow">→</span>
            <span class="step">2. 余弦召回 Top{{ topK }}</span>
            <span class="arrow">→</span>
            <span class="step">3. 规则排序</span>
            <span class="arrow">→</span>
            <span class="step">4. 可解释生成</span>
          </div>
        </div>
      </div>

      <!-- 空结果 -->
      <div class="empty-state card" v-else-if="match.candidates.length === 0">
        <AppIcon name="search" :size="40" />
        <h3>暂无匹配候选</h3>
        <p>系统里其他用户还太少，或画像维度还不够丰富。多聊聊、邀请朋友注册试试。</p>
      </div>

      <!-- 候选列表 -->
      <template v-else>
        <div class="result-summary">
          <span>共召回 {{ match.totalCount }} 人，为你精选前 {{ match.candidates.length }} 位</span>
        </div>

        <div class="candidate-list">
          <MatchCard
            v-for="(c, idx) in match.candidates"
            :key="c.userId"
            :candidate="c"
            :rank="idx + 1"
            :my-initial="auth.displayName"
            :icebreakers="match.icebreakers[c.userId] || null"
            :icebreaker-loading="!!match.icebreakerLoading[c.userId]"
            :dm-loading="!!dmLoading[c.userId]"
            @icebreaker="onIcebreaker"
            @dm="onDm"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '../components/common/AppIcon.vue'
import MatchCard from '../components/MatchCard.vue'
import { useMatchStore } from '../stores/matchStore.js'
import { useProfileStore } from '../stores/profileStore.js'
import { useAuthStore } from '../stores/authStore.js'
import { useDmStore } from '../stores/dmStore.js'

const match = useMatchStore()
const profile = useProfileStore()
const auth = useAuthStore()
const dm = useDmStore()
const router = useRouter()

const topK = ref(20)
const hasProfile = ref(false)
const dmLoading = ref({})
const autoRefresh = ref(true)
let pollTimer = null

async function onRun() {
  try {
    await match.run()
    match.lastConfidence = profile.confidence
  } catch (e) {
    if (e.message?.includes('画像')) {
      hasProfile.value = false
    }
  }
}

// ★ 自动推荐：每 10 秒检测画像置信度变化，变化则自动刷新匹配
function startAutoPoll() {
  stopAutoPoll()
  pollTimer = setInterval(async () => {
    if (!autoRefresh.value || match.loading) return
    try {
      await profile.load()
      hasProfile.value = !!profile.profile && profile.profile.interests.length > 0
      if (hasProfile.value && Math.abs(profile.confidence - match.lastConfidence) > 0.02) {
        await match.run()
        match.lastConfidence = profile.confidence
      }
    } catch { /* */ }
  }, 10_000)
}
function stopAutoPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}
watch(autoRefresh, (on) => { if (on) startAutoPoll(); else stopAutoPoll() })

async function onIcebreaker(userId) {
  await match.generateIcebreaker(userId)
}

async function onDm(userId, displayName) {
  dmLoading.value[userId] = true
  try {
    const roomId = await dm.startRoomWith(userId, displayName)
    router.push({
      name: 'dm-room',
      params: { roomId },
      query: { name: displayName, uid: userId },
    })
  } catch (e) {
    // 创建失败（如未匹配过），错误已在 store 里
  } finally {
    dmLoading.value[userId] = false
  }
}

onMounted(async () => {
  await profile.load()
  hasProfile.value = !!profile.profile && profile.profile.interests.length > 0
  if (hasProfile.value) {
    // 已有结果且置信度未大变 → 直接用缓存，不重新拉
    if (match.candidates.length > 0 && Math.abs(profile.confidence - match.lastConfidence) < 0.05) {
      // 复用已有结果
    } else {
      await match.run()
      match.lastConfidence = profile.confidence
    }
  }
  if (autoRefresh.value) startAutoPoll()
})

onUnmounted(() => { stopAutoPoll() })
</script>

<style scoped>
.match-view {
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
.run-btn {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--accent-primary);
  color: white;
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  font-weight: 500;
}
.run-btn:hover:not(:disabled) {
  background: var(--accent-primary-hover);
  box-shadow: var(--shadow-glow);
}
.header-actions {
  display: flex; align-items: center; gap: var(--space-3);
}
.auto-toggle {
  display: flex; align-items: center; gap: var(--space-1);
  cursor: pointer; user-select: none;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
}
.auto-toggle input { accent-color: var(--accent-primary); }
.toggle-label { font-size: var(--fs-xs); color: var(--text-secondary); }
.spin { animation: spin 0.8s linear infinite; }

.match-body {
  max-width: 880px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-6) var(--space-12);
}

.empty-state.card {
  margin-top: var(--space-12);
  gap: var(--space-3);
}
.empty-state .btn { margin-top: var(--space-3); }

.loading-state { padding-top: var(--space-12); }
.loading-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-10);
  text-align: center;
}
.spinner.large {
  width: 40px; height: 40px;
  border-width: 3px;
}
.loading-steps {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}
.loading-steps .step {
  padding: 2px var(--space-2);
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
}
.loading-steps .arrow { color: var(--border-strong); }

.result-summary {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-bottom: var(--space-4);
  padding: 0 var(--space-1);
}

.candidate-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
