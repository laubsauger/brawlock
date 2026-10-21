/**
 * Predict mode (the default netcode) end to end: host + client sessions over the
 * in-memory transport with latency, jitter and loss, real sim, fake timers.
 * The classic snapshot path is covered by session.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LobbyView, MatchResult, Screen } from '../game/store'
import { createBot } from '../bots'
import { FIREBALL_SLOT, cloneState, createMatch, hashState, step } from '../sim'
import { killPawn } from '../sim/combat'
import { startRound } from '../sim/mode'
import { ticks } from '../sim/config'
import type { InputCommand, MatchSettings, PlayerId, PlayerInput, SimEvent, SimState, SpellId } from '../sim/types'
import type { Bot } from '../bots'
import { codeFromSearch, roomLink } from './code'
import { createMemoryNet, mulberry32, type LinkOptions } from './memory'
import type { NetGradeEvent } from './netstats'
import { MAX_AHEAD_TICKS, eventKey } from './predict'
import { createSession, type NetMode, type SessionDeps } from './session'
import type { NetFactory, Transport } from './transport'

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
  spectatorBets: true,
  bounties: true,
}

interface PeerOpts {
  netMode?: NetMode
  hostDelayCapTicks?: number
  step?: SessionDeps['step']
  createMatch?: SessionDeps['createMatch']
  bots?: boolean
  /** bots from this factory instead of the real AI (scripted, independent of src/bots tuning) */
  createBot?: SessionDeps['createBot']
  /** record only the hash of each authoritative tick (long runs) */
  hashOnly?: boolean
  inputHints?: boolean
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
  const authHash = new Map<number, number>()
  /** what audio got, and pushEvents batches game/frame.ts would drop (tick already logged) */
  const heard: SimEvent[] = []
  /** every pushed / heard event with the tick of the batch it came in */
  const pushedLog: { tick: number; e: SimEvent }[] = []
  const heardLog: { tick: number; e: SimEvent }[] = []
  const pushedTicks = new Set<number>()
  const droppedBatches: { tick: number; events: SimEvent[] }[] = []
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
      // a stream client steps one confirmed state in place: copy (or hash) what it shows now
      observe: (s) => {
        if (opts.hashOnly) authHash.set(s.tick, noEventsHash(s))
        else auth.push(cloneState(s))
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
        pushedTicks.clear()
      },
      setLocalPlayer: () => {},
      pushState: (state) => {
        shown.push({ state, wall: performance.now() })
      },
      pushEvents: (tick, evs) => {
        // game/frame.ts semantics: empty batches are ignored, a second batch for a tick is dropped
        if (evs.length === 0) return
        if (pushedTicks.has(tick)) {
          droppedBatches.push({ tick, events: evs })
          return
        }
        pushedTicks.add(tick)
        events.push(...evs)
        for (const e of evs) pushedLog.push({ tick, e })
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
    audio: {
      playEvents: (evs, listener) => {
        heard.push(...evs)
        const tick = (listener.state as SimState | undefined)?.tick ?? -1
        for (const e of evs) heardLog.push({ tick, e })
      },
    },
    createMatch: opts.createMatch ?? createMatch,
    step: (s: SimState, inputs: PlayerInput[]) => {
      steps.n++
      baseStep(s, inputs)
    },
    createBot:
      opts.createBot ??
      (opts.bots
        ? createBot
        : () => {
            throw new Error('no bots here')
          }),
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
    inputHints: opts.inputHints,
  }
  const issue = (c: InputCommand) => {
    queue.push(c)
    for (const cb of listeners) cb(c)
  }
  return { session: createSession(deps), store, shown, auth, authHash, events, heard, pushedLog, heardLog, droppedBatches, results, issue, steps }
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

