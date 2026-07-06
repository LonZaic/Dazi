<template>
  <div class="match-card card anim-float-up" :style="{ '--delay': rank * 60 + 'ms' }">
    <div class="card-top">
      <!-- 排名 -->
      <div class="rank-badge" :class="rankClass">
        <span class="rank-num">#{{ rank }}</span>
      </div>

      <!-- 头像 + 基本信息 -->
      <div class="who">
        <div class="avatar clickable" @click="goToUserHome" :title="`查看 ${candidate.displayName} 的主页`">{{ initial }}</div>
        <div class="who-info">
          <div class="who-name clickable" @click="goToUserHome" :title="`查看 ${candidate.displayName} 的主页`">
            {{ candidate.displayName }}
            <!-- ═══ MBTI 类型徽章（DeepSeek-Super 风格玻璃质感）═══ -->
            <span
              v-if="mbtiType !== 'UNKNOWN'"
              class="mbti-badge"
              :class="mbtiColorClass"
              :title="mbtiTooltip"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"
                  stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="currentColor" fill-opacity="0.18"/>
              </svg>
              <span class="mbti-type-text">{{ mbtiType }}</span>
              <span class="mbti-type-nick">{{ mbtiNickname }}</span>
            </span>
            <span v-else class="mbti-badge mbti-unknown" title="对方 MBTI 还没测出来，多聊几句更准">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 2"/>
              </svg>
              <span class="mbti-type-text">待测</span>
            </span>
          </div>
          <div class="who-score">
            <span class="score-label">匹配度</span>
            <span class="score-val" :class="scoreClass">{{ scorePct }}%</span>
            <span v-if="mbtiScorePct !== null" class="mbti-score-chip" :class="mbtiColorClass" :title="`MBTI 兼容度 ${mbtiScorePct}%`">
              MBTI {{ mbtiScorePct }}%
            </span>
          </div>
        </div>
      </div>

      <!-- 共同兴趣 -->
      <div class="common" v-if="candidate.commonInterests.length">
        <div class="common-label">
          <AppIcon name="heart" :size="12" />
          共同兴趣
        </div>
        <div class="common-chips">
          <span class="chip chip-warm" v-for="i in candidate.commonInterests.slice(0, 4)" :key="i">{{ i }}</span>
        </div>
      </div>
    </div>

    <!-- 解释 -->
    <div class="explanation">
      <AppIcon name="lightbulb" :size="14" />
      <span>{{ candidate.explanation }}</span>
    </div>

    <!-- ═══ MBTI 兼容度详情卡（双方类型 + 兼容度解释，DeepSeek-Super 玻璃卡）═══ -->
    <div class="mbti-detail-card" v-if="candidate.mbti && mbtiType !== 'UNKNOWN'">
      <div class="mbti-pair">
        <div class="mbti-side">
          <span class="mbti-role">你</span>
          <span class="mbti-type-big" :class="mineColorClass">{{ candidate.mbti.mineType }}</span>
        </div>
        <div class="mbti-bridge">
          <svg width="36" height="20" viewBox="0 0 36 20" fill="none">
            <path d="M2 10h32" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="3 3"/>
            <path d="M28 6l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
          <span class="mbti-compat-pct" :class="mbtiColorClass">{{ mbtiScorePct }}%</span>
        </div>
        <div class="mbti-side">
          <span class="mbti-role">TA</span>
          <span class="mbti-type-big" :class="mbtiColorClass">{{ mbtiType }}</span>
        </div>
      </div>
      <div class="mbti-reason">{{ candidate.mbti.reason }}</div>
      <div class="mbti-sub-scores" v-if="candidate.mbti.detail">
        <div class="sub-score">
          <span class="sub-label">功能互补</span>
          <div class="sub-bar"><div class="sub-fill" :class="mbtiColorClass" :style="{ width: (candidate.mbti.detail.functionComplement * 100) + '%' }"></div></div>
          <span class="sub-pct">{{ Math.round(candidate.mbti.detail.functionComplement * 100) }}%</span>
        </div>
        <div class="sub-score">
          <span class="sub-label">维度平衡</span>
          <div class="sub-bar"><div class="sub-fill" :class="mbtiColorClass" :style="{ width: (candidate.mbti.detail.dimensionBalance * 100) + '%' }"></div></div>
          <span class="sub-pct">{{ Math.round(candidate.mbti.detail.dimensionBalance * 100) }}%</span>
        </div>
        <div class="sub-score">
          <span class="sub-label">主导和谐</span>
          <div class="sub-bar"><div class="sub-fill" :class="mbtiColorClass" :style="{ width: (candidate.mbti.detail.dominantHarmony * 100) + '%' }"></div></div>
          <span class="sub-pct">{{ Math.round(candidate.mbti.detail.dominantHarmony * 100) }}%</span>
        </div>
      </div>
    </div>

    <!-- 因子雷达图 + 因子详情 -->
    <div class="factors-area">
      <div class="radar-wrap">
        <RadarChart
          :factors="candidate.factors"
          :labels="factorLabels"
          :size="200"
        />
      </div>
      <div class="factor-list">
        <div class="factor-item" v-for="(f, key) in candidate.factors" :key="key">
          <div class="factor-head">
            <span class="factor-name">{{ factorLabel(key) }}</span>
            <span class="factor-val" :class="confClassOf(f)">{{ Math.round(f * 100) }}%</span>
          </div>
          <div class="factor-bar">
            <div class="factor-bar-fill" :class="confClassOf(f)" :style="{ width: (f * 100) + '%' }"></div>
          </div>
          <div class="factor-hint">{{ factorHint(key, f) }}</div>
        </div>
      </div>
    </div>

    <!-- 候选人画像摘要 -->
    <div class="target-summary">
      <div class="summary-row">
        <span class="summary-key">兴趣</span>
        <div class="chips">
          <span class="chip chip-neutral" v-for="i in candidate.interests.slice(0, 6)" :key="i">{{ i }}</span>
          <span v-if="!candidate.interests.length" class="empty-inline">未明确</span>
        </div>
      </div>
      <div class="summary-row">
        <span class="summary-key">风格</span>
        <span class="summary-val">{{ styleText(candidate.socialStyle) }}</span>
      </div>
      <div class="summary-row" v-if="candidate.goal">
        <span class="summary-key">目标</span>
        <span class="summary-val">{{ candidate.goal }}</span>
      </div>
    </div>

    <!-- 破冰话术 -->
    <div class="icebreaker-area">
      <div class="action-row">
        <button
          class="ice-btn"
          :disabled="icebreakerLoading"
          @click="$emit('icebreaker', candidate.userId)"
        >
          <AppIcon name="sparkles" :size="14" />
          <span v-if="icebreakerLoading" class="mini-spin"></span>
          <span>{{ icebreakers ? '重新生成破冰' : '生成破冰话术' }}</span>
        </button>

        <button
          class="dm-btn"
          :disabled="dmLoading"
          @click="$emit('dm', candidate.userId, candidate.displayName)"
        >
          <AppIcon name="message" :size="14" />
          <span v-if="dmLoading" class="mini-spin"></span>
          <span>发私信</span>
        </button>
      </div>

      <transition name="expand">
        <div class="icebreaker-list" v-if="icebreakers">
          <div class="icebreaker-head">
            <AppIcon name="message" :size="14" />
            <span>推荐的开场白</span>
            <span class="ice-source" :class="icebreakers.source">{{ icebreakers.source === 'llm' ? 'AI 生成' : '模板生成' }}</span>
          </div>
          <div
            class="icebreaker-item"
            v-for="(ice, i) in icebreakers.list"
            :key="i"
            @click="copyText(ice)"
            :title="'点击复制'"
          >
            <span class="ice-num">{{ i + 1 }}</span>
            <span class="ice-text">{{ ice }}</span>
            <AppIcon name="check" :size="12" class="ice-copy" />
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from './common/AppIcon.vue'
import RadarChart from './RadarChart.vue'

