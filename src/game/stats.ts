/**
 * Local match statistics. No server yet, so every peer records the matches it
 * saw into localStorage: match history (bounded), career totals for the local
 * profile, head-to-head encounters per opponent profile, a local Elo rating
 * per profile (bots rate as 'bot:<difficulty>'), and personal bests.
 *
 * Flow: the session creates a MatchTracker at match start, feeds it every played
 * tick's state + events (offline / host: one tick at a time; online clients: the
 * newest snapshot with every event since the last one), and at game over turns it
 * into a MatchRecord that recordMatch() folds into the stored aggregates.
 *
 * Memory is bounded: the tracker keeps counters per player (and per spell / cause),
 * never per-tick arrays. Aggregates are updated incrementally, so career, encounters
 * and the hall of fame outlive the history cap. Corrupt or foreign data never throws:
 * it is ignored field by field, and v1 saves are migrated in place.
 */
import type { BotDifficulty, GameMode, MatchSettings, PlayerId, PlayerSlot, SimEvent, SimState, TeamMode } from '../sim/types'
import { TICK_HZ } from '../sim/types'
import { ITEM_SLOT_START, MASTERY_MAX_LEVEL, SLOT_COUNT, SPELL_MAX_LEVEL } from '../sim/config'
import { PASSIVE_ITEMS, SPELLS } from '../sim/spells/data'
import type { InspectedKit } from './inspect'
import { KillTally } from './announcer'
import { isTeleportSave, slideDecay, slideSnapshot } from './teleportSave'
import { randomId, safeLocalStorage, type KV } from './profile'
import type { MatchResult } from './store'

// ---------------------------------------------------------------------------
// Types (read API for the UI)
// ---------------------------------------------------------------------------

/**
 * What one player did in one match, as this browser saw it. Distances in game units
 * (a tile is 192), times in seconds, all values rounded (1 decimal for seconds).
 */
export interface PlayerMatchStats {
  // movement
  /** distance covered by the player's own walking */
  walked: number
  /** distance covered while knocked around (knockback velocity, not walking) */
  pushed: number
  /** longest single knockback flight, start to stop, straight line */
  longestFlight: number
  /** total Teleport distance */
  teleported: number
  // combat
  /** to other players */
  damageDealt: number
  /** from every source, lava included */
  damageTaken: number
  knockbacksDealt: number
  knockbacksTaken: number
  /** credited kills by the death's cause ('lava' = pushed into the lava, 'scourge', ...) */
  killsByCause: Record<string, number>
  deathsByCause: Record<string, number>
  /** deaths nobody else is credited for: walked into lava, own blast. Disconnects excluded */
  selfKills: number
  /** kills credited as the last hitter, the lava or a pillar did the rest */
  lastHitKills: number
  firstBlood: boolean
  /** most kills without dying (announcer's streak) */
  bestStreak: number
  /** longest multi-kill chain (announcer's window): 2 = double ... */
  bestMulti: number
  // spells
  /** spell id -> [casts, hits]; a hit = a cast that damaged at least one enemy */
  spells: Record<string, [number, number]>
  /** enemies hit by Scourge (each enemy in each blast) */
  scourgeHits: number
  /** Teleports out of the lava or off a lava-bound slide onto safe ground */
  teleportSaves: number
  /** enemy projectiles a Shield turned back or stole */
  shieldReflects: number
  pillarsDestroyed: number
  // survival
  /** time alive during fights */
  aliveSec: number
  lavaSec: number
  lavaDamage: number
  /** rounds this player was still standing when the round was decided */
  roundsSurvived: number
  // economy
  /** gold received during the match (start gold not counted) */
  goldEarned: number
  goldSpent: number
  /** highest-level spell or item owned at the end: [id, level] */
  topSpell: [string, number] | null
}

export interface Participant {
  player: PlayerId
  /** stable profile id, 'bot:<difficulty>' for bots, empty for unidentified legacy humans */
  profileId: string
  name: string
  color: number
  kind: 'human' | 'bot'
  difficulty?: BotDifficulty
  team: number
  score: number
  kills: number
  deaths: number
  /** damage dealt to other players over the whole match */
  damage: number
  won: boolean
  /** detailed stats (absent in old saves and in history older than HISTORY_DETAIL_MAX) */
  stats?: PlayerMatchStats
  /** Last observed equipment and upgrades, detached from the running simulation. */
  build?: InspectedKit
}

export type Outcome = 'win' | 'loss' | 'spectator'
export type MatchQueue = 'ranked' | 'casual' | 'custom' | 'offline'

export type AwardId =
  | 'butcher'
  | 'marathon'
  | 'pinball'
  | 'frequentFlyer'
  | 'lavaLover'
  | 'oops'
  | 'sniper'
  | 'untouchable'
  | 'escapeArtist'
  | 'ringOfFire'
  | 'returnToSender'
  | 'demolition'
  | 'hazardPay'
  | 'raidBoss'
  | 'sprayAndPray'
  | 'passenger'
  | 'personalGrudge'

export interface Award {
  id: AwardId
  title: string
  player: PlayerId
  value: number
  /** 'u' game units, 's' seconds, '%' percent (value 0..100), '' a count */
  unit: 'u' | 's' | '%' | ''
  blurb: string
}

export interface MatchRecord {
  /** Absent on legacy records whose queue was not recorded. */
  queue?: MatchQueue
  /** Server-confirmed rating outcome; absent on historical records without confirmation. */
  rating?: import('../net/rating').MatchRating
  id: string
  /** ms since epoch, local clock */
  date: number
  teamMode: TeamMode
  gameMode: GameMode
  settings: MatchSettings
  rounds: number
  durationSec: number
  participants: Participant[]
  winners: PlayerId[]
  /** local player id in this match, -1 = spectated */
  self: PlayerId
  outcome: Outcome
  /** kills between participants: [killer, victim, count] */
  kills: [PlayerId, PlayerId, number][]
  /** damage between participants: [from, to, amount] */
  damage: [PlayerId, PlayerId, number][]
  /** player who drew first blood, null = nobody */
  firstBlood?: PlayerId | null
  /** fun titles picked at the end of the match (matchAwards) */
  awards?: Award[]
  /** account reward lookup for this match (Embers), when the server issued one */
  progression?: { matchId: string; status: 'pending' | 'awarded' | 'ineligible' | 'unavailable' }
}

/** Career totals of the movement / combat counters (summed PlayerMatchStats). */
export interface CareerTotals {
  walked: number
  pushed: number
  teleported: number
  damageTaken: number
  knockbacksDealt: number
  knockbacksTaken: number
  selfKills: number
  lastHitKills: number
  firstBloods: number
  casts: number
  hits: number
  scourgeHits: number
  teleportSaves: number
  shieldReflects: number
  pillarsDestroyed: number
  aliveSec: number
  lavaSec: number
  lavaDamage: number
  roundsSurvived: number
  goldEarned: number
  goldSpent: number
  killsByCause: Record<string, number>
  deathsByCause: Record<string, number>
}

export type HallOfFameKey =
  | 'mostKills'
  | 'mostDamage'
  | 'bestStreak'
  | 'bestMulti'
  | 'longestFlight'
  | 'mostPushed'
  | 'mostWalked'
  | 'bestAccuracy'
  | 'mostScourgeHits'
  | 'mostTeleportSaves'
  | 'mostReflects'
  | 'longestAlive'

