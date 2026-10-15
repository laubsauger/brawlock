/**
 * Physics (spells.md §3.1-§3.2): swept circles, time-of-impact narrow phase, collisions
 * resolved in TOI order, notification by alliance x channel matrix and initiative, elastic
 * response, warlock push-out rules, arena wall at 5910.
 *
 * Broad phase: the original sorts swept X extents (sort-and-sweep). With at most ~10 pawns,
 * a few dozen projectiles and 8 pillars we test every pair instead. The result is identical:
 * the broad phase only discards pairs whose swept X ranges are disjoint, and such pairs can
 * never have a time of impact inside the tick, so the candidate set equals the narrow-phase
 * set. (This stops being exact once time_scale != 1 exists — Warpzone — because the original
 * broad phase sweeps with scaled velocity and the narrow phase with raw velocity.)
 * Ties in TOI resolve by pair generation order (ascending entity ids), which is deterministic.
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
  STD_PROJECTILE,
  collMatrix,
} from './collision'
import {
  GAME_ARENA_RADIUS,
  OBSTACLE_ELASTICITY,
  OBSTACLE_MASS,
  ORIGINAL_TICK_SCALE,
  PAWN_ELASTICITY,
  PAWN_MASS,
  PAWN_RADIUS,
} from './config'
import { PROJECTILE_BEHAVIORS } from './spells'
import { NEUTRAL_OWNER, alliance } from './teams'

/** Pawn body CC: ENEMY, ALLY -> {PLAYER, PROJECTILE, OBSTACLE}, init 0, elastic 0.5. */
export const PAWN_COLLIDER: ColliderProfile = {
  channel: CH_PLAYER,
  init: 0,
  mat: collMatrix(0, BIT_PLAYER | BIT_PROJECTILE | BIT_OBSTACLE, BIT_PLAYER | BIT_PROJECTILE | BIT_OBSTACLE),
  elastic: true,
  elasticity: PAWN_ELASTICITY,
  mass: PAWN_MASS,
  notifiesOther: true,
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
}

/** Kinematic view of a body. Pawns and projectiles are used directly; obstacles get a proxy. */
interface Kin {
  x: number
  y: number
  vx: number
  vy: number
}

interface Body {
  ref: BodyRef
  id: number
  owner: PlayerId
  k: Kin
  radius: number
  cc: ColliderProfile
  isStatic: boolean
}

interface Pair {
  toi: number
  a: Body
  b: Body
  notifyA: boolean
  notifyB: boolean
}

function pawnBody(p: PawnState): Body {
  return { ref: { kind: 'pawn', pawn: p }, id: p.id, owner: p.owner, k: p, radius: PAWN_RADIUS, cc: PAWN_COLLIDER, isStatic: false }
}

function projectileBody(p: ProjectileState): Body {
  const cc = PROJECTILE_BEHAVIORS[p.spell]?.collider ?? STD_PROJECTILE
  return { ref: { kind: 'projectile', proj: p }, id: p.id, owner: p.owner, k: p, radius: p.radius, cc, isStatic: false }
}

function obstacleBody(o: ObstacleState): Body {
  return {
    ref: { kind: 'obstacle', obstacle: o },
    id: o.id,
    owner: NEUTRAL_OWNER,
    k: { x: o.x, y: o.y, vx: 0, vy: 0 },
    radius: o.radius,
    cc: OBSTACLE_COLLIDER,
    isStatic: true,
  }
}

function destroyed(b: Body): boolean {
  const r = b.ref
  if (r.kind === 'pawn') return !r.pawn.alive
  if (r.kind === 'projectile') return r.proj.ticksLeft <= 0 || !!r.proj.data.dead
  return r.obstacle.hp <= 0
}

/**
 * Earliest t in [0, dt] at which two moving circles touch, or -1. Already overlapping = 0.
 */
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

function notify(state: SimState, self: Body, other: Body, nx: number, ny: number, x: number, y: number, overlapping: boolean): void {
  if (self.ref.kind !== 'projectile') return // pawn CC modifiers (Shield, Thrust, ...) hook in here later
  const proj = self.ref.proj
  const hit: CollisionHit = { other: other.ref, otherId: other.id, nx, ny, x, y, overlapping }
  PROJECTILE_BEHAVIORS[proj.spell]?.onCollide?.(state, proj, hit)
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
  if (a.isStatic) {
    a.k.vx = 0
    a.k.vy = 0
  }
  if (b.isStatic) {
    b.k.vx = 0
    b.k.vy = 0
  }
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

/** Collision detection + resolution + integration for one tick. */
export function physicsStep(state: SimState): void {
  const bodies: Body[] = []
  for (const p of state.pawns) if (p.alive) bodies.push(pawnBody(p))
  for (const p of state.projectiles) if (!(p.ticksLeft <= 0 || p.data.dead)) bodies.push(projectileBody(p))
  for (const o of state.obstacles) if (o.hp > 0) bodies.push(obstacleBody(o))
  bodies.sort((a, b) => a.id - b.id)

  const pairs: Pair[] = []
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      // a = lower initiative (dominant); equal keeps id order
      let a = bodies[i]
      let b = bodies[j]
      if (b.cc.init < a.cc.init) {
        const t = a
        a = b
        b = t
      }
      if (a.isStatic && b.isStatic) continue
      const al = alliance(state, a.owner, b.owner)
      const fa = (a.cc.mat[al] & (1 << b.cc.channel)) !== 0
      const fb = (b.cc.mat[al] & (1 << a.cc.channel)) !== 0
      const oa = a.cc.notifiesOther && fa
      const ob = b.cc.notifiesOther && fb
      const notifyA = a.cc.init < b.cc.init ? fa : fa && ob
      const notifyB = fb && oa
      if (!notifyA && !notifyB) continue
      const toi = timeOfImpact(a.k, b.k, a.radius + b.radius, DT)
      if (toi < 0) continue
      pairs.push({ toi, a, b, notifyA, notifyB })
    }
  }
  // stable sort keeps generation order for equal TOI
  pairs.sort((p, q) => p.toi - q.toi)

  for (const pr of pairs) {
    const { a, b, toi } = pr
    if (destroyed(a) || destroyed(b)) continue
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
    if (pr.notifyA) notify(state, a, b, nx, ny, hx, hy, overlapping)
    if (pr.notifyB) notify(state, b, a, -nx, -ny, hx, hy, overlapping)
    if (a.cc.elastic && b.cc.elastic) elasticResponse(a, b, nx, ny)
  }

  for (const p of state.pawns) {
    if (!p.alive) continue
    p.x += p.vx * DT
    p.y += p.vy * DT
    arenaBounds(p)
  }
  for (const p of state.projectiles) {
    p.x += p.vx * DT
    p.y += p.vy * DT
    arenaBounds(p)
  }
  if (state.obstacles.some((o) => o.hp <= 0)) state.obstacles = state.obstacles.filter((o) => o.hp > 0)
}
