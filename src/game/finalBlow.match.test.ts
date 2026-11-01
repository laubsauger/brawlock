import { describe, expect, it } from 'vitest'
import { createBot } from '../bots'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import { planFinalBlow, type FinalBlowPlan } from './finalBlow'
import { MomentsEngine } from './moments'
import { StateRing } from './stateRing'

/**
 * Engine, ring and planner together on seeded duels, as the match runs them: every round decider
 * gets a Final Blow, and nearly all of them show the hit itself (the ring reaches back far enough).
 */
describe('Final Blow on seeded duels', () => {
  it('every round decider gets a plan, at least 95% of them full', () => {
    const plans: FinalBlowPlan[] = []
    let deciders = 0
    for (const seed of [41, 42, 43, 44]) {
      const slots = (['hard', 'brutal'] as const).map((difficulty, id) => ({ id, name: `b${id}`, color: 0, team: id, kind: 'bot' as const, difficulty }))
      const s = createMatch({ ...DEFAULT_SETTINGS, winScore: 2, shopSeconds: 3, arenaCap: 15, shrinkSeconds: 7 }, slots, seed)
      const bots = slots.map((slot) => createBot(slot.id, slot.difficulty, seed * 31 + slot.id))
      const engine = new MomentsEngine()
      const ring = new StateRing()
      for (let i = 0; i < 30_000 && s.phase !== 'gameOver'; i++) {
        const inputs = bots.flatMap((b) => {
          const cmds = b.think(s)
          return cmds.length ? [{ player: b.player, tick: s.tick, cmds }] : []
        })
        step(s, inputs)
        engine.update(s.events, s)
        ring.observe(s, s.events)
        if (!s.events.some((e) => e.type === 'roundWin')) continue
        const decider = engine.deciderOf(s.round)
        if (!decider) continue
        deciders++
        const plan = planFinalBlow(decider, ring.oldest, decider.traits.includes('matchDecider') ? 'match' : 'round', false)
        if (plan) plans.push(plan)
      }
    }
    expect(deciders).toBeGreaterThan(4)
    expect(plans).toHaveLength(deciders)
    expect(plans.filter((p) => !p.partial).length).toBeGreaterThanOrEqual(0.95 * deciders)
    expect(plans.some((p) => p.kind === 'match')).toBe(true)
  })
})