export interface HallOfFameEntry {
  value: number
  date: number
  matchId: string
}

export interface Career {
  profileId: string
  games: number
  wins: number
  losses: number
  kills: number
  deaths: number
  damage: number
  rounds: number
  seconds: number
  winStreak: number
  bestWinStreak: number
  vsHumans: { games: number; wins: number }
  vsBots: { games: number; wins: number }
  firstPlayed: number
  lastPlayed: number
  totals: CareerTotals
  /** personal bests, one match each */
  hallOfFame: Partial<Record<HallOfFameKey, HallOfFameEntry>>
}

/** Head-to-head record of the local player against one opponent profile. */
export interface Encounter {
  profileId: string
  lastName: string
  lastColor: number
  kind: 'human' | 'bot'
  difficulty?: BotDifficulty
  games: number
  wins: number
  losses: number
  /** both won (teammates) or both lost (someone else won) */
  draws: number
  /** times the local player killed them */
  killsOn: number
  /** times they killed the local player */
  deathsTo: number
  damageDealt: number
  damageTaken: number
  firstSeen: number
  lastSeen: number
}

export interface RatingRow {
  profileId: string
  name: string
  color: number
  kind: 'human' | 'bot'
  rating: number
  games: number
  wins: number
  losses: number
  lastSeen: number
  /** the local profile */
  self: boolean
}

// ---------------------------------------------------------------------------
// Elo (pure)
// ---------------------------------------------------------------------------

export const ELO_START = 1500
export const ELO_K = 32

/** Expected score of a player rated `a` against one rated `b`. */
export function eloExpected(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400))
}

/**
 * Pairwise Elo for one match of N players. `outcome(i, j)` is 1 if i beat j, 0 if
 * j beat i, 0.5 for a draw, null to skip the pair (teammates). Each player's change
 * is averaged over their pairs, so K means "per match" at any player count and a
 * 1v1 is the classic zero-sum Elo update.
 */
export function eloUpdate(ratings: number[], outcome: (i: number, j: number) => number | null, k = ELO_K): number[] {
  const n = ratings.length
  const delta = new Array<number>(n).fill(0)
  const pairs = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = outcome(i, j)
      if (s === null) continue
      const d = k * (s - eloExpected(ratings[i], ratings[j]))
      delta[i] += d
      delta[j] -= d
      pairs[i]++
      pairs[j]++
    }
  }
  return ratings.map((r, i) => (pairs[i] ? r + delta[i] / pairs[i] : r))
}

/** Pairwise result inside a recorded match: winners beat the rest, then higher score. */
export function pairOutcome(rec: Pick<MatchRecord, 'teamMode'>, a: Participant, b: Participant): number | null {
  if (rec.teamMode === 'teams' && a.team === b.team) return null
  if (a.won !== b.won) return a.won ? 1 : 0
  if (a.score !== b.score) return a.score > b.score ? 1 : 0
  return 0.5
}

// ---------------------------------------------------------------------------
// Tracker: consumes the played event stream of one match
// ---------------------------------------------------------------------------

export interface TrackerInfo {
  queue?: MatchQueue
  localPlayer: PlayerId
  slots: PlayerSlot[]
  settings: MatchSettings
}

export function profileIdOf(slot: PlayerSlot): string {
  if (slot.kind === 'bot') return `bot:${slot.difficulty ?? 'medium'}`
  return slot.profileId ?? ''
}

/** Missing IDs and old name-based anonymous labels cannot identify a persistent human. */
export function hasProfileIdentity(p: Pick<Participant, 'profileId' | 'kind'>): boolean {
  return !!p.profileId && (p.kind === 'bot' || !p.profileId.startsWith('anon:'))
}

/** a knockback flight starts above this knockback speed (u/s) ... */
export const FLIGHT_START_SPEED = 200
/** ... and ends once it decays below this one */
export const FLIGHT_STOP_SPEED = 20
/** spells whose hits are counted for accuracy (they deal damage) */
const DAMAGING = new Set([
  'fireball', 'scourge', 'boomerang', 'lightning', 'homing', 'twin', 'thrust', 'cluster', 'drain',
  'bouncer', 'recharge', 'windwalk', 'meteor', 'splitter', 'snowball', 'gravity', 'link',
])

/** Running counters of one player. */
class Acc {
  walked = 0
  pushed = 0
  longestFlight = 0
  teleported = 0
  damageDealt = 0
  damageTaken = 0
  knockbacksDealt = 0
  knockbacksTaken = 0
  killsByCause = new Map<string, number>()
  deathsByCause = new Map<string, number>()
  selfKills = 0
  lastHitKills = 0
  firstBlood = false
  bestStreak = 0
  bestMulti = 0
  spells = new Map<string, [number, number]>()
  /** casts per spell still waiting for their first enemy hit */
  armed = new Map<string, number>()
  scourgeHits = 0
  teleportSaves = 0
  shieldReflects = 0
  pillarsDestroyed = 0
  aliveSec = 0
  lavaSec = 0
  lavaDamage = 0
  roundsSurvived = 0
  goldEarned = 0
  goldSpent = 0
  topSpell: [string, number] | null = null
  // last observed pawn state
  seen = false
  x = 0
  y = 0
  kbx = 0
  kby = 0
  inLava = false
  lastGold: number | null = null
  flight: { x: number; y: number } | null = null

