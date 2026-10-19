import * as THREE from 'three/webgpu'
import type { ObstacleState } from '../../../sim/types'
import { isLocationSafe } from '../../arenaGeom'
import { S, TILE_TOP_H } from '../../coords'
import { cameraRig } from '../../cameraRig'
import type { WorldCtx } from '../world'
import { createObstacleVisual, type ObstacleVisual } from './obstacle'
import { preloadLooks, setPropAnisotropy } from './materials'
import { SHAPE_SLOTS, allShapeSpecs, cachedShape, prefetchShapes, shapeSpec } from './shapes'

/**
 * Drop-in replacement for scene/Obstacles (same public surface), built on
 * createObstacleVisual: one sculpted pillar per obstacle, shared theme
 * materials, rise for mid-round spawns (Rockpillar), shudder + chips on
 * damage, a sink-crumble when a Rockpillar expires.
 *
 * No pillar is ever built at a phase change: shapes come from the worker
 * cache (shapes.ts), visuals are pooled per shape across rounds, and every
 * shape is pre-warmed once (one per frame, hidden under the lava at the
 * camera focus, chips included) so its buffers, render objects and shadow
 * variant exist before a round asks for it.
 */

export const OBSTACLE_MAX_HP = 400
const RISE_DUR = 0.55
const SINK_DUR = 0.45
/** pooled visuals pre-warmed per shape (rounds often repeat a shape) */
const WARM_PER_SHAPE = 2
/** frames a staged visual renders before it is parked in the pool */
const WARM_FRAMES = 2

interface Track {
  id: number
  hp: number
  seen: number
  spawnAt: number
  seed: number
  theme: number
  variant: number
  radius: number
  ticksLeft: number | undefined
  vis: ObstacleVisual
  key: string
  x: number
  y: number
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453
  return s - Math.floor(s)
}

export class PropObstacles {
  readonly group = new THREE.Group()
  private tracks = new Map<number, Track>()
  private dying: { vis: ObstacleVisual; key: string; at: number }[] = []
  /** idle visuals per shape key (hidden, kept in the group so their GPU state stays warm) */
  private free = new Map<string, ObstacleVisual[]>()
  private warmQueue: { key: string; theme: number; variant: number; radius: number; seed: number }[] = []
  private staged: { vis: ObstacleVisual; key: string; frames: number }[] = []
  private theme = 0
  private frameId = 0
  private lastNow = -1
  /** called when a pillar loses hp (x, y, radius, hpFrac) for chip FX */
  onHit: ((x: number, y: number, radius: number, hpFrac: number) => void) | null = null

  constructor(private ctx: WorldCtx) {
    this.group.name = 'Obstacles'
    // start every theme's texture load now so pillars are textured before the first fight
    setPropAnisotropy(ctx.tier.anisotropy)
    preloadLooks()
    prefetchShapes()
    for (let n = 0; n < WARM_PER_SHAPE; n++) {
      for (const sp of allShapeSpecs()) {
        // a seed whose slot matches the spec's key
        for (let slot = 0; slot < SHAPE_SLOTS; slot++) {
          if (shapeSpec(sp.theme, sp.variant, sp.radius, slot).key === sp.key) this.warmQueue.push({ key: sp.key, theme: sp.theme, variant: sp.variant, radius: sp.radius, seed: slot })
        }
      }
    }
  }

  private create(theme: number, variant: number, radius: number, seed: number): ObstacleVisual {
    const vis = createObstacleVisual({ theme: theme as 0 | 1 | 2, variant, radius, seed, castShadow: this.ctx.tier.shadowMap > 0, anisotropy: this.ctx.tier.anisotropy })
    this.group.add(vis.object3d)
    return vis
  }

  /** A pooled visual for this shape, or a new one (shape geometry is shared either way). */
  private acquire(theme: number, variant: number, radius: number, seed: number): { vis: ObstacleVisual; key: string } {
    const key = shapeSpec(theme, variant, radius, seed).key
    const list = this.free.get(key)
    const vis = list?.pop() ?? this.create(theme, variant, radius, seed)
    vis.reset()
    vis.object3d.visible = true
    return { vis, key }
  }

  private release(vis: ObstacleVisual, key: string): void {
    vis.reset()
    vis.object3d.visible = false
    let list = this.free.get(key)
    if (!list) this.free.set(key, (list = []))
    list.push(vis)
  }

  /** One hidden pre-warm per frame: render a pooled visual (and its chips) under the lava. */
  private warmStep(): void {
    let w = 0
    for (const st of this.staged) {
      if (--st.frames > 0) {
        this.staged[w++] = st
        continue
      }
      this.release(st.vis, st.key)
    }
    this.staged.length = w
    const next = this.warmQueue[0]
    if (!next || !cachedShape(next.key)) return
    this.warmQueue.shift()
    const vis = this.create(next.theme, next.variant, next.radius, next.seed)
    // under the lava at the camera focus: in the frustum, drawn, never seen
    vis.object3d.position.set(cameraRig.fx * S, -6, -cameraRig.fy * S)
    vis.hitShudder(1, 0, 0.3)
    vis.update(1 / 60)
    this.staged.push({ vis, key: next.key, frames: WARM_FRAMES })
  }

