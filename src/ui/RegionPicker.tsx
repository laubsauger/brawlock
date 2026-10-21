import { pickRegion, regionPlayerLabel, regionPopulation, useRegionDetours, type queueRegion, type RegionStatus } from './lib/servers'
import { RegionPing } from './RegionPing'
import { useOnlinePopulation } from './lib/presence'
import { RegionMaintenance } from './RegionMaintenance'
import { MenuGlyph } from './icons'
import { Button } from './widgets'

/** Online visitors and connected game humans have separate, explicit labels. */
export function RegionPicker({ statuses, choice, onChange, route }: {
  statuses: RegionStatus[]
  choice: string
  onChange: (region: string) => void
  /** menu queues: Auto may be holding the home region through its maintenance */
  route?: ReturnType<typeof queueRegion>
}) {
  const selected = route ? route.region : pickRegion(statuses, choice)
  const accept = useRegionDetours((s) => s.accept)
  const population = regionPopulation(statuses)
  const presence = useOnlinePopulation()
  const onlineLabel = (id: string) => presence ? `${presence.regions[id] ?? '—'} online` : '— online'
  return <div data-testid="queue-region" className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded border border-white/10 bg-[#140e0b]/85 px-3 py-2 text-sm">
    <label className="flex min-w-0 flex-1 items-center gap-2 text-ash">
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[#d9b98a]"><MenuGlyph kind="region" size={15} />Region</span>
      <select aria-label="Game region" className="field min-w-0 flex-1 py-1 text-sm" value={choice} onChange={(event) => onChange(event.target.value)}>
        <option value="auto">Auto · {selected ? `${selected.label} · ${onlineLabel(selected.id)}` : 'lowest ping · — online'}</option>
        {statuses.map((status) => <option key={status.id} value={status.id} title={regionPlayerLabel(status)}>{status.label} · {onlineLabel(status.id)}{status.maintenance?.draining ? ' · maintenance' : status.state === 'down' ? ' · offline' : ''}</option>)}
      </select>
    </label>
    {selected ? <RegionPing s={selected} /> : <span className="text-xs text-ash">Checking…</span>}
    {route?.held && route.home && route.detour ? <div role="status" data-testid="region-detour" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-xs leading-snug text-[#f3d3a1]">
      <span className="flex min-w-0 flex-1 items-center gap-2"><span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ffb347]" />{route.home.label}, where you play, is under maintenance. Wait here, or switch for now.</span>
      <Button size="sm" variant="primary" onClick={() => accept(route.home!.id)} data-testid="region-detour-accept">Play on {route.detour.label}{route.detour.rttMs != null ? ` · ${route.detour.rttMs} ms` : ''}</Button>
    </div> : route?.detour && route.home ? <p role="status" className="flex w-full items-center gap-2 text-xs leading-snug text-ash">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ffb347]" />Playing on {route.detour.label} while {route.home.label} is under maintenance
    </p> : <RegionMaintenance statuses={statuses} selected={selected ?? null} />}
    <div className="flex w-full items-center justify-between gap-3 border-t border-white/8 pt-1.5 text-xs tabular-nums text-[#c9c1b4]">
      <span data-testid="global-player-count" title="People with the game open, including menus. Updates every 30 seconds; departed visitors expire after 90 seconds. Bots excluded.">{presence ? `${presence.total} online` : '— online'}</span>
      <span data-testid="global-in-game-count" title={`Connected humans in games and lobbies. Bots excluded.${population.partial ? ' Some region counts are unavailable.' : ''}`}>{population.total === null ? '— in games' : `${population.total}${population.partial ? '+' : ''} in games`}</span>
    </div>
  </div>
}
