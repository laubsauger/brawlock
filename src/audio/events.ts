/**
 * SimEvent -> sound cues. Pure: no AudioContext, so it is unit-tested in node.
 * The handler table is typed over every SimEvent type, so a new event type fails
 * to compile until it is mapped here or listed in IGNORED_EVENTS with a reason.
 */
import type { EntityId, PlayerId, SimEvent, SimState, Vec2 } from '../sim/types'
import type { SfxId } from './synth'

export interface ListenerLike {
  x: number
  y: number
  halfWidth: number
  localPlayer?: PlayerId
  state?: Pick<SimState, 'pawns'>
}

export interface SoundCue {
  id: SfxId
  /** linear gain multiplier (distance falloff x loudness) */
  gain: number
  /** stereo pan -1..1 */
  pan: number
  /** recipe parameter (knockback intensity, windup seconds, size) */
  param?: number
  /** seconds after now */
  delay?: number
}

/** Event types that intentionally make no sound, with the reason. */
export const IGNORED_EVENTS: Partial<Record<SimEvent['type'], string>> = {
  projectileSpawn: 'the cast event already plays the launch; spawn carries no position',
  heal: 'lifesteal heals on every hit and would double each impact; heals show as numbers',
}

type Handler<K extends SimEvent['type']> = (
  e: Extract<SimEvent, { type: K }>,
  c: CueContext,
  batch: readonly SimEvent[],
) => SoundCue[]

interface CueContext {
  at(x: number, y: number): { pan: number; gain: number }
  pawnPos(id: EntityId): Vec2 | null
  localPawn: EntityId | null
  nearListener(x: number, y: number): boolean
}

/** Stereo pan by x relative to the listener, gain falloff by distance in screen half-widths. */
export function spatial(x: number, y: number, l: ListenerLike): { pan: number; gain: number } {
  const hw = Math.max(1, l.halfWidth)
  const dx = (x - l.x) / hw
  const dy = (y - l.y) / hw
  const d = Math.hypot(dx, dy)
  return {
    pan: Math.max(-0.85, Math.min(0.85, dx * 0.75)),
    gain: Math.max(0.12, Math.min(1, 1.15 - 0.45 * d)),
  }
}

/** Knockback speed (units/s) to hit intensity: a 0-DP fireball (~750) ~0.7, 1100 = 1. */
export function kbIntensity(kb: number): number {
  return Math.max(0.2, Math.min(1.6, kb / 1100))
}

const cue = (id: SfxId, sp: { pan: number; gain: number }, gain = 1, extra: Partial<SoundCue> = {}): SoundCue => ({
  id,
  pan: sp.pan,
  gain: sp.gain * gain,
  ...extra,
})

const CENTRE = { pan: 0, gain: 1 }

const HANDLERS: { [K in SimEvent['type']]: Handler<K> | null } = {
  cast: (e, c) => {
    // Scourge and Teleport sound from their own events (explosion / teleport)
    if (e.spell === 'scourge' || e.spell === 'teleport') return []
    const p = c.pawnPos(e.pawn) ?? { x: e.x, y: e.y }
    const sp = c.at(p.x, p.y)
    return [cue(e.spell === 'fireball' ? 'fireballCast' : 'castGeneric', sp, 0.9)]
  },
  castStart: (e, c) => {
    if (e.spell !== 'scourge') return []
    const p = c.pawnPos(e.pawn)
    const sp = p ? c.at(p.x, p.y) : CENTRE
    return [cue('scourgeWindup', sp, 1, { param: Math.max(0.2, e.ticks / 60) })]
  },
  projectileSpawn: null,
  projectileHit: (e, c, batch) => {
    if (e.spell !== 'fireball') return [cue('impact', c.at(e.x, e.y))]
    // the sim may also emit an explosion for the same blast: play it once
    const dup = batch.some(
      (o) => o.type === 'explosion' && o.spell === 'fireball' && Math.hypot(o.x - e.x, o.y - e.y) < 60,
    )
    return dup ? [] : [cue('explosion', c.at(e.x, e.y), 1, { param: 1 })]
  },
  projectileExpire: (e, c) => [cue('fizzle', c.at(e.x, e.y), 0.8)],
  damage: (e, c) => {
    if (e.source === null && e.kb === 0) {
      // lava: only the local pawn's burn is audible (rate-limited by the engine). Without
      // localPlayer, the listener follows the local pawn, so a burn at the listener is ours.
      const mine = c.localPawn !== null ? e.target === c.localPawn : c.nearListener(e.x, e.y)
      return mine ? [cue('lavaSizzle', CENTRE)] : []
    }
    return [cue('hit', c.at(e.x, e.y), 1, { param: kbIntensity(e.kb) })]
  },
  heal: null,
  teleport: (e, c) => [cue('teleportOut', c.at(e.fromX, e.fromY)), cue('teleportIn', c.at(e.toX, e.toY), 1, { delay: 0.03 })],
  explosion: (e, c) => {
    const sp = c.at(e.x, e.y)
    if (e.spell === 'scourge') return [cue('scourgeBlast', sp)]
    if (e.spell === 'obstacle') return [cue('explosion', sp, 1, { param: 1.4 })]
    return [cue('explosion', sp, 1, { param: Math.max(0.6, Math.min(1.6, e.radius / 225)) })]
  },
  death: (e, c) => {
    const p = c.pawnPos(e.pawn)
    const sp = p ? c.at(p.x, p.y) : CENTRE
    return [cue('death', { pan: sp.pan, gain: Math.max(0.6, sp.gain) })]
  },
  obstacleDestroyed: (e, c) => [cue('obstacleBreak', c.at(e.x, e.y))],
  arenaShrink: () => [cue('shrinkRumble', CENTRE, 0.9)],
  phase: (e) => (e.phase === 'fight' ? [cue('roundStart', CENTRE)] : []),
  roundWin: (e) => [cue('roundWin', CENTRE, 0.9, { param: e.team < 0 ? 0 : 1 })],
  gameOver: () => [cue('gameOver', CENTRE)],
}

/** Sound cues for one tick's events, placed relative to the listener. */
export function planEvents(events: readonly SimEvent[], listener: ListenerLike): SoundCue[] {
  const pawns = listener.state?.pawns
  const local =
    listener.localPlayer !== undefined && pawns ? (pawns.find((p) => p.owner === listener.localPlayer)?.id ?? null) : null
  const ctx: CueContext = {
    at: (x, y) => spatial(x, y, listener),
    pawnPos: (id) => {
      const p = pawns?.find((q) => q.id === id)
      return p ? { x: p.x, y: p.y } : null
    },
    localPawn: local,
    nearListener: (x, y) => Math.hypot(x - listener.x, y - listener.y) < 80,
  }
  const out: SoundCue[] = []
  for (const e of events) {
    const h = HANDLERS[e.type] as Handler<typeof e.type> | null
    if (h) out.push(...h(e as never, ctx, events))
  }
  return out
}

/** Every event type with a handler (for tests and docs). */
export const HANDLED_EVENTS = (Object.keys(HANDLERS) as SimEvent['type'][]).filter((k) => HANDLERS[k] !== null)
