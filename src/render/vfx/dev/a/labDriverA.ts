/**
 * Dev-only VFX lab driver (spell VFX workstream A). Runs the REAL sim like
 * render/dev/simDriver.ts, but grants unreleased spells straight into pawn
 * slots (bypassing the shop's RELEASED_SPELLS gate, lab only) and drives the
 * pawns from a looping script so every spell can be watched (and
 * screenshotted) in a known setup. Dummies keep full HP and walk back home.
 *
 * Never imported by the game: only by vfx/dev/a/labA.tsx.
 */
import { frame, pushEvents, pushState, resetFrame } from '../../../../game/frame'
import { DEFAULT_SETTINGS, cloneState, createMatch, step } from '../../../../sim'
import { DT, type InputCommand, type PawnState, type PlayerInput, type PlayerSlot, type SimState } from '../../../../sim/types'
import { devTime } from '../../../stats'

const COLORS = [0xff5a36, 0x3fa9ff, 0x5fd35a, 0xc86bff, 0xffd23f, 0x3fe0d0, 0xff6fb5, 0xa0a0ff, 0x9bff5a, 0xffa040]
const NAMES = ['You', 'Dummy A', 'Dummy B', 'Dummy C', 'Ally', 'Bot 5', 'Bot 6', 'Bot 7', 'Bot 8', 'Bot 9']

/** fixed slot per lab spell (fireball 6 / scourge 7 stay where the sim puts them) */
const SLOT: Record<string, number> = {
  boomerang: 0,
  cluster: 0,
  lightning: 1,
  drain: 1,
  homing: 2,
  bouncer: 2,
  twin: 3,
  recharge: 3,
  thrust: 4,
  swap: 5,
  fireball: 6,
  scourge: 7,
  redirector: 8,
  pact: 9,
  teleport: 10,
  shield: 11,
  // dummies only (never cast thrust)
  alteration: 4,
}

export const LAB_SPELLS = ['boomerang', 'lightning', 'homing', 'twin', 'thrust', 'swap', 'cluster', 'drain', 'bouncer', 'recharge', 'redirector', 'pact'] as const

/** lab layout is shifted off the arena centre (keeps the action clear of centre props) */
const OFF = { x: -150, y: -560 }

/** P0 caster, three enemy dummies, one ally (local coords, + OFF in the world) */
const HOME = [
  { x: -420, y: -40 },
  { x: 300, y: 0 },
  { x: 180, y: 400 },
  { x: 260, y: -420 },
  { x: -480, y: 380 },
]

interface Lab {
  state: SimState
  queue: { at: number; player: number; cmd: InputCommand }[]
  /** tick the current script loop started */
  t0: number
  label: string
}

type Step = [delayTicks: number, fn: (lab: Lab) => void, label?: string]

function pawn(s: SimState, player: number): PawnState | undefined {
  return s.pawns.find((p) => p.owner === player)
}

/** spell level granted in the lab (&lvl=1..7; default 3) */
let LAB_LEVEL = 3

function grant(s: SimState, player: number, spell: string, level = LAB_LEVEL): number {
  const p = pawn(s, player)
  const slot = SLOT[spell]
  if (!p || slot === undefined) return -1
  p.slots[slot] = spell
  p.levels[slot] = level
  p.cooldowns[slot] = 0
  return slot
}

function cast(lab: Lab, player: number, spell: string, x: number, y: number): void {
  const slot = grant(lab.state, player, spell)
  if (slot >= 0) lab.queue.push({ at: lab.state.tick, player, cmd: { kind: 'cast', slot, x: x + OFF.x, y: y + OFF.y } })
}

/** cast already facing the target (no turn: several casters fire on the same tick) */
function castFacing(lab: Lab, player: number, spell: string, x: number, y: number): void {
  const p = pawn(lab.state, player)
  if (p) p.facing = Math.atan2(y + OFF.y - p.y, x + OFF.x - p.x)
  cast(lab, player, spell, x, y)
}

const at = (i: number) => HOME[i]

