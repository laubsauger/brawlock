import { describe, expect, it } from 'vitest'
import { step } from '../sim/index'
import { spawnProjectile } from '../sim/projectiles'
import { castNow, cmd, fight, grant, newMatch, pawn, place, slots as mkSlots } from '../sim/testkit'
import type { PlayerScore, SimEvent, SimState } from '../sim/types'
import type { KV } from './profile'
import {
  AWARD_LEAD,
  AWARDS_MAX,
  HISTORY_DETAIL_MAX,
  MatchTracker,
  cleanStats,
  getCareer,
  getHallOfFame,
  getMatchHistory,
  matchAwards,
  recordMatch,
  type MatchRecord,
  type Participant,
  type PlayerMatchStats,
} from './stats'

function memKV(init: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...init }
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = v) }
}

function track(s: SimState): MatchTracker {
  const t = new MatchTracker({ localPlayer: 0, slots: s.slots, settings: s.settings })
  t.observe(s, [])
  return t
}

/** step the real sim, feeding every tick to the tracker like the session does */
function play(s: SimState, t: MatchTracker, ticks: number, inputs: () => Parameters<typeof step>[1] = () => []): void {
  for (let i = 0; i < ticks; i++) {
    step(s, inputs())
    t.observe(s, s.events)
  }
}

const fireballAt = (s: SimState, owner: number, x: number, y: number, vx: number) =>
  spawnProjectile(s, owner, 'fireball', x, y, vx, 0, 25, { lifetime: 2, data: { damage: 70, kb: 1 } })

// ---------------------------------------------------------------------------
describe('movement is attributed to walking or to being pushed', () => {
  it('walking counts as walked, not pushed', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), 0, 1200)
    const t = track(s)
    step(s, [cmd(0, { kind: 'move', x: 1000, y: 0 })])
    t.observe(s, s.events)
    play(s, t, 119)
    const st = t.statsOf(0)
    expect(st.walked).toBeGreaterThan(400) // 2 s at 210 u/s
    expect(st.walked).toBeLessThan(425)
    expect(st.pushed).toBe(0)
    expect(st.longestFlight).toBe(0)
  })

  it('a knockback counts as pushed, with its flight measured start to stop', () => {
    const s = fight()
    place(pawn(s, 0), -1000, 0)
    const p1 = pawn(s, 1)
    place(p1, 0, 0)
    const t = track(s)
    fireballAt(s, 0, -60, 0, 1000) // 70 damage: 749 u/s, decays x0.3115 per second
    play(s, t, 360)
    const st = t.statsOf(1)
    expect(st.walked).toBe(0)
    // total slide = 749 / -ln(0.96^(1/0.035)) ~ 642 u
    expect(st.pushed).toBeGreaterThan(600)
    expect(st.pushed).toBeLessThan(680)
    expect(st.longestFlight).toBeGreaterThan(580)
    expect(st.longestFlight).toBeLessThanOrEqual(st.pushed)
    expect(st.knockbacksTaken).toBe(1)
    expect(t.statsOf(0).knockbacksDealt).toBe(1)
  })

  it('walking while being pushed counts both, each for its own part', () => {
    const s = fight()
    place(pawn(s, 0), -1000, 0)
    const p1 = pawn(s, 1)
    place(p1, 0, 0, Math.PI / 2)
    const t = track(s)
    step(s, [cmd(1, { kind: 'move', x: 0, y: 1000 })])
    t.observe(s, s.events)
    fireballAt(s, 0, -60, 0, 1000)
    play(s, t, 120)
    const st = t.statsOf(1)
    expect(st.walked).toBeGreaterThan(400)
    expect(st.pushed).toBeGreaterThan(400)
  })
})

