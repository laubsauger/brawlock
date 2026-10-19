import type { RegionStatus } from '../net/online'

/** Maintenance is reachable service state, shown separately from availability/ping. */
export function RegionMaintenance({ statuses }: { statuses: readonly RegionStatus[] }) {
  const draining = statuses.filter((region) => region.maintenance?.draining)
  if (!draining.length) return null
  const all = draining.length === statuses.length
  return <div role="status" data-testid="region-maintenance" className="w-full rounded border border-[#ffb347]/35 bg-[#281d13] px-3 py-2 text-sm leading-snug text-[#f3d3a1]">
    <p className="font-semibold">Maintenance · {draining.map((region) => region.label).join(' · ')}</p>
    <p className="mt-1 text-xs">{all ? 'New server games are paused. Existing matches can finish; use Rejoin to return to your game.' : 'New games are paused in these regions. Choose another region, or use Rejoin for your existing game.'}</p>
  </div>
}
