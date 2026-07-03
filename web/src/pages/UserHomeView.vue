<template>
  <div class="user-home-view">
    <!-- 顶栏 -->
    <header class="home-header">
      <button class="back-btn" @click="goBack">
        <AppIcon name="chevron-left" :size="20" />
      </button>
      <span class="header-title">{{ isMe ? '我的主页' : 'TA 的主页' }}</span>
    </header>

    <div class="home-body" v-if="!loading">
      <!-- ═══ 左栏：Hero 卡（头像+基本信息，桌面端 sticky）═══ -->
      <div class="left-column">
        <div class="hero-card">
          <div class="avatar-wrap" :style="{ background: avatarBg }">
            <span class="avatar-text">{{ initial }}</span>
          </div>
          <h2 class="hero-name">{{ data?.user.displayName || '匿名' }}</h2>
          <p class="hero-username">@{{ data?.user.username }}</p>

          <!-- MBTI 徽章 -->
          <div class="hero-mbti" v-if="data?.mbti">
            <span class="mbti-badge" :class="mbtiGroup(data.mbti.type)">
              {{ data.mbti.type }}
            </span>
            <span class="mbti-nick">{{ mbtiNick(data.mbti.type) }}</span>
            <span class="mbti-conf">置信度 {{ Math.round(data.mbti.confidence * 100) }}%</span>
          </div>

          <!-- Bio 简介 -->
          <p class="hero-bio" v-if="data?.home?.bio">{{ data.home.bio }}</p>
          <p class="hero-bio placeholder" v-else>{{ isMe ? '点编辑添加一句话简介' : 'TA 还没写简介' }}</p>

          <!-- 自定义标签 -->
          <div class="hero-tags" v-if="data?.home?.tags?.length">
            <span class="tag" v-for="t in data.home.tags" :key="t">{{ t }}</span>
          </div>

          <!-- 编辑按钮（仅自己主页显示） -->
          <button v-if="isMe" class="edit-btn" @click="editMode = !editMode">
            <AppIcon name="edit" :size="14" />
            {{ editMode ? '收起编辑' : '编辑主页' }}
          </button>
        </div>

        <!-- 注册时间 -->
        <div class="meta-footer" v-if="data?.user?.createdAt">
          加入于 {{ fmtDate(data.user.createdAt) }}
        </div>
      </div>

      <!-- ═══ 右栏：编辑面板 + AI 画像 ═══ -->
      <div class="right-column">
        <!-- ═══ 编辑面板（仅自己主页） ═══ -->
        <transition name="slide-down">
          <div class="card edit-panel" v-if="isMe && editMode">
            <h3 class="panel-title">编辑我的主页</h3>

            <div class="form-row">
              <label>一句话简介</label>
              <input
                v-model="editForm.bio"
                type="text"
                maxlength="80"
                placeholder="比如：周末爱爬山的技术宅"
                class="form-input"
              />
            </div>

            <div class="form-row">
              <label>头像底色</label>
              <div class="color-picker">
                <button
                  v-for="c in colorOptions"
                  :key="c"
                  class="color-dot"
                  :class="{ active: editForm.avatarColor === c }"
                  :style="{ background: c }"
                  @click="editForm.avatarColor = c"
                ></button>
              </div>
            </div>

            <div class="form-row">
              <label>个性标签（最多 10 个，回车添加）</label>
              <div class="tags-input-area">
                <span class="tag removable" v-for="(t, i) in editForm.tags" :key="i" @click="removeTag(i)">
                  {{ t }} ×
                </span>
                <input
                  v-model="tagInput"
                  type="text"
                  maxlength="12"
                  placeholder="输入标签后回车"
                  class="tag-input"
                  @keydown.enter.prevent="addTag"
                />
              </div>
            </div>

            <button class="save-btn" @click="saveHome" :disabled="saving">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </transition>

        <!-- ═══ AI 画像区（DeepSeek-Super 玻璃卡） ═══ -->
        <div class="card profile-section" v-if="data?.profile">
          <div class="section-head">
            <AppIcon name="sparkles" :size="16" />
            <h3>AI 画像</h3>
            <span class="conf-tag">{{ Math.round(data.profile.confidence * 100) }}%</span>
          </div>

          <!-- 兴趣 -->
          <div class="sub-section" v-if="data.profile.interests?.length">
            <div class="sub-label">兴趣</div>
            <div class="chips">
              <span class="chip" v-for="i in data.profile.interests" :key="i.name">
                {{ i.name }}
                <small>{{ Math.round(i.confidence * 100) }}%</small>
              </span>
            </div>
          </div>

          <!-- 社交风格 -->
          <div class="sub-section">
            <div class="sub-label">社交风格</div>
            <div class="kv-grid">
              <div class="kv">
                <span class="kv-key">能量</span>
                <span class="kv-val">{{ styleLabel(data.profile.socialStyle?.energy) }}</span>
              </div>
              <div class="kv">
                <span class="kv-key">深度</span>
                <span class="kv-val">{{ styleLabel(data.profile.socialStyle?.depth) }}</span>
              </div>
            </div>
          </div>

          <!-- 活跃时段 -->
          <div class="sub-section" v-if="data.profile.schedule?.length">
            <div class="sub-label">活跃时段</div>
            <div class="chips">
              <span class="chip neutral" v-for="s in data.profile.schedule" :key="s">{{ scheduleLabel(s) }}</span>
            </div>
          </div>

          <!-- 目标 -->
          <div class="sub-section" v-if="data.profile.goal">
            <div class="sub-label">找搭子目标</div>
            <p class="goal-text">{{ data.profile.goal }}</p>
          </div>
        </div>

        <!-- 无画像提示 -->
        <div class="card empty-profile" v-else>
          <AppIcon name="user" :size="32" />
          <p>{{ isMe ? '你还没有 AI 画像，去聊几句吧' : 'TA 还没有 AI 画像' }}</p>
        </div>
      </div>
    </div>

    <!-- 加载中 -->
    <div class="loading" v-else>
      <div class="spinner"></div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '../components/common/AppIcon.vue'
