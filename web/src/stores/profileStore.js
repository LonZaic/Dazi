// 画像 store
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { profileApi } from '../api/index.js'

export const useProfileStore = defineStore('profile', () => {
  const profile = ref(null)
  const confidence = ref(0)
  const profileText = ref('')
  const history = ref([])
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      const res = await profileApi.get()
      profile.value = res.profile
      confidence.value = res.confidence || 0
      profileText.value = res.profileText || ''
    } finally {
      loading.value = false
    }
  }

  async function loadHistory() {
    const res = await profileApi.history()
    history.value = res.history || []
  }

  return { profile, confidence, profileText, history, loading, load, loadHistory }
})
