// Builds public/models/warlock/warlock.glb from the CC0 Quaternius packs (see docs/ASSETS.md).
// Not part of the app build. Run from a scratch dir that has the tools installed:
//   npm i @gltf-transform/core@4 @gltf-transform/functions@4 @gltf-transform/extensions@4 meshoptimizer@0.22
//   WARLOCK_SRC=<dir with the extracted packs> node build-warlock.mjs <out.glb> [--variant v1|v2] [--catalog]
// Needs `sips` (macOS) and `cwebp` on PATH for textures.
//   v3 (default): v2 without the belts / buckles (the runtime sash + medallion replace them)
//   v2:           hood without a face (the runtime adds the void + eyes), no pauldron
//                 (the runtime mantle replaces it), parts simplified to ~9k tris.
//   v1:           first export, Superhero head under the hood, full-res parts.
//   --catalog:    every UAL1 + UAL2 clip (uncompressed) for picking clips in the preview.
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions'
import { mergeDocuments, prune, dedup, resample, meshopt, compactPrimitive, weld, simplifyPrimitive } from '@gltf-transform/functions'
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { join as pjoin } from 'node:path'
import { tmpdir } from 'node:os'

const SRC = process.env.WARLOCK_SRC ?? '/private/tmp/claude-501/-Users-flo-work-code-brawlock/1f913911-16dd-4766-ab99-72b6a905d863/scratchpad'
const OUTFIT = `${SRC}/downloads/quaternius-outfits/x/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf`
// copy of Superhero_Male_FullBody.gltf with the two missing *_png.png texture names duplicated
const BASE = `${SRC}/work/base/Superhero_Male_FullBody.gltf`
const UAL1 = `${SRC}/downloads/quaternius-ual/x/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb`
const UAL2 = `${SRC}/downloads/quaternius-ual2/x/Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb`

const out = process.argv[2]
const CATALOG = process.argv.includes('--catalog')
const vi = process.argv.indexOf('--variant')
const VARIANT = vi > 0 ? process.argv[vi + 1] : 'v3'
const V2UP = VARIANT === 'v2' || VARIANT === 'v3'

/** our clip name -> [library, source clip] */
const CLIPS = {
  idle: [UAL1, 'Idle_Loop'],
  walk: [UAL1, 'Walk_Loop'],
  run: [UAL1, 'Jog_Fwd_Loop'],
  castEnter: [UAL1, 'Spell_Simple_Enter'],
  castLoop: [UAL1, 'Spell_Simple_Idle_Loop'],
  castShoot: [UAL1, 'Spell_Simple_Shoot'],
  castExit: [UAL1, 'Spell_Simple_Exit'],
  throw: [UAL2, 'OverhandThrow'],
  slam: [UAL2, 'NinjaJump_Land'],
  hit: [UAL1, 'Hit_Chest'],
  hitHead: [UAL1, 'Hit_Head'],
  knockback: [UAL2, 'Hit_Knockback'],
  death: [UAL1, 'Death01'],
}

/** v2 simplification ratio per outfit mesh (name match); the robe hides most of the legs */
const SIMPLIFY = [
  [/Boots/, 0.22],
  [/Bracer/, 0.3],
  [/Belt/, 0.4],
  [/Arms/, 0.45],
  [/Legs/, 0.45],
  [/Body/, 0.5],
  [/Hood/, 0.65],
]

await MeshoptEncoder.ready
await MeshoptSimplifier.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })

const doc = await io.read(OUTFIT)
const root = doc.getRoot()
const skin = root.listSkins()[0]
const joints = skin.listJoints()
const jointByName = new Map(joints.map((j) => [j.getName(), j]))
const armature = root.listScenes()[0].listChildren().find((n) => n.getName() === 'Armature')

if (V2UP) {
  for (const n of root.listNodes()) if (/Pauldron/.test(n.getName())) n.dispose()
}
if (VARIANT === 'v3') {
  for (const n of root.listNodes()) if (/Belt/.test(n.getName())) n.dispose()
}

