/**
 * Shared spell identity palette (render + VFX modules + UI may read it).
 *
 * One core + accent pair per spell id. Rules:
 * - distinct at a glance from each other AND from the lava (deep orange,
 *   value-mid): spells that are "fire" (Fireball, Meteor, Rush) push hue or
 *   value away from the lava's orange (Fireball = hot yellow-white core with a
 *   crimson rim, Meteor = violet-hearted fire, Rush = gold).
 * - colorblind-aware: neighbours differ in VALUE (light / dark) as well as
 *   hue, so deuteranopes/protanopes still separate red vs green spells by
 *   brightness (Drain dark sickly green vs Homing bright magenta-red, etc.).
 * - `core` is the hot centre (bright, may exceed 1 for bloom when used as
 *   HDR), `accent` is the rim / trail / decal colour.
 *
 * Values are sRGB hex (UI-friendly). Use `spellColor(id)` for linear
 * THREE.Color copies (shader / particle colours), multiply for HDR.
 */
import * as THREE from 'three/webgpu'

export interface SpellPalette {
  /** hot centre (sRGB hex) */
  core: number
  /** rim / trail / decal (sRGB hex) */
  accent: number
  /** short note on the identity (for tuning) */
  note: string
}

export const SPELL_PALETTE: Record<string, SpellPalette> = {
  // column 1: knockout
  fireball: { core: 0xfff1b8, accent: 0xe32f12, note: 'fire spectrum: yellow-white core, crimson rim' },
  boomerang: { core: 0xffc8a8, accent: 0xbe6f49, note: 'red-copper, lighter than Fireball / darker drain (deutan pair)' },
  lightning: { core: 0xf2f8ff, accent: 0x67b5f8, note: 'electric white-blue' },
  homing: { core: 0xff86c0, accent: 0xe03467, note: 'magenta-red, hot pink rim' },
  twin: { core: 0xfff0b0, accent: 0xffb85e, note: 'pale gold-orange, far lighter than lava' },
  // column 2: transport
  teleport: { core: 0xd8fbff, accent: 0x37c6db, note: 'arcane cyan' },
  thrust: { core: 0xf4ffff, accent: 0xb4f0f2, note: 'cyan-white shock, palest blue-green' },
  swap: { core: 0xe6d8ff, accent: 0x906afe, note: 'violet (cyan edge in the effect)' },
  // column 3
  cluster: { core: 0xffe6a0, accent: 0xc18a21, note: 'amber, darker + browner than Twin' },
  drain: { core: 0xd0f0a0, accent: 0x3c5305, note: 'sickly green, dark olive (value-separated from Boomerang)' },
  bouncer: { core: 0xfffcb0, accent: 0xe4e04a, note: 'pure yellow, very light' },
  recharge: { core: 0xe9c8ff, accent: 0x9945e4, note: 'purple' },
  // column 4
  windwalk: { core: 0xffffff, accent: 0xc8cbce, note: 'pale grey-white, no hue' },
  meteor: { core: 0xffd6f0, accent: 0x491b8b, note: 'deep violet fire, dark' },
  splitter: { core: 0xffc0f8, accent: 0xe153db, note: 'magenta, bright' },
  snowball: { core: 0xf0fbff, accent: 0x7ad0f9, note: 'ice blue, light' },
  // column 5
  shield: { core: 0xfff8de, accent: 0xfff4dc, note: 'gold-white, palest (tritan-safe vs Bouncer yellow)' },
  rush: { core: 0xfff0a8, accent: 0xfc9206, note: 'flame orange-gold, lighter/yellower than lava' },
  alteration: { core: 0xffffff, accent: 0xaeafa6, note: 'silver glass, warm grey (vs cool Windwalk)' },
  gravity: { core: 0xb48cff, accent: 0x15092d, note: 'black-violet lensing, darkest' },
  // column 6
  grip: { core: 0xe0ffa0, accent: 0x7fd73f, note: 'toxic green, bright' },
  warpzone: { core: 0xb8fff2, accent: 0x37a297, note: 'teal' },
  magnetize: { core: 0xd0e4ff, accent: 0x39679c, note: 'steel blue, mid-dark' },
  rockpillar: { core: 0xd9c2a0, accent: 0x755640, note: 'earth brown' },
  link: { core: 0xcfffcf, accent: 0x27b35f, note: 'chain green' },
  // items / default spells
  scourge: { core: 0xff5a6e, accent: 0x631319, note: 'blood crimson over black' },
  redirector: { core: 0xffe0b8, accent: 0x9b6942, note: 'bronze' },
  pact: { core: 0xffd0d0, accent: 0x8d133c, note: 'dark wine / blood' },
}

