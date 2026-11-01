/**
 * One daily Gauntlet run (docs/moonshot/specs/daily.md): the human (seat 0, team 0) against the
 * day's five waves (team 1) on a small arena, two lives, a shop between waves. Only the current
 * wave's bots are seated; every bot thinks every tick, seated or not, so its dice never depend on
 * seating. A lost or drawn round costs a life and the same wave fights again. Pure and
 * deterministic in (day, salt, the human's commands): the server re-runs it to verify a score.
 *
 * Score: waves cleared, then fight time from the first fight's start to the round win that cleared
 * the last cleared wave (lost fights included, shops and round ends not), minus 3 s for each
 * knockout the day's bounty spell sealed by then (at most five).
 */
import { BotController } from '../../bots/controller'
import { drawBuild } from '../../bots/plan'
import { Rng } from '../../bots/prng'
import { DEFAULT_SETTINGS, createMatch, setPlayerConnected, step } from '../../sim'
import { hashString } from '../../sim/snapshot'
import { TICK_HZ, type PlayerInput, type InputCommand, type MatchSettings, type PlayerSlot, type SimState, type TickRate } from '../../sim/types'
import { ticks } from '../../sim/config'
import { MomentsEngine } from '../moments'
import type { CosmeticEquipment } from '../progressionCatalog'
import type { DailyDay } from './calendar'

/** the daily always runs at this rate, whatever the last room ran (the score is in its ticks) */
export const DAILY_HZ: TickRate = 30
export const DAILY_LIVES = 2
/** seconds off per bounty knockout, and how many count */
export const BOUNTY_SECONDS = 3
export const BOUNTY_MAX = 5
/** extra gold for the champion when it is seated */
export const CHAMPION_GOLD = 80
/** a run is at most this much sim time (s) */
export const DAILY_MAX_SECONDS = 600
export const DAILY_SHOP_SECONDS = 15
/** the fight arena: min(cap, base + warlocks), a ring every few seconds (the ranked final's numbers) */
const ARENA_BASE = 9
const ARENA_CAP = 15
const RING_SECONDS = 6

export type DailyEnd = 'cleared' | 'lost' | 'abandoned' | 'timeout'

export interface DailyResult {
  waves: number
  /** scored time in ticks (bounty already taken off) */
  timeTicks: number
  bountyKos: number
  /** all fight ticks played (an idle run earns no reward) */
  fightTicks: number
  endTick: number
  ended: DailyEnd | null
}

/** The run's match settings for a day. */
export function dailySettings(day: DailyDay): MatchSettings {
  return {
    ...DEFAULT_SETTINGS,
    teamMode: 'teams',
    gameMode: 'rounds',
    winScore: day.waves.length,
    shopSeconds: DAILY_SHOP_SECONDS,
    botsReplaceLeavers: false,
    spectatorBets: false,
    bounties: false,
    arenaBase: ARENA_BASE,
    arenaCap: ARENA_CAP,
    shrinkSeconds: RING_SECONDS,
    ...day.omen.settings,
  }
}

export interface DailyPlayer {
  name: string
  color: number
  cosmetics?: CosmeticEquipment
}

export class DailyRun {
  readonly state: SimState
  /** the wave fighting or next (0..4); 5 once cleared */
  wave = 0
  lives = DAILY_LIVES
  ended: DailyEnd | null = null
  private readonly bots: BotController[]
  private readonly moments = new MomentsEngine()
  private fightTicks = 0
  private scoredTicks = 0
  private bounty = 0
  private bountyAtClear = 0
  private seated = new Set<number>()

