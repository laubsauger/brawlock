/**
 * Dev-only warlock preview (not part of the app build).
 *   npx vite --port 5193  ->  http://localhost:5193/src/render/character/dev/preview.html
 * ?catalog  loads public/models/warlock/_catalog.glb (every UAL clip) to pick clips.
 */
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'

const params = new URLSearchParams(location.search)

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(2, devicePixelRatio))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  document.getElementById('root')!.appendChild(renderer.domElement)
  await renderer.init()

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0910)
  const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100)
  camera.position.set(0, 1.6, 4.2)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0, 0.95, 0)
  controls.update()

  scene.add(new THREE.HemisphereLight(0x221c3a, 0xff4a12, 0.85))
  const moon = new THREE.DirectionalLight(0x9fb2ff, 1.7)
  moon.position.set(-0.42, 0.86, 0.3).multiplyScalar(10)
  moon.castShadow = true
  moon.shadow.mapSize.set(2048, 2048)
  const sc = moon.shadow.camera as THREE.OrthographicCamera
  sc.left = sc.bottom = -3
  sc.right = sc.top = 3
  scene.add(moon)
  if (params.has('studio')) {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2.2))
    const key = new THREE.DirectionalLight(0xffffff, 2)
    key.position.set(1, 2, 3)
    scene.add(key)
  }
  const ground = new THREE.Mesh(new THREE.CircleGeometry(4, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: 0x1a1618, roughness: 0.9 }))
  ground.receiveShadow = true
  scene.add(ground)

  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  const gltf = await loader.loadAsync(params.has('catalog') ? '/models/warlock/_catalog.glb' : '/models/warlock/warlock.glb')
  const model = gltf.scene
  model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true
  })
  scene.add(model)
  const mixer = new THREE.AnimationMixer(model)
  let action: THREE.AnimationAction | null = null

  const ui = document.createElement('div')
  ui.style.cssText = 'position:absolute;left:8px;top:8px;font:12px ui-monospace,monospace;color:#ddd;display:flex;flex-direction:column;gap:4px;max-height:95vh;overflow:auto'
  const sel = document.createElement('select')
  for (const c of gltf.animations) sel.add(new Option(`${c.name} (${c.duration.toFixed(2)}s)`, c.name))
  const play = (name: string) => {
    const clip = gltf.animations.find((c) => c.name === name)
    if (!clip) return
    const next = mixer.clipAction(clip)
    next.reset().play()
    if (action && action !== next) action.crossFadeTo(next, 0.15, false)
    action = next
  }
  sel.onchange = () => play(sel.value)
  ui.appendChild(sel)
  const speed = document.createElement('input')
  speed.type = 'range'
  speed.min = '0'
  speed.max = '2'
  speed.step = '0.05'
  speed.value = '1'
  speed.oninput = () => (mixer.timeScale = Number(speed.value))
  ui.appendChild(speed)
  document.body.appendChild(ui)
  // contact sheet: n clones posed across the clip
  const sheetRoot = new THREE.Group()
  scene.add(sheetRoot)
  const sheetMixers: THREE.AnimationMixer[] = []
  const sheet = (name: string, n = 6, yaw = 0.6) => {
    sheetRoot.clear()
    sheetMixers.length = 0
    const clip = gltf.animations.find((c) => c.name === name)
    if (!clip) return 'no clip'
    model.visible = false
    for (let i = 0; i < n; i++) {
      const c = cloneSkinned(model)
      c.visible = true
      c.position.x = (i - (n - 1) / 2) * 1.1
      c.rotation.y = yaw
      const m = new THREE.AnimationMixer(c)
      m.clipAction(clip).play()
      m.setTime((clip.duration * i) / Math.max(1, n - 1))
      sheetRoot.add(c)
      sheetMixers.push(m)
    }
    camera.position.set(0, 1.4, n * 1.25)
    controls.target.set(0, 0.9, 0)
    return clip.duration
  }
  ;(window as unknown as Record<string, unknown>).__wl = { scene, camera, controls, model, mixer, play, gltf, sheet }

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  })
  const clock = new THREE.Clock()
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1)
    mixer.update(dt)
    controls.update()
    renderer.render(scene, camera)
  })
}

main().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:absolute;top:0;left:0">${String(e?.stack ?? e)}</pre>`)
  console.error(e)
})