  endFlight(x: number, y: number): void {
    if (!this.flight) return
    const d = Math.hypot(x - this.flight.x, y - this.flight.y)
    if (d > this.longestFlight) this.longestFlight = d
    this.flight = null
  }
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export class MatchTracker {
  private firstTick = -1
  private lastTick = -1
  /** `${killer}>${victim}` → count */
  private killPairs = new Map<string, number>()
  /** `${from}>${to}` → damage */
  private dmgPairs = new Map<string, number>()
  private readonly accs = new Map<PlayerId, Acc>()
  private readonly builds = new Map<PlayerId, InspectedKit>()
  private readonly tally = new KillTally()
  private firstBlood: PlayerId | null = null
  private readonly info: TrackerInfo
  /** per-second decay rate of knockback velocity: v(t) = v0 * e^(-decay t) */
  private readonly decay: number

  constructor(info: TrackerInfo) {
    this.info = info
    this.decay = slideDecay(info.settings?.friction)
  }

  private acc(p: PlayerId): Acc {
    let a = this.accs.get(p)
    if (!a) {
      a = new Acc()
      this.accs.set(p, a)
    }
    return a
  }

  /** Feed one played tick (or several ticks' events with the newest state). */
  observe(state: SimState, events: readonly SimEvent[]): void {
    const tick = n(state.tick)
    if (this.firstTick < 0) this.firstTick = tick
    const dt = this.lastTick >= 0 ? Math.max(0, tick - this.lastTick) / TICK_HZ : 0
    if (tick > this.lastTick) this.lastTick = tick
    const now = tick / TICK_HZ
    const pawns = Array.isArray(state.pawns) ? state.pawns : []
    const ownerOf = new Map<number, PlayerId>()
    for (const p of pawns) ownerOf.set(p.id, p.owner)
    const teamOf = new Map<PlayerId, number>()
    for (const s of Array.isArray(state.slots) ? state.slots : this.info.slots) teamOf.set(s.id, s.team)
    const enemies = (a: PlayerId, b: PlayerId) => a !== b && (teamOf.get(a) === undefined || teamOf.get(a) !== teamOf.get(b))
    const layer = n(state.arena?.layer)
    const fighting = state.phase === 'fight'

    // events first: they happened before the snapshot they arrive with
    for (const e of events) {
      switch (e.type) {
        case 'death': {
          if (e.killer !== null && e.killer !== e.owner) bump(this.killPairs, `${e.killer}>${e.owner}`, 1)
          const victim = this.acc(e.owner)
          const cause = e.cause ?? 'unknown'
          bump(victim.deathsByCause, cause, 1)
          if (e.killer === null && cause !== 'disconnect') victim.selfKills++
          victim.endFlight(e.x ?? victim.x, e.y ?? victim.y)
          const kill = this.tally.death(e.owner, e.killer, now)
          if (kill) {
            const k = this.acc(kill.killer)
            bump(k.killsByCause, cause, 1)
            if (cause === 'lava' || cause === 'obstacle') k.lastHitKills++
            if (kill.streak > k.bestStreak) k.bestStreak = kill.streak
            if (kill.chain > k.bestMulti) k.bestMulti = kill.chain
            if (kill.firstBlood) {
              k.firstBlood = true
              this.firstBlood = kill.killer
            }
          }
          break
        }
        case 'damage': {
          if (!(e.amount > 0)) break
          const target = ownerOf.get(e.target)
          if (target === undefined) break
          const t = this.acc(target)
          t.damageTaken += e.amount
          if (e.cause === 'lava') t.lavaDamage += e.amount
          if (e.kb > 0) t.knockbacksTaken++
          if (e.source === null || e.source === target) break
          bump(this.dmgPairs, `${e.source}>${target}`, e.amount)
          const s = this.acc(e.source)
          s.damageDealt += e.amount
          if (e.kb > 0) s.knockbacksDealt++
          if (e.cause && enemies(e.source, target)) {
            if (e.cause === 'scourge') s.scourgeHits++
            const armed = s.armed.get(e.cause) ?? 0
            if (armed > 0) {
              s.armed.set(e.cause, armed - 1)
              const row = s.spells.get(e.cause)
              if (row) row[1]++
            }
          }
          break
        }
        case 'cast': {
          const owner = ownerOf.get(e.pawn)
          if (owner === undefined) break
          const a = this.acc(owner)
          const row = a.spells.get(e.spell) ?? [0, 0]
          row[0]++
          a.spells.set(e.spell, row)
          if (DAMAGING.has(e.spell)) a.armed.set(e.spell, (a.armed.get(e.spell) ?? 0) + 1)
          break
        }
        case 'teleport': {
          const owner = ownerOf.get(e.pawn)
          if (owner === undefined) break
          const a = this.acc(owner)
          a.teleported += Math.hypot(e.toX - e.fromX, e.toY - e.fromY)
          if (fighting && a.seen && isTeleportSave(a, e.toX, e.toY, layer, this.decay)) a.teleportSaves++
          break
        }
        case 'shieldReflect': {
          const owner = ownerOf.get(e.pawn)
          if (owner !== undefined && (e.reflected || e.stolen)) this.acc(owner).shieldReflects++
          break
        }
        case 'obstacleDestroyed':
          if (e.by !== undefined && e.by !== null) this.acc(e.by).pillarsDestroyed++
          break
        case 'roundWin':
          for (const p of pawns) if (p.alive) this.acc(p.owner).roundsSurvived++
          break
      }
    }

    // then the snapshot: integrate movement over the elapsed time, track flights
    for (const p of pawns) {
      const score = Array.isArray(state.scores) ? state.scores.find((s) => s.id === p.owner) : undefined
      if (score && Array.isArray(p.slots) && Array.isArray(p.levels)) {
        this.builds.set(p.owner, { slots: [...p.slots], levels: [...p.levels], masteries: { ...score.masteries } })
      }
      const a = this.acc(p.owner)
      const x = n(p.x)
      const y = n(p.y)
      const wx = n(p.walkVx)
      const wy = n(p.walkVy)
      const kbx = n(p.vx) - wx
      const kby = n(p.vy) - wy
      const kb = Math.hypot(kbx, kby)
      if (p.alive) {
        if (dt > 0) {
          a.walked += Math.hypot(wx, wy) * dt
          a.pushed += kb * dt
          if (fighting) {
            a.aliveSec += dt
            if (n(p.lavaTicks) > 0) a.lavaSec += dt
          }
        }
        if (!a.flight && kb >= FLIGHT_START_SPEED) a.flight = a.seen ? { x: a.x, y: a.y } : { x, y }
        else if (a.flight && kb < FLIGHT_STOP_SPEED) a.endFlight(x, y)
      } else {
        a.endFlight(a.x, a.y)
      }
      if (Array.isArray(p.slots) && Array.isArray(p.levels)) {
        for (let i = 0; i < p.slots.length; i++) {
          const id = p.slots[i]
          const lv = n(p.levels[i])
          if (id && lv > (a.topSpell?.[1] ?? 0)) a.topSpell = [id, lv]
        }
      }
      a.seen = true
      Object.assign(a, slideSnapshot(p))
    }
    if (Array.isArray(state.scores)) {
      for (const sc of state.scores) {
        const a = this.acc(sc.id)
        const g = n(sc.gold)
        if (a.lastGold !== null) {
          if (g > a.lastGold) a.goldEarned += g - a.lastGold
          else a.goldSpent += a.lastGold - g
        }
        a.lastGold = g
      }
    }
  }

  /** Detached last observed build; callers cannot mutate the tracker's snapshot. */
  buildOf(player: PlayerId): InspectedKit | null {
    const build = this.builds.get(player)
    return build ? { slots: [...build.slots], levels: [...build.levels], masteries: { ...build.masteries } } : null
  }

  /** Per-player stats so far (also used by finish). */
  statsOf(player: PlayerId): PlayerMatchStats {
    const a = this.accs.get(player) ?? new Acc()
    const r = Math.round
    const r1 = (v: number) => Math.round(v * 10) / 10
    const map = (m: Map<string, number>) => Object.fromEntries([...m].map(([k, v]) => [k, r(v)]))
    return {
      walked: r(a.walked),
      pushed: r(a.pushed),
      longestFlight: r(a.longestFlight),
      teleported: r(a.teleported),
      damageDealt: r(a.damageDealt),
      damageTaken: r(a.damageTaken),
      knockbacksDealt: a.knockbacksDealt,
      knockbacksTaken: a.knockbacksTaken,
      killsByCause: map(a.killsByCause),
      deathsByCause: map(a.deathsByCause),
      selfKills: a.selfKills,
      lastHitKills: a.lastHitKills,
      firstBlood: a.firstBlood,
      bestStreak: a.bestStreak,
      bestMulti: a.bestMulti,
      spells: Object.fromEntries([...a.spells].map(([k, [c, h]]) => [k, [c, h] as [number, number]])),
      scourgeHits: a.scourgeHits,
      teleportSaves: a.teleportSaves,
      shieldReflects: a.shieldReflects,
      pillarsDestroyed: a.pillarsDestroyed,
      aliveSec: r1(a.aliveSec),
      lavaSec: r1(a.lavaSec),
      lavaDamage: r(a.lavaDamage),
      roundsSurvived: a.roundsSurvived,
      goldEarned: r(a.goldEarned),
      goldSpent: r(a.goldSpent),
      topSpell: a.topSpell ? [a.topSpell[0], a.topSpell[1]] : null,
    }
  }

  finish(result: MatchResult, date = Date.now()): MatchRecord {
    const slots = result.slots.length ? result.slots : this.info.slots
    const winners = new Set(result.winners)
    const dealt = new Map<PlayerId, number>()
    for (const [key, v] of this.dmgPairs) {
      const from = Number(key.split('>')[0])
      dealt.set(from, (dealt.get(from) ?? 0) + v)
    }
    const participants: Participant[] = slots.map((s) => {
      const sc = result.scores.find((x) => x.id === s.id)
      const build = this.buildOf(s.id)
      return {
        player: s.id,
        profileId: profileIdOf(s),
        name: s.name,
        color: s.color,
        kind: s.kind,
        ...(s.difficulty ? { difficulty: s.difficulty } : {}),
        team: s.team,
        score: sc?.score ?? 0,
        kills: sc?.kills ?? 0,
        deaths: sc?.deaths ?? 0,
        damage: Math.round(dealt.get(s.id) ?? 0),
        won: winners.has(s.id),
        stats: this.statsOf(s.id),
        ...(build ? { build } : {}),
      }
    })
    const self = participants.some((p) => p.player === this.info.localPlayer) ? this.info.localPlayer : -1
    const ticks = result.ticks ?? Math.max(0, this.lastTick - this.firstTick)
    const split = (m: Map<string, number>): [PlayerId, PlayerId, number][] =>
      [...m].map(([k, v]) => {
        const [a, b] = k.split('>').map(Number)
        return [a, b, Math.round(v)]
      })
    const rec: MatchRecord = {
      id: randomId(),
      ...(this.info.queue ? { queue: this.info.queue } : {}),
      date,
      teamMode: this.info.settings.teamMode,
      gameMode: this.info.settings.gameMode,
      settings: { ...this.info.settings },
      rounds: result.rounds,
      durationSec: Math.round(ticks / TICK_HZ),
      participants,
      winners: [...result.winners],
      self,
      outcome: self < 0 ? 'spectator' : winners.has(self) ? 'win' : 'loss',
      kills: split(this.killPairs),
      damage: split(this.dmgPairs),
      firstBlood: this.firstBlood,
      ...(result.rating ? { rating: { ...result.rating } } : {}),
      ...(result.progression ? { progression: { ...result.progression } } : {}),
    }
    rec.awards = matchAwards(rec)
    return rec
  }
}

function bump(m: Map<string, number>, k: string, v: number): void {
  m.set(k, (m.get(k) ?? 0) + v)
}

// ---------------------------------------------------------------------------
// Awards (pure)
// ---------------------------------------------------------------------------

/** Overall accuracy of the damaging spells, null under `minCasts` casts. */
export function accuracy(s: PlayerMatchStats, minCasts = 0): number | null {
  let casts = 0
  let hits = 0
  for (const [id, [c, h]] of Object.entries(s.spells)) {
    if (!DAMAGING.has(id)) continue
    casts += c
    hits += h
  }
  return casts > 0 && casts >= minCasts ? hits / casts : null
}

export function totalKills(s: PlayerMatchStats): number {
  let k = 0
  for (const v of Object.values(s.killsByCause)) k += v
  return k
}

interface AwardDef {
  id: AwardId
  title: string
  unit: Award['unit']
  tone: 'praise' | 'roast'
  /** Avoid several cards describing the same player's one distinctive habit. */
  family?: string
  /** the stat, or null when the player does not qualify at all */
  value: (s: PlayerMatchStats, player: Participant, rec: AwardRecord) => number | null
  /** best value must reach this (higher-is-better) or stay at/below it (lower-is-better) */
  threshold: number
  lowerIsBetter?: boolean
  blurb: (v: number, player: Participant, rec: AwardRecord) => string
}

type AwardRecord = Pick<MatchRecord, 'participants'> & Partial<Pick<MatchRecord, 'kills' | 'teamMode'>>

/** the winner must beat the runner-up by this factor to count as a clear outlier */
export const AWARD_LEAD = 1.25
/** most awards shown for one match */
export const AWARDS_MAX = 5
/** Sniper needs this many damaging casts */
export const SNIPER_MIN_CASTS = 10

const tiles = (u: number) => Math.round(u / 192)

function missedCasts(s: PlayerMatchStats): number | null {
  const aim = accuracy(s, 20)
  if (aim === null || aim > 0.25) return null
  return Object.entries(s.spells).reduce((n, [id, [casts, hits]]) => n + (DAMAGING.has(id) ? Math.max(0, casts - hits) : 0), 0)
}

function favoriteVictim(rec: AwardRecord, player: Participant): { victim: Participant; kills: number; total: number } | null {
  const teamGame = rec.teamMode === 'teams' || rec.teamMode === 'shuffle'
  const kills = rec.kills ?? []
  const victims = rec.participants.filter((p) => p.player !== player.player && (!teamGame || p.team !== player.team))
    .map((victim) => ({ victim, kills: kills.reduce((n, [from, to, count]) => n + (from === player.player && to === victim.player ? count : 0), 0) }))
    .sort((a, b) => b.kills - a.kills || a.victim.player - b.victim.player)
  const first = victims[0]
  const total = kills.reduce((n, [from, to, count]) => n + (from === player.player && to !== player.player ? count : 0), 0)
  // In a duel there is no choice of rival. A tied favourite is not a grudge.
  if (victims.length < 2 || !first || first.kills < 3 || first.kills / Math.max(1, total) < 0.6 || first.kills === victims[1].kills) return null
  return { ...first, total }
}

export const AWARD_DEFS: readonly AwardDef[] = [
  { id: 'butcher', title: 'Butcher', tone: 'praise', family: 'kills', unit: '', value: (s) => totalKills(s), threshold: 3, blurb: (v) => `${v} kills. Nobody was safe.` },
  { id: 'ringOfFire', title: 'Ring of Fire', tone: 'praise', unit: '', value: (s) => s.scourgeHits, threshold: 5, blurb: (v) => `Scourged ${v} warlocks. Personal space, enforced.` },
  { id: 'escapeArtist', title: 'Escape Artist', tone: 'praise', unit: '', value: (s) => s.teleportSaves, threshold: 2, blurb: (v) => `Teleported out of certain doom ${v} times.` },
  { id: 'sniper', title: 'Sniper', tone: 'praise', unit: '%', value: (s) => accuracy(s, SNIPER_MIN_CASTS), threshold: 0.5, blurb: (v) => `${Math.round(v * 100)}% of damaging casts found a target.` },
  { id: 'frequentFlyer', title: 'Frequent Flyer', tone: 'roast', family: 'knockbackTravel', unit: 'u', value: (s) => s.longestFlight, threshold: 900, blurb: (v) => `One knockback carried them ${tiles(v)} tiles. Economy class.` },
  { id: 'pinball', title: 'Pinball', tone: 'roast', family: 'knockbackTravel', unit: 'u', value: (s) => s.pushed, threshold: 4000, blurb: (v) => `Knocked around for ${tiles(v)} tiles. The scenic route.` },
  { id: 'oops', title: 'Oops', tone: 'roast', unit: '', value: (s) => s.selfKills, threshold: 2, blurb: (v) => `${v} uncredited deaths. The arena sends its regards.` },
  { id: 'lavaLover', title: 'Lava Lover', tone: 'roast', unit: 's', value: (s) => s.lavaSec, threshold: 8, blurb: (v) => `${Math.round(v)} seconds in lava. A very heated relationship.` },
  { id: 'marathon', title: 'Marathon', tone: 'praise', unit: 'u', value: (s) => s.walked, threshold: 6000, blurb: (v) => `Walked ${tiles(v)} tiles. The floor wants overtime.` },
  { id: 'returnToSender', title: 'Return to Sender', tone: 'praise', unit: '', value: (s) => s.shieldReflects, threshold: 4, blurb: (v) => `Returned ${v} projectiles. No receipt needed.` },
  { id: 'demolition', title: 'Open Floor Plan', tone: 'praise', unit: '', value: (s) => s.pillarsDestroyed, threshold: 3, blurb: (v) => `${v} pillars demolished. Interior design, with explosives.` },
  { id: 'hazardPay', title: 'Outsourcing', tone: 'praise', unit: '', value: (s) => s.lastHitKills, threshold: 3, blurb: (v) => `${v} credited lava or pillar kills. Let the scenery finish the job.` },
  { id: 'raidBoss', title: 'Raid Boss', tone: 'praise', family: 'kills', unit: '', value: (s) => s.bestStreak, threshold: 4, blurb: (v) => `${v} kills in one life. Briefly a boss fight.` },
  { id: 'sprayAndPray', title: 'Warning Shots', tone: 'roast', unit: '', value: missedCasts, threshold: 15, blurb: (v) => `${v} damaging casts hit nobody. The floor looked terrified.` },
  { id: 'passenger', title: 'Designated Passenger', tone: 'roast', family: 'knockbackTravel', unit: '%', value: (s) => s.walked + s.pushed >= 4000 && s.pushed >= 3000 ? s.pushed / (s.walked + s.pushed) : null, threshold: 0.65, blurb: (v) => `${Math.round(v * 100)}% of ground travel came from knockback. Why walk?` },
  { id: 'personalGrudge', title: 'Personal Grudge', tone: 'roast', unit: '', value: (_s, p, rec) => favoriteVictim(rec, p)?.kills ?? null, threshold: 3, blurb: (v, p, rec) => {
    const rival = favoriteVictim(rec, p)!
    return `${v} of ${rival.total} kills were ${rival.victim.name}${rival.victim.kind === 'bot' ? ' (bot)' : ''}. Very selective customer service.`
  } },
  {
    id: 'untouchable',
    title: 'Untouchable',
    tone: 'praise',
    unit: '',
    value: (s) => (s.roundsSurvived >= 2 && s.aliveSec >= 20 && s.damageDealt >= 100 ? s.damageTaken : null),
    threshold: 200,
    lowerIsBetter: true,
    blurb: (v) => `Survived multiple rounds taking ${Math.round(v)} damage. Excellent drama avoidance.`,
  },
]

/**
 * 0..AWARDS_MAX fun titles for clear outliers of one match. A title goes to the single best
 * player for its stat, only if the value reaches the threshold and leads the runner-up by
 * AWARD_LEAD (so a 50/49 split awards nothing). Ranked by how far the winner stands out.
 * The five-card selection spreads coverage across players and tones, and avoids repeating
 * one player's same stat family. Records without detailed stats get none.
 */
export function matchAwards(rec: AwardRecord): Award[] {
  const scored: { award: Award; score: number; order: number; tone: AwardDef['tone']; family: string }[] = []
  AWARD_DEFS.forEach((def, order) => {
    const vals: { player: PlayerId; v: number }[] = []
    for (const p of rec.participants) {
      if (!p.stats) continue
      const v = def.value(p.stats, p, rec)
      if (v !== null && Number.isFinite(v)) vals.push({ player: p.player, v })
    }
    if (vals.length === 0) return
    const sorted = vals.sort((a, b) => (def.lowerIsBetter ? a.v - b.v : b.v - a.v) || a.player - b.player)
    const best = sorted[0]
    const next = sorted[1]
    let score: number
    if (def.lowerIsBetter) {
      // needs someone to compare with, and a clear gap
      if (!next || !(best.v < next.v && best.v * AWARD_LEAD <= next.v) || best.v > def.threshold) return
      score = next.v / Math.max(1, best.v)
    } else {
      if (!(best.v >= def.threshold)) return
      if (next && !(best.v >= next.v * AWARD_LEAD && best.v > next.v)) return
      score = (best.v / def.threshold) * (next && next.v > 0 ? best.v / next.v : 2)
    }
    const winner = rec.participants.find((p) => p.player === best.player)!
    scored.push({ award: { id: def.id, title: def.title, player: best.player, value: Math.round(best.v * 1000) / 1000, unit: def.unit, blurb: def.blurb(best.v, winner, rec) }, score, order, tone: def.tone, family: def.family ?? def.id })
  })
  const ranked = scored.sort((a, b) => b.score - a.score || a.order - b.order)
  const selected: typeof ranked = []
  while (ranked.length && selected.length < AWARDS_MAX) {
    const eligible = ranked.filter((candidate) => !selected.some((picked) => picked.award.player === candidate.award.player && picked.family === candidate.family))
    if (!eligible.length) break
    const unseen = (c: typeof eligible[number]) => !selected.some((s) => s.award.player === c.award.player)
    // Give the room a turn in the spotlight; include a compliment and a gentle
    // roast when both qualify, rather than five variations of the MVP's score.
    const missingTone = selected.length === 1 ? selected[0].tone === 'praise' ? 'roast' : 'praise' : null
    const pick = eligible.find((c) => c.tone === missingTone && unseen(c))
      ?? eligible.find((c) => c.tone === missingTone)
      ?? eligible.find(unseen)
      ?? eligible[0]
    selected.push(pick)
    ranked.splice(ranked.indexOf(pick), 1)
  }
  return selected.map((x) => x.award)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const KEY = 'brawlock.stats.v1'
/** stored shape version (v1: before detailed stats) */
export const STATS_VERSION = 2
export const HISTORY_MAX = 200
/** history entries that keep per-player detailed stats (older ones drop them to stay small) */
export const HISTORY_DETAIL_MAX = 30

interface StatsDb {
  v: 2
  history: MatchRecord[]
  career: Career | null
  encounters: Record<string, Encounter>
  ratings: Record<string, Omit<RatingRow, 'self'>>
}

function emptyDb(): StatsDb {
  return { v: 2, history: [], career: null, encounters: {}, ratings: {} }
}

const num = n
function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  const o = obj(v)
  if (o) for (const [k, x] of Object.entries(o)) if (num(x) > 0) out[k] = num(x)
  return out
}

const TOTAL_KEYS = [
  'walked', 'pushed', 'teleported', 'damageTaken', 'knockbacksDealt', 'knockbacksTaken', 'selfKills', 'lastHitKills',
  'firstBloods', 'casts', 'hits', 'scourgeHits', 'teleportSaves', 'shieldReflects', 'pillarsDestroyed', 'aliveSec',
  'lavaSec', 'lavaDamage', 'roundsSurvived', 'goldEarned', 'goldSpent',
] as const

function cleanTotals(v: unknown): CareerTotals {
  const o = obj(v) ?? {}
  const t = {} as Record<(typeof TOTAL_KEYS)[number], number>
  for (const k of TOTAL_KEYS) t[k] = num(o[k])
  return { ...t, killsByCause: counts(o.killsByCause), deathsByCause: counts(o.deathsByCause) }
}

const HOF_KEYS: readonly HallOfFameKey[] = [
  'mostKills', 'mostDamage', 'bestStreak', 'bestMulti', 'longestFlight', 'mostPushed', 'mostWalked', 'bestAccuracy',
  'mostScourgeHits', 'mostTeleportSaves', 'mostReflects', 'longestAlive',
]

function cleanHof(v: unknown): Career['hallOfFame'] {
  const out: Career['hallOfFame'] = {}
  const o = obj(v)
  if (!o) return out
  for (const k of HOF_KEYS) {
    const e = obj(o[k])
    if (e && typeof e.value === 'number' && Number.isFinite(e.value)) out[k] = { value: e.value, date: num(e.date), matchId: str(e.matchId) }
  }
  return out
}

function cleanCareer(v: unknown): Career | null {
  const o = obj(v)
  if (!o) return null
  const vs = (x: unknown) => {
    const q = obj(x)
    return { games: num(q?.games), wins: num(q?.wins) }
  }
  return {
    profileId: str(o.profileId),
    games: num(o.games),
    wins: num(o.wins),
    losses: num(o.losses),
    kills: num(o.kills),
    deaths: num(o.deaths),
    damage: num(o.damage),
    rounds: num(o.rounds),
    seconds: num(o.seconds),
    winStreak: num(o.winStreak),
    bestWinStreak: num(o.bestWinStreak),
    vsHumans: vs(o.vsHumans),
    vsBots: vs(o.vsBots),
    firstPlayed: num(o.firstPlayed),
    lastPlayed: num(o.lastPlayed),
    totals: cleanTotals(o.totals),
    hallOfFame: cleanHof(o.hallOfFame),
  }
}

/** Field-by-field clean of stored detailed stats; undefined if unusable. */
export function cleanStats(v: unknown): PlayerMatchStats | undefined {
  const o = obj(v)
  if (!o) return undefined
  const spells: Record<string, [number, number]> = {}
  const sp = obj(o.spells)
  if (sp) {
    for (const [k, x] of Object.entries(sp)) {
      if (Array.isArray(x)) spells[k] = [num(x[0]), num(x[1])]
    }
  }
  const top = Array.isArray(o.topSpell) && typeof o.topSpell[0] === 'string' ? ([o.topSpell[0], num(o.topSpell[1])] as [string, number]) : null
  return {
    walked: num(o.walked),
    pushed: num(o.pushed),
    longestFlight: num(o.longestFlight),
    teleported: num(o.teleported),
    damageDealt: num(o.damageDealt),
    damageTaken: num(o.damageTaken),
    knockbacksDealt: num(o.knockbacksDealt),
    knockbacksTaken: num(o.knockbacksTaken),
    killsByCause: counts(o.killsByCause),
    deathsByCause: counts(o.deathsByCause),
    selfKills: num(o.selfKills),
    lastHitKills: num(o.lastHitKills),
    firstBlood: o.firstBlood === true,
    bestStreak: num(o.bestStreak),
    bestMulti: num(o.bestMulti),
    spells,
    scourgeHits: num(o.scourgeHits),
    teleportSaves: num(o.teleportSaves),
    shieldReflects: num(o.shieldReflects),
    pillarsDestroyed: num(o.pillarsDestroyed),
    aliveSec: num(o.aliveSec),
    lavaSec: num(o.lavaSec),
    lavaDamage: num(o.lavaDamage),
    roundsSurvived: num(o.roundsSurvived),
    goldEarned: num(o.goldEarned),
    goldSpent: num(o.goldSpent),
    topSpell: top,
  }
}

const AWARD_IDS = new Set(AWARD_DEFS.map((d) => d.id))
function cleanAwards(v: unknown): Award[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Award[] = []
  for (const x of v) {
    const o = obj(x)
    if (!o || !AWARD_IDS.has(o.id as AwardId)) continue
    const unit = o.unit === 'u' || o.unit === 's' || o.unit === '%' ? o.unit : ''
    out.push({ id: o.id as AwardId, title: str(o.title), player: num(o.player), value: num(o.value), unit, blurb: str(o.blurb) })
  }
  return out
}

function cleanEncounter(id: string, v: unknown): Encounter | null {
  const o = obj(v)
  if (!o) return null
  return {
    profileId: id,
    lastName: str(o.lastName, '?'),
    lastColor: num(o.lastColor),
    kind: o.kind === 'bot' ? 'bot' : 'human',
    ...(typeof o.difficulty === 'string' ? { difficulty: o.difficulty as BotDifficulty } : {}),
    games: num(o.games),
    wins: num(o.wins),
    losses: num(o.losses),
    draws: num(o.draws),
    killsOn: num(o.killsOn),
    deathsTo: num(o.deathsTo),
    damageDealt: num(o.damageDealt),
    damageTaken: num(o.damageTaken),
    firstSeen: num(o.firstSeen),
    lastSeen: num(o.lastSeen),
  }
}

function cleanRating(id: string, v: unknown): Omit<RatingRow, 'self'> | null {
  const o = obj(v)
  if (!o) return null
  return {
    profileId: id,
    name: str(o.name, '?'),
    color: num(o.color),
    kind: o.kind === 'bot' ? 'bot' : 'human',
    rating: typeof o.rating === 'number' && Number.isFinite(o.rating) ? o.rating : ELO_START,
    games: num(o.games),
    wins: num(o.wins),
    losses: num(o.losses),
    lastSeen: num(o.lastSeen),
  }
}

function isRecord(v: unknown): v is MatchRecord {
  const o = obj(v)
  return !!o && typeof o.date === 'number' && Array.isArray(o.participants) && Array.isArray(o.winners)
}

function cleanMatchRating(value: unknown): MatchRecord['rating'] {
  const rating = obj(value)
  if (!rating || (rating.status !== 'rated' && rating.status !== 'unrated' && rating.status !== 'unavailable')) return undefined
  return { status: rating.status, ...(typeof rating.reason === 'string' ? { reason: rating.reason } : {}) }
}

/** A stored build is complete or absent; never invent upgrades for incomplete history. */
export function cleanBuild(value: unknown): InspectedKit | undefined {
  const build = obj(value)
  if (!build || !Array.isArray(build.slots) || build.slots.length !== SLOT_COUNT
    || !Array.isArray(build.levels) || build.levels.length !== SLOT_COUNT) return undefined
  const masteries = obj(build.masteries)
  const bounded = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
  if (!masteries || !bounded(masteries.duration, MASTERY_MAX_LEVEL)
    || !bounded(masteries.range, MASTERY_MAX_LEVEL) || !bounded(masteries.lifesteal, MASTERY_MAX_LEVEL)) return undefined
  for (let i = 0; i < SLOT_COUNT; i++) {
    const id: unknown = build.slots[i]
    const level: unknown = build.levels[i]
    if (id === null) {
      if (level !== 0) return undefined
      continue
    }
    if (typeof id !== 'string') return undefined
    const active = Object.hasOwn(SPELLS, id) ? SPELLS[id] : undefined
    const passive = Object.hasOwn(PASSIVE_ITEMS, id) ? PASSIVE_ITEMS[id] : undefined
    const def = i < ITEM_SLOT_START ? active?.kind === 'spell' && active.column - 1 === i ? active : undefined
      : active?.kind === 'item' ? active : passive
    if (!def || !bounded(level, i < ITEM_SLOT_START ? Math.min(def.maxLevel, SPELL_MAX_LEVEL) : def.maxLevel) || level === 0) return undefined
  }
  return {
    slots: [...build.slots], levels: [...build.levels],
    masteries: { duration: masteries.duration, range: masteries.range, lifesteal: masteries.lifesteal },
  }
}

/** Clean the v2 additions of a stored record (v1 records simply have none). */
function cleanRecord(r: MatchRecord): MatchRecord {
  const participants = r.participants.map((p) => {
    const stats = cleanStats((p as { stats?: unknown }).stats)
    const build = cleanBuild((p as { build?: unknown }).build)
    const { stats: _drop, build: _build, ...rest } = p as Participant
    void _drop
    void _build
    return { ...rest, ...(stats ? { stats } : {}), ...(build ? { build } : {}) }
  })
  const awards = cleanAwards(r.awards)
  const out: MatchRecord = { ...r, participants }
  if (!['ranked', 'casual', 'custom', 'offline'].includes(r.queue as string)) delete out.queue
  const rating = cleanMatchRating(r.rating)
  if (rating) out.rating = rating
  else delete out.rating
  if (awards) out.awards = awards
  else delete out.awards
  return out
}

function cleanMap<T>(v: unknown, clean: (id: string, x: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {}
  const o = obj(v)
  if (!o) return out
  for (const [k, x] of Object.entries(o)) {
    const c = clean(k, x)
    if (c) out[k] = c
  }
  return out
}

function loadDb(kv: KV | null): StatsDb {
  let raw: string | null = null
  try {
    raw = kv?.getItem(KEY) ?? null
  } catch {
    return emptyDb()
  }
  if (!raw) return emptyDb()
  try {
    const v = obj(JSON.parse(raw))
    // v1 -> v2: same layout, detailed stats / totals / hall of fame added (cleaned in as zeros)
    if (!v || (v.v !== 1 && v.v !== 2)) return emptyDb()
    return {
      v: 2,
      history: Array.isArray(v.history) ? v.history.filter(isRecord).slice(0, HISTORY_MAX).map(cleanRecord) : [],
      career: cleanCareer(v.career),
      encounters: cleanMap(v.encounters, cleanEncounter),
      ratings: cleanMap(v.ratings, cleanRating),
    }
  } catch {
    return emptyDb()
  }
}

/** Stored sparsely: zero / false / empty fields are dropped (cleanStats restores them). */
function compactStats(s: PlayerMatchStats): Partial<PlayerMatchStats> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (v === 0 || v === false || v === null) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue
    out[k] = v
  }
  return out as Partial<PlayerMatchStats>
}

