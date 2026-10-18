/**
 * Dev-only death / after-hit lab driver (VFX workstream C). Never imported by the game.
 * Runs the REAL sim: P0 killer, P1..Pn victims (n = 1..4, all dying in the same tick for
 * stacking tests), a bystander (keeps the round alive). Every cycle the victims are revived
 * at their anchors and killed by the chosen cause, through the real sim path where one exists
 * (Fireball / Scourge casts, lava burn, pillar explosion, disconnect) and receiveDamage(cause)
 * for every other spell id.
 */
import { frame, pushEvents, pushState, resetFrame } from '../../../../game/frame'
import { DEFAULT_SETTINGS, cloneState, createMatch, step } from '../../../../sim'
import { damageObstacle, killPawn, receiveDamage } from '../../../../sim/combat'
import { FIREBALL_SLOT, SCOURGE_SLOT } from '../../../../sim/config'
import { DT, TICK_HZ, type PawnState, type PlayerInput, type PlayerSlot, type SimState } from '../../../../sim/types'
import { devCamera } from '../../../cameraRig'
import { devTime } from '../../../stats'

export const ALL_CAUSES = ['fireball', 'lava', 'scourge', 'obstacle', 'disconnect', 'homing', 'lightning', 'snowball', 'gravity', 'thrust', 'drain', 'meteor'] as const

const VICTIM_COLORS = [0x3fa9ff, 0xc86bff, 0xffd23f, 0x3fe0d0]
/** victim offsets from the cause anchor (a tight cluster: worst case for stacking) */
const OFFS = [
  { x: 0, y: 0 },
  { x: 30, y: 120 },
  { x: 120, y: -50 },
  { x: -20, y: -130 },
]

export interface DeathLabOptions {
  causes: string[]
  every: number
  /** Cast any real ability without forcing damage/death (readability/cancel review). */
  castOnly?: boolean
  /** after-hit mode: hit (not kill) the victims with `causes` instead */
  hit: boolean
  victimColor?: number
  /** victims dying together, 1..4 */
  n?: number
  /** cancel the killer's windup (stop order) this many seconds after it started (Scourge fake) */
  cancelAfter?: number
  /** killer slot colour (default red) */
  killerColor?: number
  /** killer's Scourge level 1..3 (visual tiers) */
  level?: number
  /** Scourge: the victims cast it too, in the same tick (overlapping circles, caster identity) */
  allCast?: boolean
}

export const labState = { label: '', deathTick: -1, hitTick: -1, castTick: -1, tick: 0 }

