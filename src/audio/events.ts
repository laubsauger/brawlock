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
  state?: Pick<SimState, 'pawns'> & Partial<Pick<SimState, 'projectiles' | 'arena' | 'tick' | 'phase' | 'phaseTicksLeft' | 'round' | 'scores' | 'slots' | 'settings'>>
}

/** One automation point of a moving sound, seconds after its start. */
export interface PathPoint {
  t: number
  pan: number
  gain: number
  /** playback-rate factor (Doppler) */
  rate: number
}

export interface SoundCue {
  /** sound to play; null = only stop `stopKey` */
  id: SfxId | null
  /** linear gain multiplier (distance falloff x loudness) */
  gain: number
  /** stereo pan -1..1 */
  pan: number
  /** recipe parameter (knockback intensity, windup seconds, size) */
  param?: number
  /** seconds after now */
  delay?: number
  /** register the voice under this key so a later cue can cut it (windups) */
  key?: string
  /** fade out voices registered under this key before playing */
  stopKey?: string
  /** pan / gain / rate automation for a moving source (projectile in flight) */
  path?: PathPoint[]
}

/** Voice key of a projectile's travel loop. */
export const projectileKey = (id: EntityId) => `proj:${id}`

/** How a spell's `cast` event sounds. null = silent there (the spell sounds from its own events). */
export interface SpellSounds {
  cast: SfxId | null
  castParam?: number
}

export const SPELL_SOUNDS: Record<string, SpellSounds> = {
  fireball: { cast: 'fireballCast' },
  cluster: { cast: 'fireballCast', castParam: 0.6 },
  scourge: { cast: null }, // windup + explosion events
  teleport: { cast: null }, // teleport event
  lightning: { cast: null }, // beam event
  swap: { cast: 'swapCast' },
  thrust: { cast: 'dashBurst' }, // contact = spellHit
  boomerang: { cast: 'bladeThrow' },
  homing: { cast: 'arcaneCast' },
  twin: { cast: 'twinCast' },
  drain: { cast: 'drainCast' },
  recharge: { cast: 'rechargeCast' },
  bouncer: { cast: 'bouncerCast' },
  redirector: { cast: null }, // spellHit 'redirector' is the grab
  pact: { cast: null }, // the pact modifier
  shield: { cast: null }, // shield modifier
  rush: { cast: null }, // rush modifier
  alteration: { cast: null }, // alteration modifier + swap event
  windwalk: { cast: null }, // windwalk modifier
  meteor: { cast: 'meteorCast' },
  splitter: { cast: 'splitterCast' },
  snowball: { cast: 'snowCast' },
  gravity: { cast: 'gravityCast' },
  grip: { cast: 'gripCast' },
  warpzone: { cast: 'warpCast' },
  magnetize: { cast: 'magnetCast' },
  rockpillar: { cast: 'pillarRise' },
  link: { cast: 'linkCast' },
}

/**
 * How a projectile sounds, keyed like the sim's behaviors: `kind ?? spell`.
 * travel = loop while it flies; hit / expire null = silent (another event is the payoff).
 */
export interface ProjectileSounds {
  travel?: SfxId
  hit?: SfxId | null
  hitParam?: number
  expire?: SfxId | null
}

export const PROJECTILE_SOUNDS: Record<string, ProjectileSounds> = {
  fireball: { travel: 'fireballTravel', hit: 'explosion', hitParam: 1, expire: 'fizzle' },
  cluster: { travel: 'clusterTravel', hit: 'explosion', hitParam: 0.55, expire: 'fizzle' },
  swap: { travel: 'swapTravel', hit: null, expire: null }, // the swap event plays the exchange
  boomerang: { travel: 'bladeSpin', hit: 'bladeHit', expire: null },
  homing: { travel: 'homingTravel', hit: 'arcaneBurst', expire: 'fizzle' },
  twin: { travel: 'twinTravel', hit: 'impact', expire: null },
  drain: { travel: 'drainTravel', hit: 'drainHit', expire: 'fizzle' },
  drainHeal: { travel: 'orbTravel', hit: 'orbAbsorb', expire: null },
  bouncer: { travel: 'bouncerTravel', hit: 'zapHit', expire: 'fizzle' },
  recharge: { travel: 'rechargeTravel', hit: 'zapHit', expire: 'fizzle' },
  rechargeRefresh: { travel: 'orbTravel', hit: null, expire: null }, // cooldownReset plays the refresh
  meteor: { travel: 'meteorFall', hit: null, expire: null }, // the explosion event is the landing
  splitter: { travel: 'splitterTravel', hit: 'zapHit', expire: null },
  splitterSpawner: { travel: 'splitterTravel', hit: null, expire: null },
  splitterChild: { travel: 'childZip', hit: 'impact', hitParam: 0.6, expire: null },
  snowball: { travel: 'snowRoll', hit: null, expire: null }, // snowball modifier + explosion event
  gravity: { travel: 'gravityHum', hit: 'gravityEnd', expire: 'gravityEnd' },
  grip: { travel: 'gripTravel', hit: 'tink', expire: null }, // grip modifier = chains
  warpzone: { travel: 'warpHum', hit: null, expire: 'popOff' },
  magnetize: { travel: 'magnetTravel', hit: null, expire: 'fizzle' }, // magnetize modifier
  link: { travel: 'linkTravel', hit: null, expire: 'fizzle' }, // link modifier = tether loop
}
const DEFAULT_PROJECTILE: ProjectileSounds = { hit: 'impact', expire: 'fizzle' }
const projectileSounds = (kind: string): ProjectileSounds => PROJECTILE_SOUNDS[kind] ?? DEFAULT_PROJECTILE

