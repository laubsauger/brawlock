import { cloneState, createMatch, DEFAULT_SETTINGS, FIREBALL_SLOT, isLocationSafe, spellDef, step, TICK_HZ, type InputCommand, type PlayerSlot, type SimState } from '../sim'

export const PRACTICE_STEPS = ['move', 'fireball', 'shop', 'teleport', 'lava'] as const
export type PracticeStep = typeof PRACTICE_STEPS[number] | 'complete'
export interface PracticeView {
  step: PracticeStep
  target: { x: number; y: number } | null
  retries: number
}
const TELEPORT = spellDef('teleport')
if (!TELEPORT) throw new Error('The practice lesson requires Teleport.')
export const TELEPORT_SLOT = TELEPORT.column - 1
const TELEPORT_COST = TELEPORT.cost
const WALK_TARGET = { x: -300, y: 180 }
const BLINK_TARGET = { x: -120, y: 320 }

/** Private offline lesson. Real movement, purchases, projectiles and lava; no match recorder. */
export class PracticeScenario {
  state: SimState
  view: PracticeView = { step: 'move', target: WALK_TARGET, retries: 0 }
  private lavaHit = false

  constructor(player: { name: string; color: number | null; cosmetics?: PlayerSlot['cosmetics'] | null }) {
    const slots: PlayerSlot[] = [
      { id: 0, name: player.name, color: player.color ?? 0xff7700, kind: 'human', team: 0, ...(player.cosmetics ? { cosmetics: player.cosmetics } : {}) },
      { id: 1, name: 'Training dummy', color: 0x2e7bff, kind: 'bot', difficulty: 'dummy', team: 1 },
    ]
    this.state = createMatch({ ...DEFAULT_SETTINGS, shopSeconds: 0, winScore: 99, startGold: TELEPORT_COST,
      roundGold: 0, killGold: 0, winGold: 0, spectatorBets: false, bounties: false }, slots, 34519)
    for (let i = 0; i < 3 && this.state.phase !== 'fight'; i++) step(this.state, [])
    if (this.state.phase !== 'fight') throw new Error('Practice could not enter combat.')
    this.state.arena.layer = 9
    this.state.arena.nextShrinkTick = -1
    this.state.obstacles = []
    this.state.events = []
    this.place(0, -300, 0)
    this.place(1, 180, 0)
  }

  private place(owner: number, x: number, y: number): void {
    const pawn = this.state.pawns.find((p) => p.owner === owner)
    if (!pawn) throw new Error('Practice pawn is missing.')
    Object.assign(pawn, { x, y, vx: 0, vy: 0, walkVx: 0, walkVy: 0, alive: true, hp: pawn.maxHp,
      kbPoints: 0, invulnerable: false, moveTarget: null, cast: null, lastHitter: null, lavaTicks: 0 })
    pawn.modifiers = []
    pawn.cooldowns.fill(0)
  }

  private advance(next: PracticeStep): void {
    this.state.projectiles = []
    const local = this.state.pawns.find((p) => p.owner === 0)!
    local.cast = null
    local.moveTarget = null
    local.cooldowns.fill(0)
    if (next === 'shop' || next === 'complete') {
      this.state.phase = 'shop'
      this.state.phaseTicksLeft = 2
    } else this.state.phase = 'fight'
    if (next === 'lava') {
      // One stationary, vulnerable target just inside the real tile boundary.
      this.place(0, 480, 0)
      this.place(1, 820, 0)
      if (!isLocationSafe(this.state, 820, 0)) throw new Error('Practice target must start on solid ground.')
      this.lavaHit = false
    }
    const target = next === 'move' ? WALK_TARGET : next === 'teleport' ? BLINK_TARGET
      : next === 'fireball' ? { x: this.state.pawns[1].x, y: this.state.pawns[1].y }
        : next === 'lava' ? { x: 820, y: 0 } : null
    this.view = { ...this.view, step: next, target }
  }

  tick(commands: InputCommand[]): void {
    this.state = cloneState(this.state)
    const phase = this.view.step
    if (phase === 'shop' || phase === 'complete') this.state.phaseTicksLeft = 2 // No lesson deadline.
    // The lesson exposes only its current tool; normal matches keep their own rules.
    const allowed = commands.filter((cmd) => {
      if (phase === 'complete') return false
      if (phase === 'shop') return cmd.kind === 'buySpell' && cmd.spell === 'teleport'
      if (cmd.kind === 'move' || cmd.kind === 'stop') return true
      return cmd.kind === 'cast' && (phase === 'teleport' ? cmd.slot === TELEPORT_SLOT
        : (phase === 'fireball' || phase === 'lava') && cmd.slot === FIREBALL_SLOT)
    })
    step(this.state, [{ player: 0, tick: this.state.tick, cmds: allowed }])
    // Short retries are explicit practice rules, never written to match settings.
    for (const pawn of this.state.pawns) for (let i = 0; i < pawn.cooldowns.length; i++) pawn.cooldowns[i] = Math.min(pawn.cooldowns[i], 2 * TICK_HZ)
    const local = this.state.pawns.find((p) => p.owner === 0)!
    const dummy = this.state.pawns.find((p) => p.owner === 1)!
    if (!local.alive) {
      this.place(0, phase === 'lava' ? 480 : -300, 0)
      this.state.phase = phase === 'shop' || phase === 'complete' ? 'shop' : 'fight'
      this.state.phaseTicksLeft = 2
      this.state.events = this.state.events.filter((e) => e.type !== 'roundWin' && e.type !== 'gameOver')
      this.view = { ...this.view, retries: this.view.retries + 1 }
      return
    }
    if (phase === 'move' && Math.hypot(local.x - WALK_TARGET.x, local.y - WALK_TARGET.y) < 55) this.advance('fireball')
    else if (phase === 'fireball' && this.state.events.some((e) => e.type === 'damage' && e.target === dummy.id && e.source === 0 && e.cause === 'fireball')) this.advance('shop')
    else if (phase === 'shop' && this.state.events.some((e) => e.type === 'purchase' && e.player === 0 && e.id === 'teleport')) this.advance('teleport')
    else if (phase === 'teleport' && this.state.events.some((e) => e.type === 'teleport' && e.pawn === local.id && Math.hypot(e.toX - BLINK_TARGET.x, e.toY - BLINK_TARGET.y) < 70)) this.advance('lava')
    else if (phase === 'lava') {
      if (this.state.events.some((e) => e.type === 'damage' && e.target === dummy.id && e.source === 0 && e.cause === 'fireball')) this.lavaHit = true
      if (this.lavaHit && this.state.events.some((e) => e.type === 'death' && e.owner === 1 && e.killer === 0 && e.cause === 'lava')) this.advance('complete')
      else if (!dummy.alive) {
        this.place(1, 820, 0)
        this.lavaHit = false
        this.state.phase = 'fight'
        this.view = { ...this.view, retries: this.view.retries + 1 }
      }
    }
  }
}
