import { ImageOff } from 'lucide-react'
import { useState } from 'react'

/**
 * Product image with a real failure placeholder.
 *
 * CRMEB returns absolute image URLs on its own host. If the host is unavailable
 * (or the URL is not an image), the page must keep a readable card instead of a
 * broken-image icon or a blank block. Images are lazy-loaded so narrow mobile
 * screens do not fetch the whole catalogue eagerly.
 */
export function ShopProductImage({
  src,
  alt,
  className,
}: {
  src: string | null | undefined
  alt: string
  className: string
}) {
  // Track the exact source that failed instead of resetting in an effect: a new
  // URL is automatically retried, and the fallback never sticks to another image.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const failed = Boolean(src && failedSrc === src)

  if (!src || failed) {
    return (
      <span
        role="img"
        aria-label={`${alt}（商品图片暂时无法加载）`}
        className={`flex items-center justify-center bg-slate-100 text-slate-400 ${className}`}
      >
        <ImageOff size={26} strokeWidth={1.5} aria-hidden="true" />
      </span>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(src)}
      className={className}
    />
  )
}
