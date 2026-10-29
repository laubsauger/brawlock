import { describe, expect, it } from 'vitest'
import { createMatch, DEFAULT_SETTINGS, step, ticks } from '../../sim'
import type { PlayerInput, PlayerSlot } from '../../sim/types'
import { decodeReplay, encodeReplay } from './format'
import { ReplayPlayer } from './player'
import { ReplayRecorder, replayHash } from './recorder'

describe('Shop Ready replay', () => {
  it('reproduces a shop cut by Ready tick for tick, fight start included', async () => {
    // a replay that missed the cut would start the fight 20 s late and desync everything after it
    const slots: PlayerSlot[] = [0, 1].map((id) => ({ id, name: `Player ${id}`, kind: 'human', team: id, color: id + 1 }))
    const state = createMatch({ ...DEFAULT_SETTINGS }, slots, 7)
    const recorder = new ReplayRecorder()
    recorder.begin({ localPlayer: 0, slots, settings: state.settings, seed: 7 })
    const hashes = new Map([[state.tick, replayHash(state)]])
    const readyAt = ticks(2)
    let fightAt = -1
    for (let i = 0; i < ticks(12); i++) {
      const inputs: PlayerInput[] = state.tick === readyAt
        ? [0, 1].map((player) => ({ player, tick: state.tick, cmds: [{ kind: 'shopReady' as const, ready: true }] }))
        : []
      recorder.step(state, inputs)
      step(state, inputs)
      recorder.observe(state, state.events)
      hashes.set(state.tick, replayHash(state))
      if (state.phase === 'fight' && fightAt < 0) fightAt = state.tick
    }
    expect(fightAt).toBe(readyAt + ticks(4))
    const data = recorder.finish('shop-ready', 'shop-ready-test', [])!
    const player = new ReplayPlayer((await decodeReplay(await encodeReplay(data)))!, 'shop-ready-test')
    let replayFight = -1
    while (!player.done) {
      player.stepOnce()
      expect(replayHash(player.state)).toBe(hashes.get(player.tick))
      if (player.state.phase === 'fight' && replayFight < 0) replayFight = player.tick
    }
    expect(player.desync).toBeNull()
    expect(replayFight).toBe(fightAt)
  })
})
