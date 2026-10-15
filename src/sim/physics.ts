/**
 * Physics (spells.md §3.1-§3.2): swept circles, time-of-impact narrow phase, collisions
 * resolved in TOI order, notification by alliance x channel matrix and initiative, elastic
 * response, warlock push-out rules, arena wall at 5910.
 *
 * Every actor contributes collision components (CCs): a pawn has its body CC plus temporary
 * CCs from modifiers (Shield, Alteration, Thrust, Windwalk); projectiles one (or none); obstacles
 * one. CCs of the same actor never interact.
 *
 * Broad phase: like the original, a pair is only considered if the X extents swept with
 * velocity x dt x time_scale overlap. We test that per pair instead of sorting (n is tiny);
 * the candidate set is identical. The narrow phase then uses RAW velocities, ignoring time_scale
 * (original quirk, spells.md §12.13). Ties in TOI resolve by pair generation order (ascending
 * actor ids, body CC before temporary CCs), which is deterministic.
 */
import { DT } from './types'
import type { ObstacleState, PawnState, PlayerId, ProjectileState, SimState } from './types'
import {
  BIT_OBSTACLE,
  BIT_PLAYER,
  BIT_PROJECTILE,
  CH_OBSTACLE,
  CH_PLAYER,
  CH_PROJECTILE,
  type BodyRef,
  type ColliderProfile,
  type CollisionHit,
  collMatrix,
} from './collision'
import { GAME_ARENA_RADIUS, OBSTACLE_ELASTICITY, OBSTACLE_MASS, ORIGINAL_TICK_SCALE, PAWN_ELASTICITY, PAWN_MASS, PAWN_RADIUS } from './config'
import { MODIFIERS } from './modifiers'
import { isAlive, kindOf, timeScale } from './projectiles'
import { PROJECTILE_BEHAVIORS } from './spells'
import { pawnMass } from './stats'
import { ALLIANCE_ALLY, ALLIANCE_ENEMY, NEUTRAL_OWNER, alliance } from './teams'

const PAWN_DEFAULT_MASK = BIT_PLAYER | BIT_PROJECTILE | BIT_OBSTACLE

/** Pawn body CC: ENEMY, ALLY -> {PLAYER, PROJECTILE, OBSTACLE}, init 0, elastic 0.5. */
export const PAWN_COLLIDER: ColliderProfile = {
  channel: CH_PLAYER,
  init: 0,
  mat: collMatrix(0, PAWN_DEFAULT_MASK, PAWN_DEFAULT_MASK),
  elastic: true,
  elasticity: PAWN_ELASTICITY,
  mass: PAWN_MASS,
  notifiesOther: true,
  acceptDamage: true,
}

/** Obstacle CC: ENEMY, ALLY -> {PLAYER, PROJECTILE}, static, mass 10000, elastic 0.5. */
export const OBSTACLE_COLLIDER: ColliderProfile = {
  channel: CH_OBSTACLE,
  init: 0,
  mat: collMatrix(0, BIT_PLAYER | BIT_PROJECTILE, BIT_PLAYER | BIT_PROJECTILE),
  elastic: true,
  elasticity: OBSTACLE_ELASTICITY,
  mass: OBSTACLE_MASS,
  notifiesOther: true,
  acceptDamage: true,
}

/** Body CC of a pawn with its modifiers' accept-mask changes applied (Shield, Thrust, Windwalk). */
export function pawnBodyProfile(pawn: PawnState): ColliderProfile {
  let ally = PAWN_DEFAULT_MASK
  let enemy = PAWN_DEFAULT_MASK
  for (const m of pawn.modifiers) {
    const f = MODIFIERS[m.id]?.bodyMask
    if (f) [ally, enemy] = f(m, ally, enemy)
  }
  const mass = pawnMass(pawn)
  if (ally === PAWN_DEFAULT_MASK && enemy === PAWN_DEFAULT_MASK && mass === PAWN_MASS) return PAWN_COLLIDER
  const mat: [number, number, number] = [0, 0, 0]
  mat[ALLIANCE_ALLY] = ally
  mat[ALLIANCE_ENEMY] = enemy
  return { ...PAWN_COLLIDER, mat, mass }
}