import { api } from '../api/client.js'

const route = useRoute()
const router = useRouter()

const loading = ref(true)
const saving = ref(false)
const editMode = ref(false)
const data = ref(null)

const isMe = computed(() => route.params.userId === 'me' || !route.params.userId)

const editForm = reactive({
  bio: '',
  avatarColor: '',
  tags: [],
})
const tagInput = ref('')

const colorOptions = [
  '#8b5cf6', '#10b981', '#4f7dff', '#ff8a4c',
  '#ec4899', '#14b8a6', '#f59e0b', '#6366f1',
]

const initial = computed(() => {
  const name = data.value?.user?.displayName || 'U'
  return name.charAt(0).toUpperCase()
})

const avatarBg = computed(() => {
  const c = data.value?.home?.avatarColor || '#8b5cf6'
  return `linear-gradient(135deg, ${c}, ${shadeColor(c, -20)})`
})

onMounted(async () => {
  if (isMe.value) {
    // 加载自己的主页设定
    try {
      const [homeRes, profileRes] = await Promise.all([
        api.get('/profile/home/me'),
        api.get('/profile'),
      ])
      data.value = {
        user: {
          displayName: profileRes.profile?.basic?.displayName || '我',
          username: 'me',
          createdAt: Date.now(),
        },
        profile: profileRes.profile,
        mbti: null,
        home: homeRes.home,
      }
      editForm.bio = homeRes.home?.bio || ''
      editForm.avatarColor = homeRes.home?.avatarColor || ''
      editForm.tags = homeRes.home?.tags || []
    } catch (e) {
      console.error('加载主页失败', e)
    } finally {
      loading.value = false
    }
  } else {
    // 查看他人主页
    try {
      data.value = await api.get(`/profile/${route.params.userId}/public`)
    } catch (e) {
      console.error('加载他人主页失败', e)
    } finally {
      loading.value = false
    }
  }
})

function addTag() {
  const t = tagInput.value.trim()
  if (!t || editForm.tags.length >= 10) return
  if (editForm.tags.includes(t)) return
  editForm.tags.push(t)
  tagInput.value = ''
}

function removeTag(idx) {
  editForm.tags.splice(idx, 1)
}

