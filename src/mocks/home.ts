import {
  Bell,
  BookOpen,
  CalendarDays,
  FileText,
  HeartHandshake,
  HeartPulse,
  Phone,
  Plus,
  RadioTower,
  Truck,
  Tv,
  Users,
  UsersRound,
  UtensilsCrossed,
  Wifi,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

/**
 * Home fixtures ported from the V0.3 home screen.
 * They are demonstration content only; no service or API is connected.
 * Community messages/broadcasts/activities now live in `community.ts`.
 */

export type EntryTone = 'mint' | 'peach'

export type ServiceEntry = {
  id: string
  label: string
  icon: LucideIcon
  tone: EntryTone
  to?: string
  pendingNotice?: string
}

export type HomeBannerContent = {
  location: string
  eyebrow: string
  title: string
  description: string
  actionLabel: string
  pendingNotice: string
}

export const homeBanner: HomeBannerContent = {
  location: '幸福街道 · 幸福里社区',
  eyebrow: '本周重点',
  title: '周末便民服务日',
  description: '广电手机卡、宽带咨询，社区活动和健康服务一次看齐。',
  actionLabel: '查看活动',
  pendingNotice: '演示：便民服务日的活动详情尚未迁移，当前不能报名。',
}

export type GdQuickEntry = {
  id: string
  label: string
  icon: LucideIcon
}

/** The four V0.3 home shortcuts all lead to the single `/gd` display page. */
export const homeGdEntries: GdQuickEntry[] = [
  { id: 'mobile', label: '手机卡', icon: Phone },
  { id: 'broadband', label: '宽带', icon: Wifi },
  { id: 'tv', label: '电视', icon: Tv },
  { id: 'onsite', label: '上门服务', icon: Truck },
]

export const homeQuickEntries: ServiceEntry[] = [
  {
    id: 'broadcast',
    label: '社区广播',
    icon: RadioTower,
    tone: 'mint',
    to: '/community/broadcast',
  },
  {
    id: 'health',
    label: '健康服务',
    icon: HeartPulse,
    tone: 'peach',
    to: '/health',
  },
  {
    id: 'culture',
    label: '党群文化',
    icon: Users,
    tone: 'mint',
    to: '/community/culture',
  },
  {
    id: 'activity',
    label: '社区活动',
    icon: CalendarDays,
    tone: 'peach',
    to: '/community',
  },
]

export const homeMoreServices: ServiceEntry[] = [
  {
    id: 'learning',
    label: '学习服务',
    icon: BookOpen,
    tone: 'peach',
    pendingNotice: '演示：学习服务尚未接入，内容可按街道配置。',
  },
  {
    id: 'guide',
    label: '办事指引',
    icon: FileText,
    tone: 'mint',
    pendingNotice: '演示：办事指引尚未接入。',
  },
  {
    id: 'canteen',
    label: '社区食堂',
    icon: UtensilsCrossed,
    tone: 'peach',
    pendingNotice: '演示：社区食堂尚未接入。',
  },
  {
    id: 'neighbour-news',
    label: '街坊消息',
    icon: Bell,
    tone: 'mint',
    pendingNotice: '演示：街坊消息尚未接入。',
  },
  {
    id: 'elder-care',
    label: '助老服务',
    icon: HeartHandshake,
    tone: 'peach',
    pendingNotice: '演示：助老服务尚未接入。',
  },
  {
    id: 'volunteer',
    label: '志愿服务',
    icon: UsersRound,
    tone: 'mint',
    pendingNotice: '演示：志愿服务尚未接入。',
  },
  {
    id: 'repair',
    label: '便民维修',
    icon: Wrench,
    tone: 'peach',
    pendingNotice: '演示：便民维修尚未接入。',
  },
  {
    id: 'more',
    label: '更多',
    icon: Plus,
    tone: 'mint',
    pendingNotice: '演示：更多服务尚未配置。',
  },
]
