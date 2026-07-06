<template>
  <div class="login-page">
    <svg class="mosaic-bg" aria-hidden="true">
      <defs>
        <pattern id="mosaic" width="180" height="120" patternUnits="userSpaceOnUse">
          <rect v-for="i in 24" :key="i"
            :x="((i-1)%6)*30" :y="Math.floor((i-1)/6)*30"
            width="30" height="30"
            :fill="colors[((i-1) + Math.floor((i-1)/6)) % 6]"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#mosaic)" opacity="0.5"/>
    </svg>
    <div class="mosaic-overlay"></div>

    <div class="login-card">
      <div class="card-logo">
        <AppIcon name="sparkles" :size="28" />
      </div>
      <h1 class="card-title">{{ mode === 'login' ? '搭子匹配官' : '创建账号' }}</h1>
      <p class="card-sub">{{ mode === 'login' ? '基于多智能体的对话式社交匹配' : '填写以下信息开始匹配' }}</p>

      <form class="form" @submit.prevent="onSubmit">
        <input
          v-model="username"
          type="text"
          autocomplete="username"
          placeholder="用户名"
          maxlength="32"
          :disabled="loading"
        />
        <input
          v-if="mode === 'register'"
          v-model="displayName"
          type="text"
          placeholder="昵称（可选）"
          :disabled="loading"
        />
        <input
          v-model="password"
          type="password"
          :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
          placeholder="密码"
          :disabled="loading"
        />

        <button class="form-btn" type="submit" :disabled="loading">
          {{ loading ? '请稍候…' : (mode === 'login' ? '登录' : '创建账号') }}
        </button>
        <button class="form-btn-outline" type="button" @click="toggleMode">
          {{ mode === 'login' ? '没有账号？去注册' : '已有账号？去登录' }}
        </button>

        <p v-if="error" class="form-error">{{ error }}</p>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '../components/common/AppIcon.vue'
import { useAuthStore } from '../stores/authStore.js'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

// 马赛克色：跟随主题
const lightColors = ['#e8ecf4','#dfe4ed','#d6dce6','#cdd4df','#c4ccd8','#bbc4d1']
const darkColors = ['#141a22','#1c2230','#242a38','#2c3240','#343a48','#3c4250']
const colors = computed(() => {
  const theme = document.documentElement.getAttribute('data-theme')
  return theme === 'dark' || !theme ? darkColors : lightColors
})

const mode = ref('login')
const username = ref('')
const password = ref('')
const displayName = ref('')
const loading = ref(false)
const error = ref('')

function toggleMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  error.value = ''
}

async function onSubmit() {
  error.value = ''
  if (!username.value.trim() || !password.value) {
    error.value = '请填写用户名和密码'
    return
  }
  loading.value = true
  try {
    if (mode.value === 'login') {
      await auth.login(username.value.trim(), password.value)
    } else {
      await auth.register(username.value.trim(), password.value, displayName.value.trim() || undefined)
    }
    router.push(route.query.redirect || '/chat')
  } catch (e) {
    error.value = e.message || '操作失败'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--bg-base);
}

/* ── Mosaic 马赛克背景 ── */
.mosaic-bg {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.mosaic-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(ellipse at center, transparent 40%, var(--bg-base) 80%);
}

/* ── 登录卡片（模仿 DeepSeek-Super） ── */
.login-card {
  position: relative;
  z-index: 1;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 14px;
  padding: 40px;
  width: 380px;
  max-width: 92vw;
}

.card-logo {
  width: 56px;
  height: 56px;
  margin: 0 auto var(--space-4);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-lg);
  color: var(--accent-primary, #5b8def);
}
.card-title {
  font-size: 22px;
  font-weight: 500;
  color: var(--text-primary);
  text-align: center;
  margin-bottom: 4px;
  letter-spacing: -0.3px;
}
.card-sub {
  font-size: 14px;
  color: var(--text-secondary);
  text-align: center;
  margin-bottom: 20px;
  font-weight: 300;
}

/* ── 表单 ── */
.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.form input {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 14px;
  font-family: inherit;
  font-weight: 300;
  color: var(--text-primary);
  outline: none;
  transition: border-color .15s;
}
.form input:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-primary-soft);
  outline: none;
}
.form input::placeholder {
  color: var(--text-tertiary);
}
.form input:disabled {
  opacity: 0.5;
}

.form-btn {
  padding: 10px;
  border-radius: 8px;
  border: none;
  background: var(--accent-primary);
  color: var(--text-on-accent);
  font-size: 14px;
  font-family: inherit;
  font-weight: 400;
  cursor: pointer;
  transition: background .15s;
  margin-top: 4px;
}
.form-btn:hover:not(:disabled) {
  background: var(--accent-primary-hover);
}
.form-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.form-btn-outline {
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
  padding: 10px;
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 300;
  cursor: pointer;
  transition: background .15s, color .15s;
}
.form-btn-outline:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.form-error {
  font-size: 12px;
  color: var(--danger);
  text-align: center;
  margin-top: 4px;
  font-weight: 300;
}
</style>
