import { pickRegion, regionPlayerLabel, regionPopulation, type RegionStatus } from './lib/servers'
import { RegionPing } from './RegionPing'

/** Population reuses menu health probes; no separate request or gameplay polling. */
export function RegionPicker({ statuses, choice, onChange }: {
  statuses: RegionStatus[]
  choice: string
  onChange: (region: string) => void
}) {
  const selected = pickRegion(statuses, choice)
  const population = regionPopulation(statuses)
  return <div data-testid="queue-region" className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded border border-white/10 bg-[#140e0b]/85 px-3 py-2 text-sm">
    <label className="flex min-w-0 flex-1 items-center gap-2 text-ash">
      <span className="sr-only">Region</span>
      <select aria-label="Game region" className="field min-w-0 flex-1 py-1 text-sm" value={choice} onChange={(event) => onChange(event.target.value)}>
        <option value="auto">Auto · {selected ? `${selected.label} · ${regionPlayerLabel(selected)}` : 'lowest ping · — players'}</option>
        {statuses.map((status) => <option key={status.id} value={status.id}>{status.label} · {regionPlayerLabel(status)}{status.maintenance?.draining ? ' · updating' : status.state === 'down' ? ' · offline' : ''}</option>)}
      </select>
    </label>
    {selected ? <RegionPing s={selected} /> : <span className="text-xs text-ash">Checking…</span>}
    <span className="shrink-0 rounded border border-white/10 bg-white/5 px-2 py-1 text-xs tabular-nums text-[#c9c1b4]" data-testid="global-player-count" aria-label={`${population.label} · human players across regions`} title={`Connected humans in games and lobbies. Bots excluded.${population.partial ? ' Some region counts are unavailable.' : ''}`}>
      {population.label}
    </span>
  </div>
}
