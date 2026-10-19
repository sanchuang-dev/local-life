import {
  Apple,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  HeartPulse,
  Package,
  Sparkles,
  Store,
  Tv,
  Watch,
  type LucideIcon,
} from 'lucide-react'

import type { EntryTone } from './home'

/**
 * Life fixtures ported from the V0.3 `life`, `product`, `exchange` and `points`
 * screens. They are demonstration data only.
 *
 * This module is the single source for the resident-points balance, goods and
 * stores. No payment, order, inventory, coupon or loyalty backend is connected,
 * and no value here may be presented as a real balance or redemption.
 */

export const lifePoints = {
  current: 2680,
  earnableToday: 80,
} as const

export type LifeProductCategory = '果蔬生鲜' | '米面粮油' | '洗护日用' | '广电权益'

export type LifeProductFilter = '全部' | LifeProductCategory

export const lifeProductCategories: LifeProductCategory[] = [
  '果蔬生鲜',
  '米面粮油',
  '洗护日用',
  '广电权益',
]

export const lifeProductFilters: LifeProductFilter[] = ['全部', ...lifeProductCategories]

export type LifeProduct = {
  id: string
  name: string
  category: LifeProductCategory
  points: number
  icon: LucideIcon
  tone: EntryTone
  summary: string
  stock: string
  limit: string
  exchangeMode: string
  location: string
  validity: string
  note: string
}

export const lifeProducts: LifeProduct[] = [
  {
    id: 'fruit-basket',
    name: '时令水果篮',
    category: '果蔬生鲜',
    points: 480,
    icon: Apple,
    tone: 'mint',
    summary: '当季水果组合，示例规格约 3 公斤，以到店实物为准。',
    stock: '示例库存 42 份',
    limit: '每人每月限兑 2 份',
    exchangeMode: '积分兑换 + 到店核销',
    location: '幸福里便利店（示例）',
    validity: '兑换后 15 天内有效',
    note: '首批仅支持到店自提，不提供配送；水果品种随季节变化。',
  },
  {
    id: 'rice-5kg',
    name: '5 斤装大米',
    category: '米面粮油',
    points: 1200,
    icon: Package,
    tone: 'peach',
    summary: '5 斤装大米，包装与产地信息仅用于界面演示。',
    stock: '示例库存 86 件',
    limit: '每人每月限兑 2 件',
    exchangeMode: '积分兑换 + 到店核销',
    location: '幸福里便利店（示例）',
    validity: '兑换后 15 天内有效',
    note: '不提供配送；实物规格与库存以未来真实兑换规则为准。',
  },
  {
    id: 'wash-set',
    name: '洗护套装',
    category: '洗护日用',
    points: 680,
    icon: Sparkles,
    tone: 'mint',
    summary: '洗护用品组合示意，具体品牌与规格不在本原型承诺范围内。',
    stock: '示例库存 35 套',
    limit: '每人每月限兑 1 套',
    exchangeMode: '积分兑换 + 到店核销',
    location: '幸福里便利店（示例）',
    validity: '兑换后 15 天内有效',
    note: '演示商品不构成实际销售承诺，也不会产生真实订单。',
  },
  {
    id: 'gd-member-month',
    name: '广电会员月卡',
    category: '广电权益',
    points: 2000,
    icon: Tv,
    tone: 'peach',
    summary: '广电会员月卡权益示意，仅展示积分兑换概念，不办理真实权益。',
    stock: '示例名额 20 份',
    limit: '每人限兑 1 份',
    exchangeMode: '积分兑换 + 权益登记（演示）',
    location: '广电社区服务点（演示）',
    validity: '兑换后 30 天内登记',
    note: '不生成会员账号、卡密或真实券码，具体权益以未来合作方案为准。',
  },
]

export type LifeStore = {
  id: string
  name: string
  meta: string
  tag?: string
  icon: LucideIcon
  tone: EntryTone
  pendingNotice: string
}

