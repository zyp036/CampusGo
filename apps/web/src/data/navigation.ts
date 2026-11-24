import { House, Images, Sparkles, Trophy, User, Users } from '@lucide/vue'
import type { NavItem } from '@/types/models'

/**
 * 全站唯一导航配置。
 * 侧边栏渲染全部 6 项；底部导航按 inMobileBar 取 5 项。
 * 新增模块时只需在此追加，两个布局自动同步。
 */
export const navItems: NavItem[] = [
  {
    routeName: 'home',
    label: '首页',
    shortLabel: '首页',
    description: '今天也要发现校园里的新鲜事',
    icon: House,
    inMobileBar: true
  },
  {
    routeName: 'plan',
    label: '生活规划',
    shortLabel: '规划',
    description: '校园地点、预算时间，一次安排明白',
    icon: Sparkles,
    inMobileBar: true
  },
  {
    routeName: 'challenge',
    label: '趣味挑战',
    shortLabel: '挑战',
    description: '完成小任务，攒经验，升等级',
    icon: Trophy,
    inMobileBar: true
  },
  {
    routeName: 'memories',
    label: '生活记忆',
    shortLabel: '记忆',
    description: '你走过的路，都会留在这里',
    icon: Images,
    inMobileBar: false
  },
  {
    routeName: 'partners',
    label: '兴趣搭子',
    shortLabel: '搭子',
    description: '找个人一起，把事情做完',
    icon: Users,
    inMobileBar: true
  },
  {
    routeName: 'profile',
    label: '个人中心',
    shortLabel: '我的',
    description: '你的偏好、等级与徽章',
    icon: User,
    inMobileBar: true
  }
]

export const mobileNavItems = navItems.filter((item) => item.inMobileBar)

export function findNavItem(routeName: string): NavItem | undefined {
  return navItems.find((item) => item.routeName === routeName)
}
