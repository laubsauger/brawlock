/**
 * Dedicated server (M4.1) end to end over real local TCP: server/listen.mjs on an
 * ephemeral port, headless client sessions (predict mode) joining through the same
 * hybrid net the browser uses (online.ts). Real timers: real sockets. Session clocks run
 * TIME_SCALE× faster than wall time on both sides (same code paths, shorter matches).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { LobbyView, MatchResult, Screen } from '../game/store'
import { createBot } from '../bots'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import type { SimState } from '../sim/types'
import { startServer, type DedicatedServer } from '../../server/listen.mjs'
import { startClock } from './clock'
import { Online, ServerError, hybridNet, parseRegions, type ServerRegion } from './online'
import { PROTOCOL_VERSION, decode, encode } from './protocol'
import { KeyedLimiter, TokenBucket } from './ratelimit'
import { createSession } from './session'
import type { NetFactory } from './transport'
import { wsNet } from './ws'

const TIME_SCALE = 4
let servers: DedicatedServer[] = []
const quiet = () => {}
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
})

const until = async (pred: () => boolean, ms: number, what: string) => {
  const t0 = performance.now()
  while (!pred()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const noP2P: NetFactory = {
  host: () => Promise.reject(new Error('no p2p in this test')),
  join: () => Promise.reject(new Error('no p2p in this test')),
}

interface ClientOpts {
  key?: string
  device?: string
  build?: string
  /** a bot plays the seat from the predicted view */
  play?: boolean
  /** extra regions next to `base` (multi-region builds) */
  regions?: ServerRegion[]
}

/** A headless browser client: the real session, the hybrid net, a bot at the keyboard. */
function headlessClient(base: string | null, opts: ClientOpts = {}) {
  let lobby = { role: 'offline', joinUrl: null, roomCode: null, status: 'idle', error: null, slots: [], settings: null, localPlayer: 0, pings: {}, ready: {} } as LobbyView
  let screen: Screen = 'menu'
  let shown: SimState | null = null
  const results: MatchResult[] = []
  let bot: ReturnType<typeof createBot> | null = null
  let thought = -1
  const online = new Online({ regions: [...(base ? [{ id: 'test', label: 'Test', url: base }] : []), ...(opts.regions ?? [])], build: opts.build ?? 'dev-test' })
  let routed: ServerRegion | null = null
  const notices: string[] = []
  const session = createSession({
    ui: {
      lobby: () => lobby,
      setLobby: (p) => {
        lobby = { ...lobby, ...p }
        if (p.notice) notices.push(p.notice)
      },
      screen: () => screen,
      setScreen: (s) => {
        screen = s
      },
      setResult: () => {},
      paused: () => false,
      onScreen: () => () => {},
    },
    profile: () => ({ id: `profile-${opts.key ?? 'headless'}`, name: 'Headless', color: null }),
    recorder: {
      start: (info) => {
        bot = opts.play !== false && info.localPlayer >= 0 ? createBot(info.localPlayer, 'hard', 99) : null
        thought = -1
      },
      observe: () => {},
      finish: (r) => {
        results.push(r)
      },
      abort: () => {},
    },
    frame: { reset: () => (shown = null), setLocalPlayer: () => {}, pushState: (s) => (shown = s), pushEvents: () => {}, setNet: () => {} },
    input: {
      drain: () => {
        const s = shown
        if (!bot || !s || s.tick === thought) return []
        thought = s.tick
        return bot.think(s)
      },
    },
    audio: { playEvents: () => {} },
    createMatch,
    step,
    createBot,
    defaultSettings: DEFAULT_SETTINGS,
    net: hybridNet(noP2P, online, (url) => wsNet(url), (r) => (routed = r)),
    startClock: (onPulse) => startClock((t) => onPulse(t * TIME_SCALE)),
    now: () => performance.now() * TIME_SCALE,
    random: Math.random,
    joinUrl: (c) => `http://test/?room=${c}`,
    clientKey: () => opts.key ?? 'headless-key',
    netMode: () => 'predict',
    device: opts.device ? () => opts.device! : undefined,
    build: opts.build ?? 'dev-test',
  })
  return { session, online, lobby: () => lobby, screen: () => screen, results, notices, shown: () => shown, routed: () => routed }
}

