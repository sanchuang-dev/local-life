import { useLocation } from 'react-router'

const backLabels: Record<string, string> = {
  '/': '返回首页',
  '/me': '返回我的',
  '/gd': '返回广电服务',
  '/community': '返回社区',
  '/community/broadcast': '返回社区广播',
  '/health': '返回健康服务',
  '/life': '返回惠生活',
  '/life/exchange': '返回积分兑换',
  '/points': '返回我的积分',
}

/**
 * Shared sub-pages can be entered from more than one module. Internal links may
 * pass `state={{ from: '/me' }}` so the back affordance returns to the module the
 * visitor actually came from; direct visits fall back to the page's own parent.
 */
export function useBackTarget(fallbackTo: string, fallbackLabel: string) {
  const { state } = useLocation()
  const from = (state as { from?: unknown } | null)?.from
  const candidate =
    typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')
      ? from
      : undefined
  const backTo = candidate ?? fallbackTo

  return { backTo, backLabel: backLabels[backTo] ?? fallbackLabel }
}
