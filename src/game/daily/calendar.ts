/**
 * The daily Gauntlet's calendar (docs/moonshot/specs/daily.md): what each UTC day is. Everyone
 * plays the same day: its champion (by weekday), its omen (one rule for the run, each omen once
 * per nine-day cycle), its bounty spell (never the same two days running), its five waves and
 * every bot's build. Pure: the caller passes the time; tables only grow, and a change to a day
 * that has started carries a `from` day (the golden test pins them).
 */
import { hashString } from '../../sim/snapshot'
import type { BotDifficulty, MatchSettings, SpellId } from '../../sim/types'
import { BUILD_IDS, type BuildId } from '../../bots/plan'
import { Rng } from '../../bots/prng'
import type { CosmeticEquipment } from '../progressionCatalog'

export const DAY_MS = 86_400_000
/** Daily #1: Monday 2026-11-02 (UTC day number) */
export const LAUNCH_DAY = 20759

/** The UTC day a moment (ms since the epoch) falls on. */
export function dayOf(ms: number): number {
  return Math.floor(ms / DAY_MS)
}

export function dailyNumber(day: number): number {
  return day - LAUNCH_DAY + 1
}

export interface Champion {
  name: string
  /** the short name in day names ("Blood Moon over Rook") */
  short: string
  tier: BotDifficulty
  /** a signature build, or drawn from the day */
  build: BuildId | null
  cosmetics: CosmeticEquipment
  line: string
}

const dress = (p: Partial<CosmeticEquipment>): CosmeticEquipment => ({ victory: null, head: null, back: null, robe: null, emblem: null, staff: null, ...p })

/** One champion per UTC weekday, Sunday first. */
export const CHAMPIONS: readonly Champion[] = [
  { name: 'The Pyre Abbess', short: 'the Abbess', tier: 'brutal', build: null, cosmetics: dress({ head: 'head-candles', back: 'back-wings', robe: 'robe-emberveil', emblem: 'emblem-crown' }), line: 'Nobody has seen her build twice.' },
  { name: 'Cinder the Patient', short: 'Cinder', tier: 'hard', build: 'duelist', cosmetics: dress({ head: 'head-ram', emblem: 'emblem-flame' }), line: 'Walls with Shield and waits for you to get greedy.' },
  { name: 'Rook, the Blink Thief', short: 'Rook', tier: 'hard', build: 'blink', cosmetics: dress({ head: 'head-crow', back: 'back-wings', staff: 'staff-bone' }), line: 'Teleports in for the Scourge and out again.' },
  { name: 'Mother Ash', short: 'Mother Ash', tier: 'hard', build: 'artillery', cosmetics: dress({ head: 'head-candles', robe: 'robe-emberveil', staff: 'staff-gnarled' }), line: 'Meteors from afar; at her best in the last two rings.' },
  { name: 'Brother Thrum', short: 'Thrum', tier: 'hard', build: 'brawler', cosmetics: dress({ head: 'head-demon', back: 'back-spikes', staff: 'staff-iron' }), line: 'Thrust first. Questions never.' },
  { name: 'Vesper', short: 'Vesper', tier: 'hard', build: 'leech', cosmetics: dress({ head: 'head-crescent', back: 'back-crescent', emblem: 'emblem-moon' }), line: 'Swaps you into the lava and drinks the rest.' },
  { name: 'Old Hob', short: 'Old Hob', tier: 'hard', build: 'hunter', cosmetics: dress({ head: 'head-antlers', emblem: 'emblem-eye', staff: 'staff-gnarled' }), line: 'Roots you with Grip, then sends the Homing bolt.' },
]

export interface Omen {
  id: string
  name: string
  /** the day's name from the champion's short name */
  dayName: (champion: string) => string
  flavour: string
  /** match options it changes */
  settings: Partial<MatchSettings>
}

/** The nine omens. Names match Wild's deck (wild.md). */
export const OMENS: readonly Omen[] = [
  { id: 'clear', name: 'Clear Skies', dayName: (c) => `${cap(c)} under Clear Skies`, flavour: 'No omen today. Just you, the lava and the waves.', settings: {} },
  { id: 'bloodMoon', name: 'Blood Moon', dayName: (c) => `Blood Moon over ${c}`, flavour: 'The moon is red and every push lands harder, yours and theirs.', settings: { kbMultiplier: 1.5 } },
  { id: 'slickStone', name: 'Slick Stone', dayName: (c) => `${cap(c)} on Slick Stone`, flavour: 'The tiles sweat. Every slide runs long.', settings: { friction: 0.975 } },
  { id: 'hungryLava', name: 'Hungry Lava', dayName: (c) => `${cap(c)} and the Hungry Lava`, flavour: 'The lava bites half again as hard. Don’t linger.', settings: { lavaDps: 150 } },
  { id: 'coldLava', name: 'Cold Lava', dayName: (c) => `${cap(c)} by Cold Lava`, flavour: 'The lava has cooled. A second chance at the edge, for them too.', settings: { lavaDps: 60 } },
  { id: 'glassBones', name: 'Glass Bones', dayName: (c) => `${cap(c)} and the Glass Bones`, flavour: 'Every hit cuts deeper, and deeper cuts fly further.', settings: { dmgMultiplier: 1.5 } },
  { id: 'leanYear', name: 'Lean Year', dayName: (c) => `A Lean Year for ${c}`, flavour: 'Fifteen gold to start, six a round. Spend like it matters.', settings: { startGold: 15, roundGold: 6 } },
  { id: 'feast', name: 'Feast', dayName: (c) => `${cap(c)}’s Feast`, flavour: 'Eighty gold before the first wave. Build something ridiculous.', settings: { startGold: 80 } },
  { id: 'suddenCollapse', name: 'Sudden Collapse', dayName: (c) => `Sudden Collapse with ${c}`, flavour: 'The floor gives way every four seconds.', settings: { shrinkSeconds: 4 } },
]

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Spells a day's bounty is drawn from. */
export const BOUNTY_SPELLS: readonly SpellId[] = ['lightning', 'homing', 'boomerang', 'twin', 'bouncer', 'cluster', 'splitter', 'snowball', 'meteor', 'thrust']

