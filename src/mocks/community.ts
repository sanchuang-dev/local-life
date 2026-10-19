import {
  Bell,
  BookOpen,
  CalendarDays,
  ChessKnight,
  CloudRain,
  Droplets,
  Gift,
  HeartHandshake,
  MapPin,
  Music2,
  RadioTower,
  ShieldAlert,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react'

import type { EntryTone } from './home'

/**
 * Community fixtures ported from the V0.3 `community`, `broadcast`,
 * `activity` and `culture` screens. This module is the single source for the
 * community demo content, so the home community sections and the community
 * pages read the same entries instead of keeping private copies.
 *
 * Everything here is demonstration content: no community, government or
 * emergency service is connected, no notification is sent and no audio
 * recording exists.
 */

/* ------------------------------------------------------------------ notices */

export type CommunityNotice = {
  id: string
  title: string
  meta: string
  tag: string
  tone: 'warn' | 'plain'
  icon: LucideIcon
  source: string
  time: string
  summary: string
  detailNote: string
  /** Featured in the home "社区消息" card. */
  onHome?: boolean
}

export const communityNotices: CommunityNotice[] = [
  {
    id: 'water',
    title: '今晚 20:00–22:00 东片区计划停水',
    meta: '社区公共提醒 · 请提前储水',
    tag: '应急',
    tone: 'warn',
    icon: Droplets,
    source: '应急广播 · 演示来源',
    time: '今天 17:05',
    summary:
      '本条通知用于演示社区消息列表到详情的浏览与返回，不是真实的停水安排。',
    detailNote: '正式的片区范围、起止时间与恢复说明由社区发布后在此展示。',
    onHome: true,
  },
  {
    id: 'welfare',
    title: '周六集体福利领取通知',
    meta: '时间、地点与领取对象请查看详情（示例）',
    tag: '街坊',
    tone: 'plain',
    icon: Gift,
    source: '街坊消息 · 演示来源',
    time: '示例时间 · 以社区正式发布为准',
    summary: '本条为演示消息，用于验证社区消息列表到详情的浏览与返回。',
    detailNote: '正式领取时间、地点与对象范围由社区发布后在此展示。',
    onHome: true,
  },
  {
    id: 'weather',
    title: '雷雨天气提醒',
    meta: '社区通知 · 今天 12:30',
    tag: '通知',
    tone: 'plain',
    icon: CloudRain,
    source: '社区通知 · 演示来源',
    time: '今天 12:30',
    summary: '本条为演示通知，用于验证社区消息列表到详情的浏览与返回。',
    detailNote: '正式的天气预警内容由社区或气象渠道发布后在此展示。',
  },
  {
    id: 'anti-fraud',
    title: '谨防「健康讲座送礼品」类推销',
    meta: '反诈宣传 · 今天 09:10',
    tag: '反诈',
    tone: 'plain',
    icon: ShieldAlert,
    source: '反诈宣传 · 演示来源',
    time: '今天 09:10',
    summary: '本条为演示宣传，用于验证社区消息列表到详情的浏览与返回。',
    detailNote: '正式的反诈内容与举报方式由社区或公安机关发布后在此展示。',
  },
]

export const homeCommunityNotices = communityNotices.filter((notice) => notice.onHome)

/* ---------------------------------------------------------------- broadcasts */

export type CommunityBroadcastPeriod = 'current' | 'today' | 'history'

export type CommunityBroadcast = {
  id: string
  title: string
  time: string
  kind: string
  channel: string
  period: CommunityBroadcastPeriod
  emergency?: boolean
  icon: LucideIcon
  summary: string
  /** Broadcasts that also describe a migrated activity link to its detail. */
  activityTo?: string
}

const broadcastPerformance: CommunityBroadcast = {
  id: 'performance',
  title: '今晚 19:00 篮球场举办社区文艺演出',
  time: '今天 16:20',
  kind: '活动通知',
  channel: '社区喇叭 + 电视大屏（演示）',
  period: 'current',
  icon: RadioTower,
  summary:
    '面向社区播报今晚文艺演出的时间与地点；可继续查看对应活动的详情与签到演示。',
  activityTo: '/community/activity/performance',
}

const broadcastWater: CommunityBroadcast = {
  id: 'water',
  title: '今晚 20:00–22:00 幸福里东片区计划停水',
  time: '今天 17:05',
  kind: '应急广播',
  channel: '应急通道（演示）',
  period: 'today',
  emergency: true,
  icon: ShieldAlert,
  summary:
    '应急通道独立于商业与活动信息，任何积分任务都不会出现在此处。本条为演示内容，未接入任何应急广播体系。',
}

const broadcastAntiFraud: CommunityBroadcast = {
  id: 'anti-fraud',
  title: '反诈提醒：勿信上门推销',
  time: '今天 09:10',
  kind: '反诈宣传',
  channel: '社区喇叭（演示）',
  period: 'today',
  icon: ShieldCheck,
  summary: '提醒居民警惕以健康讲座、赠品为名的上门推销。本条为演示内容。',
}

const broadcastLecture: CommunityBroadcast = {
  id: 'lecture',
  title: '高血压自我管理讲座预告',
  time: '今天 08:00',
  kind: '健康活动',
  channel: '社区喇叭（演示）',
  period: 'today',
  icon: Bell,
  summary:
    '健康讲座预告，具体场次属于健康模块（C04），本条仅作广播列表演示。',
}

export const communityBroadcasts: CommunityBroadcast[] = [
  broadcastPerformance,
  broadcastWater,
  broadcastAntiFraud,
  broadcastLecture,
]

/** The broadcast card shown on the home screen, derived from the same list. */
export type CommunityBroadcastSummary = {
  title: string
  meta: string
  actionLabel: string
  to: string
}

export const communityBroadcastSummary: CommunityBroadcastSummary = {
  title: `刚刚社区广播：${broadcastPerformance.title}`,
  meta: `${broadcastPerformance.time} · 演示来源`,
  actionLabel: '查看广播',
  to: '/community/broadcast',
}

/* ---------------------------------------------------------------- activities */

export type CommunityActivity = {
  id: string
  title: string
  meta: string
  icon: LucideIcon
  tone: EntryTone
  tags?: string[]
  to?: string
  pendingNotice?: string
}

/** The two home-screen scene cards (V0.3 home `今天社区有什么`). */
export const homeCommunityActivities: CommunityActivity[] = [
  {
    id: 'chess',
    title: '象棋友谊赛',
    meta: '14:30 · 余 6 位',
    icon: ChessKnight,
    tone: 'mint',
    to: '/community/activity/chess',
  },
  {
    id: 'dance',
    title: '广场舞教学',
    meta: '19:00 · 免费',
    icon: Music2,
    tone: 'peach',
    to: '/community/activity/dance',
  },
]

/** The `正在发生的社区活动` list on `/community`. */
export const communityActivityList: CommunityActivity[] = [
  {
    id: 'performance',
    title: '社区文艺演出 · 粤曲合唱专场',
    meta: '19:00 · 社区篮球场 · 已报名 128/200',
    tags: ['文艺', '今晚'],
    icon: CalendarDays,
    tone: 'mint',
    to: '/community/activity/performance',
  },
  {
    id: 'health-check',
    title: '免费血压与血糖检测',
    meta: '09:00 · 社区服务中心 · 名额 60，余 18',
    tags: ['健康', '明天'],
    icon: HeartHandshake,
    tone: 'peach',
    pendingNotice:
      '演示：旧版原型只提供文艺演出的示例详情，本条活动尚未迁移详情页。',
  },
  {
    id: 'volunteer',
    title: '社区环境清洁志愿行动',
    meta: '08:30 · 社区服务中心集合 · 志愿服务 +50 积分',
    tags: ['志愿服务', '本周六'],
    icon: Users,
    tone: 'mint',
    pendingNotice:
      '演示：旧版原型只提供文艺演出的示例详情，本条活动尚未迁移详情页。',
  },
]

export type ActivityField = { label: string; value: string }
export type ActivityProgrammeItem = { time: string; title: string }

export type CommunityActivityDetail = {
  id: string
  title: string
  subtitle: string
  tags: string[]
  fields: ActivityField[]
  programme?: ActivityProgrammeItem[]
  /** Only activities with an actual sign-in demo keep this button. */
  signInNotice?: string
  reminderNotice?: string
  footer: string
}

const performanceActivity: CommunityActivityDetail = {
  id: 'performance',
  title: '社区文艺演出 · 粤曲与合唱专场',
  subtitle: '社区活动时间、地点与节目安排',
  tags: ['文艺', '社区活动', '示例活动'],
  fields: [
    { label: '时间', value: '今天 19:00–21:00' },
    { label: '地点', value: '幸福里社区篮球场' },
    { label: '名额', value: '128 / 200（余 72）' },
    { label: '组织方', value: '幸福里社区党群服务中心（演示名称）' },
    { label: '积分', value: '报名 +10 · 到场签到 +30（演示）' },
    { label: '报名状态', value: '已报名，待签到（演示）' },
  ],
  programme: [
    { time: '19:00', title: '开场 · 社区腰鼓队' },
    { time: '19:30', title: '粤曲选段《彩云追月》' },
    { time: '20:10', title: '合唱《我和我的祖国》' },
    { time: '20:40', title: '广场舞互动 + 健康服务台' },
  ],
  signInNotice: '演示：扫码签到不会产生真实签到记录或积分。',
  reminderNotice: '演示：活动提醒不会发送真实通知。',
  footer:
    '本活动为演示数据；实际报名、签到与积分规则以社区正式发布为准。组织方为示例名称，不代表任何真实社区、单位或公职部门。',
}

const welfareDayActivity: CommunityActivityDetail = {
  id: 'welfare-day',
  title: '周末便民服务日',
  subtitle: '广电咨询 · 健康服务 · 社区事务',
  tags: ['便民服务', '周末', '示例活动'],
  fields: [
    { label: '时间', value: '本周六 09:00–12:00（演示）' },
    { label: '地点', value: '幸福里社区中心广场' },
    { label: '服务内容', value: '广电手机卡/宽带咨询、健康检测、社区事务咨询' },
    { label: '组织方', value: '幸福里社区 + 广电服务点（演示名称）' },
    { label: '参与方式', value: '现场参与，无需报名（演示）' },
  ],
  reminderNotice: '演示：活动提醒不会发送真实通知。',
  footer:
    '本活动为演示数据；实际服务项目、时间与地点以社区及广电服务点正式发布为准。',
}

const chessActivity: CommunityActivityDetail = {
  id: 'chess',
  title: '象棋友谊赛',
  subtitle: '社区棋友交流 · 现场报名',
  tags: ['文体', '棋牌', '示例活动'],
  fields: [
    { label: '时间', value: '今天 14:30–16:30（演示）' },
    { label: '地点', value: '幸福里社区活动室 1 楼' },
    { label: '名额', value: '已报名 18 / 24（余 6）' },
    { label: '组织方', value: '社区棋友会（演示名称）' },
    { label: '参与方式', value: '现场报名，先到先得（演示）' },
  ],
  signInNotice: '演示：扫码签到不会产生真实签到记录或积分。',
  reminderNotice: '演示：活动提醒不会发送真实通知。',
  footer:
    '本活动为演示数据；实际赛程、名额与报名方式以社区正式发布为准。',
}

const danceActivity: CommunityActivityDetail = {
  id: 'dance',
  title: '广场舞教学',
  subtitle: '免费教学 · 社区广场',
  tags: ['文体', '舞蹈', '示例活动'],
  fields: [
    { label: '时间', value: '今天 19:00–20:00（演示）' },
    { label: '地点', value: '幸福里社区中心广场' },
    { label: '费用', value: '免费（演示）' },
    { label: '组织方', value: '社区文体队（演示名称）' },
    { label: '参与方式', value: '现场参与，无需报名（演示）' },
  ],
  reminderNotice: '演示：活动提醒不会发送真实通知。',
  footer:
    '本活动为演示数据；实际教学安排、时间与地点以社区正式发布为准。',
}

/**
 * Activity details keyed by the id in `/community/activity/:activityId`.
 * `/community/activity` without an id keeps the original performance detail.
 */
export const communityActivityDetails: CommunityActivityDetail[] = [
  performanceActivity,
  welfareDayActivity,
  chessActivity,
  danceActivity,
]

export const defaultCommunityActivityDetail = performanceActivity

/* ----------------------------------------------------------- culture courses */

export type CultureCourseStatusTone = 'open' | 'plain' | 'warn'

export type CultureCourse = {
  id: string
  title: string
  schedule: string
  organiser: string
  /** Matched against the filter chips; courses without a category appear under 全部. */
  category?: string
  status: string
  statusTone: CultureCourseStatusTone
  icon: LucideIcon
}

export const cultureCategories = ['全部', '书法', '太极', '合唱', '粤曲']

export const cultureCourses: CultureCourse[] = [
  {
    id: 'calligraphy',
    title: '书法班 · 楷书入门',
    schedule: '每周二、四 09:00–11:00 · 文化中心 2 楼书画室',
    organiser: '组织方：社区党群服务中心（演示名称） · 名额 24（余 5）',
    category: '书法',
    status: '可报名',
    statusTone: 'open',
    icon: BookOpen,
  },
  {
    id: 'taichi',
    title: '太极拳晨练',
    schedule: '每天 06:30–07:30 · 社区广场',
    organiser: '组织方：社区文体队（演示名称） · 无需报名',
    category: '太极',
    status: '自由参加',
    statusTone: 'plain',
    icon: Users,
  },
  {
    id: 'chorus',
    title: '合唱团排练',
    schedule: '每周三 15:00–17:00 · 文化中心礼堂',
    organiser: '组织方：社区合唱团（演示名称） · 名额 40（已满）',
    category: '合唱',
    status: '名额已满',
    statusTone: 'plain',
    icon: Music2,
  },
  {
    id: 'lecture',
    title: '文化讲座 · 老年营养与三餐',
    schedule: '本周六 15:00 · 文化中心多功能厅',
    organiser: '组织方：社区 + 健康服务方（演示名称，科普性质） · 名额 60',
    status: '筹备中',
    statusTone: 'warn',
    icon: HeartHandshake,
  },
]

/* -------------------------------------------------------------- hub entries */

export type CommunityEntry = {
  id: string
  label: string
  badge?: string
  icon: LucideIcon
  tone: EntryTone
  to?: string
  pendingNotice?: string
}

export const communityEntries: CommunityEntry[] = [
  {
    id: 'broadcast',
    label: '社区广播',
    badge: '今日 4 条',
    icon: RadioTower,
    tone: 'mint',
    to: '/community/broadcast',
  },
  {
    id: 'activity',
    label: '社区活动',
    badge: '3 场示例',
    icon: CalendarDays,
    tone: 'peach',
    to: '/community/activity/performance',
  },
  {
    id: 'culture',
    label: '党群文化中心',
    badge: '演示排期',
    icon: Users,
    tone: 'mint',
    to: '/community/culture',
  },
  {
    id: 'elder',
    label: '助老服务',
    badge: '部分筹备中',
    icon: HeartHandshake,
    tone: 'peach',
    pendingNotice: '演示：助老服务在首批试点名单内，尚未接入。',
  },
  {
    id: 'map',
    label: '服务地图',
    icon: MapPin,
    tone: 'mint',
    pendingNotice: '演示：服务地图尚未接入。',
  },
]
