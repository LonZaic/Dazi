<template>
  <div class="radar-chart">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`">
      <!-- 网格圈 -->
      <circle v-for="r in rings" :key="r"
        :cx="center" :cy="center" :r="r"
        fill="none" stroke="var(--border-subtle)" stroke-width="1"
      />
      <!-- 轴线 -->
      <line v-for="(axis, i) in axes" :key="'a' + i"
        :x1="center" :y1="center"
        :x2="axis.x" :y2="axis.y"
        stroke="var(--border-subtle)" stroke-width="1"
      />
      <!-- 数据多边形 -->
      <polygon
        :points="polygonPoints"
        fill="var(--accent-primary-soft)"
        stroke="var(--accent-primary)"
        stroke-width="2"
        stroke-linejoin="round"
      />
      <!-- 数据点 -->
      <circle v-for="(p, i) in dataPoints" :key="'p' + i"
        :cx="p.x" :cy="p.y" r="3"
        fill="var(--accent-primary)"
      />
      <!-- 标签 -->
      <text v-for="(label, i) in labelPositions" :key="'l' + i"
        :x="label.x" :y="label.y"
        :text-anchor="label.anchor"
        dominant-baseline="middle"
        fill="var(--text-secondary)"
        font-size="11"
      >{{ labels[i] }}</text>
    </svg>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  // 因子数据 { key: 0-1 }
  factors: { type: Object, required: true },
  // 显示顺序与标签
  labels: { type: Array, default: () => [] },
  size: { type: Number, default: 220 },
})

const center = computed(() => props.size / 2)
const radius = computed(() => props.size / 2 - 36)
const rings = computed(() => [
  radius.value * 0.25,
  radius.value * 0.5,
  radius.value * 0.75,
  radius.value,
])

const factorKeys = computed(() => Object.keys(props.factors))

// 各轴端点
const axes = computed(() => {
  const n = factorKeys.value.length
  return factorKeys.value.map((_, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2
    return {
      x: center.value + Math.cos(angle) * radius.value,
      y: center.value + Math.sin(angle) * radius.value,
    }
  })
})

// 数据点
const dataPoints = computed(() => {
  const n = factorKeys.value.length
  return factorKeys.value.map((k, i) => {
    const v = Math.max(0, Math.min(1, props.factors[k] || 0))
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2
    return {
      x: center.value + Math.cos(angle) * radius.value * v,
      y: center.value + Math.sin(angle) * radius.value * v,
    }
  })
})

const polygonPoints = computed(() =>
  dataPoints.value.map(p => `${p.x},${p.y}`).join(' '),
)

const labelPositions = computed(() => {
  const n = factorKeys.value.length
  return factorKeys.value.map((_, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2
    const lx = center.value + Math.cos(angle) * (radius.value + 16)
    const ly = center.value + Math.sin(angle) * (radius.value + 16)
    let anchor = 'middle'
    if (Math.cos(angle) > 0.3) anchor = 'start'
    else if (Math.cos(angle) < -0.3) anchor = 'end'
    return { x: lx, y: ly, anchor }
  })
})
</script>

<style scoped>
.radar-chart { display: inline-block; }
</style>
