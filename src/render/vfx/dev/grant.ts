/**
 * Dev-only spell grant + scripted casts for VFX look-dev (never imported by the app).
 * Spells that are not in RELEASED_SPELLS cannot be bought, so the lab driver writes them
 * straight into its OWN SimState copy (pawn.slots / levels / cooldowns). No sim code changes.
 *
 * Lab page: /src/render/vfx/dev/b/labB.html  (see b/labB.tsx for every URL param)
 *   ?grant=meteor,shield&lvl=7          every pawn owns these spells (one per shop column)
 *   &script=1:meteor:t0;0:shield:self:0.6   cycle of scripted casts  caster:spell:target[:delay s]
 *        target = t<player> (that pawn's position), self, or <x>_<y> (game units)
 *   &every=3                            cycle length, seconds (sim time)
 *   &place=-350_0,350_0                 pawn anchors per player id; re-placed + healed each cycle
 *   &ai=0                               bots stand still (only the script casts)
 */
import { createBot, type Bot } from '../../../bots'
import { frame, pushEvents, pushState, resetFrame } from '../../../game/frame'
import { input } from '../../../game/input'
import { DEFAULT_SETTINGS, cloneState, createMatch, step } from '../../../sim'
import { SPELLS } from '../../../sim/spells/data'
import { DT, TICK_HZ, type BotDifficulty, type InputCommand, type PlayerInput, type PlayerSlot, type SimState } from '../../../sim/types'
import { devTime } from '../../stats'

/** Put `spell` into its shop column slot for `player` (ready to cast). Returns the slot or -1. */
export function grantSpell(state: SimState, player: number, spell: string, level: number): number {
  const def = SPELLS[spell]
  const pawn = state.pawns.find((p) => p.owner === player)
  if (!def || !pawn) return -1
  const slot = def.kind === 'spell' ? def.column - 1 : pawn.slots.indexOf(spell)
  if (slot < 0) return -1
  pawn.slots[slot] = spell
  pawn.levels[slot] = Math.max(1, Math.min(def.maxLevel, level))
  pawn.cooldowns[slot] = 0
  return slot
}

export interface ScriptStep {
  caster: number
  spell: string
  target: { kind: 'pawn'; id: number } | { kind: 'self' } | { kind: 'point'; x: number; y: number }
  delay: number
}

export function parseScript(s: string | null): ScriptStep[] {
  if (!s) return []
  const out: ScriptStep[] = []
  for (const part of s.split(';')) {
    const [c, spell, t = 'self', d = '0'] = part.split(':')
    if (!spell) continue
    let target: ScriptStep['target'] = { kind: 'self' }
    if (t.startsWith('t')) target = { kind: 'pawn', id: Number(t.slice(1)) }
    else if (t.includes('_')) {
      const [x, y] = t.split('_').map(Number)
      target = { kind: 'point', x, y }
    }
    out.push({ caster: Number(c), spell, target, delay: Number(d) || 0 })
  }
  return out
}

const COLORS = [0xff5a36, 0x3fa9ff, 0x5fd35a, 0xc86bff]
const NAMES = ['You', 'Frostbinder', 'Mossgrave', 'Hexweaver']

export interface LabOptions {
  bots: number
  difficulty: BotDifficulty
  grant: string[]
  level: number
  script: ScriptStep[]
  every: number
  place: { x: number; y: number }[]
  ai: boolean
  /** 'teams' puts player 0 and 1 on one team (ally view tests) */
  teams: boolean
}

export function labOptionsFromUrl(params: URLSearchParams): LabOptions {
  const place = (params.get('place') ?? '')
    .split(',')
    .filter(Boolean)
    .map((p) => {
      const [x, y] = p.split('_').map(Number)
      return { x, y }
    })
  return {
    bots: Number(params.get('bots') ?? 1),
    difficulty: (params.get('bot') as BotDifficulty | null) ?? 'medium',
    grant: (params.get('grant') ?? '').split(',').filter(Boolean),
    level: Number(params.get('lvl') ?? 4),
    script: parseScript(params.get('script')),
    every: Number(params.get('every') ?? 3),
    place,
    ai: params.get('ai') !== '0',
    teams: params.has('allies'),
  }
}

