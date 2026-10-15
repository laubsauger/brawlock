/**
 * Bouncer (spells.md §8.14). Speed 900, r38, TTL 1 s x rm, restarted (x rm) after every pawn
 * bounce. init -1: SELF/ALLY{PLAYER}, ENEMY{PLAYER, PROJECTILE, OBSTACLE}; ignores `prevHit`
 * (the caster at launch).
 * On a pawn != prevHit: enemy -> damage (kb 1.2) then damage x 0.7; while damage >= 10 it
 * retargets the closest living pawn of ANY alliance (caster included) except the one just hit,
 * with an intercept course; allies / self do not decay it. Below 10 it dies.
 * Obstacle: reflect (no TTL reset). Enemy projectile: the Bouncer dies, the other is unharmed.
 */
import { BOUNCER_CC } from '../collision'
import { destroyProjectile, receiveDamage } from '../combat'
import { bounceOff, setLifetime, spawnProjectile } from '../projectiles'
import { isEnemy } from '../teams'
import type { PawnState, ProjectileState, SimState } from '../types'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr } from './util'

export const bouncerSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const speed = attr(def, 'speed', level)
    spawnProjectile(state, caster.owner, 'bouncer', caster.x, caster.y, a.dx * speed, a.dy * speed, attr(def, 'radius', level), {
      lifetime: attr(def, 'ttl', level),
      data: {
        damage: castAttr(ctx, 'damage'),
        kb: attr(def, 'knockback_factor', level),
        decay: attr(def, 'damage_decay', level),
        minDamage: attr(def, 'min_damage', level),
        ttl: attr(def, 'ttl', level),
        speed,
        prevHit: caster.id,
        hits: 0,
      },
    })
  },
}

/** Aim at `t` on an intercept course (original solver, result not re-normalised). */
function retarget(p: ProjectileState, t: PawnState, speed: number): void {
  const dx = p.x - t.x
  const dy = p.y - t.y
  const a = dx * t.vx + dy * t.vy
  const b = t.vx * t.vx + t.vy * t.vy - speed * speed
  const c = dx * dx + dy * dy
  const disc = a * a - b * c
  let time = -1
  if (disc >= 0 && b !== 0) {
    const sq = Math.sqrt(disc)
    const t1 = (a + sq) / b
    const t2 = (a - sq) / b
    time = t1 >= 0 ? t1 : t2 >= 0 ? t2 : -1
  }
  if (time > 0) {
    p.vx = (t.vx * time - dx) / time
    p.vy = (t.vy * time - dy) / time
  } else {
    const l = Math.sqrt(c)
    if (l > 0) {
      p.vx = (-dx / l) * speed
      p.vy = (-dy / l) * speed
    }
  }
}

function closestOther(state: SimState, p: ProjectileState, exclude: number): PawnState | null {
  let best: PawnState | null = null
  let bd = Infinity
  for (const q of state.pawns) {
    if (!q.alive || q.id === exclude) continue
    const d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y)
    if (d < bd) {
      bd = d
      best = q
    }
  }
  return best
}

export const bouncerProjectile: ProjectileBehavior = {
  collider: BOUNCER_CC,
  onCollide(state, p, hit) {
    const o = hit.other
    const d = p.data
    if (o.kind === 'obstacle') {
      bounceOff(state, p, hit)
      return
    }
    if (o.kind === 'projectile') {
      destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
      return
    }
    const target = o.pawn
    if (target.id === d.prevHit) return
    if (isEnemy(state, p.owner, target.owner)) {
      receiveDamage(state, target, { amount: d.damage, source: p.owner, normal: { x: hit.nx, y: hit.ny }, knockbackFactor: d.kb, cause: 'bouncer' })
      d.damage *= d.decay
      d.hits += 1
    }
    d.prevHit = target.id
    if (d.damage < d.minDamage) {
      destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
      return
    }
    const next = closestOther(state, p, target.id)
    if (next) retarget(p, next, d.speed)
    setLifetime(state, p, d.ttl)
    state.events.push({ type: 'projectileBounce', id: p.id, spell: p.spell, x: hit.x, y: hit.y })
  },
}