const router = useRouter()

const props = defineProps({
  candidate: { type: Object, required: true },
  rank: { type: Number, required: true },
  myInitial: { type: String, default: 'U' },
  icebreakers: { type: Object, default: null },
  icebreakerLoading: { type: Boolean, default: false },
  dmLoading: { type: Boolean, default: false },
})

defineEmits(['icebreaker', 'dm'])

function goToUserHome() {
  if (props.candidate.userId) router.push(`/home/${props.candidate.userId}`)
}

const initial = computed(() => (props.candidate.displayName || 'U').charAt(0).toUpperCase())
const scorePct = computed(() => Math.round(props.candidate.score * 100))
const scoreClass = computed(() => {
  if (scorePct.value >= 70) return 'high'
  if (scorePct.value >= 50) return 'mid'
  return 'low'
})
const rankClass = computed(() => {
  if (props.rank === 1) return 'gold'
  if (props.rank === 2) return 'silver'
  if (props.rank === 3) return 'bronze'
  return 'normal'
})

const factorLabels = ['向量', '兴趣', '风格', '时段', '目标', 'MBTI']
const factorKeyLabels = {
  vector: '向量相似度',
  interest: '兴趣重合',
  style: '社交风格',
  schedule: '时段重合',
  goal: '目标互补',
  mbti: 'MBTI 兼容',
}

