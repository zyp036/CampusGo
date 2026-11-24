import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { useUserStore } from '@/stores/user'

const APP_NAME = '拾光CampusGo'

/** 路由守卫标记：首次导航跳过（等 App.vue 的 checkAuthCapability 完成），后续导航立即判定 */
let initialNavigationDone = false

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: DefaultLayout,
    children: [
      { path: '', redirect: { name: 'home' } },
      {
        path: 'home',
        name: 'home',
        component: () => import('@/views/HomeView.vue'),
        meta: { title: '首页' }
      },
      {
        path: 'plan',
        name: 'plan',
        component: () => import('@/views/PlanView.vue'),
        meta: { title: '生活规划' }
      },
      {
        // 独立探索页已取消：旧地址与收藏夹跳转到规划页（地点列表在那一页里）
        path: 'explore',
        redirect: (to) => ({ name: 'plan', query: to.query })
      },
      {
        path: 'challenge',
        name: 'challenge',
        component: () => import('@/views/ChallengeView.vue'),
        meta: { title: '趣味挑战' }
      },
      {
        path: 'memories',
        name: 'memories',
        component: () => import('@/views/MemoriesView.vue'),
        meta: { title: '生活记忆' }
      },
      {
        path: 'partners',
        name: 'partners',
        component: () => import('@/views/PartnersView.vue'),
        meta: { title: '兴趣搭子' }
      },
      {
        path: 'profile',
        name: 'profile',
        component: () => import('@/views/ProfileView.vue'),
        meta: { title: '个人中心' }
      }
    ]
  },
  {
    path: '/',
    component: AuthLayout,
    children: [
      {
        path: 'login',
        name: 'login',
        component: () => import('@/views/LoginView.vue'),
        meta: { title: '登录' }
      },
      {
        path: 'register',
        name: 'register',
        component: () => import('@/views/RegisterView.vue'),
        meta: { title: '注册' }
      }
    ]
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: { name: 'home' }
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

/**
 * 登录守卫：
 * - 首次导航跳过（App.vue 的 checkAuthCapability 还在跑），让页面自己展示登录提示；
 * - 后续导航：未登录 → /login；已登录访问 /login 或 /register → /home。
 */
router.beforeEach((to) => {
  const isAuthPage = to.name === 'login' || to.name === 'register'
  const user = useUserStore()

  if (!initialNavigationDone) {
    initialNavigationDone = true
    return true
  }

  if (!user.isAuthenticated && !isAuthPage) return { name: 'login' }
  if (user.isAuthenticated && isAuthPage) return { name: 'home' }
  return true
})

router.afterEach((to) => {
  const pageTitle = typeof to.meta.title === 'string' ? to.meta.title : ''
  document.title = pageTitle ? `${pageTitle} · ${APP_NAME}` : APP_NAME
})

export default router
