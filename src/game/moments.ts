/**
 * The moments engine (docs/moonshot/specs/moments.md): what mattered in a match, named from the
 * confirmed stream of ticks so the live client, the replay player and a server name the same
 * moments. Knockouts are traced to the hit that caused them (most deaths are lava burns seconds
 * after the push), then rounds and matches get their deciders; multi-knockouts, denied escapes,
 * clutches and close calls round it out. Each moment carries a score for the Final Blow and the
 * results reel to pick from. Nothing here knows who is watching.
 *
 * Order within a tick: events in array order (a lethal damage comes before its death, the last
 * death before roundWin, roundWin before gameOver), then the state pass (flights, lava stays,
 * slides, clutch candidates, close-call confirmation), then the stolen-projectile table for the
 * next tick.
 */
import { MULTI_WINDOW } from '../render/overlay/killStamps'
import { ARENA_TILE_SIZE, OBSTACLE_EXPLODE_RADIUS, ticks } from '../sim/config'
import { hypot } from '../sim/math'
import { gameWinners } from '../sim/mode'
import { isRoundParticipant } from '../sim/teams'
import { TICK_HZ, type EntityId, type PlayerId, type SimEvent, type SimState } from '../sim/types'
import { KillTally, isCloseCallHit } from './announcer'
import { FLIGHT_START_SPEED, FLIGHT_STOP_SPEED } from './flight'
import { isDeniedEscape, writeSlide, type SlideSnapshot } from './teleportSave'

/** a slide that stops at the edge and tips in a moment later is still the push (s) */
export const SEAL_GRACE = 0.5
/** added to the longest possible lava stay (maxHp / lavaDps) when looking back for the push (s) */
export const SEAL_FLIGHT_EXTRA = 2
/** a sealing flight longer than this is a long flight: about the top 7% (game units) */
export const LONG_FLIGHT = 6 * ARENA_TILE_SIZE
/** a close call counts once the warlock is alive and off the lava this long after the hit (s) */
export const CLOSE_CALL_SAFE = 5
/** default window margins (s) */
export const MOMENT_PRE = 0.5
export const MOMENT_POST = 0.5
/** a denied escape shows this long before (without a pusher) and after the Teleport (s) */
const DENIED_LEAD = 1
/** a clutch shows until this long after the round win, and at most its last CLUTCH_MAX (s) */
const CLUTCH_TAIL = 1
const CLUTCH_MAX = 8
/** a close call's window is at most this long (s) */
const CLOSE_CALL_MAX = 6

export type MomentKind = 'knockout' | 'multiKnockout' | 'denied' | 'clutch' | 'closeCall'
export type MomentTrait = 'roundDecider' | 'matchDecider' | 'reflected' | 'detonation' | 'pillarBlast' | 'longFlight' | 'comeback'

export interface MomentCamera {
  /** the victim's pawn (knockout), the Teleporter (denied), the clutch or close-call player */
  subject: EntityId
  /** the hitter's pawn, if any */
  other: EntityId | null
  /** where the key instant happened (game units) */
  x: number
  y: number
  /** the victim's knockback direction just after the hit, normalized; 0 when none */
  dirX: number
  dirY: number
}

export interface Moment {
  /** creation order within the match */
  id: number
  kind: MomentKind
  /** sorted, no duplicates */
  traits: MomentTrait[]
  round: number
  /** the instant that matters (sealing hit, Teleport, round win, hit), ticks */
  tick: number
  /** knockout: death tick; multi: last death; else = tick */
  end: number
  /** window to show, ticks */
  from: number
  to: number
  /** first = who did it */
  actors: PlayerId[]
  victims: PlayerId[]
  /** the sealing hit's spell id or 'obstacle' */
  cause: string | null
  /** multi: knockouts; clutch: enemies faced; else 1 */
  count: number
  score: number
  camera: MomentCamera
  /** false while a chain can still grow */
  final: boolean
}

