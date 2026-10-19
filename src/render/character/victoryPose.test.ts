import { describe, expect, it } from 'vitest'
import { ROUND_END_SECONDS, ticks } from '../../sim/config'
import { roundWon } from '../../sim/mode'
import { fight, run } from '../../sim/testkit'
import { newVictoryPose, sampleVictoryPose, victoryStyle, type VictoryStyle } from './victoryPose'

const STYLES: VictoryStyle[] = ['dance', 'summon', 'flourish', 'ascendant', 'revel']

describe('round winner poses', () => {
  it('cycles all three styles per winner without random state or simulation mutations', () => {
    for (const owner of [0, 3, 9]) {
      const sequence = [1, 2, 3].map((round) => victoryStyle(round, owner))
      expect(new Set(sequence).size).toBe(3)
      expect([4, 5, 6].map((round) => victoryStyle(round, owner))).toEqual(sequence)
    }
    expect(victoryStyle(1, 0)).not.toBe(victoryStyle(1, 1))
  })

  it('has distinct dance, overhead summon and cross-cast-open silhouettes', () => {
    const dance = newVictoryPose()
    const summon = newVictoryPose()
    const cast = newVictoryPose()
    sampleVictoryPose('dance', 0.45, 1, dance)
    expect(Math.abs(dance.knee)).toBeGreaterThan(0.15)
    expect(Math.abs(dance.armWave)).toBeGreaterThan(0.2)
    sampleVictoryPose('summon', 1.2, 1, summon)
    expect(summon.overhead).toBeGreaterThan(0.85)
    expect(summon.knee).toBe(0)
    sampleVictoryPose('flourish', 0.25, 1, cast)
    expect(cast.cross).toBeGreaterThan(0.8)
    sampleVictoryPose('flourish', 0.8, 1, cast)
    expect(cast.beam).toBeGreaterThan(0.85)
    sampleVictoryPose('flourish', 1.6, 1, cast)
    expect(cast.flare).toBeGreaterThan(0.7)
    expect(cast.overhead).toBeLessThan(0.2)
  })

  it('uses account equipment for the new poses without changing the free celebration mix', () => {
    expect(victoryStyle(1, 0, 'victory-ascendant')).toBe('ascendant')
    expect(victoryStyle(1, 0, 'victory-revel')).toBe('revel')
    expect(victoryStyle(1, 0, null)).toBe(victoryStyle(1, 0))
    const ascendant = newVictoryPose(), revel = newVictoryPose()
    sampleVictoryPose('ascendant', 1.8, 1, ascendant)
    sampleVictoryPose('revel', 1.0, 1, revel)
    expect(ascendant.flare).toBe(0.8)
    expect(ascendant.overhead).toBeGreaterThan(0.4)
    expect(revel.overhead).toBe(0.56)
    expect(revel.elbowR).toBeGreaterThan(revel.elbowL)
    sampleVictoryPose('revel', 2.1, 1, revel)
    expect(revel.bow).toBeGreaterThan(0.5)
  })

  it('keeps all three animations continuous and bounded throughout the longer camera hold', () => {
    for (const style of STYLES) {
      const before = newVictoryPose()
      const after = newVictoryPose()
      sampleVictoryPose(style, 0, 1, before)
      expect(Object.values(before).every((value) => value === 0)).toBe(true)
      for (let age = 0; age <= ROUND_END_SECONDS; age += 1 / 120) {
        sampleVictoryPose(style, age + 1 / 120, 1, after)
        for (const key of Object.keys(before) as (keyof typeof before)[]) {
          expect(Number.isFinite(after[key])).toBe(true)
          expect(Math.abs(after[key] - before[key])).toBeLessThan(0.065)
          expect(Math.abs(after[key])).toBeLessThanOrEqual(1)
        }
        expect(after.bounce).toBeGreaterThanOrEqual(0)
        expect(after.bounce).toBeLessThanOrEqual(0.07)
        Object.assign(before, after)
      }
    }
  })

  it('reduced motion retains distinct static poses with no dance, bounce or torso oscillation', () => {
    for (const style of STYLES) {
      const first = newVictoryPose()
      const last = newVictoryPose()
      sampleVictoryPose(style, 0, 0, first)
      sampleVictoryPose(style, ROUND_END_SECONDS, 0, last)
      expect(last).toEqual(first)
      expect([last.bounce, last.knee, last.twist, last.sway, last.armWave].every((value) => value === 0)).toBe(true)
    }
  })

  it('gives celebrations the added second before the next shop, without delaying simulation steps', () => {
    const state = fight(2, undefined, { winScore: 99 })
    roundWon(state, 0)
    const tick = state.tick
    run(state, ticks(2))
    expect(state.phase).toBe('roundEnd')
    expect(state.tick).toBe(tick + ticks(2))
    run(state, ticks(1) - 1)
    expect(state.phase).toBe('roundEnd')
    run(state, 1)
    expect(state.phase).toBe('shop')
  })
})
