/**
 * Spell VFX plugin registry. Spell visual modules live in
 * src/render/vfx/spells/** (owned by the VFX workstreams) and register
 * themselves from src/render/vfx/spells/index.ts.
 *
 * Contract (match worlds only; the menu backdrop uses the built-ins):
 * - onEvent: called for EVERY SimEvent the world consumes (deduped by tick
 *   via the world's event cursor), in tick order. Built-in handling for an
 *   event is skipped when the event's `spell` is claimed by a module
 *   (module.spell or module.kinds), or when any onEvent returns true.
 * - drawProjectile: called every frame for each live projectile whose `spell`
 *   is claimed (module.spell or module.kinds), with the interpolated game
 *   position; the built-in projectile look is not drawn for it.
 * - drawModifier: called every frame for each pawn modifier whose id is in
 *   module.modifiers (alive pawns only), with the pawn's interpolated position.
 * - frame: called once per frame after events, before projectiles.
 * - init / dispose: a world calls init(ctx) before first use and dispose()
 *   when it is torn down (tier change, leaving the match). Modules must drop
 *   any three objects they created in dispose() and rebuild lazily on init.
 *
 * Timing: use ctx.now (world clock, seconds; it freezes during hit-stop and
 * drives every shader-animated system) and ctx.dt. Never keep your own
 * wall clock for gameplay-relevant visuals: windups, releases and impacts
 * come from state and events.
 */
import type * as THREE from 'three/webgpu'
import type { Quality } from '../../game/store'
import type { EntityId, ModifierState, PawnState, ProjectileState, SimEvent, SimState } from '../../sim/types'
import type { TierConfig } from '../quality'
import type { Billboards } from '../scene/Billboards'
import type { ContactShadows } from '../scene/ContactShadows'
import type { GroundFx } from '../scene/GroundFx'
import type { Particles } from '../scene/Particles'
import type { Scorches } from '../scene/Scorches'
import type { GlowLights, WorldCtx } from '../scene/world'

export interface PawnRenderInfo {
  /** interpolated game position */
  x: number
  y: number
  /** current floor height under the pawn (game units; tile top or sunk in lava) */
  h: number
  /** team colour 0xRRGGBB */
  color: number
  owner: number
  alive: boolean
  onLava: boolean
  /** staff crystal tip, three world units (for cast flares) */
  tip: THREE.Vector3
}

export interface VfxCtx {
  /** world clock, seconds (freezes during hit-stop; particles/rings are timed by it) */
  readonly now: number
  /** frame delta, seconds (0 during hit-stop) */
  readonly dt: number
  /** current authoritative snapshot (frame.curr), null before the first one */
  readonly state: SimState | null
  /** previous snapshot, for your own interpolation */
  readonly prev: SimState | null
  /** interpolation factor prev -> curr this frame */
  readonly alpha: number
  /** local player id, -1 = spectator (e.g. Windwalk ghosting for own pawn) */
  readonly localPlayer: number
  /** settings.fxIntensity 0..1 (scale shake, flashes, optional extras) */
  readonly fx: number
  readonly quality: Quality
  readonly tier: TierConfig
  /** parent for persistent objects you create (remove them in dispose) */
  readonly scene: THREE.Group
  readonly camera: THREE.PerspectiveCamera
  /** shared uniforms/textures: uTime, noise texture, arena SDF field */
  readonly world: WorldCtx

  /** additive GPU particles (fire, sparks, embers; streaks via negative sway) */
  readonly particles: Particles
  /** soft alpha smoke */
  readonly smoke: Particles
  /** opaque chips (stone, debris) */
  readonly debris: Particles
  /** per-frame glow sprites: call add()/addStreak() EVERY frame you want them */
  readonly billboards: Billboards
  /** ground ring decals (RING_EXPAND / RING_IMPLODE / RING_CHEVRON from scene/GroundFx) */
  readonly ground: GroundFx
  /** same shapes as dark soft shadows (under lifted markers) */
  readonly groundShadow: GroundFx
  /** fading burn marks on tiles */
  readonly scorches: Scorches
  /** per-frame contact shadow discs */
  readonly contact: ContactShadows
  /** per-frame fake point lights on floor and pawns (max GLOW_N per frame, shared) */
  readonly glow: GlowLights

  /** pawn render info by pawn entity id (interpolated), null if unknown */
  pawn(id: EntityId): PawnRenderInfo | null
  /** pawn render info by owner player id */
  pawnOf(owner: number): PawnRenderInfo | null
  /** team colour of a player */
  colorOf(owner: number): number
  /** floor height at a game position: tile top, or the lava surface */
  floorAt(x: number, y: number): number
  /** true when (x, y) is over lava */
  isLava(x: number, y: number): boolean
  /** game (x, y, h) -> three world position */
  toWorld(x: number, y: number, h: number, out?: THREE.Vector3): THREE.Vector3

  /** transient flash: billboard + floor light, `life` seconds */
  flash(x: number, y: number, h: number, life: number, radius: number, size: number, r: number, g: number, b: number): void
  /** camera trauma (0..1), scaled by fxIntensity internally */
  shake(amount: number): void
  /** shake only if (x, y) is near the camera focus */
  shakeNear(x: number, y: number, amount: number): void
  /** directional camera shove (game units/s along dx, dy) */
  kick(dx: number, dy: number, amount: number): void
  /** request hit-stop (seconds, capped); use for big hits on the local pawn */
  hitStop(seconds: number): void
}

export interface SpellVfx {
  /** spell id this module illustrates (claims events/projectiles with this spell) */
  spell: string
  /** extra projectile spell/kind ids it draws (replaces the generic projectile look) */
  kinds?: string[]
  /** pawn modifier ids it draws */
  modifiers?: string[]
  init?(ctx: VfxCtx): void
  /** return true to suppress built-in handling for this event */
  onEvent?(e: SimEvent, ctx: VfxCtx): boolean | void
  drawProjectile?(p: ProjectileState, x: number, y: number, ctx: VfxCtx): void
  drawModifier?(pawn: PawnState, mod: ModifierState, x: number, y: number, ctx: VfxCtx): void
  frame?(ctx: VfxCtx): void
  dispose?(): void
}

const modules: SpellVfx[] = []

/** Register a spell VFX module (call at import time from vfx/spells/index.ts). */
export function registerSpellVfx(mod: SpellVfx): void {
  const i = modules.findIndex((m) => m.spell === mod.spell)
  if (i >= 0) modules[i] = mod // HMR / re-registration replaces
  else modules.push(mod)
}

export function spellVfxModules(): readonly SpellVfx[] {
  return modules
}

/** Module claiming a projectile/event spell id, if any. */
export function vfxForSpell(spell: string): SpellVfx | undefined {
  for (const m of modules) {
    if (m.spell === spell) return m
    if (m.kinds && m.kinds.includes(spell)) return m
  }
  return undefined
}

/** Module drawing a modifier id, if any. */
export function vfxForModifier(id: string): SpellVfx | undefined {
  for (const m of modules) if (m.modifiers && m.modifiers.includes(id)) return m
  return undefined
}
