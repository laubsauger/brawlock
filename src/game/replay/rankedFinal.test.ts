import { describe, expect, it } from 'vitest'
import { cloneState, createMatch, DEFAULT_SETTINGS, step } from '../../sim'
import type { PlayerInput, PlayerSlot } from '../../sim/types'
import { decodeReplay, encodeReplay } from './format'
import { ReplayPlayer } from './player'
import { ReplayRecorder, replayHash } from './recorder'

describe('ranked final replay', () => {
  it('preserves finalist eligibility, equipment, terminal winner and deterministic seeking across the final', async () => {
    const slots: PlayerSlot[] = [0, 1, 2].map((id) => ({ id, name: `Player ${id}`, kind: 'human', team: id, color: id + 1 }))
    const state = createMatch({ ...DEFAULT_SETTINGS, rankedRounds: 5, startGold: 100 }, slots, 11)
    // Start recording at the real boundary after five scheduled scoring rounds.
    state.round = 5
    state.phase = 'roundEnd'
    state.phaseTicksLeft = 1
    state.tick = 1000
    state.scores.forEach((score, i) => { score.score = i < 2 ? 2 : 1 })
    state.pawns[0].levels[6] = 3
    const recorder = new ReplayRecorder()
    recorder.begin({ localPlayer: 2, slots, settings: state.settings, seed: 11 })
    const hashes = new Map([[state.tick, replayHash(state)]])
    const phase = () => state.phase
    let fightAt = -1
    for (let i = 0; i < 3600 && phase() !== 'gameOver'; i++) {
      const inputs: PlayerInput[] = []
      if (phase() === 'fight' && fightAt < 0) {
        fightAt = state.tick
        inputs.push({ player: 1, tick: state.tick, cmds: [{ kind: 'move', x: 100000, y: 100000 }] })
      }
      recorder.step(state, inputs)
      step(state, inputs)
      recorder.observe(state, state.events)
      hashes.set(state.tick, replayHash(state))
    }
    expect(state.phase).toBe('gameOver')
    expect(state.round).toBe(6)
    expect(state.rankedFinal).toEqual({ contenders: [0, 1], winners: [0] })
    expect(state.scores.map((s) => s.score)).toEqual([2, 2, 1])
    expect(state.pawns[2].alive).toBe(false)
    expect(state.pawns[0].levels[6]).toBe(3)
    const data = recorder.finish('ranked-final', 'ranked-test', [0])!
    const decoded = (await decodeReplay(await encodeReplay(data)))!
    const player = new ReplayPlayer(decoded, 'ranked-test')
    while (!player.done) {
      player.stepOnce()
      expect(replayHash(player.state)).toBe(hashes.get(player.tick))
    }
    expect(player.desync).toBeNull()
    expect(player.state.rankedFinal).toEqual(state.rankedFinal)
    for (const tick of [1000, fightAt, data.endTick, fightAt - 1, data.endTick]) {
      player.seek(tick)
      expect(replayHash(player.state)).toBe(hashes.get(tick))
    }
    const copy = cloneState(player.state)
    copy.rankedFinal!.contenders.push(2)
    expect(player.state.rankedFinal!.contenders).toEqual([0, 1])
  })
})