async function saveHome() {
  saving.value = true
  try {
    await api.put('/profile/home', {
      bio: editForm.bio,
      avatarColor: editForm.avatarColor,
      tags: editForm.tags,
    })
    // 刷新展示
    if (data.value) {
      data.value.home = { bio: editForm.bio, avatarColor: editForm.avatarColor, tags: [...editForm.tags] }
    }
    editMode.value = false
  } catch (e) {
    console.error('保存失败', e)
  } finally {
    saving.value = false
  }
}

function goBack() {
  if (window.history.length > 1) router.back()
  else router.push('/match')
}

function mbtiGroup(type) {
  if (!type || type === 'UNKNOWN' || type.length < 3) return 'mbti-unknown'
  const s = type[1], t = type[2]
  if (s === 'N' && t === 'T') return 'mbti-nt'
  if (s === 'N' && t === 'F') return 'mbti-nf'
  if (s === 'S' && t === 'J') return 'mbti-sj'
  if (s === 'S' && t === 'P') return 'mbti-sp'
  return 'mbti-unknown'
}

function mbtiNick(type) {
  const names = {
    INTJ: '战略家', INTP: '逻辑家', ENTJ: '指挥官', ENTP: '辩论家',
    INFJ: '提倡者', INFP: '调停者', ENFJ: '主人公', ENFP: '竞选者',
    ISTJ: '物流师', ISFJ: '守卫者', ESTJ: '总经理', ESFJ: '执政官',
    ISTP: '鉴赏家', ISFP: '探险家', ESTP: '企业家', ESFP: '表演者',
  }
  return names[type] || '待测'
}

function styleLabel(v) {
  const map = {
    introvert: '内向', extrovert: '外向',
    shallow: '浅交流', deep: '深度',
  }
  return map[v] || v || '未明确'
}

function scheduleLabel(s) {
  const map = {
    weekday_morning: '工作日早', weekday_afternoon: '工作日下午',
    weekday_evening: '工作日晚', weekend_morning: '周末早',
    weekend_afternoon: '周末下午', weekend_evening: '周末晚',
  }
  return map[s] || s
}

function fmtDate(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('zh-CN')
}

function shadeColor(hex, percent) {
  let r = parseInt(hex.slice(1, 3), 16)
  let g = parseInt(hex.slice(3, 5), 16)
  let b = parseInt(hex.slice(5, 7), 16)
  r = Math.max(0, Math.min(255, r + (r * percent / 100)))
  g = Math.max(0, Math.min(255, g + (g * percent / 100)))
  b = Math.max(0, Math.min(255, b + (b * percent / 100)))
  return `#${Math.round(r).toString(16).padStart(2, '0')}${Math.round(g).toString(16).padStart(2, '0')}${Math.round(b).toString(16).padStart(2, '0')}`
}
</script>

<style scoped>
/* ════════════════════════════════════════════════════════════
   个人主页 — DeepSeek-Super 暗色美学 · 桌面双栏布局
   ════════════════════════════════════════════════════════════ */

.user-home-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 32px 48px;
  min-height: 100vh;
  height: 100vh;
  overflow-y: auto;
  position: relative;
}

/* 顶部一抹蓝光氛围 */
.user-home-view::before {
  content: '';
  position: fixed;
  top: 0; left: 50%;
  width: 800px; height: 320px;
  transform: translateX(-50%);
  background: radial-gradient(ellipse 60% 80% at 50% 0%, var(--accent-glow) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
  opacity: 0.7;
}

.home-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 28px;
  position: relative;
  z-index: 1;
}

.back-btn {
  width: 40px; height: 40px;
  border-radius: 12px;
  background: var(--bg2);
  border: 1px solid var(--border);
  color: var(--text);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: all var(--transition-base);
}
.back-btn:hover {
  background: var(--bg3);
  border-color: var(--accent);
  transform: translateY(-1px);
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}

/* ═══ 主体网格：桌面双栏 / 移动单栏 ═══ */
.home-body {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
  position: relative;
  z-index: 1;
}

@media (min-width: 960px) {
  .home-body {
    grid-template-columns: 360px 1fr;
    align-items: start;
  }
}

/* ═══ 左栏：Hero 卡 ═══ */
.left-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

