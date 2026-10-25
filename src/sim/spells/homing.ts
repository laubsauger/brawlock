/**
 * Homing (spells.md §8.7). Rebuilt as clearly intended (the original file failed to parse).
 * Spawns at caster + 64 dir with speed 800 + the caster's forward speed, r30, lifetime 4.5 x rm.
 * Target: enemy pawn nearest the cursor at cast; re-acquired (nearest enemy to the bolt) when
 * missing, dead or no longer an enemy of the (possibly new, Shield) owner. Steering per original
 * 0.035 s tick: v = 0.97 v + 0.03 (1000 unit(target - pos)), converted to our tick rate.
 * init -1, std + SELF{PLAYER}:
 * - enemy pawn: damage, kb 1.0, destroyed
 * - own caster: self-detonation, AoE r292 (0 -> damage, kb 0.9) on the caster's enemies and the
 *   caster gets +50 move speed for 4 s x dm (+120 "burnout" while thrusting), destroyed
 * - obstacle: damages it, destroyed;  enemy projectile: destroyed without damaging it
 */
import { HOMING_CC } from '../collision'
import { damageArea, damageObstacle, destroyProjectile, receiveDamage } from '../combat'
import { ORIGINAL_TICK_SCALE, ticks } from '../config'
import { pow } from '../math'
import { addModifier, hasModifier, type ModifierBehavior } from '../modifiers'
import { ownerPawn, spawnProjectile } from '../projectiles'
import { buffDuration } from '../stats'
import { isEnemy } from '../teams'
import { onTickRate, type PawnState, type PlayerId, type SimState } from '../types'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr } from './util'

/** 0.97 per original tick, as a per-sim-tick factor */
let KEEP = 0
onTickRate(() => { KEEP = pow(0.97, ORIGINAL_TICK_SCALE) })

export const MOD_HOMING_HASTE = 'homingHaste'

function nearestEnemy(state: SimState, owner: PlayerId, x: number, y: number): PawnState | null {
  let best: PawnState | null = null
  let bd = Infinity
  for (const p of state.pawns) {
    if (!p.alive || !isEnemy(state, owner, p.owner)) continue
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y)
    if (d < bd) {
      bd = d
      best = p
    }
  }
  return best
}

export const homingSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const offset = attr(def, 'spawn_offset', level)
    const speed = attr(def, 'launch_speed', level) + (caster.vx * a.dx + caster.vy * a.dy)
    const target = nearestEnemy(state, caster.owner, ctx.x, ctx.y)
    spawnProjectile(state, caster.owner, 'homing', caster.x + a.dx * offset, caster.y + a.dy * offset, a.dx * speed, a.dy * speed, attr(def, 'radius', level), {
      level,
      lifetime: attr(def, 'range', level) / attr(def, 'speed', level),
      data: {
        damage: castAttr(ctx, 'damage'),
        target: target ? target.id : -1,
        cruise: attr(def, 'speed', level),
        selfRadius: attr(def, 'self_radius', level),
        selfKb: attr(def, 'self_kb', level),
        haste: attr(def, 'self_speed_bonus', level),
        burnout: attr(def, 'self_speed_bonus_thrust', level),
        hasteTime: attr(def, 'self_buff_duration', level),
      },
    })
  },
}

export const homingHasteModifier: ModifierBehavior = { temporary: true }

export const homingProjectile: ProjectileBehavior = {
  collider: HOMING_CC,
  onTick(state, p) {
    let t = state.pawns.find((q) => q.id === p.data.target)
    if (!t || !t.alive || !isEnemy(state, p.owner, t.owner)) {
      t = nearestEnemy(state, p.owner, p.x, p.y) ?? undefined
      p.data.target = t ? t.id : -1
    }
    if (!t) return
    const dx = t.x - p.x
    const dy = t.y - p.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (!(d > 0)) return
    const c = p.data.cruise
    p.vx = KEEP * p.vx + (1 - KEEP) * ((c * dx) / d)
    p.vy = KEEP * p.vy + (1 - KEEP) * ((c * dy) / d)
  },
  onCollide(state, p, hit) {
    const o = hit.other
    if (o.kind === 'pawn') {
      if (o.pawn.owner === p.owner) {
        // self-detonation
        state.events.push({ type: 'explosion', x: p.x, y: p.y, radius: p.data.selfRadius, spell: 'homing', level: p.level })
        damageArea(state, p.owner, p.x, p.y, p.data.selfRadius, { amountMin: 0, amountMax: p.data.damage, knockbackFactor: p.data.selfKb, cause: 'homing' })
        const caster = ownerPawn(state, p)
        if (caster && caster.alive) {
          const burnout = hasModifier(caster, 'thrust')
          addModifier(state, caster, MOD_HOMING_HASTE, ticks(buffDuration(state, caster, caster.owner, p.data.hasteTime)), caster.owner, {
            speed: burnout ? p.data.burnout : p.data.haste,
            burnout: burnout ? 1 : 0,
          })
        }
      } else {
        receiveDamage(state, o.pawn, { amount: p.data.damage, source: p.owner, normal: { x: hit.nx, y: hit.ny }, cause: 'homing' })
      }
    } else if (o.kind === 'obstacle') {
      damageObstacle(state, o.obstacle, p.data.damage, p.owner)
    }
    destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
  },
}
