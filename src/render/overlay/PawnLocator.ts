import * as THREE from 'three/webgpu'
import { S } from '../coords'

/** keep the marker this far inside the screen edge (px) */
const EDGE_PAD = 34
/** the warlock counts as visible inside this NDC box */
const VISIBLE = 0.94

/**
 * Off-screen locator for the local warlock: when edge pan or peek moves it
 * out of view, an arrow in its identity colour sits on the screen edge,
 * pointing at it, so you never lose yourself. One DOM element, style writes
 * only on real change.
 */
export class PawnLocator {
  private el: HTMLDivElement
  private arrow: HTMLDivElement
  private v = new THREE.Vector3()
  private shown = false
  private lastX = -1e9
  private lastY = -1e9
  private lastA = 1e9
  private lastColor = ''

  constructor(private parent: HTMLElement) {
    const el = document.createElement('div')
    el.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;display:none;z-index:3;will-change:transform'
    const arrow = document.createElement('div')
    // a chevron in a dark disc: reads on any floor, never like a spell icon
    arrow.style.cssText =
      'position:absolute;left:-17px;top:-17px;width:34px;height:34px;border-radius:50%;background:rgba(8,6,10,.72);box-shadow:0 0 0 2px currentColor inset,0 0 10px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center'
    arrow.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M5 3 L13 9 L5 15" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    el.appendChild(arrow)
    parent.appendChild(el)
    this.el = el
    this.arrow = arrow
  }

  /**
   * Game position (x, y, height h), identity colour css string. Call after
   * the camera moved this frame (it projects through camera.matrixWorld).
   */
  update(camera: THREE.Camera, x: number, y: number, h: number, color: string, active: boolean): void {
    let show = false
    let px = 0
    let py = 0
    let ang = 0
    if (active) {
      const v = this.v.set(x * S, h * S, -y * S).project(camera)
      // behind the camera: mirror so the arrow still points the right way
      let nx = v.x
      let ny = v.y
      if (v.z > 1) {
        nx = -nx
        ny = -ny
      }
      if (Math.abs(nx) > VISIBLE || Math.abs(ny) > VISIBLE || v.z > 1) {
        show = true
        const w = this.parent.clientWidth || 1
        const hh = this.parent.clientHeight || 1
        // ray from the screen centre to the warlock, clipped to the padded edge box
        const dx = nx * w * 0.5
        const dy = -ny * hh * 0.5
        const bx = w * 0.5 - EDGE_PAD
        const by = hh * 0.5 - EDGE_PAD
        const s = Math.min(bx / Math.max(1e-6, Math.abs(dx)), by / Math.max(1e-6, Math.abs(dy)))
        px = w * 0.5 + dx * s
        py = hh * 0.5 + dy * s
        ang = Math.atan2(dy, dx)
      }
    }
    if (show !== this.shown) {
      this.el.style.display = show ? '' : 'none'
      this.shown = show
    }
    if (!show) return
    if (color !== this.lastColor) {
      this.arrow.style.color = color
      this.lastColor = color
    }
    if (Math.abs(px - this.lastX) >= 0.5 || Math.abs(py - this.lastY) >= 0.5 || Math.abs(ang - this.lastA) > 0.01) {
      this.el.style.transform = `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0)`
      this.arrow.style.transform = `rotate(${ang.toFixed(3)}rad)`
      this.lastX = px
      this.lastY = py
      this.lastA = ang
    }
  }

  dispose(): void {
    this.el.remove()
  }
}