export function startDeathLab(o: DeathLabOptions, onLabel: (s: string) => void): () => void {
  const n = Math.max(1, Math.min(4, o.n ?? 1))
  const slots: PlayerSlot[] = [{ id: 0, name: 'Killer', color: o.killerColor ?? 0xff5a36, team: 0, kind: 'human' }]
  for (let i = 0; i < n; i++) {
    const color = i === 0 && o.victimColor !== undefined ? o.victimColor : VICTIM_COLORS[i]
    slots.push({ id: i + 1, name: n === 1 ? 'Victim' : `Victim ${i + 1}`, color, team: i + 1, kind: 'bot', difficulty: 'medium' })
  }
  slots.push({ id: n + 1, name: 'Bystander', color: 0x5fd35a, team: n + 1, kind: 'bot', difficulty: 'medium' })
  const settings = { ...DEFAULT_SETTINGS, shopSeconds: 1, winScore: 99 }
  const state: SimState = createMatch(settings, slots, 4242)
  resetFrame()
  frame.localPlayer = 0
  pushState(cloneState(state))
  let fightStart = -1
  let cycle = -1
  let killed = false
  let cause = o.causes[0]
  const isVictim = (owner: number) => owner >= 1 && owner <= n

  const pawnOf = (owner: number) => state.pawns.find((p) => p.owner === owner)!
  const victims = () => state.pawns.filter((p) => isVictim(p.owner))
  const anchor = (c: string) => (c === 'lava' ? { x: 1620, y: -120 } : c === 'scourge' ? { x: -170, y: 0 } : { x: 160, y: 0 })

  const setup = () => {
    cause = o.causes[cycle % o.causes.length]
    const k = pawnOf(0)
    const b = pawnOf(n + 1)
    const a = anchor(cause)
    k.x = cause === 'lava' ? 1180 : -300
    k.y = 0
    b.x = -200
    b.y = -800
    for (const p of state.pawns) {
      p.alive = true
      p.hp = p.maxHp
      p.vx = p.vy = p.walkVx = p.walkVy = 0
      p.moveTarget = null
      p.kbPoints = 0
      p.lavaTicks = 0
      p.cooldowns = p.cooldowns.map(() => 0)
    }
    if (o.level) for (const p of state.pawns) p.levels[SCOURGE_SLOT] = Math.max(1, Math.min(3, o.level))
    victims().forEach((v, i) => {
      if (cause === 'scourge') {
        // ring around the killer, inside the Scourge radius (250); with allCast
        // further out so the circles overlap like a busy 8-player fight
        const ang = (i / n) * Math.PI * 2
        const rr = o.allCast ? 300 : 130
        v.x = k.x + Math.cos(ang) * rr
        v.y = k.y + Math.sin(ang) * rr
      } else {
        v.x = a.x + OFFS[i].x
        v.y = a.y + OFFS[i].y
      }
      v.facing = Math.atan2(k.y - v.y, k.x - v.x)
    })
    const v0 = pawnOf(1)
    k.facing = Math.atan2(v0.y - k.y, v0.x - k.x)
    state.obstacles = []
    devCamera.focus = { x: (a.x + k.x) / 2 + 60, y: a.y }
    killed = false
    labState.label = `${o.hit ? 'after-hit' : 'death'}: ${cause}${n > 1 ? ` x${n}` : ''}`
    onLabel(labState.label)
  }

  /** casts go in as inputs; direct sim calls run AFTER step() (step clears the event list) */
  let post: (() => void) | null = null
  const act = (inputs: PlayerInput[], T: number) => {
    if (killed || T < 0.4) return
    killed = true
    const k = pawnOf(0)
    if (!o.hit && !o.castOnly) for (const v of victims()) v.hp = 1.5
    if ((o.castOnly || ['fireball', 'snowball', 'twin', 'cluster', 'bouncer', 'boomerang'].includes(cause)) && cause !== 'scourge' && n === 1) {
      const v = pawnOf(1)
      const slot = cause === 'fireball' ? FIREBALL_SLOT : 0
      k.slots[slot] = cause
      k.levels[slot] = 1
      inputs.push({ player: 0, tick: state.tick, cmds: [{ kind: 'cast', slot, x: v.x, y: v.y }] })
    } else if (cause === 'scourge') {
      inputs.push({ player: 0, tick: state.tick, cmds: [{ kind: 'cast', slot: SCOURGE_SLOT, x: k.x, y: k.y }] })
      if (o.allCast) for (const v of victims()) inputs.push({ player: v.owner, tick: state.tick, cmds: [{ kind: 'cast', slot: SCOURGE_SLOT, x: v.x, y: v.y }] })
    } else if (cause === 'lava') {
      // victims stand on lava: the burn kills them (or keeps burning in hit mode)
      if (o.hit) for (const v of victims()) v.hp = v.maxHp
    } else {
      post = () => direct(k)
    }
  }

  const direct = (k: PawnState) => {
    if (cause === 'obstacle') {
      const v = pawnOf(1)
      const ob = { id: state.nextEntityId++, x: v.x - 140, y: v.y + 30, radius: 45, hp: 1, variant: 0 }
      state.obstacles.push(ob)
      damageObstacle(state, ob, 10)
      return
    }
    for (const v of victims()) {
      if (cause === 'disconnect') {
        killPawn(state, v, null, 'disconnect', 0)
        continue
      }
      const dx = v.x - k.x
      const dy = v.y - k.y
      const d = Math.hypot(dx, dy) || 1
      // context event so render can attribute the hit like a real projectile / beam
      if (cause === 'lightning') state.events.push({ type: 'beam', spell: 'lightning', owner: 0, fromX: k.x, fromY: k.y, toX: v.x, toY: v.y, target: v.id, blocked: false })
      else state.events.push({ type: 'projectileHit', id: -1, spell: cause, x: v.x - (dx / d) * 30, y: v.y - (dy / d) * 30, target: v.id })
      // same 35 damage in both modes: victims sit at 1.5 HP to die, so kb stays realistic
      receiveDamage(state, v, { amount: 35, cause, source: 0, normal: { x: dx / d, y: dy / d } })
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
      if (o.cancelAfter !== undefined && labState.castTick >= 0 && state.tick - labState.castTick === Math.round(o.cancelAfter * TICK_HZ)) {
        inputs.push({ player: 0, tick: state.tick, cmds: [{ kind: 'stop' }] })
      }
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
        for (const p of state.pawns) if (!isVictim(p.owner)) p.hp = p.maxHp
      }
      step(state, inputs)
      if (post) {
        post()
        post = null
      }
      for (const e of state.events) {
        if (e.type === 'death' && isVictim(e.owner)) labState.deathTick = state.tick
        if (e.type === 'castStart' && e.pawn === pawnOf(0).id) labState.castTick = state.tick
        if (e.type === 'damage' && isVictim(state.pawns.find((p) => p.id === e.target)?.owner ?? -1)) labState.hitTick = state.tick
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
