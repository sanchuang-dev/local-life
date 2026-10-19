import {
  Coins,
  FileText,
  Headphones,
  MapPin,
  Package,
  Star,
  Tv,
  Users,
  Watch,
  type LucideIcon,
} from 'lucide-react'

import type { EntryTone } from './home'
import { lifePoints } from './life'

/**
 * "Me" fixtures ported from the V0.3 `me` screen.
 *
 * The profile, activity/coupon counts, services and settings are demonstration
 * content only. No account, order, coupon, family or customer-service backend is
 * connected, and the points value comes from the shared life fixture so there is
 * only one demo balance in the project.
 */

export const meProfile = {
  name: '张阿姨',
  community: '示例用户 · 幸福里社区 · 已实名（演示）',
  tag: '普通会员',
} as const

export type MeStat = {
  id: string
  label: string
  value: string
  tone: EntryTone
  to?: string
  pendingNotice?: string
}

export const meStats: MeStat[] = [
  {
    id: 'points',
    label: '积分',
    value: String(lifePoints.current),
    tone: 'peach',
    to: '/points',
  },
  {
    id: 'activities',
    label: '我的活动',
    value: '3',
    tone: 'mint',
    pendingNotice: '演示：我的活动尚未接入，当前不展示真实报名、签到或参与记录。',
  },
  {
    id: 'coupons',
    label: '优惠券',
    value: '2',
    tone: 'mint',
    pendingNotice: '演示：优惠券尚未接入，当前不发放、不核销也不展示真实券码。',
  },
]

export type MeServiceItem = {
  id: string
  label: string
  meta?: string
  icon: LucideIcon
  tone: EntryTone
  to?: string
  pendingNotice?: string
}

export const meServices: MeServiceItem[] = [
  {
    id: 'points',
    label: '我的积分',
    meta: '余额、明细与任务',
    icon: Coins,
    tone: 'peach',
    to: '/points',
  },
  {
    id: 'devices',
    label: '我的设备',
    meta: '家庭健康设备与绑定',
    icon: Watch,
    tone: 'mint',
    to: '/me/devices',
  },
  {
    id: 'gd',
    label: '广电服务',
    meta: '手机卡、宽带、电视与上门服务（筹备中）',
    icon: Tv,
    tone: 'peach',
    to: '/gd',
  },
  {
    id: 'orders',
    label: '我的订单',
    meta: '兑换记录与核销状态',
    icon: Package,
    tone: 'mint',
    pendingNotice: '演示：我的订单尚未接入，当前不展示真实兑换、支付或核销记录。',
  },
  {
    id: 'archive',
    label: '健康档案',
    meta: '历史数据与家庭成员',
    icon: FileText,
    tone: 'mint',
    pendingNotice: '演示：健康档案尚未接入，当前不读取或保存任何个人健康信息。',
  },
  {
    id: 'favorites',
    label: '我的收藏',
    meta: '内容与服务',
    icon: Star,
    tone: 'peach',
    pendingNotice: '演示：我的收藏尚未接入，当前不保存任何收藏内容。',
  },
]

export const meSettings: MeServiceItem[] = [
  {
    id: 'family',
    label: '家庭成员',
    icon: Users,
    tone: 'mint',
    pendingNotice: '演示：家庭成员尚未接入，当前不采集或保存任何成员信息。',
  },
  {
    id: 'address',
    label: '地址管理',
    icon: MapPin,
    tone: 'peach',
    pendingNotice: '演示：地址管理尚未接入，当前不采集或保存任何地址。',
  },
  {
    id: 'support',
    label: '客服',
    meta: '工作日 09:00–18:00（演示）',
    icon: Headphones,
    tone: 'mint',
    pendingNotice: '演示：客服尚未接入，当前不会发起在线会话或电话。',
  },
]

export type DemoIndexEntry = {
  label: string
  to: string
}

export type DemoIndexGroup = {
  id: string
  title: string
  entries: DemoIndexEntry[]
}

/**
 * Temporary page index for browsing the migrated V0.3 screens. It exists so the
 * five historical modules stay reachable for review and product reduction
 * discussions; it is not a proposal for the new navigation.
 */
export const demoIndexGroups: DemoIndexGroup[] = [
  {
    id: 'home',
    title: '首页',
    entries: [
      { label: '首页', to: '/' },
      { label: '广电服务', to: '/gd' },
    ],
  },
  {
    id: 'community',
    title: '社区',
    entries: [
      { label: '社区首页', to: '/community' },
      { label: '社区广播', to: '/community/broadcast' },
      { label: '活动详情', to: '/community/activity/performance' },
      { label: '党群文化中心', to: '/community/culture' },
      { label: '消息详情', to: '/community/notice/water' },
    ],
  },
  {
    id: 'health',
    title: '健康',
    entries: [
      { label: '健康服务', to: '/health' },
      { label: '社区助手', to: '/health/assistant' },
      { label: '魔镜健康终端', to: '/health/device' },
      { label: '健康讲堂', to: '/health/lecture' },
      { label: '我的设备', to: '/me/devices' },
    ],
  },
  {
    id: 'life',
    title: '惠生活',
    entries: [
      { label: '惠生活', to: '/life' },
      { label: '积分兑换', to: '/life/exchange' },
      { label: '商品详情', to: '/life/product/rice-5kg' },
      { label: '我的积分', to: '/points' },
    ],
  },
  {
    id: 'me',
    title: '我的',
    entries: [
      { label: '我的', to: '/me' },
      { label: '我的积分', to: '/points' },
      { label: '我的设备', to: '/me/devices' },
    ],
  },
]

export const meDemoNote =
  '本页依据 V0.3 我的页迁移，用户、积分、活动、优惠券、设备与设置均为示例；未接入账号、订单、优惠券、家庭成员或客服服务。'
