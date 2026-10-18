/**
 * Inspecting other warlocks and spectating (as in the original: select an
 * enemy hero to see its items). Pure state and picking; the input layer
 * calls pickPawnAt on a plain left click, the HUD shows the card and the
 * "Watching" chip, render follows the spectated player.
 *
 * Picking never interferes with casting: input only calls it when no
 * normal-cast targeting is up (that left click casts), and quick / release
 * cast modes never use the left button.
 */
import type { PlayerSlot, SimState } from '../sim/types'

/** Any current seat can be inspected; inspectedLoadout keeps shop purchases private. */
export function canInspect(state: SimState | null, _local: number, player: number): boolean {
  return !!state?.slots.some((s) => s.id === player)
}

export interface InspectedKit {
  readonly slots: readonly (SimState['pawns'][number]['slots'][number])[]
  readonly levels: readonly number[]
  readonly masteries: Readonly<SimState['scores'][number]['masteries']>
}

export type InspectedLoadout = { kind: 'live' | 'lastRound' | 'unrevealed'; kit: InspectedKit | null }

// Only combat commits a build. Shop updates must never replace this detached snapshot.
let committedRound = -1
type Occupant = Pick<PlayerSlot, 'kind' | 'profileId' | 'name'>
const committed = new Map<number, { occupant: Occupant; kit: InspectedKit }>()

function sameOccupant(a: Occupant, b: Occupant): boolean {
  return a.kind === b.kind && (a.profileId || b.profileId ? a.profileId === b.profileId : a.name === b.name)
}

function copyKit(state: SimState, player: number): InspectedKit | null {
  const pawn = state.pawns.find((p) => p.owner === player)
  const score = state.scores.find((s) => s.id === player)
  if (!pawn || !score) return null
  return { slots: [...pawn.slots], levels: [...pawn.levels], masteries: { ...score.masteries } }
}

/** Called by the frame producer so a hidden/unmounted inspect panel cannot miss combat. */
export function rememberRevealedLoadouts(state: SimState): void {
  if (state.round < committedRound) resetRevealedLoadouts()
  if (state.phase !== 'fight' || state.round === committedRound) return
  committedRound = state.round
  committed.clear()
  for (const slot of state.slots) {
    const kit = copyKit(state, slot.id)
    if (kit) committed.set(slot.id, { occupant: { kind: slot.kind, profileId: slot.profileId, name: slot.name }, kit })
  }
}

export function resetRevealedLoadouts(): void {
  committedRound = -1
  committed.clear()
}

/** The only source of kits for opponent UI, including scoreboard icons and hover cards. */
export function inspectedLoadout(state: SimState | null, local: number, player: number, source: 'live' | 'replay' = 'live'): InspectedLoadout | null {
  if (!state || !canInspect(state, local, player)) return null
  // A replay is read-only history: always use its current frame, including after a seek.
  if (source === 'replay' || player === local || state.phase === 'fight' || state.phase === 'gameOver') {
    return { kind: 'live', kit: copyKit(state, player) }
  }
  const previous = state.round === committedRound ? committed.get(player) : null
  const slot = state.slots.find((s) => s.id === player)!
  const kit = previous && sameOccupant(previous.occupant, slot) ? previous.kit : null
  return kit ? { kind: 'lastRound', kit } : { kind: 'unrevealed', kit: null }
}

export function inspectionLabel(kind: InspectedLoadout['kind']): string {
  if (kind === 'lastRound') return 'Last round · current purchases hidden'
  if (kind === 'unrevealed') return 'Revealed when combat starts'
  return 'Current loadout'
}

/** a click within this many game units of a warlock picks it */
export const PICK_RADIUS = 60

/**
 * The live warlock nearest to a ground point, within `radius`: its owner, or
 * -1. A plain loop over the pawns, no allocation (runs on every left click).
 */
export function pickPawnAt(state: SimState | null, x: number, y: number, radius = PICK_RADIUS): number {
  if (!state) return -1
  let best = -1
  let bestD = radius * radius
  for (const p of state.pawns) {
    if (!p.alive) continue
    const dx = p.x - x
    const dy = p.y - y
    const d = dx * dx + dy * dy
    if (d <= bestD) {
      bestD = d
      best = p.owner
    }
  }
  return best
}

/** Owner of the pawn with this pawn id, or -1. */
export function ownerOfPawn(state: SimState | null, pawnId: number): number {
  if (!state) return -1
  for (const p of state.pawns) if (p.id === pawnId) return p.owner
  return -1
}

/** The local player is watching, not playing: no warlock of their own, or it is down. */
export function isSpectating(state: SimState | null, local: number): boolean {
  if (!state) return false
  if (local < 0) return true
  const me = state.pawns.find((p) => p.owner === local)
  return !me || !me.alive
}

/** Living players in slot order (spectate cycling, 1-9 keys). */
export function livingPlayers(state: SimState | null, except = -1): number[] {
  if (!state) return []
  const out: number[] = []
  for (const s of state.slots) {
    if (s.id === except) continue
    if (state.pawns.some((p) => p.owner === s.id && p.alive)) out.push(s.id)
  }
  return out
}

/** Next / previous in a list of players, wrapping; the first one when `current` is not in it. */
export function cycle(list: readonly number[], current: number, dir: 1 | -1): number {
  if (list.length === 0) return -1
  const i = list.indexOf(current)
  if (i < 0) return dir > 0 ? list[0] : list[list.length - 1]
  return list[(i + dir + list.length) % list.length]
}

/** Can the local player see this player's gold? Yourself and your allies (team modes) only. */
export function goldVisible(state: SimState | null, local: number, player: number): boolean {
  if (!state) return false
  if (player === local) return true
  if (state.settings.teamMode === 'ffa') return false
  const me = state.slots.find((s) => s.id === local)
  const them = state.slots.find((s) => s.id === player)
  return !!me && !!them && me.team === them.team
}

// ---------------------------------------------------------------------------
// Who is inspected / followed (a tiny store; React reads it with useSyncExternalStore)
// ---------------------------------------------------------------------------

export interface InspectState {
  /** player whose card is open, -1 = none */
  inspect: number
  /** player the spectator camera follows by choice, -1 = automatic */
  follow: number
}

let current: InspectState = { inspect: -1, follow: -1 }
const subs = new Set<() => void>()

export const inspectStore = {
  get: (): InspectState => current,
  subscribe(cb: () => void): () => void {
    subs.add(cb)
    return () => subs.delete(cb)
  },
  set(p: Partial<InspectState>): void {
    const next = { ...current, ...p }
    if (next.inspect === current.inspect && next.follow === current.follow) return
    current = next
    for (const f of subs) f()
  },
  /** Click on a warlock: open its card, or close it when it is already open. */
  toggleInspect(player: number): void {
    inspectStore.set({ inspect: current.inspect === player ? -1 : player })
  },
  reset(): void {
    inspectStore.set({ inspect: -1, follow: -1 })
  },
}
