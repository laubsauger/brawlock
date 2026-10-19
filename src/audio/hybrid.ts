/**
 * Hybrid mode: recordings layered under (or instead of) the synth recipes, per sound.
 * Verdicts (sound design, checked with offline A/B renders against the LUFS targets):
 * - hybrid: the recording adds what synthesis lacks (real fire, stone, ice, metal, cloth,
 *   electricity); the synth keeps the punch, timing and spell identity;
 * - synth: magical / abstract sounds (Homing, Twin, Gravity, Warpzone, Magnetize, Splitter,
 *   orbs, windups, cast inhale and snuff, ordinary UI, music) where the synth reads better and the
 *   timing must be exact.
 * `trim` scales the combined voice to fit the existing mix and limiter headroom.
 * Body layers carry the impact; clicks, cloth and crackle stay behind them.
 */
import type { AssetId } from './assets'
import type { SfxId } from './synth'

export interface SampleLayer {
  /** variants; one is picked at random per trigger */
  assets: readonly AssetId[]
  /** layer gain relative to the synth voice */
  gain: number
  /** random playback rate range (pitch / speed variation) */
  rate?: readonly [number, number]
  /** start offset after the voice start, seconds */
  at?: number
  /** play a random slice of this length (s) from a longer source, with short fades */
  slice?: readonly [number, number]
  /** loop for the whole voice (travel loops), following its Doppler */
  loop?: boolean
  /** only when the voice param is at least this (e.g. knockback intensity) */
  minParam?: number
}

export interface HybridDef {
  layers: readonly SampleLayer[]
  /** synth recipe gain in hybrid mode (1 = unchanged, 0 = the recording replaces it) */
  synth?: number
  /** overall voice gain in hybrid mode, after the recording and synth are combined */
  trim?: number
}

