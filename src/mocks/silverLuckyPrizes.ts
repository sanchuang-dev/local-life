/** Six reusable draw assets in one 6-column WebP strip, and a 3 × 3 ring. */
export const luckyPrizes = [
  { id: 'eggs', name: '鸡蛋兑换券', level: '四等奖', imageIndex: 0 },
  { id: 'tissues', name: '生活纸品', level: '三等奖', imageIndex: 1 },
  { id: 'coupon', name: '本地体验券', level: '二等奖', imageIndex: 2 },
  { id: 'device', name: '惊喜硬件礼包', level: '一等奖', imageIndex: 3 },
  { id: 'gift', name: '社区小礼物', level: '五等奖', imageIndex: 4 },
  { id: 'thanks', name: '谢谢参与', level: '参与奖', imageIndex: 5 },
] as const

export type LuckyPrize = (typeof luckyPrizes)[number]

// Eight positions around the central CTA; duplicate items are visual only.
export const luckyGridSlots: readonly (number | null)[] = [
  0, 1, 2,
  4, null, 3,
  5, 2, 1,
]
