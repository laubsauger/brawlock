/**
 * Bot difficulty presets as a parameter vector (docs/PLAN.md §7).
 *
 * The original AI had one knob, the think interval (easy 1.0 s, medium 0.5 s,
 * hard 0.2 s), with identical decision logic. We keep that logic and spread
 * difficulty over the knobs below. Every preset stays human-plausible: reaction
 * delay >= 150 ms and aim error > 0 through Brutal. Uber sits above Brutal without cheating:
 * reaction >= 120 ms, aim error > 0, the same casts, cooldowns and gold; it wins on decisions.
 *
 * Calibrated with Elo per ROUND (scripts/bots/elo.ts, BOT_ELO below). Every active tier
 * draws from the same seeded shop-build pool. Difficulty still controls reaction, aim
 * and combat decisions: Hard is Brutal's decision set at slower hands (0.18 s, 0.03 rad),
 * while Brutal adds edge pressure. Easy keeps its beginner reaction and aim settings.
 *
 * | param            | dummy | easy  | medium | hard  | brutal | uber  | original |
 * |------------------|-------|-------|--------|-------|--------|-------|----------|
 * | thinkInterval s  |   -   | 1.0   | 0.35   | 0.1   | 0.1    | 0.1   | 1.0/0.5/0.2 |
 * | reactionDelay s  |   -   | 0.35  | 0.22   | 0.18  | 0.15   | 0.12  | 0        |
 * | aimErrorRad      |   -   | 0.20  | 0.08   | 0.03  | 0.02   | 0.015 | 0        |
 * | leadChance       |   -   | 0.33  | 0.5    | 0.95  | 0.95   | 1     | 1/3      |
 * | leadWindup       |   -   | no    | no     | yes   | yes    | yes   | no       |
 * | castChance/think |   -   | 0.2   | 0.2    | 0.25  | 0.25   | 0.3   | 1/5      |
 * | rangeCheck       |   -   | no    | no     | yes   | yes    | yes   | no       |
 * | dodge (thresh)   |   -   | 3     | 3      | 2.5   | 2.5    | 2.5   | 3        |
 * | scourgeChance    |   -   | 1/6   | 1/6    | 0.3   | 0.3    | 0.5   | 1/6      |
 * | scourgeRange     |   -   | 300   | 300    | 240   | 240    | 240   | 300      |
 * | escapeChance     |   -   | 1/3   | 1/3    | 1.0   | 1.0    | 1.0   | 1/3      |
 * | safeWander       |   -   | yes   | yes    | yes   | yes    | yes   | no       |
 * | edgeMargin       |   -   | 0     | 60     | 150   | 150    | 170   | -        |
 * | shrinkLookahead s|   -   | 0     | 0      | 3     | 3      | 3     | -        |
 * | walkOffLava      |   -   | no    | yes    | yes   | yes    | yes   | no       |
 * | dodgeAvoidsLava  |   -   | no    | no     | yes   | yes    | yes   | no       |
 * | buys spells      |   no  | plan  | plan   | plan  | plan   | plan  | yes      |
 * | comboChance      |   -   | 0     | 0      | 0.9   | 0.9    | 1     | -        |
 * | thrustAttack     |   -   | no    | no     | yes   | yes    | yes   | no       |
 * | threatChance     |   -   | 0.35  | 0.8    | 1     | 1      | 1     | -        |
 * | threatEscape     |   -   | no    | no     | yes   | yes    | yes   | -        |
 * | useCover         |   -   | no    | no     | yes   | yes    | yes   | -        |
 * | teleportSave     |   -   | 0.1   | 0.35   | 1     | 1      | 1     | -        |
 * | saveLookahead    |   -   | no    | no     | yes   | yes    | yes   | -        |
 * | momentumAware    |   -   | no    | no     | yes   | yes    | yes   | -        |
 * | teleportDodge    |   -   | 0     | 0      | 1     | 1      | 1     | -        |
 * | teleportOffense  |   -   | 0     | 0      | 0.1   | 0.1    | 0.5   | -        |
 * | shieldReflect    |   -   | 0.1   | 0.35   | 1     | 1      | 1     | -        |
 * | targetSense      |   -   | 0     | 0.4    | 0.8   | 1      | 1     | -        |
 * | scourgeMinValue  |   -   | -     | -      | 0.5   | 0.5    | 0.45  | -        |
 * | scourgeMinHp     |   -   | 0     | 0      | 220   | 220    | 200   | -        |
 * | edgePressure     |   -   | no    | no     | no    | yes    | yes   | -        |
 * | frictionLead     |   -   | no    | no     | no    | no     | yes   | -        |
 * | shotGate         |   -   | 0     | 0      | 0     | 0      | 0.3   | -        |
 *
 * comboChance: chance per think to detonate its own Fireball with Lightning when the
 * Fireball flies next to an enemy (the original AI never combined spells).
 * thrustAttack: Thrust into a nearby enemy when the ground past them is safe (the original
 * only used Thrust to leave lava).
 *
 * threatChance: chance per think to walk out of an area about to strike (an enemy charging
 * Scourge, a Meteor's landing spot, a Gravity orb's damage zone). threatEscape: when walking
 * cannot clear it in time, use the escape spell instead.
 *
 * teleportSave: chance per think to teleport out of a lethal or high-risk lava trajectory
 * (saveLookahead: predict it from the knockback slide before touching lava; otherwise only
 * once standing in lava). momentumAware: Teleport keeps 80% of the velocity, so the landing
 * spot is chosen where that leftover slide ends on safe ground. teleportDodge: blink out of a
 * projectile that walking cannot clear in time when the hit would be lethal or high-risk.
 * teleportOffense: chance to blink to the arena-centre side of an enemy near the edge, so the
 * next hits push it out (only with Teleport spare and nothing threatening).
 *
 * Scourge: every preset needs an enemy inside the blast radius (never an empty radius).
 * scourgeMinValue (hard and up) replaces the per-think chance with a value: expected enemies
 * still inside when the 0.9 s windup ends (rooted or pulled ones count fully, walkers can
 * leave), weighted up when the push would end in lava; never below scourgeMinHp unless the
 * blast would kill.
 *
 * edgePressure (Brutal, Uber) picks the target with the best kill chance (near the edge, high
 * knockback points) and keeps to its arena-centre side, so hits push out. 'plan' (all active tiers)
 * draws one of several builds per bot (plan.ts: an escape spell first, a damage spell, Fireball
 * and Scourge upgrades, then what the build is about) and buys to it as gold allows each shop
 * phase. Uber only: frictionLead leads knocked targets with their decaying slide;
 * shotGate skips shots a target can easily walk out of.
 *
 * targetSense (FFA, 2+ enemies): local opportunities beyond distance: finishing chances,
 * threats, fading retaliation, and third-party pushes, weighed against nearby competition.
 * A seeded personality varies risk, opportunism and target attachment. Score hysteresis
 * stabilizes choices without a chase timer; smooth positioning utility trades firing range,
 * crowd pressure, travel and health. Crowds can still be worthwhile when a finish is good.
 * 0 = closest enemy, without the additional opportunity scoring.
 *
 * shieldReflect: chance per think to raise its own Shield (when it owns one) against a bolt on a
 * collision course that would reach the bubble while it is up (the Teleport-save scale). Every
 * preset holds fire at a target whose Shield or Alteration bubble will still be up when the
 * shot gets there (it would come back, or be wasted), and dodges its own shot coming back even
 * right after casting it.
 *
 * useCover: a bolt whose flight hits a pillar before reaching us is no threat, so the bot
 * stays in a pillar's cover instead of stepping out of it, and dodges toward cover. Every
 * preset keeps wander points out of pillars, walks around them and never dodges into one.
 *
 * Dummy issues no commands at all: a practice target that stands where it spawned.
 */
