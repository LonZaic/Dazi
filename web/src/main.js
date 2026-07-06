import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router/index.js'

import './assets/styles/variables.css'
import './assets/styles/reset.css'
import './assets/styles/animations.css'
import './style.css'

// 主题持久化：启动时恢复用户偏好，默认浅色模式
const savedTheme = localStorage.getItem('theme') || 'light'
if (savedTheme === 'dark') {
  document.documentElement.removeAttribute('data-theme')
} else {
  document.documentElement.setAttribute('data-theme', savedTheme)
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
