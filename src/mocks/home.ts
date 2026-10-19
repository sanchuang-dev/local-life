import {
  Bell,
  BookOpen,
  CalendarDays,
  ChessKnight,
  Droplets,
  FileText,
  Gift,
  HeartHandshake,
  HeartPulse,
  Music2,
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
  pendingNotice: '演示：活动详情与报名页面将在 C03 接入，当前不能报名。',
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
    pendingNotice: '演示：社区广播页面将在 C03 接入。',
  },
  {
    id: 'health',
    label: '健康服务',
    icon: HeartPulse,
    tone: 'peach',
    pendingNotice: '演示：健康服务页面将在 C04 接入。',
  },
  {
    id: 'culture',
    label: '党群文化',
    icon: Users,
    tone: 'mint',
    pendingNotice: '演示：党群文化页面将在 C03 接入。',
  },
  {
    id: 'activity',
    label: '社区活动',
    icon: CalendarDays,
    tone: 'peach',
    pendingNotice: '演示：社区活动页面将在 C03 接入。',
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

export type CommunityBroadcastContent = {
  title: string
  meta: string
  actionLabel: string
  pendingNotice: string
}

export const communityBroadcast: CommunityBroadcastContent = {
  title: '刚刚社区广播：今晚 19:00 篮球场有文艺演出',
  meta: '今天 16:20 · 幸福里社区党群服务中心',
  actionLabel: '重听',
  pendingNotice: '演示：广播重听需要 C03 广播页面与音频能力，当前不可播放。',
}

export type CommunityNotice = {
  id: string
  title: string
  meta: string
  tag: string
  tone: 'warn' | 'plain'
  icon: LucideIcon
  pendingNotice: string
}

export const communityNotices: CommunityNotice[] = [
  {
    id: 'water',
    title: '今晚 20:00–22:00 东片区计划停水',
    meta: '社区公共提醒 · 请提前储水',
    tag: '通知',
    tone: 'warn',
    icon: Droplets,
    pendingNotice: '演示：通知详情尚未接入。',
  },
  {
    id: 'welfare',
    title: '周六集体福利领取通知',
    meta: '时间、地点与领取对象请查看详情（示例）',
    tag: '街坊',
    tone: 'plain',
    icon: Gift,
    pendingNotice: '演示：通知详情尚未接入。',
  },
]

export type CommunityActivity = {
  id: string
  title: string
  meta: string
  icon: LucideIcon
  tone: EntryTone
  pendingNotice: string
}

export const communityActivities: CommunityActivity[] = [
  {
    id: 'chess',
    title: '象棋友谊赛',
    meta: '14:30 · 余 6 位',
    icon: ChessKnight,
    tone: 'mint',
    pendingNotice: '演示：活动详情与报名将在 C03 接入。',
  },
  {
    id: 'dance',
    title: '广场舞教学',
    meta: '19:00 · 免费',
    icon: Music2,
    tone: 'peach',
    pendingNotice: '演示：活动详情与报名将在 C03 接入。',
  },
]
