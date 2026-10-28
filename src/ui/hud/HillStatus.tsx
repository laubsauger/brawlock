import { frame } from '../../game/frame'
import { HILL_SHRINK_PERIOD, hillSealed } from '../../sim'
import type { SimState } from '../../sim/types'
import { TICK_HZ } from '../../sim/types'
import { usePolled } from '../lib/ticker'
import { playerColor, slotName, teamName } from '../lib/view'

/** standings rows shown (the leaders) */
const ROWS = 3
/** "Hill shrinks in Ns" shows this close to a shrink */
const SHRINK_NOTICE = 10

interface Standing {
  team: number
  label: string
  color: string
  score: number
  mine: boolean
}

interface HillView {
  status: 'waiting' | 'sealed' | 'open' | 'held' | 'contested'
  holder: Standing | null
  /** the holder is still inside the capture time: no tickets yet */
  taking: boolean
  standings: Standing[]
  target: number
  shrinkIn: number | null
  /** whole seconds until the opening force field drops, while it is up */
  opensIn: number | null
}

/** One row per side: a player in FFA, a team (sharing its tickets) otherwise. */
function standings(s: SimState, local: number | null): Standing[] {
  const teams = s.settings.teamMode !== 'ffa'
  const localTeam = local === null ? null : s.slots.find((sl) => sl.id === local)?.team ?? null
  const bySide = new Map<number, Standing>()
  for (const slot of s.slots) {
    const score = s.scores.find((sc) => sc.id === slot.id)?.score ?? 0
    const prev = bySide.get(slot.team)
    if (prev) {
      prev.score = Math.max(prev.score, score)
      continue
    }
    bySide.set(slot.team, {
      team: slot.team,
      label: teams ? `${teamName(slot.team)} team` : slotName(s, slot.id),
      color: playerColor(slot, s.settings.teamMode),
      score,
      mine: slot.team === localTeam,
    })
  }
  return [...bySide.values()].sort((a, b) => b.score - a.score || a.team - b.team)
}

function read(): HillView | null {
  const s = frame.curr
  if (!s || s.settings.gameMode !== 'hill') return null
  const local = frame.localPlayer >= 0 ? frame.localPlayer : null
  const all = standings(s, local)
  const h = s.hill
  const fight = s.phase === 'fight' && !!h
  const sealed = fight && hillSealed(s)
  const status = !fight || !h ? 'waiting' : sealed ? 'sealed' : h.contested ? 'contested' : h.team !== null ? 'held' : 'open'
  const holder = status === 'held' ? all.find((x) => x.team === h!.team) ?? null : null
  let shrinkIn: number | null = null
  if (fight && h && h.nextShrinkTick >= 0) {
    const secs = Math.ceil((h.nextShrinkTick - s.tick) / TICK_HZ)
    if (secs >= 0 && secs <= SHRINK_NOTICE) shrinkIn = secs
  }
  // the leaders, plus your own row when you are not among them
  const top = all.slice(0, ROWS)
  const mine = all.find((x) => x.mine)
  if (mine && !top.includes(mine)) top[ROWS - 1] = mine
  const taking = status === 'held' && !!h && h.heldTicks < 0
  const opensIn = sealed ? Math.ceil((h!.openTick! - s.tick) / TICK_HZ) : null
  return { status, holder, taking, standings: top, target: Math.max(1, s.settings.winScore), shrinkIn, opensIn }
}

const key = (v: HillView | null) =>
  v ? `${v.status}|${v.holder?.team}|${v.taking}|${v.shrinkIn}|${v.opensIn}|${v.target}|${v.standings.map((x) => `${x.team}:${x.score}:${x.label}`).join(',')}` : ''

/**
 * King of the Hill status under the clock: who holds the hill (or that it is contested), and
 * the ticket race toward the target. Polled a few times a second; tickets move once a second.
 */
export function HillStatus() {
  const v = usePolled(read, key, 6)
  if (!v) return null
  const head = v.status === 'held' && v.holder
    ? <><b style={{ color: v.holder.color }}>{v.holder.mine ? (v.taking ? 'You are taking' : 'You hold') : `${v.holder.label} ${v.taking ? 'is taking' : 'holds'}`}</b> the hill</>
    : v.status === 'sealed' ? <span className="text-[#a9dcff]">Hill sealed, opens in <b className="tabular" data-testid="hill-opens-in" data-seconds={v.opensIn}>{v.opensIn}s</b></span>
    : v.status === 'contested' ? <b className="text-[#ff9b7a]">Hill contested</b>
      : v.status === 'open' ? <span className="text-[#ffd890]">The hill is open, take it</span>
        : <span className="text-ash">Hold the glowing centre tiles</span>
  return (
    <div className="hud-plate hill-status mt-1 w-[19rem] rounded-[6px] px-3 py-1.5" data-status={v.status} aria-label="King of the Hill">
      <div className="flex items-center gap-2 text-[0.82rem] leading-tight font-semibold">
        <span className="hill-crown" aria-hidden>♛</span>
        <span className="min-w-0 flex-1 truncate">{head}</span>
        {v.shrinkIn !== null && <span className="text-[0.72rem] text-[#ffbfa8]">shrinks in {v.shrinkIn}s</span>}
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {v.standings.map((x) => (
          <li key={x.team} className="flex items-center gap-2 text-[0.74rem] leading-none">
            <span className={`w-[6.5rem] truncate ${x.mine ? 'font-bold text-bone' : 'text-ash'}`}>{x.label}</span>
            <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-black/40">
              <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, (x.score / v.target) * 100)}%`, background: x.color, boxShadow: `0 0 6px ${x.color}` }} />
            </span>
            <span className="tabular w-[3.6rem] text-right font-semibold text-gold">{x.score}<span className="text-ash/70">/{v.target}</span></span>
          </li>
        ))}
      </ul>
      <p className="sr-only">Hill shrinks every {HILL_SHRINK_PERIOD} seconds.</p>
    </div>
  )
}