describe('kills and self-kills', () => {
  it('a lava death nobody caused is a self-kill, not anyone’s kill', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 3000, 0)
    const t = track(s)
    for (let i = 0; i < 900 && pawn(s, 1).alive; i++) play(s, t, 1)
    expect(pawn(s, 1).alive).toBe(false)
    expect(t.statsOf(1)).toMatchObject({ selfKills: 1, deathsByCause: { lava: 1 } })
    expect(t.statsOf(0).killsByCause).toEqual({})
    expect(t.statsOf(1).lavaSec).toBeGreaterThan(5)
    expect(t.statsOf(1).lavaDamage).toBeGreaterThan(900)
  })

  it('pushed into the lava: the pusher gets a lava kill (last hit), the victim no self-kill', () => {
    const s = fight()
    place(pawn(s, 0), -1000, 0)
    const p1 = pawn(s, 1)
    place(p1, 0, 0)
    const t = track(s)
    fireballAt(s, 0, -60, 0, 1000)
    play(s, t, 30)
    expect(p1.lastHitter).toBe(0)
    place(p1, 3000, 0)
    play(s, t, 900)
    expect(t.statsOf(0)).toMatchObject({ killsByCause: { lava: 1 }, lastHitKills: 1, firstBlood: true })
    expect(t.statsOf(1).selfKills).toBe(0)
  })

  it('streaks, multi-kills and first blood come from the announcer’s tally', () => {
    const t = new MatchTracker({ localPlayer: 0, slots: mkSlots(4), settings: newMatch().settings })
    const st = (tick: number) => ({ tick, pawns: [0, 1, 2, 3].map((p) => ({ id: 100 + p, owner: p })) }) as unknown as SimState
    const death = (owner: number, killer: number | null): SimEvent => ({ type: 'death', pawn: 100 + owner, owner, killer, cause: 'fireball' })
    t.observe(st(60), [death(1, 0)])
    t.observe(st(120), [death(2, 0)]) // within 3 s: double
    t.observe(st(900), [death(3, 0)]) // later: streak 3, chain restarts
    t.observe(st(960), [death(0, 3)])
    expect(t.statsOf(0)).toMatchObject({ bestStreak: 3, bestMulti: 2, firstBlood: true, killsByCause: { fireball: 3 } })
    expect(t.statsOf(3).firstBlood).toBe(false)
  })
})

describe('spells, saves and economy', () => {
  it('accuracy: a cast that damages an enemy is a hit, a miss is not, extra bolts are not extra hits', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), 300, 0)
    const t = track(s)
    const ev = castNow(s, 0, 6, 300, 0)
    t.observe(s, ev)
    play(s, t, 30)
    expect(t.statsOf(0).spells.fireball).toEqual([1, 1])
    place(pawn(s, 1), 0, 1200)
    for (let i = 0; i < 300; i++) {
      step(s, [])
      t.observe(s, s.events)
    }
    t.observe(s, castNow(s, 0, 6, 300, 0))
    play(s, t, 80)
    expect(t.statsOf(0).spells.fireball).toEqual([2, 1])
    // Cluster: four bolts into one target still count one hit for the one cast
    const c = fight()
    place(pawn(c, 0), 0, 0, 0)
    place(pawn(c, 1), 120, 0)
    const tc = track(c)
    tc.observe(c, castNow(c, 0, grant(c, 0, 'cluster'), 300, 0))
    play(c, tc, 20)
    expect(tc.statsOf(0).spells.cluster).toEqual([1, 1])
  })

  it('Scourge counts every enemy hit', () => {
    const s = fight(3)
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 100, 0)
    place(pawn(s, 2), -100, 0)
    const t = track(s)
    t.observe(s, castNow(s, 0, 7, 0, 0))
    expect(t.statsOf(0).scourgeHits).toBe(2)
  })

  it('Teleport out of the lava or off a lava-bound slide is a save; a casual blink is not', () => {
    const lava = fight()
    place(pawn(lava, 0), 2000, 0)
    place(pawn(lava, 1), 0, 900)
    const t1 = track(lava)
    play(lava, t1, 3)
    t1.observe(lava, castNow(lava, 0, grant(lava, 0, 'teleport'), 0, 0))
    expect(t1.statsOf(0).teleportSaves).toBe(1)

    const slide = fight()
    const p = pawn(slide, 0)
    place(p, 900, 0)
    place(pawn(slide, 1), 0, 900)
    const t2 = track(slide)
    p.vx = 1500 // would come to rest ~2200 out: lava
    play(slide, t2, 1)
    t2.observe(slide, castNow(slide, 0, grant(slide, 0, 'teleport'), -500, 0))
    expect(t2.statsOf(0).teleportSaves).toBe(1)

    const calm = fight()
    place(pawn(calm, 0), 0, 0)
    place(pawn(calm, 1), 0, 900)
    const t3 = track(calm)
    t3.observe(calm, castNow(calm, 0, grant(calm, 0, 'teleport'), 500, 0))
    expect(t3.statsOf(0)).toMatchObject({ teleportSaves: 0, teleported: 500 })
  })

  it('gold earned and spent, and the most-upgraded spell', () => {
    const s = newMatch({ shopSeconds: 1, startGold: 30, roundGold: 10, winGold: 2, killGold: 0 })
    const t = track(s)
    step(s, [cmd(0, { kind: 'buySpell', spell: 'teleport' }, { kind: 'buySpell', spell: 'teleport' })])
    t.observe(s, s.events)
    while (s.phase !== 'fight') {
      step(s, [])
      t.observe(s, s.events)
    }
    pawn(s, 1).x = 3000
    while ((s.phase as string) !== 'shop') {
      step(s, [])
      t.observe(s, s.events)
    }
    // spent: Teleport 12 + upgrade 6. Earned: round gold 10 + win gold 2 (start gold is not earned)
    expect(t.statsOf(0)).toMatchObject({ goldSpent: 18, goldEarned: 12, topSpell: ['teleport', 2], roundsSurvived: 1 })
    expect(t.statsOf(1).roundsSurvived).toBe(0)
  })
})

