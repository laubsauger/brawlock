/**
 * Showcase: the simulation side of one shot (no three / DOM, so shots can be
 * tuned in node with `npx vite-node scripts/showcase/tune.ts <shot>`).
 *
 * Runs the REAL sim like the VFX labs (render/vfx/dev/grant.ts, a/labDriverA.ts):
 * spells are granted straight into this private SimState copy and the action is
 * scripted with ordinary input commands, so nothing in src/sim changes. A hidden
 * bystander keeps the round alive when the last dummy dies (it is stripped from
 * the snapshots the renderer sees).
 */
import { createBot, type Bot } from '../../bots'
import { DEFAULT_SETTINGS, FIREBALL_SLOT, SCOURGE_SLOT, cloneState, createMatch, isLocationSafe, step } from '../../sim'
import { SPELLS } from '../../sim/spells/data'
import { TICK_HZ, type BotDifficulty, type InputCommand, type ObstacleState, type PawnState, type PlayerInput, type PlayerSlot, type ProjectileState, type SimEvent, type SimState } from '../../sim/types'

export interface PlayerDef {
  name: string
  color: number
  team?: number
  /** AI driven (finale); absent = scripted dummy */
  bot?: BotDifficulty
}

export const COLORS = {
  ember: 0xff5a36,
  azure: 0x3fa9ff,
  moss: 0x5fd35a,
  violet: 0xc86bff,
  gold: 0xffd23f,
  teal: 0x3fe0d0,
  rose: 0xff6fb5,
  ice: 0xa0a0ff,
  lime: 0x9bff5a,
  amber: 0xffa040,
}

export interface SimShotSpec {
  players: PlayerDef[]
  seed?: number
  /** obstacle/tile theme 0 temple, 1 volcanic, 2 overgrown */
  theme?: number
  /** arena layer (radius = (layer - 1) * 100); default: what the sim picks */
  layer?: number
  /** keep the round's random pillars (default: cleared) */
  pillars?: boolean
  /** let the arena shrink on its own timer (default: frozen) */
  shrink?: boolean
  /** stay in the shop phase (combat off, shop ward) */
  shop?: boolean
  /** add the hidden bystander (default true for scripted shots) */
  bystander?: boolean
  /** fast-forward this many sim seconds after the fight starts before the shot begins */
  ffwd?: number
  /** default spell level for grants */
  level?: number
  /** everyone (bots) gets these spells at `level` */
  kit?: string[]
  /** per-player spells (granted after `kit`, before any fast-forward) */
  kits?: Record<number, string[]>
  teamMode?: 'ffa' | 'teams'
  /** runs once when the shot clock starts (fight running, pawns placed) */
  setup?(s: ShotSim): void
  /** [sim seconds, action] in any order */
  script?: [number, (s: ShotSim) => void][]
  /** every sim tick before the step (fast-forward included) */
  tick?(s: ShotSim): void
}

const BYSTANDER_ID = 9
/** far out in the lava, out of every spell's reach (its HP is refilled every tick) */
const BYSTANDER_AT = { x: 0, y: -5200 }

export class ShotSim {
  readonly state: SimState
  /** clone of the previous tick's state (render interpolation) */
  prev: SimState
  /** clone of the current state (what render sees) */
  curr: SimState
  /** tick the shot clock started */
  t0 = 0
  readonly bots: Bot[] = []
  readonly log: { st: number; e: SimEvent }[] = []
  /** events of the last step */
  events: SimEvent[] = []
  private inputs: PlayerInput[] = []
  private post: (() => void)[] = []
  private cues: [number, (s: ShotSim) => void][]
  private cueIdx = 0
  readonly level: number
  readonly hidden = new Set<number>()