/** A hit that could have caused a knockout (Rule 3). */
interface Hit {
  tick: number
  src: PlayerId
  kb: number
  cause: string
  x: number
  y: number
  reflected: boolean
  detonation: boolean
  pillar: boolean
  /** flight start (Rule 4) */
  x0: number
  y0: number
  /** still flying */
  flying: boolean
  /** tick the flight ended (the hit tick when it never started) */
  flightEnd: number
  flightLen: number
  /** the victim's knockback direction just after the hit */
  dirX: number
  dirY: number
}

interface Slide extends SlideSnapshot {
  hp: number
  moveSpeed: number
  alive: boolean
}

interface PawnMemo {
  owner: PlayerId
  hits: Hit[]
  flight: Hit | null
  /** first tick of the current unbroken lava stay */
  stayStart: number | null
  /** the pawn as the previous state had it */
  slide: Slide
  /** a pending close call's hit tick */
  closeAt: number | null
  /** round of this player's last close call */
  closeRound: number
}

/** score parts (Rule 15) */
interface Parts {
  base: number
  stakes: number
  spectacle: number
  novelty: number
}

/** An open multi-knockout chain, or the kill that may start one. */
interface Chain {
  /** the chain's first kill: victim, window start, death tick */
  victim: PlayerId
  from: number
  tick: number
  moment: Moment | null
  last: number
}

/** A death of this tick and its knockout, for the round decider. */
interface TickDeath {
  owner: PlayerId
  knockout: Moment | null
}

export class MomentsEngine {
  private moments: Moment[] = []
  private parts = new Map<number, Parts>()
  private pawns = new Map<EntityId, PawnMemo>()
  private tally = new KillTally()
  private chains = new Map<PlayerId, Chain>()
  /** earlier moments per kind and first actor (novelty) */
  private seen = new Map<string, number>()
  /** projectiles a Shield had stolen, as the previous state had them: id -> new owner and spell */
  private stolen: ReadonlyMap<EntityId, { owner: PlayerId; spell: string }> = new Map()
  private round = 0
  private lastTick = -1
  /** sides at fight start (team modes) */
  private teamAt = new Map<PlayerId, number>()
  private teamSizes = new Map<number, number>()
  /** clutch candidates: the side's last warlock, from when, and the most enemies faced */
  private clutch = new Map<PlayerId, { at: number; enemies: number; victims: PlayerId[] }>()
  /** the most round wins each player was behind the leader at a round win */
  private deficit = new Map<PlayerId, number>()
  private deciders = new Map<number, Moment>()
  private matchDecider: Moment | null = null
  private changed = new Set<Moment>()

  reset(): void {
    this.moments = []
    this.parts.clear()
    this.pawns.clear()
    this.tally.reset()
    this.chains.clear()
    this.seen.clear()
    this.stolen = new Map()
    this.round = 0
    this.lastTick = -1
    this.teamAt.clear()
    this.teamSizes.clear()
    this.clutch.clear()
    this.deficit.clear()
    this.deciders.clear()
    this.matchDecider = null
    this.changed.clear()
  }

  all(): readonly Moment[] {
    return this.moments
  }

  /** the knockout that ended `round`, if one did */
  deciderOf(round: number): Moment | null {
    return this.deciders.get(round) ?? null
  }

  /** One authoritative tick (or several, from a snapshot client). Returns the moments created or changed by it. */
  update(events: readonly SimEvent[], state: SimState): readonly Moment[] {
    // a new match (or a replay seek back) restarts the clock
    if (state.tick < this.lastTick - ticks(1)) this.reset()
    this.lastTick = state.tick
    this.changed.clear()
    const prevStolen = this.stolen
    let dying: Set<EntityId> | null = null
    let deaths: TickDeath[] | null = null
    for (const e of events) {
      switch (e.type) {
        case 'phase':
          if (e.phase === 'fight') this.startFight(state)
          break
        case 'damage': {
          if (dying === null) {
            dying = new Set()
            for (const d of events) if (d.type === 'death' && d.cause !== 'disconnect') dying.add(d.pawn)
          }
          this.onDamage(e, events, state, prevStolen, dying)
          break
        }
        case 'teleport':
          this.onTeleport(e, state)
          break
        case 'death':
          if (e.cause === 'disconnect') break
          ;(deaths ??= []).push({ owner: e.owner, knockout: this.onDeath(e, state) })
          break
        case 'roundWin':
          this.onRoundWin(e, state, deaths ?? [])
          break
        case 'gameOver':
          this.onGameOver(e)
          break
      }
    }
    this.statePass(state)
    // stolen projectiles for the next tick's reflected check (no allocation while there are none)
    let next: Map<EntityId, { owner: PlayerId; spell: string }> | null = null
    for (const p of state.projectiles) {
      const orig = p.data.origOwner
      if (orig !== undefined && orig !== p.owner) (next ??= new Map()).set(p.id, { owner: p.owner, spell: p.spell })
    }
    this.stolen = next ?? NONE_STOLEN
    return this.changed.size === 0 ? NO_MOMENTS : [...this.changed]
  }

