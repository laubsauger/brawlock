/**
 * Bot difficulty presets as a parameter vector (docs/PLAN.md §7).
 *
 * The original AI had one knob, the think interval (easy 1.0 s, medium 0.5 s,
 * hard 0.2 s), with identical decision logic. We keep that logic and spread
 * difficulty over the knobs below. Every preset stays human-plausible: reaction
 * delay >= 150 ms and aim error > 0, even for Brutal.
 *
 * | param            | dummy | easy  | medium | hard  | brutal | original |
 * |------------------|-------|-------|--------|-------|--------|----------|
 * | thinkInterval s  |   -   | 1.0   | 0.5    | 0.2   | 0.1    | 1.0/0.5/0.2 |
 * | reactionDelay s  |   -   | 0.35  | 0.25   | 0.18  | 0.15   | 0        |
 * | aimErrorRad      |   -   | 0.20  | 0.10   | 0.05  | 0.02   | 0        |
 * | leadChance       |   -   | 0.33  | 0.5    | 0.85  | 0.95   | 1/3      |
 * | leadWindup       |   -   | no    | no     | yes   | yes    | no       |
 * | castChance/think |   -   | 0.2   | 0.2    | 0.2   | 0.25   | 1/5      |
 * | rangeCheck       |   -   | no    | no     | yes   | yes    | no       |
 * | dodge (thresh)   |   -   | 3     | 3      | 3     | 2.5    | 3        |
 * | scourgeChance    |   -   | 1/6   | 1/6    | 1/6   | 0.3    | 1/6      |
 * | scourgeRange     |   -   | 300   | 300    | 300   | 240    | 300      |
 * | escapeChance     |   -   | 1/3   | 1/3    | 0.5   | 1.0    | 1/3      |
 * | safeWander       |   -   | yes   | yes    | yes   | yes    | no       |
 * | edgeMargin       |   -   | 0     | 60     | 110   | 150    | -        |
 * | shrinkLookahead s|   -   | 0     | 0      | 1.5   | 3      | -        |
 * | walkOffLava      |   -   | no    | yes    | yes   | yes    | no       |
 * | dodgeAvoidsLava  |   -   | no    | no     | yes   | yes    | no       |
 * | buys spells      |   no  | yes   | yes    | yes   | yes    | yes      |
 *
 * Dummy issues no commands at all: a practice target that stands where it spawned.
 */
import type { BotDifficulty } from '../sim/types'

export interface BotParams {
  /** false = never issue any command (Dummy) */
  active: boolean
  /** seconds between decisions */
  thinkInterval: number
  /** seconds between a decision and its commands reaching the sim */
  reactionDelay: number
  /** aim error, radians; triangular distribution in [-aimErrorRad, aimErrorRad] */
  aimErrorRad: number
  /** chance to lead a projectile at the target's predicted position */
  leadChance: number
  /**
   * lead also covers the spell's cast point and our own reaction delay (the target keeps
   * walking while we click and wind up), as a practiced player anticipates
   */
  leadWindup: boolean
  /** chance per think to try a projectile cast */
  castChance: number
  /** skip shots whose aim point is beyond the spell's range */
  rangeCheck: boolean
  dodge: boolean
  /** danger that triggers a dodge; 3 means a projectile path within ~332 units */
  dodgeThreshold: number
  /** chance per think to start Scourge with an enemy within scourgeRange */
  scourgeChance: number
  scourgeRange: number
  /** chance per think to cast the escape spell while standing on lava */
  escapeChance: number
  /** reject wander points that are lava (the original did not check) */
  safeWander: boolean
  /** wander points keep this distance from lava, units */
  edgeMargin: number
  /** seconds before a shrink during which the next (smaller) layer counts as the arena */
  shrinkLookahead: number
  /** on lava without a usable escape: walk to the nearest tile instead of wandering */
  walkOffLava: boolean
  /** pick a dodge direction that does not step into lava */
  dodgeAvoidsLava: boolean
  /** chance per think to retarget to the closest enemy (original 1/5) */
  retargetChance: number
  /** buy random spells between rounds (original behaviour) */
  buys: boolean
}

const ORIGINAL: Omit<BotParams, 'thinkInterval'> = {
  active: true,
  reactionDelay: 0.35,
  aimErrorRad: 0.2,
  leadChance: 1 / 3,
  leadWindup: false,
  castChance: 1 / 5,
  rangeCheck: false,
  dodge: true,
  dodgeThreshold: 3,
  scourgeChance: 1 / 6,
  scourgeRange: 300,
  escapeChance: 1 / 3,
  safeWander: true,
  edgeMargin: 0,
  shrinkLookahead: 0,
  walkOffLava: false,
  dodgeAvoidsLava: false,
  retargetChance: 1 / 5,
  buys: true,
}

export const BOT_PRESETS: Record<BotDifficulty, BotParams> = {
  dummy: {
    ...ORIGINAL,
    active: false,
    thinkInterval: 1e7,
    dodge: false,
    castChance: 0,
    scourgeChance: 0,
    escapeChance: 0,
    buys: false,
  },
  easy: {
    ...ORIGINAL,
    thinkInterval: 1.0,
  },
  medium: {
    ...ORIGINAL,
    thinkInterval: 0.5,
    reactionDelay: 0.25,
    aimErrorRad: 0.1,
    leadChance: 0.5,
    edgeMargin: 60,
    walkOffLava: true,
  },
  hard: {
    ...ORIGINAL,
    thinkInterval: 0.2,
    reactionDelay: 0.18,
    aimErrorRad: 0.05,
    leadChance: 0.85,
    leadWindup: true,
    rangeCheck: true,
    escapeChance: 0.5,
    edgeMargin: 110,
    shrinkLookahead: 1.5,
    walkOffLava: true,
    dodgeAvoidsLava: true,
  },
  brutal: {
    ...ORIGINAL,
    thinkInterval: 0.1,
    reactionDelay: 0.15,
    aimErrorRad: 0.02,
    leadChance: 0.95,
    leadWindup: true,
    castChance: 0.25,
    rangeCheck: true,
    dodgeThreshold: 2.5,
    scourgeChance: 0.3,
    scourgeRange: 240,
    escapeChance: 1,
    edgeMargin: 150,
    shrinkLookahead: 3,
    walkOffLava: true,
    dodgeAvoidsLava: true,
  },
}
