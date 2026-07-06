import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/authStore.js'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../pages/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: () => import('../components/layout/AppShell.vue'),
    children: [
      { path: '', redirect: '/chat' },
      {
        path: 'chat',
        name: 'chat',
        component: () => import('../pages/ChatView.vue'),
      },
      {
        path: 'profile',
        name: 'profile',
        component: () => import('../pages/ProfileView.vue'),
      },
      {
        path: 'home/:userId?',
        name: 'user-home',
        component: () => import('../pages/UserHomeView.vue'),
      },
      {
        path: 'match',
        name: 'match',
        component: () => import('../pages/MatchView.vue'),
      },
      {
        path: 'dm',
        name: 'dm-list',
        component: () => import('../pages/DmListView.vue'),
      },
      {
        path: 'dm/:roomId',
        name: 'dm-room',
        component: () => import('../pages/DmRoomView.vue'),
      },
      {
        path: 'privacy',
        name: 'privacy',
        component: () => import('../pages/PrivacyView.vue'),
      },
      {
        path: 'ws-demo',
        name: 'ws-demo',
        component: () => import('../pages/WsDemoView.vue'),
        meta: { devOnly: true },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/chat' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  },
})

// 用 Promise 确保每次刷新先初始化认证态再路由判定
let _initPromise = null

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  // 确保只初始化一次
  if (!_initPromise) _initPromise = auth.init()
  await _initPromise

  if (!to.meta.public && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  // 已登录用户也可以访问登录页（方便切号测试）
})

export default router
