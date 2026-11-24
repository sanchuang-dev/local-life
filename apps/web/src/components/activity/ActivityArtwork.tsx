import { useState } from 'react'
import './ActivityArtwork.css'

type ActivityArtworkProps = {
  variant?: 'thumbnail' | 'empty' | 'page'
  className?: string
  /**
   * Real activity hero image projected by the public visual config. `null`
   * keeps the shared illustration; an image that fails to load falls back to the
   * same illustration instead of a broken cover.
   */
  imageUrl?: string | null
  /** Accessible name for a real activity cover; omitted for decorative artwork. */
  alt?: string
}

/**
 * Shared artwork for activity covers and empty lists.
 *
 * The default (no real image) stays the existing transparent illustration. When
 * a real activity hero is available it is rendered as a photo cover; a load
 * failure degrades to the illustration, so lists never show a broken image.
 */
export function ActivityArtwork({
  variant = 'thumbnail',
  className = '',
  imageUrl = null,
  alt = '',
}: ActivityArtworkProps) {
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const placeholder = `${import.meta.env.BASE_URL}images/community-activity-artwork.webp`
  const showPhoto = Boolean(imageUrl) && failedSource !== imageUrl
  const source = showPhoto ? (imageUrl as string) : placeholder

  return (
    <span
      className={`activity-artwork activity-artwork--${variant}${showPhoto ? ' activity-artwork--photo' : ''} ${className}`}
      aria-hidden={showPhoto ? undefined : 'true'}
    >
      <img
        src={source}
        alt={showPhoto ? alt : ''}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={showPhoto ? () => setFailedSource(imageUrl ?? null) : undefined}
      />
    </span>
  )
}