/** teleport a pawn (lab setup) */
function put(lab: Lab, i: number, x: number, y: number): void {
  const p = pawn(lab.state, i)
  if (!p) return
  p.x = x + OFF.x
  p.y = y + OFF.y
  p.vx = p.vy = p.walkVx = p.walkVy = 0
  p.moveTarget = null
}

function home(lab: Lab): void {
  for (let i = 0; i < HOME.length; i++) {
    const p = pawn(lab.state, i)
    if (!p) continue
    p.x = HOME[i].x + OFF.x
    p.y = HOME[i].y + OFF.y
    p.vx = p.vy = p.walkVx = p.walkVy = 0
    p.moveTarget = null
    p.facing = i === 0 ? 0 : Math.PI
  }
}

/** One looping demo per spell. Delays are ticks after the previous step. */
const SCRIPTS: Record<string, Step[]> = {
  boomerang: [
    [10, (l) => cast(l, 0, 'boomerang', at(1).x, at(1).y), 'boomerang -> A (hit, returns)'],
    [170, (l) => cast(l, 0, 'boomerang', -60, -360), 'boomerang -> empty (full arc)'],
    [170, () => {}],
  ],
  lightning: [
    [10, (l) => put(l, 0, -180, -20), 'lightning: caster in range'],
    [4, (l) => cast(l, 0, 'lightning', at(1).x, at(1).y), 'lightning -> A'],
    [70, (l) => cast(l, 0, 'lightning', -40, 380), 'lightning -> miss (full range)'],
    [60, (l) => cast(l, 3, 'shield', at(3).x, at(3).y), 'C shields'],
    [8, (l) => cast(l, 0, 'lightning', at(3).x, at(3).y), 'lightning -> blocked by bubble'],
    [70, (l) => put(l, 0, -180, -20), 'fireball, then lightning detonates it'],
    [2, (l) => cast(l, 0, 'fireball', at(2).x, at(2).y)],
    // after the fireball has left the hand (a new order would cancel its cast point)
    [22, (l) => cast(l, 0, 'lightning', at(2).x, at(2).y)],
    [80, () => {}],
  ],
  /** Lightning verification: open ground, warlock, Shield, Alteration, three bolts in one tick */
  lightningx: [
    [10, (l) => put(l, 0, -180, -20), 'lightningx: open ground (full range)'],
    [4, (l) => castFacing(l, 0, 'lightning', -40, 380)],
    [60, (l) => castFacing(l, 0, 'lightning', at(1).x, at(1).y), 'lightningx: on a warlock'],
    [60, (l) => cast(l, 3, 'shield', at(3).x, at(3).y), 'lightningx: on Shield'],
    [4, (l) => castFacing(l, 0, 'lightning', at(3).x, at(3).y)],
    [60, (l) => cast(l, 2, 'alteration', at(2).x, at(2).y), 'lightningx: on Alteration'],
    [4, (l) => castFacing(l, 0, 'lightning', at(2).x, at(2).y)],
    [70, (l) => {
      // three casters, same tick: P0 and the ally at A, dummy C at P0
      castFacing(l, 0, 'lightning', at(1).x, at(1).y)
      castFacing(l, 4, 'lightning', at(1).x, at(1).y)
      castFacing(l, 3, 'lightning', -180, -20)
    }, 'lightningx: three bolts in one tick'],
    [70, (l) => put(l, 0, -180, -20), 'lightningx: fireball detonation (r225)'],
    [2, (l) => castFacing(l, 0, 'fireball', at(1).x, at(1).y)],
    [24, (l) => castFacing(l, 0, 'lightning', at(1).x, at(1).y)],
    [80, () => {}],
  ],
  homing: [
    [10, (l) => cast(l, 0, 'homing', at(2).x, at(2).y), 'homing -> B (seeks)'],
    [120, (l) => cast(l, 0, 'homing', at(1).x, at(1).y), 'homing + thrust into it (burnout)'],
    [16, (l) => cast(l, 0, 'thrust', at(1).x, at(1).y)],
    [110, (l) => cast(l, 0, 'homing', at(1).x, at(1).y), 'homing + teleport ahead (self-detonation)'],
    [17, (l) => cast(l, 0, 'teleport', -80, -25)],
    [130, () => {}],
  ],
  twin: [
    [10, (l) => cast(l, 0, 'twin', at(1).x, at(1).y), 'twin -> A (long, flat arcs)'],
    [100, (l) => cast(l, 0, 'twin', -200, -40), 'twin -> short (wide arcs)'],
    [130, () => {}],
  ],
  thrust: [
    [10, (l) => cast(l, 0, 'thrust', at(1).x, at(1).y), 'thrust -> A (slam)'],
    [100, (l) => cast(l, 0, 'thrust', -100, -420), 'thrust -> empty (brake)'],
    [100, () => {}],
  ],
  swap: [
    [10, (l) => cast(l, 0, 'swap', at(1).x, at(1).y), 'swap with A'],
    [90, (l) => cast(l, 0, 'swap', -100, 300), 'swap -> empty (blink)'],
    [90, () => {}],
  ],
  cluster: [
    [10, (l) => put(l, 0, -200, -20), 'cluster: caster in range (672)'],
    [4, (l) => cast(l, 0, 'cluster', at(1).x, at(1).y), 'cluster -> A'],
    [90, (l) => cast(l, 0, 'cluster', -100, -460), 'cluster -> miss'],
    [90, () => {}],
  ],
  drain: [
    [10, (l) => cast(l, 0, 'drain', at(2).x, at(2).y), 'drain -> B (slow + heal orb)'],
    [150, (l) => cast(l, 0, 'drain', at(4).x, at(4).y), 'drain -> ally (heal + haste)'],
    [150, () => {}],
  ],
  bouncer: [
    [10, (l) => cast(l, 0, 'bouncer', at(1).x, at(1).y), 'bouncer -> A (ricochets)'],
    [260, () => {}],
  ],
  recharge: [
    [10, (l) => cast(l, 0, 'recharge', at(1).x, at(1).y), 'recharge -> A (streak, refresh orb)'],
    [110, (l) => cast(l, 0, 'recharge', at(1).x, at(1).y), 'recharge again (streak 2)'],
    [110, (l) => cast(l, 0, 'recharge', at(2).x, at(2).y), 'recharge again (streak 3)'],
    [110, (l) => cast(l, 0, 'recharge', -100, -460), 'recharge miss (streak reset)'],
    [90, () => {}],
  ],
  redirector: [
    [10, (l) => cast(l, 0, 'fireball', at(3).x, at(3).y), 'fireball -> C, redirect toward B'],
    [22, (l) => cast(l, 0, 'redirector', at(2).x, at(2).y)],
    [120, (l) => cast(l, 0, 'boomerang', -60, -360), 'boomerang, redirect toward A'],
    [26, (l) => cast(l, 0, 'redirector', at(1).x, at(1).y)],
    [150, () => {}],
  ],
  pact: [
    [10, (l) => cast(l, 0, 'pact', at(1).x, at(1).y), 'pact (armed)'],
    [90, (l) => cast(l, 0, 'fireball', at(1).x, at(1).y), 'fireball consumes pact -> slow'],
    [200, () => {}],
  ],
}

