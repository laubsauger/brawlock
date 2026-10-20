/**
 * Lightning (spells.md §8.6). Instant hitscan, length 600 x rm, half-width 25.
 * Candidate CCs: (Lightning accepts the channel for that alliance — ENEMY {PLAYER, PROJECTILE,
 * OBSTACLE} — AND the CC accepts PROJECTILE from that alliance AND it is not a Warpzone) OR it is
 * an own / allied Fireball. Hit-testable when |perpendicular distance of its centre| <= 25 + r
 * and its centre lies 0 < s < best ahead; the nearest wins. A warlock's bubble (Alteration) and
 * body share one centre, so on equal distance the larger CC wins: the bubble blocks, as the docs
 * require (the original's tie order was table iteration order).
 * - own / allied Fireball: detonates (r225, full damage within r100, kb 1.35).
 *   Brawlock balance change: peak is 2/3 (Lightning + Fireball launch damage), then falls to 0
 *   from r100 to r225; the reference instead used fixed 70 and fell off from the centre.
 * - CC accepts damage: damage along the BEAM direction, knockback factor 0.92
 * - enemy Shield / Alteration bubble: the beam stops there with no effect
 */
import { BIT_OBSTACLE, BIT_PLAYER, BIT_PROJECTILE } from '../collision'
import { damageArea, damageObstacle, destroyProjectile, receiveDamage } from '../combat'
import { type Body, collectBodies } from '../physics'
import { damageProjectile, kindOf } from '../projectiles'
import { rangeFactor } from '../stats'
import { ALLIANCE_ENEMY, alliance } from '../teams'
import { attr } from './data'
import type { SpellBehavior } from './types'
import { aim, castAttr } from './util'

const LIGHTNING_ENEMY_MASK = BIT_PLAYER | BIT_PROJECTILE | BIT_OBSTACLE
const FIREBALL_FULL_DAMAGE_RADIUS = 100

export const lightningSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const max = attr(def, 'range', level) * rangeFactor(state, caster.owner)
    const half = attr(def, 'beam_radius', level)
    let best = max
    let winner: Body | null = null
    let winnerIsFireball = false
    for (const b of collectBodies(state)) {
      const al = alliance(state, caster.owner, b.owner)
      const isFireball = b.ref.kind === 'projectile' && kindOf(b.ref.proj) === 'fireball'
      const warpzone = b.ref.kind === 'projectile' && kindOf(b.ref.proj) === 'warpzone'
      const accepts =
        al === ALLIANCE_ENEMY &&
        (LIGHTNING_ENEMY_MASK & (1 << b.cc.channel)) !== 0 &&
        (b.cc.mat[al] & BIT_PROJECTILE) !== 0 &&
        !warpzone
      const friendlyFireball = al !== ALLIANCE_ENEMY && isFireball
      if (!accepts && !friendlyFireball) continue
      const rx = b.k.x - caster.x
      const ry = b.k.y - caster.y
      const s = rx * a.dx + ry * a.dy
      const perp = Math.abs(rx * a.dy - ry * a.dx)
      const better = s < best || (winner !== null && s === best && b.radius > winner.radius)
      if (perp <= half + b.radius && s > 0 && better) {
        best = s
        winner = b
        winnerIsFireball = friendlyFireball
      }
    }
    const damage = castAttr(ctx, 'damage')
    let blocked = false
    if (winner) {
      const r = winner.ref
      if (winnerIsFireball && r.kind === 'projectile') {
        const fb = r.proj
        const radius = attr(def, 'fb_radius', level)
        state.events.push({ type: 'explosion', x: fb.x, y: fb.y, radius, spell: 'lightning', level })
        destroyProjectile(state, fb, null)
        damageArea(state, caster.owner, fb.x, fb.y, radius, {
          amountMin: 0,
          amountMax: (2 / 3) * (damage + fb.data.damage),
          fullDamageRadius: FIREBALL_FULL_DAMAGE_RADIUS,
          knockbackFactor: attr(def, 'fb_knockback_factor', level),
          cause: 'lightning',
        })
      } else if (winner.cc.acceptDamage) {
        if (r.kind === 'pawn') {
          receiveDamage(state, r.pawn, { amount: damage, source: caster.owner, normal: { x: a.dx, y: a.dy }, knockbackFactor: attr(def, 'knockback_factor', level), cause: 'lightning' })
        } else if (r.kind === 'projectile') damageProjectile(state, r.proj, null)
        else damageObstacle(state, r.obstacle, damage, caster.owner)
      } else {
        blocked = true
      }
    }
    state.events.push({
      type: 'beam',
      spell: 'lightning',
      owner: caster.owner,
      fromX: caster.x,
      fromY: caster.y,
      toX: caster.x + a.dx * best,
      toY: caster.y + a.dy * best,
      target: winner ? winner.id : null,
      blocked,
      level,
    })
  },
}
