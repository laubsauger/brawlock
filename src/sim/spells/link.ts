/**
 * Link (spells.md §8.28). Tether bolt 950 u/s, r35, no lifetime: flies for 860 x rm / 950 s
 * (actor timer), then retracts to the caster (destroyed within 75, or at once if the caster
 * dies). init -1, ALLY{PLAYER}, ENEMY{PLAYER, OBSTACLE}; never touches projectiles; Gravity
 * ignores it; a Shield reflects it without stealing it.
 * On a warlock: the CASTER gets a 'link' modifier pulling that warlock toward the caster at
 * 1550 u/s^2 (enemies also take DPS every 0.2 s, no knockback). On a pillar: the caster is
 * pulled toward the pillar. No max duration; it breaks when the linked warlock dies or has
 * Shield / Rush, within 100 (120 for a pillar), when the pillar is gone, when the caster casts
 * Teleport / Swap with the cursor on lava (pawn links only), on the caster's death or a round reset.
 */
import { LINK_CC } from '../collision'
import { destroyProjectile, receiveDamage } from '../combat'
import { isLocationSafe } from '../arena'
import { ticks } from '../config'
import { type ModifierBehavior, addModifier, hasModifier, removeModifier } from '../modifiers'
import { killProjectile, ownerPawn, spawnProjectile } from '../projectiles'
import { rangeFactor } from '../stats'
import { isEnemy } from '../teams'
import { DT } from '../types'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr } from './util'

export const MOD_LINK = 'link'

export const linkSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const speed = attr(def, 'speed', level)
    spawnProjectile(state, caster.owner, 'link', caster.x, caster.y, a.dx * speed, a.dy * speed, attr(def, 'radius', level), {
      level,
      lifetime: null,
      data: {
        speed,
        t: 0,
        retractAt: (attr(def, 'range', level) * rangeFactor(state, caster.owner)) / speed,
        retracting: 0,
        returnDist: attr(def, 'return_dist', level),
        dps: castAttr(ctx, 'damage'),
        pull: attr(def, 'pull_accel', level),
        breakDist: attr(def, 'break_dist', level),
        breakDistObstacle: attr(def, 'break_dist_obstacle', level),
        dpsPeriod: ticks(attr(def, 'dps_period', level)),
      },
    })
  },
}

export const linkProjectile: ProjectileBehavior = {
  collider: LINK_CC,
  noGravity: true,
  onTick(state, p, dt) {
    const caster = ownerPawn(state, p)
    if (!caster || !caster.alive) {
      killProjectile(state, p)
      return
    }
    const d = p.data
    if (!d.retracting) {
      d.t += dt
      if (d.t >= d.retractAt) d.retracting = 1
    }
    if (d.retracting) {
      const dx = caster.x - p.x
      const dy = caster.y - p.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < d.returnDist) {
        killProjectile(state, p)
        return
      }
      p.vx = (dx / dist) * d.speed
      p.vy = (dy / dist) * d.speed
    }
  },
  onCollide(state, p, hit) {
    const caster = ownerPawn(state, p)
    const o = hit.other
    const d = p.data
    if (caster && caster.alive && (o.kind === 'pawn' || o.kind === 'obstacle')) {
      const isPawn = o.kind === 'pawn'
      const enemy = isPawn && isEnemy(state, p.owner, o.pawn.owner)
      addModifier(state, caster, MOD_LINK, -1, caster.owner, {
        target: hit.otherId,
        obstacle: isPawn ? 0 : 1,
        dps: enemy ? d.dps : 0,
        pull: d.pull,
        breakDist: isPawn ? d.breakDist : d.breakDistObstacle,
        dpsPeriod: d.dpsPeriod,
        dpsTimer: d.dpsPeriod,
      })
    }
    destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
  },
}

export const linkModifier: ModifierBehavior = {
  temporary: true,
  onPreTick(state, caster, mod) {
    const d = mod.data
    const target = d.obstacle ? state.obstacles.find((o) => o.id === d.target && o.hp > 0) : state.pawns.find((q) => q.id === d.target)
    const pawnTarget = !d.obstacle ? state.pawns.find((q) => q.id === d.target) : undefined
    if (!target || (pawnTarget && (!pawnTarget.alive || hasModifier(pawnTarget, 'shield') || hasModifier(pawnTarget, 'rush')))) {
      removeModifier(state, caster, mod)
      return
    }
    const dx = target.x - caster.x
    const dy = target.y - caster.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < d.breakDist) {
      removeModifier(state, caster, mod)
      return
    }
    const a = d.pull * DT
    if (pawnTarget) {
      pawnTarget.vx -= (dx / dist) * a
      pawnTarget.vy -= (dy / dist) * a
      if (d.dps > 0) {
        d.dpsTimer -= 1
        if (d.dpsTimer <= 0) {
          d.dpsTimer += d.dpsPeriod
          receiveDamage(state, pawnTarget, { amount: d.dps * (d.dpsPeriod / 60), source: caster.owner, cause: 'link' })
        }
      }
    } else {
      caster.vx += (dx / dist) * a
      caster.vy += (dy / dist) * a
    }
  },
  onSpellCast(state, caster, mod, ctx) {
    if (mod.data.obstacle) return
    const id = ctx.def.id
    if ((id === 'teleport' || id === 'swap') && !isLocationSafe(state, ctx.x, ctx.y)) removeModifier(state, caster, mod)
  },
}