  // ------------------------------------------------------------------ events

  private startFight(state: SimState): void {
    this.round = state.round
    this.clutch.clear()
    this.teamAt.clear()
    this.teamSizes.clear()
    for (const s of state.slots) {
      if (!isRoundParticipant(state, s.id)) continue
      this.teamAt.set(s.id, s.team)
      this.teamSizes.set(s.team, (this.teamSizes.get(s.team) ?? 0) + 1)
    }
    for (const m of this.pawns.values()) {
      m.hits = []
      m.flight = null
      m.stayStart = null
      m.closeAt = null
    }
  }

  private memo(id: EntityId, state: SimState): PawnMemo | null {
    let m = this.pawns.get(id)
    if (m) return m
    const p = state.pawns.find((q) => q.id === id)
    if (!p) return null
    m = {
      owner: p.owner,
      hits: [],
      flight: null,
      stayStart: null,
      slide: writeSlide({ x: 0, y: 0, kbx: 0, kby: 0, inLava: false, hp: p.hp, moveSpeed: p.moveSpeed, alive: p.alive }, p),
      closeAt: null,
      closeRound: -1,
    }
    this.pawns.set(id, m)
    return m
  }

  private teamOf(state: SimState, id: PlayerId): number {
    return state.slots.find((s) => s.id === id)?.team ?? id
  }

  /** Rules 3, 4 and 13. */
  private onDamage(e: Extract<SimEvent, { type: 'damage' }>, events: readonly SimEvent[], state: SimState, prevStolen: ReadonlyMap<EntityId, { owner: PlayerId; spell: string }>, dying: ReadonlySet<EntityId>): void {
    const p = state.pawns.find((q) => q.id === e.target)
    if (!p) return
    const m = this.memo(e.target, state)
    if (!m) return
    // close call: a qualifying hit (re)starts the clock, once per player per round
    if (state.phase === 'fight' && m.closeRound !== this.round && isCloseCallHit(e, p)) m.closeAt = state.tick
    if (!(e.kb > 0) && !dying.has(e.target)) return
    let src = e.source
    let pillar = false
    if (src === null && e.cause === 'obstacle') {
      // a pillar blast: whoever broke the nearest pillar this tick
      let best = Infinity
      for (const o of events) {
        if (o.type !== 'obstacleDestroyed' || o.by === null || o.by === undefined) continue
        const d = hypot(o.x - e.x, o.y - e.y)
        if (d <= OBSTACLE_EXPLODE_RADIUS && d < best) {
          best = d
          src = o.by
        }
      }
      pillar = src !== null
    }
    if (src === null || src === m.owner || this.teamOf(state, src) === this.teamOf(state, m.owner)) return
    const cause = e.cause ?? ''
    let reflected = false
    if (prevStolen.size > 0) {
      for (const o of events) {
        if (o.type !== 'projectileHit' && o.type !== 'projectileExpire') continue
        const s = prevStolen.get(o.id)
        if (s && s.owner === src && s.spell === cause) reflected = true
      }
    }
    let detonation = false
    if (cause === 'lightning') {
      for (const o of events) if (o.type === 'explosion' && o.spell === 'lightning' && hypot(o.x - e.x, o.y - e.y) <= o.radius) detonation = true
    }
    const hit: Hit = {
      tick: state.tick, src, kb: e.kb, cause: pillar ? 'obstacle' : cause, x: e.x, y: e.y, reflected, detonation, pillar,
      x0: e.x, y0: e.y, flying: false, flightEnd: state.tick, flightLen: 0, dirX: 0, dirY: 0,
    }
    if (e.kb > 0) {
      // the next knockback hit ends the running flight
      if (m.flight) this.endFlight(m.flight, e.x, e.y, state.tick)
      m.flight = null
      if (e.kb >= FLIGHT_START_SPEED) {
        hit.flying = true
        m.flight = hit
      }
      const kx = p.vx - p.walkVx
      const ky = p.vy - p.walkVy
      const l = hypot(kx, ky)
      if (l > 0) {
        hit.dirX = kx / l
        hit.dirY = ky / l
      }
    }
    m.hits.push(hit)
    const keep = this.sealTicks(p.maxHp, state)
    while (m.hits.length > 0 && m.hits[0].tick < state.tick - keep) m.hits.shift()
  }