@media (min-width: 960px) {
  .left-column {
    position: sticky;
    top: 24px;
  }
}

.hero-card {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg2) 90%, transparent), color-mix(in srgb, var(--bg) 95%, transparent));
  backdrop-filter: blur(20px);
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg);
  padding: 36px 24px 28px;
  text-align: center;
  position: relative;
  overflow: hidden;
  box-shadow: var(--shadow-md);
}

/* 顶部装饰条 */
.hero-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 80px;
  background: radial-gradient(ellipse 80% 100% at 50% 0%, var(--accent-muted) 0%, transparent 70%);
  pointer-events: none;
}

.avatar-wrap {
  width: 112px; height: 112px;
  border-radius: 50%;
  margin: 0 auto 18px;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 12px 32px rgba(0,0,0,0.35), 0 0 0 4px var(--bg2);
  position: relative;
  z-index: 1;
}

.avatar-text {
  font-size: 46px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 2px 10px rgba(0,0,0,0.4);
}

.hero-name {
  font-size: 24px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
  letter-spacing: -0.02em;
}

.hero-username {
  font-size: 13px;
  color: var(--text2);
  margin-bottom: 16px;
  font-family: var(--font-mono);
}

.hero-mbti {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-radius: 999px;
  background: var(--bg3);
  border: 1px solid var(--border2);
  margin-bottom: 16px;
}

.mbti-badge {
  font-size: 13px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 6px;
  letter-spacing: 0.5px;
}

.mbti-badge.mbti-nt { background: var(--mbti-nt-soft); color: var(--mbti-nt); }
.mbti-badge.mbti-nf { background: var(--mbti-nf-soft); color: var(--mbti-nf); }
.mbti-badge.mbti-sj { background: var(--mbti-sj-soft); color: var(--mbti-sj); }
.mbti-badge.mbti-sp { background: var(--mbti-sp-soft); color: var(--mbti-sp); }
.mbti-badge.mbti-unknown { background: rgba(120,120,120,0.2); color: #aaa; }

.mbti-nick {
  font-size: 12px;
  color: var(--text2);
}

.mbti-conf {
  font-size: 11px;
  color: var(--text3);
  padding-left: 10px;
  border-left: 1px solid var(--border2);
}

.hero-bio {
  font-size: 14px;
  color: var(--text2);
  max-width: 320px;
  margin: 0 auto 16px;
  line-height: 1.6;
}

.hero-bio.placeholder {
  color: var(--text3);
  font-style: italic;
}

.hero-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin-bottom: 20px;
  min-height: 28px;
}

.tag {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--bg3);
  color: var(--text);
  border: 1px solid var(--border2);
  transition: all var(--transition-fast);
}

.tag.removable {
  cursor: pointer;
}
.tag.removable:hover {
  background: var(--red-muted);
  color: var(--red);
  border-color: var(--red);
}

.edit-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  border-radius: 10px;
  background: var(--accent-muted);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-base);
}
.edit-btn:hover {
  background: var(--accent);
  color: #fff;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--accent-glow);
}

/* ═══ 右栏：内容卡 ═══ */
.right-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ═══ 卡片通用 ═══ */
.card {
  background: color-mix(in srgb, var(--bg2) 78%, transparent);
  backdrop-filter: blur(20px);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 24px;
  box-shadow: var(--shadow-sm);
  transition: border-color var(--transition-base);
}
.card:hover {
  border-color: var(--border2);
}

/* ═══ 编辑面板 ═══ */
.edit-panel {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-glow), var(--shadow-md);
}

.panel-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-title::before {
  content: '';
  width: 3px; height: 16px;
  background: var(--accent);
  border-radius: 2px;
}

.form-row {
  margin-bottom: 18px;
}

.form-row label {
  display: block;
  font-size: 12px;
  color: var(--text2);
  margin-bottom: 8px;
  font-weight: 500;
  letter-spacing: 0.3px;
}

.form-input {
  width: 100%;
  padding: 11px 14px;
  border-radius: 10px;
  background: var(--bg);
  border: 1px solid var(--border2);
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: all var(--transition-base);
}
.form-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-muted);
}