export function projectileProfile(p: ProjectileState): ColliderProfile | null {
  const b = PROJECTILE_BEHAVIORS[kindOf(p)]
  if (!b) return null
  return typeof b.collider === 'function' ? b.collider(p) : b.collider
}

/** Kinematic view of a body. Pawns and projectiles are used directly; obstacles likewise. */
interface Kin {
  x: number
  y: number
  vx: number
  vy: number
}

export interface Body {
  ref: BodyRef
  /** actor entity id */
  id: number
  owner: PlayerId
  k: Kin
  radius: number
  cc: ColliderProfile
  isStatic: boolean
  /** time scale of the actor (Warpzone), 1 for pawns and obstacles */
  ts: number
}

interface Pair {
  toi: number
  a: Body
  b: Body
  notifyA: boolean
  notifyB: boolean
}

const STATIC_KIN = (o: ObstacleState): Kin => ({ x: o.x, y: o.y, vx: 0, vy: 0 })

/** All active collision components, ordered by actor id (body CC before temporary CCs). */
export function collectBodies(state: SimState): Body[] {
  const out: Body[] = []
  for (const p of state.pawns) {
    if (!p.alive) continue
    out.push({ ref: { kind: 'pawn', pawn: p, cc: 'body', mod: null }, id: p.id, owner: p.owner, k: p, radius: PAWN_RADIUS, cc: pawnBodyProfile(p), isStatic: false, ts: 1 })
    for (const m of p.modifiers) {
      const c = MODIFIERS[m.id]?.collider?.(state, p, m)
      if (c) out.push({ ref: { kind: 'pawn', pawn: p, cc: m.id, mod: m }, id: p.id, owner: p.owner, k: p, radius: c.radius, cc: c.profile, isStatic: false, ts: 1 })
    }
  }
  for (const p of state.projectiles) {
    if (!isAlive(p)) continue
    const cc = projectileProfile(p)
    if (cc) out.push({ ref: { kind: 'projectile', proj: p }, id: p.id, owner: p.owner, k: p, radius: p.radius, cc, isStatic: !!p.data.static, ts: timeScale(p) })
  }
  for (const o of state.obstacles) {
    if (o.hp > 0) out.push({ ref: { kind: 'obstacle', obstacle: o }, id: o.id, owner: NEUTRAL_OWNER, k: STATIC_KIN(o), radius: o.radius, cc: OBSTACLE_COLLIDER, isStatic: true, ts: 1 })
  }
  // stable: keeps body-before-temporary order inside one pawn
  return out.sort((a, b) => a.id - b.id)
}

export function bodyDestroyed(b: Body): boolean {
  const r = b.ref
  if (r.kind === 'pawn') return !r.pawn.alive || (r.mod !== null && !r.pawn.modifiers.includes(r.mod))
  if (r.kind === 'projectile') return !isAlive(r.proj)
  return r.obstacle.hp <= 0
}

/** Earliest t in [0, dt] at which two moving circles touch, or -1. Already overlapping = 0. */
export function timeOfImpact(a: Kin, b: Kin, r: number, dt: number): number {
  const px = b.x - a.x
  const py = b.y - a.y
  const c = px * px + py * py - r * r
  if (c < 0) return 0
  const vx = b.vx - a.vx
  const vy = b.vy - a.vy
  const hb = px * vx + py * vy
  if (hb >= 0) return -1
  const aa = vx * vx + vy * vy
  const disc = hb * hb - aa * c
  if (disc < 0) return -1
  const t = (-hb - Math.sqrt(disc)) / aa
  return t <= dt ? (t > 0 ? t : 0) : -1
}