  private endFlight(h: Hit, x: number, y: number, tick: number): void {
    h.flying = false
    h.flightEnd = tick
    h.flightLen = hypot(x - h.x0, y - h.y0)
  }

  /** how far back a lava death looks for its push: the longest possible stay plus SEAL_FLIGHT_EXTRA */
  private sealTicks(maxHp: number, state: SimState): number {
    const dps = state.settings.lavaDps
    return dps > 0 ? ticks(maxHp / dps + SEAL_FLIGHT_EXTRA) : Infinity
  }

  /** Rule 11. */
  private onTeleport(e: Extract<SimEvent, { type: 'teleport' }>, state: SimState): void {
    const m = this.pawns.get(e.pawn)
    if (!m || state.phase !== 'fight' || !m.slide.alive) return
    if (!isDeniedEscape(m.slide, m.slide, e.toX, e.toY, state)) return
    const tick = state.tick
    let pusher: Hit | null = null
    for (let i = m.hits.length - 1; i >= 0; i--) {
      if (m.hits[i].kb > 0) {
        pusher = m.hits[i]
        break
      }
    }
    if (pusher && !this.carried(pusher, m.stayStart ?? tick)) pusher = null
    this.add('denied', {
      round: this.round, tick, end: tick,
      from: (pusher ? pusher.tick : tick - ticks(DENIED_LEAD)) - ticks(MOMENT_PRE), to: tick + ticks(DENIED_LEAD),
      actors: [m.owner], victims: pusher ? [pusher.src] : [], cause: null, count: 1, final: true,
      camera: { subject: e.pawn, other: pusher ? this.pawnOf(state, pusher.src) : null, x: m.slide.x, y: m.slide.y, dirX: pusher?.dirX ?? 0, dirY: pusher?.dirY ?? 0 },
    }, { base: 1.2, stakes: 1, spectacle: 1 })
  }

  /** the hit kept the pawn in the lava stay that began at `stayStart`, or carried it there */
  private carried(h: Hit, stayStart: number): boolean {
    return h.tick >= stayStart || h.flying || h.flightEnd >= stayStart - ticks(SEAL_GRACE)
  }

  private pawnOf(state: SimState, owner: PlayerId): EntityId | null {
    return state.pawns.find((q) => q.owner === owner)?.id ?? null
  }

