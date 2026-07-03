// 认证 store
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { authApi } from '../api/index.js'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const loading = ref(false)

  const isLoggedIn = computed(() => !!user.value)
  const displayName = computed(() => user.value?.displayName || user.value?.username || '用户')

  async function fetchMe() {
    loading.value = true
    try {
      const res = await authApi.me()
      user.value = res.user
      return res.user
    } catch {
      user.value = null
      return null
    } finally {
      loading.value = false
    }
  }

  async function register(username, password, displayName) {
    const res = await authApi.register(username, password, displayName)
    user.value = res.user
    return res.user
  }

  async function login(username, password) {
    const res = await authApi.login(username, password)
    user.value = res.user
    return res.user
  }

  async function logout() {
    await authApi.logout()
    user.value = null
  }

  return { user, loading, isLoggedIn, displayName, fetchMe, register, login, logout }
})