// ---------------------------------------------------------------- v1: head from the base body
if (VARIANT === 'v1') {
  const src = await io.read(BASE)
  const sRoot = src.getRoot()
  const sSkin = sRoot.listSkins()[0]
  const sJoints = sSkin.listJoints().map((j) => j.getName())
  if (sJoints.join() !== joints.map((j) => j.getName()).join()) throw new Error('joint order differs')
  const keepNodes = new Set(['SuperHero_Male', 'Eyes'])
  const headJ = new Set(['Head', 'neck_01'].map((n) => sJoints.indexOf(n)))
  for (const node of sRoot.listNodes()) {
    if (!keepNodes.has(node.getName())) continue
    for (const prim of node.getMesh().listPrimitives()) {
      const J = prim.getAttribute('JOINTS_0').getArray()
      const W = prim.getAttribute('WEIGHTS_0').getArray()
      const idx = prim.getIndices().getArray()
      const n = prim.getAttribute('POSITION').getCount()
      const hw = new Float32Array(n)
      for (let v = 0; v < n; v++) for (let k = 0; k < 4; k++) if (headJ.has(J[v * 4 + k])) hw[v] += W[v * 4 + k]
      const keep = []
      for (let t = 0; t < idx.length; t += 3) {
        if (hw[idx[t]] > 0.5 && hw[idx[t + 1]] > 0.5 && hw[idx[t + 2]] > 0.5) keep.push(idx[t], idx[t + 1], idx[t + 2])
      }
      prim.getIndices().setArray(new Uint32Array(keep))
      compactPrimitive(prim)
    }
  }
  const map = mergeDocuments(doc, src)
  for (const sNode of sRoot.listNodes()) {
    const tNode = map.get(sNode)
    if (keepNodes.has(sNode.getName())) {
      // head / neck / spine bind matrices match the outfit skin (checked: < 1e-3)
      tNode.setSkin(skin)
      tNode.setName(sNode.getName() === 'Eyes' ? 'Warlock_Eyes' : 'Warlock_Head')
      armature.addChild(tNode)
    }
  }
  for (const scene of root.listScenes().slice(1)) {
    for (const n of scene.listChildren()) n.dispose()
    scene.dispose()
  }
  for (const s of root.listSkins()) if (s !== skin) s.dispose()
}

// ---------------------------------------------------------------- animations (retarget by bone name)
{
  const pelvisRest = jointByName.get('pelvis').getTranslation()
  const libs = new Map()
  const sources = CATALOG ? [UAL1, UAL2] : [...new Set(Object.values(CLIPS).map((c) => c[0]))]
  for (const lib of sources) libs.set(lib, await io.read(lib))
  const buffer = root.listBuffers()[0]
  const copyAccessor = (acc, transform) => {
    let arr = acc.getArray().slice()
    if (transform) arr = transform(arr)
    return doc.createAccessor().setType(acc.getType()).setArray(arr).setBuffer(buffer)
  }
  const addClip = (lib, srcAnim, name) => {
    const sPelvis = libs.get(lib).getRoot().listNodes().find((n) => n.getName() === 'pelvis').getTranslation()
    // the mannequin's pelvis sits lower than the outfit rig: scale its translation to our leg length
    const k = pelvisRest[2] / sPelvis[2]
    const anim = doc.createAnimation(name)
    for (const ch of srcAnim.listChannels()) {
      const tName = ch.getTargetNode()?.getName()
      const path = ch.getTargetPath()
      const target = jointByName.get(tName)
      if (!target) continue
      // rotations for every bone, translation only for the pelvis (bone lengths stay ours)
      if (path === 'scale') continue
      if (path === 'translation' && tName !== 'pelvis') continue
      const s = ch.getSampler()
      const sampler = doc
        .createAnimationSampler()
        .setInterpolation(s.getInterpolation())
        .setInput(copyAccessor(s.getInput()))
        .setOutput(copyAccessor(s.getOutput(), path === 'translation' ? (a) => a.map((v) => v * k) : null))
      anim.addSampler(sampler)
      anim.addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(path).setSampler(sampler))
    }
  }
  if (CATALOG) {
    for (const [lib, d] of libs) {
      const tag = lib === UAL1 ? '1' : '2'
      for (const a of d.getRoot().listAnimations()) if (a.getName() !== 'A_TPose') addClip(lib, a, `${tag}:${a.getName()}`)
    }
  } else {
    for (const [name, [lib, clip]] of Object.entries(CLIPS)) {
      const a = libs.get(lib).getRoot().listAnimations().find((x) => x.getName() === clip)
      if (!a) throw new Error('missing clip ' + clip)
      addClip(lib, a, name)
    }
  }
}

