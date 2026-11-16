import './ActivityArtwork.css'

type ActivityArtworkProps = {
  variant?: 'thumbnail' | 'empty' | 'page'
  className?: string
}

/** Shared illustration for activity covers without a published image and empty lists. */
export function ActivityArtwork({ variant = 'thumbnail', className = '' }: ActivityArtworkProps) {
  return (
    <span className={`activity-artwork activity-artwork--${variant} ${className}`} aria-hidden="true">
      <img
        src={`${import.meta.env.BASE_URL}images/community-activity-artwork.webp`}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    </span>
  )
}
