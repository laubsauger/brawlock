import { DEFAULT_SETTINGS } from '../sim'
import { OBSTACLE_RADII } from '../sim/config'
import { DT, type ObstacleState, type PawnState, type PlayerSlot, type ProjectileState, type SimEvent, type SimState } from '../sim/types'
import { layerRadius } from './arenaGeom'

/**
 * Scripted calm stage for the menu backdrop (replaces the dev mock duel there):
 * three warlocks loiter near the platform edge, turn to each other, take a few
 * steps and now and then hurl a Fireball that misses into the lava or cracks
 * against a pillar. No Scourge, Teleport, knockback, deaths or shrink: the big
 * windup and blast rings of those read as UI clutter behind the menu.
 *
 * Plain data out (SimState + events), stepped by the caller at DT, so the
 * normal MatchWorld renders it. Render-side only: Math.random is fine here.
 */

export const MENU_LAYER = 14
const R = layerRadius(MENU_LAYER)
/** the corner of the platform the camera frames (game radians) */
export const MENU_FOCUS_ANGLE = -0.62
/** a spot this far inside the edge is the centre of the action */
const INSET = 300
const FIREBALL_SPEED = 1000
const CAST_TICKS = 12

export interface MenuStage {
  step(): { state: SimState; events: SimEvent[] }
  /** game-space centre of the action (camera target) */
  readonly focus: { x: number; y: number }
  /** outward unit vector of the framed edge */
  readonly out: { x: number; y: number }
}

function pawn(id: number, owner: number, x: number, y: number, facing: number): PawnState {
  return {
    id,
    owner,
    x,
    y,
    vx: 0,
    vy: 0,
    walkVx: 0,
    walkVy: 0,
    facing,
    hp: 1000,
    maxHp: 1000,
    hpRegen: 0,
    moveSpeed: 120,
    kbPoints: 0,
    kbFactor: 1,
    alive: true,
    invulnerable: false,
    moveTarget: null,
    cast: null,
    cooldowns: [0],
    slots: ['fireball'],
    levels: [1],
    modifiers: [],
    lastHitter: null,
    lavaTicks: 0,
  }
}

interface Actor {
  p: PawnState
  home: { x: number; y: number }
  /** ticks until the next idle decision */
  wait: number
  /** obstacle id the current cast aims at (null = a miss into the lava) */
  hits: number | null
  /**
   * a cast being lined up: the pawn turns, then throws. Kept out of
   * PawnState.cast on purpose: a running windup draws the aim arrow and the
   * palm charge rings, which read as UI clutter behind the menu panels.
   */
  aim: { x: number; y: number; ticks: number } | null
}