/** Older history keeps its scoreboard but sheds the detailed per-player stats. */
function trimDetail(history: MatchRecord[]): MatchRecord[] {
  return history.map((r, i) => ({
    ...r,
    participants: r.participants.map(({ stats, ...p }) => (i < HISTORY_DETAIL_MAX && stats ? { ...p, stats: compactStats(stats) as PlayerMatchStats } : p)),
  }))
}

function saveDb(kv: KV | null, db: StatsDb): void {
  if (!kv) return
  const history = trimDetail(db.history)
  try {
    kv.setItem(KEY, JSON.stringify({ ...db, history }))
  } catch {
    // quota: keep aggregates, shed old history
    try {
      kv.setItem(KEY, JSON.stringify({ ...db, history: history.slice(0, 20) }))
    } catch {
      /* give up silently; stats are a nicety */
    }
  }
}

const listeners = new Set<() => void>()

/** Notified after every recorded match (or clear). Returns unsubscribe. */
export function onStatsChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Fresh counters for observed detailed matches; absence of coverage stays separate. */
export function emptyTotals(): CareerTotals {
  return cleanTotals({})
}

export function addTotals(t: CareerTotals, s: PlayerMatchStats): void {
  t.walked += s.walked
  t.pushed += s.pushed
  t.teleported += s.teleported
  t.damageTaken += s.damageTaken
  t.knockbacksDealt += s.knockbacksDealt
  t.knockbacksTaken += s.knockbacksTaken
  t.selfKills += s.selfKills
  t.lastHitKills += s.lastHitKills
  if (s.firstBlood) t.firstBloods++
  for (const [id, [c, h]] of Object.entries(s.spells)) {
    if (!DAMAGING.has(id)) continue
    t.casts += c
    t.hits += h
  }
  t.scourgeHits += s.scourgeHits
  t.teleportSaves += s.teleportSaves
  t.shieldReflects += s.shieldReflects
  t.pillarsDestroyed += s.pillarsDestroyed
  t.aliveSec += s.aliveSec
  t.lavaSec += s.lavaSec
  t.lavaDamage += s.lavaDamage
  t.roundsSurvived += s.roundsSurvived
  t.goldEarned += s.goldEarned
  t.goldSpent += s.goldSpent
  for (const [k, v] of Object.entries(s.killsByCause)) t.killsByCause[k] = (t.killsByCause[k] ?? 0) + v
  for (const [k, v] of Object.entries(s.deathsByCause)) t.deathsByCause[k] = (t.deathsByCause[k] ?? 0) + v
}

