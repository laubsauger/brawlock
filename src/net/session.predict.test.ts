/**
 * Predict mode (the default netcode) end to end: host + client sessions over the
 * in-memory transport with latency, jitter and loss, real sim, fake timers.
 * The classic snapshot path is covered by session.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LobbyView, MatchResult, Screen } from '../game/store'
import { createBot } from '../bots'
import { createMatch, hashState, step } from '../sim'
import type { InputCommand, MatchSettings, PlayerInput, SimEvent, SimState } from '../sim/types'
import { codeFromSearch, roomLink } from './code'
import { createMemoryNet, mulberry32, type LinkOptions } from './memory'
import type { NetGradeEvent } from './netstats'
import { MAX_AHEAD_TICKS } from './predict'
import { createSession, type NetMode, type SessionDeps } from './session'
import type { NetFactory } from './transport'

const DT = 1000 / 60

const SETTINGS: MatchSettings = {
  teamMode: 'ffa',
  gameMode: 'rounds',
  winScore: 11,
  startGold: 30,
  roundGold: 10,
  killGold: 0,
  winGold: 0,
  lavaDps: 100,
  kbMultiplier: 1,
  dmgMultiplier: 1,
  friction: 0.96,
  // the first shop phase lasts this long; the tests walk around in it (no lava, no damage)
  shopSeconds: 30,
  botsReplaceLeavers: false,
}

interface PeerOpts {
  netMode?: NetMode
  hostDelayCapTicks?: number
  step?: SessionDeps['step']
  bots?: boolean
}

interface Shown {
  state: SimState
  /** wall time (fake clock) when the session handed it to render */
  wall: number
}