import type { BotDifficulty } from '../sim/types'
import type { BuildId } from './plan'

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
  /** buy spells and items between rounds or while dead */
  buys: boolean
  /** chance per think to Lightning its own Fireball when it passes an enemy */
  comboChance: number
  /** use Thrust as an attack on a close enemy, not only to leave lava */
  thrustAttack: boolean
  /** chance per think to leave an area threat (charging Scourge, Meteor spot, Gravity zone) */
  threatChance: number
  /** escape spell out of an area threat when walking is too slow */
  threatEscape: boolean
  /** count pillars as cover from projectiles */
  useCover: boolean
  /** chance per think to teleport out of a lethal / high-risk lava trajectory */
  teleportSave: number
  /** predict lava from the knockback slide (false: only react once in lava) */
  saveLookahead: boolean
  /** landing spot accounts for Teleport keeping 80% of the velocity */
  momentumAware: boolean
  /** chance per think to blink out of an unavoidable, dangerous projectile */
  teleportDodge: number
  /** chance per think to blink to an enemy's centre side when it is near the edge */
  teleportOffense: number
  /** chance per think to raise its own Shield against a bolt about to hit */
  shieldReflect: number
  /** FFA target choice beyond distance: 0 = closest enemy (original), 1 = full opportunity score */
  targetSense: number
  /** value-based Scourge (0 = the original per-think chance) */
  scourgeMinValue: number
  /** no Scourge below this HP unless it kills */
  scourgeMinHp: number
  /** target by kill chance and hold the centre side of it */
  edgePressure: boolean
  /** lead knocked targets with friction */
  frictionLead: boolean
  /** minimum estimated hit chance to take a shot (0 = always) */
  shotGate: number
  /**
   * shop: 'random' = original one random spell per 40 s, 'plan' = a build drawn per bot
   * (plan.ts), a build id = always that build (tuning)
   */
  buildPlan: 'random' | 'plan' | BuildId
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
  comboChance: 0,
  thrustAttack: false,
  threatChance: 0.35,
  threatEscape: false,
  useCover: false,
  teleportSave: 0.1,
  saveLookahead: false,
  momentumAware: false,
  teleportDodge: 0,
  teleportOffense: 0,
  shieldReflect: 0.1,
  targetSense: 0,
  scourgeMinValue: 0,
  scourgeMinHp: 0,
  edgePressure: false,
  frictionLead: false,
  shotGate: 0,
  buildPlan: 'random',
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
    buildPlan: 'plan',
  },
  medium: {
    ...ORIGINAL,
    buildPlan: 'plan',
    thinkInterval: 0.35,
    reactionDelay: 0.22,
    aimErrorRad: 0.08,
    leadChance: 0.5,
    edgeMargin: 60,
    walkOffLava: true,
    threatChance: 0.8,
    teleportSave: 0.35,
    shieldReflect: 0.35,
    targetSense: 0.4,
  },
  hard: {
    ...ORIGINAL,
    buildPlan: 'plan',
    thinkInterval: 0.1,
    reactionDelay: 0.18,
    aimErrorRad: 0.03,
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
    comboChance: 0.9,
    thrustAttack: true,
    threatChance: 1,
    threatEscape: true,
    useCover: true,
    teleportSave: 1,
    saveLookahead: true,
    momentumAware: true,
    teleportDodge: 1,
    teleportOffense: 0.1,
    shieldReflect: 1,
    targetSense: 0.8,
    scourgeMinValue: 0.5,
    scourgeMinHp: 220,
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
    comboChance: 0.9,
    thrustAttack: true,
    threatChance: 1,
    threatEscape: true,
    useCover: true,
    teleportSave: 1,
    saveLookahead: true,
    momentumAware: true,
    teleportDodge: 1,
    teleportOffense: 0.1,
    shieldReflect: 1,
    targetSense: 1,
    scourgeMinValue: 0.5,
    scourgeMinHp: 220,
    edgePressure: true,
    buildPlan: 'plan',
  },
  uber: {
    ...ORIGINAL,
    thinkInterval: 0.1,
    reactionDelay: 0.12,
    aimErrorRad: 0.015,
    leadChance: 1,
    leadWindup: true,
    castChance: 0.3,
    rangeCheck: true,
    dodgeThreshold: 2.5,
    scourgeChance: 0.5,
    scourgeRange: 240,
    escapeChance: 1,
    edgeMargin: 170,
    shrinkLookahead: 3,
    walkOffLava: true,
    dodgeAvoidsLava: true,
    comboChance: 1,
    thrustAttack: true,
    threatChance: 1,
    threatEscape: true,
    useCover: true,
    teleportSave: 1,
    saveLookahead: true,
    momentumAware: true,
    teleportDodge: 1,
    teleportOffense: 0.5,
    shieldReflect: 1,
    targetSense: 1,
    scourgeMinValue: 0.45,
    scourgeMinHp: 200,
    edgePressure: true,
    frictionLead: true,
    shotGate: 0.3,
    buildPlan: 'plan',
  },
}

/**
 * Round-based Elo per difficulty (Medium = 1000), measured by `npm run bots:elo`: Bradley–Terry
 * fit over seeded 1v1 rounds, rounded to 25 (table and intervals: docs/PLAN.md §7). Rounds, not
 * matches, are the unit: a first-to-5 match turns a 75% round edge into about 90% of matches.
 * For a future human rating on the same scale. Dummy has no rating (it never acts).
 */
export const BOT_ELO: Record<Exclude<BotDifficulty, 'dummy'>, number> = {
  easy: 400,
  medium: 1000,
  hard: 1600,
  brutal: 1825,
  uber: 2000,
}