/** Real sim + bots like render/dev/simDriver, plus grants, anchors and scripted casts. */
export function startLabDriver(o: LabOptions): () => void {
  const nBots = Math.max(1, Math.min(3, o.bots))
  const slots: PlayerSlot[] = []
  for (let i = 0; i <= nBots; i++) {
    const team = o.teams && i === 1 ? 0 : i
    slots.push({ id: i, name: NAMES[i], color: COLORS[i], team, kind: i === 0 ? 'human' : 'bot', difficulty: i === 0 ? undefined : o.difficulty })
  }
  const seed = 12345
  const settings = { ...DEFAULT_SETTINGS, shopSeconds: 1, winScore: 99, teamMode: o.teams ? ('teams' as const) : ('ffa' as const) }
  const state = createMatch(settings, slots, seed)
  const bots: Bot[] = o.ai ? slots.filter((s) => s.kind === 'bot').map((s) => createBot(s.id, o.difficulty, seed + s.id)) : []
  resetFrame()
  frame.localPlayer = 0
  input.drain()
  pushState(cloneState(state))
  let fightStart = -1
  // dev probe: sim seconds since the fight started (screenshot scripts wait on it)
  ;(window as unknown as Record<string, unknown>).__lab = { state, t: () => (fightStart < 0 ? -1 : (state.tick - fightStart) / TICK_HZ) }

  let lastCycleT = -1
  const placeAll = () => {
    for (const p of state.pawns) {
      const a = o.place[p.owner]
      if (!a) continue
      p.x = a.x
      p.y = a.y
      p.vx = p.vy = p.walkVx = p.walkVy = 0
      p.moveTarget = null
      p.hp = p.maxHp
      p.kbPoints = 0
      p.facing = Math.atan2(-a.y, -a.x)
    }
  }
  const scriptCmds = (inputs: PlayerInput[]) => {
    if (state.phase !== 'fight') {
      fightStart = -1
      return
    }
    if (fightStart < 0) {
      fightStart = state.tick
      lastCycleT = -1
    }
    for (const p of state.pawns) for (const g of o.grant) if (p.slots[SPELLS[g]?.column - 1] !== g) grantSpell(state, p.owner, g, o.level)
    const T = (state.tick - fightStart) / TICK_HZ
    const ct = T % o.every
    if (ct < lastCycleT) placeAll()
    if (lastCycleT < 0) placeAll()
    for (const s of o.script) {
      if (!(s.delay > lastCycleT && s.delay <= ct) && !(lastCycleT < 0 && s.delay === 0)) continue
      const pawn = state.pawns.find((p) => p.owner === s.caster)
      if (!pawn || !pawn.alive) continue
      const slot = grantSpell(state, s.caster, s.spell, o.level)
      if (slot < 0) continue
      let x = pawn.x + Math.cos(pawn.facing) * 200
      let y = pawn.y + Math.sin(pawn.facing) * 200
      if (s.target.kind === 'point') {
        x = s.target.x
        y = s.target.y
      } else if (s.target.kind === 'pawn') {
        const id = s.target.id
        const t = state.pawns.find((p) => p.owner === id)
        if (t) {
          x = t.x
          y = t.y
        }
      }
      const cmd: InputCommand = { kind: 'cast', slot, x, y }
      inputs.push({ player: s.caster, tick: state.tick, cmds: [cmd] })
    }
    lastCycleT = ct
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
      const cmds = input.drain()
      if (cmds.length > 0) inputs.push({ player: 0, tick: state.tick, cmds })
      for (const b of bots) {
        const c = b.think(state)
        if (c.length > 0) inputs.push({ player: b.player, tick: state.tick, cmds: c })
      }
      scriptCmds(inputs)
      step(state, inputs)
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
