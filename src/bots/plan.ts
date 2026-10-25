/**
 * Shop builds shared by every active bot tier. Each bot draws one build when it is created,
 * from its own seeded stream, so a lobby of bots shows the range of builds players use
 * instead of one build eight times.
 *
 * A build is a priority list bought in order as gold allows, several buys per shop phase like
 * a player would (the original AI bought one random spell per 40 s and never upgraded). It
 * saves up for the next step instead of spending on something lower.
 *
 * Every build keeps the same spine: an escape spell first (the save), a damage spell, then
 * Fireball and Scourge upgrades (more damage is more knockback). They differ in what they
 * build around:
 * - blink: Teleport and Lightning (the Fireball detonation combo); Link or Gravity pulls a
 *   target into a Scourge.
 * - hunter: Teleport, Homing and Grip: root the target, then Scourge or Fireball it.
 * - duelist: Teleport, Twin or Lightning, Bouncer or Drain, Boots to step out of bolts, later a
 *   Shield to send bolts back.
 * - artillery: Teleport, Meteor, Homing or Boomerang, Cluster or Bouncer from range, Boots to keep
 *   its distance, Ring of Health.
 * - brawler: Thrust and Boomerang up close, Gravity or Grip holds a target for the Scourge,
 *   Armor against knockback.
 * - leech: Swap, Drain and Snowball or Splitter, Cape and Ring of Health to outlast.
 * A step whose `id` is a list is a choice between spells of one role, drawn with the build;
 * a later step with the same list upgrades that same choice.
 *
 * Masteries (5 gold a level) follow the plan: range for builds that fight from a distance,
 * duration for roots and pulls, lifesteal for builds that trade hits up close. Before
 * 2026-10-25 no bot ever bought one.
 *
 * King of the Hill draws with HILL_WEIGHTS: area and multi-target builds (Meteor and Cluster,
 * Gravity into Scourge) come up more often; every build stays possible.
 */
import { ITEM_SLOT_START, MASTERY_COST, MASTERY_MAX_LEVEL, PASSIVE_ITEMS, RELEASED_SPELLS, SPELLS } from '../sim'
import type { MasteryKind } from '../sim/stats'
import type { InputCommand, PawnState, PlayerScore, SpellId } from '../sim/types'
import type { Rng } from './prng'

export interface Step {
  kind: 'spell' | 'item' | 'mastery'
  /** a spell or item id, or a MasteryKind for a mastery step */
  id: SpellId
  /** buy / upgrade until this level */
  level: number
}

export interface Build {
  id: BuildId
  steps: readonly Step[]
}

type Choice = SpellId | readonly SpellId[]
interface BuildDef {
  /** relative draw weight */
  weight: number
  steps: readonly { kind: Step['kind']; id: Choice; level: number }[]
}

const spell = (id: Choice, level: number) => ({ kind: 'spell' as const, id, level })
const item = (id: Choice, level: number) => ({ kind: 'item' as const, id, level })
const mastery = (id: MasteryKind, level: number) => ({ kind: 'mastery' as const, id, level })

const PULL: readonly SpellId[] = ['link', 'gravity']
const HOLD: readonly SpellId[] = ['grip', 'link']
const DUEL_BOLT: readonly SpellId[] = ['twin', 'lightning']
const DUEL_T: readonly SpellId[] = ['bouncer', 'drain']
const ARTY_BOLT: readonly SpellId[] = ['homing', 'boomerang']
const BARRAGE: readonly SpellId[] = ['cluster', 'bouncer']
const CLOSE_HOLD: readonly SpellId[] = ['gravity', 'grip']
const LEECH_E: readonly SpellId[] = ['snowball', 'splitter']