/** Bytes per direction on every link of a memory net (host side: down = host → client). */
interface Meter {
  down: number
  up: number
}
function meteredNet(net: NetFactory): { net: NetFactory; meters: Meter[] } {
  const meters: Meter[] = []
  const wrap = (t: Transport, m: Meter, dir: 'down' | 'up'): Transport =>
    new Proxy(t, {
      get(target, prop) {
        if (prop === 'sendUnreliable' || prop === 'sendReliable')
          return (d: string) => {
            m[dir] += d.length
            ;(target as Transport)[prop](d)
          }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  return {
    meters,
    net: {
      async host() {
        const ep = await net.host()
        return {
          id: ep.id,
          close: () => ep.close(),
          onConnection: (cb) =>
            ep.onConnection((t) => {
              const m: Meter = { down: 0, up: 0 }
              meters.push(m)
              cb(wrap(t, m, 'down'))
            }),
        }
      },
      async join(code, onStatus) {
        const t = await net.join(code, onStatus)
        // client side counts its uplink into the newest meter (same link)
        return wrap(t, meters[meters.length - 1] ?? { down: 0, up: 0 }, 'up')
      },
    },
  }
}

/** A host and `n` clients in one room (one shared metered memory net). */
async function room(link: LinkOptions, n: number, hostOpts: PeerOpts = {}, clientOpts: PeerOpts = {}) {
  const metered = meteredNet(createMemoryNet(link))
  const host = makePeer(metered.net, 'Hosty', 'host-key', hostOpts)
  await host.session.openHost()
  const code = codeFromSearch(new URL(host.store.lobby.joinUrl!).search)!
  const clients: ReturnType<typeof makePeer>[] = []
  for (let i = 0; i < n; i++) {
    const c = makePeer(metered.net, `Client${i}`, `client-key-${i}`, clientOpts)
    const joined = c.session.join(code)
    await vi.advanceTimersByTimeAsync(800)
    await joined
    clients.push(c)
  }
  return { host, clients, meters: metered.meters, code, net: metered.net }
}

const lastShown = (p: { shown: Shown[] }) => p.shown[p.shown.length - 1].state
const noEventsHash = (s: SimState) => hashState({ ...s, events: [] })
const pawnOf = (s: SimState, owner: number) => s.pawns.find((p) => p.owner === owner)!
const noEvents = (s: SimState) => hashState({ ...s, events: [] })

/** 80 ms and 150 ms RTT (one-way latency + uniform jitter), 10 % loss on the unreliable path. */
const RTT80: LinkOptions = { latencyMs: 34, jitterMs: 12, loss: 0.1, seed: 5 }
const RTT150: LinkOptions = { latencyMs: 65, jitterMs: 20, loss: 0.1, seed: 9 }

describe('spectator wagers over the confirmed input stream', () => {
  it('settles duplicate dead-player wagers once at 160 ms RTT with 10% loss and rejects next-round stale resends', async () => {
    const shopSeconds = 0.5
    const roundWinTick = ticks(4)
    const bettingMatch: SessionDeps['createMatch'] = (settings, slots, seed) => {
      const state = createMatch({ ...settings, shopSeconds, roundGold: 0, winGold: 0, killGold: 0 }, slots, seed)
      startRound(state)
      for (const id of [0, 1, 2]) killPawn(state, pawnOf(state, id), 3, 'fireball')
      return state
    }
    const scriptedStep: SessionDeps['step'] = (state, inputs) => {
      // Identical authoritative/predicted fixture events; all economic transitions use real sim code.
      // Driven by state, never by wall time (the session clock is real time even with fake
      // timers, so a loaded machine shifted fixed ticks): round one ends once all three bets are
      // in, with 4 and the bystander 5 falling together (bets need 3+ warlocks alive); round two
      // knocks out the bettors as its fight starts.
      if (state.round === 1 && state.phase === 'fight' && state.tick >= roundWinTick && state.betting.bets.length >= 3 && pawnOf(state, 4).alive) {
        for (const id of [4, 5]) killPawn(state, pawnOf(state, id), 3, 'fireball')
      }
      if (state.round === 2 && state.phase === 'fight' && pawnOf(state, 0).alive) {
        for (const id of [0, 1, 2]) killPawn(state, pawnOf(state, id), 3, 'fireball')
      }
      step(state, inputs)
    }
    const opts: PeerOpts = { createMatch: bettingMatch, step: scriptedStep }
    const r = await room({ latencyMs: 72, jitterMs: 16, loss: 0.1, seed: 18 }, 5, opts, opts)
    const peers = [r.host, ...r.clients]
    try {
      const advanceUntil = async (done: () => boolean, capMs: number) => {
        for (let t = 0; t < capMs && !done(); t += 100) await vi.advanceTimersByTimeAsync(100)
      }
      r.host.session.startMatch()
      await vi.advanceTimersByTimeAsync(700)
      const bettors = peers.slice(0, 3)
      bettors.forEach((peer, id) => {
        const wager: InputCommand = { kind: 'spectateBet', round: 1, target: id < 2 ? 3 : 4 }
        peer.issue(wager)
        peer.issue(wager)
      })
      await advanceUntil(() => (r.host.auth.at(-1)?.betting.bets.length ?? 0) >= 3, 10000)
      const accepted = r.host.auth.at(-1)!
      expect(accepted.betting.bets.map((bet) => bet.player)).toEqual([0, 1, 2])
      expect(accepted.scores.slice(0, 3).map((s) => s.gold)).toEqual([29, 29, 29])
      // Through the celebration pause and the shop, until round two's knockouts are confirmed.
      await advanceUntil(() => { const s = r.host.auth.at(-1)!; return s.round === 2 && !pawnOf(s, 1).alive }, 30000)
      const settled = r.host.auth.at(-1)!
      expect(settled.round).toBe(2)
      expect(settled.betting.lastSettlement).toMatchObject({
        round: 1, winners: [3], bountyAdded: 1,
        payouts: [{ player: 0, amount: 1, correct: true }, { player: 1, amount: 1, correct: true }, { player: 2, amount: 0, correct: false }],
      })
      expect(settled.scores.slice(0, 3).map((s) => s.gold)).toEqual([30, 30, 29])
      expect(settled.betting.bounties).toMatchObject([{ holder: { player: 3 }, amount: 1, activeFromRound: 2 }])
      expect(pawnOf(settled, 1).alive).toBe(false)
      const before = cloneState(settled).betting
      bettors.forEach((peer) => peer.issue({ kind: 'spectateBet', round: 1, target: 4 }))
      await vi.advanceTimersByTimeAsync(1500)
      const final = r.host.auth.at(-1)!
      expect(final.betting).toEqual(before)
      expect(final.scores.slice(0, 3).map((s) => s.gold)).toEqual([30, 30, 29])
      const truth = new Map(r.host.auth.map((s) => [s.tick, noEventsHash(s)]))
      for (const peer of r.clients) {
        const confirmed = peer.auth.filter((s) => s.tick > 250)
        expect(confirmed.length).toBeGreaterThan(200)
        for (const s of confirmed) expect(noEventsHash(s)).toBe(truth.get(s.tick))
        expect(peer.session.debug().streamDesyncs).toBe(0)
      }
    } finally {
      for (const peer of peers) peer.session.leave()
    }
  })
})

describe('dedicated bot prediction', () => {
  it('uses queued bot decisions to reduce turn corrections at 160 ms RTT without delaying own input', async () => {
    // A fixed movement script isolates network behavior from AI balancing and combat.
    const factory: SessionDeps['createBot'] = (player, difficulty): Bot => {
      const pending: { at: number; cmds: InputCommand[] }[] = []
      let origin: { x: number; y: number } | null = null
      return {
        player, difficulty,
        think(s) {
          origin ??= { x: pawnOf(s, player).x, y: pawnOf(s, player).y }
          if (s.tick % 23 === 0) pending.push({ at: s.tick + 12, cmds: [{ kind: 'move', x: origin.x + (Math.floor(s.tick / 23) % 2 ? 250 : -250), y: origin.y }] })
          const cmds: InputCommand[] = []
          while (pending[0]?.at <= s.tick) cmds.push(...pending.shift()!.cmds)
          return cmds
        },
        scheduled: () => pending,
      }
    }
    const metrics: { error: number; ownMs: number; maxStep: number }[] = []
    for (const hints of [false, true]) {
      const net = createMemoryNet({ latencyMs: 72, jitterMs: 16, loss: 0.1, seed: 18 })
      const host = makePeer(net, 'Server', 'server-key', { createBot: factory, inputHints: hints })
      const client = makePeer(net, 'Client', 'client-key')
      await host.session.openHost({ dedicated: true })
      const code = host.store.lobby.roomCode!
      const joining = client.session.join(code)
      await vi.advanceTimersByTimeAsync(800)
      await joining
      host.session.addBot('hard')
      host.session.startMatch()
      await vi.advanceTimersByTimeAsync(1200)
      const ownMs = await reaction(client, 0, 180)
      await vi.advanceTimersByTimeAsync(6500)
      const truth = new Map(host.auth.map((s) => [s.tick, s]))
      let error = 0
      let count = 0
      let maxStep = 0
      for (let i = 1; i < client.shown.length; i++) {
        const s = client.shown[i].state
        const t = truth.get(s.tick)
        if (!t || s.tick < 90) continue
        const p = pawnOf(s, 1)
        const q = pawnOf(t, 1)
        error += Math.hypot(p.x - q.x, p.y - q.y)
        count++
        const prev = client.shown[i - 1].state
        if (prev.tick + 1 === s.tick) maxStep = Math.max(maxStep, Math.hypot(p.x - pawnOf(prev, 1).x, p.y - pawnOf(prev, 1).y))
      }
      metrics.push({ error: error / count, ownMs, maxStep })
      expect(count).toBeGreaterThan(250)
      expect(client.session.debug().streamDesyncs).toBe(0)
      host.session.leave()
      client.session.leave()
    }
    console.log('[bot turns 160ms]', JSON.stringify({ withoutPlans: metrics[0], withPlans: metrics[1] }))
    expect(metrics[1].error).toBeLessThan(metrics[0].error * 0.5)
    expect(metrics[1].maxStep).toBeLessThan(metrics[0].maxStep)
    expect(metrics[1].ownMs).toBeLessThanOrEqual(1000 / 60)
  })
})

/**
 * Time from issuing a move to the first state handed to render whose own pawn
 * reacts (turns toward the target or moves), in ms.
 */
async function reaction(p: ReturnType<typeof makePeer>, owner: number, dx: number): Promise<number> {
  const s0 = lastShown(p)
  const me = pawnOf(s0, owner)
  // the session rounds move targets to 1/100 unit (stream.ts quantizeCmds)
  const q = (v: number) => Math.round(v * 100) / 100
  const target = { x: q(me.x + dx), y: q(me.y + dx / 2) }
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
    // a late own frame (10 % loss, 20 ms jitter: rare but possible) costs ~30 displayed ticks
    // while its correction decays; everything else is exact
    expect(d.lateFrames).toBeLessThanOrEqual(2)
    expect(exact / comparable.length).toBeGreaterThan(0.8)
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
    // the injected drift makes the session warn once; capture it here so a real desync
    // warning anywhere else in the suite stands out
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
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
      // snapshot mode re-simulates a snapshot pair, stream mode compares checkpoint hashes
      expect(warn.mock.calls.filter((c) => /determinism check failed|state hash mismatch/.test(String(c[0])))).toHaveLength(1)
      host.session.leave()
      client.session.leave()
    } finally {
      warn.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// event delivery
// ---------------------------------------------------------------------------

const WATCHED = new Set<SimEvent['type']>(['beam', 'explosion', 'death', 'damage'])

/**
 * A bot with a fixed script instead of the AI, so this scenario does not change when the
 * bots are retuned. Every 60 ticks Lightning (slot 0) at the nearest living enemy, 30
 * ticks later a Fireball at it; in between it walks a circle around the centre. A function
 * of the state only, so every peer that runs it gets the same inputs. Casts are spaced
 * wider than delivery()'s matching window (45 ticks) and come from different spots, so
 * two of its casts are never taken for copies of one another.
 */
function scriptedBot(player: PlayerId): Bot {
  return {
    player,
    difficulty: 'hard',
    think(s) {
      const me = s.pawns.find((p) => p.owner === player)
      if (!me || !me.alive) return []
      let foe: (typeof s.pawns)[number] | null = null
      for (const p of s.pawns) if (p.owner !== player && p.alive && (!foe || Math.hypot(p.x - me.x, p.y - me.y) < Math.hypot(foe.x - me.x, foe.y - me.y))) foe = p
      if (s.tick % 60 === 0 && foe) return [{ kind: 'cast', slot: 0, x: foe.x, y: foe.y }]
      if (s.tick % 60 === 30 && foe) return [{ kind: 'cast', slot: FIREBALL_SLOT, x: foe.x, y: foe.y }]
      if (s.tick % 60 === 15) {
        const a = (s.tick / 60) * 1.3
        return [{ kind: 'move', x: Math.cos(a) * 350, y: Math.sin(a) * 350 }]
      }
      return []
    },
  }
}

/** Lightning in slot 0 for every pawn (host only builds the match). */
function lightningMatch(settings: MatchSettings, slots: Parameters<typeof createMatch>[1], seed: number): SimState {
  const s = createMatch(settings, slots, seed)
  for (const p of s.pawns) {
    p.slots[0] = 'lightning'
    p.levels[0] = 1
  }
  return s
}

/** Cooldowns zeroed every tick, on host and client alike (the sim stays deterministic). */
const spamStep = (s: SimState, inputs: PlayerInput[]) => {
  step(s, inputs)
  for (const p of s.pawns) p.cooldowns.fill(0)
}

interface Delivery {
  auth: number
  drops: { tick: number; e: SimEvent }[]
  dups: number
  dupList: { tick: number; e: SimEvent }[]
  phantoms: number
  phantomList: { tick: number; e: SimEvent }[]
  byType: Record<string, number>
}

/**
 * One-to-one match of authoritative events against what a peer delivered: same
 * identity (eventKey), within 160 units, delivered at most 5 ticks before and
 * `late` ticks after the authoritative tick (late events ride a later batch).
 * An unmatched delivery is a duplicate when it is a second copy of an
 * authoritative event (same identity, within 40 units of it, in its window), a
 * phantom (a mispredicted event the authority never had) otherwise.
 */
function delivery(authStates: SimState[], got: { tick: number; e: SimEvent }[], upTo: number, late: number): Delivery {
  const auth: { tick: number; e: SimEvent; key: string }[] = []
  for (const s of authStates) {
    if (s.tick > upTo) continue
    for (const e of s.events) if (WATCHED.has(e.type)) auth.push({ tick: s.tick, e, key: eventKey(e) })
  }
  const shown = got.filter((g) => WATCHED.has(g.e.type) && g.tick <= upTo + late).map((g) => ({ ...g, key: eventKey(g.e), used: false }))
  const pos = (e: SimEvent): [number, number] => {
    const o = e as unknown as Record<string, number>
    return [o.x ?? o.fromX ?? NaN, o.y ?? o.fromY ?? NaN]
  }
  const near = (a: SimEvent, b: SimEvent) => {
    const [ax, ay] = pos(a)
    const [bx, by] = pos(b)
    return !(Math.hypot(ax - bx, ay - by) > 160)
  }
  // a copy of the same event also ends where the original ended (a beam aimed elsewhere is another cast)
  const same = (a: SimEvent, b: SimEvent) => {
    if (!near(a, b)) return false
    if (a.type !== 'beam' || b.type !== 'beam') return true
    return Math.hypot(a.toX - b.toX, a.toY - b.toY) <= 160
  }
  const drops: Delivery['drops'] = []
  const byType: Record<string, number> = {}
  for (const a of auth) {
    byType[a.e.type] = (byType[a.e.type] ?? 0) + 1
    const m = shown.find((g) => !g.used && g.key === a.key && g.tick >= a.tick - 5 && g.tick <= a.tick + late && near(g.e, a.e))
    if (m) m.used = true
    else drops.push({ tick: a.tick, e: a.e })
  }
  let dups = 0
  let phantoms = 0
  const dupList: Delivery['dupList'] = []
  const phantomList: Delivery['phantomList'] = []
  const copyOf = (g: (typeof shown)[number]) =>
    auth.some((a) => {
      if (a.key !== g.key || g.tick < a.tick - 5 || g.tick > a.tick + late || !same(g.e, a.e)) return false
      const [ax, ay] = pos(a.e)
      const [gx, gy] = pos(g.e)
      return !(Math.hypot(ax - gx, ay - gy) > 40)
    })
  for (const g of shown) {
    // past the cutoff its authoritative twin is not in the list
    if (g.used || g.tick > upTo) continue
    if (copyOf(g)) {
      dups++
      dupList.push({ tick: g.tick, e: g.e })
    } else {
      phantoms++
      phantomList.push({ tick: g.tick, e: g.e })
    }
  }
  return { auth: auth.length, drops, dups, dupList, phantoms, phantomList, byType }
}

describe('event delivery (beam, explosion, death, damage)', () => {
  /**
   * Why: a one-tick event (Lightning's beam) has no second chance. Whatever the
   * link does, every authoritative event caused by the local player, the remote
   * player and a bot must reach render (pushEvents) and audio exactly once on
   * both peers: never dropped by a rollback, never doubled by a re-simulation.
   */
  it.each([
    ['RTT 0', { latencyMs: 0, jitterMs: 0, loss: 0.1, seed: 21 }],
    ['RTT 80', { latencyMs: 34, jitterMs: 12, loss: 0.1, seed: 22 }],
    ['RTT 200', { latencyMs: 90, jitterMs: 20, loss: 0.1, seed: 23 }],
  ] as [string, LinkOptions][])(
    'every event reaches pushEvents and audio exactly once at %s with 10 %% loss',
    async (label, link) => {
      for (const mode of ['predict', 'snapshot', 'classic'] as NetMode[]) {
        const common = { netMode: mode, step: spamStep, bots: true, createBot: scriptedBot }
        const { host, client } = await pair(link, { ...common, createMatch: lightningMatch }, common)
        // hits hurt (Lightning from all three every few ticks): deaths and new rounds happen during the run
        host.session.updateSettings({ shopSeconds: 1, winScore: 50, dmgMultiplier: 5, kbMultiplier: 1.6 })
        host.session.addBot('hard')
        host.session.startMatch()
        await vi.advanceTimersByTimeAsync(1500)
        // both humans cast Lightning (slot 0) at the bot and at each other, and walk
        for (let i = 0; i < 60; i++) {
          const s = lastShown(client)
          const bot = pawnOf(s, 2)
          const me = pawnOf(s, 1)
          const other = pawnOf(s, 0)
          if (i % 5 === 4) client.issue({ kind: 'cast', slot: FIREBALL_SLOT, x: bot.x, y: bot.y })
          else if (i % 3 === 0) client.issue({ kind: 'cast', slot: 0, x: bot.x, y: bot.y })
          else if (i % 3 === 1) client.issue({ kind: 'cast', slot: 0, x: other.x, y: other.y })
          else client.issue({ kind: 'move', x: me.x * 0.7 + 60, y: me.y * 0.7 - 40 })
          const hs = lastShown(host)
          const hb = pawnOf(hs, 2)
          const hme = pawnOf(hs, 0)
          const hc = pawnOf(hs, 1)
          if (i % 5 === 2) host.issue({ kind: 'cast', slot: FIREBALL_SLOT, x: hc.x, y: hc.y })
          else if (i % 3 === 1) host.issue({ kind: 'cast', slot: 0, x: hb.x, y: hb.y })
          else if (i % 3 === 2) host.issue({ kind: 'cast', slot: 0, x: hc.x, y: hc.y })
          else host.issue({ kind: 'move', x: hme.x * 0.7 - 50, y: hme.y * 0.7 + 30 })
          await vi.advanceTimersByTimeAsync(230 + (i % 4) * 40)
        }
        await vi.advanceTimersByTimeAsync(2000)
        const upTo = host.auth[host.auth.length - 1].tick - 90
        const late = 40
        const report: string[] = []
        for (const [who, p] of [
          ['host', host],
          ['client', client],
        ] as const) {
          for (const [chan, log] of [
            ['pushEvents', p.pushedLog],
            ['audio', p.heardLog],
          ] as const) {
            const d = delivery(host.auth, log, upTo, late)
            report.push(`${who}/${chan}: ${d.auth} auth ${JSON.stringify(d.byType)}, drops ${d.drops.length}, dups ${d.dups}, phantoms (mispredicted) ${d.phantoms}`)
            if (d.drops.length) console.log(`[delivery ${label} ${mode}] ${who}/${chan} dropped`, JSON.stringify(d.drops.slice(0, 5)))
            if (d.dups) {
              // (context for a failure: deliveries and authority around each duplicate)
              const nearby = log.filter((g) => d.dupList.some((x) => Math.abs(x.tick - g.tick) <= 45 && g.e.type === x.e.type))
              const authNear = host.auth.filter((st) => d.dupList.some((x) => Math.abs(x.tick - st.tick) <= 45)).flatMap((st) => st.events.filter((e) => d.dupList.some((x) => x.e.type === e.type)).map((e) => ({ tick: st.tick, e })))
              console.log(`[delivery ${label} ${mode}] ${who}/${chan} dups`, JSON.stringify(d.dupList), '\n delivered near:', JSON.stringify(nearby), '\n auth near:', JSON.stringify(authNear))
            }
            expect(d.auth).toBeGreaterThan(0)
            expect(d.drops).toEqual([])
            expect(d.dups).toBe(0)
            // classic shows the authority verbatim; prediction may show a few events the
            // authority never had (a remote player cancelled a cast or dodged out of lava
            // inside the prediction window; this test cancels casts on purpose), never many
            if (mode === 'classic') expect(d.phantoms).toBe(0)
            else expect(d.phantoms).toBeLessThanOrEqual(Math.max(3, 0.05 * d.auth))
            if (d.phantoms) console.log(`[delivery ${label} ${mode}] ${who}/${chan} phantoms`, JSON.stringify(d.phantomList).slice(0, 400))
          }
          expect(p.droppedBatches).toEqual([])
        }
        // every kind of watched event happened; both humans and the (scripted) bot cast
        const all = host.auth.flatMap((s) => s.events)
        const beamOwners = new Set(all.flatMap((e) => (e.type === 'beam' ? [e.owner] : [])))
        expect(beamOwners.has(0) && beamOwners.has(1)).toBe(true)
        const botPawn = host.auth[0].pawns.find((q) => q.owner === 2)!.id
        expect(all.some((e) => e.type === 'cast' && e.pawn === botPawn)).toBe(true)
        for (const t of ['damage', 'death'] as const) expect(all.some((e) => e.type === t)).toBe(true)
        console.log(`[delivery ${label} ${mode}] ${report.join(' | ')}`)
        host.session.leave()
        client.session.leave()
      }
    },
    60000,
  )
})

// ---------------------------------------------------------------------------
// event delivery: fast repeats
// ---------------------------------------------------------------------------

/** match flow is authoritative-only and not part of the ledger's job */
const FLOW = new Set<SimEvent['type']>(['phase', 'roundWin', 'gameOver', 'arenaShrink'])

/**
 * Strict one-to-one match of a peer's delivered events against the authority, per event
 * type: same identity (eventKey), same spot (within 160 units, or both without one), and
 * delivered from MAX_AHEAD_TICKS before to `late` ticks after the authoritative tick (an event
 * revealed by the stream plays with the next displayed tick). Greedy in tick order, so
 * a burst of identical events (Cluster's projectiles) pairs off by count. Returns, per
 * type, the authoritative count, the unmatched authoritative events (drops) and the
 * unmatched deliveries (extras: with only one player acting there is nothing to
 * mispredict, so an extra is an event delivered twice).
 */
function strictDelivery(authStates: SimState[], got: { tick: number; e: SimEvent }[], upTo: number, late: number) {
  const pos = (e: SimEvent): [number, number] => {
    const o = e as unknown as Record<string, number>
    return [o.x ?? o.fromX ?? NaN, o.y ?? o.fromY ?? NaN]
  }
  const auth = authStates.filter((st) => st.tick <= upTo).flatMap((st) => st.events.filter((e) => !FLOW.has(e.type)).map((e) => ({ tick: st.tick, e, key: eventKey(e) })))
  const shown = got.filter((g) => !FLOW.has(g.e.type) && g.tick <= upTo + late).map((g) => ({ ...g, key: eventKey(g.e), used: false })).sort((a, b) => a.tick - b.tick)
  const out: Record<string, { auth: number; drops: number; extras: number }> = {}
  const row = (t: string) => (out[t] ??= { auth: 0, drops: 0, extras: 0 })
  for (const a of auth) {
    row(a.e.type).auth++
    const [ax, ay] = pos(a.e)
    const m = shown.find((g) => {
      // Own actions play immediately even when loss delays their authoritative input.
      // Use the predictor's actual lead bound and keep each match one-to-one.
      if (g.used || g.key !== a.key || g.tick < a.tick - MAX_AHEAD_TICKS || g.tick > a.tick + late) return false
      const [gx, gy] = pos(g.e)
      return !(Math.hypot(ax - gx, ay - gy) > 160)
    })
    if (m) m.used = true
    else row(a.e.type).drops++
  }
  for (const g of shown) if (!g.used && g.tick <= upTo) row(g.e.type).extras++
  return out
}

describe('strict event delivery matching', () => {
  it('allows bounded early prediction while preserving exact duplicate and missing-event counts', () => {
    const state = createMatch(SETTINGS, [], 1)
    const cast: SimEvent = { type: 'cast', pawn: 2, spell: 'splitter', x: 913.27, y: -0.01, level: 3 }
    const main: SimEvent = { type: 'projectileSpawn', id: 24, spell: 'splitter' }
    const child: SimEvent = { type: 'projectileSpawn', id: 25, spell: 'splitter' }
    const auth = [{ ...state, tick: 651, events: [cast, main] }, { ...state, tick: 702, events: [child] }]
    // Same spell on both the main bolt and a later child: match the early main first,
    // rather than consuming the later child's delivery for the main's shared key.
    const delivered = [{ tick: 639, e: cast }, { tick: 639, e: main }, { tick: 690, e: child }]
    expect(strictDelivery(auth, delivered, 750, 60)).toEqual({
      cast: { auth: 1, drops: 0, extras: 0 }, projectileSpawn: { auth: 2, drops: 0, extras: 0 },
    })
    expect(strictDelivery(auth, delivered.concat({ tick: 666, e: cast }, { tick: 666, e: main }), 750, 60)).toEqual({
      cast: { auth: 1, drops: 0, extras: 1 }, projectileSpawn: { auth: 2, drops: 0, extras: 1 },
    })
    expect(strictDelivery(auth, delivered.slice(0, 1), 750, 60)).toEqual({
      cast: { auth: 1, drops: 0, extras: 0 }, projectileSpawn: { auth: 2, drops: 2, extras: 0 },
    })
    expect(strictDelivery(auth, [{ tick: 639, e: { ...cast, x: cast.x + 161 } }], 750, 60).cast).toEqual({ auth: 1, drops: 1, extras: 1 })
    expect(strictDelivery(auth, [{ tick: 651 - MAX_AHEAD_TICKS - 1, e: cast }], 750, 60).cast).toEqual({ auth: 1, drops: 1, extras: 1 })
  })
})

/** Every pawn owns `spells` in slots 0.. (host only builds the match). */
function loadoutMatch(spells: SpellId[], level = 3) {
  return (settings: MatchSettings, slots: Parameters<typeof createMatch>[1], seed: number): SimState => {
    const s = createMatch(settings, slots, seed)
    for (const p of s.pawns) {
      spells.forEach((sp, k) => {
        p.slots[k] = sp
        p.levels[k] = level
      })
    }
    return s
  }
}

describe('event delivery: fast repeats (Recharge chains, Cluster / Twin / Splitter)', () => {
  /**
   * Why: the ledger plays each event once across rollbacks by matching identity, spot and
   * a few ticks. Real play repeats the same kind of event quickly: Recharge resets its own
   * cooldown on a hit (cooldownReset, streak, chained casts), Cluster fires a fan of
   * identical projectiles in one tick, Twin two, Splitter a spawner and its waves. None
   * of them may be dropped, merged into one or delivered twice, on either peer, at
   * 80 and 200 ms with 10 % loss. One player acts at a time (the other stands still), so
   * nothing can be mispredicted and every extra delivery is a real duplicate.
   */
  it.each([
    ['Recharge chains', 'RTT 80', { latencyMs: 34, jitterMs: 12, loss: 0.1, seed: 31 }],
    ['Recharge chains', 'RTT 200', { latencyMs: 90, jitterMs: 20, loss: 0.1, seed: 32 }],
    ['Cluster / Twin / Splitter', 'RTT 80', { latencyMs: 34, jitterMs: 12, loss: 0.1, seed: 33 }],
    ['Cluster / Twin / Splitter', 'RTT 200', { latencyMs: 90, jitterMs: 20, loss: 0.1, seed: 34 }],
  ] as [string, string, LinkOptions][])(
    '%s at %s with 10 %% loss: 0 drops, 0 duplicates per event type on both peers',
    async (scenario, label, link) => {
      const recharge = scenario.startsWith('Recharge')
      // Recharge keeps its real cooldown (its reset is the point); the bursts get theirs
      // zeroed so a short test sees many casts, spaced 50 ticks apart like quick real play
      const common = { netMode: 'predict' as NetMode, createMatch: loadoutMatch(recharge ? ['recharge'] : ['cluster', 'twin', 'splitter']), ...(recharge ? {} : { step: spamStep }) }
      for (const actor of ['client', 'host'] as const) {
        const { host, client } = await pair(link, common, common)
        host.session.updateSettings({ shopSeconds: 1, winScore: 50, dmgMultiplier: 0.2, kbMultiplier: 0.25 })
        host.session.startMatch()
        await vi.advanceTimersByTimeAsync(1500)
        const me = actor === 'client' ? client : host
        const meId = actor === 'client' ? 1 : 0
        for (let i = 0; i < 150; i++) {
          const s = lastShown(me)
          const foe = pawnOf(s, 1 - meId)
          const self = pawnOf(s, meId)
          // walk to 320 units from the (idle) foe, on its side towards the centre, then fire
          const r = Math.hypot(foe.x, foe.y) || 1
          const spot = { x: foe.x - (foe.x / r) * 320, y: foe.y - (foe.y / r) * 320 }
          // a new cast only when the last one fired: re-casting during the cast point cancels
          // it, and a remote peer cannot know that in advance (a misprediction, not this test)
          if (self.cast) {
            // casting: any new command would cancel it
          } else if (Math.hypot(self.x - spot.x, self.y - spot.y) > 60) me.issue({ kind: 'move', ...spot })
          else if (recharge) {
            if (self.cooldowns[0] === 0 && i % 3 === 0) me.issue({ kind: 'cast', slot: 0, x: foe.x, y: foe.y })
          } else if (i % 6 === 0) me.issue({ kind: 'cast', slot: (i / 6) % 3, x: foe.x, y: foe.y })
          await vi.advanceTimersByTimeAsync(140)
        }
        await vi.advanceTimersByTimeAsync(2500)
        const upTo = host.auth[host.auth.length - 1].tick - 120
        const all = host.auth.filter((st) => st.tick <= upTo).flatMap((st) => st.events)
        // the scenario happened: chained Recharge hits / bursts of identical projectiles, and
        // no cast was cancelled (a remote peer cannot foresee a cancel: that would be a
        // misprediction, outside what this test measures)
        expect(all.filter((e) => e.type === 'castCancel')).toEqual([])
        if (recharge) {
          expect(all.filter((e) => e.type === 'cooldownReset').length).toBeGreaterThanOrEqual(3)
          expect(all.filter((e) => e.type === 'streak').length).toBeGreaterThanOrEqual(3)
        } else {
          const perTick = new Map<number, number>()
          for (const st of host.auth) for (const e of st.events) if (e.type === 'projectileSpawn' && e.spell === 'cluster') perTick.set(st.tick, (perTick.get(st.tick) ?? 0) + 1)
          expect(Math.max(0, ...perTick.values())).toBeGreaterThanOrEqual(3)
          for (const sp of ['cluster', 'twin', 'splitter']) expect(all.some((e) => e.type === 'projectileSpawn' && e.spell === sp)).toBe(true)
        }
        const report: string[] = []
        for (const [who, p] of [
          ['host', host],
          ['client', client],
        ] as const) {
          for (const [chan, log] of [
            ['pushEvents', p.pushedLog],
            ['audio', p.heardLog],
          ] as const) {
            const d = strictDelivery(host.auth, log, upTo, 60)
            const bad = Object.entries(d).filter(([, r]) => r.drops || r.extras)
            report.push(`${who}/${chan} ${JSON.stringify(d)}`)
            expect(bad, `${scenario} ${label}, ${actor} acting: ${who}/${chan}`).toEqual([])
          }
          expect(p.droppedBatches).toEqual([])
        }
        console.log(`[repeats ${scenario} ${label} ${actor} acting] ${report[0]} | ${report[2]}`)
        host.session.leave()
        client.session.leave()
      }
    },
    60000,
  )
})

// ---------------------------------------------------------------------------
// input stream (M4.2)
// ---------------------------------------------------------------------------

/** Bot-filled room: host + one client (both idle humans) + bots, everyone fighting. */
async function botRoom(link: LinkOptions, players: number, mode: NetMode, extra: PeerOpts = {}) {
  const opts: PeerOpts = { netMode: mode, bots: true, ...extra }
  const r = await room(link, 1, opts, opts)
  r.host.session.updateSettings({ shopSeconds: 1, winScore: 50 })
  for (let i = 0; i < players - 2; i++) r.host.session.addBot('hard')
  r.host.session.startMatch()
  return r
}

describe('input stream (M4.2)', () => {
  /**
   * Why: snapshots cost ~150-300 KB/s per player; the stream sends only the stepped
   * inputs. At 8-10 players it must be at least 10× less traffic to the client, while
   * the client really runs on the stream (not snapshots) and stays exact.
   */
  it.each([8, 10])('%i players: the stream needs ≥10× less downlink than snapshots', async (players) => {
    const down: Record<string, number> = {}
    for (const mode of ['snapshot', 'predict'] as NetMode[]) {
      const r = await botRoom(RTT80, players, mode)
      await vi.advanceTimersByTimeAsync(3000)
      const m = r.meters[0]
      const d0 = m.down
      const u0 = m.up
      await vi.advanceTimersByTimeAsync(10000)
      down[mode] = (m.down - d0) / 10
      const up = (m.up - u0) / 10
      const dbg = r.clients[0].session.debug()
      console.log(`[stream bytes ${players}p ${mode}] down ${(down[mode] / 1024).toFixed(1)} KB/s, up ${(up / 1024).toFixed(2)} KB/s, streaming ${dbg.streamTick >= 0}, checks ${dbg.streamChecks}, desyncs ${dbg.streamDesyncs}`)
      if (mode === 'predict') {
        expect(dbg.streamTick).toBeGreaterThan(600)
        expect(r.host.session.debug().streamPeers).toBe(1)
        expect(dbg.streamChecks).toBeGreaterThan(5)
        expect(dbg.streamDesyncs).toBe(0)
      }
      r.host.session.leave()
      r.clients[0].session.leave()
    }
    expect(down.snapshot / down.predict).toBeGreaterThanOrEqual(10)
  }, 60000)

  /** Why: no drift. The client's confirmed state must equal the host's at every checkpoint for 10k+ ticks under loss. */
  it('a client reaches the same state hash as the host over 10k ticks with 10 % loss', async () => {
    const r = await botRoom(RTT80, 4, 'predict', { hashOnly: true })
    await vi.advanceTimersByTimeAsync(10500 / 60 * 1000)
    const host = r.host.authHash
    const client = r.clients[0].authHash
    let compared = 0
    for (const [tick, h] of client) {
      const hh = host.get(tick)
      if (hh === undefined) continue
      compared++
      if (hh !== h) throw new Error(`confirmed state differs from the host at tick ${tick}`)
    }
    const dbg = r.clients[0].session.debug()
    console.log(`[stream 10k] ${compared} ticks compared, client confirmed tick ${dbg.streamTick}, hash checks ${dbg.streamChecks}, desyncs ${dbg.streamDesyncs}`)
    expect(compared).toBeGreaterThan(10000)
    expect(dbg.streamDesyncs).toBe(0)
    r.host.session.leave()
    r.clients[0].session.leave()
  }, 120000)

  /** Why: a player who drops and comes back mid-match must converge from a keyframe, not stay broken. */
  it('a player who rejoins mid-match converges via a keyframe', async () => {
    const net = createMemoryNet(RTT80)
    const host = makePeer(net, 'Hosty', 'host-key', { bots: true })
    await host.session.openHost()
    const code = codeFromSearch(new URL(host.store.lobby.joinUrl!).search)!
    const first = makePeer(net, 'Clienta', 'client-key', {})
    let joined = first.session.join(code)
    await vi.advanceTimersByTimeAsync(800)
    await joined
    host.session.updateSettings({ shopSeconds: 1, winScore: 50, botsReplaceLeavers: true })
    host.session.addBot('hard')
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(8000)
    const seat = first.store.lobby.localPlayer
    first.session.leave()
    await vi.advanceTimersByTimeAsync(2000)
    // same tab key: takes its seat back
    const again = makePeer(net, 'Clienta', 'client-key', {})
    joined = again.session.join(code)
    await vi.advanceTimersByTimeAsync(800)
    await joined
    await vi.advanceTimersByTimeAsync(4000)
    const dbg = again.session.debug()
    expect(lastShown(again).pawns.some((p) => p.owner === again.store.lobby.localPlayer)).toBe(true)
    expect(again.store.lobby.localPlayer).toBe(seat)
    // started well past tick 0: the stream began from a keyframe
    expect(again.auth[0].tick).toBeGreaterThan(400)
    const hostHash = new Map(host.auth.map((s) => [s.tick, noEventsHash(s)]))
    const tail = again.auth.slice(-120)
    for (const s of tail) expect(noEventsHash(s)).toBe(hostHash.get(s.tick))
    expect(dbg.streamDesyncs).toBe(0)
    host.session.leave()
    again.session.leave()
  }, 60000)

  /** Why: a divergence (engine bug, corrupted state) must be detected by the hash checks and healed by a keyframe. */
  it('a forced divergence is detected and healed via a keyframe snapshot', async () => {
    const perturbed = (s: SimState, inputs: PlayerInput[]) => {
      step(s, inputs)
      // once: whoever steps tick 400 (prediction and confirmed state alike) drifts; the
      // RNG state never heals by itself (hp would regenerate back to its cap)
      if (s.tick === 400) s.rng = (s.rng + 1) >>> 0
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = await room(RTT80, 1, { bots: true }, { step: perturbed })
      r.host.session.updateSettings({ shopSeconds: 1, winScore: 50 })
      r.host.session.addBot('hard')
      r.host.session.startMatch()
      await vi.advanceTimersByTimeAsync(15000)
      const c = r.clients[0]
      const dbg = c.session.debug()
      expect(dbg.streamDesyncs).toBe(1)
      expect(warn.mock.calls.filter((x) => /state hash mismatch/.test(String(x[0])))).toHaveLength(1)
      // healed: the latest confirmed states equal the host's again
      const hostHash = new Map(r.host.auth.map((s) => [s.tick, noEventsHash(s)]))
      const tail = c.auth.slice(-200)
      for (const s of tail) expect(noEventsHash(s)).toBe(hostHash.get(s.tick))
      expect(tail[0].tick).toBeGreaterThan(600)
      r.host.session.leave()
      c.session.leave()
    } finally {
      warn.mockRestore()
    }
  }, 60000)

  /** Why: spectators (joined mid-match) need no stream state; they watch the host's snapshots. */
  it('a mid-match joiner spectates on snapshots and sees the host state', async () => {
    // No bot seat to reserve: this is a spectator, rather than a next-round entrant.
    const r = await room(RTT80, 1)
    r.host.session.startMatch()
    await vi.advanceTimersByTimeAsync(5000)
    const late = makePeer(r.net, 'Late', 'late-key', {})
    const joined = late.session.join(r.code)
    await vi.advanceTimersByTimeAsync(800)
    await joined
    await vi.advanceTimersByTimeAsync(3000)
    expect(late.session.debug().netMode).toBe('classic')
    expect(late.session.debug().streamTick).toBe(-1)
    const hostHash = new Map(r.host.auth.map((s) => [s.tick, noEventsHash(s)]))
    expect(late.auth.length).toBeGreaterThan(100)
    for (const s of late.auth.filter((_, i) => i % 20 === 0)) expect(noEventsHash(s)).toBe(hostHash.get(s.tick))
    // the stream client keeps streaming meanwhile
    expect(r.clients[0].session.debug().streamDesyncs).toBe(0)
    r.host.session.leave()
    r.clients[0].session.leave()
    late.session.leave()
  }, 30000)
})

describe('remote-action latency (M4.2)', () => {
  /** Time from A issuing a move to the first state B shows with A's pawn reacting to it. */
  async function remoteLatency(a: ReturnType<typeof makePeer>, b: ReturnType<typeof makePeer>, aPlayer: number, samples: number): Promise<number[]> {
    const out: number[] = []
    for (let i = 0; i < samples; i++) {
      await vi.advanceTimersByTimeAsync(260 + (i % 3) * 37)
      const me = pawnOf(lastShown(a), aPlayer)
      const q = (v: number) => Math.round(v * 100) / 100
      const target = { x: q(me.x + (i % 2 ? 160 : -160)), y: q(me.y + (i % 3 ? 70 : -70)) }
      const before = b.shown.length
      const t0 = performance.now()
      a.issue({ kind: 'move', ...target })
      let ms = Infinity
      for (let k = 0; k < 600 && ms === Infinity; k++) {
        await vi.advanceTimersByTimeAsync(1)
        for (let j = before; j < b.shown.length; j++) {
          const p = pawnOf(b.shown[j].state, aPlayer)
          if (p.moveTarget && p.moveTarget.x === target.x) {
            ms = b.shown[j].wall - t0
            break
          }
        }
      }
      out.push(ms)
    }
    return out
  }

  /**
   * Why: latency first. Seeing other players act must be no slower on the input stream
   * than on snapshots (the host relays each step the tick it runs it); relaying raw
   * inputs as hints should make it faster, or it is not worth keeping.
   */
  it.each([
    ['80 ms', RTT80],
    ['200 ms', { latencyMs: 90, jitterMs: 20, loss: 0.1, seed: 31 } as LinkOptions],
  ])('remote action latency at %s RTT: snapshot vs stream vs stream + hints', async (label, link) => {
    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]
    const res: Record<string, { c2c: number; h2c: number }> = {}
    for (const [name, mode, hints] of [
      ['snapshot', 'snapshot', false],
      ['stream', 'predict', false],
      ['stream+hints', 'predict', true],
    ] as [string, NetMode, boolean][]) {
      const opts: PeerOpts = { netMode: mode, inputHints: hints }
      const r = await room(link, 2, opts, opts)
      r.host.session.startMatch()
      await vi.advanceTimersByTimeAsync(2500)
      const [a, b] = r.clients
      const pa = a.store.lobby.localPlayer
      const c2c = await remoteLatency(a, b, pa, 8)
      const h2c = await remoteLatency(r.host, b, 0, 8)
      res[name] = { c2c: med(c2c), h2c: med(h2c) }
      console.log(`[remote ${label} ${name}] client→client ${c2c.map((x) => x.toFixed(0)).join(' ')} ms (median ${med(c2c).toFixed(0)}), host→client ${h2c.map((x) => x.toFixed(0)).join(' ')} ms (median ${med(h2c).toFixed(0)})`)
      for (const p of [r.host, ...r.clients]) p.session.leave()
    }
    // the stream is no slower than snapshots (one tick of slack for timing noise)
    expect(res.stream.c2c).toBeLessThanOrEqual(res.snapshot.c2c + DT)
    expect(res.stream.h2c).toBeLessThanOrEqual(res.snapshot.h2c + DT)
    // hints never make it slower
    expect(res['stream+hints'].c2c).toBeLessThanOrEqual(res.stream.c2c + DT)
  }, 60000)
})
