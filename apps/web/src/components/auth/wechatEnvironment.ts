/** Official account OAuth is initiated inside WeChat's embedded browser. */
export function isWeChatBrowser(userAgent: string): boolean {
  return /MicroMessenger/i.test(userAgent)
}

/** Preserve deep links, invitation parameters and HashRouter location in local preview. */
export function developmentPreviewUrl(href: string): string {
  const url = new URL(href)
  url.searchParams.set('previewApp', '1')
  return url.href
}

/** The resident H5 has a WeChat-only entry. Staff workbench stays browser-accessible. */
export function shouldShowWeChatGate(options: {
  userAgent: string
  pathname: string
  search: string
  isDevelopment: boolean
  previewSessionEnabled?: boolean
}): boolean {
  const { userAgent, pathname, search, isDevelopment, previewSessionEnabled } = options
  if (pathname === '/workbench' || pathname.startsWith('/workbench/')) return false
  // Local-only switch for design iteration, including routes reached after login.
  if (isDevelopment && (previewSessionEnabled || new URLSearchParams(search).get('previewApp') === '1')) return false
  return !isWeChatBrowser(userAgent)
}