export function createMenuStage(theme = Math.floor(Math.random() * 3)): MenuStage {
  const ox = Math.cos(MENU_FOCUS_ANGLE)
  const oy = Math.sin(MENU_FOCUS_ANGLE)
  // tangent along the edge (counter-clockwise)
  const tx = -oy
  const ty = ox
  const fx = ox * (R - INSET)
  const fy = oy * (R - INSET)
  const at = (along: number, depth: number) => ({ x: fx + tx * along + ox * depth, y: fy + ty * along + oy * depth })

  const slots: PlayerSlot[] = [
    { id: 0, name: 'Emberveil', color: 0xff5a36, team: 0, kind: 'bot' },
    { id: 1, name: 'Tidecaller', color: 0x2ee6c9, team: 1, kind: 'bot' },
    { id: 2, name: 'Mossgrave', color: 0x5fd35a, team: 2, kind: 'bot' },
  ]
  // a loose triangle: two along the edge, one further in
  const homes = [at(-230, 110), at(240, 40), at(40, -170)]
  const actors: Actor[] = homes.map((h, i) => ({ p: pawn(i + 1, i, h.x, h.y, 0), home: h, wait: 40 + i * 50, hits: null, aim: null }))
  const face = (a: Actor, x: number, y: number) => (a.p.facing = Math.atan2(y - a.p.y, x - a.p.x))
  actors.forEach((a, i) => {
    const o = actors[(i + 1) % actors.length]
    face(a, o.p.x, o.p.y)
  })

  // two pillars of the stage's theme flanking the group
  const radii = OBSTACLE_RADII[theme] ?? OBSTACLE_RADII[0]
  const pa = at(470, -80)
  const pb = at(-470, -230)
  const obstacles: ObstacleState[] = [
    { id: 900, x: pa.x, y: pa.y, radius: radii[0], hp: 400, variant: 0 },
    { id: 901, x: pb.x, y: pb.y, radius: radii[Math.min(2, radii.length - 1)], hp: 400, variant: Math.min(2, radii.length - 1) },
  ]

  let tick = 0
  let nextId = 1000
  let projectiles: ProjectileState[] = []
  /** projectile id -> obstacle it will strike (null = expires over the lava) */
  const strikes = new Map<number, number | null>()
  let nextCast = 90
  const rnd = (a: number, b: number) => a + Math.random() * (b - a)

  const step = (): { state: SimState; events: SimEvent[] } => {
    tick++
    const events: SimEvent[] = []

    // ---- casting: one warlock at a time, every ~2.5-4.5 s
    if (--nextCast <= 0) {
      const idle = actors.filter((a) => !a.aim)
      const a = idle[Math.floor(Math.random() * idle.length)]
      if (a) {
        let x: number
        let y: number
        let hits: number | null = null
        const roll = Math.random()
        if (roll < 0.3) {
          // at a pillar: chips and a shudder
          const ob = obstacles[Math.floor(Math.random() * obstacles.length)]
          x = ob.x
          y = ob.y
          hits = ob.id
        } else {
          // past a rival, out over the lava (a near miss reads as a duel)
          const o = actors.filter((b) => b !== a)[Math.floor(Math.random() * (actors.length - 1))]
          const dx = o.p.x - a.p.x
          const dy = o.p.y - a.p.y
          const d = Math.hypot(dx, dy) || 1
          const miss = (Math.random() < 0.5 ? -1 : 1) * rnd(95, 150)
          x = o.p.x + (-dy / d) * miss
          y = o.p.y + (dx / d) * miss
          // never toward the camera (it sits inward): those cross the frame
          // bottom and end on the floor; head outward over the lava instead
          const outward = ((x - a.p.x) * ox + (y - a.p.y) * oy) / (Math.hypot(x - a.p.x, y - a.p.y) || 1)
          if (roll > 0.75 || outward < -0.15) {
            // straight out into the lava
            x = a.p.x + ox * 700 + tx * rnd(-250, 250)
            y = a.p.y + oy * 700 + ty * rnd(-250, 250)
          }
        }
        a.p.walkVx = a.p.walkVy = a.p.vx = a.p.vy = 0
        a.p.moveTarget = null
        face(a, x, y)
        a.aim = { x, y, ticks: CAST_TICKS }
        a.hits = hits
      }
      nextCast = Math.round(rnd(150, 270))
    }

    for (const a of actors) {
      const p = a.p
      if (a.aim) {
        face(a, a.aim.x, a.aim.y)
        if (--a.aim.ticks > 0) continue
        const c = a.aim
        a.aim = null
        a.wait = Math.round(rnd(40, 90))
        events.push({ type: 'cast', pawn: p.id, spell: 'fireball', x: c.x, y: c.y })
        const ang = Math.atan2(c.y - p.y, c.x - p.x)
        const hits = a.hits
        // flight: to the pillar's face, or ~1.4 s out over the lava
        const dist = hits !== null ? Math.max(60, Math.hypot(c.x - p.x, c.y - p.y) - 70) : rnd(900, 1300)
        const pr: ProjectileState = {
          id: nextId++,
          owner: p.owner,
          spell: 'fireball',
          x: p.x + Math.cos(ang) * 45,
          y: p.y + Math.sin(ang) * 45,
          vx: Math.cos(ang) * FIREBALL_SPEED,
          vy: Math.sin(ang) * FIREBALL_SPEED,
          radius: 25,
          ticksLeft: Math.max(4, Math.round(dist / FIREBALL_SPEED / DT)),
          data: {},
        }
        strikes.set(pr.id, hits)
        projectiles.push(pr)
        events.push({ type: 'projectileSpawn', id: pr.id, spell: 'fireball' })
        continue
      }
      // idle: stand, turn to a rival, now and then a few steps around home
      if (--a.wait <= 0) {
        const r = Math.random()
        if (r < 0.45) {
          const ang = rnd(0, Math.PI * 2)
          const rr = rnd(30, 110)
          p.moveTarget = { x: a.home.x + Math.cos(ang) * rr, y: a.home.y + Math.sin(ang) * rr }
        } else {
          const o = actors.filter((b) => b !== a)[Math.floor(Math.random() * (actors.length - 1))]
          face(a, o.p.x, o.p.y)
        }
        a.wait = Math.round(rnd(70, 200))
      }
      if (p.moveTarget) {
        const dx = p.moveTarget.x - p.x
        const dy = p.moveTarget.y - p.y
        const d = Math.hypot(dx, dy)
        if (d < 8) {
          p.moveTarget = null
          p.walkVx = p.walkVy = p.vx = p.vy = 0
        } else {
          p.walkVx = p.vx = (dx / d) * p.moveSpeed
          p.walkVy = p.vy = (dy / d) * p.moveSpeed
          const want = Math.atan2(dy, dx)
          let da = want - p.facing
          while (da > Math.PI) da -= Math.PI * 2
          while (da < -Math.PI) da += Math.PI * 2
          p.facing += Math.max(-0.15, Math.min(0.15, da))
        }
      }
      p.x += p.vx * DT
      p.y += p.vy * DT
    }

    // ---- projectiles
    const keep: ProjectileState[] = []
    for (const pr of projectiles) {
      pr.x += pr.vx * DT
      pr.y += pr.vy * DT
      if (--pr.ticksLeft > 0) {
        keep.push(pr)
        continue
      }
      const target = strikes.get(pr.id) ?? null
      strikes.delete(pr.id)
      if (target !== null) events.push({ type: 'projectileHit', id: pr.id, spell: pr.spell, x: pr.x, y: pr.y, target })
      else events.push({ type: 'projectileExpire', id: pr.id, spell: pr.spell, x: pr.x, y: pr.y })
    }
    projectiles = keep

    const state: SimState = {
      tick,
      rng: 1,
      nextEntityId: nextId,
      settings: DEFAULT_SETTINGS,
      slots,
      phase: 'fight',
      phaseTicksLeft: -1,
      round: 1,
      arena: { layer: MENU_LAYER, nextShrinkTick: -1, theme },
      scores: [],
      // fresh objects every tick: the frame buffer contract forbids mutation after push
      pawns: actors.map(({ p }) => ({ ...p, cast: p.cast ? { ...p.cast } : null, moveTarget: p.moveTarget ? { ...p.moveTarget } : null })),
      projectiles: projectiles.map((p) => ({ ...p })),
      obstacles: obstacles.map((o) => ({ ...o })),
      events,
    }
    return { state, events }
  }

  return { step, focus: at(0, -40), out: { x: ox, y: oy } }
}
