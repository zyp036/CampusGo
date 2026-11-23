import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import AuthLayout from '@/layouts/AuthLayout.vue'

const APP_NAME = '拾光CampusGo'

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
        meta: { title: 'AI生活规划' }
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

router.afterEach((to) => {
  const pageTitle = typeof to.meta.title === 'string' ? to.meta.title : ''
  document.title = pageTitle ? `${pageTitle} · ${APP_NAME}` : APP_NAME
})

export default router
