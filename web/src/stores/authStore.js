// 认证 store
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { authApi } from '../api/index.js'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const loading = ref(false)
  const ready = ref(false)
  const avatarUrl = ref('')
  const avatarColor = ref('#6366f1')

  const isLoggedIn = computed(() => !!user.value)
  const displayName = computed(() => user.value?.displayName || user.value?.username || '用户')

  // 全局唯一初始化 Promise，防止多次 fetchMe 并发
  let _initPromise = null

  async function init() {
    if (_initPromise) return _initPromise
    _initPromise = (async () => {
      loading.value = true
      try {
        const res = await authApi.me()
        user.value = res.user
        // displayName 和 avatarUrl 已在 /api/auth/me 中从 user_home 表查出
        avatarUrl.value = res.user.avatarUrl || ''
        avatarColor.value = res.user.avatarColor || '#6366f1'
        return res.user
      } catch {
        user.value = null
        return null
      } finally {
        loading.value = false
        ready.value = true
      }
    })()
    return _initPromise
  }

  async function fetchMe() {
    return init()
  }

  async function register(username, password, displayName) {
    const res = await authApi.register(username, password, displayName)
    user.value = res.user
    ready.value = true
    return res.user
  }

  async function login(username, password) {
    const res = await authApi.login(username, password)
    user.value = res.user
    ready.value = true
    return res.user
  }

  async function logout() {
    await authApi.logout()
    user.value = null
    ready.value = true
  }

  return { user, loading, ready, isLoggedIn, displayName, avatarUrl, avatarColor, fetchMe, init, register, login, logout }
})