/** Names for the wave bots. */
export const BOT_NAMES: readonly string[] = ['Ashling', 'Cinderkin', 'Soot', 'Wick', 'Clinker', 'Slag', 'Brand', 'Tallow']

/**
 * Day rules. Tables only grow and a change takes effect from a day (a day is the same for every
 * build that plays it). 2 (playtest 2026-11-02: two Mediums to the Hard champion with its gold was
 * a cliff, and a Snowball push into the lava never paid the bounty): a plain Hard wave before the
 * champion, half the champion's gold, a third life for the longer run, and a bounty for any
 * warlock your bounty spell touched in the 4 s before it went down. (Waves sitting out bank their
 * round gold, so the last ones come with bigger builds.)
 */
export type DailyRules = 1 | 2
export const RULES_V2_FROM = LAUNCH_DAY + 2
export const rulesOf = (day: number): DailyRules => (day >= RULES_V2_FROM ? 2 : 1)

/** The waves' tiers before the champion, per rules. */
const WAVE_TIERS: Record<DailyRules, readonly BotDifficulty[][]> = {
  1: [['easy'], ['easy', 'easy'], ['medium', 'easy'], ['medium', 'medium']],
  2: [['easy'], ['easy', 'easy'], ['medium', 'easy'], ['medium', 'medium'], ['hard']],
}
/** gold the champion brings to its fight (a bigger build), per rules */
const CHAMPION_GOLD: Record<DailyRules, number> = { 1: 80, 2: 40 }
const LIVES: Record<DailyRules, number> = { 1: 2, 2: 3 }

export interface DailyBot {
  /** seat id in the run's match */
  seat: number
  name: string
  tier: BotDifficulty
  build: BuildId
  champion: boolean
  cosmetics?: CosmeticEquipment
}

export interface DailyDay {
  day: number
  number: number
  seed: number
  weekday: number
  champion: Champion
  omen: Omen
  bounty: SpellId
  /** the waves' bots in order, the champion alone in the last */
  waves: DailyBot[][]
  rules: DailyRules
  /** gold the champion brings to its fight */
  championGold: number
  /** lost fights the run survives */
  lives: number
  /** "Blood Moon over Rook" */
  name: string
}

/** Each omen once per nine-day cycle; a cycle never opens with the omen that closed the one before. */
function omenOf(day: number): Omen {
  const n = OMENS.length
  const deck = (cycle: number): number[] => {
    const order = OMENS.map((_, i) => i)
    const rng = new Rng(hashString(`omen-cycle:${cycle}`))
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    return order
  }
  const cycle = Math.floor(day / n)
  const order = deck(cycle)
  const before = deck(cycle - 1)
  if (order[0] === before[n - 1]) [order[0], order[1]] = [order[1], order[0]]
  return OMENS[order[day - cycle * n]]
}

/** The day's bounty spell: drawn from its seed, redrawn while it equals yesterday's (from the launch day on). */
function bountyOf(day: number): SpellId {
  const draw = (d: number, prev: SpellId | null): SpellId => {
    const rng = new Rng(hashString(`bounty:${d}`))
    for (;;) {
      const s = BOUNTY_SPELLS[Math.floor(rng.next() * BOUNTY_SPELLS.length)]
      if (s !== prev) return s
    }
  }
  let prev: SpellId | null = null
  for (let d = Math.min(day, LAUNCH_DAY); d <= day; d++) prev = draw(d, prev)
  return prev!
}

/** Everything that makes `day` the day it is. */
export function defineDay(day: number): DailyDay {
  const seed = hashString(`brawlock-daily:v1:${day}`)
  const weekday = (((day + 4) % 7) + 7) % 7
  const champion = CHAMPIONS[weekday]
  const omen = omenOf(day)
  const rng = new Rng(seed)
  const names = [...BOT_NAMES]
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1))
    ;[names[i], names[j]] = [names[j], names[i]]
  }
  let seat = 1
  const buildFor = (s: number) => BUILD_IDS[hashString(`${seed}:${s}`) % BUILD_IDS.length]
  const rules = rulesOf(day)
  const waves: DailyBot[][] = WAVE_TIERS[rules].map((tiers) => tiers.map((tier) => {
    const s = seat++
    return { seat: s, name: names[(s - 1) % names.length], tier, build: buildFor(s), champion: false }
  }))
  const c = seat++
  waves.push([{ seat: c, name: champion.name, tier: champion.tier, build: champion.build ?? buildFor(c), champion: true, cosmetics: champion.cosmetics }])
  return { day, number: dailyNumber(day), seed, weekday, champion, omen, bounty: bountyOf(day), waves, rules, championGold: CHAMPION_GOLD[rules], lives: LIVES[rules], name: omen.dayName(champion.short) }
}