  constructor(
    readonly day: DailyDay,
    readonly salt: number,
    player: DailyPlayer,
  ) {
    if (TICK_HZ !== DAILY_HZ) throw new Error(`The daily runs at ${DAILY_HZ} Hz (setTickRate first)`)
    const slots: PlayerSlot[] = [{ id: 0, name: player.name, color: player.color, team: 0, kind: 'human', ...(player.cosmetics ? { cosmetics: player.cosmetics } : {}) }]
    for (const wave of day.waves) {
      for (const b of wave) slots.push({ id: b.seat, name: b.name, color: b.champion ? 0xd23cff : 0x2e7bff, team: 1, kind: 'bot', difficulty: b.tier, ...(b.cosmetics ? { cosmetics: b.cosmetics } : {}) })
    }
    this.state = createMatch(dailySettings(day), slots, day.seed)
    const dice = (day.seed ^ salt) >>> 0
    this.bots = day.waves.flat().map((b) => {
      const bot = new BotController(b.seat, b.tier, dice)
      // the day's build for this seat, the same for everyone
      bot.build = drawBuild(new Rng(hashString(`build:${day.seed}:${b.seat}`)), b.build)
      return bot
    })
    this.seat(0)
  }

  /** One tick with the human's commands. */
  tick(cmds: readonly InputCommand[]): void {
    if (this.ended) return
    const s = this.state
    const mine = cmds.filter((c) => c.kind !== 'spectateBet')
    const inputs: PlayerInput[] = [{ player: 0, tick: s.tick, cmds: mine }]
    for (const b of this.bots) inputs.push({ player: b.player, tick: s.tick, cmds: b.think(s) })
    step(s, inputs)
    this.observe(s.events)
  }

  /** The bookkeeping of one stepped tick (public so crafted events can drive it in tests). */
  observe(events: readonly SimState['events'][number][]): void {
    const s = this.state
    if (s.phase === 'fight') this.fightTicks++
    this.moments.update(events, s)
    for (const e of events) {
      if (e.type === 'death') this.countBounty(e)
      if (e.type !== 'roundWin') continue
      if (e.team === 0 && e.players.includes(0)) {
        this.wave++
        this.scoredTicks = this.fightTicks
        this.bountyAtClear = this.bounty
        if (this.wave >= this.day.waves.length) this.ended = 'cleared'
        else this.seat(this.wave)
      } else {
        this.lives--
        if (this.lives <= 0) this.ended = 'lost'
      }
    }
    if (!this.ended && s.tick >= ticks(DAILY_MAX_SECONDS)) this.ended = 'timeout'
  }

  /** Give up: the run scores what it achieved (time stops at the last cleared wave anyway). */
  abandon(): void {
    if (!this.ended) this.ended = 'abandoned'
  }

  result(): DailyResult {
    const off = Math.min(BOUNTY_MAX, this.bountyAtClear) * ticks(BOUNTY_SECONDS)
    return { waves: this.wave, timeTicks: Math.max(0, this.scoredTicks - off), bountyKos: this.bounty, fightTicks: this.fightTicks, endTick: this.state.tick, ended: this.ended }
  }

  /** fight ticks so far (the HUD's clock) */
  get clockTicks(): number {
    return this.fightTicks
  }

  get bountyKos(): number {
    return this.bounty
  }

  /** a team-1 warlock went down: its sealing hit by the human with the bounty spell counts */
  private countBounty(e: Extract<SimState['events'][number], { type: 'death' }>): void {
    if (e.owner === 0 || e.cause === 'disconnect') return
    const ko = this.moments.all().find((m) => m.kind === 'knockout' && m.end === this.state.tick && m.victims.includes(e.owner))
    if (ko && ko.actors[0] === 0 && ko.cause === this.day.bounty) this.bounty++
  }

  /** Seat the wave's bots; everyone else sits out. */
  private seat(wave: number): void {
    const on = new Set(this.day.waves[wave].map((b) => b.seat))
    for (const b of this.day.waves.flat()) {
      setPlayerConnected(this.state, b.seat, on.has(b.seat))
      if (!on.has(b.seat)) {
        const pawn = this.state.pawns.find((p) => p.owner === b.seat)
        if (pawn) pawn.alive = false
      } else if (b.champion && !this.seated.has(b.seat)) {
        const sc = this.state.scores.find((x) => x.id === b.seat)
        if (sc) sc.gold += CHAMPION_GOLD
      }
      if (on.has(b.seat)) this.seated.add(b.seat)
    }
  }
}
