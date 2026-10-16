/**
 * Dev preview driver running the REAL sim: createMatch + step at a fixed
 * 60 Hz accumulator (performance.now based, independent of the render rate),
 * the local player on slot 0 fed by game/input, bots from src/bots on the
 * other slots. Pushes snapshots and per-tick events into game/frame.ts just
 * like the offline session does. Every visual timing in render comes from
 * this state and its events.
 */
import { createBot, type Bot } from '../../bots'
import { frame, pushEvents, pushState, resetFrame } from '../../game/frame'
import { input } from '../../game/input'
import { DEFAULT_SETTINGS, cloneState, createMatch, step } from '../../sim'
import { DT, type BotDifficulty, type PlayerInput, type PlayerSlot } from '../../sim/types'
import { devTime } from '../stats'

const COLORS = [0xff5a36, 0x3fa9ff, 0x5fd35a, 0xc86bff, 0xffd23f, 0x2ee6c9, 0xff5fa8, 0xa3e048, 0xff8f3f, 0x8f9bff]
const NAMES = ['You', 'Frostbinder', 'Mossgrave', 'Hexweaver', 'Ashmonger', 'Tidecaller', 'Rosethorn', 'Bilecrown', 'Cinderjaw', 'Duskveil']

export function startSimDriver(opts: { bots?: number; difficulty?: BotDifficulty; shopSeconds?: number; seed?: number; teamMode?: 'ffa' | 'teams' | 'shuffle' } = {}): () => void {
  const nBots = Math.max(1, Math.min(9, opts.bots ?? 1))
  const slots: PlayerSlot[] = []
  for (let i = 0; i <= nBots; i++) {
    const team = opts.teamMode && opts.teamMode !== 'ffa' ? i % 2 : i
    slots.push({ id: i, name: NAMES[i], color: COLORS[i], team, kind: i === 0 ? 'human' : 'bot', difficulty: i === 0 ? undefined : opts.difficulty ?? 'medium' })
  }
  const seed = opts.seed ?? ((Math.random() * 1e9) | 0)
  const settings = { ...DEFAULT_SETTINGS, shopSeconds: opts.shopSeconds ?? 4, winScore: 5, teamMode: opts.teamMode ?? DEFAULT_SETTINGS.teamMode }
  const state = createMatch(settings, slots, seed)
  const bots: Bot[] = slots.filter((s) => s.kind === 'bot').map((s) => createBot(s.id, s.difficulty ?? 'medium', seed + s.id))
  resetFrame()
  frame.localPlayer = 0
  // dev handle: look-dev scripts may reposition pawns in the live sim state
  ;(window as unknown as Record<string, unknown>).__brawlockSim = state
  input.drain()
  pushState(cloneState(state))

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
      step(state, inputs)
      pushEvents(state.tick, state.events.slice())
      stepped = true
    }
    // one snapshot per rendered frame that advanced the sim: interpolation
    // then spans real elapsed time between snapshots
    if (stepped) pushState(cloneState(state), performance.now())
  }
  raf = requestAnimationFrame(loop)
  return () => {
    cancelAnimationFrame(raf)
    resetFrame()
    frame.localPlayer = -1
  }
}