function factorLabel(k) {
  return factorKeyLabels[k] || k
}

// ═══ MBTI 相关计算属性 ═══
// 4 大气质组配色（和 server/.../matchAgentMbtiAdapter.ts 的 mbtiTypeColorClass 对齐）
const mbtiType = computed(() => props.candidate.mbti?.theirsType || 'UNKNOWN')
const mineType = computed(() => props.candidate.mbti?.mineType || 'UNKNOWN')
const mbtiNickname = computed(() => mbtiType.value === 'UNKNOWN' ? '' : MBTI_NICKNAMES[mbtiType.value] || '')
const mbtiScorePct = computed(() => {
  if (!props.candidate.mbti) return null
  return Math.round(props.candidate.mbti.score * 100)
})
const mbtiColorClass = computed(() => mbtiColorClassOf(mbtiType.value))
const mineColorClass = computed(() => mbtiColorClassOf(mineType.value))
const mbtiTooltip = computed(() => {
  if (mbtiType.value === 'UNKNOWN') return '对方 MBTI 还没测出来'
  const nick = mbtiNickname.value
  const conf = props.candidate.mbti?.theirsConfidence ?? 0
  const confLabel = conf >= 0.7 ? '高置信' : conf >= 0.5 ? '中置信' : '低置信（仅供参考）'
  return `${mbtiType.value} · ${nick} · ${confLabel}`
})

function mbtiColorClassOf(type) {
  if (type === 'UNKNOWN') return 'mbti-unknown'
  const second = type[1]
  const third = type[2]
  if (second === 'N' && third === 'T') return 'mbti-nt'
  if (second === 'N' && third === 'F') return 'mbti-nf'
  if (second === 'S' && third === 'J') return 'mbti-sj'
  if (second === 'S' && third === 'P') return 'mbti-sp'
  return 'mbti-unknown'
}