  constructor(readonly spec: SimShotSpec) {
    this.level = spec.level ?? 4
    const slots: PlayerSlot[] = spec.players.map((p, i) => ({
      id: i,
      name: p.name,
      color: p.color,
      team: p.team ?? i,
      kind: p.bot ? 'bot' : i === 0 ? 'human' : 'bot',
      difficulty: p.bot ?? 'dummy',
    }))
    const bystander = spec.bystander ?? !spec.players.some((p) => p.bot)
    if (bystander) {
      slots.push({ id: BYSTANDER_ID, name: 'Bystander', color: 0x808080, team: BYSTANDER_ID, kind: 'bot', difficulty: 'dummy' })
      this.hidden.add(BYSTANDER_ID)
    }
    const seed = spec.seed ?? 4242
    const settings = {
      ...DEFAULT_SETTINGS,
      shopSeconds: spec.shop ? 999 : 0.05,
      winScore: 99,
      teamMode: spec.teamMode ?? ('ffa' as const),
    }
    const state = createMatch(settings, slots, seed)
    this.state = state
    for (const p of spec.players) {
      const i = spec.players.indexOf(p)
      if (p.bot) this.bots.push(createBot(i, p.bot, seed + i * 7919))
    }
    if (spec.theme !== undefined) state.arena.theme = spec.theme
    if (!spec.pillars) state.obstacles = []
    if (!spec.shop) {
      let guard = 0
      while (state.phase !== 'fight' && guard++ < 600) step(state, [])
      if (!spec.shrink) state.arena.nextShrinkTick = -1
    }
    if (spec.layer !== undefined) state.arena.layer = spec.layer
    if (spec.theme !== undefined) state.arena.theme = spec.theme
    if (!spec.pillars) state.obstacles = []
    for (const p of state.pawns) {
      if (p.owner === BYSTANDER_ID) {
        p.x = BYSTANDER_AT.x
        p.y = BYSTANDER_AT.y
        continue
      }
      // no 2 s spawn invulnerability bubble in the showcase
      p.invulnerable = false
      p.modifiers = p.modifiers.filter((m) => m.id !== 'spawnInvulnerable')
    }
    if (spec.kit) for (const p of state.pawns) if (p.owner !== BYSTANDER_ID) for (const sp of spec.kit) this.grant(p.owner, sp)
    if (spec.kits) for (const [owner, list] of Object.entries(spec.kits)) for (const sp of list) this.grant(Number(owner), sp)
    for (const sc of state.scores) sc.gold = 999
    if (spec.ffwd && spec.ffwd > 0) {
      const n = Math.round(spec.ffwd * TICK_HZ)
      for (let i = 0; i < n; i++) this.stepOnce(false)
    }
    this.cues = (spec.script ?? []).slice().sort((a, b) => a[0] - b[0])
    this.t0 = state.tick
    spec.setup?.(this)
    this.curr = this.snapshot()
    this.prev = this.curr
  }

  /** sim seconds since the shot clock started */
  get st(): number {
    return (this.state.tick - this.t0) / TICK_HZ
  }

  pawn(owner: number): PawnState {
    const p = this.state.pawns.find((q) => q.owner === owner)
    if (!p) throw new Error(`no pawn ${owner}`)
    return p
  }

  /** newest live projectile of a spell (optionally by owner / kind) */
  proj(spell: string, owner?: number, kind?: string): ProjectileState | undefined {
    let best: ProjectileState | undefined
    for (const p of this.state.projectiles) {
      if (p.spell !== spell) continue
      if (owner !== undefined && p.owner !== owner) continue
      if (kind !== undefined && (p.kind ?? p.spell) !== kind) continue
      if (!best || p.id > best.id) best = p
    }
    return best
  }

  /** teleport a pawn (setup only), facing `face` radians or toward (0, 0) */
  put(owner: number, x: number, y: number, face?: number): void {
    const p = this.pawn(owner)
    p.x = x
    p.y = y
    p.vx = p.vy = p.walkVx = p.walkVy = 0
    p.moveTarget = null
    p.facing = face ?? Math.atan2(-y, -x)
    p.alive = true
    p.hp = p.maxHp
    p.kbPoints = 0
  }

  /** distance from the centre to the platform edge along `angle` (radians) */
  edge(angle: number): number {
    let r = 0
    while (r < 6000 && isLocationSafe(this.state, Math.cos(angle) * (r + 10), Math.sin(angle) * (r + 10))) r += 10
    return r
  }

  safe(x: number, y: number): boolean {
    return isLocationSafe(this.state, x, y)
  }

  /** face a point (no turn delay for the next cast) */
  face(owner: number, x: number, y: number): void {
    const p = this.pawn(owner)
    p.facing = Math.atan2(y - p.y, x - p.x)
  }

