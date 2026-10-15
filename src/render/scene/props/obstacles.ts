import * as THREE from 'three/webgpu'
import type { ObstacleState } from '../../../sim/types'
import { isLocationSafe } from '../../arenaGeom'
import { S, TILE_TOP_H } from '../../coords'
import type { WorldCtx } from '../world'
import { createObstacleVisual, type ObstacleVisual } from './obstacle'

/**
 * Drop-in replacement for scene/Obstacles (same public surface), built on
 * createObstacleVisual: one sculpted pillar per obstacle, shared theme
 * materials, rise for mid-round spawns (Rockpillar), shudder + chips on
 * damage, a sink-crumble when a Rockpillar expires.
 */

export const OBSTACLE_MAX_HP = 400
const RISE_DUR = 0.55
const SINK_DUR = 0.45

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
  private dying: { vis: ObstacleVisual; at: number }[] = []
  private theme = 0
  private frameId = 0
  private lastNow = -1
  /** called when a pillar loses hp (x, y, radius, hpFrac) for chip FX */
  onHit: ((x: number, y: number, radius: number, hpFrac: number) => void) | null = null

  constructor(private ctx: WorldCtx) {
    this.group.name = 'Obstacles'
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
    for (const o of list) {
      let tr = this.tracks.get(o.id)
      if (tr && (tr.theme !== this.theme || tr.variant !== o.variant || tr.radius !== o.radius) && o.variant >= 0) {
        this.remove(tr, false)
        tr = undefined
      }
      if (!tr) {
        const seed = Math.floor(hash(o.id * 1.37 + o.variant) * 100000)
        const vis = createObstacleVisual({ theme: this.theme as 0 | 1 | 2, variant: o.variant, radius: o.radius, seed, castShadow: this.ctx.tier.shadowMap > 0, anisotropy: this.ctx.tier.anisotropy })
        tr = { id: o.id, hp: o.hp, seen: fid, spawnAt: animateNew ? now : -100, seed, theme: this.theme, variant: o.variant, radius: o.radius, ticksLeft: o.ticksLeft, vis, x: o.x, y: o.y }
        vis.object3d.position.set(o.x * S, TILE_TOP_H * S, -o.y * S)
        this.group.add(vis.object3d)
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
    for (const [, tr] of this.tracks) {
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
        d.vis.dispose()
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
      this.dying.push({ vis: tr.vis, at: now })
    } else tr.vis.dispose()
  }

  dispose(): void {
    for (const tr of this.tracks.values()) tr.vis.dispose()
    for (const d of this.dying) d.vis.dispose()
    this.tracks.clear()
    this.dying.length = 0
    this.group.removeFromParent()
  }
}
