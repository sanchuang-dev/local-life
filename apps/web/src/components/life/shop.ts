/**
 * Presentation helpers for real CRMEB product data.
 *
 * Amounts come from the adapter as integer cents (contract: `priceCents`), so the
 * H5 never re-parses upstream decimal strings with `Number()`/`parseFloat()`.
 */

/** `1230` → `¥12.30`. Negative or non-finite values are a contract violation. */
export function formatPriceCents(cents: number): string {
  const safe = Number.isFinite(cents) && cents >= 0 ? Math.round(cents) : 0
  return `¥${(safe / 100).toFixed(2)}`
}

/** All categories of a product, or an explicit "未分类" instead of an empty chip. */
export function categoryLabel(categoryNames: string[]): string {
  const names = categoryNames.map((name) => name.trim()).filter(Boolean)
  return names.length > 0 ? names.join(' / ') : '未分类'
}

/** Single-line category label for compact cards. */
export function primaryCategory(categoryNames: string[]): string {
  return categoryNames.find((name) => name.trim().length > 0)?.trim() ?? '未分类'
}

export function activityStatusLabel(status: 'published' | 'paused' | 'ended'): string {
  switch (status) {
    case 'published':
      return '已发布'
    case 'paused':
      return '已暂停'
    case 'ended':
      return '已结束'
  }
}

/**
 * CRMEB product descriptions are admin-authored HTML. The MVP shows their text
 * instead of injecting upstream HTML into the platform origin: no
 * `dangerouslySetInnerHTML`, no scripts, no inline styles or remote embeds.
 */
export function plainTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
