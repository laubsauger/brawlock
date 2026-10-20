import * as THREE from 'three/webgpu'
import type { EmblemCosmeticId } from '../../game/progressionCatalog'
import { EMBLEM_IDS, drawEmblem } from './emblemArt'

/**
 * Cape emblems: single-colour prints on the back of the cape, drawn in the wearer's player
 * colour. Each emblem is a few Canvas2D strokes in a 100 x 100 box (emblemArt.ts); all of them
 * are painted once into one coverage atlas (white on black), and the cloth shader samples the
 * wearer's cell. Adding one is a draw function and a catalog entry: no mesh, no texture file.
 */
export { EMBLEM_IDS }
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
    c.fillStyle = '#fff'
    c.strokeStyle = '#fff'
    // drawEmblem keeps a margin, so mip levels never bleed into the neighbour
    drawEmblem(c, id, CELL)
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
