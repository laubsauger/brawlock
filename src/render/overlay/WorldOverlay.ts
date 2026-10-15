import * as THREE from 'three/webgpu'
import { S } from '../coords'

/**
 * DOM overlay anchored to world positions: floating combat numbers (red
 * damage, green heal, 1 s, stacked per target), name tags with compact HP
 * bars and knockback-point tint, and short callouts on big moments.
 * Imperative: pooled elements, positions written every frame, no React.
 */

const NUM_POOL = 64
const PLATE_POOL = 12
const CALLOUT_POOL = 4
const NUM_LIFE = 1
const CALLOUT_LIFE = 1.1

interface FloatNum {
  el: HTMLDivElement
  active: boolean
  born: number
  x: number
  y: number
  h: number
  stack: number
  jitter: number
  target: number
  kind: 'dmg' | 'heal'
  amount: number
}

interface Plate {
  el: HTMLDivElement
  name: HTMLDivElement
  fill: HTMLDivElement
  kb: HTMLDivElement
  lastName: string
  lastColor: number
  lastHp: number
  lastKb: number
}

interface Callout {
  el: HTMLDivElement
  active: boolean
  born: number
  x: number
  y: number
  h: number
}

export interface PlateInput {
  x: number
  y: number
  h: number
  name: string
  color: number
  hp: number
  maxHp: number
  kbPoints: number
  visible: boolean
  local: boolean
}

const css = `
.bl-ov{position:absolute;inset:0;pointer-events:none;overflow:hidden;contain:strict;font-family:Nunito,ui-rounded,system-ui,sans-serif}
.bl-num{position:absolute;left:0;top:0;will-change:transform,opacity;font-weight:900;white-space:nowrap;letter-spacing:.02em;
  text-shadow:0 0 2px #000,0 1px 0 #000,0 0 6px rgba(0,0,0,.9);transform-origin:50% 100%}
.bl-num.dmg{color:rgb(255,50,50)}
.bl-num.heal{color:rgb(50,255,50)}
.bl-plate{position:absolute;left:0;top:0;width:96px;margin-left:-48px;will-change:transform;display:flex;flex-direction:column;align-items:center;gap:2px}
.bl-plate .nm{font-size:11px;font-weight:800;line-height:1;letter-spacing:.04em;text-shadow:0 0 2px #000,0 1px 1px #000,0 0 5px rgba(0,0,0,.8);white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis}
.bl-plate .bar{position:relative;width:64px;height:6px;border-radius:2px;background:rgba(10,6,6,.82);box-shadow:0 0 0 1px rgba(0,0,0,.85),0 0 6px rgba(0,0,0,.6);overflow:hidden}
.bl-plate .fill{position:absolute;inset:1px;transform-origin:0 50%;border-radius:1px}
.bl-plate .kb{position:absolute;left:1px;right:1px;bottom:-0px;height:1px;transform-origin:0 50%;background:#ffb347;box-shadow:0 0 4px #ff7a1a}
.bl-plate.local .bar{width:72px;height:7px}
.bl-call{position:absolute;left:0;top:0;will-change:transform,opacity;font-weight:900;font-size:26px;letter-spacing:.08em;white-space:nowrap;
  color:#ffe2a8;text-shadow:0 0 3px #000,0 2px 0 #4a1000,0 0 14px rgba(255,110,20,.95),0 0 28px rgba(255,60,0,.6);text-transform:uppercase}
`

let styleInjected = false

export class WorldOverlay {
  readonly root: HTMLDivElement
  private nums: FloatNum[] = []
  private plates: Plate[] = []
  private callouts: Callout[] = []
  private v = new THREE.Vector3()
  private w = 1
  private h = 1
  private ro: ResizeObserver

  constructor(parent: HTMLElement) {
    if (!styleInjected) {
      const st = document.createElement('style')
      st.textContent = css
      document.head.appendChild(st)
      styleInjected = true
    }
    this.root = document.createElement('div')
    this.root.className = 'bl-ov'
    parent.appendChild(this.root)
    for (let i = 0; i < PLATE_POOL; i++) {
      const el = document.createElement('div')
      el.className = 'bl-plate'
      el.style.display = 'none'
      const name = document.createElement('div')
      name.className = 'nm'
      const bar = document.createElement('div')
      bar.className = 'bar'
      const fill = document.createElement('div')
      fill.className = 'fill'
      const kb = document.createElement('div')
      kb.className = 'kb'
      bar.append(fill, kb)
      el.append(name, bar)
      this.root.appendChild(el)
      this.plates.push({ el, name, fill, kb, lastName: '', lastColor: -1, lastHp: -1, lastKb: -1 })
    }
    for (let i = 0; i < NUM_POOL; i++) {
      const el = document.createElement('div')
      el.className = 'bl-num'
      el.style.display = 'none'
      this.root.appendChild(el)
      this.nums.push({ el, active: false, born: 0, x: 0, y: 0, h: 0, stack: 0, jitter: 0, target: -1, kind: 'dmg', amount: 0 })
    }
    for (let i = 0; i < CALLOUT_POOL; i++) {
      const el = document.createElement('div')
      el.className = 'bl-call'
      el.style.display = 'none'
      this.root.appendChild(el)
      this.callouts.push({ el, active: false, born: 0, x: 0, y: 0, h: 0 })
    }
    this.ro = new ResizeObserver(() => {
      this.w = this.root.clientWidth || 1
      this.h = this.root.clientHeight || 1
    })
    this.ro.observe(this.root)
    this.w = this.root.clientWidth || 1
    this.h = this.root.clientHeight || 1
  }