  /** Rules 6, 7 and 10. Returns the death's knockout. */
  private onDeath(e: Extract<SimEvent, { type: 'death' }>, state: SimState): Moment | null {
    const tick = state.tick
    const m = this.memo(e.pawn, state)
    if (m?.flight) {
      this.endFlight(m.flight, e.x ?? m.slide.x, e.y ?? m.slide.y, tick)
      m.flight = null
    }
    if (m) m.closeAt = null
    let seal: Hit | null = null
    if (m && e.cause === 'lava') {
      let h: Hit | null = null
      for (let i = m.hits.length - 1; i >= 0; i--) {
        if (m.hits[i].kb > 0) {
          h = m.hits[i]
          break
        }
      }
      const maxHp = state.pawns.find((q) => q.id === e.pawn)?.maxHp ?? 0
      // a warlock that burns up on its first lava tick never had a state in the lava: its stay is this tick
      const stayStart = m.stayStart ?? tick
      if (h && tick - h.tick <= this.sealTicks(maxHp, state) && this.carried(h, stayStart)) seal = h
    } else if (m) {
      for (let i = m.hits.length - 1; i >= 0; i--) {
        if (m.hits[i].tick === tick) {
          seal = m.hits[i]
          break
        }
      }
    }
    let knockout: Moment | null = null
    if (seal) {
      const traits: MomentTrait[] = []
      if (seal.reflected) traits.push('reflected')
      if (seal.detonation) traits.push('detonation')
      if (seal.pillar || e.cause === 'obstacle') traits.push('pillarBlast')
      if (seal.flightLen > LONG_FLIGHT) traits.push('longFlight')
      knockout = this.add('knockout', {
        round: this.round, tick: seal.tick, end: tick, from: seal.tick - ticks(MOMENT_PRE), to: tick + ticks(MOMENT_POST),
        actors: [seal.src], victims: [e.owner], cause: seal.cause, count: 1, final: true, traits,
        camera: { subject: e.pawn, other: this.pawnOf(state, seal.src), x: seal.x, y: seal.y, dirX: seal.dirX, dirY: seal.dirY },
      }, { base: 1, stakes: 1, spectacle: 0.85 + 0.15 * Math.min(2, seal.kb / 1500) })
    }
    // clutch: an enemy of a candidate falls
    for (const [player, c] of this.clutch) if (this.teamAt.get(player) !== this.teamAt.get(e.owner)) c.victims.push(e.owner)
    this.multi(e, knockout, tick)
    return knockout
  }

  /** Rule 10: credited kills chained like the announcer's (KillTally). */
  private multi(e: Extract<SimEvent, { type: 'death' }>, knockout: Moment | null, tick: number): void {
    const kill = this.tally.death(e.owner, e.killer, tick / TICK_HZ)
    if (!kill) return
    const from = knockout ? knockout.from : tick - ticks(MULTI_WINDOW + MOMENT_PRE)
    if (kill.chain === 1) {
      this.chains.set(kill.killer, { victim: e.owner, from, tick, moment: null, last: tick })
      return
    }
    const c = this.chains.get(kill.killer)
    if (!c) return
    c.last = tick
    if (!c.moment) {
      c.moment = this.add('multiKnockout', {
        round: this.round, tick: c.tick, end: tick, from: c.from, to: tick + ticks(MOMENT_POST),
        actors: [kill.killer], victims: [c.victim, e.owner], cause: null, count: 2, final: false,
        camera: { subject: e.pawn, other: knockout?.camera.other ?? null, x: e.x ?? 0, y: e.y ?? 0, dirX: 0, dirY: 0 },
      }, { base: 0.9 * 2, stakes: 1, spectacle: 1 })
      return
    }
    const mm = c.moment
    mm.count = kill.chain
    mm.victims.push(e.owner)
    mm.end = tick
    mm.to = tick + ticks(MOMENT_POST)
    this.parts.get(mm.id)!.base = 0.9 * kill.chain
    this.rescore(mm)
  }

