import type { MemoryItem } from '@/types/models'
import { coverGradients } from '@/data/gradients'
import { explorePlaces } from '@/data/explore'

/**
 * 生活记忆演示数据。阶段8 接入数据库与文件存储后，
 * 这里的内容将整体替换为「用户真实产生的记录」。
 *
 * 日期统一用 dateKey（ISO）：卡片上的「11 月 14 日 · 周六」和
 * 时间线的「2026 年 11 月」都由 utils/datetime 从它推导，不再另存一份文字。
 */
export const memoryRecords: MemoryItem[] = [
  {
    id: 'mem-1',
    title: '第一次一个人去西津渡',
    dateKey: '2026-11-14',
    location: '西津渡历史文化街区',
    activityType: '城市探索',
    expGained: 60,
    coverGradient: coverGradients.dusk,
    photoCount: 6,
    note: '从一号码头走上去，在救生会门口坐了二十分钟。回程的公交正好看到长江变暗。'
  },
  {
    id: 'mem-2',
    title: '图书馆窗边那个位置',
    dateKey: '2026-11-11',
    location: '江苏大学图书馆',
    activityType: '独处',
    expGained: 25,
    coverGradient: coverGradients.violet,
    photoCount: 2,
    note: '下午四点半以后光最好，写完了一篇课程作业的初稿。'
  },
  {
    id: 'mem-3',
    title: '操场跑了这三个学期最顺的一次',
    dateKey: '2026-11-08',
    location: '西山操场',
    activityType: '运动',
    expGained: 40,
    coverGradient: coverGradients.mist,
    photoCount: 1,
    note: '五公里，配速掉到 6 分半但没停。第二次约到了一起跑的搭子。'
  },
  {
    id: 'mem-4',
    title: '勤人谷的湖边走了两圈',
    dateKey: '2026-11-02',
    location: '勤人谷',
    activityType: '摄影',
    expGained: 35,
    coverGradient: coverGradients.blue,
    photoCount: 9,
    note: '下午湖边的光正好，日晷的影子斜在水面上，一口气拍了一整组。'
  },
  {
    id: 'mem-5',
    title: '把计划里的事全做完了',
    dateKey: '2026-10-26',
    location: '江苏大学 + 北固山',
    activityType: 'AI 规划',
    expGained: 80,
    coverGradient: coverGradients.grape,
    photoCount: 4,
    note: '第一次严格照着生成的计划走完，中间没有改路线。'
  }
]

/**
 * 补记时的地点候选：直接取校园地点示例列表那 8 个地点的名字，
 * 两条链路用同一批写法；输入框仍可自由填写别的地点，候选只是提示。
 */
export const memoryLocationHints = explorePlaces.map((place) => place.name)
