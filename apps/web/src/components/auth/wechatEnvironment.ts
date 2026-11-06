/** Official account OAuth is initiated inside WeChat's embedded browser. */
export function isWeChatBrowser(userAgent: string): boolean {
  return /MicroMessenger/i.test(userAgent)
}