/** Personal-best candidates of one match (only values > 0 compete). */
export function hallOfFameValues(me: Pick<Participant, 'stats'>): Partial<Record<HallOfFameKey, number>> {
  const s = me.stats
  if (!s) return {}
  const acc = accuracy(s, SNIPER_MIN_CASTS)
  return {
    mostKills: totalKills(s),
    mostDamage: s.damageDealt,
    bestStreak: s.bestStreak,
    bestMulti: s.bestMulti,
    longestFlight: s.longestFlight,
    mostPushed: s.pushed,
    mostWalked: s.walked,
    ...(acc !== null ? { bestAccuracy: Math.round(acc * 1000) / 1000 } : {}),
    mostScourgeHits: s.scourgeHits,
    mostTeleportSaves: s.teleportSaves,
    mostReflects: s.shieldReflects,
    longestAlive: s.aliveSec,
  }
}

export interface RecordedProfileDetail {
  matches: number
  seconds: number
  damage: number
  totals: CareerTotals
  spells: Record<string, [number, number]>
  hallOfFame: Career['hallOfFame']
}

export interface RecordedProfileCoverage {
  detailedMatches: number
  totalMatches: number
  firstDetailedAt: number | null
  lastDetailedAt: number | null
}

/** Fold one covered match; callers own identity, eligibility and duplicate protection. */
export function addRecordedMatch(detail: RecordedProfileDetail, stats: PlayerMatchStats, seconds: number, date: number, matchId: string): void {
  detail.matches++
  detail.seconds += seconds
  detail.damage += stats.damageDealt
  addTotals(detail.totals, stats)
  for (const [id, [casts, hits]] of Object.entries(stats.spells)) {
    const previous = detail.spells[id] ?? [0, 0]
    detail.spells[id] = [previous[0] + casts, previous[1] + hits]
  }
  for (const [key, value] of Object.entries(hallOfFameValues({ stats })) as [HallOfFameKey, number][]) {
    const previous = detail.hallOfFame[key]
    if (value > 0 && (!previous || value > previous.value || (value === previous.value && date < previous.date))) detail.hallOfFame[key] = { value, date, matchId }
  }
}

