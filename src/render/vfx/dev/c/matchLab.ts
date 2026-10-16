/**
 * Dev-only 8-player bot match for palette review (VFX workstream C): every pawn is a bot
 * (player 0 too, so the camera follows a fighting pawn), slot colours from the standard
 * PLAYER_COLORS or the colourblind set, so before/after screenshots show the exact
 * display result of game/playerPalette.displayColor. Never imported by the game.
 */
import { createBot, type Bot } from '../../../../bots'
import { frame, pushEvents, pushState, resetFrame } from '../../../../game/frame'
import { PLAYER_COLORS_CB } from '../../../../game/playerPalette'
import { PLAYER_COLORS } from '../../../../net/session'
import { DEFAULT_SETTINGS, cloneState, createMatch, step } from '../../../../sim'
import { DT, TICK_HZ, type PlayerInput, type PlayerSlot } from '../../../../sim/types'
import { devTime } from '../../../stats'

export const matchState = { fightT: -1 }

export function startMatchLab(o: { n: number; cb: boolean; seed: number }): () => void {
  const pal = o.cb ? PLAYER_COLORS_CB : PLAYER_COLORS
  const slots: PlayerSlot[] = []
  for (let i = 0; i < o.n; i++) slots.push({ id: i, name: `Bot ${i + 1}`, color: pal[i], team: i, kind: 'bot', difficulty: 'hard' })
  const state = createMatch({ ...DEFAULT_SETTINGS, shopSeconds: 1, winScore: 99 }, slots, o.seed)
  const bots: Bot[] = slots.map((s) => createBot(s.id, 'hard', o.seed + s.id))
  resetFrame()
  frame.localPlayer = 0
  pushState(cloneState(state))
  let fightStart = -1
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
      for (const b of bots) {
        const c = b.think(state)
        if (c.length > 0) inputs.push({ player: b.player, tick: state.tick, cmds: c })
      }
      step(state, inputs)
      if (state.phase === 'fight' && fightStart < 0) fightStart = state.tick
      matchState.fightT = fightStart < 0 ? -1 : (state.tick - fightStart) / TICK_HZ
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