.color-picker {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.color-dot {
  width: 34px; height: 34px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all var(--transition-fast);
  position: relative;
}
.color-dot:hover { transform: scale(1.1); }
.color-dot.active {
  border-color: var(--text);
  transform: scale(1.15);
}
.color-dot.active::after {
  content: '✓';
  position: absolute;
  inset: 0;
  display: flex; align-items: center; justify-content: center;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  text-shadow: 0 1px 3px rgba(0,0,0,0.5);
}

.tags-input-area {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px;
  border-radius: 10px;
  background: var(--bg);
  border: 1px solid var(--border2);
  min-height: 46px;
  align-items: center;
  transition: border-color var(--transition-base);
}
.tags-input-area:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-muted);
}

.tag-input {
  flex: 1;
  min-width: 120px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 13px;
  padding: 4px;
}

.save-btn {
  width: 100%;
  padding: 13px;
  border-radius: 10px;
  background: var(--accent);
  border: none;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition-base);
  letter-spacing: 0.3px;
}
.save-btn:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
  box-shadow: 0 6px 16px var(--accent-glow);
}
.save-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }

/* ═══ AI 画像区 ═══ */
.profile-section {
  position: relative;
  overflow: hidden;
}
.profile-section::before {
  content: '';
  position: absolute;
  top: 0; right: 0;
  width: 200px; height: 200px;
  background: radial-gradient(circle, var(--accent-muted) 0%, transparent 70%);
  pointer-events: none;
  opacity: 0.6;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 22px;
  position: relative;
  z-index: 1;
}

.section-head h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  flex: 1;
  letter-spacing: -0.01em;
}

.conf-tag {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--accent-muted);
  color: var(--accent);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.sub-section {
  margin-bottom: 22px;
  padding-bottom: 22px;
  border-bottom: 1px solid var(--border);
}
.sub-section:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.sub-label {
  font-size: 11px;
  color: var(--text3);
  margin-bottom: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
  font-weight: 600;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  font-size: 13px;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--bg3);
  color: var(--text);
  border: 1px solid var(--border2);
  transition: all var(--transition-fast);
}
.chip:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
.chip small {
  color: var(--text3);
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}
.chip.neutral {
  background: var(--bg);
}

.kv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

@media (min-width: 1200px) {
  .kv-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.kv {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  background: var(--bg);
  border-radius: 10px;
  border: 1px solid var(--border);
}

.kv-key {
  font-size: 11px;
  color: var(--text3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.kv-val {
  font-size: 15px;
  color: var(--text);
  font-weight: 500;
}

.goal-text {
  font-size: 15px;
  color: var(--text);
  line-height: 1.6;
  padding: 12px 14px;
  background: var(--bg);
  border-radius: 10px;
  border-left: 3px solid var(--accent);
}

.empty-profile {
  text-align: center;
  padding: 48px 24px;
  color: var(--text3);
}
.empty-profile p {
  margin-top: 12px;
  font-size: 14px;
}

.meta-footer {
  text-align: center;
  font-size: 12px;
  color: var(--text3);
  padding: 16px 0 8px;
  grid-column: 1 / -1;
}

/* ═══ 加载 ═══ */
.loading {
  display: flex;
  justify-content: center;
  padding: 120px 0;
  grid-column: 1 / -1;
}

.spinner {
  width: 28px; height: 28px;
  border: 2px solid var(--border2);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin .8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ═══ 过渡 ═══ */
.slide-down-enter-active, .slide-down-leave-active {
  transition: all .3s ease;
  overflow: hidden;
}
.slide-down-enter-from, .slide-down-leave-to {
  max-height: 0;
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
  margin-bottom: 0;
  border-width: 0;
}
.slide-down-enter-to, .slide-down-leave-from {
  max-height: 600px;
  opacity: 1;
}

/* ═══ 移动端优化 ═══ */
@media (max-width: 640px) {
  .user-home-view {
    padding: 16px;
  }
  .hero-card {
    padding: 28px 16px 24px;
  }
  .avatar-wrap {
    width: 96px; height: 96px;
  }
  .avatar-text {
    font-size: 38px;
  }
  .hero-name {
    font-size: 20px;
  }
  .card {
    padding: 18px;
  }
}
</style>