/** Only this device's retained, identified match records; never inferred from names. */
export function recordedProfileStats(records: readonly MatchRecord[], profileId: string): { coverage: RecordedProfileCoverage; detail: RecordedProfileDetail | null } {
  const coverage: RecordedProfileCoverage = { detailedMatches: 0, totalMatches: 0, firstDetailedAt: null, lastDetailedAt: null }
  const detail: RecordedProfileDetail = { matches: 0, seconds: 0, damage: 0, totals: emptyTotals(), spells: {}, hallOfFame: {} }
  if (!profileId) return { coverage, detail: null }
  for (const record of [...records].sort((a, b) => a.date - b.date)) {
    const owners = record.participants.filter((p) => p.profileId === profileId && hasProfileIdentity(p))
    // A duplicated identity cannot be attributed to one participant safely.
    if (owners.length !== 1) continue
    coverage.totalMatches++
    const owner = owners[0]
    if (!owner.stats) continue
    coverage.detailedMatches++
    coverage.firstDetailedAt ??= record.date
    coverage.lastDetailedAt = record.date
    addRecordedMatch(detail, owner.stats, record.durationSec, record.date, record.id)
  }
  return { coverage, detail: detail.matches ? detail : null }
}

/** Fold one finished match into history, ratings, career and encounters. */
export function recordMatch(rec: MatchRecord, selfProfileId: string, kv: KV | null = safeLocalStorage()): void {
  const db = loadDb(kv)
  db.history.unshift(rec)
  if (db.history.length > HISTORY_MAX) db.history.length = HISTORY_MAX

  // ratings: every participant, as seen from this browser
  const ps = rec.participants
  const rated = ps.filter(hasProfileIdentity)
  const before = rated.map((p) => db.ratings[p.profileId]?.rating ?? ELO_START)
  const after = eloUpdate(before, (i, j) => pairOutcome(rec, rated[i], rated[j]))
  rated.forEach((p, i) => {
    const r = db.ratings[p.profileId]
    db.ratings[p.profileId] = {
      profileId: p.profileId,
      name: p.name,
      color: p.color,
      kind: p.kind,
      rating: after[i],
      games: (r?.games ?? 0) + 1,
      wins: (r?.wins ?? 0) + (p.won ? 1 : 0),
      losses: (r?.losses ?? 0) + (p.won ? 0 : 1),
      lastSeen: rec.date,
    }
  })

  const me = ps.find((p) => p.player === rec.self)
  if (me) {
    const c: Career = db.career ?? cleanCareer({})!
    c.profileId = selfProfileId
    c.games++
    if (me.won) c.wins++
    else c.losses++
    c.kills += me.kills
    c.deaths += me.deaths
    c.damage += me.damage
    c.rounds += rec.rounds
    c.seconds += rec.durationSec
    c.winStreak = me.won ? c.winStreak + 1 : 0
    c.bestWinStreak = Math.max(c.bestWinStreak, c.winStreak)
    const vs = ps.some((p) => p !== me && p.kind === 'human') ? c.vsHumans : c.vsBots
    vs.games++
    if (me.won) vs.wins++
    if (!c.firstPlayed) c.firstPlayed = rec.date
    c.lastPlayed = rec.date
    if (me.stats) {
      addTotals(c.totals, me.stats)
      for (const [k, v] of Object.entries(hallOfFameValues(me)) as [HallOfFameKey, number][]) {
        if (v > 0 && v > (c.hallOfFame[k]?.value ?? 0)) c.hallOfFame[k] = { value: v, date: rec.date, matchId: rec.id }
      }
    }
    db.career = c

    const pair = (list: [PlayerId, PlayerId, number][], a: PlayerId, b: PlayerId) =>
      list.find(([x, y]) => x === a && y === b)?.[2] ?? 0
    for (const o of ps) {
      if (o === me || o.profileId === selfProfileId || !hasProfileIdentity(o)) continue
      const e: Encounter = db.encounters[o.profileId] ?? cleanEncounter(o.profileId, { firstSeen: rec.date })!
      e.games++
      if (me.won && !o.won) e.wins++
      else if (o.won && !me.won) e.losses++
      else e.draws++
      e.killsOn += pair(rec.kills, me.player, o.player)
      e.deathsTo += pair(rec.kills, o.player, me.player)
      e.damageDealt += pair(rec.damage, me.player, o.player)
      e.damageTaken += pair(rec.damage, o.player, me.player)
      e.lastName = o.name
      e.lastColor = o.color
      e.kind = o.kind
      if (o.difficulty) e.difficulty = o.difficulty
      e.lastSeen = rec.date
      db.encounters[o.profileId] = e
    }
  }

  saveDb(kv, db)
  for (const cb of listeners) cb()
}