/**
 * What the planner remembers across ticks (owned by the engine): each live projectile's
 * kind, read from state at spawn, because hit / expire events only carry the spell.
 */
export interface CueMemory {
  projectiles: Map<EntityId, string>
  /** the Wilhelm scream already played this match (cleared at game over) */
  wilhelmUsed: boolean
  /** 0..1 roll for rare cue variants (tests pass a fixed one) */
  rng: () => number
}
export const newCueMemory = (rng: () => number = Math.random): CueMemory => ({ projectiles: new Map(), wilhelmUsed: false, rng })

/**
 * Chance that a credited knock-into-the-lava screams the Wilhelm scream instead of a death cry:
 * an homage, so it stays rare (at most once per match per listener).
 */
export const WILHELM_CHANCE = 1 / 25

/** death cue param that swaps the death cry for the Wilhelm scream (hybrid `death` layers) */
export const WILHELM_PARAM = 1

/** Exaggerated "speed of sound" (units/s) so a passing fireball audibly swoops. */
const DOPPLER_C = 5000

/**
 * Pan, gain and Doppler rate along a straight flight, sampled every 50 ms. The listener sits
 * above the camera focus (half a screen up), so the pitch bend is smooth as it passes.
 */
export function flightPath(x: number, y: number, vx: number, vy: number, seconds: number, l: ListenerLike): PathPoint[] {
  const h = Math.max(1, l.halfWidth) * 0.5
  const out: PathPoint[] = []
  const steps = Math.max(1, Math.ceil(seconds / 0.05))
  for (let i = 0; i <= steps; i++) {
    const t = (seconds * i) / steps
    const px = x + vx * t
    const py = y + vy * t
    const sp = spatial(px, py, l)
    const rx = px - l.x
    const ry = py - l.y
    const r = Math.hypot(rx, ry, h)
    const vr = (vx * rx + vy * ry) / r
    out.push({ t, pan: sp.pan, gain: sp.gain, rate: Math.max(0.7, Math.min(1.4, DOPPLER_C / (DOPPLER_C + vr))) })
  }
  return out
}

/** Voice key of a pawn's cast windup (Scourge charge, cast-point inhale). */
export const windupKey = (pawn: EntityId) => `windup:${pawn}`

export type ModSound = {
  on?: [SfxId, number?]
  off?: [SfxId, number?]
  /** loop for as long as the modifier lasts (param = max seconds), cut when it ends */
  loop?: [SfxId, number]
}

/** Modifier sounds by exact sim id. Listed with no sound = heard through another event. */
export const MODIFIER_IDS: Record<string, ModSound> = {
  pact: { on: ['darkPulse'] },
  pactSlow: { on: ['slowDown'] },
  homingHaste: { on: ['hasteUp'] },
  drainHaste: { on: ['hasteUp'] },
  drainSlow: { on: ['slowDown'] },
  redirectorPenalty: {}, // the redirect itself is heard (spellHit)
  thrust: {}, // the dash is heard from its cast
  rechargeStreak: {}, // streak events
  spawnInvulnerable: {}, // round start horn
  windwalk: { on: ['fade', 1], off: ['fade', 0] },
  rush: { on: ['ignite'], off: ['popOff'] },
  snowball: { on: ['snowGrab'] },
  shield: { on: ['shieldUp'], off: ['popOff'] },
  grip: { on: ['chains'] },
  alteration: { on: ['altArm'], off: ['popOff'] },
  magnetize: { on: ['magnetOn'], off: ['popOff'] },
  link: { loop: ['linkLoop', 12], off: ['popOff'] },
}