  /** Rules 8, 9, 12 and 14. */
  private onRoundWin(e: Extract<SimEvent, { type: 'roundWin' }>, state: SimState, deaths: readonly TickDeath[]): void {
    const tick = state.tick
    // the last death's knockout, else the latest knockout of the tick's other deaths
    let decider: Moment | null = null
    for (let i = deaths.length - 1; i >= 0 && !decider; i--) decider = deaths[i].knockout
    const matchOver = gameWinners(state) !== null
    if (decider) {
      this.addTrait(decider, 'roundDecider')
      if (matchOver) {
        this.addTrait(decider, 'matchDecider')
        this.matchDecider = decider
      }
      this.deciders.set(this.round, decider)
    }
    // clutch: the side's last warlock survived two or more enemies and won
    for (const [player, c] of this.clutch) {
      if (!e.players.includes(player) || !state.pawns.some((q) => q.owner === player && q.alive)) continue
      const to = tick + ticks(CLUTCH_TAIL)
      const from = Math.max(c.at, decider?.from ?? c.at, to - ticks(CLUTCH_MAX))
      const subject = this.pawnOf(state, player)
      const pawn = state.pawns.find((q) => q.owner === player)
      this.add('clutch', {
        round: this.round, tick, end: tick, from, to, actors: [player], victims: c.victims.slice(), cause: null, count: c.enemies, final: true,
        camera: { subject: subject ?? -1, other: null, x: pawn?.x ?? 0, y: pawn?.y ?? 0, dirX: 0, dirY: 0 },
      }, { base: 1.5 + 0.5 * (c.enemies - 2), stakes: matchOver ? 2.5 : 1.5, spectacle: 1 })
    }
    this.clutch.clear()
    // close calls still pending are confirmed by surviving the round
    for (const [id, m] of this.pawns) {
      if (m.closeAt === null) continue
      const p = state.pawns.find((q) => q.id === id)
      if (p?.alive) this.confirmClose(m, id, state)
      else m.closeAt = null
    }
    // comeback bookkeeping: how far behind the leader each player is (team modes: by side)
    if (state.settings.gameMode === 'rounds') {
      const team = state.settings.teamMode === 'teams'
      const side = new Map<number, number>()
      for (const sc of state.scores) {
        const s = team ? this.teamOf(state, sc.id) : sc.id
        side.set(s, Math.max(side.get(s) ?? 0, sc.score))
      }
      let top = 0
      for (const v of side.values()) top = Math.max(top, v)
      for (const sc of state.scores) {
        const own = side.get(team ? this.teamOf(state, sc.id) : sc.id) ?? 0
        this.deficit.set(sc.id, Math.max(this.deficit.get(sc.id) ?? 0, top - own))
      }
    }
  }

  private onGameOver(e: Extract<SimEvent, { type: 'gameOver' }>): void {
    if (this.matchDecider && e.winners.some((w) => (this.deficit.get(w) ?? 0) >= 2)) this.addTrait(this.matchDecider, 'comeback')
    for (const m of this.moments) {
      if (m.final) continue
      m.final = true
      this.changed.add(m)
    }
    for (const m of this.pawns.values()) m.closeAt = null
  }

  private confirmClose(m: PawnMemo, id: EntityId, state: SimState): void {
    const at = m.closeAt!
    m.closeAt = null
    m.closeRound = this.round
    const from = at - ticks(MOMENT_PRE)
    this.add('closeCall', {
      round: this.round, tick: at, end: at, from, to: Math.min(state.tick + ticks(MOMENT_POST), from + ticks(CLOSE_CALL_MAX)),
      actors: [m.owner], victims: [], cause: null, count: 1, final: true,
      camera: { subject: id, other: null, x: m.slide.x, y: m.slide.y, dirX: 0, dirY: 0 },
    }, { base: 0.8, stakes: 1, spectacle: 1 })
  }

  // ------------------------------------------------------------------ state pass

  private statePass(state: SimState): void {
    const tick = state.tick
    const fight = state.phase === 'fight'
    for (const p of state.pawns) {
      const m = this.pawns.get(p.id) ?? (fight ? this.memo(p.id, state) : null)
      if (!m) continue
      if (m.flight) {
        if (!p.alive || hypot(p.vx - p.walkVx, p.vy - p.walkVy) < FLIGHT_STOP_SPEED) {
          this.endFlight(m.flight, p.x, p.y, tick)
          m.flight = null
        }
      }
      if (p.alive && p.lavaTicks > 0) {
        if (m.stayStart === null) m.stayStart = tick
      } else m.stayStart = null
      if (m.closeAt !== null && tick - m.closeAt >= ticks(CLOSE_CALL_SAFE)) {
        if (!p.alive) m.closeAt = null
        else if (fight && p.lavaTicks === 0) this.confirmClose(m, p.id, state)
      }
      writeSlide(m.slide, p)
      m.slide.hp = p.hp
      m.slide.moveSpeed = p.moveSpeed
      m.slide.alive = p.alive
    }
    // multi-knockouts are final once the window passes without a link
    for (const c of this.chains.values()) {
      if (c.moment && !c.moment.final && tick - c.last > ticks(MULTI_WINDOW)) {
        c.moment.final = true
        this.changed.add(c.moment)
      }
    }
    if (fight && this.teamSizes.size > 0) this.clutchPass(state)
  }

