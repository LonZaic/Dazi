<template>
  <div class="user-home-view" :style="pageStyle">
    <!-- 加载中 -->
    <div class="loading" v-if="loading">
      <div class="spinner"></div>
    </div>

    <template v-else>
      <!-- ═══ 顶部 banner ═══ -->
      <div class="home-banner">
        <div class="banner-content">
          <!-- 头像区 — 点击上传 -->
          <div class="avatar-section">
            <label class="avatar-wrap" v-if="isMe" title="点击更换头像">
              <input type="file" accept="image/*" class="avatar-input" @change="onAvatarChange" />
              <img v-if="avatarSrc" :src="avatarSrc" class="avatar-img" alt="" />
              <span v-else class="avatar-text" :style="{ background: avatarColor }">{{ initial }}</span>
              <span class="avatar-overlay">
                <AppIcon name="image" :size="18" />
              </span>
            </label>
            <div class="avatar-wrap" v-else>
              <img v-if="avatarSrc" :src="avatarSrc" class="avatar-img" alt="" />
              <span v-else class="avatar-text" :style="{ background: avatarColor }">{{ initial }}</span>
            </div>
          </div>

          <!-- 信息区 -->
          <div class="info-section">
            <!-- 名字 — inline 编辑 -->
            <div class="info-row name-row">
              <input
                v-if="isMe && editingName"
                ref="nameInput"
                v-model="editName"
                class="inline-input name-input"
                maxlength="24"
                @keydown.enter="saveName"
                @blur="saveName"
              />
              <h1 v-else class="display-name" @click="isMe ? startEditName() : null" :class="{ clickable: isMe }">
                {{ displayName }}
              </h1>
              <AppIcon v-if="isMe && !editingName" name="edit" :size="14" class="edit-hint" />
            </div>

            <!-- 一句话简介 -->
            <div class="info-row bio-row">
              <input
                v-if="isMe && editingBio"
                ref="bioInput"
                v-model="editBio"
                class="inline-input bio-input"
                maxlength="80"
                placeholder="写一句话介绍自己..."
                @keydown.enter="saveBio"
                @blur="saveBio"
              />
              <p
                v-else
                class="bio"
                :class="{ placeholder: !bioText, clickable: isMe }"
                @click="isMe ? startEditBio() : null"
              >
                {{ bioText || (isMe ? '写一句话介绍自己...' : 'TA 还没写简介') }}
              </p>
              <AppIcon v-if="isMe && !editingBio" name="edit" :size="14" class="edit-hint" />
            </div>

            <!-- 标签 — inline 编辑 -->
            <div class="tags-area">
              <div class="tags-row" v-if="editingTags || tags.length">
                <span
                  v-for="(t, i) in tags"
                  :key="i"
                  class="tag"
                  :class="{ removable: isMe && editingTags }"
                  @click="isMe && editingTags ? removeTag(i) : null"
                >
                  {{ t }}
                  <AppIcon v-if="isMe && editingTags" name="x" :size="10" />
                </span>
                <input
                  v-if="isMe && editingTags"
                  v-model="tagInput"
                  type="text"
                  maxlength="12"
                  placeholder="输入标签回车"
                  class="tag-inline-input"
                  @keydown.enter.prevent="addTag"
                />
              </div>
              <div class="tags-actions" v-if="isMe">
                <span v-if="!editingTags && !tags.length" class="tags-placeholder clickable" @click="startEditTags()">
                  添加个性标签...
                </span>
                <template v-if="editingTags">
                  <button class="tags-done-btn" @click="saveTags">完成</button>
                </template>
                <button v-if="!editingTags && tags.length" class="tags-edit-btn" @click="startEditTags()">
                  <AppIcon name="edit" :size="12" /> 编辑标签
                </button>
              </div>
            </div>

            <!-- 主题色 / 城市 / 性别 / 年龄 -->
            <div class="settings-row" v-if="isMe">
              <div class="color-picker-inline">
                <span class="setting-label">主题色</span>
                <button
                  v-for="c in colorOptions"
                  :key="c"
                  class="color-dot"
                  :class="{ active: editForm.avatarColor === c }"
                  :style="{ background: c }"
                  @click="setColor(c)"
                ></button>
              </div>

              <div class="settings-line">
                <span class="setting-label">城市</span>
                <input v-model="editForm.city" class="setting-input" placeholder="如：北京" maxlength="16" @change="saveCit" />
              </div>

              <div class="settings-line">
                <span class="setting-label">性别</span>
                <select v-model="editForm.genderPref" class="setting-select" @change="saveCit">
                  <option value="">不限</option>
                  <option value="male">男</option>
                  <option value="female">女</option>
                </select>
              </div>

              <div class="settings-line">
                <span class="setting-label">年龄</span>
                <input v-model.number="editForm.ageMin" type="number" class="setting-input small" placeholder="20" min="16" max="60" @change="saveCit" />
                <span class="setting-sep">-</span>
                <input v-model.number="editForm.ageMax" type="number" class="setting-input small" placeholder="35" min="16" max="60" @change="saveCit" />
              </div>
            </div>

            <!-- 点赞按钮 (他人主页) -->
            <div class="like-row" v-if="!isMe && data?.user?.id">
              <button class="like-btn" :class="{ liked: likeState.liked }" @click="toggleLike()" :disabled="likeState.loading">
                <AppIcon :name="likeState.liked ? 'heart' : 'heart'" :size="16" />
                <span>{{ likeState.count || 0 }}</span>
              </button>
            </div>

            <!-- 加入时间 -->
            <div class="join-time" v-if="data?.user?.createdAt">
              <AppIcon name="clock" :size="12" />
              <span>{{ fmtDate(data.user.createdAt) }} 加入</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ 内容区 ═══ -->
      <div class="home-content">
        <!-- MBTI 条块 -->
        <div class="mbti-strip" v-if="data?.mbti && data.mbti.partial">
          <span class="mbti-label">MBTI</span>
          <span class="mbti-chars">
            <span
              v-for="(ch, idx) in data.mbti.partial.split('')"
              :key="idx"
              class="mbti-char"
              :class="{ unknown: ch === '_' }"
            >{{ ch }}</span>
          </span>
          <span class="mbti-conf">{{ Math.round(data.mbti.confidence * 100) }}%</span>
        </div>

        <!-- 最近动态 -->
        <div class="content-card" v-if="isGoalValid(data?.profile?.goal)">
          <div class="card-head">
            <span class="card-head-icon"><AppIcon name="activity" :size="16" /></span>
            <h3>最近在干嘛</h3>
          </div>
          <p class="goal-text" style="margin:0">{{ data.profile.goal }}</p>
        </div>

        <!-- AI 画像卡片 -->
        <div class="content-card" v-if="data?.profile">
          <div class="card-head">
            <span class="card-head-icon"><AppIcon name="sparkles" :size="16" /></span>
            <h3>AI 画像</h3>
            <span class="conf-badge">{{ Math.round(data.profile.confidence * 100) }}%</span>
          </div>

          <!-- 统计 -->
          <div class="stat-cards">
            <div class="stat-card">
              <span class="stat-num">{{ data.profile.interests?.length || 0 }}</span>
              <span class="stat-label">兴趣</span>
            </div>
            <div class="stat-card">
              <span class="stat-num">{{ data.profile.schedule?.length || 0 }}</span>
              <span class="stat-label">时段</span>
            </div>
            <div class="stat-card">
              <span class="stat-num">{{ styleLabel(data.profile.socialStyle?.energy) || styleLabel(data.profile.socialStyle?.depth) || '-' }}</span>
              <span class="stat-label">风格</span>
            </div>
          </div>

          <!-- 兴趣 -->
          <div class="card-section" v-if="data.profile.interests?.length">
            <div class="section-title">兴趣偏好</div>
            <div class="chips">
              <span class="chip" v-for="i in data.profile.interests" :key="i.name">
                {{ i.name }}
                <small>{{ Math.round(i.confidence * 100) }}%</small>
              </span>
            </div>
          </div>

          <!-- 社交风格 -->
          <div class="card-section" v-if="data.profile.socialStyle?.energy || data.profile.socialStyle?.depth">
            <div class="section-title">社交风格</div>
            <div class="mini-bars">
              <div class="mini-bar-row" v-if="data.profile.socialStyle?.energy">
                <span class="mini-bar-label">能量</span>
                <div class="mini-bar-track"><div class="mini-bar-fill" :style="{ width: stylePct(data.profile.socialStyle.energy) + '%' }"></div></div>
                <span class="mini-bar-val">{{ styleLabel(data.profile.socialStyle.energy) }}</span>
              </div>
              <div class="mini-bar-row" v-if="data.profile.socialStyle?.depth">
                <span class="mini-bar-label">深度</span>
                <div class="mini-bar-track"><div class="mini-bar-fill" :style="{ width: stylePct(data.profile.socialStyle.depth) + '%' }"></div></div>
                <span class="mini-bar-val">{{ styleLabel(data.profile.socialStyle.depth) }}</span>
              </div>
            </div>
          </div>

          <!-- 活跃时段 -->
          <div class="card-section" v-if="data.profile.schedule?.length">
            <div class="section-title">活跃时段</div>
            <div class="chips">
              <span class="chip neutral" v-for="s in data.profile.schedule" :key="s">{{ scheduleLabel(s) }}</span>
            </div>
          </div>

          <!-- 目标 -->
          <div class="card-section" v-if="isGoalValid(data.profile.goal)">
            <div class="section-title">找搭子目标</div>
            <p class="goal-text">{{ data.profile.goal }}</p>
          </div>
        </div>

        <!-- 无画像 -->
        <div class="content-card empty-card" v-else>
          <AppIcon name="sparkles" :size="32" />
          <h4>{{ isMe ? '还没有 AI 画像' : 'TA 还没有 AI 画像' }}</h4>
          <p>{{ isMe ? '去聊几句，AI 会自动构建你的画像' : '' }}</p>
          <RouterLink v-if="isMe" to="/chat" class="primary-btn">去聊天</RouterLink>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '../components/common/AppIcon.vue'