/** Fallback by id fragment for spells whose modifiers have not landed yet. */
const MODIFIER_FRAGMENTS: ({ match: string } & ModSound)[] = [
  { match: 'shield', on: ['shieldUp'], off: ['popOff'] },
  { match: 'windwalk', on: ['fade', 1], off: ['fade', 0] },
  { match: 'grip', on: ['chains'] },
  { match: 'rush', on: ['ignite'], off: ['popOff'] },
]

/** Event types that intentionally make no sound, with the reason. */
export const IGNORED_EVENTS: Partial<Record<SimEvent['type'], string>> = {
  heal: 'lifesteal heals on every hit and would double each impact; heals show as numbers',
}

type Handler<K extends SimEvent['type']> = (
  e: Extract<SimEvent, { type: K }>,
  c: CueContext,
  batch: readonly SimEvent[],
) => SoundCue[]

interface CueContext {
  listener: ListenerLike
  memory: CueMemory
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

/** Scourge is in everyone's starting kit and heard every round: L1 stays modest, the full blast is the L3 escalation. */
const SCOURGE_GAIN = [0.6, 0.8, 1]
const scourgeLevel = (level?: number) => Math.max(1, Math.min(3, level ?? 1))
/** an opponent's Scourge charge: a faint cue, not a warning siren (original: silent until the blast) */
const SCOURGE_ENEMY_WINDUP = 0.2

const HANDLERS: { [K in SimEvent['type']]: Handler<K> | null } = {
  cast: (e, c) => {
    const ss = SPELL_SOUNDS[e.spell] ?? { cast: 'castGeneric' }
    if (!ss.cast) return []
    const p = c.pawnPos(e.pawn) ?? { x: e.x, y: e.y }
    return [cue(ss.cast, c.at(p.x, p.y), 0.9, { param: ss.castParam ?? 1 })]
  },
  castStart: (e, c) => {
    const p = c.pawnPos(e.pawn)
    const sp = p ? c.at(p.x, p.y) : CENTRE
    const key = windupKey(e.pawn)
    if (e.spell === 'scourge') {
      // as in the original (no cast sound until the blast), opponents barely hear the charge;
      // only the caster gets the full windup as feedback
      const owner = c.listener.state?.pawns.find((q) => q.id === e.pawn)?.owner
      const theirs = c.listener.localPlayer !== undefined && owner !== undefined && owner !== c.listener.localPlayer
      const gain = SCOURGE_GAIN[scourgeLevel(e.level) - 1] * (theirs ? SCOURGE_ENEMY_WINDUP : 1)
      return [cue('scourgeWindup', sp, gain, { param: Math.max(0.2, e.ticks / 60), key })]
    }
    // short cast points get an inhale, so a cancelled (fake) cast is heard as inhale + snuff
    if (e.ticks >= 6) return [cue('castInhale', sp, 0.7, { param: e.ticks / 60, key })]
    return []
  },
  castCancel: (e, c) => {
    const key = windupKey(e.pawn)
    // nothing was audible before the cast point began (still turning): just make sure it is cut
    if (!e.started) return [{ id: null, gain: 0, pan: 0, stopKey: key }]
    const p = c.pawnPos(e.pawn)
    const sp = p ? c.at(p.x, p.y) : CENTRE
    return [cue('castSnuff', sp, 1, { stopKey: key })]
  },
  projectileSpawn: (e, c) => {
    const pr = c.listener.state?.projectiles?.find((q) => q.id === e.id)
    const kind = pr?.kind ?? e.spell
    c.memory.projectiles.set(e.id, kind)
    const id = projectileSounds(kind).travel
    // the launch itself is the cast sound; the loop needs the projectile's flight from state
    if (!id || !pr) return []
    // Meteor: hover + fall; other untimed projectiles loop until their hit / expire cuts them
    const life =
      pr.data.hoverTime !== undefined
        ? pr.data.hoverTime + (pr.data.fallTime ?? 0)
        : pr.data.noTimer
          ? 6
          : Math.max(0.1, Math.min(6, pr.ticksLeft / 60))
    const path = flightPath(pr.x, pr.y, pr.vx, pr.vy, Math.min(life, 3), c.listener)
    return [{ id, gain: path[0].gain, pan: path[0].pan, param: life, key: projectileKey(e.id), path }]
  },
  projectileHit: (e, c, batch) => {
    const kind = c.memory.projectiles.get(e.id) ?? e.spell
    c.memory.projectiles.delete(e.id)
    const ps = projectileSounds(kind)
    const stopKey = projectileKey(e.id)
    // the sim may also emit an explosion for the same blast (Lightning detonation): play it once
    const blast = ps.hit === 'explosion' && batch.some((o) => o.type === 'explosion' && Math.hypot(o.x - e.x, o.y - e.y) < 60)
    const id = blast ? null : ps.hit === undefined ? DEFAULT_PROJECTILE.hit : ps.hit
    return [id ? cue(id, c.at(e.x, e.y), 1, { param: ps.hitParam, stopKey }) : { id: null, gain: 0, pan: 0, stopKey }]
  },
  projectileExpire: (e, c) => {
    const kind = c.memory.projectiles.get(e.id) ?? e.spell
    c.memory.projectiles.delete(e.id)
    const ps = projectileSounds(kind)
    const id = ps.expire === undefined ? DEFAULT_PROJECTILE.expire : ps.expire
    const stopKey = projectileKey(e.id)
    return [id ? cue(id, c.at(e.x, e.y), 0.8, { stopKey }) : { id: null, gain: 0, pan: 0, stopKey }]
  },
  damage: (e, c) => {
    if (e.source === null && e.kb === 0) {
      // lava: only the local pawn's burn is audible (rate-limited by the engine). Without
      // localPlayer, the listener follows the local pawn, so a burn at the listener is ours.
      const mine = c.localPawn !== null ? e.target === c.localPawn : c.nearListener(e.x, e.y)
      return mine ? [cue('lavaSizzle', CENTRE)] : []
    }
    const sp = c.at(e.x, e.y)
    const out = [cue('hit', sp, 1, { param: kbIntensity(e.kb) })]
    // Rush soaked part of it: a flame flare over the hit
    if (e.absorbed && e.absorbed > 0) out.push(cue('flare', sp, 0.8))
    return out
  },
  heal: null,
  teleport: (e, c) => [cue('teleportOut', c.at(e.fromX, e.fromY)), cue('teleportIn', c.at(e.toX, e.toY), 1, { delay: 0.03 })],
  explosion: (e, c) => {
    const sp = c.at(e.x, e.y)
    if (e.spell === 'scourge') {
      const level = scourgeLevel(e.level)
      return [cue('scourgeBlast', sp, SCOURGE_GAIN[level - 1], { param: level })]
    }
    if (e.spell === 'obstacle') return [cue('explosion', sp, 1, { param: 1.4 })]
    if (e.spell === 'homing') return [cue('arcaneBurst', sp, 1.1)]
    if (e.spell === 'meteor') return [cue('meteorImpact', sp)]
    if (e.spell === 'snowball') return [cue('snowBurst', sp)]
    // Lightning detonating a Fireball: a bigger fire blast laced with electricity
    if (e.spell === 'lightning') return [cue('explosion', sp, 1, { param: 1.25 }), cue('zapHit', sp, 0.7)]
    return [cue('explosion', sp, 1, { param: Math.max(0.6, Math.min(1.6, e.radius / 225)) })]
  },
  death: (e, c) => {
    const p = c.pawnPos(e.pawn)
    const sp = e.x !== undefined && e.y !== undefined ? c.at(e.x, e.y) : p ? c.at(p.x, p.y) : CENTRE
    if (e.cause === 'disconnect') return [cue('fade', sp, 0.6, { stopKey: windupKey(e.pawn) })]
    let param: number | undefined
    if (e.cause === 'lava' && e.killer !== null && !c.memory.wilhelmUsed && c.memory.rng() < WILHELM_CHANCE) {
      c.memory.wilhelmUsed = true
      param = WILHELM_PARAM
    }
    // Your own knockout stays centered and distinct even when the camera is panned away.
    if (e.owner === c.listener.localPlayer) return [cue('death', CENTRE, 1.15, { stopKey: windupKey(e.pawn), param })]
    const out = [cue('death', { pan: sp.pan, gain: Math.max(0.6, sp.gain) }, 1, { stopKey: windupKey(e.pawn), param })]
    // A credited kill is a personal reward, independent of distance or the spectator camera.
    const local = c.listener.localPlayer
    if (local !== undefined && local >= 0 && e.killer === local) out.push(cue('killConfirm', CENTRE))
    // The exact authoritative bounty is separate from ordinary kill/round gold.
    // A quiet two-part coin settle belongs only to its collector.
    if (e.killer === c.listener.localPlayer && e.bountyGold && e.bountyGold > 0) {
      out.push(cue('uiBuy', CENTRE, 0.65, { delay: 0.13 }), cue('streakTick', CENTRE, 0.55, { delay: 0.24, param: 4 }))
    }
    return out
  },
  respawn: (e, c) => [cue('respawnSwell', c.at(e.x, e.y))],
  beam: (e, c) => {
    const out = [cue('beamZap', c.at(e.fromX, e.fromY))]
    if (e.blocked) out.push(cue('tink', c.at(e.toX, e.toY), 1, { delay: 0.01 }))
    else if (e.target !== null) out.push(cue('impact', c.at(e.toX, e.toY), 0.8, { delay: 0.01 }))
    return out
  },
  shieldReflect: (e, c) => {
    const out = [cue('reflect', c.at(e.x, e.y), 1, { param: e.stolen ? 1 : 0 })]
    if (e.stolen && e.reflected && e.pawn === c.localPawn) out.push(cue('streakTick', CENTRE, 0.4, { delay: 0.07, param: 1 }))
    return out
  },
  swap: (e, c) => {
    const glass = e.spell === 'alteration' ? 1 : 0
    return [
      cue('swapWarp', c.at(e.fromX, e.fromY), 1, { param: glass }),
      cue('swapWarp', c.at(e.toX, e.toY), 0.8, { param: glass, delay: 0.04 }),
    ]
  },
  modifier: (e, c) => {
    const lower = e.id.toLowerCase()
    const m = MODIFIER_IDS[e.id] ?? MODIFIER_FRAGMENTS.find((x) => lower.includes(x.match))
    if (!m) return []
    const p = c.pawnPos(e.pawn)
    const sp = p ? c.at(p.x, p.y) : CENTRE
    const key = `mod:${e.pawn}:${e.id}`
    const out: SoundCue[] = []
    if (e.on && m.loop) out.push(cue(m.loop[0], sp, 1, { param: m.loop[1], key }))
    const s = e.on ? m.on : m.off
    if (s) out.push(cue(s[0], sp, 1, { param: s[1] ?? 0, stopKey: !e.on && m.loop ? key : undefined }))
    else if (!e.on && m.loop) out.push({ id: null, gain: 0, pan: 0, stopKey: key })
    return out
  },
  spellHit: (e, c) => [cue(e.spell === 'redirector' ? 'redirect' : 'chargeSlam', c.at(e.x, e.y))],
  projectileBounce: (e, c) => [cue('ricochet', c.at(e.x, e.y), 0.9)],
  cooldownReset: (e, c) => {
    const p = c.pawnPos(e.pawn)
    const mine = e.pawn === c.localPawn
    return [cue('refresh', p ? c.at(p.x, p.y) : CENTRE, mine ? 1 : 0.5)]
  },
  // a personal combo counter: only the owner hears it
  streak: (e, c) => (e.pawn === c.localPawn && e.value > 0 ? [cue('streakTick', CENTRE, 0.8, { param: e.value })] : []),
  // the local player's own shopping only (others' purchases stay private); louder than UI ticks
  purchase: (e, c) => {
    const mine =
      c.listener.localPlayer !== undefined
        ? e.player === c.listener.localPlayer
        : (() => {
            const p = c.pawnPos(e.pawn)
            return p ? c.nearListener(p.x, p.y) : false
          })()
    if (!mine) return []
    const id = e.kind === 'mastery' ? 'buyMastery' : e.level <= 1 ? 'buyNew' : 'buyUpgrade'
    return [cue(id, CENTRE, 1.2, { param: e.level })]
  },
  obstacleDestroyed: (e, c) => [cue('obstacleBreak', c.at(e.x, e.y))],
  arenaShrink: () => [cue('shrinkRumble', CENTRE, 0.9)],
  phase: (e) => (e.phase === 'fight' ? [cue('roundStart', CENTRE)] : []),
  roundWin: (e) => [cue('roundWin', CENTRE, 0.9, { param: e.team < 0 ? 0 : 1 })],
  gameOver: (_e, c) => {
    c.memory.wilhelmUsed = false
    return [cue('gameOver', CENTRE)]
  },
}

/** Sound cues for one tick's events, placed relative to the listener. */
export function planEvents(events: readonly SimEvent[], listener: ListenerLike, memory: CueMemory = newCueMemory()): SoundCue[] {
  const pawns = listener.state?.pawns
  const local =
    listener.localPlayer !== undefined && pawns ? (pawns.find((p) => p.owner === listener.localPlayer)?.id ?? null) : null
  // forget projectiles whose end we never saw (snapshots skipped)
  if (memory.projectiles.size > 512) memory.projectiles.clear()
  const ctx: CueContext = {
    listener,
    memory,
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
