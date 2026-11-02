import {
  Activity,
  FileText,
  Gauge,
  Headphones,
  HeartPulse,
  LineChart,
  Radio,
  ScanFace,
  Sparkles,
  Video,
  Watch,
  type LucideIcon,
} from 'lucide-react'

import type { EntryTone } from './home'

/**
 * Health fixtures ported from the V0.3 `health`, `ai`, `device`, `lecture` and
 * `mydevices` screens. This module is the only source for the health demo
 * content.
 *
 * Everything here is demonstration content: no personal health record is
 * collected, no device is paired, no video/audio is streamed and no AI service
 * is called. The sample values must never be presented as medical guidance.
 */

export type HealthDeviceEntry = {
  id: string
  label: string
  icon: LucideIcon
  tone: EntryTone
  pendingNotice: string
}

export const healthDeviceEntries: HealthDeviceEntry[] = [
  {
    id: 'mirror',
    label: '魔镜',
    icon: ScanFace,
    tone: 'mint',
    pendingNotice: '演示：魔镜绑定流程尚未接入，当前不会连接或读取任何真实设备。',
  },
  {
    id: 'pressure',
    label: '血压计',
    icon: Gauge,
    tone: 'mint',
    pendingNotice: '演示：血压计绑定流程尚未接入，当前不会同步任何测量数据。',
  },
  {
    id: 'oxygen',
    label: '血氧仪',
    icon: HeartPulse,
    tone: 'peach',
    pendingNotice: '演示：血氧仪绑定流程尚未接入，当前不会同步任何测量数据。',
  },
  {
    id: 'band',
    label: '手环',
    icon: Watch,
    tone: 'peach',
    pendingNotice: '演示：手环绑定流程尚未接入，当前不会同步睡眠或步数数据。',
  },
]

export type HealthMetric = {
  id: string
  value: string
  unit: string
  label: string
  note: string
}

export const healthMetrics: HealthMetric[] = [
  {
    id: 'pressure',
    value: '128',
    unit: '/ 82',
    label: '最近血压 mmHg',
    note: '示例值',
  },
  {
    id: 'sleep',
    value: '7',
    unit: '小时',
    label: '昨夜睡眠',
    note: '示例值',
  },
]

export const healthArchiveNote =
  '数据为演示值，来自尚未接入的示例设备；不构成医学判断，也不能作为健康决策依据。'

/* --------------------------------------------------------------- assistant */

export type HealthAssistantMessage = {
  id: string
  from: 'assistant' | 'visitor'
  lines: string[]
}

export const healthAssistant = {
  title: '社区助手',
  subtitle: '问活动、问积分、问健康、找广电服务——一句话就行',
  disclaimer:
    '当前为演示应答；健康问题只提供日常信息，不提供疾病诊断或治疗建议。',
  privacyNote:
    '演示不采集、不上传或保存任何输入内容。请勿在此填写姓名、病历、用药或检查结果等个人健康信息。',
  sampleMessages: [
    {
      id: 'welcome',
      from: 'assistant',
      lines: [
        '您好，我是社区助手。可以帮您查社区活动、看积分、找附近服务，也能陪您了解日常健康知识。想先问点什么？',
      ],
    },
    {
      id: 'question',
      from: 'visitor',
      lines: ['今天社区有什么活动？'],
    },
    {
      id: 'answer',
      from: 'assistant',
      lines: [
        '今天有两场：',
        '1. 象棋友谊赛 14:30，社区服务中心一层，余 6 位；',
        '2. 社区文艺演出 19:00，社区篮球场，可现场签到得积分。',
        '要我帮您报名象棋赛吗？',
      ],
    },
  ] satisfies HealthAssistantMessage[],
  quickQuestions: ['我的积分有多少', '最近检测结果', '附近有哪些服务', '今天有健康讲座吗'],
  inputPlaceholder: '输入问题（勿填个人健康信息）',
  sendNotice:
    '演示：社区助手尚未接入，问题不会发送、不会保存，也不会产生真实回复或健康建议。',
} as const

/* ------------------------------------------------------------------ device */

export const healthMirror = {
  title: '魔镜 · AI 健康终端',
  subtitle: '家庭健康设备的统一入口之一。具体能力以未来真实硬件、算法与服务商为准。',
  tags: ['演示设备', '尚未绑定'],
  description: '当前没有可连接的设备，绑定流程为演示入口。',
  bindNotice: '演示：设备绑定流程尚未接入，不会搜索、配对或读取任何硬件。',
} as const

export type HealthCapability = {
  id: string
  title: string
  meta: string
  icon: LucideIcon
}

