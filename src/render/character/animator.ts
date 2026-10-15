import * as THREE from 'three/webgpu'
import type { ClipPair } from './asset'

/**
 * Two-layer clip player on one AnimationMixer:
 *   lower layer  pelvis + legs (+ spine_01)
 *   upper layer  spine_02 up, arms, head
 * Each layer cross-fades with weights that always sum to 1, so a cast can
 * run on the upper body while the legs keep running / sliding, and a
 * full-body clip simply plays the same clip on both layers in sync.
 * Additive one-shots (hit reactions) ride on top.
 */

export interface PlayOpts {
  fade?: number
  loop?: boolean
  timeScale?: number
  /** start time (s); default 0 */
  at?: number
  /** restart even if already the active clip */
  restart?: boolean
}

class Layer {
  readonly actions = new Map<string, THREE.AnimationAction>()
  readonly list: THREE.AnimationAction[] = []
  private weights: number[] = []
  current: THREE.AnimationAction | null = null
  currentName = ''
  private fade = 0.2

  add(name: string, action: THREE.AnimationAction): void {
    this.actions.set(name, action)
    this.list.push(action)
    this.weights.push(0)
    action.setEffectiveWeight(0)
  }

  play(name: string, o: PlayOpts = {}): THREE.AnimationAction | null {
    const a = this.actions.get(name)
    if (!a) return null
    const ts = o.timeScale ?? 1
    if (a === this.current && !o.restart) {
      a.timeScale = ts
      return a
    }
    const i = this.list.indexOf(a)
    if (o.restart || this.weights[i] < 1e-3 || !a.isRunning()) {
      a.reset()
      a.time = o.at ?? 0
    }
    a.enabled = true
    a.paused = false
    a.setLoop(o.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity)
    a.clampWhenFinished = o.loop === false
    a.timeScale = ts
    if (!a.isRunning()) a.play()
    this.current = a
    this.currentName = name
    this.fade = Math.max(1e-3, o.fade ?? 0.2)
    return a
  }

  update(dt: number): void {
    const cur = this.current
    if (!cur) return
    const ci = this.list.indexOf(cur)
    const wc = Math.min(1, this.weights[ci] + dt / this.fade)
    this.weights[ci] = wc
    let others = 0
    for (let i = 0; i < this.list.length; i++) if (i !== ci) others += this.weights[i]
    const scale = others > 0 ? (1 - wc) / others : 0
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i]
      if (i !== ci) {
        this.weights[i] *= scale
        if (this.weights[i] < 1e-3) {
          this.weights[i] = 0
          if (a.isRunning() || a.enabled) a.stop()
        }
      }
      a.setEffectiveWeight(this.weights[i])
    }
  }

  get time(): number {
    return this.current?.time ?? 0
  }
}

export class Animator {
  readonly mixer: THREE.AnimationMixer
  readonly lower = new Layer()
  readonly upper = new Layer()
  private additive = new Map<string, THREE.AnimationAction>()
  private addW = new Map<THREE.AnimationAction, number>()

  constructor(root: THREE.Object3D, clips: Record<string, ClipPair>, additive: Record<string, THREE.AnimationClip>) {
    this.mixer = new THREE.AnimationMixer(root)
    for (const [name, pair] of Object.entries(clips)) {
      this.lower.add(name, this.mixer.clipAction(pair.lo))
      this.upper.add(name, this.mixer.clipAction(pair.up))
    }
    for (const [name, clip] of Object.entries(additive)) {
      const a = this.mixer.clipAction(clip)
      a.blendMode = THREE.AdditiveAnimationBlendMode
      a.setLoop(THREE.LoopOnce, 1)
      a.clampWhenFinished = false
      this.additive.set(name, a)
      this.addW.set(a, 0)
    }
  }

  /** Same clip on both layers, time-synced. */
  full(name: string, o: PlayOpts = {}): void {
    this.lower.play(name, o)
    const up = this.upper.play(name, o)
    const lo = this.lower.current
    if (up && lo && up !== lo) up.time = lo.time
  }

  /** Upper layer back onto whatever the lower layer plays, in sync. */
  upperFollow(fade: number): void {
    const name = this.lower.currentName
    const lo = this.lower.current
    if (!lo) return
    if (this.upper.currentName === name) return
    const up = this.upper.play(name, { fade, loop: lo.loop !== THREE.LoopOnce, timeScale: lo.timeScale, restart: true })
    if (up) up.time = lo.time
  }

  /** Keeps the follower's speed in step with the lower layer while both play the same clip. */
  syncUpper(): void {
    const lo = this.lower.current
    const up = this.upper.current
    if (lo && up && this.upper.currentName === this.lower.currentName) {
      up.timeScale = lo.timeScale
      if (Math.abs(up.time - lo.time) > 0.05) up.time = lo.time
    }
  }

  hit(name: string, weight: number): void {
    const a = this.additive.get(name)
    if (!a) return
    a.reset()
    a.setEffectiveWeight(weight)
    this.addW.set(a, weight)
    a.play()
  }

  update(dt: number): void {
    this.lower.update(dt)
    this.upper.update(dt)
    this.mixer.update(dt)
  }
}