// ---------------------------------------------------------------------------
const base = cleanStats({})!
function part(player: number, stats: Partial<PlayerMatchStats>): Participant {
  return { player, profileId: `p${player}`, name: `p${player}`, color: 0, kind: 'human', team: player, score: 0, kills: 0, deaths: 0, damage: 0, won: false, stats: { ...base, ...stats } }
}

describe('awards pick clear outliers above sensible thresholds', () => {
  it('Butcher goes to the true outlier', () => {
    const a = matchAwards({ participants: [part(0, { killsByCause: { fireball: 2 } }), part(1, { killsByCause: { lava: 4, scourge: 2 } }), part(2, {})] })
    expect(a.find((x) => x.id === 'butcher')).toMatchObject({ player: 1, value: 6, title: 'Butcher' })
  })

  it('no award below the threshold or without a clear lead', () => {
    expect(matchAwards({ participants: [part(0, { killsByCause: { fireball: 2 } }), part(1, {})] }).find((x) => x.id === 'butcher')).toBeUndefined()
    const close = matchAwards({ participants: [part(0, { killsByCause: { fireball: 5 } }), part(1, { killsByCause: { fireball: 5 * (AWARD_LEAD - 0.1) } })] })
    expect(close.find((x) => x.id === 'butcher')).toBeUndefined()
  })

  it('Sniper needs enough casts; Untouchable compares survivors only', () => {
    const few = matchAwards({ participants: [part(0, { spells: { fireball: [9, 9] } }), part(1, { spells: { fireball: [9, 1] } })] })
    expect(few.find((x) => x.id === 'sniper')).toBeUndefined()
    const many = matchAwards({ participants: [part(0, { spells: { fireball: [12, 9] } }), part(1, { spells: { fireball: [12, 3] } })] })
    expect(many.find((x) => x.id === 'sniper')).toMatchObject({ player: 0, unit: '%', value: 0.75 })
    const tough = matchAwards({
      participants: [part(0, { roundsSurvived: 3, damageTaken: 80 }), part(1, { roundsSurvived: 2, damageTaken: 500 }), part(2, { roundsSurvived: 0, damageTaken: 0 })],
    })
    expect(tough.find((x) => x.id === 'untouchable')).toMatchObject({ player: 0, value: 80 })
  })

  it(`at most ${AWARDS_MAX}, none without detailed stats`, () => {
    const loud = part(0, {
      killsByCause: { fireball: 9 }, walked: 20000, pushed: 20000, longestFlight: 3000, lavaSec: 60, selfKills: 5,
      teleportSaves: 5, scourgeHits: 20, spells: { fireball: [20, 18] },
    })
    expect(matchAwards({ participants: [loud, part(1, {})] }).length).toBe(AWARDS_MAX)
    const { stats: _s, ...bare } = part(0, { walked: 99999 })
    void _s
    expect(matchAwards({ participants: [bare] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
const score = (id: number): PlayerScore => ({ id, gold: 0, score: 0, kills: 0, deaths: 0, damageThisRound: 0, masteries: { duration: 0, range: 0, lifesteal: 0 }, connected: true })

function finished(walked: number, date: number): MatchRecord {
  const s = fight()
  const t = track(s)
  const rec = t.finish({ winners: [0], slots: s.slots, scores: [score(0), score(1)], rounds: 1, ticks: 600 }, date)
  rec.participants[0].stats = { ...rec.participants[0].stats!, walked }
  return rec
}

describe('storage: old saves load, the stored shape stays small', () => {
  it('a v1 save (no detailed stats) loads and upgrades on the next record', () => {
    const v1 = {
      v: 1,
      history: [{ id: 'old', date: 1, teamMode: 'ffa', gameMode: 'rounds', rounds: 3, durationSec: 90, participants: [{ player: 0, name: 'me', won: true }], winners: [0], self: 0, outcome: 'win', kills: [], damage: [] }],
      career: { profileId: 'me', games: 4, wins: 3, kills: 9 },
      encounters: {},
      ratings: {},
    }
    const kv = memKV({ 'brawlock.stats.v1': JSON.stringify(v1) })
    const c = getCareer(kv)!
    expect(c).toMatchObject({ games: 4, wins: 3, kills: 9 })
    expect(c.totals.walked).toBe(0)
    expect(c.hallOfFame).toEqual({})
    expect(getMatchHistory(5, kv)[0].participants[0].stats).toBeUndefined()

    recordMatch(finished(1234, 2), 'me', kv)
    expect(JSON.parse(kv.data['brawlock.stats.v1']).v).toBe(2)
    expect(getCareer(kv)!).toMatchObject({ games: 5, totals: { walked: 1234 } })
    expect(getHallOfFame(kv).mostWalked).toMatchObject({ value: 1234, date: 2 })
  })

  it('corrupt detailed stats are cleaned field by field', () => {
    const rec = finished(10, 1) as unknown as Record<string, unknown>
    ;(rec.participants as Record<string, unknown>[])[0].stats = { walked: 'far', pushed: NaN, spells: { fireball: ['x', 2] }, killsByCause: { lava: -1, fireball: 2 } }
    rec.awards = [{ id: 'nope' }, { id: 'butcher', title: 'Butcher', player: 0, value: 4, unit: '', blurb: 'b' }]
    const kv = memKV({ 'brawlock.stats.v1': JSON.stringify({ v: 2, history: [rec], career: null, encounters: {}, ratings: {} }) })
    const got = getMatchHistory(1, kv)[0]
    expect(got.participants[0].stats).toMatchObject({ walked: 0, pushed: 0, spells: { fireball: [0, 2] }, killsByCause: { fireball: 2 } })
    expect(got.awards).toEqual([{ id: 'butcher', title: 'Butcher', player: 0, value: 4, unit: '', blurb: 'b' }])
  })

  it('the hall of fame only moves on a new personal best', () => {
    const kv = memKV()
    recordMatch(finished(5000, 1), 'me', kv)
    recordMatch(finished(3000, 2), 'me', kv)
    expect(getHallOfFame(kv).mostWalked).toMatchObject({ value: 5000, date: 1 })
    recordMatch(finished(7000, 3), 'me', kv)
    expect(getHallOfFame(kv).mostWalked).toMatchObject({ value: 7000, date: 3 })
  })

  it(`only the newest ${HISTORY_DETAIL_MAX} matches keep detailed stats`, () => {
    const kv = memKV()
    for (let i = 0; i < HISTORY_DETAIL_MAX + 3; i++) recordMatch(finished(100, i + 1), 'me', kv)
    const hist = getMatchHistory(HISTORY_DETAIL_MAX + 3, kv)
    expect(hist[HISTORY_DETAIL_MAX - 1].participants[0].stats).toBeDefined()
    expect(hist[HISTORY_DETAIL_MAX].participants[0].stats).toBeUndefined()
    expect(hist[HISTORY_DETAIL_MAX].participants[0].name).toBeDefined()
  })
})
