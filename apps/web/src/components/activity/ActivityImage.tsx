import { useState } from 'react'
import './activityTheme.css'

type ActivityImageProps = {
  /** Ordered artwork candidates: configured visual first, bundled fallback last. */
  candidates: readonly string[]
  alt: string
  className?: string
  fetchPriority?: 'high' | 'auto'
  loading?: 'eager' | 'lazy'
}

/**
 * Activity artwork with a real fallback chain.
 *
 * A failed remote hero/poster URL advances to the next candidate, ending with
 * the bundled legacy artwork. If every candidate fails (for example an offline
 * Pages preview without the asset), a tinted placeholder keeps the layout stable
 * instead of showing a broken-image icon. Callers key the component by activity
 * and candidate list so a new activity restarts the chain.
 */
export function ActivityImage({
  candidates,
  alt,
  className = '',
  fetchPriority = 'auto',
  loading = 'eager',
}: ActivityImageProps) {
  const [failedCount, setFailedCount] = useState(0)

  if (candidates.length === 0 || failedCount >= candidates.length) {
    return <span className={`activity-image-fallback ${className}`} role="img" aria-label={alt} />
  }

  return (
    <img
      key={candidates[failedCount]}
      src={candidates[failedCount]}
      alt={alt}
      className={className}
      fetchPriority={fetchPriority}
      loading={loading}
      decoding="async"
      draggable={false}
      onError={() => setFailedCount((count) => count + 1)}
    />
  )
}