/** Refresh current display labels by stable ID; recorded match labels stay historical. */
export function updateProfileNames(profiles: readonly { profileId: string; name: string }[], kv: KV | null = safeLocalStorage()): void {
  if (!profiles.length) return
  const db = loadDb(kv)
  let changed = false
  for (const p of profiles) {
    if (!p.profileId || p.profileId.startsWith('anon:')) continue
    const rating = db.ratings[p.profileId]
    if (rating && rating.name !== p.name) {
      rating.name = p.name
      changed = true
    }
    const encounter = db.encounters[p.profileId]
    if (encounter && encounter.lastName !== p.name) {
      encounter.lastName = p.name
      changed = true
    }
  }
  if (!changed) return
  saveDb(kv, db)
  for (const cb of listeners) cb()
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/** Career totals of the local profile, null before the first finished match. */
export function getCareer(kv: KV | null = safeLocalStorage()): Career | null {
  return loadDb(kv).career
}

/** Personal bests of the local profile (empty before the first match with detailed stats). */
export function getHallOfFame(kv: KV | null = safeLocalStorage()): Career['hallOfFame'] {
  return loadDb(kv).career?.hallOfFame ?? {}
}

/** Head-to-head records, most recently met first. */
export function getEncounters(kv: KV | null = safeLocalStorage()): Encounter[] {
  return Object.values(loadDb(kv).encounters).sort((a, b) => b.lastSeen - a.lastSeen)
}

/** Recorded matches, newest first. */
export function getMatchHistory(limit = 20, kv: KV | null = safeLocalStorage()): MatchRecord[] {
  return loadDb(kv).history.slice(0, Math.max(0, limit))
}

/** Every profile this browser has seen, by local rating. `selfProfileId` marks the local row. */
/**
 * Players rated on this device, best first. Bots are left out: every bot of a difficulty shares
 * one identity (`bot:brutal`), so a row would merge many opponents, and a ladder is for people.
 */
export function getLocalLeaderboard(selfProfileId?: string, kv: KV | null = safeLocalStorage()): RatingRow[] {
  return Object.values(loadDb(kv).ratings)
    .filter((r) => r.kind !== 'bot')
    .map((r) => ({ ...r, self: r.profileId === selfProfileId }))
    .sort((a, b) => b.rating - a.rating)
}

export function clearStats(kv: KV | null = safeLocalStorage()): void {
  try {
    kv?.setItem(KEY, JSON.stringify(emptyDb()))
  } catch {
    /* ignore */
  }
  for (const cb of listeners) cb()
}
