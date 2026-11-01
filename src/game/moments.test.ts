import { describe, expect, it } from 'vitest'
import { ticks } from '../sim/config'
import { fight, pawn } from '../sim/testkit'
import { TICK_HZ, type MatchSettings, type ProjectileState, type SimEvent, type SimState } from '../sim/types'
import { Announcer, DENIED_LINES, KillTally } from './announcer'
import { MomentsEngine, type Moment } from './moments'

/**
 * The moments engine names what mattered (docs/moonshot/specs/moments.md). These scenes feed it
 * hand-made event sequences on a real match state, edited between ticks the way the sim leaves
 * it: knockback velocity for a flight, lavaTicks for a lava stay, alive for a death.
 */
function scene(n = 3, settings: Partial<MatchSettings> = {}, teams?: number[]) {
  const s = fight(n, teams, { shopSeconds: 0, ...settings })
  s.events = []
  const eng = new MomentsEngine()
  eng.update([{ type: 'phase', phase: 'fight', round: s.round }], s)
  const tick = (events: SimEvent[] = []) => {
    s.tick += 1
    return eng.update(events, s)
  }
  const wait = (seconds: number) => {
    for (let i = 0; i < ticks(seconds); i++) tick()
  }
  const kinds = (kind: Moment['kind']) => eng.all().filter((m) => m.kind === kind)
  return { s, eng, tick, wait, kinds }
}

const dmg = (s: SimState, victim: number, source: number | null, kb: number, cause = 'fireball', amount = 50): SimEvent => {
  const p = pawn(s, victim)
  return { type: 'damage', target: p.id, amount, source, x: p.x, y: p.y, kb, cause }
}
const death = (s: SimState, victim: number, killer: number | null, cause = 'lava'): SimEvent => {
  const p = pawn(s, victim)
  p.alive = false
  return { type: 'death', pawn: p.id, owner: victim, killer, cause, x: p.x, y: p.y }
}
/** victim pushed by `src`: flying at `speed` from this tick */
const push = (s: SimState, victim: number, src: number, speed = 1000, cause = 'fireball'): SimEvent => {
  const p = pawn(s, victim)
  p.vx = speed
  p.walkVx = 0
  return dmg(s, victim, src, speed, cause)
}
const lava = (s: SimState, victim: number, on = true) => (pawn(s, victim).lavaTicks = on ? 1 : 0)
const land = (s: SimState, victim: number) => (pawn(s, victim).vx = 0)
const kill = (s: SimState, victim: number, killer: number, cause = 'fireball'): SimEvent[] => [push(s, victim, killer, 900, cause), death(s, victim, killer, cause)]

