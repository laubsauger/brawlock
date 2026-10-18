import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LobbyView, MatchResult, Screen } from '../game/store'
import type { InputCommand, MatchSettings, PlayerInput, PlayerSlot, SimEvent, SimState } from '../sim/types'
import { codeFromSearch, roomLink } from './code'
import { createMemoryNet, mulberry32, type LinkOptions } from './memory'
import { PROTOCOL_VERSION, decode, encode, type TickEvents } from './protocol'
import { createSession, type MatchRecorder, type NetMode, type SessionDeps } from './session'
import { createBot } from '../bots'
import type { NetFactory } from './transport'

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
  shopSeconds: 30,
  botsReplaceLeavers: false,
  spectatorBets: true,
  bounties: true,
}

interface SimApi {
  createMatch: (settings: MatchSettings, slots: PlayerSlot[], seed: number) => SimState
  step: (state: SimState, inputs: PlayerInput[]) => void
}

/** The real sim, if it works yet. Never faked: the match tests skip instead. */
async function probeSim(): Promise<{ sim: SimApi | null; why: string }> {
  try {
    const sim = await import('../sim')
    const slots: PlayerSlot[] = [
      { id: 0, name: 'a', color: 1, team: 0, kind: 'human' },
      { id: 1, name: 'b', color: 2, team: 1, kind: 'human' },
    ]
    const s = sim.createMatch({ ...SETTINGS }, slots, 1)
    sim.step(s, [])
    return { sim, why: '' }
  } catch (e) {
    return { sim: null, why: e instanceof Error ? e.message : String(e) }
  }
}
const { sim, why: simMissing } = await probeSim()

const noSim: SimApi = {
  createMatch: () => {
    throw new Error('sim not used in lobby tests')
  },
  step: () => {
    throw new Error('sim not used in lobby tests')
  },
}

interface PeerOpts {
  color?: number | null
  profileId?: string
  device?: string
  createBot?: SessionDeps['createBot']
  /** this suite pins the classic (snapshot interpolation) path; predict mode: session.predict.test.ts */
  netMode?: NetMode
}

/** MatchRecorder fake: what this peer would write to its local stats. */
function fakeRecorder() {
  const r = { started: 0, observed: 0, results: [] as MatchResult[], aborted: 0 }
  const recorder: MatchRecorder = {
    start: () => {
      r.started++
    },
    observe: () => {
      r.observed++
    },
    finish: (res) => {
      r.results.push(res)
    },
    abort: () => {
      r.aborted++
    },
  }
  return { r, recorder }
}

