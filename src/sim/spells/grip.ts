/**
 * Grip (spells.md §8.24). Bolt 1000 u/s, r39, lifetime 1.1 s x rm, std collision, no damage.
 * Enemy hit: walk velocity zeroed (knockback kept), Stop() (cancels their cast), then a root for
 * duration x their debuff factor x caster dm: -10000 move speed, takes only 33% knockback
 * (kb_reduction 0.67), +5 DP for every spell they cast meanwhile (casting stays allowed).
 * Anything else: the bolt just dies.
 */
import { STD_PROJECTILE } from '../collision'
import { destroyProjectile } from '../combat'
import { ticks } from '../config'
import { type ModifierBehavior, addModifier } from '../modifiers'
import { clearWalk, stopPawn } from '../orders'
import { spawnProjectile } from '../projectiles'
import { debuffDuration } from '../stats'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim } from './util'

export const MOD_GRIP = 'grip'

export const gripSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const speed = attr(def, 'speed', level)
    spawnProjectile(state, caster.owner, 'grip', caster.x, caster.y, a.dx * speed, a.dy * speed, attr(def, 'radius', level), {
      level,
      lifetime: attr(def, 'lifetime', level),
      data: {
        duration: attr(def, 'duration', level),
        dpGain: attr(def, 'dp_gain', level),
        kbReduction: attr(def, 'kb_reduction', level),
        speed: attr(def, 'speed_bonus', level),
      },
    })
  },
}

export const gripProjectile: ProjectileBehavior = {
  collider: STD_PROJECTILE,
  onCollide(state, p, hit) {
    const o = hit.other
    if (o.kind === 'pawn') {
      const t = o.pawn
      const d = p.data
      clearWalk(t)
      stopPawn(state, t)
      addModifier(state, t, MOD_GRIP, ticks(debuffDuration(state, t, p.owner, d.duration)), p.owner, {
        speed: d.speed,
        kbReduction: d.kbReduction,
        dpGain: d.dpGain,
      })
    }
    destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
  },
}

export const gripModifier: ModifierBehavior = {
  temporary: true,
  onSpellCast(_s, pawn, mod) {
    pawn.kbPoints += mod.data.dpGain
  },
}
