/**
 * Local match statistics. No server yet, so every peer records the matches it
 * saw into localStorage: match history (bounded), career totals for the local
 * profile, head-to-head encounters per opponent profile, and a local Elo rating
 * per profile (bots rate as 'bot:<difficulty>').
 *
 * Flow: the session creates a MatchTracker at match start, feeds it every played
 * tick's state + events (deaths with killer, damage between players; counters
 * only, so memory stays bounded), and at game over turns it into a MatchRecord
 * that recordMatch() folds into the stored aggregates.
 *
 * Aggregates are updated incrementally, so career and encounters outlive the
 * history cap. Corrupt or foreign data never throws: it is ignored field by field.
 */
import type { BotDifficulty, GameMode, MatchSettings, PlayerId, PlayerSlot, SimEvent, SimState, TeamMode } from '../sim/types'
import { TICK_HZ } from '../sim/types'
import { randomId, safeLocalStorage, type KV } from './profile'
import type { MatchResult } from './store'

// ---------------------------------------------------------------------------
// Types (read API for the UI)
// ---------------------------------------------------------------------------

export interface Participant {
  player: PlayerId
  /** profile id, 'bot:<difficulty>' for bots, 'anon:<name>' for peers without one */
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
}

export type Outcome = 'win' | 'loss' | 'spectator'

export interface MatchRecord {
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
  localPlayer: PlayerId
  slots: PlayerSlot[]
  settings: MatchSettings
}

export function profileIdOf(slot: PlayerSlot): string {
  if (slot.kind === 'bot') return `bot:${slot.difficulty ?? 'medium'}`
  return slot.profileId ?? `anon:${slot.name}`
}

export class MatchTracker {
  private firstTick = -1
  private lastTick = -1
  /** `${killer}>${victim}` → count */
  private killPairs = new Map<string, number>()
  /** `${from}>${to}` → damage */
  private dmgPairs = new Map<string, number>()
  private readonly info: TrackerInfo

  constructor(info: TrackerInfo) {
    this.info = info
  }

  /** Feed one played tick (or several ticks' events with the newest state). */
  observe(state: SimState, events: readonly SimEvent[]): void {
    if (this.firstTick < 0) this.firstTick = state.tick
    if (state.tick > this.lastTick) this.lastTick = state.tick
    for (const e of events) {
      if (e.type === 'death') {
        if (e.killer !== null && e.killer !== e.owner) bump(this.killPairs, `${e.killer}>${e.owner}`, 1)
      } else if (e.type === 'damage') {
        if (e.source === null || !(e.amount > 0)) continue
        const target = state.pawns.find((p) => p.id === e.target)
        if (target && target.owner !== e.source) bump(this.dmgPairs, `${e.source}>${target.owner}`, e.amount)
      }
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
      }
    })
    const self = participants.some((p) => p.player === this.info.localPlayer) ? this.info.localPlayer : -1
    const ticks = result.ticks ?? Math.max(0, this.lastTick - this.firstTick)
    const split = (m: Map<string, number>): [PlayerId, PlayerId, number][] =>
      [...m].map(([k, v]) => {
        const [a, b] = k.split('>').map(Number)
        return [a, b, Math.round(v)]
      })
    return {
      id: randomId(),
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
    }
  }
}

function bump(m: Map<string, number>, k: string, v: number): void {
  m.set(k, (m.get(k) ?? 0) + v)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const KEY = 'brawlock.stats.v1'
export const HISTORY_MAX = 200

interface StatsDb {
  v: 1
  history: MatchRecord[]
  career: Career | null
  encounters: Record<string, Encounter>
  ratings: Record<string, Omit<RatingRow, 'self'>>
}

function emptyDb(): StatsDb {
  return { v: 1, history: [], career: null, encounters: {}, ratings: {} }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
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
  }
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
    if (!v || v.v !== 1) return emptyDb()
    return {
      v: 1,
      history: Array.isArray(v.history) ? v.history.filter(isRecord).slice(0, HISTORY_MAX) : [],
      career: cleanCareer(v.career),
      encounters: cleanMap(v.encounters, cleanEncounter),
      ratings: cleanMap(v.ratings, cleanRating),
    }
  } catch {
    return emptyDb()
  }
}

function saveDb(kv: KV | null, db: StatsDb): void {
  if (!kv) return
  try {
    kv.setItem(KEY, JSON.stringify(db))
  } catch {
    // quota: keep aggregates, shed old history
    try {
      kv.setItem(KEY, JSON.stringify({ ...db, history: db.history.slice(0, 20) }))
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

/** Fold one finished match into history, ratings, career and encounters. */
export function recordMatch(rec: MatchRecord, selfProfileId: string, kv: KV | null = safeLocalStorage()): void {
  const db = loadDb(kv)
  db.history.unshift(rec)
  if (db.history.length > HISTORY_MAX) db.history.length = HISTORY_MAX

  // ratings: every participant, as seen from this browser
  const ps = rec.participants
  const before = ps.map((p) => db.ratings[p.profileId]?.rating ?? ELO_START)
  const after = eloUpdate(before, (i, j) => pairOutcome(rec, ps[i], ps[j]))
  ps.forEach((p, i) => {
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
    db.career = c

    const pair = (list: [PlayerId, PlayerId, number][], a: PlayerId, b: PlayerId) =>
      list.find(([x, y]) => x === a && y === b)?.[2] ?? 0
    for (const o of ps) {
      if (o === me || o.profileId === selfProfileId) continue
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

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/** Career totals of the local profile, null before the first finished match. */
export function getCareer(kv: KV | null = safeLocalStorage()): Career | null {
  return loadDb(kv).career
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
export function getLocalLeaderboard(selfProfileId?: string, kv: KV | null = safeLocalStorage()): RatingRow[] {
  return Object.values(loadDb(kv).ratings)
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
