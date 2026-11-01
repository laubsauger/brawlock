/**
 * The finish zoom (docs/moonshot/specs/final-blow.md, Rules 14 to 20): when a hit lands on the
 * last warlock of the last opposing side and the lava forecast says it will not get out (or it
 * dies outright), the camera punches in for half a second and a stinger plays. A forecast, not
 * knowledge: Teleport, Shield and the next shrink are not foreseen, so a zoom can be wrong, and
 * that is still drama. Fed by the displayed stream (the audio engine's playEvents), so on a client
 * it lands with the predicted hit the player sees. Nothing slows down.
 */
import { lavaOutcome, physVelocity } from '../bots/predict'
import { ticks } from '../sim/config'
import { gameWinners } from '../sim/mode'
import { isRoundParticipant } from '../sim/teams'
import type { EntityId, PlayerId, SimEvent, SimState } from '../sim/types'

/** a victim zooms at most once this often (s) */
export const ZOOM_VICTIM_GAP = 2
/** zooms per round at most */
export const ZOOM_ROUND_CAP = 2

export interface FinishZoom {
  victim: EntityId
  x: number
  y: number
  /** 'match' when this round's win decides the match */
  kind: 'round' | 'match'
  tick: number
}

export class FinishZoomTracker {
  /** Settings > Gameplay > Finish zoom */
  enabled = true
  private lastByVictim = new Map<EntityId, number>()
  private thisRound = 0
  private lastTick = -Infinity

  reset(): void {
    this.lastByVictim.clear()
    this.thisRound = 0
    this.lastTick = -Infinity
  }

  /** One displayed tick. Returns the zooms it starts (at most one per deciding hit). */
  update(events: readonly SimEvent[], state: SimState, localPlayer: PlayerId): FinishZoom[] {
    if (state.tick < this.lastTick - ticks(1)) this.reset()
    this.lastTick = state.tick
    let out: FinishZoom[] | null = null
    for (const e of events) {
      if (e.type === 'phase' && e.phase === 'fight') {
        this.lastByVictim.clear()
        this.thisRound = 0
        continue
      }
      if (!this.enabled || e.type !== 'damage' || !(e.kb > 0) || e.source === null || state.phase !== 'fight') continue
      const v = state.pawns.find((p) => p.id === e.target)
      if (!v || e.source === v.owner) continue
      const zoom = this.decide(v, e.source, state, localPlayer)
      if (!zoom) continue
      if (this.thisRound >= ZOOM_ROUND_CAP) continue
      const last = this.lastByVictim.get(v.id)
      if (last !== undefined && state.tick - last < ticks(ZOOM_VICTIM_GAP)) continue
      this.lastByVictim.set(v.id, state.tick)
      this.thisRound++
      ;(out ??= []).push(zoom)
    }
    return out ?? []
  }

  private decide(v: SimState['pawns'][number], source: PlayerId, state: SimState, local: PlayerId): FinishZoom | null {
    const team = (id: PlayerId) => state.slots.find((s) => s.id === id)?.team ?? id
    const side = team(v.owner)
    if (team(source) === side) return null
    // sides still standing (round participants only)
    const alive = new Set<number>()
    let mates = 0
    for (const p of state.pawns) {
      if (!p.alive || !isRoundParticipant(state, p.owner)) continue
      const s = team(p.owner)
      alive.add(s)
      if (s === side && p.id !== v.id) mates++
    }
    if (mates > 0) return null
    if (v.alive ? alive.size !== 2 : alive.size > 1) return null
    // whose zoom: a player still fighting only sees their own side's finishing hits
    const localPawn = local >= 0 ? state.pawns.find((p) => p.owner === local) : undefined
    const localSideAlive = local >= 0 && state.pawns.some((p) => p.alive && team(p.owner) === team(local) && isRoundParticipant(state, p.owner))
    if (localSideAlive) {
      if (v.id === localPawn?.id || side === team(local)) return null
      const winner = [...alive].find((s) => s !== side)
      if (winner !== undefined && winner !== team(local)) return null
    }
    const lethal = !v.alive || lavaOutcome(state, { x: v.x, y: v.y }, physVelocity(v), v.hp, v.moveSpeed, state.arena.layer).lethal
    if (!lethal) return null
    return { victim: v.id, x: v.x, y: v.y, kind: this.decidesMatch(state, side) ? 'match' : 'round', tick: state.tick }
  }

  /** gameWinners with the round point given to the side that is about to win */
  private decidesMatch(state: SimState, losingSide: number): boolean {
    if (state.rankedFinal) return true
    const team = (id: PlayerId) => state.slots.find((s) => s.id === id)?.team ?? id
    const winners = state.pawns.filter((p) => p.alive && isRoundParticipant(state, p.owner) && team(p.owner) !== losingSide).map((p) => p.owner)
    const scores = state.scores.map((sc) => (winners.includes(sc.id) ? { ...sc, score: sc.score + 1 } : sc))
    return gameWinners({ ...state, scores, round: state.round }) !== null
  }
}

type Listener = (z: FinishZoom) => void
const listeners = new Set<Listener>()

/** Every finish zoom started, for the camera (MatchWorld) and the sound. `subscribe` returns its unsubscribe. */
export const finishZooms = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  emit(z: FinishZoom): void {
    for (const fn of listeners) fn(z)
  },
}

/** The match's tracker, fed by the audio engine from the displayed stream. */
export const matchFinishZoom = new FinishZoomTracker()
