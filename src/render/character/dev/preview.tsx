/**
 * Dev-only warlock preview (not part of the app build).
 *   npx vite --port 5193  ->  http://localhost:5193/src/render/character/dev/preview.html
 * A fake pawn (60 Hz, original friction) drives createWarlock() exactly like
 * the match does: PawnState + prev + alpha + per-tick SimEvents.
 * Params: ?style=procedural  ?staff=gnarled|iron|bone  ?view=game|close  ?n=10  ?mode=circle|line|idle
 *         ?splash (show the key art for comparison)  ?nopost  ?turntable
 *         ?tier=low|high|ultra (emulates the match tiers: bloom, shadows, dpr)  ?ground=tiles  ?wlook=void
 * window.__wp exposes the controls for scripted screenshots.
 */
import * as THREE from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { PawnState, SimEvent } from '../../../sim/types'
import { S } from '../../coords'
import { clothParams, createWarlock, preloadWarlock, warlockParams, type DeathKind, type StaffVariant, type WarlockHandle, type WarlockStyle } from '../index'
import { getWarlockAsset } from '../asset'
import { getSpellColor } from '../../vfx/palette'

const params = new URLSearchParams(location.search)
const DT = 1 / 60
const FRICTION = Math.pow(0.96, DT / 0.035)
const COLORS = [0x2fd6c8, 0xe0352b, 0x4f7dff, 0xf2b630, 0x9b4dff, 0x3ccf4e, 0xff6fb5, 0xe8e8e8, 0xff8a1f, 0x18b0ff]

type Mode = 'idle' | 'circle' | 'line' | 'walk' | 'treadmill' | 'treadwalk'

interface Actor {
  pawn: PawnState
  prev: PawnState
  w: WarlockHandle
  holder: THREE.Group
  mode: Mode
  phase: number
  dir: number
  pending: SimEvent[]
  frameEvents: SimEvent[]
  burning: boolean
  dieNext?: boolean
}

