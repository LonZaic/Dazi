// 匹配 store
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { matchApi } from '../api/index.js'

export const useMatchStore = defineStore('match', () => {
  const candidates = ref([])
  const totalCount = ref(0)
  const myProfileText = ref('')
  const loading = ref(false)
  const icebreakers = ref({})  // { [targetUserId]: { list, source, factors } }
  const icebreakerLoading = ref({})

  async function run(limit) {
    loading.value = true
    try {
      const res = await matchApi.run(limit)
      candidates.value = res.candidates
      totalCount.value = res.totalCount
      myProfileText.value = res.myProfileText
      return res
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
    icebreakers, icebreakerLoading,
    run, generateIcebreaker, reset,
  }
})
