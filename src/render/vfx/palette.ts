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
  fireball: { core: 0xfff1b8, accent: 0xd8261a, note: 'fire spectrum: yellow-white core, crimson rim' },
  boomerang: { core: 0xffb08a, accent: 0xa8431f, note: 'red-copper, mid value' },
  lightning: { core: 0xf2f8ff, accent: 0x5aa9ff, note: 'electric white-blue, brightest' },
  homing: { core: 0xff7ad0, accent: 0xd1124f, note: 'magenta-red, bright' },
  twin: { core: 0xffe08a, accent: 0xe08a12, note: 'gold-orange, lighter than lava' },
  // column 2: transport
  teleport: { core: 0xd8fbff, accent: 0x18c8e8, note: 'cyan' },
  thrust: { core: 0xfff0d0, accent: 0xb07a3a, note: 'dusty bronze shock' },
  swap: { core: 0xe6d8ff, accent: 0x7b4dff, note: 'violet with cyan edge' },
  // column 3
  cluster: { core: 0xffe6a0, accent: 0xd99a1e, note: 'amber, desaturated vs twin' },
  drain: { core: 0xc8f7a0, accent: 0x3f7d16, note: 'sickly green, dark' },
  bouncer: { core: 0xfffcb0, accent: 0xe6d21a, note: 'pure yellow, very light' },
  recharge: { core: 0xe9c8ff, accent: 0x7a2fd1, note: 'purple' },
  // column 4
  windwalk: { core: 0xffffff, accent: 0xb9c2cc, note: 'pale grey-white, low saturation' },
  meteor: { core: 0xffd6f0, accent: 0x6a1fb5, note: 'deep violet fire' },
  splitter: { core: 0xffb3ff, accent: 0xc21fbf, note: 'magenta' },
  snowball: { core: 0xf0fbff, accent: 0x7cc8ff, note: 'ice blue, light' },
  // column 5
  shield: { core: 0xfff8de, accent: 0xf0c53c, note: 'gold-white' },
  rush: { core: 0xfff0a8, accent: 0xff9a1f, note: 'flame orange-gold, lighter/yellower than lava' },
  alteration: { core: 0xffffff, accent: 0x9fb2c2, note: 'silver glass' },
  gravity: { core: 0xb48cff, accent: 0x1a0b2e, note: 'black-violet lensing, darkest' },
  // column 6
  grip: { core: 0xd8ff8a, accent: 0x6fbf00, note: 'toxic green, bright' },
  warpzone: { core: 0xb8fff2, accent: 0x0c9c8c, note: 'teal' },
  magnetize: { core: 0xd0e4ff, accent: 0x4a6f9c, note: 'steel blue, mid-dark' },
  rockpillar: { core: 0xd9c2a0, accent: 0x6b5a44, note: 'earth' },
  link: { core: 0xcfffcf, accent: 0x2f9c4a, note: 'chain green' },
  // items / default spells
  scourge: { core: 0xff5a6e, accent: 0x5a0010, note: 'blood crimson over black' },
  redirect: { core: 0xffffff, accent: 0xa0a0ff, note: 'pale periwinkle' },
  pact: { core: 0xffd0d0, accent: 0x8a0f2a, note: 'dark wine' },
}

/** Fallback for unknown ids: neutral arcane lilac. */
export const DEFAULT_PALETTE: SpellPalette = { core: 0xf0e8ff, accent: 0x8f7ad8, note: 'fallback' }

/** Strip level / item prefixes: 'scourge3', 'item_warlock_fireball2' -> base id. */
export function baseSpellId(id: string): string {
  const s = id.replace(/^item_warlock_/, '').replace(/^warlock_/, '')
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