import { api } from '../api/client.js'
import { useAuthStore } from '../stores/authStore.js'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const loading = ref(true)
const data = ref(null)

const isMe = computed(() => route.params.userId === 'me' || !route.params.userId)

// ─── 编辑状态 ───
const editingName = ref(false)
const editingBio = ref(false)
const editingTags = ref(false)
const editName = ref('')
const editBio = ref('')
const tagInput = ref('')
const nameInput = ref(null)
const bioInput = ref(null)

const editForm = reactive({ displayName: '', bio: '', avatarColor: '#6366f1', tags: [], city: '', genderPref: '', ageMin: 20, ageMax: 35 })

const colorOptions = ['#6366f1','#8b5cf6','#3b82f6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899']

// ─── 头像 ───
const avatarSrc = ref('')

const avatarColor = computed(() => {
  return editForm.avatarColor || '#6366f1'
})

// ─── 点赞 ───
const likeState = reactive({ liked: false, count: 0, loading: false })

// ─── 显示名（可能是自定义的） ───
const displayName = computed(() => {
  return editForm.displayName || data.value?.user.displayName || '匿名'
})

const initial = computed(() => displayName.value.charAt(0).toUpperCase())

const bioText = computed(() => editForm.bio)
const tags = computed(() => editForm.tags || [])

