import * as THREE from 'three/webgpu'
import { S } from '../coords'
import { tweaks } from '../tweaks'

/**
 * DOM overlay anchored to world positions (pooled elements, positions written
 * every frame, no React):
 * - Dota-style overhead plates: name, segmented HP bar (separator every 100
 *   HP, team fill, white damage trail that drains after a hit) and right under
 *   it the knockback-points meter (Warlock's "mana bar") shifting yellow ->
 *   orange -> red with the multiplier, "x1.4" shown past x1.1.
 * - combat numbers: overshoot pop-in, arcing drift, size/heat/shake scaled by
 *   damage and knockback, rapid hits merged, lava ticks grouped (small,
 *   orange), heals green with "+".
 * - short callouts on big moments.
 */

const NUM_POOL = 64
const PLATE_POOL = 12
const CALLOUT_POOL = 4
const NUM_LIFE = 1.05
const CALLOUT_LIFE = 1.1
/** KB meter full scale (multiplier x2 at 1000 points) */
const KB_FULL = 1000

/*
 * Plate de-collision (no layout reads: sizes come from the CSS below).
 * A plate box is ~33 px tall (3 + 4 px padding, 12 px name + 2 px gap, 8 px
 * bar, 4 px knockback row); plates may overlap a little padding, so stacking
 * uses a 30 px pitch. Width: the bar (78 px, local 86 px) or the name,
 * whichever is wider, plus 14 px padding; name width is estimated from its
 * length (11 px, weight 800, ~6.5 px per glyph, max 120 px).
 */
const PLATE_PITCH = 30
const PLATE_PAD_X = 14
/** horizontal slack: plates may touch at their faint padding before they count as overlapping */
const PLATE_SLACK_X = 8
/** a plate moves up at most ~2 plate heights; past that a clump is allowed to overlap */
const PLATE_MAX_PUSH = 2 * 33
/** ease time constant for the stacking offset: ~95 % of the way in 120 ms, no jitter when the order flips */
const PLATE_EASE_TAU = 0.04

function plateWidth(name: string, local: boolean): number {
  return Math.max(local ? 86 : 78, Math.min(120, name.length * 6.5)) + PLATE_PAD_X
}

export type NumberKind = 'dmg' | 'heal' | 'burn' | 'absorb'

interface FloatNum {
  el: HTMLDivElement
  active: boolean
  born: number
  x: number
  y: number
  h: number
  stack: number
  driftX: number
  target: number
  kind: NumberKind
  amount: number
  kb: number
  pulseAt: number
  lastOp: string
}

interface Plate {
  el: HTMLDivElement
  name: HTMLDivElement
  bar: HTMLDivElement
  fill: HTMLDivElement
  trail: HTMLDivElement
  ticks: HTMLDivElement
  kb: HTMLDivElement
  kbFill: HTMLDivElement
  mult: HTMLDivElement
  lastName: string
  lastColor: number
  lastNameColor: number
  lastHp: number
  lastMax: number
  lastKb: number
  lastMult: string
  lastOpacity: string
  /** last written screen position (px) and trail scale: skip sub-pixel / unchanged writes */
  lastX: number
  lastY: number
  lastTrail: number
  shown: boolean
  trailFrac: number
  trailHoldUntil: number
  id: number
}

interface Callout {
  el: HTMLDivElement
  active: boolean
  born: number
  x: number
  y: number
  h: number
  lastOp: string
}

export interface PlateInput {
  /** stable id (pawn id) so trails follow the right warlock */
  id: number
  x: number
  y: number
  h: number
  name: string
  /** identity (team) colour: HP fill */
  color: number
  /** slot colour: name text */
  nameColor: number
  hp: number
  maxHp: number
  kbPoints: number
  visible: boolean
  local: boolean
}

/** thin dark outline for combat numbers (keeps them punchy, readable over lava) */
const THIN_OUTLINE = '0 0 1px #000,1px 0 1px rgba(0,0,0,.9),-1px 0 1px rgba(0,0,0,.9),0 1px 1px rgba(0,0,0,.9),0 -1px 1px rgba(0,0,0,.9)'
const OUTLINE = '-1.5px -1.5px 0 #000,1.5px -1.5px 0 #000,-1.5px 1.5px 0 #000,1.5px 1.5px 0 #000,0 2px 0 #000,0 -2px 0 #000,2px 0 0 #000,-2px 0 0 #000'

