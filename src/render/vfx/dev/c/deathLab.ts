/**
 * Dev-only death / after-hit lab driver (VFX workstream C). Never imported by the game.
 * Runs the REAL sim with three players: P0 killer, P1 victim, P2 bystander (keeps the round
 * alive). Every cycle the victim is revived at its anchor and killed by the chosen cause,
 * through the real sim path where one exists (Fireball / Scourge casts, lava burn, pillar
 * explosion, disconnect) and receiveDamage(cause) for every other spell id.
 */
import { frame, pushEvents, pushState, resetFrame } from '../../../../game/frame'
import { DEFAULT_SETTINGS, cloneState, createMatch, step } from '../../../../sim'
import { damageObstacle, killPawn, receiveDamage } from '../../../../sim/combat'
import { FIREBALL_SLOT, SCOURGE_SLOT } from '../../../../sim/config'
import { DT, TICK_HZ, type PlayerInput, type PlayerSlot, type SimState } from '../../../../sim/types'
import { devCamera } from '../../../cameraRig'
import { devTime } from '../../../stats'

export const ALL_CAUSES = ['fireball', 'lava', 'scourge', 'obstacle', 'disconnect', 'homing', 'lightning', 'snowball', 'gravity', 'thrust', 'drain', 'meteor'] as const

const SLOTS: PlayerSlot[] = [
  { id: 0, name: 'Killer', color: 0xff5a36, team: 0, kind: 'human' },
  { id: 1, name: 'Victim', color: 0x3fa9ff, team: 1, kind: 'bot', difficulty: 'medium' },
  { id: 2, name: 'Bystander', color: 0x5fd35a, team: 2, kind: 'bot', difficulty: 'medium' },
]

export interface DeathLabOptions {
  causes: string[]
  every: number
  /** after-hit mode: hit (not kill) the victim with `causes` instead */
  hit: boolean
  victimColor?: number
}

export const labState = { label: '', deathTick: -1, hitTick: -1, tick: 0 }

export function startDeathLab(o: DeathLabOptions, onLabel: (s: string) => void): () => void {
  const slots = SLOTS.map((s, i) => (i === 1 && o.victimColor !== undefined ? { ...s, color: o.victimColor } : s))
  const settings = { ...DEFAULT_SETTINGS, shopSeconds: 1, winScore: 99 }
  const state: SimState = createMatch(settings, slots, 4242)
  resetFrame()
  frame.localPlayer = 0
  pushState(cloneState(state))
  let fightStart = -1
  let cycle = -1
  let killed = false
  let cause = o.causes[0]

  const pawnOf = (owner: number) => state.pawns.find((p) => p.owner === owner)!
  const anchor = (c: string) => (c === 'lava' ? { x: 1440, y: -120 } : c === 'scourge' ? { x: -170, y: 0 } : { x: 160, y: 0 })

  const setup = () => {
    cause = o.causes[cycle % o.causes.length]
    const k = pawnOf(0)
    const v = pawnOf(1)
    const b = pawnOf(2)
    const a = anchor(cause)
    k.x = cause === 'lava' ? 1100 : -300
    k.y = 0
    b.x = -200
    b.y = -800
    for (const p of [k, v, b]) {
      p.alive = true
      p.hp = p.maxHp
      p.vx = p.vy = p.walkVx = p.walkVy = 0
      p.moveTarget = null
      p.kbPoints = 0
      p.lavaTicks = 0
      p.cooldowns = p.cooldowns.map(() => 0)
    }
    v.x = a.x
    v.y = a.y
    v.facing = Math.PI
    k.facing = Math.atan2(v.y - k.y, v.x - k.x)
    state.obstacles = []
    devCamera.focus = { x: (a.x + k.x) / 2 + 60, y: a.y }
    killed = false
    labState.label = `${o.hit ? 'after-hit' : 'death'}: ${cause}`
    onLabel(labState.label)
  }

  const act = (inputs: PlayerInput[], T: number) => {
    const v = pawnOf(1)
    const k = pawnOf(0)
    if (killed || T < 0.4) return
    killed = true
    if (!o.hit) v.hp = 1.5
    const kill = !o.hit
    switch (cause) {
      case 'fireball':
        inputs.push({ player: 0, tick: state.tick, cmds: [{ kind: 'cast', slot: FIREBALL_SLOT, x: v.x, y: v.y }] })
        return
      case 'scourge':
        inputs.push({ player: 0, tick: state.tick, cmds: [{ kind: 'cast', slot: SCOURGE_SLOT, x: k.x, y: k.y }] })
        return
      case 'lava':
        // victim already stands on lava; the burn kills it (or keeps burning it in hit mode)
        if (o.hit) v.hp = v.maxHp
        return
      case 'obstacle': {
        const ob = { id: state.nextEntityId++, x: v.x - 140, y: v.y + 30, radius: 45, hp: 1, variant: 0 }
        state.obstacles.push(ob)
        damageObstacle(state, ob, 10)
        return
      }
      case 'disconnect':
        killPawn(state, v, null, 'disconnect', 0)
        return
      default: {
        const dx = v.x - k.x
        const dy = v.y - k.y
        const d = Math.hypot(dx, dy) || 1
        // context event so render can attribute the hit like a real projectile / beam
        if (cause === 'lightning') state.events.push({ type: 'beam', spell: 'lightning', owner: 0, fromX: k.x, fromY: k.y, toX: v.x, toY: v.y, target: v.id, blocked: false })
        else state.events.push({ type: 'projectileHit', id: -1, spell: cause, x: v.x - (dx / d) * 30, y: v.y - (dy / d) * 30, target: v.id })
        receiveDamage(state, v, { amount: kill ? 999 : 35, cause, source: 0, normal: { x: dx / d, y: dy / d } })
      }
    }
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
      const inputs: PlayerInput[] = []
      if (state.phase === 'fight') {
        if (fightStart < 0) fightStart = state.tick
        const T = (state.tick - fightStart) / TICK_HZ
        const c = Math.floor(T / o.every)
        if (c !== cycle) {
          cycle = c
          setup()
        }
        act(inputs, T - c * o.every)
        // keep the killer and bystander alive and topped up
        for (const p of state.pawns) if (p.owner !== 1) p.hp = p.maxHp
      }
      step(state, inputs)
      for (const e of state.events) {
        if (e.type === 'death' && e.owner === 1) labState.deathTick = state.tick
        if (e.type === 'damage' && state.pawns.find((p) => p.id === e.target)?.owner === 1) labState.hitTick = state.tick
      }
      labState.tick = state.tick
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
    devCamera.focus = null
  }
}
