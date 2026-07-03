<template>
  <div class="app-root">
    <router-view v-slot="{ Component }">
      <transition name="page" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useAuthStore } from './stores/authStore.js'

const auth = useAuthStore()
onMounted(() => {
  // 启动时尝试恢复登录态（httpOnly cookie 自动携带）
  auth.fetchMe().catch(() => {})
})
</script>

<style>
.page-enter-active,
.page-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}
.page-enter-from,
.page-leave-to {
  opacity: 0;
}
</style>