// ─── 主页背景：跟随主题色 ───
const pageStyle = computed(() => {
  const c = avatarColor.value
  if (!c) return {}
  // 把 hex 转成 rgba，叠加在深色底上
  const r = parseInt(c.slice(1,3), 16)
  const g = parseInt(c.slice(3,5), 16)
  const b = parseInt(c.slice(5,7), 16)
  return {
    background: `linear-gradient(170deg, rgba(${r},${g},${b},0.13) 0%, var(--bg) 50%, rgba(${r},${g},${b},0.08) 100%)`,
  }
})

onMounted(async () => {
  if (isMe.value) {
    try {
      const [homeRes, profileRes] = await Promise.all([
        api.get('/profile/home/me'),
        api.get('/profile'),
      ])
      data.value = {
        user: {
          displayName: auth.user?.displayName || auth.user?.username || '用户',
          username: auth.user?.username || 'me',
          createdAt: Math.floor(Date.now() / 1000)
        },
        profile: profileRes.profile,
        mbti: profileRes.mbti || null,
      }
      editForm.bio = homeRes.home?.bio || ''
      editForm.avatarColor = homeRes.home?.avatarColor || '#6366f1'
      editForm.displayName = homeRes.home?.displayName || ''
      editForm.tags = homeRes.home?.tags || []
      editForm.city = homeRes.home?.city || ''
      editForm.genderPref = homeRes.home?.genderPref || ''
      if (homeRes.home?.ageRange) {
        editForm.ageMin = homeRes.home.ageRange.min
        editForm.ageMax = homeRes.home.ageRange.max
      }
      avatarSrc.value = homeRes.home?.avatarUrl || ''
      // ★ 同步到全局 authStore：保证侧栏/私信/AI 对话的头像、颜色、名字一致
      if (homeRes.home?.avatarUrl) auth.avatarUrl = homeRes.home.avatarUrl
      if (homeRes.home?.avatarColor) auth.avatarColor = homeRes.home.avatarColor
      if (homeRes.home?.displayName && auth.user) auth.user.displayName = homeRes.home.displayName
    } catch (e) { console.error(e) } finally { loading.value = false }
  } else {
    try {
      const res = await api.get(`/profile/${route.params.userId}/public`)
      data.value = res
      if (res.home) {
        editForm.bio = res.home.bio || ''
        editForm.avatarColor = res.home.avatarColor || '#6366f1'
        editForm.tags = res.home.tags || []
        editForm.displayName = res.home.displayName || ''
        avatarSrc.value = res.home.avatarUrl || ''
      }
      // 查点赞状态
      try {
        const lk = await api.get(`/likes/${route.params.userId}`)
        likeState.liked = lk.liked
        likeState.count = lk.count
      } catch {}
    } catch (e) { console.error(e) } finally { loading.value = false }
  }
})