function sweptX(b: Body): [number, number] {
  const x1 = b.k.x + b.k.vx * DT * b.ts
  return b.k.x < x1 ? [b.k.x - b.radius, x1 + b.radius] : [x1 - b.radius, b.k.x + b.radius]
}

function notify(state: SimState, self: Body, hit: CollisionHit): void {
  const r = self.ref
  if (r.kind === 'projectile') {
    // both sides of a pair are told even if the first reaction destroyed the second
    // (Fireball vs Fireball: both explode), as in the original
    PROJECTILE_BEHAVIORS[kindOf(r.proj)]?.onCollide?.(state, r.proj, hit)
  } else if (r.kind === 'pawn' && r.mod) {
    // a temporary CC whose modifier was just removed (e.g. two Thrusts hitting each other)
    // must not react twice
    if (r.pawn.alive && r.pawn.modifiers.includes(r.mod)) MODIFIERS[r.mod.id]?.onColliderHit?.(state, r.pawn, r.mod, hit)
  }
}

/** Momentum exchange along n (from a to b), original formula with per-body elasticity. */
function momentumResponse(a: Body, b: Body, nx: number, ny: number): void {
  const ma = a.cc.mass
  const mb = b.cc.mass
  const mom = ma * (a.k.vx * nx + a.k.vy * ny) - mb * (b.k.vx * nx + b.k.vy * ny)
  if (!(mom > 0)) return
  const j = 0.5 * mom * (1 + 0.5 * (a.cc.elasticity + b.cc.elasticity))
  a.k.vx -= (j / ma) * nx
  a.k.vy -= (j / ma) * ny
  b.k.vx += (j / mb) * nx
  b.k.vy += (j / mb) * ny
}

function syncObstacle(b: Body): void {
  if (b.ref.kind === 'obstacle') {
    b.k.vx = 0
    b.k.vy = 0
  }
}

function elasticResponse(a: Body, b: Body, nx: number, ny: number): void {
  if (a.cc.channel === CH_PROJECTILE || b.cc.channel === CH_PROJECTILE) {
    momentumResponse(a, b, nx, ny)
  } else {
    // separation at the start of this tick (positions are not yet integrated)
    const dx = b.k.x - a.k.x
    const dy = b.k.y - a.k.y
    const rs = a.radius + b.radius
    const r = dx * dx + dy * dy - rs * rs
    if (r < 0) {
      if (a.ref.kind === 'pawn' && b.ref.kind === 'pawn') {
        // two warlocks already overlapping: pushed apart by dif / s each, s = max(30, sqrt(-r)),
        // per original 0.035 s tick (scaled to our tick)
        const s = Math.max(30, Math.sqrt(-r))
        const px = (dx / s) * ORIGINAL_TICK_SCALE
        const py = (dy / s) * ORIGINAL_TICK_SCALE
        a.k.x -= px
        a.k.y -= py
        b.k.x += px
        b.k.y += py
      } else if (a.isStatic !== b.isStatic) {
        // warlock overlapping a pillar: placed exactly at r1 + r2 along the normal
        const mover = a.isStatic ? b : a
        const fixed = a.isStatic ? a : b
        let ux = mover.k.x - fixed.k.x
        let uy = mover.k.y - fixed.k.y
        const d = Math.sqrt(ux * ux + uy * uy)
        if (d > 0) {
          ux /= d
          uy /= d
        } else {
          ux = 1
          uy = 0
        }
        mover.k.x = fixed.k.x + ux * rs
        mover.k.y = fixed.k.y + uy * rs
      } else {
        momentumResponse(a, b, nx, ny)
      }
    } else {
      momentumResponse(a, b, nx, ny)
    }
  }
  // a static actor's velocity is forced back to 0 after every collision
  if (a.isStatic) syncObstacle(a)
  if (b.isStatic) syncObstacle(b)
}

