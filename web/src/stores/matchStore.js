// 匹配 store
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { matchApi } from '../api/index.js'

export const useMatchStore = defineStore('match', () => {
  const candidates = ref([])
  const totalCount = ref(0)
  const myProfileText = ref('')
  const loading = ref(false)
  const icebreakers = ref({})
  const icebreakerLoading = ref({})
  const lastConfidence = ref(0)  // 上次匹配时的画像置信度

  async function run(limit) {
    loading.value = true
    try {
      const res = await matchApi.run(limit)
      candidates.value = res.candidates || []
      totalCount.value = res.totalCount || 0
      myProfileText.value = res.myProfileText || ''
      return res
    } catch {
      // 失败不清空已有结果
      return null
    } finally {
      loading.value = false
    }
  }

  async function generateIcebreaker(targetUserId) {
    icebreakerLoading.value[targetUserId] = true
    try {
      const res = await matchApi.icebreaker(targetUserId)
      icebreakers.value[targetUserId] = {
        list: res.icebreakers,
        source: res.source,
        factors: res.factors,
      }
      return res
    } finally {
      icebreakerLoading.value[targetUserId] = false
    }
  }

  function reset() {
    candidates.value = []
    totalCount.value = 0
    icebreakers.value = {}
  }

  return {
    candidates, totalCount, myProfileText, loading,
    icebreakers, icebreakerLoading, lastConfidence,
    run, generateIcebreaker, reset,
  }
})