const MBTI_NICKNAMES = {
  INTJ: '战略家', INTP: '逻辑家', ENTJ: '指挥官', ENTP: '辩论家',
  INFJ: '提倡者', INFP: '调停者', ENFJ: '主人公', ENFP: '竞选者',
  ISTJ: '物流师', ISFJ: '守卫者', ESTJ: '总经理', ESFJ: '执政官',
  ISTP: '鉴赏家', ISFP: '探险家', ESTP: '企业家', ESFP: '表演者',
}
function factorHint(k, v) {
  const hints = {
    vector: v > 0.6 ? '整体画像高度相似' : v > 0.4 ? '画像有一定相似度' : '画像差异较大',
    interest: v > 0.5 ? '兴趣高度重合' : v > 0.2 ? '部分兴趣交集' : '兴趣不同',
    style: v > 0.7 ? '风格很合拍' : v > 0.4 ? '风格可接受' : '风格差异大',
    schedule: v > 0.5 ? '时段重合好' : v > 0.2 ? '部分时段重合' : '时段不重合',
    goal: v > 0.6 ? '目标一致' : v > 0.3 ? '目标相关' : '目标不同',
    mbti: v > 0.7 ? '思维方式黄金互补' : v > 0.5 ? '思维方式可互补' : v > 0.4 ? '思维中性' : '思维方式差异大',
  }
  return hints[k] || ''
}
function confClassOf(v) {
  if (v >= 0.6) return 'high'
  if (v >= 0.4) return 'mid'
  return 'low'
}
function styleText(s) {
  if (!s) return '未明确'
  const e = { introvert: '内向', extrovert: '外向', ambivert: '中间', unknown: '未知' }[s.energy] || '未知'
  const d = { surface: '浅社交', deep: '深度', mixed: '看场合', unknown: '未知' }[s.depth] || '未知'
  return `${e} · ${d}`
}
async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t)
  } catch { /* 忽略 */ }
}
</script>

<style scoped>
.match-card {
  animation-delay: var(--delay);
  padding: var(--space-5);
  transition: border-color var(--dur-fast) var(--ease-out);
}
.match-card:hover {
  border-color: var(--border-strong);
}