// ─── 头像上传 ───
async function onAvatarChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  if (file.size > 2 * 1024 * 1024) return
  const reader = new FileReader()
  reader.onload = async () => {
    const dataUrl = reader.result
    avatarSrc.value = dataUrl
    try {
      await api.post('/avatar', { image: dataUrl })
      auth.avatarUrl = dataUrl   // 同步到全局，侧栏实时更新
    } catch { /* */ }
  }
  reader.readAsDataURL(file)
  e.target.value = ''
}

// ─── 名字 inline 编辑 ───
function startEditName() {
  editName.value = displayName.value
  editingName.value = true
  setTimeout(() => nameInput.value?.focus(), 50)
}
async function saveName() {
  editingName.value = false
  const name = editName.value.trim()
  if (name && name !== displayName.value) {
    editForm.displayName = name
    try { await api.put('/profile/home', buildHomePayload()) } catch {}
    // 同步到全局 authStore，侧栏 + 所有页面实时更新（displayName 是 computed，改 user.displayName 即可）
    if (auth.user) auth.user.displayName = name
  }
}

// ─── 简介 inline 编辑 ───
function startEditBio() {
  editBio.value = editForm.bio || ''
  editingBio.value = true
  setTimeout(() => bioInput.value?.focus(), 50)
}
async function saveBio() {
  editingBio.value = false
  const bio = editBio.value.trim()
  if (bio !== editForm.bio) {
    editForm.bio = bio
    try { await api.put('/profile/home', buildHomePayload()) } catch {}
  }
}