function makePeer(net: NetFactory, name: string, key: string, api: SimApi = noSim, opts: PeerOpts = {}) {
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
    result: null as MatchResult | null,
  }
  const screenCbs: ((s: Screen) => void)[] = []
  const out = {
    states: [] as SimState[],
    events: [] as TickEvents[],
    localPlayer: -1,
    net: { rtt: 0, loss: 0 },
  }
  const pending: InputCommand[] = []
  const rec = fakeRecorder()
  const deps: SessionDeps = {
    recorder: rec.recorder,
    profile: () => ({ id: opts.profileId ?? `profile-${name}`, name, color: opts.color ?? null }),
    ...(opts.device ? { device: () => opts.device! } : {}),
    ui: {
      lobby: () => store.lobby,
      setLobby: (p) => {
        store.lobby = { ...store.lobby, ...p }
      },
      screen: () => store.screen,
      setScreen: (s) => {
        store.screen = s
        for (const cb of screenCbs) cb(s)
      },
      setResult: (r) => {
        store.result = r
      },
      paused: () => false,
      onScreen: (cb) => {
        screenCbs.push(cb)
        return () => screenCbs.splice(screenCbs.indexOf(cb), 1)
      },
    },
    frame: {
      reset: () => {
        out.states.length = 0
        out.events.length = 0
      },
      setLocalPlayer: (id) => {
        out.localPlayer = id
      },
      pushState: (s) => {
        out.states.push(s)
      },
      pushEvents: (tick: number, events: SimEvent[]) => {
        out.events.push({ tick, events })
      },
      setNet: (rtt, loss) => {
        out.net = { rtt, loss }
      },
    },
    input: { drain: () => pending.splice(0) },
    audio: { playEvents: () => {} },
    createMatch: api.createMatch,
    step: api.step,
    createBot:
      opts.createBot ??
      (() => {
        throw new Error('no bots in these tests')
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
    netMode: () => opts.netMode ?? 'classic',
  }
  return { session: createSession(deps), store, out, pending, stats: rec.r }
}

const LINK: LinkOptions = { latencyMs: 40, jitterMs: 15, loss: 0.05, seed: 11 }

async function hostAndClient(api: SimApi = noSim, link: LinkOptions = LINK, hostOpts: PeerOpts = {}, clientOpts: PeerOpts = {}) {
  const net = createMemoryNet(link)
  const host = makePeer(net, 'Hosty', 'host-key', api, hostOpts)
  const client = makePeer(net, 'Clienta', 'client-key', api, clientOpts)
  await host.session.openHost()
  const code = codeFromSearch(new URL(host.store.lobby.joinUrl!).search)!
  // typed the way a friend would read it out
  const joined = client.session.join(`${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`)
  await vi.advanceTimersByTimeAsync(500)
  await joined
  return { net, host, client, code }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('session lobby over the network', () => {
  it('renames both current lobby seats without changing their stable identities', async () => {
    const { host, client } = await hostAndClient()
    const ids = host.store.lobby.slots.map((s) => s.profileId)
    host.session.setDisplayName('Same name')
    client.session.setDisplayName('Same name\u0000')
    await vi.advanceTimersByTimeAsync(300)
    expect(host.store.lobby.slots.map((s) => s.name)).toEqual(['Same name', 'Same name'])
    expect(host.store.lobby.slots.map((s) => s.profileId)).toEqual(ids)
    expect(client.store.lobby.slots).toEqual(host.store.lobby.slots)
  })

  it('streams current-match renames deterministically and preserves profile IDs', async () => {
    if (!sim) throw new Error(simMissing)
    const { host, client } = await hostAndClient(sim, { ...LINK, loss: 0 }, { netMode: 'predict' }, { netMode: 'predict' })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(1000)
    const matchId = host.session.debug().matchId
    host.session.setDisplayName('New host')
    client.session.setDisplayName('New guest')
    await vi.advanceTimersByTimeAsync(1000)
    for (const peer of [host, client]) {
      expect(peer.store.lobby.slots.map((s) => [s.name, s.profileId])).toEqual([['New host', 'profile-Hosty'], ['New guest', 'profile-Clienta']])
      expect(peer.out.states.at(-1)!.slots.map((s) => s.name)).toEqual(['New host', 'New guest'])
      expect(peer.session.debug().matchId).toBe(matchId)
    }
    expect(client.session.debug().streamDesyncs).toBe(0)
  })

  it.each(['lobby', 'match'] as const)('rejects a different tab using an active profile in the %s', async (phase) => {
    if (!sim) throw new Error(simMissing)
    const { host, client, code, net } = await hostAndClient(sim, { ...LINK, loss: 0 })
    if (phase === 'match') {
      host.session.startMatch()
      await vi.advanceTimersByTimeAsync(300)
    }
    for (const profileId of ['profile-Clienta', 'profile-Hosty']) {
      const duplicate = makePeer(net, 'Another name', `another-tab-${profileId}`, sim, { profileId })
      const joined = duplicate.session.join(code)
      await vi.advanceTimersByTimeAsync(500)
      await joined
      expect(duplicate.store.lobby.error).toMatch(/already connected.*another tab/i)
      expect(host.store.lobby.slots.map((s) => s.name)).toEqual(['Hosty', 'Clienta'])
      expect(host.store.lobby.slots).toHaveLength(2)
      expect(client.store.lobby.status).toBe('open')
    }
  })

  it.each(['lobby', 'match'] as const)('lets a same-tab refresh replace its live connection in the %s', async (phase) => {
    if (!sim) throw new Error(simMissing)
    const { host, client, code, net } = await hostAndClient(sim, { ...LINK, loss: 0 })
    if (phase === 'match') {
      host.session.startMatch()
      await vi.advanceTimersByTimeAsync(300)
    }
    const id = client.store.lobby.localPlayer
    const refreshed = makePeer(net, 'Refreshed guest', 'client-key', sim, { profileId: 'profile-Clienta' })
    const joined = refreshed.session.join(code)
    await vi.advanceTimersByTimeAsync(600)
    await joined
    expect(refreshed.store.lobby.localPlayer).toBe(id)
    expect(refreshed.store.lobby.status).toBe('open')
    expect(host.store.lobby.slots).toHaveLength(2)
    expect(host.store.lobby.slots.find((s) => s.id === id)).toMatchObject({ name: 'Refreshed guest', profileId: 'profile-Clienta' })
    if (phase === 'match') {
      expect(refreshed.out.localPlayer).toBe(id)
      expect(host.out.states.at(-1)!.scores.find((s) => s.id === id)?.connected).toBe(true)
      expect(refreshed.session.debug().matchId).toBe(host.session.debug().matchId)
    }
  })

  it('a renamed returning profile reclaims its seat even with a new tab key and device', async () => {
    if (!sim) throw new Error(simMissing)
    const { host, client, code, net } = await hostAndClient(sim, { ...LINK, loss: 0 }, { createBot }, { profileId: 'stable-profile-guest', device: 'stable-device-guest' })
    host.session.updateSettings({ botsReplaceLeavers: true })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(500)
    const id = client.store.lobby.localPlayer
    client.session.leave()
    await vi.advanceTimersByTimeAsync(300)
    const back = makePeer(net, 'New guest', 'new-tab-key', sim, { profileId: 'stable-profile-guest', device: 'new-device-guest' })
    const joined = back.session.join(code)
    await vi.advanceTimersByTimeAsync(500)
    await joined
    await vi.advanceTimersByTimeAsync(300)
    expect(back.store.lobby.localPlayer).toBe(id)
    expect(host.store.lobby.slots.find((s) => s.id === id)).toMatchObject({ name: 'New guest', profileId: 'stable-profile-guest' })
    expect(host.out.states.at(-1)!.slots.find((s) => s.id === id)).toMatchObject({ name: 'New guest', profileId: 'stable-profile-guest' })
  })

  it('never reclaims another profile seat merely because a tab key or device matches', async () => {
    if (!sim) throw new Error(simMissing)
    const { host, client, code, net } = await hostAndClient(sim, { ...LINK, loss: 0 }, {}, { device: 'original-device' })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(300)
    const id = client.store.lobby.localPlayer
    client.session.leave()
    await vi.advanceTimersByTimeAsync(300)
    const other = makePeer(net, 'Clienta', 'client-key', sim, { profileId: 'different-profile', device: 'original-device' })
    const joined = other.session.join(code)
    await vi.advanceTimersByTimeAsync(500)
    await joined
    expect(other.store.lobby.localPlayer).not.toBe(id)
    expect(other.out.localPlayer).toBe(-1)
    expect(host.store.lobby.slots.find((s) => s.id === id)?.profileId).toBe('profile-Clienta')
    expect(host.out.states.at(-1)!.scores.find((s) => s.id === id)?.connected).toBe(false)
  })

  it('preserves a waiting bot-seat reservation through a same-tab refresh', async () => {
    if (!sim) throw new Error(simMissing)
    const { host, code, net } = await hostAndClient(sim, { ...LINK, loss: 0 }, { createBot })
    host.session.updateSettings({ shopSeconds: 3 })
    host.session.addBot('hard')
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(3400)
    expect(host.out.states.at(-1)!.phase).toBe('fight')
    const waiting = makePeer(net, 'Waiting guest', 'waiting-tab-key', sim, { profileId: 'waiting-profile' })
    const joined = waiting.session.join(code)
    await vi.advanceTimersByTimeAsync(400)
    await joined
    const id = waiting.store.lobby.localPlayer
    expect(waiting.store.lobby.waitingForRound).toBe(true)
    expect(waiting.out.localPlayer).toBe(-1)
    const refreshed = makePeer(net, 'Renamed waiter', 'waiting-tab-key', sim, { profileId: 'waiting-profile' })
    const rejoined = refreshed.session.join(code)
    await vi.advanceTimersByTimeAsync(400)
    await rejoined
    expect(refreshed.store.lobby.localPlayer).toBe(id)
    expect(refreshed.store.lobby.waitingForRound).toBe(true)
    expect(refreshed.out.localPlayer).toBe(-1)
    expect(host.store.lobby.slots).toHaveLength(3)
    expect(host.out.states.at(-1)!.slots.find((s) => s.id === id)?.kind).toBe('bot')
  })

  it('refuses a new human without a valid profile ID instead of identifying them by name', async () => {
    const net = createMemoryNet(LINK)
    const host = makePeer(net, 'Hosty', 'host-key')
    await host.session.openHost()
    const invalid = makePeer(net, 'Hosty', 'guest-key', noSim, { profileId: 'bad' })
    const joined = invalid.session.join(host.store.lobby.roomCode!)
    await vi.advanceTimersByTimeAsync(500)
    await joined
    expect(host.store.lobby.slots).toHaveLength(1)
    expect(invalid.store.lobby.error).toMatch(/profile.*invalid/i)
  })

  it('a joining client gets its own slot and color, and mirrors every host lobby change', async () => {
    const { host, client, code } = await hostAndClient()
    expect(host.store.lobby.status).toBe('open')
    expect(client.store.lobby.status).toBe('open')
    expect(host.store.lobby.roomCode).toBe(code)
    expect(client.store.lobby.roomCode).toBe(code)
    expect(client.store.screen).toBe('lobby')
    expect(client.store.lobby.localPlayer).toBe(1)
    expect(host.store.lobby.slots.map((s) => s.name)).toEqual(['Hosty', 'Clienta'])
    expect(client.store.lobby.slots).toEqual(host.store.lobby.slots)
    const [a, b] = host.store.lobby.slots
    expect(a.color).not.toBe(b.color)

    host.session.updateSettings({ winScore: 3 })
    host.session.addBot('easy')
    host.session.setTeam(1, 0)
    await vi.advanceTimersByTimeAsync(200)
    expect(client.store.lobby.settings?.winScore).toBe(3)
    expect(client.store.lobby.slots).toEqual(host.store.lobby.slots)
    expect(client.store.lobby.slots).toHaveLength(3)
    expect(client.store.lobby.slots[1].team).toBe(0)
    expect(new Set(host.store.lobby.slots.map((s) => s.color)).size).toBe(3)

    // only the host edits the lobby
    client.session.addBot('hard')
    client.session.updateSettings({ winScore: 99 })
    await vi.advanceTimersByTimeAsync(200)
    expect(host.store.lobby.slots).toHaveLength(3)
    expect(host.store.lobby.settings?.winScore).toBe(3)
  })

  it('a client leaving frees its slot; the host leaving sends the client to the menu with a reason', async () => {
    const first = await hostAndClient()
    first.client.session.leave()
    expect(first.client.store.screen).toBe('menu')
    await vi.advanceTimersByTimeAsync(300)
    expect(first.host.store.lobby.slots).toHaveLength(1)
    expect(first.host.store.lobby.notice).toMatch(/Clienta left/)

    const second = await hostAndClient()
    second.host.session.leave()
    await vi.advanceTimersByTimeAsync(300)
    expect(second.client.store.screen).toBe('menu')
    expect(second.client.store.lobby.status).toBe('error')
    expect(second.client.store.lobby.error).toMatch(/host closed/i)
  })

  it('the host can kick a client, which lands on the menu with a reason', async () => {
    const { host, client } = await hostAndClient()
    host.session.removeSlot(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(host.store.lobby.slots).toHaveLength(1)
    expect(client.store.screen).toBe('menu')
    expect(client.store.lobby.error).toMatch(/removed/i)
  })

  it('rejects a client running another protocol version with a readable error', async () => {
    const net = createMemoryNet(LINK)
    const host = makePeer(net, 'Hosty', 'k')
    await host.session.openHost()
    const pending = net.join(host.store.lobby.roomCode!)
    await vi.advanceTimersByTimeAsync(100)
    const t = await pending
    const got: string[] = []
    t.onMessage((d) => got.push(d))
    t.sendReliable(
      encode({ t: 'hello', name: 'old', version: PROTOCOL_VERSION + 1, key: 'x', profileId: 'profile-old', color: null }),
    )
    await vi.advanceTimersByTimeAsync(300)
    const err = got.map(decode).find((m) => m?.t === 'error')
    expect(err && err.t === 'error' && err.message).toMatch(/version mismatch/i)
    expect(host.store.lobby.slots).toHaveLength(1)
  })

  it('a failed join lands on the menu with the reason instead of throwing', async () => {
    const net = createMemoryNet(LINK)
    const client = makePeer(net, 'Clienta', 'k')
    await client.session.join('ZZZZZ')
    expect(client.store.screen).toBe('menu')
    expect(client.store.lobby.status).toBe('error')
    expect(client.store.lobby.error).toMatch(/no room/i)

    // a mistyped code is explained, not dialed
    await client.session.join('K0RB1')
    expect(client.store.lobby.status).toBe('error')
    expect(client.store.lobby.error).toMatch(/I or O/)
  })
})

describe.skipIf(!sim)(`session match over the network${sim ? '' : ` (SKIPPED: real sim not ready: ${simMissing})`}`, () => {
  /**
   * Why: M0 is host-authoritative state sync. Whatever the client renders must be
   * exactly the host's simulation for that tick (no drift, no lost fields), and a
   * client's commands must reach the host's sim through the lossy channel.
   */
  it("client plays the host's exact states and its inputs drive its pawn on the host", async () => {
    const { host, client } = await hostAndClient(sim!)
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(300)
    expect(host.store.screen).toBe('match')
    expect(client.store.screen).toBe('match')
    expect(host.out.localPlayer).toBe(0)
    expect(client.out.localPlayer).toBe(1)

    const start = host.out.states[host.out.states.length - 1].pawns.find((p) => p.owner === 1)!
    const target = { x: start.x + 300, y: start.y }
    client.pending.push({ kind: 'move', x: target.x, y: target.y })
    await vi.advanceTimersByTimeAsync(3000)

    const hostStates = new Map(host.out.states.map((s) => [s.tick, s]))
    const cs = client.out.states
    expect(cs.length).toBeGreaterThan(120)
    for (let i = 1; i < cs.length; i++) expect(cs[i].tick).toBeGreaterThan(cs[i - 1].tick)
    const last = cs[cs.length - 1]
    // compare as JSON: what the wire can carry is what the client must see
    expect(JSON.stringify(last)).toBe(JSON.stringify(hostStates.get(last.tick)))
    // a sample across the run, not just the end
    for (const s of cs.filter((_, i) => i % 37 === 0)) {
      expect(JSON.stringify(s)).toBe(JSON.stringify(hostStates.get(s.tick)))
    }
    // client display lags the host by latency + jitter buffer, but not more
    const hostTick = host.out.states[host.out.states.length - 1].tick
    expect(hostTick - last.tick).toBeLessThan(15)

    // the client's move reached the host sim
    const moved = host.out.states.some((s) => {
      const p = s.pawns.find((q) => q.owner === 1)!
      const hit = p.moveTarget && Math.abs(p.moveTarget.x - target.x) < 1e-9 && Math.abs(p.moveTarget.y - target.y) < 1e-9
      return hit || Math.hypot(p.x - start.x, p.y - start.y) > 30
    })
    expect(moved).toBe(true)
    expect(client.out.net.rtt).toBeGreaterThan(60)
  })

  it('a client dropping mid-match keeps its pawn on the host, marked disconnected', async () => {
    const { host, client } = await hostAndClient(sim!)
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(500)
    client.session.leave()
    await vi.advanceTimersByTimeAsync(500)
    expect(host.store.screen).toBe('match')
    expect(host.store.lobby.notice).toMatch(/Clienta left/)
    const s = host.out.states[host.out.states.length - 1]
    expect(s.pawns.some((p) => p.owner === 1)).toBe(true)
    expect(s.scores.find((x) => x.id === 1)?.connected).toBe(false)
  })
})

const bots = await import('../bots').catch(() => null)

describe.skipIf(!sim || !bots)('session rematch, pings, profiles and stats', () => {
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

  /**
   * Why: the results → rematch → match loop must be one host click and zero client
   * clicks, with the same lineup and settings but a fresh seed (a new arena roll,
   * not a replay).
   */
  it('rematch keeps slots and settings, draws a new seed, and clients follow without clicking', async () => {
    const calls: { slots: PlayerSlot[]; settings: MatchSettings; seed: number }[] = []
    const spy: SimApi = {
      createMatch: (st, sl, seed) => {
        calls.push({ settings: structuredClone(st), slots: structuredClone(sl), seed })
        return sim!.createMatch(st, sl, seed)
      },
      step: sim!.step,
    }
    const { host, client } = await hostAndClient(spy)
    host.session.addBot('easy')
    host.session.updateSettings({ winScore: 5 })
    host.session.startMatch()
    await advance(1000)

    // host sends everyone back to the lobby; a client flags "wants rematch"
    host.session.backToLobby()
    await advance(300)
    expect(host.store.screen).toBe('lobby')
    expect(client.store.screen).toBe('lobby')
    client.session.setReady(true)
    await advance(300)
    expect(host.store.lobby.ready).toEqual({ 1: true })
    expect(client.store.lobby.ready).toEqual({ 1: true })

    host.session.rematch()
    await advance(600)
    expect(host.store.screen).toBe('match')
    expect(client.store.screen).toBe('match')
    expect(calls).toHaveLength(2)
    expect(calls[1].slots).toEqual(calls[0].slots)
    expect(calls[1].slots).toHaveLength(3)
    expect(calls[1].settings).toEqual(calls[0].settings)
    expect(calls[1].seed).not.toBe(calls[0].seed)
    expect(host.store.lobby.ready).toEqual({})
    expect(client.store.lobby.ready).toEqual({})
    // the client is playing the new match, not the old one
    expect(client.out.states[client.out.states.length - 1].tick).toBeLessThan(40)

    // rematch straight out of a running match restarts it
    host.session.rematch()
    await advance(600)
    expect(calls).toHaveLength(3)
    expect(calls[2].seed).not.toBe(calls[1].seed)
    expect(client.store.screen).toBe('match')
    // aborted matches never reach local stats
    expect(host.stats.results).toEqual([])
  })

  it('everyone sees every player ping, the host at 0', async () => {
    const { host, client } = await hostAndClient()
    await advance(3000)
    const hp = host.store.lobby.pings
    expect(hp[0]).toBe(0)
    // 2 × 40 ms one-way latency plus up to 2 × 15 ms jitter
    expect(hp[1]).toBeGreaterThan(70)
    expect(hp[1]).toBeLessThan(115)
    expect(client.store.lobby.pings[0]).toBe(0)
    expect(Math.abs(client.store.lobby.pings[1] - hp[1])).toBeLessThan(15)
  })

  it('profile ids and preferred colors reach every lobby; a taken color falls back to a free one', async () => {
    const { host, client } = await hostAndClient(noSim, LINK, { color: 0x123456 }, { color: 0x123456 })
    const [h, c] = client.store.lobby.slots
    expect(h).toMatchObject({ profileId: 'profile-Hosty', color: 0x123456 })
    expect(c.profileId).toBe('profile-Clienta')
    expect(c.color).not.toBe(0x123456)
    host.session.addBot('hard')
    await advance(200)
    expect(client.store.lobby.slots[2].profileId).toBe('bot:hard')
  })

  /**
   * Why: with no server, each peer's stats come from its own recording. Host and
   * client must both record the same finished match (same winners, scores, length).
   */
  it('every peer records the finished match', async () => {
    const { host, client } = await hostAndClient(sim!, LINK, { createBot: bots!.createBot }, { createBot: bots!.createBot })
    host.session.updateSettings({ winScore: 1, shopSeconds: 1 })
    host.session.addBot('brutal')
    host.session.startMatch()
    for (let s = 0; s < 400 && host.store.screen !== 'results'; s++) await advance(1000)
    await advance(1000)
    expect(host.store.screen).toBe('results')
    expect(client.store.screen).toBe('results')
    expect(host.stats.results).toHaveLength(1)
    expect(client.stats.results).toHaveLength(1)
    const [hr] = host.stats.results
    const [cr] = client.stats.results
    expect(cr).toEqual(hr)
    expect(hr.ticks).toBeGreaterThan(0)
    expect(hr.winners.length).toBeGreaterThan(0)
    expect(client.stats.observed).toBeGreaterThan(100)
    // a whole bot match runs under fake timers (deterministic outcome); only the real
    // CPU time grows with machine load, so this test gets more than the default 5 s
  }, 30000)
})
