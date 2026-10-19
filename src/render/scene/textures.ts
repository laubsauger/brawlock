import * as THREE from 'three/webgpu'
import { assetUrl } from '../../lib/assets'

/**
 * Optional authored PBR texture sets (art pipeline drops them into
 * public/textures/<theme>/<name>_{albedo,normal,orm}.webp). Every material
 * keeps its procedural TSL fallback; when a set loads, the owner rebuilds its
 * material with the maps. Missing files are fine (probed with HEAD first so a
 * missing set never spams the console).
 */
export interface SurfaceMaps {
  albedo: THREE.Texture
  normal: THREE.Texture
  /** R = ambient occlusion, G = roughness, B = metalness */
  orm: THREE.Texture
  /** optional height (R, 1 = high) for parallax occlusion mapping */
  height: THREE.Texture | null
}

export const THEME_DIRS = ['temple', 'volcanic', 'overgrown'] as const

/**
 * Loaded textures waiting for their GPU upload. A world drains this on a
 * per-frame time budget (renderer.initTexture) so uploads + mip generation
 * never land in one frame on first use.
 */
export const pendingUploads: THREE.Texture[] = []

/** loadSurface calls still fetching / decoding (readiness waits for these) */
let loadsInFlight = 0

/** true when no surface set is still loading and nothing waits for upload */
export function texturesSettled(): boolean {
  return loadsInFlight === 0 && pendingUploads.length === 0
}

const cache = new Map<string, Promise<SurfaceMaps | null>>()
const fallbackLoader = new THREE.TextureLoader()

function url(path: string): string {
  return assetUrl(`textures/${path}`)
}

async function exists(u: string): Promise<boolean> {
  try {
    const r = await fetch(u, { method: 'HEAD' })
    const ct = r.headers.get('content-type') ?? ''
    return r.ok && ct.startsWith('image/')
  } catch {
    return false
  }
}

/**
 * Decode off the main thread: fetch + createImageBitmap (an <img> decodes on
 * the main thread inside the upload, 12-32 ms per 1024² webp). The bitmap is
 * flipped at decode time (flipY = false), which also keeps the WebGL2
 * fallback right, since it ignores UNPACK_FLIP_Y for bitmaps. No colour or
 * alpha conversion: normal / ORM / height data must stay raw.
 */
async function decode(u: string): Promise<THREE.Texture> {
  if (typeof createImageBitmap === 'function') {
    const r = await fetch(u)
    if (!r.ok) throw new Error(`texture ${u}: ${r.status}`)
    const bmp = await createImageBitmap(await r.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const t = new THREE.Texture(bmp as unknown as HTMLImageElement)
    t.flipY = false
    return t
  }
  return fallbackLoader.loadAsync(u)
}

async function load(u: string, srgb: boolean, anisotropy: number): Promise<THREE.Texture> {
  const t = await decode(u)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = anisotropy
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.needsUpdate = true
  pendingUploads.push(t)
  return t
}

/** Load `<dir>/<name>_{albedo,normal,orm}.webp`, or null if the set is absent. */
export function loadSurface(dir: string, name: string, anisotropy = 4): Promise<SurfaceMaps | null> {
  const key = `${dir}/${name}@${anisotropy}`
  let p = cache.get(key)
  if (!p) {
    loadsInFlight++
    p = (async () => {
      const base = `${dir}/${name}`
      if (!(await exists(url(`${base}_albedo.webp`)))) return null
      try {
        const hasHeight = await exists(url(`${base}_height.webp`))
        const [albedo, normal, orm, height] = await Promise.all([
          load(url(`${base}_albedo.webp`), true, anisotropy),
          load(url(`${base}_normal.webp`), false, anisotropy),
          load(url(`${base}_orm.webp`), false, anisotropy),
          hasHeight ? load(url(`${base}_height.webp`), false, anisotropy) : Promise.resolve(null),
        ])
        return { albedo, normal, orm, height }
      } catch {
        return null
      }
    })().finally(() => {
      loadsInFlight--
    })
    cache.set(key, p)
  }
  return p
}
