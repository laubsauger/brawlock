import * as THREE from 'three/webgpu'

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

const cache = new Map<string, Promise<SurfaceMaps | null>>()
const loader = new THREE.TextureLoader()

function url(path: string): string {
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')
  return `${base}/textures/${path}`
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

function load(u: string, srgb: boolean, anisotropy: number): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      u,
      (t) => {
        t.wrapS = THREE.RepeatWrapping
        t.wrapT = THREE.RepeatWrapping
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
        t.anisotropy = anisotropy
        t.generateMipmaps = true
        t.minFilter = THREE.LinearMipmapLinearFilter
        t.needsUpdate = true
        resolve(t)
      },
      undefined,
      reject,
    )
  })
}

/** Load `<dir>/<name>_{albedo,normal,orm}.webp`, or null if the set is absent. */
export function loadSurface(dir: string, name: string, anisotropy = 4): Promise<SurfaceMaps | null> {
  const key = `${dir}/${name}@${anisotropy}`
  let p = cache.get(key)
  if (!p) {
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
    })()
    cache.set(key, p)
  }
  return p
}
