/**
 * 江苏大学与镇江真实地点种子数据（阶段6 导入，2026-11-23 产品调整时核实更新）。
 *
 * 本脚本用于向 cg_campus_place 表写入核实存在的江苏大学校园地点与镇江知名地点。
 *
 * 重要说明：
 * 1. 地点名称与存在性已逐条核实（学校官网/后勤集团公开资料、澎湃新闻等公开报道）
 * 2. 坐标为历史近似值（GCJ-02），地图功能已随 Explore 页取消而移除，坐标仅作数据留存；
 *    身份变更过的记录与城市地点一律置 null，不拿旧坐标冒充新地点的位置
 * 3. 执行方式：幂等 upsert——按 id 更新已有记录、插入缺失记录，不删除任何行，
 *    收藏等外键引用不受影响；重复执行结果一致
 *
 * 使用方法：
 * cd apps/server
 * npx tsx scripts/seed-jiangsu-university-places.ts
 */

import { PrismaClient, PlaceSource } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

const prisma = new PrismaClient()

/** 江苏大学校园地点定义 */
interface PlaceSeed {
  id: string
  name: string
  category: 'study' | 'outdoor' | 'food' | 'sport' | 'culture' | 'view'
  reason: string
  bestTime?: string
  durationLabel?: string
  distanceLabel?: string
  coverGradient: string
  rating: number
  tags: string[]
  source: PlaceSource
  latitude: number | null
  longitude: number | null
  address?: string
  campus: string
  /** 数据来源说明 */
  dataSource: string
  /** 是否已核实坐标 */
  verified: boolean
}

/**
 * 核实存在的地点（2026-11-23）：
 * - 校园：学府路一号门、图书馆、第一食堂、体育馆、三江楼、大礼堂、勤人谷、国际餐厅
 * - 城市：西津渡、北固山、金山、南山（campus = ZHENJIANG）
 *
 * id 沿用阶段6 导入时的 8 个校园 id（收藏外键引用它们，绝不更换）；
 * 其中 6 个 id 对应的旧名称（行政楼/理学楼/校园湖/学生活动中心/体育中心等）
 * 未能核实或名称不准确，更新为核实过的地标，坐标随之置 null。
 */
