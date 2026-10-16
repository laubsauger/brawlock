import * as THREE from 'three/webgpu'

/**
 * Shadow-pass cache-key churn fix. Written against three r186
 * (Renderer.renderObject override path, Material#alphaTest accessor with a
 * `_alphaTest` backing field, shadow override flagged `isShadowPassMaterial`).
 *
 * three renders every shadow caster through one shared override material
 * per light and copies each caster's `alphaTest` onto it. Material's
 * alphaTest setter bumps `version` whenever the value crosses 0, so with
 * warlocks (alphaTest 0.5 for the death dissolve) mixed with opaque casters
 * the override's version changes several times per shadow render. Every
 * render object that sees a new version recomputes its full cache key
 * (getMaterialCacheKey walks all material properties): ~17 keys per shadow
 * frame. Measured (8 players, late round, High, 60 s): allocation 18-20 ->
 * 11-13 MB/s, minor GCs 39 -> 22-26 per minute.
 *
 * For the override the bump is not needed: a render object is per
 * (caster, override material), its node build reads the alphaTest value the
 * caster brings (the cache key includes it when the object is created), and
 * no material in this game switches alphaTest on or off at runtime. So
 * shadow-pass materials store the value without bumping the version.
 */
const WRITTEN_FOR = '186'

type PatchedMaterial = THREE.Material & { isShadowPassMaterial?: boolean; _alphaTest: number }

const desc = Object.getOwnPropertyDescriptor(THREE.Material.prototype, 'alphaTest')

if (desc?.get && desc.set) {
  const baseSet = desc.set
  Object.defineProperty(THREE.Material.prototype, 'alphaTest', {
    configurable: true,
    enumerable: desc.enumerable,
    get: desc.get,
    set(this: PatchedMaterial, value: number) {
      if (this.isShadowPassMaterial === true) this._alphaTest = value
      else baseSet.call(this, value)
    },
  })
}

// dev guard: warn when the three internals this relies on change
if (import.meta.env.DEV) {
  const problems: string[] = []
  if (THREE.REVISION !== WRITTEN_FOR) problems.push(`three r${THREE.REVISION} (patch written for r${WRITTEN_FOR})`)
  if (!desc?.get || !desc.set) problems.push('Material#alphaTest is no longer an accessor')
  else {
    const plain = new THREE.Material()
    const v0 = plain.version
    plain.alphaTest = 0.5
    if (plain.version === v0) problems.push('alphaTest no longer bumps version (patch unnecessary)')
    const shadow = new THREE.Material() as PatchedMaterial
    shadow.isShadowPassMaterial = true
    const v1 = shadow.version
    shadow.alphaTest = 0.5
    if (shadow.alphaTest !== 0.5 || shadow.version !== v1) problems.push('alphaTest backing field `_alphaTest` changed')
  }
  if (problems.length > 0) console.warn(`[render] threePatches: re-check src/render/threePatches.ts: ${problems.join('; ')}`)
}

/**
 * Console filter: react-three-fiber (9.x) creates a THREE.Clock per canvas,
 * which three r183+ reports as deprecated on every canvas mount. Not
 * actionable from here; every other three message passes through.
 */
const prevConsole = THREE.getConsoleFunction()
THREE.setConsoleFunction((type: 'log' | 'warn' | 'error', message: string, ...params: unknown[]) => {
  if (type === 'warn' && message.startsWith('THREE.Clock: This module has been deprecated')) return
  if (prevConsole) prevConsole(type, message, ...params)
  else (console[type] ?? console.log)(message, ...params)
})
