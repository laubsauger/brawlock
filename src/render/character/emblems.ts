import * as THREE from 'three/webgpu'
import type { EmblemCosmeticId } from '../../game/progressionCatalog'

/**
 * Cape emblems: single-colour prints on the back of the cape, drawn in the wearer's player
 * colour. Each emblem is a few Canvas2D strokes in a 100 x 100 box; all of them are painted once
 * into one coverage atlas (white on black), and the cloth shader samples the wearer's cell.
 * Adding one is a draw function and a catalog entry: no mesh, no texture file.
 */
type Draw = (c: CanvasRenderingContext2D) => void

const poly = (c: CanvasRenderingContext2D, pts: number[]) => {
  c.beginPath()
  c.moveTo(pts[0], pts[1])
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1])
  c.closePath()
}
const circle = (c: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
}
/** cut a shape out of what is painted so far */
const cut = (c: CanvasRenderingContext2D, shape: () => void) => {
  c.save()
  c.globalCompositeOperation = 'destination-out'
  shape()
  c.fill()
  c.restore()
}

const EMBLEMS: Record<EmblemCosmeticId, Draw> = {
  'emblem-skull': (c) => {
    circle(c, 50, 42, 30)
    c.fill()
    c.fillRect(32, 58, 36, 22)
    cut(c, () => circle(c, 38, 44, 9))
    cut(c, () => circle(c, 62, 44, 9))
    cut(c, () => poly(c, [50, 54, 45, 64, 55, 64]))
    for (const x of [38, 47, 56]) cut(c, () => c.rect(x, 72, 5, 9))
  },
  'emblem-flame': (c) => {
    c.beginPath()
    c.moveTo(50, 8)
    c.bezierCurveTo(62, 30, 82, 40, 78, 64)
    c.bezierCurveTo(75, 84, 58, 93, 50, 93)
    c.bezierCurveTo(32, 93, 20, 80, 22, 62)
    c.bezierCurveTo(24, 48, 34, 44, 36, 30)
    c.bezierCurveTo(44, 40, 44, 50, 46, 54)
    c.bezierCurveTo(52, 40, 46, 22, 50, 8)
    c.fill()
    cut(c, () => {
      c.beginPath()
      c.moveTo(50, 56)
      c.bezierCurveTo(60, 66, 62, 76, 56, 84)
      c.bezierCurveTo(50, 88, 40, 84, 41, 74)
      c.bezierCurveTo(42, 66, 48, 64, 50, 56)
    })
  },
  'emblem-crown': (c) => {
    poly(c, [14, 74, 10, 28, 32, 50, 50, 18, 68, 50, 90, 28, 86, 74])
    c.fill()
    c.fillRect(14, 79, 72, 10)
    for (const [x, y] of [[10, 26], [50, 16], [90, 26]]) {
      circle(c, x, y, 6)
      c.fill()
    }
  },
  'emblem-eye': (c) => {
    c.beginPath()
    c.moveTo(6, 50)
    c.quadraticCurveTo(50, 8, 94, 50)
    c.quadraticCurveTo(50, 92, 6, 50)
    c.fill()
    cut(c, () => circle(c, 50, 50, 20))
    circle(c, 50, 50, 11)
    c.fill()
  },
  'emblem-moon': (c) => {
    circle(c, 46, 50, 38)
    c.fill()
    cut(c, () => circle(c, 62, 42, 32))
    poly(c, [76, 58, 80, 70, 92, 70, 82, 78, 86, 90, 76, 82, 66, 90, 70, 78, 60, 70, 72, 70])
    c.fill()
  },
  'emblem-bolt': (c) => {
    poly(c, [58, 4, 20, 56, 46, 56, 36, 96, 80, 40, 54, 40, 66, 4])
    c.fill()
  },
  'emblem-spiral': (c) => {
    c.lineWidth = 9
    c.lineCap = 'round'
    c.beginPath()
    for (let a = 0; a < Math.PI * 6.2; a += 0.05) {
      const r = 4 + a * 2.25
      const x = 50 + Math.cos(a) * r
      const y = 50 + Math.sin(a) * r
      if (a === 0) c.moveTo(x, y)
      else c.lineTo(x, y)
    }
    c.stroke()
  },
  'emblem-paw': (c) => {
    c.beginPath()
    c.ellipse(50, 66, 22, 18, 0, 0, Math.PI * 2)
    c.fill()
    for (const [x, y, r] of [[22, 42, 9], [38, 28, 10], [62, 28, 10], [78, 42, 9]]) {
      c.beginPath()
      c.ellipse(x, y, r, r * 1.25, 0, 0, Math.PI * 2)
      c.fill()
    }
  },
  'emblem-smile': (c) => {
    circle(c, 50, 50, 42)
    c.fill()
    cut(c, () => circle(c, 36, 40, 7))
    cut(c, () => circle(c, 64, 40, 7))
    cut(c, () => {
      c.beginPath()
      c.arc(50, 52, 25, 0.15 * Math.PI, 0.85 * Math.PI)
      c.arc(50, 52, 16, 0.85 * Math.PI, 0.15 * Math.PI, true)
      c.closePath()
    })
  },
  'emblem-ghost': (c) => {
    c.beginPath()
    c.moveTo(18, 92)
    c.lineTo(18, 44)
    c.arc(50, 44, 32, Math.PI, 0)
    c.lineTo(82, 92)
    for (let i = 0; i < 4; i++) c.quadraticCurveTo(82 - i * 16 - 8, 80, 82 - (i + 1) * 16, 92)
    c.fill()
    cut(c, () => {
      c.beginPath()
      c.ellipse(38, 46, 6, 9, 0, 0, Math.PI * 2)
    })
    cut(c, () => {
      c.beginPath()
      c.ellipse(62, 46, 6, 9, 0, 0, Math.PI * 2)
    })
  },
  'emblem-swords': (c) => {
    for (const s of [1, -1]) {
      c.save()
      c.translate(50, 50)
      c.rotate(s * Math.PI / 4)
      poly(c, [-5, 30, -5, -34, 0, -44, 5, -34, 5, 30])
      c.fill()
      c.fillRect(-15, 26, 30, 7)
      c.fillRect(-4, 33, 8, 12)
      c.restore()
    }
  },
  'emblem-mushroom': (c) => {
    c.beginPath()
    c.arc(50, 52, 40, Math.PI, 0)
    c.closePath()
    c.fill()
    c.fillRect(38, 50, 24, 40)
    for (const [x, y, r] of [[30, 34, 7], [56, 24, 6], [72, 40, 6]]) cut(c, () => circle(c, x, y, r))
  },
  'emblem-gg': (c) => {
    c.font = '900 66px system-ui, -apple-system, "Segoe UI", sans-serif'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.save()
    c.translate(50, 52)
    c.rotate(-0.12)
    c.fillText('GG', 0, 0)
    c.restore()
    c.fillRect(14, 82, 72, 6)
  },
  'emblem-heart': (c) => {
    c.beginPath()
    c.moveTo(50, 90)
    c.bezierCurveTo(10, 64, 6, 38, 20, 24)
    c.bezierCurveTo(32, 12, 46, 18, 50, 30)
    c.bezierCurveTo(54, 18, 68, 12, 80, 24)
    c.bezierCurveTo(94, 38, 90, 64, 50, 90)
    c.fill()
    cut(c, () => poly(c, [52, 22, 44, 50, 56, 50, 46, 80, 64, 44, 52, 44, 58, 22]))
  },
}

