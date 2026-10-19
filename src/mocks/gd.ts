import {
  FileText,
  Smartphone,
  Ticket,
  Truck,
  Tv,
  Wifi,
  type LucideIcon,
} from 'lucide-react'

/**
 * GD (broadcasting network) fixtures ported from the V0.3 `gd` screen.
 * All services are demonstrations; no carrier or billing API is connected.
 */

export type GdService = {
  id: string
  label: string
  description: string
  icon: LucideIcon
  pendingNotice: string
}

export const gdServices: GdService[] = [
  {
    id: 'mobile',
    label: '手机卡',
    description: '选号 / 套餐 / 新办 / 业务咨询',
    icon: Smartphone,
    pendingNotice: '演示：手机卡办理尚未接入广电合作接口。',
  },
  {
    id: 'broadband',
    label: '宽带',
    description: '新装 / 提速 / 套餐 / 故障服务',
    icon: Wifi,
    pendingNotice: '演示：宽带办理尚未接入广电合作接口。',
  },
  {
    id: 'tv',
    label: '电视',
    description: '电视套餐 / 会员 / 机顶盒服务',
    icon: Tv,
    pendingNotice: '演示：电视服务尚未接入广电合作接口。',
  },
  {
    id: 'onsite',
    label: '上门服务',
    description: '安装 / 教学 / 维修 / 售后协助',
    icon: Truck,
    pendingNotice: '演示：上门服务预约尚未接入。',
  },
]

export const gdPackage = {
  title: '家庭融合套餐',
  subtitle: '宽带 + 电视 + 手机卡 · 示例方案',
  status: '筹备中',
  features: [
    { label: '套餐查看', value: '可查看权益结构（演示）' },
    { label: '套餐升级', value: '暂未开放' },
    { label: '家庭服务权益', value: '规划中' },
  ],
  actionLabel: '查看套餐权益',
  pendingNotice: '演示：套餐详情尚未接入广电接口。',
}

export type GdMyService = {
  id: string
  label: string
  meta: string
  icon: LucideIcon
  pendingNotice: string
}

export const gdMyServices: GdMyService[] = [
  {
    id: 'records',
    label: '上门服务记录',
    meta: '暂无记录',
    icon: FileText,
    pendingNotice: '演示：服务记录需要合作接口，当前没有真实记录。',
  },
  {
    id: 'rights',
    label: '我的广电权益',
    meta: '会员、套餐与活动权益',
    icon: Ticket,
    pendingNotice: '演示：广电权益数据尚未接入。',
  },
]

export const gdBroadcastNotice =
  '演示：社区广播页面将在 C03 接入，当前无法查看广播列表。'