/** Hard world boundary: clamp onto the circle and drop the radial velocity (a slide). */
function arenaBounds(k: Kin): void {
  const d2 = k.x * k.x + k.y * k.y
  if (d2 < GAME_ARENA_RADIUS * GAME_ARENA_RADIUS) return
  const d = Math.sqrt(d2)
  const ux = k.x / d
  const uy = k.y / d
  k.x = ux * GAME_ARENA_RADIUS
  k.y = uy * GAME_ARENA_RADIUS
  const vr = k.vx * ux + k.vy * uy
  k.vx -= vr * ux
  k.vy -= vr * uy
}

/** Notification flags for an ordered pair (a dominates: init(a) <= init(b)). */
export function notifications(state: SimState, a: Body, b: Body): [boolean, boolean] {
  const al = alliance(state, a.owner, b.owner)
  const fa = (a.cc.mat[al] & (1 << b.cc.channel)) !== 0
  const fb = (b.cc.mat[al] & (1 << a.cc.channel)) !== 0
  const oa = a.cc.notifiesOther && fa
  const ob = b.cc.notifiesOther && fb
  return [a.cc.init < b.cc.init ? fa : fa && ob, fb && oa]
}

/** Collision detection + resolution + integration for one tick. */
export function physicsStep(state: SimState): void {
  const bodies = collectBodies(state)
  const swept = bodies.map(sweptX)

  const pairs: Pair[] = []
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      let a = bodies[i]
      let b = bodies[j]
      if (a.id === b.id) continue // CCs of one actor never touch
      if (a.isStatic && b.isStatic) continue
      if (swept[i][1] < swept[j][0] || swept[j][1] < swept[i][0]) continue
      if (b.cc.init < a.cc.init) {
        const t = a
        a = b
        b = t
      }
      const [notifyA, notifyB] = notifications(state, a, b)
      if (!notifyA && !notifyB) continue
      const toi = timeOfImpact(a.k, b.k, a.radius + b.radius, DT)
      if (toi < 0) continue
      pairs.push({ toi, a, b, notifyA, notifyB })
    }
  }
  pairs.sort((p, q) => p.toi - q.toi)

  for (const pr of pairs) {
    const { a, b, toi } = pr
    if (bodyDestroyed(a) || bodyDestroyed(b)) continue
    const ax = a.k.x + a.k.vx * toi
    const ay = a.k.y + a.k.vy * toi
    const bx = b.k.x + b.k.vx * toi
    const by = b.k.y + b.k.vy * toi
    let nx = bx - ax
    let ny = by - ay
    const d = Math.sqrt(nx * nx + ny * ny)
    if (d > 0) {
      nx /= d
      ny /= d
    } else {
      nx = 1
      ny = 0
    }
    const hx = (ax + bx) * 0.5
    const hy = (ay + by) * 0.5
    const overlapping = toi === 0
    if (pr.notifyA) notify(state, a, { other: b.ref, otherId: b.id, nx, ny, x: hx, y: hy, distance: d, overlapping, radius: a.radius, otherRadius: b.radius })
    if (pr.notifyB) notify(state, b, { other: a.ref, otherId: a.id, nx: -nx, ny: -ny, x: hx, y: hy, distance: d, overlapping, radius: b.radius, otherRadius: a.radius })
    if (a.cc.elastic && b.cc.elastic) elasticResponse(a, b, nx, ny)
  }

  for (const p of state.pawns) {
    if (!p.alive) continue
    p.x += p.vx * DT
    p.y += p.vy * DT
    arenaBounds(p)
  }
  for (const p of state.projectiles) {
    if (p.data.static) continue
    const s = DT * timeScale(p)
    p.x += p.vx * s
    p.y += p.vy * s
    arenaBounds(p)
  }
  if (state.obstacles.some((o) => o.hp <= 0)) state.obstacles = state.obstacles.filter((o) => o.hp > 0)
}