export const HYBRID: Partial<Record<SfxId, HybridDef>> = {
  // Approved E04 "Iron thunder": full replacement, fixed pitch and audition gain.
  uiReady: { layers: [{ assets: ['ui_enter'], gain: 1 }], synth: 0 },
  killConfirm: {
    layers: [
      { assets: ['thud_a', 'thud_b'], gain: 0.65, rate: [0.85, 0.95] },
      { assets: ['impact_energy'], gain: 0.22, rate: [0.9, 1] },
    ],
    trim: 0.82,
  },
  // --- fire --------------------------------------------------------------------
  fireballCast: { layers: [{ assets: ['fire_whoosh_a', 'fire_whoosh_b'], gain: 0.55, rate: [0.95, 1.12] }], synth: 0.7, trim: 1.12 },
  fireballTravel: { layers: [{ assets: ['fire_loop'], gain: 1.29, rate: [0.9, 1.1], loop: true }], synth: 0.8, trim: 1.01 },
  explosion: {
    layers: [
      { assets: ['fire_burst'], gain: 0.58, rate: [0.85, 1.05] },
      { assets: ['debris_a', 'debris_b', 'debris_c', 'debris_d'], gain: 1.49, rate: [0.9, 1.1], at: 0.03 },
    ],
    synth: 0.8,
    trim: 0.88,
  },
  meteorFall: { layers: [{ assets: ['flame_jet', 'flame_roar'], gain: 0.59, rate: [0.7, 0.85], loop: true }], synth: 0.8, trim: 0.89 },
  meteorImpact: {
    layers: [
      { assets: ['fire_burst'], gain: 0.63, rate: [0.7, 0.85] },
      { assets: ['rock_fall'], gain: 0.43, rate: [0.85, 1] },
      { assets: ['debris_a', 'debris_b', 'debris_c', 'debris_d'], gain: 1.2, at: 0.12 },
    ],
    trim: 0.72,
  },
  ignite: { layers: [{ assets: ['flame_ignite'], gain: 0.48, rate: [0.9, 1.1] }], synth: 0.7, trim: 0.86 },
  lavaSizzle: { layers: [{ assets: ['coal_crackle'], gain: 0.55, slice: [0.25, 0.35] }], synth: 0.7, trim: 0.82 },
  // --- electricity -------------------------------------------------------------
  beamZap: { layers: [{ assets: ['zap_a', 'zap_b'], gain: 0.23, rate: [0.95, 1.08] }], synth: 0.75, trim: 0.92 },
  zapHit: { layers: [{ assets: ['zap_spark', 'zap_c'], gain: 0.32, rate: [0.9, 1.15] }], synth: 0.8, trim: 0.93 },
  bounceZap: { layers: [{ assets: ['zap_spark'], gain: 0.19, rate: [1, 1.3] }], trim: 0.87 },
  rechargeTravel: { layers: [{ assets: ['zap_loop'], gain: 0.3, rate: [0.95, 1.05], loop: true }], synth: 0.7, trim: 1.04 },
  linkLoop: { layers: [{ assets: ['zap_loop'], gain: 0.19, rate: [0.8, 0.9], loop: true }], synth: 0.7, trim: 0.98 },
  linkCast: { layers: [{ assets: ['chain_clicks'], gain: 0.73, slice: [0.25, 0.4] }], trim: 0.68 },
  // --- metal -------------------------------------------------------------------
  bladeThrow: { layers: [{ assets: ['blade_swish'], gain: 0.19, rate: [0.95, 1.1] }], synth: 0.7, trim: 0.92 },
  bladeSpin: { layers: [{ assets: ['fan_loop'], gain: 0.93, rate: [1.5, 1.8], loop: true }], synth: 0.7, trim: 0.94 },
  bladeHit: { layers: [{ assets: ['clank', 'clang_a'], gain: 0.19, rate: [0.95, 1.1] }], trim: 0.91 },
  tink: { layers: [{ assets: ['clank'], gain: 0.14, rate: [1, 1.2] }], trim: 0.89 },
  reflect: { layers: [{ assets: ['shield_impact'], gain: 0.26, rate: [0.95, 1.05] }], synth: 0.8, trim: 0.94 },
  ricochet: { layers: [{ assets: ['clank'], gain: 0.12, rate: [1.1, 1.35] }], trim: 0.85 },
  chains: { layers: [{ assets: ['chain_clicks'], gain: 0.49, slice: [0.35, 0.5] }], synth: 0.5, trim: 1.07 },
  // --- ice / stone -------------------------------------------------------------
  snowBurst: { layers: [{ assets: ['ice_a', 'ice_b', 'ice_c'], gain: 1.6, rate: [0.9, 1.1] }], synth: 0.7, trim: 0.92 },
  snowGrab: { layers: [{ assets: ['snow_crunch'], gain: 0.36, rate: [0.9, 1.1] }], synth: 0.6, trim: 0.97 },
  snowCast: { layers: [{ assets: ['snow_crunch'], gain: 0.17, rate: [1.1, 1.3] }], trim: 0.96 },
  pillarRise: {
    layers: [
      { assets: ['stone_drag', 'stone_door'], gain: 1.6, slice: [0.3, 0.4] },
      { assets: ['rock_fall'], gain: 0.38, at: 0.32 },
    ],
    synth: 0.6,
    trim: 0.68,
  },
  obstacleBreak: {
    layers: [
      { assets: ['debris_a', 'debris_b', 'debris_c', 'debris_d'], gain: 1.4, rate: [0.9, 1.1] },
      { assets: ['pebbles'], gain: 1.1, at: 0.1 },
    ],
    synth: 0.6,
    trim: 0.84,
  },
  shrinkRumble: {
    layers: [
      { assets: ['rumble'], gain: 1.17, rate: [0.9, 1] },
      { assets: ['stone_door'], gain: 1.32, slice: [1.2, 1.6], at: 0.3 },
    ],
    synth: 0.7,
    trim: 0.93,
  },
  // --- teleports / magic -------------------------------------------------------
  teleportOut: { layers: [{ assets: ['tele_out'], gain: 0.63, rate: [0.95, 1.05] }], synth: 0.7, trim: 1.16 },
  teleportIn: { layers: [{ assets: ['tele_in'], gain: 0.37, rate: [0.95, 1.05] }], synth: 0.7, trim: 1.17 },
  swapWarp: { layers: [{ assets: ['tele_high'], gain: 0.33, rate: [0.9, 1.1] }], synth: 0.8, trim: 1.07 },
  shieldUp: { layers: [{ assets: ['magic_cast'], gain: 0.13, rate: [1.1, 1.25] }], synth: 0.9, trim: 1.1 },
  // --- bodies ------------------------------------------------------------------
  hit: {
    layers: [
      { assets: ['hit_a', 'hit_b'], gain: 0.16, rate: [0.85, 1] },
      { assets: ['thud_a', 'thud_b'], gain: 0.6, rate: [0.85, 1], minParam: 0.8 },
      { assets: ['cloth_flutter', 'swish'], gain: 0.13, rate: [0.9, 1.1], at: 0.03, minParam: 0.9 },
    ],
    synth: 0.75,
    trim: 0.98,
  },
  impact: {
    layers: [
      { assets: ['thud_a', 'thud_b'], gain: 0.25, rate: [0.85, 0.98] },
      // R01: a subtle impact-only layer; the stronger and explosion variants were rejected.
      { assets: ['impact_energy'], gain: 0.1 },
    ],
    synth: 0.8,
    trim: 1.1,
  },
  chargeSlam: { layers: [{ assets: ['thud_a', 'thud_b'], gain: 0.94, rate: [0.85, 1], at: 0.03 }], synth: 0.8, trim: 0.99 },
  dashBurst: { layers: [{ assets: ['cloth_flutter', 'swish'], gain: 0.44, rate: [0.9, 1.05] }], trim: 0.81 },
  fade: { layers: [{ assets: ['cloth_flap', 'swish'], gain: 0.08, rate: [0.9, 1.05] }], synth: 0.8, trim: 0.77 },
  death: {
    layers: [
      // the warlock's death cry leads (one of seven, slightly varied in pitch); the body
      // impact and burn sit under it
      { assets: ['death_cry_a', 'death_cry_b', 'death_cry_c', 'death_cry_d', 'death_grunt_a', 'death_grunt_b', 'death_grunt_c'], gain: 1.15, rate: [0.94, 1.06] },
      { assets: ['thud_a'], gain: 0.9, rate: [0.75, 0.85] },
      { assets: ['fire_burst'], gain: 0.32, rate: [0.7, 0.8], at: 0.05 },
      { assets: ['coal_crackle'], gain: 0.3, slice: [0.6, 0.8], at: 0.15 },
    ],
    trim: 0.9,
  },
}