export const mirrorCapabilities: HealthCapability[] = [
  { id: 'skin', title: '面部皮肤分析', meta: '示例能力说明', icon: ScanFace },
  { id: 'vitals', title: '心率 / 血氧', meta: '需真实硬件支持', icon: HeartPulse },
  { id: 'body', title: '体脂与状态评分', meta: '评分口径待确定', icon: Activity },
  { id: 'trend', title: '健康趋势', meta: '依赖长期数据积累', icon: LineChart },
]

export const healthDeviceDisclaimer =
  '本页不提供疾病诊断、医学治疗效果、寿命预测或医学意义的衰老诊断。所有健康数值均为演示数据，不作健康决策依据。'

/* ----------------------------------------------------------------- lecture */

export type HealthLectureCategory = '科普' | '商业内容' | '直播'

export type HealthLectureFilter = '全部' | HealthLectureCategory

export const healthLectureFilters: HealthLectureFilter[] = ['全部', '科普', '商业内容', '直播']

export type HealthLectureItem = {
  id: string
  title: string
  categories: HealthLectureCategory[]
  format: string
  meta: string
  icon: LucideIcon
  tone: EntryTone
  summary?: string
  /** Completed-status hint on the lecture card. */
  progress?: string
  actionLabel?: string
  pendingNotice?: string
}

export const healthLectures: HealthLectureItem[] = [
  {
    id: 'summer-pressure',
    title: '中老年人夏季血压波动的日常观察',
    categories: ['科普'],
    format: '视频',
    meta: '8 分钟 · 完成观看 +20 积分（演示）',
    icon: Video,
    tone: 'mint',
    progress: '已看完（示例）',
  },
  {
    id: 'bedtime-stretch',
    title: '睡前十分钟拉伸，改善入睡',
    categories: ['科普'],
    format: '音频',
    meta: '12 分钟 · 完成收听 +20 积分（演示）',
    icon: Headphones,
    tone: 'mint',
    actionLabel: '开始收听',
    pendingNotice:
      '演示：本页没有音频资源，不能真实播放；也不会记录收听进度或发放积分。',
  },
  {
    id: 'live-therapy',
    title: '健康服务商直播 · 家庭理疗体验',
    categories: ['商业内容', '直播'],
    format: '直播',
    meta: '今晚 20:00 · 商业推广内容',
    icon: Radio,
    tone: 'peach',
    summary:
      '本场为商业推广，含商品与服务推荐，与社区、广电公共服务无关，不代表任何官方医疗背书。',
    actionLabel: '预约直播',
    pendingNotice: '演示：直播预约尚未接入，不会创建提醒、预约或订单记录。',
  },
  {
    id: 'medicine-kit',
    title: '家庭药箱该放什么、多久清理一次',
    categories: ['科普'],
    format: '图文',
    meta: '5 分钟 · 完成阅读 +20 积分（演示）',
    icon: FileText,
    tone: 'mint',
  },
]

/** The two V0.3 health-home lecture previews. */
export const healthLecturePreview = healthLectures.filter((item) =>
  ['summer-pressure', 'bedtime-stretch'].includes(item.id),
)

export const healthLectureNote =
  '讲堂内容中，科普、商业内容与直播均已分别标识，便于区分；内容为原型示例，不构成医疗建议。'

/* ----------------------------------------------------------------- devices */

export type DemoHealthDevice = {
  id: string
  name: string
  meta: string
  icon: LucideIcon
  state: '未绑定' | '示例'
  actionLabel?: string
  pendingNotice?: string
}

export const demoHealthDevices: DemoHealthDevice[] = [
  {
    id: 'mirror',
    name: '魔镜 · AI 健康终端',
    meta: '未绑定 · 能力与算法以真实硬件为准',
    icon: ScanFace,
    state: '未绑定',
    actionLabel: '绑定',
    pendingNotice: '演示：绑定流程尚未接入，不会连接或读取真实设备。',
  },
  {
    id: 'pressure',
    name: '电子血压计',
    meta: '最近同步：示例 · 今天 07:20',
    icon: Gauge,
    state: '示例',
  },
  {
    id: 'band',
    name: '智能手环',
    meta: '睡眠与步数（示例数据）',
    icon: Watch,
    state: '示例',
  },
]

export const supportedHealthDevices = [
  '魔镜',
  '血压计',
  '血氧仪',
  '体脂秤',
  '手环',
  '摄像头',
  '睡眠设备',
]

export const addDeviceNotice =
  '演示：添加设备流程尚未接入，不会搜索或绑定任何真实硬件。'

/* --------------------------------------------------------- shared previews */

export const healthAssistantEntry = {
  title: '社区助手',
  icon: Sparkles,
  subtitle: '问活动、问积分、问健康、找广电服务',
  actionLabel: '开始对话',
  to: '/health/assistant',
} as const