const css = `
.bl-ov{position:absolute;inset:0;pointer-events:none;overflow:hidden;contain:strict;font-family:Nunito,ui-rounded,system-ui,sans-serif}
.bl-num{position:absolute;left:0;top:0;will-change:transform,opacity;font-weight:900;white-space:nowrap;letter-spacing:.01em;line-height:1;transform-origin:50% 80%}
.bl-plate{position:absolute;left:0;top:0;width:max-content;min-width:78px;padding:3px 7px 4px;border-radius:7px;background:rgba(12,7,7,.46);box-shadow:0 0 12px 5px rgba(12,7,7,.30);will-change:transform,opacity;display:flex;flex-direction:column;align-items:center}
.bl-plate .nm{font-size:11px;font-weight:800;line-height:1.1;letter-spacing:.03em;margin-bottom:2px;text-shadow:0 0 2px #000,0 1px 1px #000,0 0 5px rgba(0,0,0,.9);white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis}
.bl-plate .bar{position:relative;width:78px;height:8px;background:#120b0b;box-shadow:0 0 0 1px #000,0 1px 4px rgba(0,0,0,.7);overflow:hidden}
.bl-plate .trail,.bl-plate .fill{position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:0 50%}
.bl-plate .trail{background:#f4efe6}
.bl-plate .fill{box-shadow:inset 0 1px 0 rgba(255,255,255,.35),inset 0 -2px 0 rgba(0,0,0,.25)}
.bl-plate .ticks{position:absolute;inset:0}
.bl-plate .kbrow{position:relative;width:78px;height:3px;margin-top:1px;background:#0d0808;box-shadow:0 0 0 1px #000}
.bl-plate .kbf{position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:0 50%}
.bl-plate .mult{position:absolute;left:84px;top:-8px;font-size:10px;font-weight:900;text-shadow:${OUTLINE};white-space:nowrap;padding:0 3px;border-radius:3px;background:rgba(12,7,7,.5)}
.bl-plate.local .bar,.bl-plate.local .kbrow{width:86px}
.bl-plate.local .mult{left:92px}
.bl-call{position:absolute;left:0;top:0;will-change:transform,opacity;font-weight:900;font-size:26px;letter-spacing:.08em;white-space:nowrap;
  color:#ffe2a8;text-shadow:0 0 3px #000,0 2px 0 #4a1000,0 0 8px rgba(0,0,0,.65),0 0 14px rgba(255,110,20,.95),0 0 28px rgba(255,60,0,.6);text-transform:uppercase}
`

let styleInjected = false

function kbColor(f: number): string {
  // yellow (55deg) -> orange -> red (0deg) as the multiplier climbs
  const hue = Math.round(55 * (1 - Math.min(1, f)))
  return `hsl(${hue} 100% ${Math.round(55 - f * 8)}%)`
}

