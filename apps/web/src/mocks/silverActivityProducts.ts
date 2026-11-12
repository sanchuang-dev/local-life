/** Activity product/service showcase: no live SKUs, prices, sales or qualifying orders. */
export type SilverActivityProductCategory = '电视娱乐' | '家庭网络' | '智能硬件' | '魔镜体验'
export const silverActivityProductCategories = ['全部', '电视娱乐', '家庭网络', '智能硬件', '魔镜体验'] as const
export type SilverActivityProductKind = 'tv' | 'box' | 'membership' | 'broadband' | 'bundle' | 'install' | 'smart-home' | 'screen' | 'mirror' | 'mirror-service'
export type SilverActivityProduct = {
  id: string
  name: string
  category: SilverActivityProductCategory
  kind: SilverActivityProductKind
  short: string
  intro: string
  includes: readonly string[]
  relatedPath: '/gd' | '/health/device'
  tag: string
}
export const silverActivityProducts: SilverActivityProduct[] = [
  {
    id: 'digital-tv', name: '家庭数字电视服务', category: '电视娱乐', kind: 'tv',
    short: '电视节目与家庭大屏服务', tag: '广电服务',
    intro: '广电电视服务方向的活动展示，具体频道、资费和办理条件以后续合作方案为准。',
    includes: ['电视节目与大屏服务展示', '套餐及会员权益咨询方向', '安装和售后服务方向'],
    relatedPath: '/gd',
  },
  {
    id: 'tv-settop-box', name: '高清电视机顶盒', category: '电视娱乐', kind: 'box',
    short: '家庭电视终端体验', tag: '硬件展示',
    intro: '机顶盒与家庭电视终端展示，并不代表已有指定硬件型号或可领取设备。',
    includes: ['电视终端场景介绍', '设备连接与使用说明方向', '具体型号、规格待确定'],
    relatedPath: '/gd',
  },
  {
    id: 'tv-membership', name: '电视会员权益', category: '电视娱乐', kind: 'membership',
    short: '家庭影音会员方案', tag: '权益方案',
    intro: '面向家庭的广电电视会员和内容权益展示，具体会员权益未配置。',
    includes: ['电视会员权益概念', '家庭大屏内容服务方向', '套餐组合待确认'],
    relatedPath: '/gd',
  },
  {
    id: 'home-broadband', name: '广电家庭宽带', category: '家庭网络', kind: 'broadband',
    short: '家庭上网与宽带服务', tag: '广电服务',
    intro: '现有广电页面的宽带业务方向，展示新装、提速、套餐和故障服务范围。',
    includes: ['家庭宽带新装咨询', '宽带套餐及提速方向', '实际覆盖与资费待确认'],
    relatedPath: '/gd',
  },
  {
    id: 'family-bundle', name: '家庭融合套餐', category: '家庭网络', kind: 'bundle',
    short: '宽带 + 电视 + 手机卡', tag: '组合方案',
    intro: '复用广电服务现有家庭融合套餐概念，内容权益和办理规则尚在筹备。',
    includes: ['家庭宽带', '电视服务', '手机卡套餐方向'],
    relatedPath: '/gd',
  },
  {
    id: 'installation-service', name: '家庭电视安装服务', category: '家庭网络', kind: 'install',
    short: '安装调试、使用教学与协助', tag: '便民服务',
    intro: '现有广电页面的上门服务方向，活动内只展示服务内容，不接受真实预约。',
    includes: ['电视及网络设备安装调试', '长者使用教学方向', '维修与售后协助方向'],
    relatedPath: '/gd',
  },
  {
    id: 'smart-home-bundle', name: '智能家居体验礼包', category: '智能硬件', kind: 'smart-home',
    short: '家庭设备联动场景展示', tag: '体验好物',
    intro: '对应活动页已有的广电智能家居礼包展示方向，非真实可购买或可领取的商品。',
    includes: ['智能家庭应用场景', '设备联动体验方向', '硬件清单与权益待确认'],
    relatedPath: '/gd',
  },
  {
    id: 'smart-display', name: '家庭智能显示屏', category: '智能硬件', kind: 'screen',
    short: '家庭信息与生活服务终端', tag: '概念硬件',
    intro: '概念硬件展示，不对应已确定的产品型号、品牌、供应商或实际售价。',
    includes: ['家庭信息显示场景', '社区服务入口展示方向', '终端规格与供应待确认'],
    relatedPath: '/gd',
  },
  {
    id: 'magic-mirror', name: '魔镜 AI 健康终端', category: '魔镜体验', kind: 'mirror',
    short: '智能设备与健康生活体验', tag: '魔镜体验',
    intro: '复用现有魔镜健康终端原型，尚未接入真实硬件、绑定或检测。',
    includes: ['魔镜终端能力介绍', '家庭健康设备入口演示', '具体算法与硬件能力待验证'],
    relatedPath: '/health/device',
  },
  {
    id: 'mirror-experience', name: '魔镜健康体验服务', category: '魔镜体验', kind: 'mirror-service',
    short: '互动体验与功能展示', tag: '体验服务',
    intro: '展示魔镜未来可能支持的体验方向，不提供医学诊断或真实健康检测。',
    includes: ['面部皮肤分析概念展示', '健康趋势与设备能力介绍', '不生成真实检测数据或健康结论'],
    relatedPath: '/health/device',
  },
]