describe('moments: knockouts are the hit that caused them', () => {
  it('a push, then a lava death 3 s later: the moment is the push, by the pusher', () => {
    // Why: most deaths are lava burns seconds after the push; a replay of the burn shows nothing.
    const { s, tick, wait, kinds } = scene()
    tick([push(s, 1, 0)])
    const pushedAt = s.tick
    wait(0.3)
    lava(s, 1)
    wait(0.2)
    land(s, 1)
    wait(2.5)
    tick([death(s, 1, 0)])
    const [ko, ...rest] = kinds('knockout')
    expect(rest).toHaveLength(0)
    expect(ko).toMatchObject({ actors: [0], victims: [1], tick: pushedAt, end: s.tick, cause: 'fireball' })
  })

  it('a push that burns a nearly dead warlock up on its first lava tick is still the knockout', () => {
    // Why: dead before any state showed it in the lava, it never had a stay to look back from.
    const { s, tick, wait, kinds } = scene()
    tick([push(s, 1, 0, 1900, 'scourge')])
    const pushedAt = s.tick
    wait(0.07)
    tick([death(s, 1, 0)])
    expect(kinds('knockout')).toMatchObject([{ actors: [0], tick: pushedAt, cause: 'scourge' }])
  })

  it('a push that stops on ground, then a walk into the lava: no knockout, though the sim credits the pusher', () => {
    // Why: a moment must be caused, not credited.
    const { s, tick, wait, kinds } = scene()
    tick([push(s, 1, 0)])
    wait(0.3)
    land(s, 1)
    wait(1.5)
    lava(s, 1)
    wait(3)
    tick([death(s, 1, 0)])
    expect(kinds('knockout')).toHaveLength(0)
  })

  it('a second, small hit during the lava stay seals it: it kept them in', () => {
    const { s, tick, wait, kinds } = scene()
    tick([push(s, 1, 0)])
    wait(0.2)
    lava(s, 1)
    land(s, 1)
    wait(1)
    tick([dmg(s, 1, 2, 60, 'lightning')])
    wait(1)
    tick([death(s, 1, 2)])
    expect(kinds('knockout').map((m) => m.actors)).toEqual([[2]])
  })

  it('a death 9 s into the stay still finds the push; past the longest stay plus 2 s it does not', () => {
    // Why: a full-health warlock lives 10 s in lava; a 4 s window missed 29% of lava deaths.
    for (const [stay, sealed] of [[9, true], [12.5, false]] as const) {
      const { s, tick, wait, kinds } = scene()
      tick([push(s, 1, 0)])
      wait(0.2)
      lava(s, 1)
      land(s, 1)
      wait(stay)
      tick([death(s, 1, 0)])
      expect(kinds('knockout'), `${stay} s`).toHaveLength(sealed ? 1 : 0)
    }
  })

  it('a direct Fireball kill: a knockout at the death tick, cause fireball', () => {
    const { s, tick, kinds } = scene()
    tick(kill(s, 1, 0))
    expect(kinds('knockout')).toMatchObject([{ tick: s.tick, end: s.tick, cause: 'fireball', actors: [0], traits: [] }])
  })

  it('a pillar broken by A blasts B into the lava: a pillar blast by A; a pillar nobody broke is no knockout', () => {
    for (const by of [0, null]) {
      const { s, tick, wait, kinds } = scene()
      const v = pawn(s, 1)
      v.vx = 800
      tick([{ type: 'obstacleDestroyed', id: 500, x: v.x + 120, y: v.y, by }, dmg(s, 1, null, 800, 'obstacle')])
      wait(0.2)
      lava(s, 1)
      land(s, 1)
      wait(1)
      tick([death(s, 1, null)])
      if (by === null) expect(kinds('knockout')).toHaveLength(0)
      else expect(kinds('knockout')).toMatchObject([{ actors: [0], cause: 'obstacle', traits: ['pillarBlast'] }])
    }
  })

  it('Lightning detonating a Fireball: a detonation; a plain Lightning hit: no trait', () => {
    for (const detonated of [true, false]) {
      const { s, tick, kinds } = scene()
      const v = pawn(s, 1)
      const blast: SimEvent[] = detonated ? [{ type: 'explosion', x: v.x + 50, y: v.y, radius: 200, spell: 'lightning' }] : []
      tick([...blast, ...kill(s, 1, 0, 'lightning')])
      expect(kinds('knockout')[0].traits).toEqual(detonated ? ['detonation'] : [])
    }
  })

  it('a Fireball stolen by a Shield kills its caster: reflected, by the thief; a Recharge orb is not', () => {
    for (const [origOwner, reflected] of [[0, true], [1, false]] as const) {
      const { s, tick, kinds } = scene()
      s.projectiles = [{ id: 900, owner: 1, spell: 'fireball', data: { origOwner } } as unknown as ProjectileState]
      tick()
      s.projectiles = []
      const a = pawn(s, 0)
      tick([{ type: 'projectileHit', id: 900, spell: 'fireball', x: a.x, y: a.y, target: a.id }, ...kill(s, 0, 1)])
      expect(kinds('knockout')[0]).toMatchObject({ actors: [1], traits: reflected ? ['reflected'] : [] })
    }
    // a stolen shot landing in the tick someone else kills its caster is not that kill
    const { s, tick, kinds } = scene()
    s.projectiles = [{ id: 900, owner: 1, spell: 'fireball', data: { origOwner: 0 } } as unknown as ProjectileState]
    tick()
    s.projectiles = []
    const a = pawn(s, 0)
    tick([{ type: 'projectileExpire', id: 900, spell: 'fireball', x: a.x, y: a.y }, ...kill(s, 0, 2)])
    expect(kinds('knockout')[0]).toMatchObject({ actors: [2], traits: [] })
  })
})