// ---------------------------------------------------------------- mesh cleanup
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    for (const s of prim.listSemantics()) if (/^(COLOR_|TEXCOORD_[1-9])/.test(s)) prim.setAttribute(s, null)
  }
}
for (const a of root.listAccessors()) if (!a.getBuffer()) a.setBuffer(root.listBuffers()[0])
await doc.transform(prune(), dedup())

// ---------------------------------------------------------------- textures: downscale + WebP
{
  const tmp = mkdtempSync(pjoin(tmpdir(), 'wl-'))
  const sizes = CATALOG ? { def: 512 } : { T_Ranger_BaseColor: 2048, T_Ranger_Normal: 2048, T_Ranger_ORM: 1024, def: 512 }
  doc.createExtension(EXTTextureWebP).setRequired(true)
  for (const tex of root.listTextures()) {
    const name = tex.getName() || tex.getURI()
    const isNormal = /Normal/i.test(name)
    const size = sizes[name] ?? sizes.def
    const png = pjoin(tmp, 'in.png')
    const rs = pjoin(tmp, 'rs.png')
    const webp = pjoin(tmp, 'out.webp')
    execFileSync('/bin/sh', ['-c', 'cat > "$1"', 'sh', png], { input: tex.getImage() })
    execFileSync('sips', ['-Z', String(size), png, '--out', rs], { stdio: 'ignore' })
    execFileSync('cwebp', ['-quiet', '-q', isNormal ? '88' : '82', '-m', '6', rs, '-o', webp])
    const buf = readFileSync(webp)
    console.log('tex', name, size, (buf.length / 1024).toFixed(0) + ' KB')
    tex.setImage(new Uint8Array(buf)).setMimeType('image/webp').setURI('')
  }
}

await doc.transform(resample({ tolerance: 1e-4 }))
if (!CATALOG) {
  await doc.transform(weld())
  let total = 0
  for (const mesh of root.listMeshes()) {
    const rule = V2UP ? SIMPLIFY.find(([re]) => re.test(mesh.getName())) : /Boots/.test(mesh.getName()) ? [null, 0.5] : null
    for (const prim of mesh.listPrimitives()) {
      const before = prim.getIndices().getCount() / 3
      if (rule) simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: rule[1], error: V2UP ? 0.045 : 0.001 })
      if (V2UP && /Boots|Bracer/.test(mesh.getName())) {
        // UV seams split these into many islands the simplifier must keep; they are dark
        // leather mostly under the hem / sleeves, so weld by position only (seam UVs
        // smear a little) and simplify again with small islands pruned
        const pos = prim.getAttribute('POSITION').getArray()
        const n = pos.length / 3
        const first = new Map()
        const remap = new Uint32Array(n)
        for (let v = 0; v < n; v++) {
          const key = `${Math.round(pos[v * 3] * 2000)},${Math.round(pos[v * 3 + 1] * 2000)},${Math.round(pos[v * 3 + 2] * 2000)}`
          if (!first.has(key)) first.set(key, v)
          remap[v] = first.get(key)
        }
        const idx = Uint32Array.from(prim.getIndices().getArray(), (i) => remap[i])
        MeshoptSimplifier.useExperimentalFeatures = true
        const target = /Boots/.test(mesh.getName()) ? 1000 : 600
        const [res] = MeshoptSimplifier.simplify(idx, new Float32Array(pos), 3, target * 3, 0.05, ['Prune'])
        prim.getIndices().setArray(res)
        compactPrimitive(prim)
      }
      const after = prim.getIndices().getCount() / 3
      total += after
      console.log('mesh', mesh.getName(), before, '->', after)
    }
  }
  console.log('outfit triangles', total)
  // one quantization volume for every mesh: identical skin, mergeable at runtime
  await doc.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizationVolume: 'scene' }))
}
for (const b of root.listBuffers().slice(1)) b.dispose()
for (const a of root.listAccessors()) if (!a.getBuffer()) a.setBuffer(root.listBuffers()[0])
await io.write(out, doc)
const bytes = readFileSync(out).length
console.log('wrote', out, (bytes / 1024).toFixed(0) + ' KB', 'anims', root.listAnimations().length)