/** Emblem order in the atlas: cell index = position here. */
export const EMBLEM_IDS = Object.keys(EMBLEMS) as EmblemCosmeticId[]
/** atlas: COLS x COLS cells of CELL px */
export const EMBLEM_COLS = 4
const CELL = 128

let atlas: THREE.CanvasTexture | null = null

/** The coverage atlas (built once, on first use, from the draw functions). */
export function emblemAtlas(): THREE.Texture {
  if (atlas) return atlas
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = EMBLEM_COLS * CELL
  const c = canvas.getContext('2d')!
  c.fillStyle = '#000'
  c.fillRect(0, 0, canvas.width, canvas.height)
  EMBLEM_IDS.forEach((id, i) => {
    c.save()
    c.translate((i % EMBLEM_COLS) * CELL, Math.floor(i / EMBLEM_COLS) * CELL)
    // a margin so mip levels never bleed into the neighbour
    c.translate(CELL * 0.08, CELL * 0.08)
    c.scale((CELL * 0.84) / 100, (CELL * 0.84) / 100)
    c.fillStyle = '#fff'
    c.strokeStyle = '#fff'
    EMBLEMS[id](c)
    c.restore()
  })
  atlas = new THREE.CanvasTexture(canvas)
  atlas.colorSpace = THREE.NoColorSpace
  // cell rows top-down, like the canvas
  atlas.flipY = false
  atlas.generateMipmaps = true
  atlas.minFilter = THREE.LinearMipmapLinearFilter
  atlas.anisotropy = 4
  return atlas
}

/** Shader index of an emblem, -1 for none (plain cape). */
export function emblemIndex(id: EmblemCosmeticId | null): number {
  return id ? EMBLEM_IDS.indexOf(id) : -1
}
