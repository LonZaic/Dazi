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

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (!to.meta.public && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.name === 'login' && auth.isLoggedIn) {
    return { name: 'chat' }
  }
})

export default router