function newPawn(id: number): PawnState {
  return {
    id,
    owner: id,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    walkVx: 0,
    walkVy: 0,
    facing: -Math.PI / 2,
    hp: 100,
    maxHp: 100,
    hpRegen: 0,
    moveSpeed: 210,
    kbPoints: 0,
    kbFactor: 1,
    alive: true,
    invulnerable: false,
    moveTarget: null,
    cast: null,
    cooldowns: [],
    slots: [],
    levels: [],
    modifiers: [],
    lastHitter: null,
    lavaTicks: 0,
  }
}

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: true })
  // ?tier emulates the match quality tiers (render/quality.ts): Low = no post /
  // bloom / shadows at 0.75 dpr, High = bloom 0.6 + 2048 shadows, Ultra = bloom 0.7 + 4096
  const tier = params.get('tier') as 'low' | 'high' | 'ultra' | null
  renderer.setPixelRatio(tier === 'low' ? 0.75 : tier === 'ultra' ? Math.min(3, devicePixelRatio) : Math.min(2, devicePixelRatio))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  document.getElementById('root')!.appendChild(renderer.domElement)
  await renderer.init()

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x07060a)
  const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 200)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true

  // match lighting (MatchWorld): cool sky, warm lava bounce, moon key from behind-left
  scene.add(new THREE.HemisphereLight(0x221c3a, 0xff4a12, 0.85))
  const moon = new THREE.DirectionalLight(0x9fb2ff, 1.7)
  moon.position.set(-0.42, 0.86, 0.3).multiplyScalar(20)
  moon.castShadow = tier !== 'low'
  moon.shadow.mapSize.set(tier === 'ultra' ? 4096 : 2048, tier === 'ultra' ? 4096 : 2048)
  const sc = moon.shadow.camera as THREE.OrthographicCamera
  sc.left = sc.bottom = -8
  sc.right = sc.top = 8
  sc.far = 60
  moon.shadow.bias = -0.0006
  moon.shadow.normalBias = 0.02
  scene.add(moon, moon.target)
  // lava glow from below / in front, like the arena edge
  const lavaLight = new THREE.PointLight(0xff5a1a, 6, 12, 1.6)
  lavaLight.position.set(1.5, 0.3, 2.5)
  scene.add(lavaLight)
  const studio = new THREE.Group()
  studio.add(new THREE.HemisphereLight(0xc8ccff, 0x3a2a24, 1.6))
  const key = new THREE.DirectionalLight(0xffffff, 1.6)
  key.position.set(2, 3, 4)
  studio.add(key)
  studio.visible = params.has('studio')
  scene.add(studio)

  const groundMat = new THREE.MeshStandardNodeMaterial({ color: 0x17141a, roughness: 0.85 })
  if (params.get('ground') === 'tiles') {
    // the match's temple tile top (192 units = 1.92 m per tile) for honest value contrast
    const tl = new THREE.TextureLoader()
    const map = tl.load('/textures/temple/tile_top_albedo.webp')
    const nrm = tl.load('/textures/temple/tile_top_normal.webp')
    map.colorSpace = THREE.SRGBColorSpace
    for (const t of [map, nrm]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(60 / 1.92, 60 / 1.92)
    }
    groundMat.color.setHex(0xffffff)
    groundMat.map = map
    groundMat.normalMap = nrm
  }
  const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 96).rotateX(-Math.PI / 2), groundMat)
  ground.receiveShadow = true
  scene.add(ground)
  const grid = new THREE.GridHelper(30, 60, 0x3a2f3a, 0x241d26)
  ;(grid.material as THREE.Material).transparent = true
  ;(grid.material as THREE.Material).opacity = 0.35
  grid.position.y = 0.002
  scene.add(grid)

  const post = !params.has('nopost') && tier !== 'low'
  const pipeline = new THREE.RenderPipeline(renderer)
  {
    const sp = pass(scene, camera)
    const col = sp.getTextureNode('output')
    // same bloom as the match (RenderLoop, High tier): strength 0.6, radius 0.4, threshold 1, smoothWidth 0.6
    if (post) {
      const b = bloom(col, tier === 'ultra' ? 0.7 : 0.6, 0.4, 1.0)
      b.smoothWidth.value = 0.6
      pipeline.outputNode = col.add(b)
    } else pipeline.outputNode = col
  }

  const t0 = performance.now()
  try {
    await preloadWarlock()
  } catch (e) {
    // keep the page alive: show the error and run the procedural style
    console.error(e)
    warlockParams.style = 'procedural'
    document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:absolute;bottom:8px;left:8px;max-width:60vw;white-space:pre-wrap">CC0 warlock failed to build, showing the procedural style:\n${String((e as Error)?.stack ?? e)}</pre>`)
  }
  const loadMs = performance.now() - t0
  const staffParam = params.get('staff') as StaffVariant | null
  if (staffParam) {
    warlockParams.staff = true
    warlockParams.staffVariant = staffParam
  }
  if (params.get('style')) warlockParams.style = params.get('style') as WarlockStyle
  if (params.get('wlook') === 'void') warlockParams.look = 'void'

  const actors: Actor[] = []
  const spawn = (i: number): Actor => {
    const pawn = newPawn(i)
    const a: Actor = {
      pawn,
      prev: structuredClone(pawn),
      w: createWarlock({ color: COLORS[i % COLORS.length] }),
      holder: new THREE.Group(),
      mode: (params.get('mode') as Mode) ?? 'idle',
      phase: (i * Math.PI * 2) / 7,
      dir: 1,
      pending: [],
      frameEvents: [],
      burning: false,
    }
    if (i > 0) {
      a.mode = 'circle'
      pawn.x = Math.cos(a.phase) * (250 + i * 40)
      pawn.y = Math.sin(a.phase) * (250 + i * 40)
    }
    a.holder.add(a.w.object3d)
    a.w.object3d.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true
    })
    scene.add(a.holder)
    actors.push(a)
    return a
  }
  const rebuild = () => {
    for (const a of actors) {
      a.w.dispose()
      a.w = createWarlock({ color: COLORS[a.pawn.id % COLORS.length] })
      a.holder.add(a.w.object3d)
    }
  }
  spawn(0)
  const n = Number(params.get('n') ?? 1)
  for (let i = 1; i < n; i++) spawn(i)
  const hero = () => actors[0]

  // ---------------------------------------------------------------- fake sim
  let tick = 0
  const emit = (a: Actor, e: SimEvent) => a.pending.push(e)
  const stepPawn = (a: Actor) => {
    const p = a.pawn
    a.prev = structuredClone(p)
    if (a.dieNext) {
      p.alive = false
      p.cast = null
      a.dieNext = false
    }
    // walk intent
    let wx = 0
    let wy = 0
    if (p.alive && !p.cast) {
      if (a.mode === 'circle') {
        const r = Math.max(120, Math.hypot(p.x, p.y))
        const ang = Math.atan2(p.y, p.x) + (a.dir * 210 * DT) / r
        const tx = Math.cos(ang) * 320
        const ty = Math.sin(ang) * 320
        const dx = tx - p.x
        const dy = ty - p.y
        const l = Math.hypot(dx, dy) || 1
        wx = (dx / l) * 210
        wy = (dy / l) * 210
      } else if (a.mode === 'treadmill' || a.mode === 'treadwalk') {
        // run / walk in place along the current facing (captures from fixed angles)
        const sp = a.mode === 'treadmill' ? 210 : 90
        wx = Math.cos(p.facing) * sp
        wy = Math.sin(p.facing) * sp
      } else if (a.mode === 'line' || a.mode === 'walk') {
        if (p.x > 380) a.dir = -1
        if (p.x < -380) a.dir = 1
        wx = a.dir * (a.mode === 'walk' ? 90 : 210)
      }
    }
    if (wx || wy) {
      // the sim turns first (1.2 rad / 0.03 s), then walks
      const want = Math.atan2(wy, wx)
      let d = want - p.facing
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      const turn = (1.2 / 0.03) * DT
      p.facing += Math.max(-turn, Math.min(turn, d))
      if (Math.abs(d) > 0.5) wx = wy = 0
    }
    const kbx = (p.vx - p.walkVx) * FRICTION
    const kby = (p.vy - p.walkVy) * FRICTION
    p.walkVx = wx
    p.walkVy = wy
    p.vx = kbx + wx
    p.vy = kby + wy
    const tread = a.mode === 'treadmill' || a.mode === 'treadwalk'
    p.x += (tread ? kbx : p.vx) * DT
    p.y += (tread ? kby : p.vy) * DT
    if (Math.hypot(p.x, p.y) > 1200) {
      p.x *= 0.5
      p.y *= 0.5
    }
    if (p.cast) {
      p.cast.ticksLeft -= 1
      if (p.cast.ticksLeft <= 0) {
        emit(a, { type: 'cast', pawn: p.id, spell: p.cast.spell, x: p.cast.x, y: p.cast.y })
        p.cast = null
      }
    }
    p.lavaTicks = a.burning && p.alive ? p.lavaTicks + 1 : 0
  }

  const ctl = {
    mode(m: Mode) {
      hero().mode = m
    },
    cast(spell = 'fireball', seconds = 0.2) {
      const a = hero()
      const p = a.pawn
      if (!p.alive) return
      if (p.cast) emit(a, { type: 'castCancel', pawn: p.id, spell: p.cast.spell, slot: 0, started: true })
      const ticks = Math.max(1, Math.round(seconds * 60))
      const tx = p.x + Math.cos(p.facing) * 500
      const ty = p.y + Math.sin(p.facing) * 500
      p.cast = { slot: 0, spell, ticksLeft: ticks, x: tx, y: ty, started: true }
      p.walkVx = p.walkVy = 0
      emit(a, { type: 'castStart', pawn: p.id, spell, ticks })
    },
    instant(spell = 'thrust') {
      const a = hero()
      emit(a, { type: 'cast', pawn: a.pawn.id, spell, x: 0, y: 0 })
    },
    cancel() {
      const a = hero()
      const p = a.pawn
      if (!p.cast) return
      emit(a, { type: 'castCancel', pawn: p.id, spell: p.cast.spell, slot: 0, started: true })
      p.cast = null
    },
    hit(kb = 300, fromAngle = Math.random() * Math.PI * 2) {
      const a = hero()
      const p = a.pawn
      const nx = -Math.cos(fromAngle)
      const ny = -Math.sin(fromAngle)
      p.vx += nx * kb
      p.vy += ny * kb
      emit(a, { type: 'damage', target: p.id, amount: 8, source: 9, x: p.x, y: p.y, kb })
    },
    death() {
      const a = hero()
      a.pawn.alive = false
      a.pawn.cast = null
      emit(a, { type: 'death', pawn: a.pawn.id, owner: a.pawn.owner, killer: null })
    },
    /** death with a sim cause (fireball etc. also push the pawn) */
    die(kind: DeathKind) {
      const a = hero()
      const p = a.pawn
      if (!p.alive) ctl.respawn()
      const causes: Record<DeathKind, string> = { ash: 'obstacle', lava: 'lava', fireball: 'fireball', meteor: 'meteor', lightning: 'lightning', freeze: 'snowball', gravity: 'gravity', drain: 'drain', shadow: 'scourge', fade: 'disconnect' }
      const kb = kind === 'fireball' || kind === 'meteor' || kind === 'gravity' ? 900 : 0
      if (kb) {
        p.vx += kb
        p.vy += 0
      }
      // like the sim: the pawn dies on the tick that carries the death event
      a.dieNext = true
      emit(a, { type: 'death', pawn: p.id, owner: p.owner, killer: null, cause: causes[kind], kb })
    },
    respawn() {
      const a = hero()
      a.pawn.alive = true
      emit(a, { type: 'respawn', pawn: a.pawn.id, owner: a.pawn.owner, x: a.pawn.x, y: a.pawn.y })
    },
    victory() {
      const a = hero()
      emit(a, { type: 'roundWin', team: 0, players: [a.pawn.owner] })
    },
    nextRound() {
      for (const a of actors) emit(a, { type: 'phase', phase: 'fight', round: 2 })
    },
    burn(on?: boolean) {
      hero().burning = on ?? !hero().burning
    },
    invuln(on?: boolean) {
      hero().pawn.invulnerable = on ?? !hero().pawn.invulnerable
    },
    style(s: WarlockStyle) {
      warlockParams.style = s
      rebuild()
    },
    staff(v: StaffVariant | null) {
      warlockParams.staff = !!v
      if (v) warlockParams.staffVariant = v
      for (const a of actors) a.w.setStaff(v)
    },
    castFrom(f: 'palm' | 'staff') {
      warlockParams.castFrom = f
      for (const a of actors) a.w.setCastFrom(f)
    },
    color(c: number) {
      hero().w.setColor(c)
    },
    view(v: 'close' | 'game' | 'side' | 'top') {
      view = v
      setView()
    },
    count(k: number) {
      while (actors.length < k) spawn(actors.length)
      while (actors.length > k) {
        const a = actors.pop()!
        a.w.dispose()
        a.holder.removeFromParent()
      }
    },
    turntable(on?: boolean) {
      turntable = on ?? !turntable
    },
    pause(on?: boolean) {
      paused = on ?? !paused
    },
    /** advance the sim + warlocks by s seconds right now (deterministic captures; pair with pause) */
    step(s: number) {
      for (let t = 0; t < s - 1e-6; t += 1 / 60) frameStep(1 / 60)
    },
    /** advance time by s seconds while paused (frame-exact screenshots) */
    advance(s: number) {
      pendingAdvance += s
    },
    studio(on?: boolean) {
      studio.visible = on ?? !studio.visible
    },
    splash(on?: boolean) {
      splashImg.style.display = (on ?? splashImg.style.display === 'none') ? 'block' : 'none'
    },
    /** visual progression: own the first n shop columns at `level` each (+ Fireball item) */
    build(n: number, level = 1) {
      const p = hero().pawn
      const cols = ['homing', 'swap', 'bouncer', 'snowball', 'rush', 'grip']
      p.slots = [...cols.map((id, i) => (i < n ? id : null)), 'fireball', 'scourge']
      p.levels = [...cols.map((_, i) => (i < n ? level : 0)), Math.min(7, level), 1]
    },
    /** level-up burst in the colour of the hero's last owned column spell */
    levelUp() {
      const p = hero().pawn
      const owned = p.slots.filter((x, i) => x && i < 6)
      const id = owned[owned.length - 1] ?? 'fireball'
      hero().w.levelUp(new THREE.Color().copy(getSpellColor(id).accent).getHex())
    },
    /** clipping debug colours (red = must be covered, green = legit through the split) */
    debugClip(on?: boolean) {
      clothParams.debugClip.value = (on ?? clothParams.debugClip.value < 0.5) ? 1 : 0
    },
    /** material look: 'readable' (default) | 'void' (the earlier near-black robe) */
    look(v: 'readable' | 'void') {
      warlockParams.look = v
    },
    /**
     * Readability lineup: 4 warlocks in a row in PLAYER_COLORS 0..3, facing
     * toward the camera / right / away / left, all idle, running in place or
     * holding a windup; camera = the match's gameplay camera (60 deg pitch,
     * 1100 units, 70 deg hfov on 4:3) over the group.
     */
    lineup(state: 'idle' | 'run' | 'cast') {
      ctl.count(4)
      const colors = [0xff3b30, 0x2e7bff, 0x14e0c8, 0xa24bff]
      const facings = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]
      actors.forEach((a, i) => {
        const p = a.pawn
        p.x = (i - 1.5) * 260
        p.y = 0
        p.vx = p.vy = p.walkVx = p.walkVy = 0
        p.facing = facings[i]
        p.cast = null
        p.alive = true
        a.mode = state === 'run' ? 'treadmill' : 'idle'
        a.w.setColor(colors[i])
        a.prev = structuredClone(p)
      })
      ctl.step(0.6)
      if (state === 'cast') {
        for (const a of actors) {
          const p = a.pawn
          const ticks = 54
          p.cast = { slot: 0, spell: 'fireball', ticksLeft: ticks, x: p.x + Math.cos(p.facing) * 500, y: p.y + Math.sin(p.facing) * 500, started: true }
          a.pending.push({ type: 'castStart', pawn: p.id, spell: 'fireball', ticks })
        }
        ctl.step(0.6)
      } else ctl.step(0.6)
      const pitch = (60 * Math.PI) / 180
      const d = 11
      camera.fov = 2 * Math.atan(Math.tan((35 * Math.PI) / 180) / (4 / 3)) * (180 / Math.PI)
      camera.updateProjectionMatrix()
      const ahead = d * 0.1
      camera.position.set(0, Math.sin(pitch) * d, Math.cos(pitch) * d - ahead)
      controls.target.set(0, 0, -ahead)
      controls.update()
      lastTarget.copy(hero().holder.position)
    },
    /** camera presets around the hero for captures (front / side / back / gameplay angle zoomed) */
    cam(preset: 'front' | 'side' | 'back' | 'game' | 'gameFar') {
      const a = hero()
      const pos = a.holder.position
      const f = a.pawn.facing
      const fx = Math.cos(f)
      const fz = -Math.sin(f)
      const pitch = (58 * Math.PI) / 180
      if (preset === 'front') camera.position.set(pos.x + fx * 3.6, pos.y + 1.0, pos.z + fz * 3.6)
      else if (preset === 'side') camera.position.set(pos.x - fz * 3.6, pos.y + 1.0, pos.z + fx * 3.6)
      else if (preset === 'back') camera.position.set(pos.x - fx * 3.6, pos.y + 1.0, pos.z - fz * 3.6)
      else {
        const dist = preset === 'game' ? 4.2 : 11
        camera.position.set(pos.x, pos.y + dist * Math.sin(pitch), pos.z + dist * Math.cos(pitch))
      }
      controls.target.set(pos.x, pos.y + (preset.startsWith('game') ? 0.55 : 0.7), pos.z)
      controls.update()
    },
    info() {
      const asset = getWarlockAsset()
      return { loadMs: Math.round(loadMs), triangles: asset?.triangles, fps: Math.round(fps), actors: actors.length, calls: renderer.info.render.drawCalls }
    },
  }
  ;(window as unknown as Record<string, unknown>).__wp = { ctl, actors, camera, controls, scene, renderer }

  // ---------------------------------------------------------------- UI
  const ui = document.createElement('div')
  ui.style.cssText = 'position:absolute;left:8px;top:8px;display:flex;flex-wrap:wrap;gap:4px;max-width:560px;font:12px ui-monospace,monospace'
  const btn = (label: string, fn: () => void) => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = 'background:#1d1822;color:#e8dcff;border:1px solid #4a3d5a;border-radius:4px;padding:4px 8px;cursor:pointer'
    b.onclick = fn
    ui.appendChild(b)
  }
  btn('idle', () => ctl.mode('idle'))
  btn('walk', () => ctl.mode('walk'))
  btn('run line', () => ctl.mode('line'))
  btn('run circle', () => ctl.mode('circle'))
  btn('cast', () => ctl.cast('fireball', 0.2))
  btn('long cast', () => ctl.cast('fireball', 0.9))
  btn('scourge', () => ctl.cast('scourge', 0.9))
  btn('instant', () => ctl.instant('thrust'))
  // one button per cast category (castStyles.ts)
  for (const [label, spell, secs] of [
    ['aoe:gravity', 'gravity', 0.6],
    ['sky:meteor', 'meteor', 0.6],
    ['buff:shield', 'shield', 0],
    ['ground:pillar', 'rockpillar', 0.4],
    ['beam:lightning', 'lightning', 0.5],
    ['move:teleport', 'teleport', 0],
  ] as const)
    btn(label, () => (secs > 0 ? ctl.cast(spell, secs) : ctl.instant(spell)))
  btn('cancel', () => ctl.cancel())
  btn('hit', () => ctl.hit(250))
  btn('knockback', () => ctl.hit(1100))
  btn('death', () => ctl.death())
  btn('respawn', () => ctl.respawn())
  btn('victory', () => ctl.victory())
  btn('next round', () => ctl.nextRound())
  btn('burn', () => ctl.burn())
  btn('invuln', () => ctl.invuln())
  btn('style', () => ctl.style(warlockParams.style === 'cc0' ? 'procedural' : 'cc0'))
  // known issue: the staff has no grip / animations yet (shelved, off by default)
  btn('staff (wip)', () => ctl.staff(warlockParams.staff ? null : warlockParams.staffVariant))
  btn('staff variant (wip)', () => {
    const order: StaffVariant[] = ['gnarled', 'iron', 'bone']
    ctl.staff(order[(order.indexOf(warlockParams.staffVariant) + 1) % order.length])
  })
  btn('cast from', () => ctl.castFrom(warlockParams.castFrom === 'palm' ? 'staff' : 'palm'))
  btn('color', () => ctl.color(COLORS[Math.floor(Math.random() * COLORS.length)]))
  btn('view', () => ctl.view(view === 'close' ? 'game' : view === 'game' ? 'side' : 'close'))
  btn('turntable', () => ctl.turntable())
  btn('freeze', () => ctl.pause())
  for (const n of [0, 2, 4, 6]) btn(`build ${n}`, () => ctl.build(n, 3))
  btn('levels max', () => ctl.build(6, 7))
  btn('level up', () => ctl.levelUp())
  btn('x10', () => ctl.count(actors.length === 1 ? 10 : 1))
  btn('studio light', () => ctl.studio())
  btn('splash', () => ctl.splash())
  btn('footprint', () => (warlockParams.debugFootprint = !warlockParams.debugFootprint))
  for (const k of ['ash', 'lava', 'fireball', 'lightning', 'freeze', 'gravity', 'drain', 'shadow', 'fade'] as DeathKind[]) btn(`die:${k}`, () => ctl.die(k))
  document.body.appendChild(ui)
  if (params.get('ui') === '0') ui.style.display = 'none'
  const hud = document.createElement('div')
  hud.style.cssText = 'position:absolute;right:8px;top:8px;font:12px ui-monospace,monospace;color:#ffd9b0;text-shadow:0 1px 2px #000;text-align:right;white-space:pre'
  document.body.appendChild(hud)
  if (params.get('ui') === '0') hud.style.display = 'none'
  const splashImg = document.createElement('img')
  splashImg.src = '/art/brand/splash.webp'
  splashImg.style.cssText = 'position:absolute;right:8px;bottom:8px;width:38vw;border:1px solid #4a3d5a;display:none'
  document.body.appendChild(splashImg)
  if (params.has('splash')) splashImg.style.display = 'block'

  // ---------------------------------------------------------------- camera
  let view = (params.get('view') as 'close' | 'game' | 'side' | 'top') ?? 'close'
  let turntable = params.has('turntable')
  let paused = false
  let pendingAdvance = 0
  const camOffset = new THREE.Vector3()
  const setView = () => {
    if (view === 'game') camOffset.set(0, Math.sin((58 * Math.PI) / 180), Math.cos((58 * Math.PI) / 180)).multiplyScalar(11)
    else if (view === 'side') camOffset.set(4.2, 1.2, 0)
    else if (view === 'top') camOffset.set(0, 9, 0.01)
    else camOffset.set(0, 1.1, 4.2)
    const target = hero().holder.position
    camera.position.copy(target).add(camOffset)
    controls.target.set(target.x, view === 'game' ? 0.6 : 0.95, target.z)
  }
  setView()

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  })

  let acc = 0
  let last = performance.now()
  let fps = 60
  let checking = false
  const lastTarget = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  /** advance the fake sim + warlocks by dt (render-frame semantics) */
  const frameStep = (dt: number) => {
    acc += dt
    for (const a of actors) a.frameEvents.length = 0
    while (acc >= DT) {
      acc -= DT
      tick++
      for (const a of actors) {
        stepPawn(a)
        // events emitted between ticks belong to this tick
        for (const e of a.pending) a.frameEvents.push(e)
        a.pending.length = 0
      }
    }
    const alpha = acc / DT
    const all: SimEvent[] = []
    for (const a of actors) for (const e of a.frameEvents) all.push(e)
    for (const a of actors) {
      const p = a.pawn
      const pr = a.prev
      a.holder.position.set((pr.x + (p.x - pr.x) * alpha) * S, 0, -(pr.y + (p.y - pr.y) * alpha) * S)
      a.w.update(p, pr, alpha, dt, all)
    }
  }
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    let dt = Math.min(0.1, (now - last) / 1000)
    last = now
    if (checking) return
    fps += (1 / Math.max(1e-3, dt) - fps) * 0.05
    if (paused) {
      dt = Math.min(pendingAdvance, 1 / 60)
      pendingAdvance -= dt
    }
    frameStep(dt)
    // camera follows the hero (orbit offsets preserved)
    const target = hero().holder.position
    const d = new THREE.Vector3().subVectors(target, lastTarget)
    camera.position.add(d)
    controls.target.add(d)
    lastTarget.copy(target)
    if (turntable && hero().mode === 'idle') {
      const off = camera.position.clone().sub(controls.target)
      off.applyAxisAngle(up, dt * 0.35)
      camera.position.copy(controls.target).add(off)
    }
    moon.target.position.copy(target)
    moon.position.copy(target).add(new THREE.Vector3(-0.42, 0.86, 0.3).multiplyScalar(20))
    lavaLight.position.set(target.x + 1.5, 0.3, target.z + 2.5)
    controls.update()
    pipeline.render()
    const hp = hero()
    hud.textContent = `${hp.w.style}  fps ${fps.toFixed(0)}  draws ${renderer.info.render.drawCalls}  tris ${getWarlockAsset()?.triangles ?? '-'} / warlock
charge ${hp.w.castCharge.toFixed(2)}  mode ${hp.mode}  kb ${Math.hypot(hp.pawn.vx - hp.pawn.walkVx, hp.pawn.vy - hp.pawn.walkVy).toFixed(0)}
load ${loadMs.toFixed(0)} ms`
  })

  // ---------------------------------------------------------------- clipping check
  // Robe-covered body parts render pure red (hips, thighs, lower spine: must never
  // show) or green (lower legs above the hem: legit through the front split);
  // everything else black. Scenarios run the real state machine; each sample is
  // rendered from 8 orbit angles + the gameplay camera and the pixels counted.
  const clipCheck = async (opts: { samplesPerSec?: number; size?: number } = {}) => {
    const sps = opts.samplesPerSec ?? 5
    // readback rows must be 256-byte aligned: size * 4 % 256 === 0
    const size = Math.ceil((opts.size ?? 192) / 64) * 64
    checking = true
    const rt = new THREE.RenderTarget(size, size)
    const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 60)
    const savedBg = scene.background
    scene.background = new THREE.Color(0)
    grid.visible = ground.visible = false
    clothParams.debugClip.value = 1
    const prevCount = actors.length
    ctl.count(1)
    const a = hero()
    const reset = () => {
      a.pawn.x = a.pawn.y = a.pawn.vx = a.pawn.vy = a.pawn.walkVx = a.pawn.walkVy = 0
      a.pawn.cast = null
      a.pawn.alive = true
      a.burning = false
      a.mode = 'idle'
      for (let i = 0; i < 60; i++) frameStep(DT)
    }
    type Sc = { name: string; dur: number; setup: () => void; every?: [number, () => void] }
    const scenarios: Sc[] = [
      { name: 'idle', dur: 2, setup: () => ctl.mode('idle') },
      { name: 'walk', dur: 3, setup: () => ctl.mode('walk') },
      { name: 'run line + 180 turns', dur: 6, setup: () => ctl.mode('line') },
      { name: 'run circle', dur: 3, setup: () => ctl.mode('circle') },
      { name: 'cast point (standing)', dur: 2.4, setup: () => ctl.cast('fireball', 0.2), every: [0.8, () => ctl.cast('fireball', 0.2)] },
      { name: 'cast long + cancel', dur: 1.6, setup: () => ctl.cast('fireball', 0.9), every: [0.6, () => ctl.cancel()] },
      { name: 'scourge slam', dur: 2.2, setup: () => ctl.cast('scourge', 0.9) },
      { name: 'hits while running', dur: 3, setup: () => ctl.mode('line'), every: [0.5, () => ctl.hit(300)] },
      { name: 'knockback tumble', dur: 2.2, setup: () => ctl.hit(1100, 0) },
      { name: 'knockback tumble from behind', dur: 2.2, setup: () => ctl.hit(1100, Math.PI / 2) },
    ]
    const views = [0, 45, 90, 135, 180, 225, 270, 315]
    const rows: string[] = []
    let worstRed = 0
    for (const sc of scenarios) {
      reset()
      sc.setup()
      let red = 0
      let green = 0
      let samples = 0
      const redByView = new Map<string, number>()
      let tAcc = 0
      let nextEvery = sc.every ? sc.every[0] : Infinity
      for (let t = 0; t < sc.dur; t += 1 / sps) {
        // advance in 60 Hz frames up to the sample time
        while (tAcc < t) {
          frameStep(DT)
          tAcc += DT
          if (tAcc >= nextEvery && sc.every) {
            sc.every[1]()
            nextEvery += sc.every[0]
          }
        }
        const pos = a.holder.position
        a.w.object3d.updateMatrixWorld(true)
        const yaw = Math.atan2(Math.cos(a.pawn.facing), -Math.sin(a.pawn.facing))
        for (const deg of [...views, -1]) {
          if (deg < 0) {
            // gameplay camera: 58 deg pitch, 11 m, looking north
            cam.position.set(pos.x, pos.y + 11 * Math.sin((58 * Math.PI) / 180), pos.z + 11 * Math.cos((58 * Math.PI) / 180))
            cam.fov = 12
          } else {
            const ang = yaw + (deg * Math.PI) / 180
            cam.position.set(pos.x + Math.sin(ang) * 3.4, pos.y + 1.0, pos.z + Math.cos(ang) * 3.4)
            cam.fov = 30
          }
          cam.updateProjectionMatrix()
          cam.lookAt(pos.x, pos.y + 0.55, pos.z)
          renderer.setRenderTarget(rt)
          renderer.render(scene, cam)
          renderer.setRenderTarget(null)
          const px = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size)) as Uint8Array
          let r = 0
          let gr = 0
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > 120 && px[i + 1] < 60) r++
            else if (px[i + 1] > 120 && px[i] < 60) gr++
          }
          red += r
          green += gr
          if (r > 0) {
            const k = deg < 0 ? 'game' : `${deg}deg`
            redByView.set(k, (redByView.get(k) ?? 0) + r)
          }
        }
        samples++
      }
      worstRed = Math.max(worstRed, red)
      const worst = [...redByView.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ')
      rows.push(`${sc.name.padEnd(30)} samples ${String(samples).padStart(3)}  red ${String(red).padStart(6)}  green ${String(green).padStart(6)}  ${worst}`)
    }
    clothParams.debugClip.value = 0
    scene.background = savedBg
    grid.visible = ground.visible = true
    rt.dispose()
    reset()
    ctl.count(prevCount)
    checking = false
    const report = `clip check (${size}px, ${sps}/s, 9 views)\n` + rows.join('\n') + `\nworst red pixels: ${worstRed}`
    console.log(report)
    return report
  }
  ;(window as unknown as Record<string, unknown>).__clipCheck = clipCheck

  /** top-down silhouette size (game units): orthographic view over the hero on white, bbox of covered pixels */
  const measureTopDown = async () => {
    const size = 512 // rows must be 256-byte aligned for the readback
    const span = 2.4 // metres
    const rt = new THREE.RenderTarget(size, size)
    const cam = new THREE.OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 0.1, 20)
    const pos = hero().holder.position
    cam.position.set(pos.x, 6, pos.z)
    cam.up.set(0, 0, -1)
    cam.lookAt(pos.x, 0, pos.z)
    const savedBg = scene.background
    scene.background = new THREE.Color(1, 1, 1)
    grid.visible = ground.visible = false
    const fp = warlockParams.debugFootprint
    warlockParams.debugFootprint = false
    for (const a of actors) a.w.update(a.pawn, a.prev, 1, 0, [])
    renderer.setRenderTarget(rt)
    renderer.render(scene, cam)
    renderer.setRenderTarget(null)
    const px = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size)) as Uint8Array
    let x0 = size
    let x1 = -1
    let y0 = size
    let y1 = -1
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        if (px[i] < 200 || px[i + 1] < 200 || px[i + 2] < 200) {
          x0 = Math.min(x0, x)
          x1 = Math.max(x1, x)
          y0 = Math.min(y0, y)
          y1 = Math.max(y1, y)
        }
      }
    scene.background = savedBg
    grid.visible = ground.visible = true
    warlockParams.debugFootprint = fp
    rt.dispose()
    const unitsPerPx = (span * 100) / size
    return { across: Math.round((x1 - x0 + 1) * unitsPerPx), deep: Math.round((y1 - y0 + 1) * unitsPerPx), height: Math.round(getWarlockAsset() ? 186.5 * 0.69 : 0) }
  }
  ;(window as unknown as Record<string, unknown>).__measure = measureTopDown
  btn('clip check', () => void clipCheck().then((r) => (hud.textContent = r)))
}

main().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:absolute;top:40px;left:8px">${String(e?.stack ?? e)}</pre>`)
  console.error(e)
})