// ─── 标签编辑 ───
function startEditTags() { editingTags.value = true }
function addTag() {
  const t = tagInput.value.trim()
  if (!t || editForm.tags.length >= 10 || editForm.tags.includes(t)) return
  editForm.tags.push(t)
  tagInput.value = ''
}
function removeTag(i) { editForm.tags.splice(i, 1) }
async function saveTags() {
  editingTags.value = false
  tagInput.value = ''
  try { await api.put('/profile/home', buildHomePayload()) } catch {}
}

// ─── 主题色 ───
async function setColor(c) {
  editForm.avatarColor = c
  auth.avatarColor = c   // 同步全局：侧栏/DM/AI 对话首字母头像颜色
  try { await api.put('/profile/home', buildHomePayload()) } catch {}
}

// ─── 构造完整的 home payload（包含所有字段，避免局部更新时把其他字段重置）───
function buildHomePayload() {
  return {
    displayName: editForm.displayName,
    bio: editForm.bio,
    avatarColor: editForm.avatarColor,
    tags: editForm.tags,
    city: editForm.city,
    genderPref: editForm.genderPref,
    ageRange: { min: editForm.ageMin, max: editForm.ageMax },
  }
}

// 城市/性别/年龄自动保存
let _saveCitTimer = null
function saveCit() {
  clearTimeout(_saveCitTimer)
  _saveCitTimer = setTimeout(async () => {
    try {
      await api.put('/profile/home', buildHomePayload())
    } catch {}
  }, 500)
}

// ─── 点赞 ───
async function toggleLike() {
  likeState.loading = true
  try {
    const res = await api.post(`/likes/${route.params.userId}`)
    likeState.liked = res.liked
    likeState.count = res.count
  } catch {} finally { likeState.loading = false }
}

// ─── 工具函数 ───
function styleLabel(v) { const m = { introvert:'内向',extrovert:'外向',ambivert:'中间',surface:'轻松',deep:'深度',mixed:'灵活' }; return m[v]||v||'未知' }
function stylePct(v) { const m = { introvert:25,extrovert:80,ambivert:50,surface:25,deep:85,mixed:50 }; return m[v]||50 }
function scheduleLabel(s) { const m = { morning:'早',afternoon:'午',evening:'晚',weekday:'工作日',weekend:'周末',night:'深夜' }; return m[s]||s }
function isGoalValid(goal) {
  if (!goal || typeof goal !== 'string') return false
  const g = goal.trim()
  return g.length > 0 && !/^unknown$/i.test(g)
}
function fmtDate(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric' })
}

function goBack() { window.history.length > 1 ? router.back() : router.push('/match') }
</script>

<style scoped>
.user-home-view {
  height: 100vh;
  overflow-y: auto;
  background: var(--bg);
}

/* ═══ 顶栏 Banner ═══ */
.home-banner {
  padding: 40px 32px 32px;
  border-bottom: 1px solid var(--border);
}

.banner-content {
  display: flex;
  gap: 28px;
  align-items: flex-start;
}

/* ─── 头像 ─── */
.avatar-section { flex-shrink: 0; }

.avatar-wrap {
  position: relative;
  display: block;
  width: 96px; height: 96px;
  border-radius: 50%;
  overflow: hidden;
  cursor: pointer;
}

.avatar-img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}

.avatar-text {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  font-size: 36px; font-weight: 700;
  color: #fff;
}

.avatar-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.4);
  opacity: 0;
  transition: opacity .15s;
  color: #fff;
}
.avatar-wrap:hover .avatar-overlay { opacity: 1; }

.avatar-input { display: none; }