describe('moments: deciders, chains, escapes, clutches and close calls', () => {
  it('the round-winning knockout decides the round, and the match when it ends it', () => {
    const { s, eng, tick, kinds } = scene(2, { winScore: 1 })
    const events = kill(s, 1, 0)
    s.scores[0].score = 1 // as roundWon leaves it
    tick([...events, { type: 'roundWin', team: s.slots[0].team, players: [0] }])
    const [ko] = kinds('knockout')
    expect(ko.traits).toEqual(['matchDecider', 'roundDecider'])
    expect(eng.deciderOf(s.round)).toBe(ko)
    // stakes 2.5 and no novelty discount
    expect(ko.score).toBeCloseTo(2.5 * (0.85 + 0.15 * Math.min(2, 900 / 1500)), 3)
    // a King of the Hill round won by tickets has no decider
    const hill = scene(2, { gameMode: 'hill', winScore: 75 })
    hill.tick([{ type: 'roundWin', team: hill.s.slots[0].team, players: [0] }])
    expect(hill.eng.deciderOf(hill.s.round)).toBeNull()
  })

  it('credited kills chained within 3 s are one multi-knockout, exactly as KillTally counts them', () => {
    const { s, tick, wait, kinds } = scene(6)
    const tally = new KillTally()
    const chains: number[] = []
    const killAt = (victim: number) => {
      tick(kill(s, victim, 0))
      chains.push(tally.death(victim, 0, s.tick / TICK_HZ)!.chain)
    }
    killAt(1)
    wait(2.5)
    killAt(2)
    wait(2)
    killAt(3)
    wait(3.5)
    killAt(4)
    wait(1)
    killAt(5)
    expect(chains).toEqual([1, 2, 3, 1, 2])
    const multis = kinds('multiKnockout')
    expect(multis.map((m) => [m.count, m.victims])).toEqual([[3, [1, 2, 3]], [2, [4, 5]]])
    expect(multis[0].final).toBe(true)
    expect(multis[1].final).toBe(false)
    wait(3.2)
    expect(multis[1].final).toBe(true)
  })

  it('Denied: a Teleport out of a lethal stay, with the pusher as victim; the announcer agrees case by case', () => {
    // Why: one rule for the voice line and the moment (isDeniedEscape), so they never disagree.
    const cases: { name: string; pushed: boolean; hp: number; denied: boolean }[] = [
      { name: 'pushed in, nearly burnt', pushed: true, hp: 90, denied: true },
      { name: 'walked in, nearly burnt', pushed: false, hp: 90, denied: true },
      { name: 'healthy lava hop', pushed: true, hp: 1000, denied: false },
    ]
    for (const c of cases) {
      const { s, tick, wait, kinds } = scene(2)
      const announcer = new Announcer()
      announcer.lineLength = () => 0.1
      const heard: string[] = []
      const feed = (events: SimEvent[] = []) => {
        tick(events)
        const a = announcer.update(events, s.tick / TICK_HZ, 1, s)
        if (a) heard.push(a.line)
      }
      feed([{ type: 'phase', phase: 'fight', round: s.round }])
      feed(c.pushed ? [push(s, 1, 0)] : [])
      for (let i = 0; i < ticks(0.2); i++) feed()
      lava(s, 1)
      land(s, 1)
      pawn(s, 1).hp = c.hp
      for (let i = 0; i < ticks(0.5); i++) feed()
      const v = pawn(s, 1)
      v.lavaTicks = 0
      feed([{ type: 'teleport', pawn: v.id, fromX: v.x, fromY: v.y, toX: 0, toY: 0 }])
      for (let t = s.tick / TICK_HZ; t < s.tick / TICK_HZ + 3; t += 0.05) {
        const a = announcer.next(t)
        if (a) heard.push(a.line)
      }
      wait(0)
      const denied = kinds('denied')
      expect(denied.length > 0, c.name).toBe(c.denied)
      expect(heard.some((l) => (DENIED_LINES as readonly string[]).includes(l)), `${c.name}: announcer`).toBe(c.denied)
      if (c.denied) expect(denied[0].victims, c.name).toEqual(c.pushed ? [0] : [])
    }
  })

  it('3v3: the last warlock of a side beats the two enemies left: a clutch; dead, or in FFA, none', () => {
    const teams = [0, 0, 0, 1, 1, 1]
    for (const survives of [true, false]) {
      const { s, tick, wait, kinds } = scene(6, {}, teams)
      tick(kill(s, 3, 0))
      wait(1)
      tick(kill(s, 1, 4))
      tick(kill(s, 2, 4))
      wait(1)
      if (!survives) {
        tick([...kill(s, 0, 5), { type: 'roundWin', team: 1, players: [3, 4, 5] }])
        expect(kinds('clutch')).toHaveLength(0)
        continue
      }
      tick(kill(s, 4, 0))
      wait(1)
      tick([...kill(s, 5, 0), { type: 'roundWin', team: 0, players: [0, 1, 2] }])
      expect(kinds('clutch')).toMatchObject([{ actors: [0], count: 2, victims: [4, 5] }])
    }
    const ffa = scene(4)
    ffa.tick(ffa.s.slots.length ? kill(ffa.s, 1, 0) : [])
    ffa.tick(kill(ffa.s, 2, 0))
    ffa.tick([...kill(ffa.s, 3, 0), { type: 'roundWin', team: ffa.s.slots[0].team, players: [0] }])
    expect(ffa.kinds('clutch')).toHaveLength(0)
  })

  it('a hit to 8% that the warlock survives 5 s off the lava is a close call, once a round; dead at 4 s it is not', () => {
    const { s, tick, wait, kinds } = scene()
    const v = pawn(s, 1)
    v.hp = 70
    tick([dmg(s, 1, 0, 0, 'fireball', 100)])
    wait(5)
    expect(kinds('closeCall')).toMatchObject([{ actors: [1], tick: s.tick - ticks(5) }])
    tick([dmg(s, 1, 0, 0, 'fireball', 5)])
    wait(6)
    expect(kinds('closeCall')).toHaveLength(1)

    const dies = scene()
    pawn(dies.s, 1).hp = 70
    dies.tick([dmg(dies.s, 1, 0, 0, 'fireball', 100)])
    dies.wait(4)
    dies.tick([death(dies.s, 1, 0)])
    dies.wait(2)
    expect(dies.kinds('closeCall')).toHaveLength(0)
  })

  it('scores: a match decider outranks a double; a fourth ordinary knockout scores below the first; a decider skips novelty', () => {
    const { s, tick, wait, kinds } = scene(6, { winScore: 1 })
    for (const victim of [1, 2, 3, 4]) {
      tick(kill(s, victim, 0))
      wait(3.5)
    }
    const ko = kinds('knockout')
    expect(ko[3].score).toBeLessThan(ko[0].score)
    expect(ko[3].score).toBeCloseTo(ko[0].score * 0.8 ** 3, 2)
    const events = kill(s, 5, 0)
    s.scores[0].score = 1
    tick([...events, { type: 'roundWin', team: s.slots[0].team, players: [0] }])
    const decider = kinds('knockout')[4]
    expect(decider.score).toBeCloseTo(2.5 * ko[0].score, 2)

    const double = scene(3)
    double.tick(kill(double.s, 1, 0))
    double.wait(1)
    double.tick(kill(double.s, 2, 0))
    expect(decider.score).toBeGreaterThan(double.kinds('multiKnockout')[0].score)
  })

  it('is deterministic: the same sequence twice gives the same moments', () => {
    const play = () => {
      const { s, eng, tick, wait } = scene(4)
      tick([push(s, 1, 0)])
      wait(0.2)
      lava(s, 1)
      land(s, 1)
      wait(2)
      tick([death(s, 1, 0)])
      tick(kill(s, 2, 0))
      tick([...kill(s, 3, 0), { type: 'roundWin', team: s.slots[0].team, players: [0] }])
      return eng.all()
    }
    expect(play()).toEqual(play())
  })
})