export interface LabOptions {
  /** spell id, 'all' to cycle every lab spell, or 'chaos' */
  spell: string
  /** chaos mode: total players (2..10), each spamming random lab spells */
  chaos?: number
  /** keep the round's random pillars (default: cleared so scripted shots fly clean) */
  pillars?: boolean
  /** dummies start at 5 HP and are not healed: the first hit kills (death VFX) */
  lethal?: boolean
  /** level of every granted spell (1..7) */
  level?: number
  /** freeze (devTime.scale = 0) `ticks` after script step `step` runs in the first loop */
  freeze?: { step: number; ticks: number } | null
  /** capture schedule: freeze at these ticks after step 0 of the first loop (one after another) */
  shotsAt?: number[]
}

/** Console / capture handles: __labA.ctl.freezeIn(12), __labA.ctl.resume(0.3) */
export const labControl = {
  freezeAt: -1,
  tick: 0,
  /** tick the first script loop started (step 0), -1 before */
  t0: -1,
  /** completed script loops */
  loops: 0,
  /** events of the first script loop: [tick - t0, type, spell, extra] */
  log: [] as [number, string, string, number][],
  /** pending freezes (absolute ticks, ascending) */
  pending: [] as number[],
  /** set while frozen by a scheduled shot; shots = freezes so far */
  frozen: false,
  shots: 0,
  freezeIn(ticks: number): void {
    labControl.freezeAt = labControl.tick + ticks
    if (devTime.scale === 0) devTime.scale = 0.3
  },
  resume(scale = 0.3): void {
    labControl.frozen = false
    devTime.scale = scale
  },
}

