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
 * Wild (sim/wild.ts) adds two reactions: a Snowball the beam meets (any owner) shatters into four
 * shards (Shatter), and a beam stopped by an enemy Shield forks back as two weaker beams (Fork).
 */
import { BIT_OBSTACLE, BIT_PLAYER, BIT_PROJECTILE } from '../collision'
import { damageArea, damageObstacle, destroyProjectile, receiveDamage } from '../combat'
import { type Body, collectBodies } from '../physics'
import { damageProjectile, killProjectile, kindOf, spawnProjectile } from '../projectiles'
import { PI, cos, sin } from '../math'
import { wildOn } from '../wild'
import type { EntityId, PlayerId, ProjectileState, SimState } from '../types'
import type { SpellDef } from './data'
import { rangeFactor } from '../stats'
import { ALLIANCE_ENEMY, alliance } from '../teams'
import { attr } from './data'
import { MOD_SHIELD } from './shield'
import type { SpellBehavior } from './types'
import { aim, castAttr } from './util'

const LIGHTNING_ENEMY_MASK = BIT_PLAYER | BIT_PROJECTILE | BIT_OBSTACLE
const FIREBALL_FULL_DAMAGE_RADIUS = 100

export const lightningSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const max = attr(def, 'range', level) * rangeFactor(state, caster.owner)
    beam(state, caster.owner, caster.x, caster.y, a.dx, a.dy, max, castAttr(ctx, 'damage'), def, level, null)
  },
}

/** Wild's Fork: a Lightning stopped by an enemy Shield splits back into two beams (degrees, damage share) */
const FORK_ANGLE = (25 * PI) / 180
const FORK_DAMAGE = 0.6
/** Wild's Shatter: a Snowball hit by Lightning breaks into shards in a fan (degrees) */
const SHARD_ANGLES = [-36, -12, 12, 36]
const SHARD_SPEED = 650
const SHARD_RADIUS = 40
const SHARD_SECONDS = 0.55
const SHARD_EXPLOSION = 120

/**
 * One Lightning beam from (x, y) along (dx, dy). `skip`: a body it never meets (a fork's own
 * shield). A fork's beams (`skip` set) do not fork again.
 */
function beam(state: SimState, owner: PlayerId, x: number, y: number, dx: number, dy: number, max: number, damage: number, def: SpellDef, level: number, skip: EntityId | null): void {
  const half = attr(def, 'beam_radius', level)
  const wild = wildOn(state.settings)
  let best = max
  let winner: Body | null = null
  let winnerIsFireball = false
  let winnerShatters = false
  for (const b of collectBodies(state)) {
    if (skip !== null && b.id === skip) continue
    const al = alliance(state, owner, b.owner)
    const isFireball = b.ref.kind === 'projectile' && kindOf(b.ref.proj) === 'fireball'
    const warpzone = b.ref.kind === 'projectile' && kindOf(b.ref.proj) === 'warpzone'
    // Wild: any Snowball (not a shard) is a target, and shatters
    const shatters = wild && b.ref.kind === 'projectile' && kindOf(b.ref.proj) === 'snowball' && !b.ref.proj.data.shard
    const accepts =
      al === ALLIANCE_ENEMY &&
      (LIGHTNING_ENEMY_MASK & (1 << b.cc.channel)) !== 0 &&
      (b.cc.mat[al] & BIT_PROJECTILE) !== 0 &&
      !warpzone
    const friendlyFireball = al !== ALLIANCE_ENEMY && isFireball
    if (!accepts && !friendlyFireball && !shatters) continue
    const rx = b.k.x - x
    const ry = b.k.y - y
    const s = rx * dx + ry * dy
    const perp = Math.abs(rx * dy - ry * dx)
    const better = s < best || (winner !== null && s === best && b.radius > winner.radius)
    if (perp <= half + b.radius && s > 0 && better) {
      best = s
      winner = b
      winnerIsFireball = friendlyFireball
      winnerShatters = shatters
    }
  }
  let blocked = false
  let fork: { x: number; y: number; owner: PlayerId; skip: EntityId } | null = null
  if (winner) {
    const r = winner.ref
    if (winnerIsFireball && r.kind === 'projectile') {
      const fb = r.proj
      const radius = attr(def, 'fb_radius', level)
      state.events.push({ type: 'explosion', x: fb.x, y: fb.y, radius, spell: 'lightning', level })
      destroyProjectile(state, fb, null)
      damageArea(state, owner, fb.x, fb.y, radius, {
        amountMin: 0,
        amountMax: (2 / 3) * (damage + fb.data.damage),
        fullDamageRadius: FIREBALL_FULL_DAMAGE_RADIUS,
        knockbackFactor: attr(def, 'fb_knockback_factor', level),
        cause: 'lightning',
      })
    } else if (winnerShatters && r.kind === 'projectile') {
      shatter(state, owner, r.proj, dx, dy)
    } else if (winner.cc.acceptDamage) {
      if (r.kind === 'pawn') {
        receiveDamage(state, r.pawn, { amount: damage, source: owner, normal: { x: dx, y: dy }, knockbackFactor: attr(def, 'knockback_factor', level), cause: 'lightning' })
      } else if (r.kind === 'projectile') damageProjectile(state, r.proj, null)
      else damageObstacle(state, r.obstacle, damage, owner)
    } else {
      blocked = true
      if (wild && skip === null && r.kind === 'pawn' && r.cc === MOD_SHIELD) fork = { x: winner.k.x, y: winner.k.y, owner: r.pawn.owner, skip: winner.id }
    }
  }
  state.events.push({
    type: 'beam',
    spell: 'lightning',
    owner,
    fromX: x,
    fromY: y,
    toX: x + dx * best,
    toY: y + dy * best,
    target: winner ? winner.id : null,
    blocked,
    level,
  })
  if (fork) {
    state.events.push({ type: 'reaction', reaction: 'fork', x: fork.x, y: fork.y, owner: fork.owner })
    for (const side of [-1, 1]) {
      const c = cos(FORK_ANGLE * side)
      const sn = sin(FORK_ANGLE * side)
      // back the way it came, turned either side
      beam(state, fork.owner, fork.x, fork.y, -dx * c + dy * sn, -dy * c - dx * sn, max, damage * FORK_DAMAGE, def, level, fork.skip)
    }
  }
}

/** Wild's Shatter: the Snowball breaks into four shards in a fan, owned by the Lightning's caster. */
function shatter(state: SimState, owner: PlayerId, ball: ProjectileState, dx: number, dy: number): void {
  // copied before the kill marks the ball's data dead
  const d = { ...ball.data }
  state.events.push({ type: 'reaction', reaction: 'shatter', x: ball.x, y: ball.y, owner })
  killProjectile(state, ball)
  for (const deg of SHARD_ANGLES) {
    const a = (deg * PI) / 180
    const c = cos(a)
    const sn = sin(a)
    const vx = (dx * c - dy * sn) * SHARD_SPEED
    const vy = (dy * c + dx * sn) * SHARD_SPEED
    spawnProjectile(state, owner, 'snowball', ball.x, ball.y, vx, vy, SHARD_RADIUS, {
      level: ball.level,
      lifetime: SHARD_SECONDS,
      rangeMastery: false,
      data: { ...d, shard: 1, damage: d.damage * 0.5, damageMin: d.damageMin * 0.5, damageMax: d.damageMax * 0.5, explosion: SHARD_EXPLOSION, kb: d.kb * 0.7 },
    })
  }
}