  /** Put `spell` into its slot (column for shop spells, kit / item slots otherwise). Returns the slot. */
  grant(owner: number, spell: string, level = this.level): number {
    const def = SPELLS[spell]
    const pawn = this.pawn(owner)
    if (!def) throw new Error(`unknown spell ${spell}`)
    let slot: number
    if (spell === 'fireball') slot = FIREBALL_SLOT
    else if (spell === 'scourge') slot = SCOURGE_SLOT
    else if (def.kind === 'spell') slot = def.column - 1
    else {
      slot = pawn.slots.indexOf(spell)
      if (slot < 0) slot = pawn.slots.findIndex((s, i) => i > SCOURGE_SLOT && s === null)
    }
    if (slot < 0) throw new Error(`no slot for ${spell}`)
    pawn.slots[slot] = spell
    pawn.levels[slot] = Math.max(1, Math.min(def.maxLevel, level))
    pawn.cooldowns[slot] = 0
    return slot
  }

  cmd(owner: number, c: InputCommand): void {
    this.inputs.push({ player: owner, tick: this.state.tick, cmds: [c] })
  }

  /** cast `spell` at a point (granted on the fly, cooldown cleared) */
  cast(owner: number, spell: string, x: number, y: number, level?: number): void {
    const slot = this.grant(owner, spell, level)
    this.cmd(owner, { kind: 'cast', slot, x, y })
  }

  /** cast at another pawn's current position, optionally leading it by `lead` units of its velocity-seconds */
  castAt(owner: number, spell: string, target: number, level?: number): void {
    const t = this.pawn(target)
    this.cast(owner, spell, t.x, t.y, level)
  }

  move(owner: number, x: number, y: number): void {
    this.cmd(owner, { kind: 'move', x, y })
  }

  stop(owner: number): void {
    this.cmd(owner, { kind: 'stop' })
  }

  hp(owner: number, v: number): void {
    this.pawn(owner).hp = v
  }

  /** run after the next step (direct sim calls; step() clears the event list) */
  after(fn: () => void): void {
    this.post.push(fn)
  }

  addObstacle(x: number, y: number, radius: number, variant = 0, hp = 400): ObstacleState {
    const ob: ObstacleState = { id: this.state.nextEntityId++, x, y, radius, hp, variant }
    this.state.obstacles.push(ob)
    return ob
  }

  /** entity ids of hidden pawns */
  private get hiddenIds(): Set<number> {
    const ids = new Set<number>()
    for (const p of this.state.pawns) if (this.hidden.has(p.owner)) ids.add(p.id)
    return ids
  }

  /** events about a hidden pawn (the bystander's lava burn) never reach the renderer */
  private aboutHidden(e: SimEvent): boolean {
    const ids = this.hiddenIds
    if ('target' in e && typeof e.target === 'number' && ids.has(e.target) && e.type !== 'projectileHit' && e.type !== 'beam') return true
    if ('pawn' in e && typeof e.pawn === 'number' && ids.has(e.pawn)) return true
    if (e.type === 'death' && this.hidden.has(e.owner)) return true
    return false
  }

  /** what render sees: the hidden bystander stripped */
  snapshot(): SimState {
    const c = cloneState(this.state)
    if (this.hidden.size > 0) c.pawns = c.pawns.filter((p) => !this.hidden.has(p.owner))
    return c
  }

  /** advance one tick: cues, bots, hooks, step. Returns the tick's events. */
  stepOnce(scripted = true): SimEvent[] {
    const s = this.state
    if (scripted) {
      const st = this.st
      while (this.cueIdx < this.cues.length && this.cues[this.cueIdx][0] <= st + 1e-9) {
        this.cues[this.cueIdx][1](this)
        this.cueIdx++
      }
    }
    // tick hooks also run while fast-forwarding, so a fast-forwarded shot replays the same match
    this.spec.tick?.(this)
    for (const b of this.bots) {
      const c = b.think(s)
      if (c.length > 0) this.inputs.push({ player: b.player, tick: s.tick, cmds: c })
    }
    const inputs = this.inputs
    this.inputs = []
    step(s, inputs)
    const post = this.post
    this.post = []
    for (const fn of post) fn()
    // keep the hidden bystander parked and alive
    for (const p of s.pawns) {
      if (!this.hidden.has(p.owner)) continue
      p.x = BYSTANDER_AT.x
      p.y = BYSTANDER_AT.y
      p.vx = p.vy = p.walkVx = p.walkVy = 0
      p.hp = p.maxHp
      p.alive = true
    }
    this.events = this.hiddenIds.size > 0 ? s.events.filter((e) => !this.aboutHidden(e)) : s.events.slice()
    if (scripted) for (const e of this.events) this.log.push({ st: this.st, e })
    this.prev = this.curr
    this.curr = this.snapshot()
    return this.events
  }
}