export function startLabDriver(opts: LabOptions, onLabel?: (s: string) => void): () => void {
  const chaos = opts.spell === 'chaos'
  LAB_LEVEL = Math.max(1, Math.min(7, opts.level ?? 3))
  const n = chaos ? Math.max(2, Math.min(10, opts.chaos ?? 10)) : HOME.length
  const slots: PlayerSlot[] = []
  for (let i = 0; i < n; i++) {
    // lab: P0 + ally on team 0, dummies on team 1 (chaos: free for all)
    const team = chaos ? i : i === 0 || i === 4 ? 0 : 1
    slots.push({ id: i, name: NAMES[i], color: COLORS[i], team, kind: i === 0 ? 'human' : 'bot', difficulty: 'dummy' })
  }
  const settings = { ...DEFAULT_SETTINGS, teamMode: chaos ? ('ffa' as const) : ('teams' as const), shopSeconds: 1, winScore: 999 }
  const state = createMatch(settings, slots, 1234)
  const lab: Lab = { state, queue: [], t0: -1, label: '' }
  resetFrame()
  frame.localPlayer = 0
  pushState(cloneState(state))

  const order = opts.spell === 'all' ? [...LAB_SPELLS] : [opts.spell]
  let scriptIdx = 0
  let stepIdx = 0
  let nextAt = -1
  let fightAt = -1
  let rng = 99

  const rand = () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff
    return rng / 0x7fffffff
  }

  const director = () => {
    const s = state
    if (s.phase !== 'fight') {
      fightAt = -1
      return
    }
    if (fightAt < 0) {
      fightAt = s.tick
      // lab: clear random pillars out of the scripted lines of fire
      if (!chaos && !opts.pillars) s.obstacles.length = 0
      if (!chaos) home(lab)
      nextAt = s.tick + 20
      stepIdx = 0
      return
    }
    s.arena.nextShrinkTick = -1
    for (const p of s.pawns) {
      if (!p.alive) continue
      // lab: no 2 s spawn invulnerability wait
      if (p.invulnerable) {
        p.invulnerable = false
        p.modifiers = p.modifiers.filter((m) => m.id !== 'spawnInvulnerable')
      }
      // dummies (and everyone in the lab) never die: keep HP topped up (unless &lethal)
      if (opts.lethal && p.owner !== 0) {
        if (s.tick === fightAt + 1) p.hp = 5
      } else p.hp = p.maxHp
      if (chaos) continue
      const i = p.owner
      if (i === 0 || i >= HOME.length) continue
      const hx = HOME[i].x + OFF.x
      const hy = HOME[i].y + OFF.y
      const sp = Math.hypot(p.vx - p.walkVx, p.vy - p.walkVy)
      const far = Math.hypot(p.x - hx, p.y - hy)
      if (sp < 40 && far > 60 && !p.cast) p.moveTarget = { x: hx, y: hy }
    }
    if (chaos) {
      for (const p of s.pawns) {
        if (!p.alive || p.cast || rand() > 0.03) continue
        const others = s.pawns.filter((q) => q.alive && q.owner !== p.owner)
        if (others.length === 0) continue
        const t = others[Math.floor(rand() * others.length)]
        const sp = LAB_SPELLS[Math.floor(rand() * LAB_SPELLS.length)]
        const slot = grant(s, p.owner, sp)
        if (slot >= 0) lab.queue.push({ at: s.tick, player: p.owner, cmd: { kind: 'cast', slot, x: t.x + (rand() - 0.5) * 120, y: t.y + (rand() - 0.5) * 120 } })
        // keep them roughly in the middle
        if (Math.hypot(p.x, p.y) > 900 && !p.cast) p.moveTarget = { x: (rand() - 0.5) * 600, y: (rand() - 0.5) * 600 }
      }
      return
    }
    if (s.tick < nextAt) return
    const script = SCRIPTS[order[scriptIdx % order.length]]
    if (!script) return
    if (stepIdx >= script.length) {
      stepIdx = 0
      scriptIdx++
      labControl.loops++
      home(lab)
      nextAt = s.tick + 30
      return
    }
    const [, fn, label] = script[stepIdx]
    if (label) {
      lab.label = `${order[scriptIdx % order.length]}: ${label}`
      onLabel?.(lab.label)
    }
    if (scriptIdx === 0 && stepIdx === 0 && labControl.t0 < 0) {
      labControl.t0 = s.tick
      if (opts.shotsAt) for (const t of opts.shotsAt) labControl.pending.push(s.tick + t)
      labControl.pending.sort((a, b) => a - b)
    }
    fn(lab)
    if (opts.freeze && scriptIdx === 0 && stepIdx === opts.freeze.step) labControl.freezeAt = s.tick + opts.freeze.ticks
    stepIdx++
    const nxt = stepIdx < script.length ? script[stepIdx][0] : 0
    nextAt = s.tick + nxt
  }

  let acc = 0
  let last = performance.now()
  let raf = 0
  const loop = () => {
    raf = requestAnimationFrame(loop)
    const now = performance.now()
    acc += Math.min(0.25, (now - last) / 1000) * devTime.scale
    last = now
    let stepped = false
    let guard = 0
    while (acc >= DT && guard++ < 8) {
      acc -= DT
      labControl.tick = state.tick
      if (labControl.freezeAt >= 0 && state.tick >= labControl.freezeAt) {
        labControl.freezeAt = -1
        devTime.scale = 0
        acc = 0
        break
      }
      if (labControl.pending.length > 0 && state.tick >= labControl.pending[0]) {
        labControl.pending.shift()
        labControl.frozen = true
        labControl.shots++
        devTime.scale = 0
        acc = 0
        break
      }
      director()
      const inputs: PlayerInput[] = []
      const due = lab.queue.filter((q) => q.at <= state.tick)
      lab.queue = lab.queue.filter((q) => q.at > state.tick)
      for (const q of due) inputs.push({ player: q.player, tick: state.tick, cmds: [q.cmd] })
      step(state, inputs)
      if (labControl.t0 >= 0 && labControl.loops === 0) {
        for (const e of state.events) {
          const rel = state.tick - labControl.t0
          if (e.type === 'cast' || e.type === 'castStart') labControl.log.push([rel, e.type, e.spell, e.pawn])
          else if (e.type === 'damage') labControl.log.push([rel, 'damage', '', e.target])
          else if (e.type === 'death') labControl.log.push([rel, 'death', e.cause ?? '', e.pawn])
          else if (e.type === 'modifier') labControl.log.push([rel, e.on ? 'modOn' : 'modOff', e.id, e.pawn])
          else if (e.type === 'heal') labControl.log.push([rel, 'heal', '', e.target])
          else if (e.type === 'beam') labControl.log.push([rel, e.blocked ? 'beamBlocked' : 'beam', e.spell, e.target ?? -1])
          else if ('spell' in e && typeof e.spell === 'string') labControl.log.push([rel, e.type, e.spell, 'id' in e ? (e.id as number) : -1])
        }
      }
      pushEvents(state.tick, state.events.slice())
      stepped = true
    }
    if (stepped) pushState(cloneState(state), performance.now())
  }
  raf = requestAnimationFrame(loop)
  return () => {
    cancelAnimationFrame(raf)
    resetFrame()
    frame.localPlayer = -1
  }
}
