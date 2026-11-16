/** A missing daily aggregate stays unknown; a confirmed zero remains a zero. */
export interface DailyLedgerPoint {
  day: string
  receivedCents: number | null
  reversedCents: number | null
}

/** Business-day boundaries are defined by the ledger contract (Asia/Shanghai). */
export function recentShanghaiBusinessDays(now = new Date()): string[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const today = Date.UTC(field('year'), field('month') - 1, field('day'))
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today - (6 - index) * 86_400_000)
    return [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ].join('-')
  })
}
