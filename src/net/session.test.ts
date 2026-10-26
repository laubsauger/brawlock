import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LobbyView, MatchResult, Screen } from '../game/store'
import { TICK_HZ, setTickRate, type InputCommand, type MatchSettings, type PlayerInput, type PlayerSlot, type SimEvent, type SimState } from '../sim/types'
import { codeFromSearch, roomLink } from './code'
import { createMemoryNet, mulberry32, type LinkOptions } from './memory'
import { PROTOCOL_VERSION, decode, encode, type TickEvents } from './protocol'
import { createSession, type MatchRecorder, type NetMode, type SessionDeps } from './session'
import { createBot } from '../bots'
import type { NetFactory } from './transport'
import type { ChatLine } from './chat'
import { killPawn } from '../sim/combat'
import { ticks } from '../sim/config'

/** the fake clock's pulse, ms: half a tick (the sessions step from an accumulator) */
const PULSE_MS = 500 / TICK_HZ

/** what people said: the room's join / leave lines left out */
const said = (chat: readonly ChatLine[] | undefined) => chat?.filter((line) => !line.system)

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
  recorder?: MatchRecorder
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
    recorder: opts.recorder ?? rec.recorder,
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
      const id = setInterval(() => onPulse(performance.now()), PULSE_MS)
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
  /** Why: a game server runs 30 or 60 Hz. A client must switch to its room's rate before it builds
   * a match there, or it would predict and time the server's ticks at the wrong speed. */
  it('switches a client to the simulation rate of the room it joins', async () => {
    const net = createMemoryNet({ latencyMs: 1 })
    const room = await net.host()
    const before = TICK_HZ
    const other = before === 30 ? 60 : 30
    room.onConnection((t) => t.onMessage((data) => {
      if (decode(data)?.t === 'hello') t.sendReliable(encode({ t: 'welcome', playerId: 1, hz: other }))
    }))
    const client = makePeer(net, 'Clienta', 'client-key')
    try {
      // the join completes with the room's lobby, which this bare room never sends
      void client.session.join(room.id).catch(() => {})
      await vi.advanceTimersByTimeAsync(200)
      expect(client.store.lobby.localPlayer).toBe(1)
      expect(TICK_HZ).toBe(other)
    } finally {
      client.session.leave()
      setTickRate(before)
    }
  })

  it('shares a three-second custom start, prevents edits/restarts during it and then starts once', async () => {
    if (!sim) throw new Error(simMissing)
    const { host, client } = await hostAndClient(sim, { latencyMs: 1 })
    client.session.requestMatchStart()
    await vi.advanceTimersByTimeAsync(20)
    expect(host.store.lobby.autoStart).toBeNull()
    host.session.requestMatchStart()
    const at = host.store.lobby.autoStart!.at
    await vi.advanceTimersByTimeAsync(20)
    expect(client.store.lobby.autoStart!.at).toBeCloseTo(at, -1)
    host.session.updateSettings({ startGold: 500 })
    host.session.setMaxPlayers(2)
    host.session.requestMatchStart()
    expect(host.store.lobby.settings!.startGold).toBe(30)
    expect(host.store.lobby.maxPlayers).toBe(10)
    expect(host.store.lobby.autoStart!.at).toBe(at)
    await vi.advanceTimersByTimeAsync(2900)
    expect(host.store.screen).toBe('lobby')
    expect(client.store.screen).toBe('lobby')
    await vi.advanceTimersByTimeAsync(200)
    expect(host.store.screen).toBe('match')
    expect(client.store.screen).toBe('match')
    expect(host.store.lobby.autoStart).toBeNull()
    expect(host.stats.started).toBe(1)
    expect(client.store.lobby.notice).toContain('Match started')
    host.session.leave(); client.session.leave()
  })

  it('cancels the custom countdown when leaving or opening another room', async () => {
    if (!sim) throw new Error(simMissing)
    const host = makePeer(createMemoryNet(), 'Host', 'host', sim)
    host.session.openOffline()
    host.session.addBot('dummy')
    host.session.requestMatchStart()
    expect(host.store.lobby.autoStart).not.toBeNull()
    host.session.leave()
    host.session.openOffline()
    await vi.advanceTimersByTimeAsync(3200)
    expect(host.store.screen).toBe('lobby')
    expect(host.store.lobby.autoStart).toBeNull()
    expect(host.stats.started).toBe(0)
    host.session.leave()
  })

  it('keeps unfilled custom seats open, lets hosts close/reopen them, and leaves removed bot seats open', async () => {
    const { host, client, net, code } = await hostAndClient(noSim, { latencyMs: 1 })
    expect(host.session.joinableSeats()).toBe(8)
    expect(client.store.lobby.maxPlayers).toBe(10)
    client.session.setMaxPlayers(2) // P2P guests cannot change the room.
    await vi.advanceTimersByTimeAsync(20)
    expect(host.session.roomState().maxPlayers).toBe(10)
    for (const invalid of [NaN, 0, 1, 11, 2.5]) host.session.setMaxPlayers(invalid)
    expect(host.session.roomState().maxPlayers).toBe(10)
    host.session.setMaxPlayers(2)
    await vi.advanceTimersByTimeAsync(20)
    expect(client.store.lobby.maxPlayers).toBe(2)
    expect(host.session.joinableSeats()).toBe(0)
    const late = makePeer(net, 'Late', 'late-key')
    let joining = late.session.join(code)
    await vi.advanceTimersByTimeAsync(50)
    await joining
    expect(late.store.lobby.error).toMatch(/full/i)
    host.session.setMaxPlayers(3)
    host.session.addBot('hard')
    expect(host.session.joinableSeats()).toBe(1)
    host.session.removeSlot(host.store.lobby.slots.find((s) => s.kind === 'bot')!.id)
    expect(host.session.joinableSeats()).toBe(1)
    joining = late.session.join(code)
    await vi.advanceTimersByTimeAsync(50)
    await joining
    expect(late.store.lobby.status).toBe('open')
    expect(late.store.lobby.maxPlayers).toBe(3)
    host.session.leave(); client.session.leave(); late.session.leave()
  })

  it.each(['classic', 'predict'] as const)('admits a player without bots between rounds, with usable purchases and matching %s states', async (netMode) => {
    if (!sim) throw new Error(simMissing)
    // End the first fight at a fixed tick so the real round/shop flow is reproducible.
    const api: SimApi = { ...sim, step(state, inputs) {
      if (state.phase === 'fight' && state.round === 1 && state.tick >= ticks(6)) {
        for (const pawn of state.pawns) if (pawn.owner !== 0 && pawn.alive) killPawn(state, pawn, null, 'lava')
      }
      sim.step(state, inputs)
    } }
    const { host, client, code, net } = await hostAndClient(api, { latencyMs: 10 }, { netMode }, { netMode })
    host.session.updateSettings({ shopSeconds: 3 })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(3500)
    expect(host.out.states.at(-1)!.phase).toBe('fight')
    expect(host.session.joinableSeats()).toBe(8)
    const late = makePeer(net, 'Late', 'late-key', api, { netMode })
    const joined = late.session.join(code)
    await vi.advanceTimersByTimeAsync(300)
    await joined
    const id = late.store.lobby.localPlayer
    expect(late.store.lobby.waitingForRound).toBe(true)
    expect(late.out.localPlayer).toBe(-1)
    expect(host.out.states.at(-1)!.pawns.some((p) => p.owner === id)).toBe(false)
    expect(host.store.lobby.chat?.some((line) => line.text.includes('Late is waiting to join next round'))).toBe(true)
    await vi.advanceTimersByTimeAsync(6000)
    expect(late.store.lobby.waitingForRound).toBe(false)
    expect(late.out.localPlayer).toBe(id)
    const active = host.out.states.at(-1)!
    expect(active.phase).toBe('shop')
    expect(active.pawns.find((p) => p.owner === id)?.alive).toBe(true)
    expect(active.slots.find((s) => s.id === id)?.takeover).toBeUndefined()
    expect(active.scores.find((s) => s.id === id)?.gold).toBe(40)
    late.pending.push({ kind: 'buySpell', spell: 'lightning' })
    await vi.advanceTimersByTimeAsync(600)
    expect(host.out.states.at(-1)!.pawns.find((p) => p.owner === id)?.slots).toContain('lightning')
    expect(late.out.states.at(-1)!.pawns.find((p) => p.owner === id)?.slots).toContain('lightning')
    if (netMode === 'predict') {
      expect(late.session.debug().netMode).toBe('predict')
      expect(late.session.debug().streamChecks).toBeGreaterThan(0)
      expect(late.session.debug().streamDesyncs).toBe(0)
      expect(client.session.debug().streamDesyncs).toBe(0)
    }
    host.session.leave(); client.session.leave(); late.session.leave()
  })

  it('releases an empty-seat reservation on disconnect and preserves it on same-tab refresh', async () => {
    if (!sim) throw new Error(simMissing)
    const { host, client, net, code } = await hostAndClient(sim, { latencyMs: 1 })
    host.session.updateSettings({ shopSeconds: 3 })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(3400)
    const late = makePeer(net, 'Waiting', 'wait-key', sim)
    let joining = late.session.join(code)
    await vi.advanceTimersByTimeAsync(100)
    await joining
    const id = late.store.lobby.localPlayer
    expect(host.session.joinableSeats()).toBe(7)
    const refreshed = makePeer(net, 'Waiting', 'wait-key', sim)
    joining = refreshed.session.join(code)
    await vi.advanceTimersByTimeAsync(100)
    await joining
    expect(refreshed.store.lobby.localPlayer).toBe(id)
    expect(refreshed.store.lobby.waitingForRound).toBe(true)
    expect(host.store.lobby.slots).toHaveLength(3)
    refreshed.session.leave()
    await vi.advanceTimersByTimeAsync(100)
    expect(host.session.joinableSeats()).toBe(8)
    expect(host.store.lobby.slots).toHaveLength(2)
    expect(host.out.states.at(-1)!.pawns).toHaveLength(2)
    host.session.leave(); client.session.leave()
  })

  it('accepts wait requests only for the sender in a casual quick lobby, with Ready taking priority', async () => {
    const net = createMemoryNet({ latencyMs: 1 })
    let send: (data: string) => void = () => { throw new Error('client not connected') }
    const clientNet: NetFactory = { ...net, async join(code) {
      const t = await net.join(code)
      send = t.sendReliable.bind(t)
      return t
    } }
    const host = makePeer(net, 'Server', 'wait-server')
    const client = makePeer(clientNet, 'Waiting', 'wait-client')
    await host.session.openHost({ dedicated: true })
    const joining = client.session.join(host.store.lobby.roomCode!)
    await vi.advanceTimersByTimeAsync(50)
    await joining
    const request = async (value: unknown, player = 999) => {
      send(JSON.stringify({ t: 'wait', wait: value, player }))
      await vi.advanceTimersByTimeAsync(20)
    }
    try {
      await request(true)
      expect(host.session.roomState().waiting).toEqual([]) // custom room
      host.session.setRoom({ quick: true, ranked: true })
      await request(true)
      expect(host.session.roomState().waiting).toEqual([]) // ranked room
      host.session.setRoom({ ranked: false })
      await request('true')
      expect(host.session.roomState().waiting).toEqual([])
      await request(true)
      expect(host.session.roomState().waiting).toEqual([client.store.lobby.localPlayer])
      expect(client.store.lobby.waitingForPlayers).toEqual([client.store.lobby.localPlayer])
      await request(false)
      client.session.setReady(true)
      await vi.advanceTimersByTimeAsync(20)
      await request(true)
      expect(host.session.roomState().waiting).toEqual([])
      host.session.setRoom({ maintenance: 'Updating' })
      client.session.setReady(false)
      await vi.advanceTimersByTimeAsync(20)
      await request(true)
      expect(host.session.roomState().waiting).toEqual([])
    } finally { client.session.leave(); host.session.leave() }
  })

  it('waits for the owner lobby before completing a join so immediate public listing is not lost', async () => {
    const net = createMemoryNet({ latencyMs: 1 })
    const delayedLobby: NetFactory = {
      ...net,
      async host() {
        const endpoint = await net.host()
        return { ...endpoint, onConnection: (accept) => endpoint.onConnection((transport) => {
          const send = transport.sendReliable.bind(transport)
          transport.sendReliable = (data) => {
            if (decode(data)?.t === 'lobby') setTimeout(() => send(data), 100)
            else send(data)
          }
          accept(transport)
        }) }
      },
    }
    const host = makePeer(delayedLobby, 'Server', 'server-key')
    const owner = makePeer(net, 'Owner', 'owner-key')
    await host.session.openHost({ dedicated: true })
    let joined = false
    const joining = owner.session.join(host.store.lobby.roomCode!).then(() => {
      joined = true
      owner.session.setPublic(true)
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(owner.store.lobby.status).toBe('open')
    expect(joined).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    await joining
    expect(owner.store.lobby.role).toBe('host')
    expect(host.session.roomState().public).toBe(true)
    expect(owner.store.lobby.public).toBe(true)
    owner.session.setPublic(false)
    await vi.advanceTimersByTimeAsync(150)
    expect(host.session.roomState().public).toBe(false)
    expect(owner.store.lobby.public).toBe(false)
    owner.session.leave()
    host.session.leave()
  })

  it('reports an active room only after hosting or accepted welcome, and clears it on leave', async () => {
    const net = createMemoryNet(LINK)
    const host = makePeer(net, 'Hosty', 'host-key')
    const opening = host.session.openHost()
    expect(host.session.isActive()).toBe(false)
    await opening
    expect(host.session.isActive()).toBe(true)
    const client = makePeer(net, 'Clienta', 'client-key')
    const joining = client.session.join(host.store.lobby.roomCode!)
    expect(client.session.isActive()).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(client.session.isActive()).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    await joining
    expect(client.session.isActive()).toBe(true)
    client.session.leave()
    expect(client.session.isActive()).toBe(false)
    host.session.leave()
    expect(host.session.isActive()).toBe(false)
  })

  it('ignores forged sender fields and enforces chat limits on the host', async () => {
    const { net, host, client, code } = await hostAndClient()
    const joining = net.join(code)
    await vi.advanceTimersByTimeAsync(100)
    const raw = await joining
    raw.sendReliable(JSON.stringify({ t: 'say', text: 'not seated' }))
    raw.sendReliable(JSON.stringify({ t: 'chat', line: { id: 99, player: 0, name: 'Spoof', color: 1, text: 'forged' } }))
    await vi.advanceTimersByTimeAsync(100)
    expect(said(host.store.lobby.chat)).toEqual([])
    raw.sendReliable(encode({ t: 'hello', name: 'Raw guest', version: PROTOCOL_VERSION, key: 'raw-key', profileId: 'profile-raw-guest', color: null }))
    await vi.advanceTimersByTimeAsync(200)
    raw.sendReliable(JSON.stringify({ t: 'say', player: 0, name: 'Hosty', text: 'actual guest' }))
    for (let i = 0; i < 4; i++) raw.sendReliable(JSON.stringify({ t: 'say', text: `raw burst ${i}` }))
    await vi.advanceTimersByTimeAsync(200)
    expect(said(host.store.lobby.chat)).toHaveLength(4)
    expect(said(host.store.lobby.chat)?.[0]).toMatchObject({ player: 2, name: 'Raw guest', text: 'actual guest' })
    expect(said(client.store.lobby.chat)).toEqual(said(host.store.lobby.chat))
    raw.close()
    client.session.leave()
    host.session.leave()
  })

  it('delivers room chat reliably with host-owned identity, renamed senders and bounded history on join', async () => {
    const { net, host, client, code } = await hostAndClient()
    expect(host.session.sendChat(' Hello room ')).toBe('sent')
    expect(client.session.sendChat('Good round 🔥')).toBe('sent')
    await vi.advanceTimersByTimeAsync(200)
    expect(said(client.store.lobby.chat)).toEqual(said(host.store.lobby.chat))
    expect(said(host.store.lobby.chat)?.map((x) => [x.player, x.name, x.text])).toEqual([[0, 'Hosty', 'Hello room'], [1, 'Clienta', 'Good round 🔥']])
    client.session.setDisplayName('New name')
    await vi.advanceTimersByTimeAsync(100)
    expect(client.session.sendChat('<b>literal text</b>')).toBe('sent')
    await vi.advanceTimersByTimeAsync(200)
    expect(said(host.store.lobby.chat)?.at(-1)).toMatchObject({ player: 1, name: 'New name', text: '<b>literal text</b>' })
    for (let i = 0; i < 55; i++) {
      await vi.advanceTimersByTimeAsync(2000)
      expect(host.session.sendChat(`line ${i}`)).toBe('sent')
    }
    const late = makePeer(net, 'Latecomer', 'late-key')
    const joining = late.session.join(code)
    await vi.advanceTimersByTimeAsync(500)
    await joining
    expect(late.store.lobby.chat).toHaveLength(50)
    expect(late.store.lobby.chat).toEqual(host.store.lobby.chat)
    // the newcomer gets the bounded history, then their own arrival as a room line
    expect(late.store.lobby.chat?.at(-2)?.text).toBe('line 54')
    expect(late.store.lobby.chat?.at(-1)).toMatchObject({ system: true, player: -1, text: 'Latecomer joined' })
    late.session.leave()
    expect(said(late.store.lobby.chat)).toEqual([])
    client.session.leave()
    host.session.leave()
  })

  it('limits chat bursts, rejects invalid input and clears conversation when opening another room', async () => {
    const { host, client } = await hostAndClient()
    expect(client.session.sendChat(' \n ')).toBe('invalid')
    expect(client.session.sendChat('x'.repeat(241))).toBe('invalid')
    for (let i = 0; i < 4; i++) expect(client.session.sendChat(`burst ${i}`)).toBe('sent')
    expect(client.session.sendChat('too fast')).toBe('limited')
    await vi.advanceTimersByTimeAsync(200)
    expect(said(host.store.lobby.chat)).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(2000)
    expect(client.session.sendChat('after refill')).toBe('sent')
    await vi.advanceTimersByTimeAsync(200)
    expect(said(host.store.lobby.chat)?.at(-1)?.text).toBe('after refill')
    client.session.leave()
    expect(client.session.sendChat('left room')).toBe('unavailable')
    await client.session.openHost()
    expect(said(client.store.lobby.chat)).toEqual([])
    expect(client.session.sendChat('new room')).toBe('sent')
    expect(said(client.store.lobby.chat)?.[0].id).toBe(1)
    client.session.leave()
    host.session.leave()
  })

  it('joins, leaves and mid-match drops appear in everyone\'s chat, so the room knows what happened', async () => {
    if (!sim) throw new Error(simMissing)
    const { net, host, client, code } = await hostAndClient(sim)
    const third = makePeer(net, 'Thirdy', 'third-key', sim)
    const joining = third.session.join(code)
    await vi.advanceTimersByTimeAsync(500)
    await joining
    const events = (chat: readonly ChatLine[] | undefined) => chat?.filter((line) => line.system).map((line) => line.text)
    expect(events(host.store.lobby.chat)).toEqual(['Clienta joined', 'Thirdy joined'])
    expect(events(client.store.lobby.chat)).toEqual(['Clienta joined', 'Thirdy joined'])
    host.session.updateSettings({ shopSeconds: 0.1 })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(600)
    third.session.leave()
    await vi.advanceTimersByTimeAsync(200)
    expect(events(client.store.lobby.chat)?.at(-1)).toMatch(/^Thirdy left/)
    client.session.leave()
    host.session.leave()
  })

  it('keeps the conversation through combat and returning to the lobby', async () => {
    if (!sim) throw new Error(simMissing)
    const { host, client } = await hostAndClient(sim)
    host.session.updateSettings({ shopSeconds: 0.1 })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(600)
    expect(client.store.screen).toBe('match')
    expect(client.session.sendChat('still here')).toBe('sent')
    await vi.advanceTimersByTimeAsync(200)
    expect(said(host.store.lobby.chat)?.at(-1)?.text).toBe('still here')
    host.session.backToLobby()
    await vi.advanceTimersByTimeAsync(200)
    expect(said(client.store.lobby.chat)).toEqual(said(host.store.lobby.chat))
    expect(said(host.store.lobby.chat)).toHaveLength(1)
    client.session.leave()
    host.session.leave()
  })

  it('authoritatively swaps bot colors, reserves human colors and rejects match-time changes', async () => {
    if (!sim) throw new Error(simMissing)
    const { host, client } = await hostAndClient(sim, { ...LINK, loss: 0 })
    host.session.addBot('dummy')
    await vi.advanceTimersByTimeAsync(200)
    const original = client.store.lobby.slots.find((s) => s.id === client.store.lobby.localPlayer)!.color
    const bot = host.store.lobby.slots.find((s) => s.kind === 'bot')!
    client.session.setPlayerColor(bot.color)
    await vi.advanceTimersByTimeAsync(200)
    expect(host.store.lobby.slots.find((s) => s.id === bot.id)!.color).toBe(original)
    expect(client.store.lobby.slots).toEqual(host.store.lobby.slots)
    const confirmed = host.store.lobby.slots.map((s) => s.color)
    client.session.setPlayerColor(host.store.lobby.slots[0].color)
    client.session.setPlayerColor(Number.NaN)
    client.session.setPlayerColor(0x123456)
    await vi.advanceTimersByTimeAsync(200)
    expect(host.store.lobby.slots.map((s) => s.color)).toEqual(confirmed)
    host.session.startMatch()
    client.session.setPlayerColor(original)
    host.session.setPlayerColor(original)
    await vi.advanceTimersByTimeAsync(200)
    expect(host.store.lobby.slots.map((s) => s.color)).toEqual(confirmed)
  })

  it('opens a 10-second vote only for the host, blocks start and counts one changeable ballot per human', async () => {
    const { host, client } = await hostAndClient()
    client.session.startLobbyVote('startGold')
    await vi.advanceTimersByTimeAsync(150)
    expect(host.store.lobby.vote).toBeNull()
    host.session.startLobbyVote('startGold')
    host.session.startLobbyVote('killGold')
    const id = host.store.lobby.vote!.id
    host.session.startMatch()
    expect(host.store.screen).toBe('lobby')
    expect(host.store.lobby.error).toBeNull()
    await vi.advanceTimersByTimeAsync(150)
    expect(client.store.lobby.vote).toMatchObject({ id, setting: 'startGold', eligible: [0, 1] })
    host.session.castLobbyVote(id, 'low')
    host.session.castLobbyVote(id, 'high')
    client.session.castLobbyVote(id - 1, 'low')
    client.session.castLobbyVote(id, 'high')
    client.session.castLobbyVote(id, 'high')
    await vi.advanceTimersByTimeAsync(300)
    expect(host.store.lobby.vote!.votes).toEqual({ 0: 'high', 1: 'high' })
    await vi.advanceTimersByTimeAsync(9400)
    expect(host.store.lobby.settings!.startGold).toBe(30)
    await vi.advanceTimersByTimeAsync(300)
    expect(host.store.lobby.vote).toBeNull()
    expect(host.store.lobby.voteResult).toMatchObject({ reason: 'won', value: 45 })
    expect(client.store.lobby.settings!.startGold).toBe(45)
    host.session.castLobbyVote(id, 'low')
    await vi.advanceTimersByTimeAsync(200)
    expect(host.store.lobby.settings!.startGold).toBe(45)
    host.session.leave(); client.session.leave()
  })

  it.each(['none', 'tie'] as const)('keeps the host value after a %s vote', async (kind) => {
    const { host, client } = await hostAndClient()
    host.session.updateSettings({ startGold: 47 })
    host.session.startLobbyVote('startGold')
    await vi.advanceTimersByTimeAsync(200)
    if (kind === 'tie') {
      host.session.castLobbyVote(host.store.lobby.vote!.id, 'low')
      client.session.castLobbyVote(client.store.lobby.vote!.id, 'high')
    }
    await vi.advanceTimersByTimeAsync(10_100)
    expect(host.store.lobby.settings!.startGold).toBe(47)
    expect(client.store.lobby.voteResult?.reason).toBe(kind === 'none' ? 'noVotes' : 'tie')
    host.session.leave(); client.session.leave()
  })

  it('cancels changed settings, excludes late arrivals and removes a disconnected voter', async () => {
    const { host, client, net, code } = await hostAndClient()
    host.session.startLobbyVote('roundGold')
    const firstId = host.store.lobby.vote!.id
    host.session.updateSettings({ roundGold: 17 })
    expect(host.store.lobby.vote).toBeNull()
    expect(host.store.lobby.voteResult?.reason).toBe('cancelled')
    expect(host.store.lobby.voteResult?.value).toBe(17)
    host.session.startLobbyVote('roundGold')
    const id = host.store.lobby.vote!.id
    const late = makePeer(net, 'Late', 'late')
    const joined = late.session.join(code)
    await vi.advanceTimersByTimeAsync(500)
    await joined
    late.session.castLobbyVote(id, 'low')
    host.session.castLobbyVote(firstId, 'low')
    client.session.castLobbyVote(id, 'low')
    host.session.castLobbyVote(id, 'high')
    await vi.advanceTimersByTimeAsync(200)
    expect(host.store.lobby.vote!.votes).toEqual({ 0: 'high', 1: 'low' })
    client.session.leave()
    await vi.advanceTimersByTimeAsync(200)
    expect(host.store.lobby.vote!.votes).toEqual({ 0: 'high' })
    await vi.advanceTimersByTimeAsync(9500)
    expect(host.store.lobby.settings!.roundGold).toBe(26)
    expect(late.store.lobby.voteResult?.reason).toBe('won')
    host.session.leave(); late.session.leave()
  })

  it('cancels timers when leaving and never carries a proposal into another room', async () => {
    const { host, client } = await hostAndClient()
    host.session.startLobbyVote('startGold')
    host.session.castLobbyVote(host.store.lobby.vote!.id, 'high')
    host.session.openOffline()
    await vi.advanceTimersByTimeAsync(10_200)
    expect(host.store.lobby.vote).toBeNull()
    expect(host.store.lobby.voteResult).toBeNull()
    expect(host.store.lobby.settings!.startGold).toBe(30)
    host.session.startLobbyVote('startGold')
    expect(host.store.lobby.vote).toBeNull()
    host.session.leave(); client.session.leave()
  })

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

  it.each(['device', 'key'] as const)('a renamed returning profile proves its original %s before reclaiming a seat', async (proof) => {
    if (!sim) throw new Error(simMissing)
    const { host, client, code, net } = await hostAndClient(sim, { ...LINK, loss: 0 }, { createBot }, { profileId: 'stable-profile-guest', device: 'stable-device-guest' })
    host.session.updateSettings({ botsReplaceLeavers: true })
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(500)
    const id = client.store.lobby.localPlayer
    client.session.leave()
    await vi.advanceTimersByTimeAsync(300)
    const back = makePeer(net, 'New guest', proof === 'key' ? 'client-key' : 'new-tab-key', sim, { profileId: 'stable-profile-guest', device: proof === 'device' ? 'stable-device-guest' : 'new-device-guest' })
    const joined = back.session.join(code)
    await vi.advanceTimersByTimeAsync(500)
    await joined
    await vi.advanceTimersByTimeAsync(300)
    expect(back.store.lobby.localPlayer).toBe(id)
    expect(host.store.lobby.slots.find((s) => s.id === id)).toMatchObject({ name: 'New guest', profileId: 'stable-profile-guest' })
    expect(host.out.states.at(-1)!.slots.find((s) => s.id === id)).toMatchObject({ name: 'New guest', profileId: 'stable-profile-guest' })
  })

  it('rejects a stolen public profile ID without the private device or reconnect key, including ranked seats', async () => {
    if (!sim) throw new Error(simMissing)
    const net = createMemoryNet({ latencyMs: 1 })
    const host = makePeer(net, 'Server', 'server-key', sim)
    const guest = makePeer(net, 'Guest', 'guest-key', sim, { profileId: 'public-roster-profile', device: 'private-guest-device' })
    await host.session.openHost({ dedicated: true })
    host.session.setRoom({ ranked: true, quick: true, public: true })
    const code = host.store.lobby.roomCode!
    const first = guest.session.join(code)
    await vi.advanceTimersByTimeAsync(20)
    await first
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(50)
    const id = guest.store.lobby.localPlayer
    guest.session.leave()
    await vi.advanceTimersByTimeAsync(20)
    const attacker = makePeer(net, 'Impostor', 'other-private-key', sim, { profileId: 'public-roster-profile', device: 'other-private-device' })
    const attack = attacker.session.join(code)
    await vi.advanceTimersByTimeAsync(30)
    await attack
    expect(attacker.store.lobby.status).toBe('error')
    expect(host.out.states.at(-1)!.scores.find((s) => s.id === id)?.connected).toBe(false)
    expect(host.store.lobby.slots.find((s) => s.id === id)?.name).toBe('Guest')
    const back = makePeer(net, 'Guest renamed', 'new-tab-key', sim, { profileId: 'public-roster-profile', device: 'private-guest-device' })
    const joined = back.session.join(code)
    await vi.advanceTimersByTimeAsync(30)
    await joined
    expect(back.store.lobby.status).toBe('open')
    expect(back.store.lobby.localPlayer).toBe(id)
    host.session.leave()
    back.session.leave()
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
    expect(other.out.localPlayer).toBe(other.store.lobby.localPlayer)
    expect(host.out.states.at(-1)!.pawns.some((p) => p.owner === other.store.lobby.localPlayer)).toBe(true)
    expect(host.store.lobby.slots.find((s) => s.id === id)?.profileId).toBe('profile-Clienta')
    expect(host.out.states.at(-1)!.scores.find((s) => s.id === id)?.connected).toBe(false)
  })

  it('gives the bots of one lobby different builds', async () => {
    // Why: identical bots (same shop build, same persona) make every lobby
    // play the same. The per-bot draw only varies if each bot gets its own
    // random streams through the session's real seeding.
    if (!sim) throw new Error(simMissing)
    const net = createMemoryNet({ ...LINK, loss: 0 })
    const made: ReturnType<typeof createBot>[] = []
    const host = makePeer(net, 'Hosty', 'host-key', sim, {
      createBot: (p, d, s) => {
        const b = createBot(p, d, s)
        made.push(b)
        return b
      },
    })
    await host.session.openHost()
    for (let i = 0; i < 8; i++) host.session.addBot('brutal')
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(200)
    const builds = made.map((b) => (b as unknown as { build: { id: string } | null }).build?.id)
    expect(builds).toHaveLength(8)
    expect(builds.every(Boolean)).toBe(true)
    expect(new Set(builds).size).toBeGreaterThanOrEqual(4)
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

  it('hands a reserved bot seat to its new player the moment the fight ends', async () => {
    // The bot must not keep playing someone's seat through the round-end pause and warm-up:
    // it looks like the new player's warlock is going haywire before they get control.
    if (!sim) throw new Error(simMissing)
    const { host, code, net } = await hostAndClient(sim, { ...LINK, loss: 0 }, { createBot })
    host.session.updateSettings({ shopSeconds: 3 })
    host.session.addBot('hard')
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(3400)
    const waiting = makePeer(net, 'Waiting guest', 'waiting-tab-key', sim, { profileId: 'waiting-profile' })
    const joined = waiting.session.join(code)
    await vi.advanceTimersByTimeAsync(400)
    await joined
    const id = waiting.store.lobby.localPlayer
    expect(waiting.store.lobby.waitingForRound).toBe(true)
    let ended: SimState | undefined
    for (let t = 0; t < 600 && !ended; t++) {
      await vi.advanceTimersByTimeAsync(100)
      // the seat changes hands on the tick the fight ends; the next state carries it
      ended = host.out.states.filter((st) => st.phase === 'roundEnd')[1]
    }
    expect(ended, 'the first round ends').toBeDefined()
    expect(ended!.slots.find((x) => x.id === id)?.kind).toBe('human')
    await vi.advanceTimersByTimeAsync(400)
    expect(waiting.store.lobby.waitingForRound).toBe(false)
    expect(waiting.out.localPlayer).toBe(id)
  }, 60000)

  /** Why: a mid-fight joiner inherits the bot's build, so the handover must open Fresh start for that shop, and it must work over the wire. */
  it('marks a bot seat taken over mid-fight in a custom room, so the newcomer can sell the bot build', async () => {
    if (!sim) throw new Error(simMissing)
    const net = createMemoryNet({ ...LINK, loss: 0 })
    const host = makePeer(net, 'Hosty', 'host-key', sim, { createBot })
    await host.session.openHost()
    // one Fireball hit throws the idle host into instant lava: the fight ends quickly
    host.session.updateSettings({ shopSeconds: 3, kbMultiplier: 10, lavaDps: 5000, startGold: 60 })
    host.session.addBot('hard')
    host.session.startMatch()
    await vi.advanceTimersByTimeAsync(3400)
    expect(host.out.states.at(-1)!.phase).toBe('fight')
    const bot = host.out.states.at(-1)!.slots.find((s) => s.kind === 'bot')!
    const botSpent = host.out.states.at(-1)!.scores.find((s) => s.id === bot.id)!.spent
    expect(botSpent).toBeGreaterThan(0) // the bot shopped in the first shop phase
    const joiner = makePeer(net, 'Late guest', 'late-key', sim, { profileId: 'late-profile' })
    const joined = joiner.session.join(host.store.lobby.roomCode!)
    await vi.advanceTimersByTimeAsync(400)
    await joined
    expect(joiner.store.lobby.localPlayer).toBe(bot.id)
    expect(joiner.store.lobby.waitingForRound).toBe(true)
    // the bot still plays this fight: no takeover yet
    expect(host.out.states.at(-1)!.slots.find((s) => s.id === bot.id)?.takeover).toBeUndefined()
    for (let i = 0; i < 120 && !host.out.states.at(-1)!.slots.find((s) => s.id === bot.id)?.takeover; i++) await vi.advanceTimersByTimeAsync(500)
    const handed = host.out.states.at(-1)!
    const seat = handed.slots.find((s) => s.id === bot.id)!
    expect(seat.kind).toBe('human')
    expect(['roundEnd', 'shop']).toContain(handed.phase)
    expect(seat.takeover).toBe(handed.round)
    const before = handed.scores.find((s) => s.id === bot.id)!
    expect(before.spent).toBeGreaterThanOrEqual(botSpent)
    // the joiner's client restarts as a player at the handover; give it a moment to stream inputs
    await vi.advanceTimersByTimeAsync(1000)
    joiner.pending.push({ kind: 'freshStart' })
    await vi.advanceTimersByTimeAsync(400)
    const after = host.out.states.at(-1)!
    const score = after.scores.find((s) => s.id === bot.id)!
    expect(score.spent).toBe(0)
    expect(score.gold).toBe(before.gold + before.spent)
    expect(after.pawns.find((p) => p.owner === bot.id)!.slots.filter((x) => x !== null)).toEqual(['fireball', 'scourge'])
    joiner.session.leave()
    host.session.leave()
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
    // most of the 3 s of ticks
    expect(cs.length).toBeGreaterThan(ticks(2))
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

describe.skipIf(!sim)('session rematch, pings, profiles and stats', () => {
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

  it.each([false, true])('waits for persistence and preserves an explicit lobby transition: cancel UI = %s', async (cancelUi) => {
    let resolveSave!: () => void
    const save = new Promise<void>((resolve) => { resolveSave = resolve })
    const persisted = vi.fn()
    const recorder: MatchRecorder = {
      start() {}, observe() {}, abort() {},
      finish: async (result) => { await save; result.rating = { status: 'rated' }; persisted(result) },
    }
    // A completed real state isolates async result delivery from combat duration.
    const completed: SimApi = {
      createMatch: (settings, slots, seed) => {
        const state = sim!.createMatch(settings, slots, seed)
        state.phase = 'gameOver'
        return state
      },
      step: sim!.step,
    }
    const { host, client } = await hostAndClient(completed, { latencyMs: 1 }, { recorder })
    host.session.startMatch()
    await advance(1000)
    expect(host.store.screen).toBe('match')
    expect(host.store.result).toBeNull()
    expect(persisted).not.toHaveBeenCalled()
    if (cancelUi) {
      host.session.backToLobby()
      await advance(20)
      expect(client.store.screen).toBe('lobby')
    }
    resolveSave()
    await advance(20)
    expect(persisted).toHaveBeenCalledTimes(1)
    expect(host.store.screen).toBe(cancelUi ? 'lobby' : 'results')
    expect(client.store.screen).toBe(cancelUi ? 'lobby' : 'results')
    expect(client.stats.results).toHaveLength(cancelUi ? 0 : 1)
    if (!cancelUi) expect(host.store.result?.rating).toEqual({ status: 'rated' })
    host.session.leave()
    client.session.leave()
  })

  it('rematch preserves results until everyone consents, supports opting out of the countdown, and then draws a new seed', async () => {
    const calls: { slots: PlayerSlot[]; settings: MatchSettings; seed: number }[] = []
    const spy: SimApi = {
      createMatch: (st, sl, seed) => {
        calls.push({ settings: structuredClone(st), slots: structuredClone(sl), seed })
        return sim!.createMatch(st, sl, seed)
      },
      step: (state, inputs) => {
        if (state.phase === 'fight' && state.round === 1 && state.tick >= ticks(3)) {
          for (const pawn of state.pawns) if (pawn.owner !== 0 && pawn.alive) killPawn(state, pawn, null, 'lava')
        }
        sim!.step(state, inputs)
      },
    }
    const { host, client, net, code } = await hostAndClient(spy)
    host.session.addBot('easy')
    host.session.updateSettings({ winScore: 1, shopSeconds: 1 })
    host.session.startMatch()
    await advance(7500)
    expect(host.store.screen).toBe('results')
    expect(client.store.screen).toBe('results')
    const result = client.store.result
    host.session.rematch()
    await advance(500)
    expect(client.store.screen).toBe('results')
    expect(client.store.result).toBe(result)
    expect(host.store.lobby.autoStart).toBeNull()
    expect(calls).toHaveLength(1)
    client.session.setReady(true)
    await advance(300)
    expect(host.store.lobby.ready).toEqual({ 0: true, 1: true })
    expect(client.store.lobby.autoStart).not.toBeNull()
    const countdown = host.store.lobby.autoStart!.at
    host.session.rematch() // Repeated host clicks must not reset or bypass the deadline.
    expect(host.store.lobby.autoStart!.at).toBe(countdown)
    await advance(2000)
    client.session.setReady(false)
    await advance(300)
    expect(host.store.lobby.autoStart).toBeNull()
    expect(client.store.lobby.autoStart).toBeNull()
    await advance(11_000)
    expect(client.store.screen).toBe('results')
    expect(client.store.result).toBe(result)
    expect(calls).toHaveLength(1)
    host.session.startMatch() // Even the host's direct start path cannot override consent.
    await advance(300)
    expect(calls).toHaveLength(1)

    const arriving = makePeer(net, 'Arrival', 'new-arrival', spy)
    const joined = arriving.session.join(code)
    await advance(300)
    await joined
    const newSeat = arriving.store.lobby.localPlayer
    expect(host.store.lobby.ready[newSeat]).toBeUndefined()
    arriving.session.setReady(true)
    await advance(300)
    expect(host.store.lobby.ready[newSeat]).toBe(true)
    arriving.session.leave()
    await advance(300)
    expect(host.store.lobby.ready[newSeat]).toBeUndefined()
    host.session.addBot('easy') // Restore the bot this temporary visitor replaced.

    client.session.setReady(true)
    await advance(9000)
    expect(host.store.screen).toBe('results')
    await advance(1400)
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

    // Rematch cannot interrupt an active match either.
    host.session.rematch()
    await advance(600)
    expect(calls).toHaveLength(2)
    expect(client.store.screen).toBe('match')
    expect(host.stats.results).toHaveLength(1)
    host.session.leave(); client.session.leave()
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

  // every peer recording the same finished match (classic and predict): replay.test.ts
})
