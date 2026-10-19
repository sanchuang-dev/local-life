import { CalendarDays, ChevronRight, MapPin } from 'lucide-react'
import { Link } from 'react-router'
import type { HomeBannerContent } from '../../mocks/home'

type HomeBannerProps = {
  banner: HomeBannerContent
}

export function HomeBanner({ banner }: HomeBannerProps) {
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-[#116d63] via-[#138b79] to-[#47ad91] px-5 pb-[74px] pt-6 text-white">
      <div
        className="pointer-events-none absolute -right-10 -top-16 h-52 w-52 rounded-full border-[36px] border-white/10"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-16 right-9 h-40 w-40 rounded-full bg-white/5"
        aria-hidden="true"
      />

      <div className="relative flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-white/80">
          <MapPin size={14} strokeWidth={2} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{banner.location}</span>
        </span>
        <span className="shrink-0 rounded-full border border-white/25 bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/85">
          演示内容
        </span>
      </div>

      <p className="relative mt-5 text-[11px] font-medium tracking-[0.18em] text-white/70">
        {banner.eyebrow}
      </p>
      <h1 className="relative mt-1.5 text-[28px] font-semibold leading-[1.25] tracking-tight">
        {banner.title}
      </h1>
      <p className="relative mt-2.5 max-w-[17rem] text-[13px] leading-6 text-white/80">
        {banner.description}
      </p>

      <Link
        to={banner.to}
        state={{ from: '/' }}
        className="relative mt-5 inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-white/25 bg-white/15 px-3.5 text-[12px] font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <CalendarDays size={15} aria-hidden="true" />
        {banner.actionLabel}
        <ChevronRight size={14} aria-hidden="true" />
      </Link>
    </section>
  )
}