  /** Rule 12: team modes only; a side's last warlock against two or more enemies is a candidate. */
  private clutchPass(state: SimState): void {
    let teamsOfTwo = false
    for (const n of this.teamSizes.values()) if (n >= 2) teamsOfTwo = true
    if (!teamsOfTwo) return
    const alive = new Map<number, PlayerId[]>()
    for (const q of state.pawns) {
      if (!q.alive || !this.teamAt.has(q.owner)) continue
      const side = this.teamAt.get(q.owner)!
      const list = alive.get(side)
      if (list) list.push(q.owner)
      else alive.set(side, [q.owner])
    }
    for (const [side, members] of alive) {
      if ((this.teamSizes.get(side) ?? 0) < 2 || members.length !== 1) continue
      let enemies = 0
      for (const [other, list] of alive) if (other !== side) enemies += list.length
      const c = this.clutch.get(members[0])
      if (c) c.enemies = Math.max(c.enemies, enemies)
      else if (enemies >= 2) this.clutch.set(members[0], { at: state.tick, enemies, victims: [] })
    }
  }

  // ------------------------------------------------------------------ moments and scores

  private add(kind: MomentKind, m: Omit<Moment, 'id' | 'kind' | 'score' | 'traits'> & { traits?: MomentTrait[] }, parts: Omit<Parts, 'novelty'>): Moment {
    const key = `${kind}:${m.actors[0]}`
    const k = this.seen.get(key) ?? 0
    this.seen.set(key, k + 1)
    const moment: Moment = { ...m, id: this.moments.length, kind, traits: [...(m.traits ?? [])].sort(), score: 0 }
    this.parts.set(moment.id, { ...parts, novelty: Math.max(0.4, Math.pow(0.8, k)) })
    this.rescore(moment)
    this.moments.push(moment)
    this.changed.add(moment)
    return moment
  }

  private addTrait(m: Moment, trait: MomentTrait): void {
    if (m.traits.includes(trait)) return
    m.traits = [...m.traits, trait].sort()
    const parts = this.parts.get(m.id)!
    if (trait === 'roundDecider') parts.stakes = Math.max(parts.stakes, 1.5)
    if (trait === 'matchDecider') parts.stakes = 2.5
    this.rescore(m)
  }

  private rescore(m: Moment): void {
    m.score = momentScore(m, this.parts.get(m.id)!)
    this.changed.add(m)
  }
}

const TRAIT_WEIGHT: Partial<Record<MomentTrait, number>> = { reflected: 1.8, detonation: 1.6, pillarBlast: 1.5, longFlight: 1.3, comeback: 1.2 }

/** Rule 15: base x stakes x spectacle x novelty, rounded to 3 decimals; deciders skip novelty. */
function momentScore(m: Moment, p: Parts): number {
  let base = p.base
  if (m.kind === 'knockout') for (const t of m.traits) base *= TRAIT_WEIGHT[t] ?? 1
  const novelty = p.stakes > 1 ? 1 : p.novelty
  return Math.round(base * p.stakes * p.spectacle * novelty * 1000) / 1000
}

const NONE_STOLEN: ReadonlyMap<EntityId, { owner: PlayerId; spell: string }> = new Map()
const NO_MOMENTS: readonly Moment[] = []

type Listener = (changed: readonly Moment[]) => void
const listeners = new Set<Listener>()

/** Moments created or changed per confirmed tick of the current match. `subscribe` returns its unsubscribe. */
export const momentEvents = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  emit(changed: readonly Moment[]): void {
    if (changed.length > 0) for (const fn of listeners) fn(changed)
  },
}

/** The current match's moments, fed by the match recorder from the confirmed stream. */
export const matchMoments = new MomentsEngine()