.card-top {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.rank-badge {
  width: 44px; height: 44px;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius-md);
  font-weight: 700;
  flex-shrink: 0;
}
.rank-badge.gold {
  background: linear-gradient(135deg, #ffd700, #ffa500);
  color: #4a2c00;
  box-shadow: 0 4px 12px rgba(255, 165, 0, 0.4);
}
.rank-badge.silver {
  background: linear-gradient(135deg, #c0c0c0, #8a8a8a);
  color: #2a2a2a;
}
.rank-badge.bronze {
  background: linear-gradient(135deg, #cd7f32, #8b4513);
  color: white;
}
.rank-badge.normal {
  background: var(--bg-elevated);
  color: var(--text-tertiary);
  border: 1px solid var(--border-default);
}
.rank-num { font-size: var(--fs-md); }

.who { display: flex; align-items: center; gap: var(--space-3); flex: 1; min-width: 180px; }
.avatar {
  width: 40px; height: 40px;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--accent-primary), var(--match-warm));
  color: white;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
}
.avatar.clickable { cursor: pointer; transition: transform .15s; }
.avatar.clickable:hover { transform: scale(1.08); }
.who-name {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.who-name.clickable { cursor: pointer; }
.who-name.clickable:hover { color: var(--accent-primary); }
.who-score { display: flex; align-items: baseline; gap: var(--space-2); margin-top: 2px; flex-wrap: wrap; }
.score-label { font-size: var(--fs-xs); color: var(--text-tertiary); }
.score-val { font-size: var(--fs-lg); font-weight: 700; }
.score-val.high { color: var(--success); }
.score-val.mid { color: var(--warning); }
.score-val.low { color: var(--text-tertiary); }

/* ═══ MBTI 徽章（DeepSeek-Super 玻璃质感，搭子卡上的"对方 MBTI"显示）═══ */
.mbti-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1.4;
  vertical-align: middle;
  border: 1px solid transparent;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: transform var(--dur-fast) var(--ease-out);
}
.mbti-badge:hover { transform: translateY(-1px); }
.mbti-type-text { letter-spacing: 0.5px; }
.mbti-type-nick {
  font-weight: 400;
  opacity: 0.75;
  font-size: 11px;
}
.mbti-badge.mbti-nt {
  background: var(--mbti-nt-soft, rgba(139, 92, 246, 0.16));
  color: var(--mbti-nt, #8b5cf6);
  border-color: color-mix(in srgb, var(--mbti-nt, #8b5cf6) 30%, transparent);
}
.mbti-badge.mbti-nf {
  background: var(--mbti-nf-soft, rgba(16, 185, 129, 0.16));
  color: var(--mbti-nf, #10b981);
  border-color: color-mix(in srgb, var(--mbti-nf, #10b981) 30%, transparent);
}
.mbti-badge.mbti-sj {
  background: var(--mbti-sj-soft, rgba(79, 125, 255, 0.16));
  color: var(--mbti-sj, #4f7dff);
  border-color: color-mix(in srgb, var(--mbti-sj, #4f7dff) 30%, transparent);
}
.mbti-badge.mbti-sp {
  background: var(--mbti-sp-soft, rgba(255, 138, 76, 0.16));
  color: var(--mbti-sp, #ff8a4c);
  border-color: color-mix(in srgb, var(--mbti-sp, #ff8a4c) 30%, transparent);
}
.mbti-badge.mbti-unknown {
  background: var(--bg-hover);
  color: var(--text-tertiary);
  border-color: var(--border-subtle);
}
.mbti-score-chip {
  padding: 1px 6px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.3px;
}
.mbti-score-chip.mbti-nt { background: var(--mbti-nt-soft, rgba(139, 92, 246, 0.16)); color: var(--mbti-nt, #8b5cf6); }
.mbti-score-chip.mbti-nf { background: var(--mbti-nf-soft, rgba(16, 185, 129, 0.16)); color: var(--mbti-nf, #10b981); }
.mbti-score-chip.mbti-sj { background: var(--mbti-sj-soft, rgba(79, 125, 255, 0.16)); color: var(--mbti-sj, #4f7dff); }
.mbti-score-chip.mbti-sp { background: var(--mbti-sp-soft, rgba(255, 138, 76, 0.16)); color: var(--mbti-sp, #ff8a4c); }
.mbti-score-chip.mbti-unknown { background: var(--bg-hover); color: var(--text-tertiary); }

/* ═══ MBTI 兼容度详情卡（DeepSeek-Super 浮动玻璃卡风格）═══ */
.mbti-detail-card {
  margin-top: var(--space-4);
  padding: var(--space-4);
  background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.mbti-pair {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.mbti-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex: 1;
}
.mbti-role {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  letter-spacing: 0.5px;
}
.mbti-type-big {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 1px;
}
.mbti-type-big.mbti-nt { color: var(--mbti-nt, #8b5cf6); }
.mbti-type-big.mbti-nf { color: var(--mbti-nf, #10b981); }
.mbti-type-big.mbti-sj { color: var(--mbti-sj, #4f7dff); }
.mbti-type-big.mbti-sp { color: var(--mbti-sp, #ff8a4c); }
.mbti-type-big.mbti-unknown { color: var(--text-tertiary); }
.mbti-bridge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: var(--text-tertiary);
}
.mbti-compat-pct {
  font-size: var(--fs-sm);
  font-weight: 700;
}
.mbti-compat-pct.mbti-nt { color: var(--mbti-nt, #8b5cf6); }
.mbti-compat-pct.mbti-nf { color: var(--mbti-nf, #10b981); }
.mbti-compat-pct.mbti-sj { color: var(--mbti-sj, #4f7dff); }
.mbti-compat-pct.mbti-sp { color: var(--mbti-sp, #ff8a4c); }
.mbti-reason {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.5;
  text-align: center;
}
.mbti-sub-scores {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}
.sub-score {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-xs);
}
.sub-label {
  width: 64px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.sub-bar {
  flex: 1;
  height: 3px;
  background: var(--bg-active);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.sub-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width var(--dur-base) var(--ease-out);
}
.sub-fill.mbti-nt { background: var(--mbti-nt, #8b5cf6); }
.sub-fill.mbti-nf { background: var(--mbti-nf, #10b981); }
.sub-fill.mbti-sj { background: var(--mbti-sj, #4f7dff); }
.sub-fill.mbti-sp { background: var(--mbti-sp, #ff8a4c); }
.sub-fill.mbti-unknown { background: var(--border-strong); }
.sub-pct {
  width: 36px;
  text-align: right;
  color: var(--text-secondary);
  font-weight: 500;
}

.common {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-width: 260px;
}
.common-label {
  display: flex; align-items: center; gap: var(--space-1);
  font-size: var(--fs-xs); color: var(--text-tertiary);
}
.common-chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }

.explanation {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding: var(--space-3);
  background: var(--accent-primary-soft);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  line-height: 1.6;
}
.explanation :deep(.app-icon) { color: var(--accent-primary); flex-shrink: 0; margin-top: 2px; }

.factors-area {
  display: flex;
  gap: var(--space-5);
  margin-top: var(--space-5);
  flex-wrap: wrap;
}
.radar-wrap {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.factor-list {
  flex: 1;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.factor-head { display: flex; justify-content: space-between; margin-bottom: 4px; }
.factor-name { font-size: var(--fs-sm); color: var(--text-secondary); }
.factor-val { font-size: var(--fs-sm); font-weight: 600; }
.factor-val.high { color: var(--success); }
.factor-val.mid { color: var(--warning); }
.factor-val.low { color: var(--text-tertiary); }
.factor-bar { height: 4px; background: var(--bg-active); border-radius: var(--radius-full); overflow: hidden; }
.factor-bar-fill { height: 100%; border-radius: var(--radius-full); }
.factor-bar-fill.high { background: var(--success); }
.factor-bar-fill.mid { background: var(--warning); }
.factor-bar-fill.low { background: var(--border-strong); }
.factor-hint { font-size: var(--fs-xs); color: var(--text-tertiary); margin-top: 2px; }

.target-summary {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.summary-row { display: flex; align-items: flex-start; gap: var(--space-3); }
.summary-key { width: 50px; flex-shrink: 0; font-size: var(--fs-xs); color: var(--text-tertiary); text-transform: uppercase; padding-top: 4px; }
.summary-val { font-size: var(--fs-sm); color: var(--text-primary); }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.empty-inline { color: var(--text-tertiary); font-size: var(--fs-sm); }

.icebreaker-area { margin-top: var(--space-5); }
.action-row {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.ice-btn, .dm-btn {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  font-weight: 500;
  transition: all var(--dur-fast) var(--ease-out);
}
.ice-btn {
  background: var(--match-warm-soft);
  color: var(--match-warm);
}
.dm-btn {
  background: var(--accent-primary-soft);
  color: var(--accent-primary);
}
.ice-btn:hover:not(:disabled) {
  background: var(--match-warm);
  color: white;
}
.dm-btn:hover:not(:disabled) {
  background: var(--accent-primary);
  color: white;
}
.ice-btn:disabled, .dm-btn:disabled { opacity: 0.6; }
.mini-spin {
  width: 12px; height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.7s linear infinite;
}

.icebreaker-list {
  margin-top: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.icebreaker-head {
  display: flex; align-items: center; gap: var(--space-2);
  font-size: var(--fs-xs); color: var(--text-tertiary);
  margin-bottom: var(--space-1);
}
.ice-source {
  margin-left: auto;
  padding: 1px var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
}
.ice-source.llm { background: var(--accent-primary-soft); color: var(--accent-primary); }
.ice-source.template { background: var(--bg-hover); color: var(--text-tertiary); }

.icebreaker-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.icebreaker-item:hover {
  border-color: var(--accent-primary);
  background: var(--accent-primary-soft);
}
.ice-num {
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-primary-soft);
  color: var(--accent-primary);
  border-radius: 50%;
  font-size: var(--fs-xs);
  font-weight: 600;
  flex-shrink: 0;
}
.ice-text { flex: 1; font-size: var(--fs-sm); color: var(--text-primary); }
.ice-copy { color: var(--text-tertiary); opacity: 0; transition: opacity var(--dur-fast); }
.icebreaker-item:hover .ice-copy { opacity: 1; }

.expand-enter-active, .expand-leave-active {
  transition: all var(--dur-base) var(--ease-out);
  overflow: hidden;
}
.expand-enter-from, .expand-leave-to {
  opacity: 0;
  max-height: 0;
}
.expand-enter-to, .expand-leave-from {
  opacity: 1;
  max-height: 400px;
}
</style>