/* ─── 信息区 ─── */
.info-section { flex: 1; min-width: 0; }

.info-row { display: flex; align-items: center; gap: 6px; }

.display-name {
  font-size: 28px; font-weight: 700;
  color: var(--text);
  margin: 0;
  line-height: 1.3;
}
.display-name.clickable { cursor: pointer; }
.display-name.clickable:hover { color: var(--accent); }

.username {
  font-size: 14px; color: var(--text2);
  margin: 2px 0 8px;
  font-family: var(--font-mono);
}

.edit-hint {
  color: var(--text3);
  opacity: 0;
  transition: opacity .15s;
}
.info-row:hover .edit-hint { opacity: 1; }

.inline-input {
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 4px 10px;
  color: var(--text);
  font-size: 20px;
  outline: none;
  box-sizing: border-box;
}
.name-input { font-size: 28px; font-weight: 700; width: 300px; }
.bio-input { font-size: 14px; width: 100%; max-width: 420px; }

/* ─── 简介 ─── */
.bio {
  font-size: 14px;
  color: var(--text2);
  margin: 0 0 12px;
  line-height: 1.6;
  max-width: 520px;
}
.bio.clickable { cursor: pointer; }
.bio.clickable:hover { color: var(--text); }
.bio.placeholder { color: var(--text3); font-style: italic; }

/* 浅色模式下简介加深 */
[data-theme="light"] .bio { color: var(--text); }
[data-theme="light"] .bio.placeholder { color: var(--text3); }

/* ─── 标签 ─── */
.tags-area { margin-bottom: 14px; }

.tags-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

.tag {
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 999px;
  background: var(--bg2);
  color: var(--text2);
  border: 1px solid var(--border);
  display: inline-flex; align-items: center; gap: 4px;
}
.tag.removable { cursor: pointer; }
.tag.removable:hover { background: var(--red-muted); color: var(--red); border-color: var(--red); }

.tag-inline-input {
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 3px 12px;
  color: var(--text);
  font-size: 12px;
  outline: none;
  width: 100px;
}

.tags-placeholder { font-size: 13px; color: var(--text3); }
.tags-placeholder.clickable { cursor: pointer; }
.tags-placeholder.clickable:hover { color: var(--text2); }

.tags-done-btn, .tags-edit-btn {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text2);
  cursor: pointer;
  display: inline-flex; align-items: center; gap: 4px;
}
.tags-done-btn:hover, .tags-edit-btn:hover { border-color: var(--accent); color: var(--text); }

/* ─── 主题色 + 城市/性别/年龄 ─── */
.color-picker-inline {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 8px;
}
.setting-label { font-size: 12px; color: var(--text3); }
.color-dot {
  width: 22px; height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}
.color-dot:hover { border-color: var(--text2); }
.color-dot.active { border-color: var(--text); box-shadow: 0 0 0 2px var(--bg); }

.settings-line {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 6px;
}
.setting-input {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  color: var(--text);
  font-size: 13px;
  outline: none;
  width: 120px;
}
.setting-input:focus { border-color: var(--accent); }
.setting-input.small { width: 56px; }
.setting-select {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.setting-select:focus { border-color: var(--accent); }
.setting-sep { color: var(--text3); font-size: 13px; }

/* ─── 点赞行 ─── */
.like-row { margin-bottom: 10px; }

.like-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 18px;
  border-radius: 8px;
  background: var(--bg2);
  border: 1px solid var(--border);
  color: var(--text2);
  font-size: 14px;
  cursor: pointer;
  transition: all .15s;
}
.like-btn:hover { border-color: var(--match-warm); color: var(--match-warm); }
.like-btn.liked { background: var(--match-warm-soft); color: var(--match-warm); border-color: var(--match-warm); }
.like-btn:disabled { opacity: 0.5; }

/* ─── 加入时间 ─── */
.join-time {
  display: flex; align-items: center; gap: 4px;
  font-size: 12px; color: var(--text3);
}

