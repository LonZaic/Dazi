<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="app-icon"
  >
    <component :is="iconPath" v-if="iconPath" />
  </svg>
</template>

<script setup>
import { computed, h } from 'vue'

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 20 },
  strokeWidth: { type: [Number, String], default: 2 },
})

// 内置图标库（lucide 风格路径，避免外部依赖）
const ICONS = {
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 | M12 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  heart: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  send: 'M22 2L11 13 | M22 2l-7 20-4-9-9-4 20-7z',
  stop: 'M6 6h12v12H6z',
  sparkles: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3z | M5 3v4 | M3 5h4 | M19 17v4 | M17 19h4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 | M16 17l5-5-5-5 | M21 12H9',
  search: 'M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12z | M21 21l-4.35-4.35',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8 | M21 3v5h-5',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 | M7 10l5 5 5-5 | M12 15V3',
  trash: 'M3 6h18 | M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 | M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18 | M6 6l12 12',
  chevronRight: 'M9 18l6-6-6-6',
  chevronLeft: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14 | M5 12h14',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 | M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  users: 'M17 21v-2a4 4 0 0 0-3-3.87 | M9 21v-2a4 4 0 0 1 3-3.87 | M16 3.13a4 4 0 0 1 0 7.75 | M8 3.13a4 4 0 0 0 0 7.75',
  target: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z | M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z | M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z | M12 6v6l4 2',
  lightbulb: 'M9 18h6 | M10 22h4 | M12 2a7 7 0 0 0-4 12.7c.6.6 1 1.5 1 2.3v1h6v-1c0-.8.4-1.7 1-2.3A7 7 0 0 0 12 2z',
  lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z | M7 11V7a5 5 0 0 1 10 0v4',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  // 图片图标（lucide image 近似路径）：相册框 + 太阳点 + 山峰折线
  image: 'M4 4h16v16H4z | M8 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2z | M4 16l5-5 4 4 3-3 4 4',
  // 主题图标
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z',
  sun: 'M12 1v2 | M12 21v2 | M4.22 4.22l1.42 1.42 | M18.36 18.36l1.42 1.42 | M1 12h2 | M21 12h2 | M4.22 19.78l1.42-1.42 | M18.36 5.64l1.42-1.42 | M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
  // 文件上传图标
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z | M14 2v6h6 | M16 13H8 | M16 17H8 | M10 9H8',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 | M17 8l-5-5-5 5 | M12 3v12',
}

const iconPath = computed(() => {
  const d = ICONS[props.name]
  if (!d) return null
  // 多段路径用 | 分隔
  const segs = d.split('|').map(s => s.trim()).filter(Boolean)
  return () => segs.map((seg, i) => h('path', { key: i, d: seg }))
})
</script>

<style scoped>
.app-icon {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
}
</style>
