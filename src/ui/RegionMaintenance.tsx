import type { RegionStatus } from '../net/online'

/**
 * One quiet line, only when maintenance affects you: the region you play in (`selected`,
 * after Auto) or every region. Without `selected` (Browse lists all regions) it names them.
 */
export function RegionMaintenance({ statuses, selected, className = '' }: { statuses: readonly RegionStatus[]; selected?: RegionStatus | null; className?: string }) {
  const draining = statuses.filter((region) => region.maintenance?.draining)
  if (!draining.length) return null
  const all = draining.length === statuses.length
  if (selected !== undefined && !all && !selected?.maintenance?.draining) return null
  const text = all ? 'Maintenance · new server games paused, Rejoin still works'
    : selected ? `${selected.label} maintenance · pick another region`
    : `${draining.map((region) => region.label).join(' · ')} maintenance · new games there paused`
  return <p role="status" data-testid="region-maintenance" className={`flex w-full items-center gap-2 text-xs leading-snug text-[#f3d3a1] ${className}`}>
    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ffb347]" />{text}
  </p>
}