// Every build takes Boots early and levels them (cheap at 5 gold a level): slow bots were
// easy to catch and too slow to reach a fight or walk out of a push.
export const BUILDS = {
  // the former single Uber build
  blink: {
    weight: 1,
    steps: [
      spell('teleport', 1),
      spell('lightning', 1),
      item('boots', 1),
      item('fireball', 3),
      item('scourge', 2),
      item('boots', 2),
      spell('teleport', 2),
      item('fireball', 5),
      spell(PULL, 1),
      item('boots', 3),
      mastery('range', 1),
      spell('teleport', 4),
      mastery('duration', 1),
      item('scourge', 3),
      item('fireball', 7),
      spell('lightning', 4),
      mastery('range', 3),
      spell('teleport', 7),
    ],
  },
  hunter: {
    weight: 1,
    steps: [
      spell('teleport', 1),
      spell('homing', 1),
      item('boots', 1),
      item('fireball', 2),
      spell(HOLD, 1),
      item('boots', 2),
      item('scourge', 2),
      spell('teleport', 2),
      item('fireball', 4),
      item('boots', 3),
      spell('homing', 3),
      mastery('duration', 2),
      item('armor', 1),
      spell('teleport', 4),
      item('scourge', 3),
      item('fireball', 6),
      spell('homing', 5),
      mastery('range', 1),
      spell(HOLD, 3),
      mastery('duration', 4),
      item('fireball', 7),
      spell('teleport', 7),
    ],
  },
  duelist: {
    weight: 1,
    steps: [
      spell('teleport', 1),
      spell(DUEL_BOLT, 1),
      item('boots', 1),
      item('fireball', 3),
      spell(DUEL_T, 1),
      item('boots', 2),
      item('scourge', 2),
      spell('teleport', 2),
      item('fireball', 5),
      item('boots', 3),
      spell(DUEL_BOLT, 3),
      mastery('lifesteal', 1),
      spell('shield', 1),
      spell('teleport', 4),
      item('scourge', 3),
      spell('shield', 2),
      mastery('lifesteal', 3),
      item('fireball', 7),
      spell(DUEL_T, 4),
      spell('teleport', 7),
    ],
  },
  artillery: {
    weight: 1,
    steps: [
      spell('teleport', 1),
      spell(ARTY_BOLT, 1),
      item('boots', 1),
      item('fireball', 3),
      spell('meteor', 1),
      item('boots', 2),
      spell(BARRAGE, 1),
      spell('teleport', 2),
      item('ring_of_health', 1),
      item('boots', 3),
      mastery('range', 1),
      spell('meteor', 3),
      item('scourge', 2),
      item('fireball', 5),
      spell('teleport', 4),
      spell(BARRAGE, 3),
      mastery('range', 3),
      item('ring_of_health', 2),
      item('fireball', 7),
      spell('meteor', 5),
      item('scourge', 3),
      spell('teleport', 7),
    ],
  },
  brawler: {
    weight: 1,
    steps: [
      spell('thrust', 1),
      spell('boomerang', 1),
      item('boots', 1),
      item('scourge', 2),
      item('fireball', 3),
      item('boots', 2),
      spell(CLOSE_HOLD, 1),
      item('armor', 1),
      spell('thrust', 3),
      item('boots', 3),
      item('scourge', 3),
      mastery('lifesteal', 1),
      item('armor', 2),
      spell('boomerang', 3),
      item('fireball', 5),
      spell('thrust', 5),
      mastery('lifesteal', 3),
      mastery('duration', 1),
      item('armor', 3),
      item('fireball', 7),
      spell('boomerang', 5),
      spell('thrust', 7),
    ],
  },
  leech: {
    weight: 1,
    steps: [
      spell('swap', 1),
      spell('drain', 1),
      item('boots', 1),
      item('cape', 1),
      item('fireball', 3),
      item('boots', 2),
      spell(LEECH_E, 1),
      item('scourge', 2),
      item('ring_of_health', 1),
      item('boots', 3),
      spell('drain', 3),
      mastery('lifesteal', 2),
      item('fireball', 5),
      item('cape', 3),
      spell('swap', 3),
      spell(LEECH_E, 3),
      item('scourge', 3),
      item('ring_of_health', 3),
      mastery('duration', 2),
      mastery('lifesteal', 4),
      item('fireball', 7),
      spell('drain', 5),
    ],
  },
} satisfies Record<string, BuildDef>

export type BuildId = keyof typeof BUILDS
export const BUILD_IDS = Object.keys(BUILDS) as BuildId[]

/** King of the Hill draw weights: holding a crowded hill rewards area and multi-target hits. */
export const HILL_WEIGHTS: Record<BuildId, number> = { blink: 1.2, hunter: 0.8, duelist: 0.6, artillery: 2, brawler: 1.6, leech: 0.8 }

/** Draws a build (`only`: always that one; `weights`: instead of each build's own), resolving its choices. */
export function drawBuild(rng: Rng, only?: BuildId, weights?: Record<BuildId, number>): Build {
  let id = only
  if (!id) {
    const weight = (b: BuildId) => weights?.[b] ?? BUILDS[b].weight
    const total = BUILD_IDS.reduce((s, b) => s + weight(b), 0)
    let r = rng.next() * total
    id = BUILD_IDS.find((b) => (r -= weight(b)) < 0) ?? BUILD_IDS[BUILD_IDS.length - 1]
  }
  const chosen = new Map<readonly SpellId[], SpellId>()
  const steps = (BUILDS[id] as BuildDef).steps.map((s): Step => {
    if (typeof s.id === 'string') return { kind: s.kind, id: s.id, level: s.level }
    let pick = chosen.get(s.id)
    if (!pick) chosen.set(s.id, (pick = rng.pick(s.id)))
    return { kind: s.kind, id: pick, level: s.level }
  })
  return { id, steps }
}

/** The next purchase of the build, or null (done, or saving up for the next step). */
export function planStep(build: Build, me: PawnState | null, gold: number, failed: ReadonlySet<SpellId>, score?: PlayerScore): { cmd: InputCommand; id: SpellId } | null {
  if (!me) return null
  for (const step of build.steps) {
    if (step.kind === 'mastery') {
      const kind = step.id as MasteryKind
      const level = score?.masteries[kind]
      if (level === undefined || failed.has(kind) || level >= step.level || level >= MASTERY_MAX_LEVEL) continue
      if (gold < MASTERY_COST) return null
      return { cmd: { kind: 'buyMastery', mastery: kind }, id: kind }
    }
    // passive items (Ring of Health, Armor, ...) are not in SPELLS: flat cost per level
    const def = SPELLS[step.id] ?? PASSIVE_ITEMS[step.id]
    if (!def || !RELEASED_SPELLS.has(step.id) || failed.has(step.id)) continue
    const slot = step.kind === 'spell' && 'column' in def ? def.column - 1 : me.slots.indexOf(step.id, ITEM_SLOT_START)
    const owned = slot >= 0 && me.slots[slot] === step.id
    // a column already holding another spell is closed for good (no selling)
    if (step.kind === 'spell' && !owned && me.slots[slot] !== null) continue
    const level = owned ? me.levels[slot] : 0
    if (level >= step.level || level >= def.maxLevel) continue
    const cost = step.kind === 'spell' && 'upgradeCosts' in def ? (level === 0 ? def.cost : def.upgradeCosts[level - 1]) : def.cost
    if (gold < cost) return null
    const cmd: InputCommand = step.kind === 'spell' ? { kind: 'buySpell', spell: step.id } : { kind: 'buyItem', item: step.id }
    return { cmd, id: step.id }
  }
  return null
}
