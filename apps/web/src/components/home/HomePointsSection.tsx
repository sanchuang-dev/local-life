import { PointsSummaryCard } from '../life/PointsSummaryCard'
import { SectionHeading } from './SectionHeading'

/**
 * Home preview of the shared resident-points balance. The card reuses the same
 * fixture and `/points` detail page as the life module so the home never keeps
 * a second balance or ledger.
 */
export function HomePointsSection() {
  return (
    <section className="mx-4 mt-7">
      <SectionHeading
        title="我的积分"
        actionLabel="去赚积分"
        actionTo="/points"
        actionState={{ from: '/' }}
      />
      <PointsSummaryCard from="/" />
    </section>
  )
}
