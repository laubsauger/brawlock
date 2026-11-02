/**
 * Wild (docs/moonshot/specs/wild.md): each omen's ambient layer and the reactions' flourish.
 * Scene effects only: the approved arena lighting is untouched (no sky, fog or light changes).
 * - Blood Moon: crimson motes drift down over the arena; every push throws red streaks
 * - Slick Stone: wet glints wink on the tiles; a sliding warlock throws a pale spray
 * - Overcharge: violet sparks crackle at every warlock's hands
 * - Sudden Collapse: grit and dust shake loose at the crumbling rim
 * - Meteor Shower: embers fall from the sky between the meteors
 * - Pillar Storm: dust motes rise from the floor (its warned spots: rockpillar.ts)
 * - Shatter / Nova / Fork: a flash and a ring where the spells met
 * Not a spell: the id 'wild' never appears on an event or projectile, so it claims nothing.
 */
import { layerRadius } from '../../../sim/arena'
import type { OmenId } from '../../../sim/wild'
import type { SimEvent } from '../../../sim/types'
import { TILE_TOP_H } from '../../coords'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import { TAU, floorH, rand } from './kitB'

type RGB = readonly [number, number, number]
const CRIMSON: RGB = [2.4, 0.22, 0.12]
const GLINT: RGB = [1.8, 2.4, 3.0]
const VIOLET: RGB = [1.5, 0.8, 2.8]
const GRIT: RGB = [0.16, 0.12, 0.09]
const EMBER: RGB = [2.6, 0.9, 0.2]
const DUST: RGB = [0.22, 0.18, 0.14]
const REACTION: Record<string, RGB> = { shatter: [1.2, 2.0, 2.8], nova: [2.8, 1.1, 0.3], fork: [1.6, 1.5, 2.9] }

/** whole spawns this frame for a rate per second, scaled by the effects setting and tier budget */
function count(ctx: VfxCtx, perSecond: number, pool = ctx.particles): number {
  return pool.budget(perSecond * ctx.dt * ctx.fx)
}

/** a random point on the arena floor (or inside its rim band when `rim` is set) */
function spot(radius: number, rim = 0): { x: number; y: number } {
  const a = Math.random() * TAU
  const r = rim > 0 ? radius - Math.random() * rim : Math.sqrt(Math.random()) * radius
  return { x: Math.cos(a) * r, y: Math.sin(a) * r }
}

