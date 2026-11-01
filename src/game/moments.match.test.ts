import { describe, expect, it } from 'vitest'
import { createBot } from '../bots'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import type { BotDifficulty, MatchSettings, SimState } from '../sim/types'
import { MomentsEngine, type Moment } from './moments'
import { ReplayRecorder } from './replay/recorder'
import { momentsOfReplaySync } from './replay/moments'

/**
 * The engine on seeded bot matches (docs/moonshot/specs/moments.md): every round that ends on a
 * sealed death has exactly one decider, on that death, the last one decides the match, nearly
 * every death is a knockout, and a replay of the match names the same moments as the live feed
 * (what the results reel and a server rely on). Brisk casual's compact arena and 7 s ring keep it
 * short; a faster ring sinks warlocks nobody pushed and is no fair test of the knockout share.
 */
const NET_ID = 'moments-test'

interface Played {
  moments: readonly Moment[]
  deaths: number
  /** per round: the tick of its last death, when that death was sealed */
  sealedLast: Map<number, number>
  rounds: number
  state: SimState
  replayMoments: Moment[] | null
}

function play(mix: BotDifficulty[], settings: Partial<MatchSettings>, seed: number, maxTicks: number): Played {
  const slots = mix.map((difficulty, id) => ({ id, name: `b${id}`, color: 0, team: id, kind: 'bot' as const, difficulty }))
  const s = createMatch({ ...DEFAULT_SETTINGS, shopSeconds: 3, arenaCap: 15, shrinkSeconds: 7, ...settings }, slots, seed)
  const bots = slots.map((slot) => createBot(slot.id, slot.difficulty, seed * 31 + slot.id))
  const engine = new MomentsEngine()
  const rec = new ReplayRecorder()
  rec.begin({ localPlayer: 0, slots, settings: s.settings, seed })
  let deaths = 0
  let rounds = 0
  const lastDeath = new Map<number, number>()
  for (let i = 0; i < maxTicks && s.phase !== 'gameOver'; i++) {
    const inputs = bots.flatMap((b) => {
      const cmds = b.think(s)
      return cmds.length ? [{ player: b.player, tick: s.tick, cmds }] : []
    })
    rec.step(s, inputs)
    step(s, inputs)
    rec.observe(s, s.events)
    engine.update(s.events, s)
    for (const e of s.events) {
      if (e.type === 'death' && e.cause !== 'disconnect') {
        deaths++
        lastDeath.set(s.round, s.tick)
      }
      if (e.type === 'roundWin') rounds++
    }
  }
  const knockoutEnds = new Set(engine.all().filter((m) => m.kind === 'knockout').map((m) => `${m.round}:${m.end}`))
  const sealedLast = new Map([...lastDeath].filter(([round, tick]) => knockoutEnds.has(`${round}:${tick}`)))
  const replay = rec.finish('moments', NET_ID, [])
  return { moments: engine.all(), deaths, sealedLast, rounds, state: s, replayMoments: replay ? momentsOfReplaySync(replay, NET_ID) : null }
}

describe('moments on seeded matches', () => {
  const duels = [11, 12, 13].map((seed) => play(['hard', 'brutal'], { winScore: 2 }, seed, 30_000))
  const ffa = play(['medium', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard', 'hard', 'hard'], { winScore: 1 }, 21, 30_000)

  it('one decider per round that ends on a sealed death, the last one the match decider; most deaths are knockouts', () => {
    const problems: string[] = []
    for (const [i, m] of [...duels, ffa].entries()) {
      if (m.state.phase !== 'gameOver') problems.push(`${i}: unfinished`)
      const deciders = m.moments.filter((x) => x.traits.includes('roundDecider'))
      for (const [round, tick] of m.sealedLast) {
        const own = deciders.filter((d) => d.round === round)
        if (own.length !== 1 || own[0].end !== tick) problems.push(`${i}: round ${round} decider ${JSON.stringify(own.map((d) => d.end))}, last death ${tick}`)
      }
      const matchDeciders = m.moments.filter((x) => x.traits.includes('matchDecider'))
      const lastRound = Math.max(...deciders.map((d) => d.round))
      if (matchDeciders.length > 1 || (matchDeciders.length === 1 && matchDeciders[0].round !== lastRound)) problems.push(`${i}: match deciders ${matchDeciders.map((d) => d.round)}`)
      for (const x of m.moments) if (!(x.from <= x.tick && x.tick <= x.end && x.end <= x.to)) problems.push(`${i}: window ${x.kind} ${x.from} ${x.tick} ${x.end} ${x.to}`)
    }
    expect(problems).toEqual([])
    // The share is over all four matches (one round of ten has only nine deaths). The spec's 91 to
    // 99% is at the classic 10 s ring; the 7 s ring sinks more warlocks nobody pushed. Every
    // unsealed death in these seeds was checked by hand (2026-11-01): the push came 4.6 to 35 s
    // earlier and the warlock walked in or its tile sank.
    const all = [...duels, ffa]
    const knockouts = all.reduce((n, m) => n + m.moments.filter((x) => x.kind === 'knockout').length, 0)
    expect(knockouts).toBeGreaterThanOrEqual(0.8 * all.reduce((n, m) => n + m.deaths, 0))
    expect(duels.some((m) => m.moments.some((x) => x.traits.includes('matchDecider')))).toBe(true)
  })

  it('a replay of the match names exactly the moments the live feed named', () => {
    for (const m of [...duels, ffa]) expect(m.replayMoments).toEqual(m.moments)
  })
})