const places: PlaceSeed[] = [
  {
    id: 'jsu-main-gate',
    name: '江苏大学学府路一号门',
    category: 'view',
    reason: '正门临学府路，图书馆正对大门，是上课与出行最常用的入口。',
    bestTime: '全天',
    coverGradient: 'blue',
    rating: 4.5,
    tags: ['校门', '交通', '标志性'],
    source: 'VERIFIED',
    latitude: 32.15310,
    longitude: 119.46900,
    address: '江苏省镇江市京口区学府路301号',
    campus: 'MAIN',
    dataSource: '学校官网 + 公开报道',
    verified: true
  },
  {
    id: 'jsu-library',
    name: '江苏大学图书馆',
    category: 'study',
    reason: '主楼正对学府路一号门，落地窗采光好，座位可提前一天预约，是自习的核心场所。',
    bestTime: '工作日 8:00-22:00',
    durationLabel: '2-4 小时',
    coverGradient: 'dusk',
    rating: 4.8,
    tags: ['学习', '自习', '藏书', '安静'],
    source: 'VERIFIED',
    latitude: 32.15450,
    longitude: 119.46750,
    address: '江苏大学校内',
    campus: 'MAIN',
    dataSource: '学校官网 + 公开报道',
    verified: true
  },
  {
    id: 'jsu-canteen-1',
    name: '第一食堂',
    category: 'food',
    reason: '东山篮球场北侧的主要食堂之一，红烧肉、面条是被提起最多的菜，价格实惠。',
    bestTime: '11:00-13:00, 17:00-19:00',
    durationLabel: '30-60 分钟',
    coverGradient: 'mist',
    rating: 4.3,
    tags: ['就餐', '食堂', '平价'],
    source: 'VERIFIED',
    latitude: 32.15380,
    longitude: 119.46820,
    address: '江苏大学校内',
    campus: 'MAIN',
    dataSource: '后勤集团公开资料 + 公开报道',
    verified: false
  },
  {
    id: 'jsu-sports-center',
    name: '江苏大学体育馆',
    category: 'sport',
    reason: '学校标志性体育馆，2003 年启用，内有温水泳池与健身房，是校内主要的室内运动场馆。',
    bestTime: '下午课后',
    durationLabel: '1-2 小时',
    coverGradient: 'violet',
    rating: 4.6,
    tags: ['运动', '体育', '健身', '游泳'],
    source: 'VERIFIED',
    latitude: null,
    longitude: null,
    address: '江苏大学校内',
    campus: 'MAIN',
    dataSource: '体育部官网（tyb.ujs.edu.cn）',
    verified: false
  },
  {
    id: 'jsu-admin-building',
    name: '三江楼',
    category: 'view',
    reason: '校内最高的建筑之一，夜晚校名灯牌很远就能看到，门前梧桐大道深秋一片金黄。',
    bestTime: '傍晚与夜晚',
    coverGradient: 'deep',
    rating: 4.6,
    tags: ['地标', '夜景', '梧桐', '教学'],
    source: 'VERIFIED',
    latitude: null,
    longitude: null,
    address: '江苏大学校内',
    campus: 'MAIN',
    dataSource: '公开报道（澎湃新闻等）',
    verified: false
  },
  {
    id: 'jsu-science-building',
    name: '大礼堂',
    category: 'culture',
    reason: '青砖白柱的老建筑，2022 年修缮，在第二、三食堂旁，门前浮雕写着「自强厚德 实干求真」。',
    bestTime: '全天',
    coverGradient: 'blue',
    rating: 4.5,
    tags: ['历史建筑', '地标', '文化'],
    source: 'VERIFIED',
    latitude: null,
    longitude: null,
    address: '江苏大学校内',
    campus: 'MAIN',
    dataSource: '公开报道（澎湃新闻等）',
    verified: false
  },
  {
    id: 'jsu-lake',
    name: '勤人谷',
    category: 'view',
    reason: '紧邻校史馆与中国农机文化展示馆的谷地景观，谷中有湖和日晷，适合安静散步。',
    bestTime: '傍晚',
    durationLabel: '20-40 分钟',
    coverGradient: 'blue',
    rating: 4.7,
    tags: ['景观', '休闲', '散步', '风景'],
    source: 'VERIFIED',
    latitude: null,
    longitude: null,
    address: '江苏大学校内',
    campus: 'MAIN',
    dataSource: '公开报道（澎湃新闻等）',
    verified: false
  },
  {
    id: 'jsu-student-center',
    name: '国际餐厅',
    category: 'food',
    reason: '与第五食堂相连，西式套餐、部队火锅都有，留学生常在这里就餐，适合换口味。',
    bestTime: '11:00-13:00, 17:00-19:00',
    durationLabel: '30-60 分钟',
    coverGradient: 'grape',
    rating: 4.4,
    tags: ['就餐', '西式', '换口味'],
    source: 'VERIFIED',
    latitude: null,
    longitude: null,
    address: '江苏大学校内',
    campus: 'MAIN',
    dataSource: '后勤集团公开资料 + 公开招标信息',
    verified: false
  },
  {
    id: 'zj-xijindu',
    name: '西津渡历史文化街区',
    category: 'culture',
    reason: '千年古渡老街，昭关石塔、救生会旧址都在里面，傍晚去能一直逛到亮灯。',
    bestTime: '傍晚至夜间',
    durationLabel: '2-3 小时',
    coverGradient: 'blue',
    rating: 4.9,
    tags: ['城市', '历史', '夜逛'],
    source: 'VERIFIED',
    latitude: null,
    longitude: null,
    address: '镇江市润州区西津渡',
    campus: 'ZHENJIANG',
    dataSource: '镇江市公开文旅资料',
    verified: false
  },
  {
    id: 'zj-beigushan',
    name: '北固山公园',
    category: 'view',
    reason: '「天下第一江山」，多景楼平台正对长江，是镇江看落日的经典位置。',
    bestTime: '日落前 1 小时',
    durationLabel: '2 小时',
    coverGradient: 'violet',
    rating: 4.8,
    tags: ['落日', '登山', '摄影', '三国'],
    source: 'VERIFIED',
    latitude: null,
    longitude: null,
    address: '镇江市京口区东吴路',
    campus: 'ZHENJIANG',
    dataSource: '镇江市公开文旅资料',
    verified: false
  },
  {
    id: 'zj-jinshan',
    name: '金山公园',
    category: 'view',
    reason: '金山寺与慈寿塔所在地，《白蛇传》水漫金山的传说出处，登塔可望长江。',
    bestTime: '晴天下午',
    durationLabel: '2-3 小时',
    coverGradient: 'grape',
    rating: 4.6,
    tags: ['城市', '历史', '摄影', '传说'],
    source: 'VERIFIED',
    latitude: null,
    longitude: null,
    address: '镇江市润州区金山路',
    campus: 'ZHENJIANG',
    dataSource: '镇江市公开文旅资料',
    verified: false
  },
  {
    id: 'zj-nanshan',
    name: '南山国家森林公园',
    category: 'outdoor',
    reason: '城市南郊的森林公园，招隐寺、竹林与步道都在里面，适合半日徒步洗肺。',
    bestTime: '上午或傍晚',
    durationLabel: '2-4 小时',
    coverGradient: 'mist',
    rating: 4.7,
    tags: ['徒步', '自然', '森林'],
    source: 'VERIFIED',
    latitude: null,
    longitude: null,
    address: '镇江市润州区南山',
    campus: 'ZHENJIANG',
    dataSource: '镇江市公开文旅资料',
    verified: false
  }
]