function ambient(ctx: VfxCtx, omen: OmenId, radius: number): void {
  const st = ctx.state!
  switch (omen) {
    case 'bloodMoon':
      for (let i = count(ctx, 70); i > 0; i--) {
        const p = spot(radius)
        ctx.particles.spawn(p.x, p.y, TILE_TOP_H + rand(250, 650), rand(-25, 25), rand(-25, 25), rand(-110, -60), rand(2.5, 4), rand(14, 22), 4, CRIMSON[0], CRIMSON[1], CRIMSON[2], 0, 0.1, 30)
      }
      break
    case 'slickStone':
      for (let i = count(ctx, 150); i > 0; i--) {
        const p = spot(radius)
        ctx.particles.spawn(p.x, p.y, TILE_TOP_H + 16, 0, 0, 12, rand(0.35, 0.7), rand(24, 36), 6, GLINT[0], GLINT[1], GLINT[2], 0, 0.5, 0)
      }
      for (const pw of st.pawns) {
        if (!pw.alive) continue
        const sx = pw.vx - pw.walkVx
        const sy = pw.vy - pw.walkVy
        const sp = Math.hypot(sx, sy)
        if (sp < 260) continue
        for (let i = count(ctx, 50 + sp / 12); i > 0; i--) {
          ctx.particles.spawn(pw.x + rand(-20, 20), pw.y + rand(-20, 20), TILE_TOP_H + 4, -sx * 0.25 + rand(-60, 60), -sy * 0.25 + rand(-60, 60), rand(60, 160), rand(0.3, 0.5), rand(12, 18), 4, GLINT[0] * 0.7, GLINT[1] * 0.7, GLINT[2] * 0.7, -900, 1.5, -0.02)
        }
      }
      break
    case 'overcharge':
      for (const pw of st.pawns) {
        if (!pw.alive) continue
        const info = ctx.pawn(pw.id)
        if (!info) continue
        for (let i = count(ctx, 45); i > 0; i--) {
          const a = Math.random() * TAU
          ctx.particles.spawn(info.x + Math.cos(a) * 28, info.y + Math.sin(a) * 28, info.h + rand(50, 130), Math.cos(a) * rand(80, 200), Math.sin(a) * rand(80, 200), rand(40, 200), rand(0.18, 0.32), rand(10, 15), 3, VIOLET[0], VIOLET[1], VIOLET[2], -400, 3, -0.03)
        }
      }
      break
    case 'suddenCollapse':
      for (let i = count(ctx, 70, ctx.debris); i > 0; i--) {
        const p = spot(radius, 90)
        ctx.debris.spawn(p.x, p.y, TILE_TOP_H + rand(2, 12), 0, 0, rand(120, 280), rand(0.5, 0.8), rand(9, 15), 5, GRIT[0], GRIT[1], GRIT[2], -1500, 0, 0)
      }
      for (let i = count(ctx, 14, ctx.smoke); i > 0; i--) {
        const p = spot(radius, 60)
        ctx.smoke.spawn(p.x, p.y, TILE_TOP_H + 8, 0, 0, rand(20, 50), rand(1, 1.6), 30, 70, DUST[0], DUST[1], DUST[2], -5, 1.5, 0)
      }
      break
    case 'meteorShower':
      for (let i = count(ctx, 45); i > 0; i--) {
        const p = spot(radius * 1.1)
        ctx.particles.spawn(p.x, p.y, TILE_TOP_H + rand(700, 1100), rand(-140, -60), rand(-60, 60), rand(-800, -550), rand(1.2, 1.8), rand(14, 20), 6, EMBER[0], EMBER[1], EMBER[2], -300, 0, -0.04)
      }
      break
    case 'pillarStorm':
      for (let i = count(ctx, 22, ctx.smoke); i > 0; i--) {
        const p = spot(radius)
        ctx.smoke.spawn(p.x, p.y, TILE_TOP_H + 6, rand(-10, 10), rand(-10, 10), rand(25, 60), rand(1.4, 2.2), 30, 80, DUST[0], DUST[1], DUST[2], 0, 1, 20)
      }
      break
  }
}

registerSpellVfx({
  spell: 'wild',
  onEvent(e: SimEvent, ctx: VfxCtx): void {
    if (e.type === 'reaction') {
      const c = REACTION[e.reaction]
      const fh = floorH(ctx, e.x, e.y)
      // inside the smallest blast a reaction makes (Nova's is 200 at the lowest levels)
      ctx.flash(e.x, e.y, fh + 70, 0.22, 170, 220, c[0], c[1], c[2])
      ctx.ground.spawn(RING_EXPAND, e.x, e.y, fh, 30, 170, 0.35, 10, c[0], c[1], c[2])
      return
    }
    // Blood Moon: a push throws red streaks off the victim
    if (e.type === 'damage' && e.kb > 200 && ctx.state?.omen === 'bloodMoon') {
      const pw = ctx.state.pawns.find((p) => p.id === e.target)
      if (!pw) return
      const sp = Math.hypot(pw.vx, pw.vy) || 1
      const dx = pw.vx / sp
      const dy = pw.vy / sp
      for (let i = ctx.particles.budget(10 * ctx.fx); i > 0; i--) {
        const s = rand(300, 700)
        ctx.particles.spawn(e.x, e.y, TILE_TOP_H + rand(40, 110), dx * s + rand(-80, 80), dy * s + rand(-80, 80), rand(0, 120), rand(0.25, 0.45), rand(8, 13), 2, CRIMSON[0], CRIMSON[1], CRIMSON[2], -600, 2, -0.05)
      }
    }
  },
  frame(ctx: VfxCtx): void {
    const st = ctx.state
    if (!st?.omen || ctx.dt <= 0) return
    if (st.phase !== 'shop' && st.phase !== 'fight') return
    ambient(ctx, st.omen, layerRadius(st.arena.layer))
  },
})