/** Fallback for unknown ids: neutral arcane lilac. */
export const DEFAULT_PALETTE: SpellPalette = { core: 0xf0e8ff, accent: 0x8f7ad8, note: 'fallback' }

/**
 * Strip level / item prefixes and projectile-kind suffixes:
 * 'scourge3', 'item_warlock_fireball2' -> base id; 'splitterChild', 'drainHeal' -> 'splitter', 'drain'.
 */
export function baseSpellId(id: string): string {
  const s = id.replace(/^item_warlock_/, '').replace(/^warlock_/, '').replace(/[A-Z].*$/, '')
  const m = /^([a-z_]+?)\d*$/.exec(s)
  return m ? m[1] : s
}

export function spellPalette(id: string): SpellPalette {
  return SPELL_PALETTE[baseSpellId(id)] ?? DEFAULT_PALETTE
}

/** Linear-space colours for shaders/particles (new Colors; cache on your side). */
export function spellColor(id: string, which: 'core' | 'accent' = 'accent', out: THREE.Color = new THREE.Color()): THREE.Color {
  const p = spellPalette(id)
  return out.setHex(which === 'core' ? p.core : p.accent, THREE.SRGBColorSpace)
}

export type RGB3 = [number, number, number]

const pairCache = new Map<string, { readonly core: THREE.Color; readonly accent: THREE.Color }>()

/**
 * Cached linear-space pair for a spell (one allocation per id, ever). Treat as
 * read-only; copy before modifying.
 */
export function getSpellColor(id: string): { readonly core: THREE.Color; readonly accent: THREE.Color } {
  const key = baseSpellId(id)
  let c = pairCache.get(key)
  if (!c) {
    c = { core: spellColor(key, 'core'), accent: spellColor(key, 'accent') }
    pairCache.set(key, c)
  }
  return c
}

/**
 * Linear HDR triple for particle / billboard spawns: identity colour times
 * `intensity` (> 1 blooms), written into `out` (no allocation).
 */
export function spellRGB(id: string, which: 'core' | 'accent' = 'accent', intensity = 1, out: RGB3 = [0, 0, 0]): RGB3 {
  const c = getSpellColor(id)[which]
  out[0] = c.r * intensity
  out[1] = c.g * intensity
  out[2] = c.b * intensity
  return out
}

/** Rec. 709 luminance of a linear triple. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** out = a + (b - a) * t (linear triples; out may alias a or b). */
export function mixRGB(a: readonly number[], b: readonly number[], t: number, out: RGB3): RGB3 {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
  return out
}

/**
 * Same hue, rescaled to luminance `target` (HDR ok): lets dark identities
 * (Meteor, Scourge, Gravity) still glow at a chosen brightness, and keeps
 * bright ones (Bouncer, Shield) from blowing out to white.
 */
export function withLuminance(rgb: readonly number[], target: number, out: RGB3): RGB3 {
  const l = Math.max(1e-4, luminance(rgb[0], rgb[1], rgb[2]))
  const k = target / l
  out[0] = rgb[0] * k
  out[1] = rgb[1] * k
  out[2] = rgb[2] * k
  return out
}