async function start(config: Record<string, unknown> = {}, build = 'dev-server') {
  const srv = await startServer({ port: 0, build, config, timeScale: TIME_SCALE, log: quiet })
  servers.push(srv)
  return { srv, base: `ws://127.0.0.1:${srv.port}`, http: `http://127.0.0.1:${srv.port}` }
}

describe('dedicated server (M4.1)', () => {
  /**
   * Why: the priority feature. A player opens a room on the server, owns it (host
   * controls without hosting), plays a full match with bots in predict mode against the
   * server's authority, starts a rematch, and leaves; the empty room closes.
   */
  it('create a room, own it, play a match and a rematch, leave; the empty room closes', async () => {
    const { srv, base, http } = await start({ emptyRoomMs: 400, region: 'test' })
    const health = (await (await fetch(`${http}/health`)).json()) as { ok: boolean; protocol: number; rooms: number }
    expect(health).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION, region: 'test', rooms: 0 })

    const owner = headlessClient(base)
    const code = await owner.online.createRoom('test')
    expect(code).toMatch(/^[A-HJ-NP-Z]{5}$/)
    await owner.session.join(code)
    expect(owner.lobby().status).toBe('open')
    // the owner of a server room gets the host's controls
    expect(owner.lobby().role).toBe('host')
    expect(owner.session.transport()).toBe('server')
    expect(owner.lobby().joinUrl).toContain(code)

    owner.session.addBot('brutal')
    owner.session.updateSettings({ winScore: 1, shopSeconds: 1, lavaDps: 400, dmgMultiplier: 2, kbMultiplier: 1.6 })
    await until(() => owner.lobby().slots.length === 2 && owner.lobby().settings?.winScore === 1, 3000, 'owner lobby edits')
    owner.session.startMatch()
    await until(() => owner.screen() === 'match', 5000, 'the match to start')
    await until(() => owner.screen() === 'results', 50000, 'the match to finish')
    expect(owner.results).toHaveLength(1)
    // the server announces itself: the connection monitor labels the link as the server
    const view = owner.session.netStats()!
    expect(view.server).toBe(true)
    expect(view.peers[0].playerId).toBe(-1)

    owner.session.rematch()
    await until(() => owner.screen() === 'match', 8000, 'the rematch to start')
    const info = (await (await fetch(`${http}/rooms/${code}`)).json()) as { exists: boolean; state: string; humans: number }
    expect(info).toMatchObject({ exists: true, state: 'match', humans: 1 })

    owner.session.leave()
    await until(() => srv.core.stats().rooms === 0, 15000, 'the empty room to close')
    expect((await fetch(`${http}/rooms/${code}`)).status).toBe(404)
  }, 90000)

  /** Why: a second player joins by code (room links work for server rooms) and plays; owner stays the first. */
  it('a second player joins the room by code and is not its owner', async () => {
    const { base } = await start()
    const a = headlessClient(base, { key: 'a', play: false })
    const code = await a.online.createRoom('test')
    await a.session.join(code)
    const b = headlessClient(base, { key: 'b', play: false })
    await b.session.join(code)
    await until(() => a.lobby().slots.length === 2 && b.lobby().slots.length === 2, 3000, 'both seated')
    expect(a.lobby().role).toBe('host')
    expect(b.lobby().role).toBe('client')
    // the non-owner's lobby edits are ignored
    b.session.addBot('easy')
    await new Promise((r) => setTimeout(r, 300))
    expect(a.lobby().slots).toHaveLength(2)
    a.session.leave()
    b.session.leave()
  }, 30000)

  /** Why: with several regions a room link still just works: the code is found on whichever region holds it. */
  it('two regions: a code created on one region is found and joined there', async () => {
    const us = await start({ region: 'us-west' })
    const eu = await start({ region: 'eu' })
    const regions = [
      { id: 'us-west', label: 'US West', url: us.base },
      { id: 'eu', label: 'Europe', url: eu.base },
    ]
    const owner = headlessClient(null, { key: 'eu-owner', play: false, regions })
    const status = await owner.online.probe()
    expect(status.map((r) => [r.id, r.state])).toEqual([
      ['us-west', 'up'],
      ['eu', 'up'],
    ])
    expect(status.every((r) => r.samples.length === 3 && r.rttMs !== null && r.rttMs < 1000)).toBe(true)
    const code = await owner.online.createRoom('eu')
    await owner.session.join(code)
    expect(owner.lobby().role).toBe('host')
    const guest = headlessClient(null, { key: 'eu-guest', play: false, regions })
    await guest.session.join(code)
    await until(() => owner.lobby().slots.length === 2, 3000, 'guest seated')
    expect(guest.routed()?.id).toBe('eu')
    expect(guest.session.transport()).toBe('server')
    expect(eu.srv.core.stats().players).toBe(2)
    expect(us.srv.core.stats().rooms).toBe(0)
    owner.session.leave()
    guest.session.leave()
  }, 30000)

  /** Why: a joiner who closed the browser (new tab key) gets its seat back by device id, a bot held it meanwhile. */
  it('device id: a returning device reclaims its seat mid-match', async () => {
    const { base } = await start()
    const owner = headlessClient(base, { key: 'owner', play: true })
    const code = await owner.online.createRoom('test')
    await owner.session.join(code)
    owner.session.updateSettings({ shopSeconds: 1, winScore: 50, botsReplaceLeavers: true })
    owner.session.addBot('easy')
    const guest = headlessClient(base, { key: 'tab-1', device: 'device-abc123', play: true })
    await guest.session.join(code)
    await until(() => owner.lobby().slots.length === 3, 3000, 'guest seated')
    const seat = guest.lobby().localPlayer
    owner.session.startMatch()
    await until(() => guest.screen() === 'match', 5000, 'match')
    await new Promise((r) => setTimeout(r, 1000))
    guest.session.leave()
    await until(() => owner.notices.some((n) => /bot took over/.test(n)), 4000, 'bot takeover')
    // the browser restarted: new tab key, same device
    const back = headlessClient(base, { key: 'tab-2', device: 'device-abc123', play: true })
    await back.session.join(code)
    await until(() => back.screen() === 'match', 5000, 'back in the match')
    expect(back.lobby().localPlayer).toBe(seat)
    await until(() => back.session.debug().streamTick > 0, 5000, 'stream resumed')
    expect(back.session.debug().streamDesyncs).toBe(0)
    owner.session.leave()
    back.session.leave()
  }, 40000)

  /** Why: a release server must not serve clients of another netcode (they would mispredict); dev builds may mix. */
  it('refuses clients of another netcode with a reload message', async () => {
    const { base, http } = await start({}, 'aaaaaaaaaaaa')
    const ok = headlessClient(base, { build: 'aaaaaaaaaaaa' })
    expect(await ok.online.available()).toBe(true)
    const old = headlessClient(base, { build: 'bbbbbbbbbbbb' })
    // the health check already tells the client the server is not for it
    expect(await old.online.available()).toBe(false)
    expect(old.online.status()[0]).toMatchObject({ state: 'mismatch', healthy: true, versionOk: false })
    await expect(old.online.createRoom('test')).rejects.toMatchObject({ reason: 'mismatch' })
    // and a direct join is refused with the reload message
    const code = (await (await fetch(`${http}/rooms`, { method: 'POST' })).json()) as { code: string }
    const ws = new WebSocket(`${base}/ws?room=${code.code}`)
    const reply = await new Promise<string>((resolve) => {
      ws.onopen = () =>
        ws.send(encode({ t: 'hello', name: 'old', version: PROTOCOL_VERSION, key: 'k', profileId: 'profile-old', color: null, build: 'bbbbbbbbbbbb' }))
      ws.onmessage = (e) => {
        const m = decode(String(e.data))
        if (m?.t === 'error') resolve(m.message)
      }
    })
    ws.close()
    expect(reply).toMatch(/different version/i)
  }, 20000)

  /** Why: one abusive client must not take the server down: rooms per IP, message floods and huge payloads are cut off. */
  it('rate limits: room creation per IP, message floods, oversized messages', async () => {
    const { srv, base, http } = await start({ roomCreatesPerMin: 3, lookupsPerMin: 5, msgsPerSec: 50 })
    const codes: number[] = []
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${http}/rooms`, { method: 'POST' })).status)
    expect(codes).toEqual([201, 201, 201, 429])
    // guessing codes: lookups per IP are limited too
    const looks: number[] = []
    for (let i = 0; i < 6; i++) looks.push((await fetch(`${http}/rooms/ABCD${'EFGHJK'[i]}`)).status)
    expect(looks).toEqual([404, 404, 404, 404, 404, 429])

    const code = (await srv.createRoom()).code
    const closedAfter = async (send: (ws: WebSocket) => void) => {
      const ws = new WebSocket(`${base}/ws?room=${code}`)
      await new Promise((r) => (ws.onopen = r))
      const closed = new Promise<boolean>((resolve) => {
        ws.onclose = () => resolve(true)
        setTimeout(() => resolve(false), 3000)
      })
      send(ws)
      return closed
    }
    // 50/s sustained, bursts of 100: 400 messages at once is a flood
    expect(await closedAfter((ws) => {
      for (let i = 0; i < 400; i++) ws.send('{"t":"ready","ready":true}')
    })).toBe(true)
    // a single 100 KB message is over the 64 KB limit
    expect(await closedAfter((ws) => ws.send('x'.repeat(100 * 1024)))).toBe(true)
    // a well-behaved client stays
    expect(await closedAfter((ws) => ws.send(encode({ t: 'hello', name: 'ok', version: PROTOCOL_VERSION, key: 'ok', profileId: 'profile-ok1', color: null })))).toBe(false)
  }, 30000)

  it('an unknown room code gets a readable error, not a dead socket', async () => {
    const { base } = await start()
    const c = headlessClient(base)
    const ws = new WebSocket(`${base}/ws?room=QQQQQ`)
    const msg = await new Promise<string>((resolve) => {
      ws.onmessage = (e) => {
        const m = decode(String(e.data))
        if (m?.t === 'error') resolve(m.message)
      }
    })
    expect(msg).toMatch(/no room/i)
    // and the hybrid net does not even try the server for it (no such room there)
    expect(await c.online.hasRoom('QQQQQ')).toBe(false)
  }, 15000)
})

describe('online regions (client side of the servers)', () => {
  const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const R = (id: string): ServerRegion => ({ id, label: id.toUpperCase(), url: `wss://${id}.test` })
  const health = (build = 'aaaaaaaaaaaa') => ({ ok: true, protocol: PROTOCOL_VERSION, build, players: 3, rooms: 1 })

  /**
   * A fake network: per host, a reply and a round-trip time on a fake clock (each request
   * advances it by that host's RTT), so ping measurement is exact and deterministic.
   */
  function fakeNet(hosts: Record<string, { rtt: number; reply: () => { status: number; body: unknown } | 'down' }>) {
    let now = 1000
    const calls: string[] = []
    const fetch = async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const h = hosts[new URL(url).hostname.split('.')[0]]
      now += h.rtt
      const r = h.reply()
      if (r === 'down') throw new TypeError('fetch failed')
      return res(r.status, r.body)
    }
    return { fetch, now: () => now, advance: (ms: number) => (now += ms), calls }
  }

  /** Why: the ping shown next to each region is the median of real /health round trips, not one noisy sample. */
  it('probe: three samples on the first probe, one per later probe, median over the last five', async () => {
    const rtts = [180, 160, 170, 400, 165, 166, 900]
    let i = 0
    const net = fakeNet({ 'us-west': { rtt: 0, reply: () => ({ status: 200, body: health() }) } })
    const fetch = async (url: string, init?: { method?: string }) => {
      net.advance(rtts[i++])
      return net.fetch(url, init)
    }
    const o = new Online({ regions: [R('us-west')], build: 'aaaaaaaaaaaa', fetch, now: net.now })
    let changes = 0
    o.subscribe(() => changes++)
    expect(o.status()[0]).toMatchObject({ id: 'us-west', label: 'US-WEST', state: 'checking', rttMs: null })
    const [first] = await o.probe()
    expect(first).toMatchObject({ state: 'up', healthy: true, versionOk: true, samples: [180, 160, 170], rttMs: 170, players: 3, rooms: 1 })
    // under 2 s old: answered from cache, no request
    expect((await o.probe())[0].samples).toHaveLength(3)
    expect(i).toBe(3)
    for (let k = 0; k < 4; k++) {
      net.advance(2500)
      await o.probe()
    }
    // window of five; one 900 ms outlier does not move the median much
    expect(o.status()[0].samples).toEqual([170, 400, 165, 166, 900])
    expect(o.status()[0].rttMs).toBe(170)
    expect(changes).toBe(5)
  })

  /** Why: P2P must never wait on a server that is down or on another netcode, and the UI must say which it is. */
  it('health: down and mismatch are reported, cached for routing, never throw', async () => {
    let up = true
    let build = 'aaaaaaaaaaaa'
    const net = fakeNet({ a: { rtt: 50, reply: () => (up ? { status: 200, body: health(build) } : 'down') } })
    const o = new Online({ regions: [R('a')], build: 'aaaaaaaaaaaa', fetch: net.fetch, now: net.now })
    expect(await o.available()).toBe(true)
    const n = net.calls.length
    expect(await o.available()).toBe(true)
    expect(net.calls.length).toBe(n)
    build = 'bbbbbbbbbbbb'
    net.advance(60_000)
    expect(await o.available()).toBe(false)
    expect(o.status()[0]).toMatchObject({ state: 'mismatch', healthy: true, versionOk: false })
    up = false
    net.advance(60_000)
    await o.probe()
    expect(o.status()[0]).toMatchObject({ state: 'down', healthy: false, rttMs: null, samples: [] })
    expect(await o.hasRoom('ABCDE')).toBe(false)
    await expect(o.createRoom('a')).rejects.toMatchObject({ reason: 'unavailable' })
    // dev builds mix freely (local testing); the protocol must still match
    const dev = new Online({ regions: [R('a')], build: 'dev-123', fetch: async () => res(200, health('bbbbbbbbbbbb')) })
    expect(await dev.available()).toBe(true)
    const old = new Online({ regions: [R('a')], build: 'dev-123', fetch: async () => res(200, { ...health(), protocol: PROTOCOL_VERSION - 1 }) })
    expect(await old.available()).toBe(false)
    const none = new Online({ regions: [], build: 'dev-x' })
    expect(none.configured).toBe(false)
    expect(await none.available()).toBe(false)
    expect(await none.choose()).toBeNull()
  })

  /** Why: Auto hosts where the ping is lowest among usable servers; an explicit region is honoured, even when down, so the UI can say why. */
  it('choose: auto = lowest ping among regions that are up; an explicit region as it is', async () => {
    // regions are probed in parallel, so this one runs on real time (a shared fake clock would mix their RTTs)
    const hosts: Record<string, { rtt: number; body: unknown }> = {
      near: { rtt: 20, body: health('bbbbbbbbbbbb') },
      mid: { rtt: 60, body: health() },
      far: { rtt: 150, body: health() },
      gone: { rtt: 5, body: null },
    }
    const fetch = async (url: string) => {
      const h = hosts[new URL(url).hostname.split('.')[0]]
      await new Promise((r) => setTimeout(r, h.rtt))
      if (!h.body) throw new TypeError('fetch failed')
      return res(200, h.body)
    }
    const o = new Online({ regions: [R('far'), R('gone'), R('near'), R('mid')], build: 'aaaaaaaaaaaa', fetch })
    // 'near' has the lowest ping but runs another netcode; 'gone' is down
    expect((await o.choose('auto'))?.id).toBe('mid')
    expect(o.region('far')!.rttMs).toBeGreaterThan(o.region('mid')!.rttMs! + 40)
    expect(await o.choose('gone')).toMatchObject({ id: 'gone', state: 'down' })
    expect((await o.choose('far'))?.id).toBe('far')
    // an unknown id (a region removed from the config) behaves like auto
    expect((await o.choose('removed'))?.id).toBe('mid')
  })

  /** Why: the host card offers the other mode in one click only with a reason it can show. */
  it('createRoom: typed failures for full, rate limited and unreachable servers', async () => {
    let status = 503
    const net = fakeNet({ a: { rtt: 5, reply: () => ({ status: 200, body: health() }) } })
    const fetch = async (url: string, init?: { method?: string }) =>
      init?.method === 'POST' ? (status === 0 ? Promise.reject(new TypeError('reset')) : res(status, status === 201 ? { code: 'ABCDE' } : { error: `nope ${status}` })) : net.fetch(url, init)
    const o = new Online({ regions: [R('a')], build: 'aaaaaaaaaaaa', fetch, now: net.now })
    await expect(o.createRoom('a')).rejects.toMatchObject({ reason: 'full', message: 'nope 503' })
    status = 429
    await expect(o.createRoom('a')).rejects.toMatchObject({ reason: 'limited' })
    status = 201
    expect(await o.createRoom('a')).toBe('ABCDE')
    await expect(o.createRoom('nowhere')).rejects.toBeInstanceOf(ServerError)
    status = 0
    await expect(o.createRoom('a')).rejects.toMatchObject({ reason: 'unavailable' })
    // a failed request takes the region out of routing until the next probe
    expect(o.status()[0].state).toBe('down')
  })

  /** Why: one build config line adds a region; a typo must not break peer-to-peer play. */
  it('config: VITE_GAME_SERVERS list, VITE_GAME_SERVER shorthand, bad entries dropped', () => {
    const warn = console.warn
    const warned: unknown[] = []
    console.warn = (...a: unknown[]) => warned.push(a)
    try {
      expect(parseRegions('[{"id":"us-west","label":"US West","url":"wss://brawlock.osc.link/"},{"id":"eu","label":"Europe","url":"wss://eu.example"}]', 'wss://ignored')).toEqual([
        { id: 'us-west', label: 'US West', url: 'wss://brawlock.osc.link' },
        { id: 'eu', label: 'Europe', url: 'wss://eu.example' },
      ])
      expect(parseRegions(undefined, 'wss://brawlock.osc.link')).toEqual([{ id: 'default', label: 'Game server', url: 'wss://brawlock.osc.link' }])
      expect(parseRegions('[{"id":"Bad Id","url":"wss://x"},{"id":"ok","url":"https://x"},{"id":"dup","url":"wss://a"},{"id":"dup","url":"wss://b"}]', undefined)).toEqual([
        { id: 'dup', label: 'dup', url: 'wss://a' },
      ])
      expect(parseRegions('not json', undefined)).toEqual([])
      expect(parseRegions(undefined, undefined)).toEqual([])
      expect(warned.length).toBe(4)
    } finally {
      console.warn = warn
    }
  })

  /** Why: a room link works wherever the room lives: any region that holds it, else peer-to-peer. */
  it('hybrid net: a code joins on the region that holds it, any other code over P2P', async () => {
    const used: string[] = []
    const fake = (name: string): NetFactory => ({
      host: async () => ({ id: name, onConnection() {}, close() {} }),
      join: async () => {
        used.push(name)
        return {} as never
      },
    })
    const rooms: Record<string, string[]> = { a: ['AAAAA'], b: ['BBBBB'], c: ['CCCCC'] }
    const net0 = fakeNet({
      a: { rtt: 20, reply: () => ({ status: 200, body: health('dev-y') }) },
      b: { rtt: 90, reply: () => ({ status: 200, body: health('dev-y') }) },
      c: { rtt: 10, reply: () => 'down' },
    })
    const fetch = async (url: string, init?: { method?: string }) => {
      const m = /\/\/(\w)\.test\/rooms\/(\w+)$/.exec(url)
      if (!m) return net0.fetch(url, init)
      return rooms[m[1]].includes(m[2]) ? res(200, { exists: true }) : res(404, { exists: false })
    }
    const o = new Online({ regions: [R('a'), R('b'), R('c')], build: 'dev-x', fetch, now: net0.now })
    const routes: (string | null)[] = []
    const net = hybridNet(fake('p2p'), o, (url) => fake(url), (r) => routes.push(r?.id ?? null))
    await net.join('BBBBB')
    await net.join('AAAAA')
    // 'c' is down: its rooms are unreachable, the code goes to P2P
    await net.join('CCCCC')
    await net.join('PEERS')
    await net.host()
    expect(used).toEqual(['wss://b.test', 'wss://a.test', 'p2p', 'p2p'])
    expect(routes).toEqual(['b', 'a', null, null, null])
  })
})

describe('rate limiter', () => {
  it('token bucket: bursts up to capacity, then the sustained rate', () => {
    const b = new TokenBucket(3, 1, 0)
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false])
    expect(b.take(999)).toBe(false)
    expect(b.take(1000)).toBe(true)
    const k = new KeyedLimiter(2, 1)
    expect([k.take('a', 0), k.take('a', 0), k.take('a', 0), k.take('b', 0)]).toEqual([true, true, false, true])
    k.sweep(10_000)
    expect(k.size).toBe(0)
  })
})