  /** Floating combat number at a game position (h = height in game units). */
  number(target: number, x: number, y: number, h: number, amount: number, kind: 'dmg' | 'heal', now: number): void {
    const amt = Math.round(amount)
    if (amt <= 0) return
    // merge bursts on the same target into one number, stack the rest
    let stack = 0
    for (const n of this.nums) {
      if (!n.active || n.target !== target || n.kind !== kind) continue
      const age = now - n.born
      if (age < 0.1) {
        n.amount += amt
        n.el.textContent = String(n.amount)
        return
      }
      if (age < 0.45) stack++
    }
    let slot = this.nums.find((n) => !n.active)
    if (!slot) slot = this.nums.reduce((a, b) => (a.born < b.born ? a : b))
    slot.active = true
    slot.born = now
    slot.x = x
    slot.y = y
    slot.h = h
    slot.stack = stack
    slot.jitter = (Math.random() - 0.5) * 22
    slot.target = target
    slot.kind = kind
    slot.amount = amt
    slot.el.className = `bl-num ${kind}`
    slot.el.textContent = String(amt)
    slot.el.style.fontSize = `${Math.round(15 + Math.min(13, amt / 9))}px`
    slot.el.style.display = ''
  }

  /** Short punchy text for big moments. Callers keep it rare. */
  callout(text: string, x: number, y: number, h: number, now: number): void {
    let slot = this.callouts.find((c) => !c.active)
    if (!slot) slot = this.callouts.reduce((a, b) => (a.born < b.born ? a : b))
    slot.active = true
    slot.born = now
    slot.x = x
    slot.y = y
    slot.h = h
    slot.el.textContent = text
    slot.el.style.display = ''
  }

  private project(camera: THREE.Camera, x: number, y: number, h: number): boolean {
    this.v.set(x * S, h * S, -y * S).project(camera)
    if (this.v.z > 1 || this.v.z < -1) return false
    this.v.x = (this.v.x * 0.5 + 0.5) * this.w
    this.v.y = (-this.v.y * 0.5 + 0.5) * this.h
    return true
  }

  update(camera: THREE.Camera, now: number, plates: PlateInput[], plateCount: number): void {
    // name tags
    for (let i = 0; i < PLATE_POOL; i++) {
      const p = this.plates[i]
      const inp = i < plateCount ? plates[i] : null
      if (!inp || !inp.visible || !this.project(camera, inp.x, inp.y, inp.h)) {
        if (p.el.style.display !== 'none') p.el.style.display = 'none'
        continue
      }
      if (p.el.style.display === 'none') p.el.style.display = ''
      p.el.style.transform = `translate3d(${this.v.x.toFixed(1)}px,${(this.v.y - 30).toFixed(1)}px,0)`
      if (p.lastName !== inp.name) {
        p.name.textContent = inp.name
        p.lastName = inp.name
      }
      if (p.lastColor !== inp.color) {
        const hex = `#${inp.color.toString(16).padStart(6, '0')}`
        p.name.style.color = hex
        p.fill.style.background = `linear-gradient(180deg, ${hex}, ${hex}cc)`
        p.el.classList.toggle('local', inp.local)
        p.lastColor = inp.color
      }
      const hpf = Math.max(0, Math.min(1, inp.hp / Math.max(1, inp.maxHp)))
      if (Math.abs(hpf - p.lastHp) > 0.002) {
        p.fill.style.transform = `scaleX(${hpf.toFixed(3)})`
        p.lastHp = hpf
      }
      const kbf = Math.max(0, Math.min(1, inp.kbPoints / 2000))
      if (Math.abs(kbf - p.lastKb) > 0.004) {
        p.kb.style.transform = `scaleX(${kbf.toFixed(3)})`
        // the bar frame heats up as knockback points grow
        const glow = Math.round(kbf * 14)
        p.kb.parentElement!.style.boxShadow = `0 0 0 1px rgba(0,0,0,.85),0 0 ${4 + glow}px rgba(255,${Math.round(150 - kbf * 110)},20,${(0.25 + kbf * 0.6).toFixed(2)})`
        p.lastKb = kbf
      }
    }

    // floating numbers
    for (const n of this.nums) {
      if (!n.active) continue
      const t = (now - n.born) / NUM_LIFE
      if (t >= 1 || !this.project(camera, n.x, n.y, n.h)) {
        n.active = false
        n.el.style.display = 'none'
        continue
      }
      const rise = 46 * (1 - Math.pow(1 - t, 3)) + n.stack * 17
      const pop = t < 0.12 ? 1.45 - (t / 0.12) * 0.45 : 1
      const op = t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1
      n.el.style.transform = `translate3d(${(this.v.x + n.jitter).toFixed(1)}px,${(this.v.y - 56 - rise).toFixed(1)}px,0) translate(-50%,0) scale(${pop.toFixed(3)})`
      n.el.style.opacity = op.toFixed(3)
    }

    // callouts
    for (const c of this.callouts) {
      if (!c.active) continue
      const t = (now - c.born) / CALLOUT_LIFE
      if (t >= 1 || !this.project(camera, c.x, c.y, c.h)) {
        c.active = false
        c.el.style.display = 'none'
        continue
      }
      const pop = t < 0.1 ? 0.6 + (t / 0.1) * 0.65 : t < 0.2 ? 1.25 - ((t - 0.1) / 0.1) * 0.25 : 1
      const op = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1
      c.el.style.transform = `translate3d(${this.v.x.toFixed(1)}px,${(this.v.y - 110 - t * 24).toFixed(1)}px,0) translate(-50%,0) scale(${pop.toFixed(3)}) rotate(-4deg)`
      c.el.style.opacity = op.toFixed(3)
    }
  }

  dispose(): void {
    this.ro.disconnect()
    this.root.remove()
  }
}