export const lifeStores: LifeStore[] = [
  {
    id: 'convenience',
    name: '幸福里便利店',
    meta: '积分兑换点 · 商品核销点 · 步行 4 分钟',
    icon: Store,
    tone: 'mint',
    pendingNotice: '演示：门店详情尚未接入，当前不展示真实地址、营业时间或库存。',
  },
  {
    id: 'gd-point',
    name: '广电社区服务点（演示）',
    meta: '套餐咨询 · 装维协助 · 筹备中',
    tag: '筹备中',
    icon: Tv,
    tone: 'peach',
    pendingNotice: '演示：广电服务点尚未接入，当前不提供真实咨询或预约。',
  },
  {
    id: 'health-point',
    name: '社区健康体验点',
    meta: '设备体验 · 首批试点',
    tag: '试点',
    icon: HeartPulse,
    tone: 'mint',
    pendingNotice: '演示：健康体验点详情尚未接入，当前不提供真实设备体验预约。',
  },
]

export type PointsTask = {
  id: string
  title: string
  meta: string
  award: string
  icon: LucideIcon
  tone: EntryTone
  state: '已领' | '待完成'
  to?: string
  actionLabel?: string
}

export const pointsTasks: PointsTask[] = [
  {
    id: 'daily-checkin',
    title: '每日签到',
    meta: '低价值行为 · 每日一次（演示）',
    award: '+10',
    icon: CheckCircle2,
    tone: 'peach',
    state: '已领',
  },
  {
    id: 'health-lecture',
    title: '完成健康讲堂 1 节',
    meta: '健康任务 · 完成观看 +20',
    award: '+20',
    icon: BookOpen,
    tone: 'mint',
    state: '待完成',
    to: '/health/lecture',
    actionLabel: '去完成',
  },
  {
    id: 'activity-checkin',
    title: '社区活动到场签到',
    meta: '高价值行为 · 到场签到 +30',
    award: '+30',
    icon: CalendarDays,
    tone: 'mint',
    state: '待完成',
    to: '/community/activity',
    actionLabel: '去参与',
  },
  {
    id: 'bind-device',
    title: '绑定家庭健康设备',
    meta: '高价值行为 · 需真实设备 · +50',
    award: '+50',
    icon: Watch,
    tone: 'peach',
    state: '待完成',
    to: '/me/devices',
    actionLabel: '去绑定',
  },
]

export type PointsTransaction = {
  id: string
  title: string
  meta: string
  amount: number
}

export const pointsTransactions: PointsTransaction[] = [
  {
    id: 'activity',
    title: '社区活动签到',
    meta: '今天 19:42 · 文艺演出',
    amount: 30,
  },
  {
    id: 'checkin',
    title: '每日签到',
    meta: '今天 08:10',
    amount: 10,
  },
  {
    id: 'exchange',
    title: '兑换「洗护套装」',
    meta: '昨天 16:20 · 到店核销',
    amount: -680,
  },
  {
    id: 'lecture',
    title: '健康讲堂观看',
    meta: '昨天 09:30 · 夏日血压观察',
    amount: 20,
  },
]

export const pointsRules = [
  '积分用于鼓励对居民有价值的行为：社区活动到场、健康讲堂学习、真实到店与设备绑定等权重更高，简单签到权重较低。',
  '积分统一为「社区居民权益积分」，不与广电积分、街道积分混用；本原型的余额、任务与明细均为静态示例。',
  '积分兑换仅作原型演示，不扣减真实积分、不生成订单或核销码，也不发放真实券。',
]

export const lifeMapNotice = '演示：服务地图尚未接入，当前不显示真实门店位置。'

export const lifeExchangeNote =
  '积分统一为「社区居民权益积分」，不与广电积分、街道积分混用；兑换品与库存为演示数据。'

export const lifeRedemptionNotice =
  '原型演示：本次兑换不会扣减积分、不会生成订单或核销码，也不会发放真实券。'

export const lifeConceptNote =
  '积分可兑换实物好礼或广电权益；当前商品、库存、门店与权益均为静态演示，不连接支付、订单或发券后台。'