  /** Advance the shape warm-up without a match state (lobby prewarm). */
  warm(): void {
    this.warmStep()
  }

  /** every shape's pooled visuals exist and have rendered once */
  get warmDone(): boolean {
    return this.warmQueue.length === 0 && this.staged.length === 0
  }

  setTheme(theme: number): void {
    this.theme = ((theme % 3) + 3) % 3
  }

  has(id: number): boolean {
    return this.tracks.has(id)
  }

  get(id: number): Track | undefined {
    return this.tracks.get(id)
  }

  /** Optional: directional shudder from a known hit point (game units). */
  hitFrom(id: number, x: number, y: number, strength = 1): void {
    const tr = this.tracks.get(id)
    if (!tr) return
    tr.vis.hitShudder(tr.x - x, tr.y - y, strength)
  }

  update(list: ObstacleState[], now: number, animateNew: boolean): void {
    this.frameId++
    const fid = this.frameId
    const dt = this.lastNow < 0 ? 0 : Math.max(0, Math.min(0.1, now - this.lastNow))
    this.lastNow = now
    this.warmStep()
    for (const o of list) {
      let tr = this.tracks.get(o.id)
      if (tr && (tr.theme !== this.theme || tr.variant !== o.variant || tr.radius !== o.radius) && o.variant >= 0) {
        this.remove(tr, false)
        tr = undefined
      }
      if (!tr) {
        const seed = Math.floor(hash(o.id * 1.37 + o.variant) * 100000)
        const { vis, key } = this.acquire(this.theme, o.variant, o.radius, seed)
        tr = { id: o.id, hp: o.hp, seen: fid, spawnAt: animateNew ? now : -100, seed, theme: this.theme, variant: o.variant, radius: o.radius, ticksLeft: o.ticksLeft, vis, key, x: o.x, y: o.y }
        vis.object3d.position.set(o.x * S, TILE_TOP_H * S, -o.y * S)
        this.tracks.set(o.id, tr)
      }
      if (o.hp < tr.hp - 0.01) {
        const frac = Math.max(0, o.hp / OBSTACLE_MAX_HP)
        // direction unknown here: a seeded sideways shudder (hitFrom gives the real one)
        const a = hash(o.id + o.hp) * Math.PI * 2
        tr.vis.hitShudder(Math.cos(a), Math.sin(a), Math.min(2, 0.5 + (tr.hp - o.hp) / 60))
        this.onHit?.(o.x, o.y, o.radius, frac)
      }
      tr.hp = o.hp
      tr.seen = fid
      tr.ticksLeft = o.ticksLeft
      tr.x = o.x
      tr.y = o.y
      tr.vis.object3d.position.set(o.x * S, TILE_TOP_H * S, -o.y * S)
      tr.vis.setDamage(o.hp / OBSTACLE_MAX_HP)
      tr.vis.riseFromGround((now - tr.spawnAt) / RISE_DUR)
      // over lava (arena shrank under it): no floor contact ring
      tr.vis.setGrounded(isLocationSafe(o.x, o.y, this.ctx.field.layer))
      tr.vis.update(dt)
    }
    for (const tr of this.tracks.values()) {
      if (tr.seen === fid) continue
      // an expiring Rockpillar sinks back; a destroyed pillar is replaced by the blast FX
      const expired = tr.ticksLeft !== undefined && tr.ticksLeft <= 8 && tr.hp > 0
      this.remove(tr, expired, now)
    }
    let w = 0
    for (let i = 0; i < this.dying.length; i++) {
      const d = this.dying[i]
      const k = (now - d.at) / SINK_DUR
      if (k >= 1) {
        this.release(d.vis, d.key)
        continue
      }
      d.vis.riseFromGround(1 - k)
      d.vis.update(dt)
      this.dying[w++] = d
    }
    this.dying.length = w
  }

  private remove(tr: Track, sink: boolean, now = 0): void {
    this.tracks.delete(tr.id)
    if (sink) {
      tr.vis.setDamage(0.05)
      tr.vis.hitShudder(1, 0, 1.5)
      this.dying.push({ vis: tr.vis, key: tr.key, at: now })
    } else this.release(tr.vis, tr.key)
  }

  dispose(): void {
    for (const tr of this.tracks.values()) tr.vis.dispose()
    for (const d of this.dying) d.vis.dispose()
    for (const st of this.staged) st.vis.dispose()
    for (const list of this.free.values()) for (const v of list) v.dispose()
    this.tracks.clear()
    this.dying.length = 0
    this.staged.length = 0
    this.free.clear()
    this.group.removeFromParent()
  }
}