export class WorldOverlay {
  readonly root: HTMLDivElement
  private nums: FloatNum[] = []
  private plates: Plate[] = []
  private callouts: Callout[] = []
  private v = new THREE.Vector3()
  private w = 1
  private h = 1
  private ro: ResizeObserver
  private lastNow = 0
  // per plate slot, reused every frame (no allocations): projected base position, width,
  // stacked target y, eased offset (px, upwards) and the pawn id that offset belongs to
  private pVis = new Uint8Array(PLATE_POOL)
  private pX = new Float32Array(PLATE_POOL)
  private pY = new Float32Array(PLATE_POOL)
  private pW = new Float32Array(PLATE_POOL)
  private pTy = new Float32Array(PLATE_POOL)
  private pOff = new Float32Array(PLATE_POOL)
  private pOffId = new Int32Array(PLATE_POOL).fill(-1)
  private pOrder: number[] = []
  private pPlaced: number[] = []

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
    const div = (cls: string) => {
      const d = document.createElement('div')
      d.className = cls
      return d
    }
    for (let i = 0; i < PLATE_POOL; i++) {
      const el = div('bl-plate')
      el.style.display = 'none'
      const name = div('nm')
      const bar = div('bar')
      const trail = div('trail')
      const fill = div('fill')
      const ticks = div('ticks')
      bar.append(trail, fill, ticks)
      const kb = div('kbrow')
      const kbFill = div('kbf')
      const mult = div('mult')
      kb.append(kbFill, mult)
      el.append(name, bar, kb)
      this.root.appendChild(el)
      this.plates.push({ el, name, bar, fill, trail, ticks, kb, kbFill, mult, lastName: '', lastColor: -1, lastNameColor: -1, lastHp: -1, lastMax: -1, lastKb: -1, lastMult: '', lastOpacity: '', lastX: -1e9, lastY: -1e9, lastTrail: -1, shown: false, trailFrac: 1, trailHoldUntil: 0, id: -1 })
    }
    for (let i = 0; i < NUM_POOL; i++) {
      const el = div('bl-num')
      el.style.display = 'none'
      this.root.appendChild(el)
      this.nums.push({ el, active: false, born: 0, x: 0, y: 0, h: 0, stack: 0, driftX: 0, target: -1, kind: 'dmg', amount: 0, kb: 0, pulseAt: -10, lastOp: '' })
    }
    for (let i = 0; i < CALLOUT_POOL; i++) {
      const el = div('bl-call')
      el.style.display = 'none'
      this.root.appendChild(el)
      this.callouts.push({ el, active: false, born: 0, x: 0, y: 0, h: 0, lastOp: '' })
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
  number(target: number, x: number, y: number, h: number, amount: number, kind: NumberKind, now: number, kb = 0): void {
    const amt = Math.round(amount)
    if (amt <= 0) return
    let stack = 0
    for (const n of this.nums) {
      if (!n.active || n.target !== target) continue
      const age = now - n.born
      // lava ticks group into one running number; rapid hits merge
      if (n.kind === kind && ((kind === 'burn' && age < 0.9) || age < 0.12)) {
        n.amount += amt
        n.kb = Math.max(n.kb, kb)
        n.pulseAt = now
        if (kind === 'burn') n.born = Math.max(n.born, now - 0.25)
        this.styleNum(n)
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
    slot.driftX = (Math.random() - 0.5) * 2 * (kind === 'burn' ? 10 : 34)
    slot.target = target
    slot.kind = kind
    slot.amount = amt
    slot.kb = kb
    slot.pulseAt = -10
    this.styleNum(slot)
    slot.el.style.display = ''
  }

  private styleNum(n: FloatNum): void {
    const k = Math.min(1, n.kb / 1500)
    let size: number
    let color: string
    let glow: string
    if (n.kind === 'heal') {
      size = 15 + Math.min(8, n.amount / 12)
      color = 'rgb(70,255,90)'
      glow = 'rgba(40,255,90,.55)'
      n.el.textContent = `+${n.amount}`
    } else if (n.kind === 'absorb') {
      // shielded / absorbed damage (Rush): orange, bracketed
      size = 14 + Math.min(8, n.amount / 12)
      color = 'rgb(255,170,60)'
      glow = 'rgba(255,140,30,.55)'
      n.el.textContent = `(${n.amount})`
    } else if (n.kind === 'burn') {
      size = 13 + Math.min(4, n.amount / 40)
      color = 'rgb(255,140,40)'
      glow = 'rgba(255,90,10,.5)'
      n.el.textContent = String(n.amount)
    } else {
      size = 16 + Math.min(14, n.amount / 8) + k * 10
      // red -> hot orange-yellow with knockback
      const g = Math.round(55 + k * 140)
      const b = Math.round(45 + k * 40)
      color = `rgb(255,${g},${b})`
      glow = `rgba(255,${Math.round(60 + k * 120)},20,${(0.45 + k * 0.4).toFixed(2)})`
      n.el.textContent = String(n.amount)
    }
    n.el.style.fontSize = `${Math.round(size)}px`
    n.el.style.color = color
    const halo = tweaks.numberHalo ? `${THIN_OUTLINE},0 0 6px rgba(0,0,0,.55),` : ''
    n.el.style.textShadow = `${halo}0 0 ${Math.round(8 + k * 10)}px ${glow}`
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

  update(camera: THREE.Camera, now: number, plates: PlateInput[], plateCount: number, focusX: number, focusY: number): void {
    const dt = Math.min(0.1, Math.max(0, now - this.lastNow))
    this.lastNow = now
    // ---- overhead plates
    // 1. project every plate (no DOM access)
    for (let i = 0; i < PLATE_POOL; i++) {
      const inp = i < plateCount ? plates[i] : null
      // off screen (with a margin for the plate's width): hidden, no writes
      const off = !inp || !inp.visible || !this.project(camera, inp.x, inp.y, inp.h) || this.v.x < -120 || this.v.x > this.w + 120 || this.v.y < -60 || this.v.y > this.h + 120
      this.pVis[i] = off ? 0 : 1
      if (off || !inp) continue
      this.pX[i] = this.v.x
      this.pY[i] = this.v.y - 38
      this.pW[i] = plateWidth(inp.name, inp.local)
    }
    // 2. de-collide: stack overlapping plates upwards
    this.stackPlates(plates, plateCount)
    // 3. ease each plate's offset toward its stacked spot, then write
    const ease = 1 - Math.exp(-dt / PLATE_EASE_TAU)
    for (let i = 0; i < PLATE_POOL; i++) {
      const p = this.plates[i]
      const inp = i < plateCount ? plates[i] : null
      const off = !inp || !this.pVis[i]
      if (off) {
        if (p.shown) {
          p.el.style.display = 'none'
          p.shown = false
        }
        continue
      }
      // stacking offset: a new or re-shown plate starts at its spot, otherwise it glides there
      const target = this.pY[i] - this.pTy[i]
      if (!p.shown || this.pOffId[i] !== inp.id) {
        this.pOff[i] = target
        this.pOffId[i] = inp.id
      } else {
        this.pOff[i] += (target - this.pOff[i]) * ease
        if (Math.abs(target - this.pOff[i]) < 0.25) this.pOff[i] = target
      }
      if (!p.shown) {
        p.el.style.display = ''
        p.shown = true
      }
      // inline style writes force a style recalc: only move on a real (>= 0.5 px) change
      const px = this.pX[i]
      const py = this.pY[i] - this.pOff[i]
      if (Math.abs(px - p.lastX) >= 0.5 || Math.abs(py - p.lastY) >= 0.5) {
        p.el.style.transform = `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0) translate(-50%,0)`
        p.lastX = px
        p.lastY = py
      }
      if (p.id !== inp.id) {
        p.id = inp.id
        p.trailFrac = 1
        p.lastHp = -1
      }
      if (p.lastName !== inp.name) {
        p.name.textContent = inp.name
        p.lastName = inp.name
      }
      if (p.lastNameColor !== inp.nameColor) {
        p.name.style.color = `#${inp.nameColor.toString(16).padStart(6, '0')}`
        p.lastNameColor = inp.nameColor
      }
      if (p.lastColor !== inp.color) {
        const hex = `#${inp.color.toString(16).padStart(6, '0')}`
        // the bar border carries the identity (team) colour too
        p.bar.style.outline = `1px solid ${hex}88`
        p.fill.style.background = `linear-gradient(180deg, ${hex}, ${hex} 55%, ${hex}bb)`
        p.el.classList.toggle('local', inp.local)
        p.lastColor = inp.color
      }
      if (p.lastMax !== inp.maxHp) {
        // separator every 100 HP
        const segs = Math.max(1, inp.maxHp / 100)
        const pct = 100 / segs
        p.ticks.style.background = `repeating-linear-gradient(90deg, transparent 0 calc(${pct.toFixed(3)}% - 1px), rgba(0,0,0,.75) calc(${pct.toFixed(3)}% - 1px) ${pct.toFixed(3)}%)`
        p.lastMax = inp.maxHp
      }
      const hpf = Math.max(0, Math.min(1, inp.hp / Math.max(1, inp.maxHp)))
      if (p.lastHp >= 0 && hpf < p.lastHp - 0.001) p.trailHoldUntil = now + 0.35
      if (hpf > p.trailFrac) p.trailFrac = hpf
      if (now > p.trailHoldUntil) p.trailFrac = Math.max(hpf, p.trailFrac - 0.55 * dt)
      // bar is ~64 px wide: 0.002 is ~0.13 px
      if (Math.abs(hpf - p.lastHp) > 0.002 || (hpf !== p.lastHp && (hpf === 0 || hpf === 1))) {
        p.fill.style.transform = `scaleX(${hpf.toFixed(4)})`
        p.lastHp = hpf
      }
      if (Math.abs(p.trailFrac - p.lastTrail) > 0.002) {
        p.trail.style.transform = `scaleX(${p.trailFrac.toFixed(4)})`
        p.lastTrail = p.trailFrac
      }
      const kbf = Math.max(0, inp.kbPoints / KB_FULL)
      if (Math.abs(kbf - p.lastKb) > 0.003) {
        p.kbFill.style.transform = `scaleX(${Math.min(1, kbf).toFixed(3)})`
        const c = kbColor(Math.min(1, kbf * 0.75))
        p.kbFill.style.background = c
        p.kbFill.style.boxShadow = `0 0 ${Math.round(2 + kbf * 6)}px ${c}`
        const mult = 1 + inp.kbPoints / KB_FULL
        const txt = mult > 1.1 ? `×${mult.toFixed(1)}` : ''
        if (txt !== p.lastMult) {
          p.mult.textContent = txt
          p.mult.style.color = c
          p.lastMult = txt
        }
        p.lastKb = kbf
      }
      // fade slightly with distance from the camera focus
      const d = Math.hypot(inp.x - focusX, inp.y - focusY)
      // quantised (0.04 steps) so a slow drift does not rewrite it every frame
      const op = inp.local ? '1' : (Math.round(Math.max(0.72, 1 - Math.max(0, d - 600) / 2400) * 25) / 25).toFixed(2)
      if (op !== p.lastOpacity) {
        p.el.style.opacity = op
        p.lastOpacity = op
      }
    }

    // ---- combat numbers
    for (const n of this.nums) {
      if (!n.active) continue
      const t = (now - n.born) / NUM_LIFE
      if (t >= 1 || !this.project(camera, n.x, n.y, n.h)) {
        n.active = false
        n.el.style.display = 'none'
        continue
      }
      // overshoot pop-in (ease-out-back), re-pulse on merges
      const pt = Math.min(1, t / 0.2)
      const c1 = 2.4
      const back = 1 + (c1 + 1) * Math.pow(pt - 1, 3) + c1 * Math.pow(pt - 1, 2)
      let scale = 0.35 + 0.65 * back
      const pa = now - n.pulseAt
      if (pa < 0.15) scale *= 1 + 0.28 * (1 - pa / 0.15)
      // arc: quick rise that eases off, slight sideways drift
      const rise = (n.kind === 'burn' ? 34 : 58) * (1 - Math.pow(1 - t, 2.4)) + n.stack * 18
      const dx = n.driftX * t
      // heavy knockback: a short shudder
      let sx = 0
      let sy = 0
      if (n.kb > 900 && t < 0.25) {
        const a = (1 - t / 0.25) * Math.min(4, n.kb / 400)
        sx = Math.sin(now * 95) * a
        sy = Math.cos(now * 83) * a
      }
      const op = t > 0.68 ? 1 - (t - 0.68) / 0.32 : 1
      n.el.style.transform = `translate3d(${(this.v.x + dx + sx).toFixed(1)}px,${(this.v.y - 56 - rise + sy).toFixed(1)}px,0) translate(-50%,0) scale(${scale.toFixed(3)})`
      const ops = op.toFixed(2)
      if (ops !== n.lastOp) {
        n.el.style.opacity = ops
        n.lastOp = ops
      }
    }

    // ---- callouts
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
      c.el.style.transform = `translate3d(${this.v.x.toFixed(1)}px,${(this.v.y - 120 - t * 24).toFixed(1)}px,0) translate(-50%,0) scale(${pop.toFixed(3)}) rotate(-4deg)`
      const ops = op.toFixed(2)
      if (ops !== c.lastOp) {
        c.el.style.opacity = ops
        c.lastOp = ops
      }
    }
  }

  /**
   * Vertical stacking pass over the visible plates. The local player's plate
   * is placed first and never moves; the rest go from the bottom of the
   * screen up, and a plate that overlaps one already placed moves above it,
   * at most PLATE_MAX_PUSH. Writes the stacked top y per slot into pTy.
   */
  private stackPlates(plates: PlateInput[], plateCount: number): void {
    const order = this.pOrder
    const placed = this.pPlaced
    order.length = 0
    placed.length = 0
    for (let i = 0; i < PLATE_POOL && i < plateCount; i++) if (this.pVis[i]) order.push(i)
    // local first, then lowest on screen first; ties by pawn id so the order does not flicker
    order.sort((a, b) => {
      const la = plates[a].local ? 1 : 0
      const lb = plates[b].local ? 1 : 0
      if (la !== lb) return lb - la
      return this.pY[b] - this.pY[a] || plates[a].id - plates[b].id
    })
    for (const i of order) {
      let y = this.pY[i]
      if (!plates[i].local) {
        // each push moves strictly up, so this settles within one pass per placed plate
        for (let pass = 0; pass <= placed.length; pass++) {
          let moved = false
          for (const j of placed) {
            const overlapX = Math.abs(this.pX[i] - this.pX[j]) < (this.pW[i] + this.pW[j]) / 2 - PLATE_SLACK_X
            if (overlapX && y > this.pTy[j] - PLATE_PITCH && y < this.pTy[j] + PLATE_PITCH) {
              y = this.pTy[j] - PLATE_PITCH
              moved = true
            }
          }
          if (!moved) break
        }
        y = Math.max(this.pY[i] - PLATE_MAX_PUSH, y)
      }
      this.pTy[i] = y
      placed.push(i)
    }
  }

  dispose(): void {
    this.ro.disconnect()
    this.root.remove()
  }
}