/* ═══ 内容区 ═══ */
.home-content {
  padding: 24px 32px 48px;
}

/* ─── MBTI 条块 ─── */
.mbti-strip {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 16px;
}
.mbti-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.mbti-chars {
  display: flex;
  gap: 4px;
}
.mbti-char {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent, #8b5cf6);
  color: #fff;
  font-size: 18px;
  font-weight: 700;
  border-radius: 8px;
  font-family: monospace;
}
.mbti-char.unknown {
  background: var(--border);
  color: var(--text3);
  font-weight: 400;
}
.mbti-conf {
  margin-left: auto;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent, #8b5cf6);
}

.content-card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  transition: border-color .15s;
}
.content-card:hover { border-color: var(--border2); }

.card-head {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 20px;
}
.card-head h3 { font-size: 15px; font-weight: 600; color: var(--text); margin: 0; flex: 1; }
.card-head-icon {
  width: 28px; height: 28px;
  border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-muted);
  color: var(--accent);
}
.conf-badge {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--accent-muted);
  color: var(--accent);
  font-weight: 600;
}

/* ─── 统计卡 ─── */
.stat-cards {
  display: flex; gap: 8px; margin-bottom: 24px;
}
.stat-card {
  flex: 1;
  text-align: center;
  padding: 14px 8px;
  background: var(--bg);
  border-radius: 8px;
}
.stat-num { display: block; font-size: 22px; font-weight: 700; color: var(--text); line-height: 1.2; }
.stat-label { font-size: 11px; color: var(--text3); text-transform: uppercase; letter-spacing: .5px; }

/* ─── 卡区内 section ─── */
.card-section { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
.card-section:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }

.section-title {
  font-size: 11px; color: var(--text3);
  margin-bottom: 10px;
  text-transform: uppercase; letter-spacing: .8px; font-weight: 600;
}

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  font-size: 13px; padding: 5px 12px;
  border-radius: 999px;
  background: var(--bg); color: var(--text2);
  border: 1px solid var(--border);
}
.chip small { color: var(--text3); margin-left: 4px; }
.chip.neutral {}

/* ─── 风格条 ─── */
.mini-bars { display: flex; flex-direction: column; gap: 12px; }
.mini-bar-row { display: flex; align-items: center; gap: 10px; }
.mini-bar-label { width: 40px; font-size: 12px; color: var(--text3); flex-shrink: 0; }
.mini-bar-track { flex: 1; height: 5px; background: var(--bg); border-radius: 999px; overflow: hidden; }
.mini-bar-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width .5s ease; }
.mini-bar-val { font-size: 13px; color: var(--text2); width: 40px; text-align: right; }

/* ─── 目标文字 ─── */
.goal-text {
  font-size: 14px; color: var(--text);
  padding: 12px 16px;
  background: var(--bg);
  border-radius: 8px;
  border-left: 3px solid var(--accent);
  margin: 0;
}

/* ─── 空状态 ─── */
.empty-card {
  text-align: center;
  padding: 48px 24px;
  color: var(--text3);
}
.empty-card h4 { font-size: 16px; color: var(--text); margin: 12px 0 4px; }
.empty-card p { font-size: 13px; margin: 0 0 16px; }

.primary-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 20px;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  text-decoration: none;
}
.primary-btn:hover { background: var(--accent-hover); }

/* ─── 加载 ─── */
.loading { display: flex; justify-content: center; padding: 120px 0; }
.spinner {
  width: 28px; height: 28px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ─── 响应式 ─── */
@media (max-width: 640px) {
  .home-banner { padding: 24px 16px 24px; }
  .banner-content { flex-direction: column; align-items: center; text-align: center; }
  .info-row { justify-content: center; }
  .tags-row { justify-content: center; }
  .color-picker-inline { justify-content: center; }
  .like-row { text-align: center; }
  .home-content { padding: 16px; }
}
</style>
