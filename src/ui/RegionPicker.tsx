import { pickRegion, regionPlayerLabel, regionPopulation, type RegionStatus } from './lib/servers'
import { RegionPing } from './RegionPing'
import { useOnlinePopulation } from './lib/presence'
import { RegionMaintenance } from './RegionMaintenance'

/** Online visitors and connected game humans have separate, explicit labels. */
export function RegionPicker({ statuses, choice, onChange }: {
  statuses: RegionStatus[]
  choice: string
  onChange: (region: string) => void
}) {
  const selected = pickRegion(statuses, choice)
  const population = regionPopulation(statuses)
  const presence = useOnlinePopulation()
  const onlineLabel = (id: string) => presence ? `${presence.regions[id] ?? '—'} online` : '— online'
  return <div data-testid="queue-region" className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded border border-white/10 bg-[#140e0b]/85 px-3 py-2 text-sm">
    <label className="flex min-w-0 flex-1 items-center gap-2 text-ash">
      <span className="sr-only">Region</span>
      <select aria-label="Game region" className="field min-w-0 flex-1 py-1 text-sm" value={choice} onChange={(event) => onChange(event.target.value)}>
        <option value="auto">Auto · {selected ? `${selected.label} · ${onlineLabel(selected.id)}` : 'lowest ping · — online'}</option>
        {statuses.map((status) => <option key={status.id} value={status.id} title={regionPlayerLabel(status)}>{status.label} · {onlineLabel(status.id)}{status.maintenance?.draining ? ' · maintenance' : status.state === 'down' ? ' · offline' : ''}</option>)}
      </select>
    </label>
    {selected ? <RegionPing s={selected} /> : <span className="text-xs text-ash">Checking…</span>}
    <RegionMaintenance statuses={statuses} />
    <div className="flex w-full items-center justify-between gap-3 border-t border-white/8 pt-1.5 text-xs tabular-nums text-[#c9c1b4]">
      <span data-testid="global-player-count" title="People with the game open, including menus. Updates every 30 seconds; departed visitors expire after 90 seconds. Bots excluded.">{presence ? `${presence.total} online` : '— online'}</span>
      <span data-testid="global-in-game-count" title={`Connected humans in games and lobbies. Bots excluded.${population.partial ? ' Some region counts are unavailable.' : ''}`}>{population.total === null ? '— in games' : `${population.total}${population.partial ? '+' : ''} in games`}</span>
    </div>
  </div>
}