function makePeer(net: NetFactory, name: string, key: string, opts: PeerOpts = {}) {
  const store = {
    lobby: {
      role: 'offline',
      joinUrl: null,
      roomCode: null,
      status: 'idle',
      error: null,
      slots: [],
      settings: null,
      localPlayer: 0,
      pings: {},
      ready: {},
    } as LobbyView,
    screen: 'menu' as Screen,
  }
  const shown: Shown[] = []
  /** authoritative states the recorder saw */
  const auth: SimState[] = []
  const events: SimEvent[] = []
  const results: MatchResult[] = []
  const queue: InputCommand[] = []
  const listeners = new Set<(c: InputCommand) => void>()
  const steps = { n: 0 }
  const baseStep = opts.step ?? step
  const deps: SessionDeps = {
    ui: {
      lobby: () => store.lobby,
      setLobby: (p) => {
        store.lobby = { ...store.lobby, ...p }
      },
      screen: () => store.screen,
      setScreen: (s) => {
        store.screen = s
      },
      setResult: () => {},
      paused: () => false,
      onScreen: () => () => {},
    },
    profile: () => ({ id: `profile-${name}`, name, color: null }),
    recorder: {
      start: () => {},
      observe: (s) => {
        auth.push(s)
      },
      finish: (r) => {
        results.push(r)
      },
      abort: () => {},
    },
    frame: {
      reset: () => {
        shown.length = 0
        events.length = 0
      },
      setLocalPlayer: () => {},
      pushState: (state) => {
        shown.push({ state, wall: performance.now() })
      },
      pushEvents: (_tick, evs) => {
        events.push(...evs)
      },
      setNet: () => {},
    },
    input: {
      drain: () => queue.splice(0),
      onCommand: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
    audio: { playEvents: () => {} },
    createMatch,
    step: (s: SimState, inputs: PlayerInput[]) => {
      steps.n++
      baseStep(s, inputs)
    },
    createBot: opts.bots
      ? createBot
      : () => {
          throw new Error('no bots here')
        },
    defaultSettings: SETTINGS,
    net,
    startClock: (onPulse) => {
      const id = setInterval(() => onPulse(performance.now()), 4)
      return () => clearInterval(id)
    },
    now: () => performance.now(),
    random: mulberry32(name.length),
    joinUrl: (code) => roomLink('http://test/', code),
    clientKey: () => key,
    netMode: () => opts.netMode ?? 'predict',
    hostDelayCapTicks: opts.hostDelayCapTicks,
  }
  const issue = (c: InputCommand) => {
    queue.push(c)
    for (const cb of listeners) cb(c)
  }
  return { session: createSession(deps), store, shown, auth, events, results, issue, steps }
}

async function pair(link: LinkOptions, hostOpts: PeerOpts = {}, clientOpts: PeerOpts = {}) {
  const net = createMemoryNet(link)
  const host = makePeer(net, 'Hosty', 'host-key', hostOpts)
  const client = makePeer(net, 'Clienta', 'client-key', clientOpts)
  await host.session.openHost()
  const code = codeFromSearch(new URL(host.store.lobby.joinUrl!).search)!
  const joined = client.session.join(code)
  await vi.advanceTimersByTimeAsync(800)
  await joined
  return { host, client }
}

const lastShown = (p: { shown: Shown[] }) => p.shown[p.shown.length - 1].state
const pawnOf = (s: SimState, owner: number) => s.pawns.find((p) => p.owner === owner)!
const noEvents = (s: SimState) => hashState({ ...s, events: [] })

/** 80 ms and 150 ms RTT (one-way latency + uniform jitter), 10 % loss on the unreliable path. */
const RTT80: LinkOptions = { latencyMs: 34, jitterMs: 12, loss: 0.1, seed: 5 }
const RTT150: LinkOptions = { latencyMs: 65, jitterMs: 20, loss: 0.1, seed: 9 }

/**
 * Time from issuing a move to the first state handed to render whose own pawn
 * reacts (turns toward the target or moves), in ms.
 */
async function reaction(p: ReturnType<typeof makePeer>, owner: number, dx: number): Promise<number> {
  const s0 = lastShown(p)
  const me = pawnOf(s0, owner)
  const target = { x: me.x + dx, y: me.y + dx / 2 }
  const before = p.shown.length
  const t0 = performance.now()
  p.issue({ kind: 'move', ...target })
  for (let i = 0; i < 400; i++) {
    await vi.advanceTimersByTimeAsync(1)
    for (let k = before; k < p.shown.length; k++) {
      const q = pawnOf(p.shown[k].state, owner)
      if (q.moveTarget && q.moveTarget.x === target.x && (q.facing !== me.facing || q.x !== me.x || q.y !== me.y)) {
        return p.shown[k].wall - t0
      }
    }
  }
  return Infinity
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('predict mode: instant own input', () => {
  /**
   * Why: the whole point of prediction. Classic mode shows an order after a full
   * round trip plus the jitter buffer; predict mode must show it on the next tick
   * at any RTT, with loss and jitter, while the host stays authoritative.
   */
  it.each([
    ['80 ms', RTT80],
    ['150 ms', RTT150],
  ])('own pawn reacts within one tick at %s RTT with 10 %% loss (classic for comparison)', async (_label, link) => {
    const measure = async (mode: NetMode) => {
      const { host, client } = await pair(link, { netMode: mode }, { netMode: mode })
      host.session.startMatch()
      await vi.advanceTimersByTimeAsync(1500)
      const samples: number[] = []
      for (let i = 0; i < 5; i++) {
        samples.push(await reaction(client, 1, i % 2 ? 200 : -200))
        await vi.advanceTimersByTimeAsync(337)
      }
      host.session.leave()
      client.session.leave()
      return samples
    }
    const classic = await measure('classic')
    const predict = await measure('predict')
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    console.log(`[reaction ${_label}] classic ${classic.map((x) => x.toFixed(0)).join(' ')} ms (mean ${mean(classic).toFixed(0)}), predict ${predict.map((x) => x.toFixed(0)).join(' ')} ms (mean ${mean(predict).toFixed(0)})`)
    // one tick plus one 4 ms pulse
    for (const ms of predict) expect(ms).toBeLessThanOrEqual(DT + 4.5)
    // classic waits at least a round trip
    const rtt = 2 * link.latencyMs!
    for (const ms of classic) expect(ms).toBeGreaterThan(rtt)
  })
})

describe('predict mode: authority and convergence', () => {
  /**
   * Why: the host stays authoritative and the client never drifts. With only the
   * client acting, its own frames run at their stamps on the host, so (nearly) every
   * tick the client displays is the host's state for that tick, bit for bit, and
   * every displayed tick after the inputs stop is exact.
   */
  it('displayed ticks equal the host state for the same tick (hash) under 150 ms RTT, 10 % loss', async () => {
    const { host, client } = await pair(RTT150)
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(1200)
    const me0 = pawnOf(lastShown(client), 1)
    for (let i = 0; i < 24; i++) {
      client.issue({ kind: 'move', x: me0.x + (i % 2 ? 250 : -250), y: me0.y + (i % 3 ? 120 : -160) })
      await vi.advanceTimersByTimeAsync(97 + (i % 4) * 31)
    }
    const quietFrom = lastShown(client).tick
    await vi.advanceTimersByTimeAsync(1500)

    const hostHash = new Map(host.auth.map((s) => [s.tick, noEvents(s)]))
    const comparable = client.shown.filter((x) => hostHash.has(x.state.tick))
    expect(comparable.length).toBeGreaterThan(150)
    const exact = comparable.filter((x) => noEvents(x.state) === hostHash.get(x.state.tick)).length
    const quiet = comparable.filter((x) => x.state.tick > quietFrom + 30)
    expect(quiet.length).toBeGreaterThan(40)
    for (const x of quiet) expect(noEvents(x.state)).toBe(hostHash.get(x.state.tick))
    const d = client.session.debug()
    console.log(
      `[convergence] exact ${exact}/${comparable.length} displayed ticks, late frames ${d.lateFrames}, margin ${d.marginTicks} ticks, ahead ${d.predictAhead}, max resim ${d.maxResimTicks}`,
    )
    expect(exact / comparable.length).toBeGreaterThan(0.9)
    // the client authored nothing: the host's sim moved the pawn
    const hostMe = pawnOf(host.auth[host.auth.length - 1], 1)
    expect(Math.hypot(hostMe.x - me0.x, hostMe.y - me0.y)).toBeGreaterThan(30)
    host.session.leave()
    client.session.leave()
  })

  /**
   * Why: other players' direction changes are only known a round trip late. The
   * correction must be bounded by what one RTT of walking can explain and spread
   * over a few frames; the client's own pawn must stay exact.
   */
  it('remote corrections are bounded and smooth; own pawn needs none', async () => {
    const { host, client } = await pair(RTT150, { hostDelayCapTicks: 0 })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(1200)
    const h0 = pawnOf(lastShown(host), 0)
    const c0 = pawnOf(lastShown(client), 1)
    for (let i = 0; i < 20; i++) {
      host.issue({ kind: 'move', x: h0.x + (i % 2 ? 260 : -260), y: h0.y + (i % 3 ? 150 : -150) })
      if (i % 3 === 0) client.issue({ kind: 'move', x: c0.x + (i % 2 ? -200 : 200), y: c0.y })
      await vi.advanceTimersByTimeAsync(180 + (i % 3) * 40)
    }
    await vi.advanceTimersByTimeAsync(1000)
    const hostAt = new Map(host.auth.map((s) => [s.tick, s]))
    let maxJump = 0
    let maxErr = 0
    let ownErr = 0
    const cs = client.shown
    for (let i = 1; i < cs.length; i++) {
      const a = cs[i - 1].state
      const b = cs[i].state
      if (b.tick !== a.tick + 1) continue
      const pa = pawnOf(a, 0)
      const pb = pawnOf(b, 0)
      maxJump = Math.max(maxJump, Math.hypot(pb.x - pa.x, pb.y - pa.y))
      const h = hostAt.get(b.tick)
      if (!h) continue
      maxErr = Math.max(maxErr, Math.hypot(pb.x - pawnOf(h, 0).x, pb.y - pawnOf(h, 0).y))
      const me = pawnOf(b, 1)
      const hm = pawnOf(h, 1)
      ownErr = Math.max(ownErr, Math.hypot(me.x - hm.x, me.y - hm.y))
    }
    const lead = client.session.debug().predictAhead
    console.log(`[corrections] remote max error ${maxErr.toFixed(1)} u, max displayed step ${maxJump.toFixed(1)} u/tick, own max error ${ownErr.toFixed(1)} u, lead ${lead} ticks`)
    // walk speed is 3.5 units / tick: a reversal over the lead (plus the 30 ms snapshot age)
    expect(maxErr).toBeGreaterThan(10)
    expect(maxErr).toBeLessThan(2 * 3.5 * (MAX_AHEAD_TICKS + 2))
    // never the whole error in one frame
    expect(maxJump).toBeLessThan(0.4 * maxErr + 3.6)
    // own inputs ran at their stamps (rare late frames cost a few units at most)
    expect(ownErr).toBeLessThan(12)
    host.session.leave()
    client.session.leave()
  })

  /**
   * Why: re-simulation must stay cheap however the network behaves: at most
   * MAX_AHEAD_TICKS steps per rollback, about one rollback per snapshot.
   */
  it('re-simulation cost per pulse is bounded and measured', async () => {
    const { host, client } = await pair(RTT150)
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(1000)
    const c0 = pawnOf(lastShown(client), 1)
    let maxPerPulse = 0
    let pulses = 0
    let total = 0
    for (let i = 0; i < 600; i++) {
      const n0 = client.steps.n
      await vi.advanceTimersByTimeAsync(4)
      const d = client.steps.n - n0
      maxPerPulse = Math.max(maxPerPulse, d)
      total += d
      pulses++
      if (i % 40 === 0) client.issue({ kind: 'move', x: c0.x + (i % 80 ? 150 : -150), y: c0.y })
    }
    const ms = pulses * 4
    const d = client.session.debug()
    console.log(
      `[resim] ${(total / (ms / 1000)).toFixed(0)} steps/s (${((total / ms) * DT).toFixed(1)} per 60 Hz frame), max ${maxPerPulse} steps in one 4 ms pulse, last rollback ${d.resimTicks} ticks, max ${d.maxResimTicks}`,
    )
    expect(d.maxResimTicks).toBeLessThanOrEqual(MAX_AHEAD_TICKS)
    // one rollback (≤ lead) + one live step, plus the 1 Hz determinism check (≤ 2 steps)
    expect(maxPerPulse).toBeLessThanOrEqual(MAX_AHEAD_TICKS + 4)
    expect((total / ms) * DT).toBeLessThan(MAX_AHEAD_TICKS)
    host.session.leave()
    client.session.leave()
  })

  /** Why: a client that runs prediction against a classic host still converges (stamps are honored by any host). */
  it('works against a host in classic mode', async () => {
    const { host, client } = await pair(RTT80, { netMode: 'classic' })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(1000)
    const me0 = pawnOf(lastShown(client), 1)
    client.issue({ kind: 'move', x: me0.x + 200, y: me0.y })
    await vi.advanceTimersByTimeAsync(2000)
    const hostHash = new Map(host.auth.map((s) => [s.tick, noEvents(s)]))
    const tail = client.shown.filter((x) => hostHash.has(x.state.tick)).slice(-30)
    expect(tail.length).toBe(30)
    for (const x of tail) expect(noEvents(x.state)).toBe(hostHash.get(x.state.tick))
    host.session.leave()
    client.session.leave()
  })
})

describe('predict mode: host fairness', () => {
  /**
   * Why: in P2P the host is the server. Its own inputs reach the authoritative sim
   * instantly while a client's take a one-way trip plus margin, a free reaction-time
   * edge. The host's inputs therefore run `hostDelay` ticks late (median client
   * one-way, capped), but the host sees them at once through its own prediction.
   */
  it("host inputs run ~one client one-way late on the authority but show on the host's next tick", async () => {
    const { host, client } = await pair(RTT150)
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(3000)
    const delay = host.session.debug().hostDelayTicks
    // 150 ms RTT → ~75 ms one-way → 4-5 ticks, under the 6-tick cap
    expect(delay).toBeGreaterThanOrEqual(4)
    expect(delay).toBeLessThanOrEqual(6)

    const authBefore = host.auth.length
    const hostTickAtIssue = host.auth[host.auth.length - 1].tick
    const ms = await reaction(host, 0, 220)
    expect(ms).toBeLessThanOrEqual(DT + 4.5)
    await vi.advanceTimersByTimeAsync(400)
    const target = pawnOf(lastShown(host), 0).moveTarget!
    const applied = host.auth.slice(authBefore).find((s) => pawnOf(s, 0).moveTarget?.x === target.x)!
    const hostLag = applied.tick - 1 - hostTickAtIssue

    // the client's own input: when does the host apply it, relative to the host's clock at issue?
    const cBefore = host.auth.length
    const cTickAtIssue = host.auth[host.auth.length - 1].tick
    const c = pawnOf(lastShown(client), 1)
    client.issue({ kind: 'move', x: c.x - 210, y: c.y + 40 })
    await vi.advanceTimersByTimeAsync(600)
    const cApplied = host.auth.slice(cBefore).find((s) => pawnOf(s, 1).moveTarget?.x === c.x - 210)!
    const clientLag = cApplied.tick - 1 - cTickAtIssue
    console.log(
      `[fairness] host delay ${delay} ticks; input → authority: host ${hostLag} ticks (${(hostLag * DT).toFixed(0)} ms), client ${clientLag} ticks (${(clientLag * DT).toFixed(0)} ms); host sees own input after ${ms.toFixed(0)} ms`,
    )
    expect(hostLag).toBeGreaterThanOrEqual(delay - 1)
    expect(hostLag).toBeLessThanOrEqual(delay + 1)
    expect(clientLag).toBeGreaterThan(0)
    host.session.leave()
    client.session.leave()
  })

  it('offline and classic hosts never delay their own inputs', async () => {
    const { host, client } = await pair(RTT150, { netMode: 'classic' })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(3000)
    expect(host.session.debug().hostDelayTicks).toBe(0)
    host.session.leave()
    client.session.leave()

    const net = createMemoryNet({})
    const solo = makePeer(net, 'Solo', 'k')
    solo.session.openOffline()
    solo.session.startMatch()
    await vi.advanceTimersByTimeAsync(1000)
    expect(solo.session.debug().hostDelayTicks).toBe(0)
    const ms = await reaction(solo, 0, 200)
    expect(ms).toBeLessThanOrEqual(DT + 4.5)
    solo.session.leave()
  })
})

describe('predict mode: match flow', () => {
  /** Why: stats must come from authoritative states, and both peers must agree on the result. */
  it('every peer records the same finished match', async () => {
    const { host, client } = await pair(RTT80, { bots: true }, { bots: true })
    host.session.updateSettings({ winScore: 1, shopSeconds: 1 })
    host.session.addBot('brutal')
    host.session.startMatch()
    for (let s = 0; s < 400 && host.store.screen !== 'results'; s++) await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(host.store.screen).toBe('results')
    expect(client.store.screen).toBe('results')
    expect(client.results).toEqual(host.results)
    expect(host.results).toHaveLength(1)
    // the recorder saw authoritative states only: every one is a host state
    const hostHash = new Map(host.auth.map((s) => [s.tick, noEvents(s)]))
    const sample = client.auth.filter((_, i) => i % 50 === 0)
    for (const s of sample) expect(noEvents(s)).toBe(hostHash.get(s.tick))
    // match-flow events played exactly once on the client, even through rollbacks
    const deaths = client.events.filter((e) => e.type === 'death').length
    const hostDeaths = host.auth.flatMap((s) => s.events).filter((e) => e.type === 'death').length
    expect(deaths).toBe(hostDeaths)
    host.session.leave()
    client.session.leave()
    // a whole bot match runs under fake timers (deterministic outcome); only the real
    // CPU time grows with machine load, so this test gets more than the default 5 s
  }, 30000)

  it('rematch: the client predicts the new match from its first ticks', async () => {
    const { host, client } = await pair(RTT80)
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(2000)
    host.session.rematch()
    await vi.advanceTimersByTimeAsync(600)
    expect(client.store.screen).toBe('match')
    const t = lastShown(client).tick
    const h = host.auth[host.auth.length - 1].tick
    expect(t).toBeLessThan(h + MAX_AHEAD_TICKS)
    expect(t).toBeGreaterThan(h)
    host.session.leave()
    client.session.leave()
  })
})

describe('link monitor', () => {
  /**
   * Why: the UI warns on bad links. The numbers must reflect the real link (RTT,
   * loss) on both sides, and a grade change must fire an event.
   */
  it('reports RTT, loss, channel and grade on both sides and fires grade events', async () => {
    const { host, client } = await pair(RTT150)
    const hostEvents: NetGradeEvent[] = []
    const clientEvents: NetGradeEvent[] = []
    host.session.onNetGrade((e) => hostEvents.push(e))
    client.session.onNetGrade((e) => clientEvents.push(e))
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(4000)
    const c0 = pawnOf(lastShown(client), 1)
    for (let i = 0; i < 10; i++) {
      client.issue({ kind: 'move', x: c0.x + (i % 2 ? 100 : -100), y: c0.y })
      await vi.advanceTimersByTimeAsync(300)
    }
    const hv = host.session.netStats()!
    const cv = client.session.netStats()!
    console.log('[netstats host]', JSON.stringify(hv))
    console.log('[netstats client]', JSON.stringify(cv))
    expect(hv.role).toBe('host')
    expect(cv.role).toBe('client')
    const hr = hv.peers.find((p) => p.playerId === 1)!
    const cr = cv.peers[0]
    for (const r of [hr, cr]) {
      expect(r.rttMs!).toBeGreaterThan(120)
      expect(r.rttMs!).toBeLessThan(200)
      expect(r.lossPct!).toBeGreaterThan(4)
      expect(r.lossPct!).toBeLessThan(20)
      expect(r.channel).toBe('unreliable')
      expect(r.inputAckLagMs!).toBeGreaterThan(100)
      expect(r.desyncs).toBe(0)
      expect(r.correctionPx).not.toBeNull()
      // 150 ms RTT and ~10 % loss: 'bad'
      expect(r.grade).toBe('bad')
    }
    expect(cr.snapshotAgeMs!).toBeLessThan(150)
    // (the lobby may already have moved the grade off 'good' on ping alone)
    expect(clientEvents.some((e) => e.to === 'bad')).toBe(true)
    expect(hostEvents.some((e) => e.playerId === 1 && e.to === 'bad')).toBe(true)
    host.session.leave()
    client.session.leave()
    expect(client.session.netStats()).toBeNull()
  })

  /** Why: a client whose sim diverges from the host's must be visible (desync count, grade reason). */
  it('counts determinism failures when the client sim diverges', async () => {
    const drift = (s: SimState, inputs: PlayerInput[]) => {
      step(s, inputs)
      // a float drifting by one ulp-ish per tick, like an engine with different trig
      if (s.pawns[0]) s.pawns[0].hp -= 1e-9
    }
    const { host, client } = await pair({ latencyMs: 20, jitterMs: 2, loss: 0, seed: 3 }, {}, { step: drift })
    const events: NetGradeEvent[] = []
    client.session.onNetGrade((e) => events.push(e))
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(5000)
    const cr = client.session.netStats()!.peers[0]
    expect(cr.desyncs!).toBeGreaterThan(0)
    expect(events.some((e) => e.reason === 'desync')).toBe(true)
    const hr = host.session.netStats()!.peers.find((p) => p.playerId === 1)!
    expect(hr.desyncs!).toBeGreaterThan(0)
    host.session.leave()
    client.session.leave()
  })
})