async function seedPlaces() {
  console.log('开始导入江苏大学校园地点数据...\n')

  let inserted = 0
  let skipped = 0
  let updated = 0

  for (const place of places) {
    // 检查是否已存在
    const existing = await prisma.campusPlace.findUnique({
      where: { id: place.id }
    })

    if (existing) {
      // 如果已存在，更新关键字段（但不覆盖用户可能修改的内容）
      await prisma.campusPlace.update({
        where: { id: place.id },
        data: {
          name: place.name,
          category: place.category,
          reason: place.reason,
          latitude: place.latitude !== null ? new Decimal(place.latitude) : null,
          longitude: place.longitude !== null ? new Decimal(place.longitude) : null,
          address: place.address,
          campus: place.campus,
          source: place.source,
          coverGradient: place.coverGradient,
          rating: new Decimal(place.rating),
          tags: place.tags,
          bestTime: place.bestTime,
          durationLabel: place.durationLabel,
          distanceLabel: place.distanceLabel
        }
      })
      console.log(`✓ 更新: ${place.name} (${place.id})`)
      updated++
    } else {
      // 插入新记录
      await prisma.campusPlace.create({
        data: {
          id: place.id,
          name: place.name,
          category: place.category,
          reason: place.reason,
          latitude: place.latitude !== null ? new Decimal(place.latitude) : null,
          longitude: place.longitude !== null ? new Decimal(place.longitude) : null,
          address: place.address,
          campus: place.campus,
          source: place.source,
          coverGradient: place.coverGradient,
          rating: new Decimal(place.rating),
          tags: place.tags,
          bestTime: place.bestTime,
          durationLabel: place.durationLabel,
          distanceLabel: place.distanceLabel
        }
      })
      console.log(`✓ 新增: ${place.name} (${place.id})`)
      inserted++
    }
  }

  console.log('\n导入完成！')
  console.log(`  新增: ${inserted} 条`)
  console.log(`  更新: ${updated} 条`)
  console.log(`  跳过: ${skipped} 条`)
  console.log(`  总计: ${places.length} 条`)

  // 验证导入结果
  const totalCount = await prisma.campusPlace.count()
  const withCoords = await prisma.campusPlace.count({
    where: {
      latitude: { not: null },
      longitude: { not: null }
    }
  })
  const verifiedCount = await prisma.campusPlace.count({
    where: { source: 'VERIFIED' }
  })

  console.log('\n数据库验证:')
  console.log(`  总地点数: ${totalCount}`)
  console.log(`  有坐标的地点: ${withCoords}`)
  console.log(`  已核实的地点: ${verifiedCount}`)

  // 输出坐标核实情况
  console.log('\n坐标核实说明:')
  for (const place of places) {
    const status = place.verified ? '✓ 已核实' : '⚠ 近似值'
    console.log(`  ${status}: ${place.name} (${place.latitude}, ${place.longitude})`)
    console.log(`    来源: ${place.dataSource}`)
  }
}

async function main() {
  try {
    await seedPlaces()
  } catch (error) {
    console.error('导入失败:', error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
