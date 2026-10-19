/**
 * Dedicated server (M4.1) end to end over real local TCP: server/listen.mjs on an
 * ephemeral port, headless client sessions (predict mode) joining through the same
 * hybrid net the browser uses (online.ts). Real timers: real sockets. Session clocks run
 * TIME_SCALE× faster than wall time on both sides (same code paths, shorter matches).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LobbyView, MatchResult, Screen } from '../game/store'
import { createBot } from '../bots'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import type { SimState } from '../sim/types'
import { startServer, type DedicatedServer, type ServerOptions } from '../../server/listen.mjs'
import type { ServerPerfSampler } from '../../server/perf.mjs'
import { remoteRatingAuthority } from '../../server/rating-client.mjs'
import type { RatingSubmission } from './ratingAuthority'
import { DEFAULT_SERVER_CONFIG } from './server'
import { startClock } from './clock'
import { Online, ServerError, hybridNet, parseRegions, type ServerRegion } from './online'
import { PROTOCOL_VERSION, decode, encode } from './protocol'
import { KeyedLimiter, TokenBucket } from './ratelimit'
import { createSession } from './session'
import type { NetFactory } from './transport'
import { wsNet } from './ws'
import { removeDir, tempDir } from '../../server/test-dir.mjs'
import { createMemoryNet } from './memory'
import { Lister, p2pListingTarget } from './lister'

const TIME_SCALE = 4
let servers: DedicatedServer[] = []
const analyticsDirs: string[] = []
const quiet = () => {}
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
  for (const dir of analyticsDirs.splice(0)) removeDir(dir)
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
  name?: string
  profileId?: string
  color?: number
  /** peer-to-peer net (default: none) */
  p2p?: NetFactory
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
  const autoStarts: NonNullable<LobbyView['autoStart']>[] = []
  const session = createSession({
    ui: {
      lobby: () => lobby,
      setLobby: (p) => {
        lobby = { ...lobby, ...p }
        if (p.notice) notices.push(p.notice)
        if (p.autoStart) autoStarts.push({ ...p.autoStart })
      },
      screen: () => screen,
      setScreen: (s) => {
        screen = s
      },
      setResult: () => {},
      paused: () => false,
      onScreen: () => () => {},
    },
    profile: () => ({ id: opts.profileId ?? `profile-${opts.device ?? opts.key ?? 'headless'}`, name: opts.name ?? 'Headless', color: opts.color ?? null }),
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
    net: hybridNet(opts.p2p ?? noP2P, online, (url) => wsNet(url), (r) => (routed = r)),
    startClock: (onPulse) => startClock((t) => onPulse(t * TIME_SCALE)),
    now: () => performance.now() * TIME_SCALE,
    random: Math.random,
    joinUrl: (c) => `http://test/?room=${c}`,
    clientKey: () => opts.key ?? 'headless-key',
    netMode: () => 'predict',
    device: opts.device ? () => opts.device! : undefined,
    build: opts.build ?? 'dev-test',
  })
  return { session, online, lobby: () => lobby, screen: () => screen, results, notices, autoStarts, shown: () => shown, routed: () => routed }
}

async function start(config: Record<string, unknown> = {}, build = 'dev-server', extra: Omit<ServerOptions, 'port' | 'build' | 'config' | 'timeScale'> = {}) {
  const srv = await startServer({ ...extra, port: 0, build, config, timeScale: TIME_SCALE, log: extra.log ?? quiet })
  servers.push(srv)
  return { srv, base: `ws://127.0.0.1:${srv.port}`, http: `http://127.0.0.1:${srv.port}` }
}

describe('dedicated server (M4.1)', () => {
  it('delivers shared chat and history to a newcomer waiting for a bot seat during combat', async () => {
    const { base, srv } = await start()
    const owner = headlessClient(base, { key: 'chat-owner', name: 'Owner', play: false })
    const friend = headlessClient(base, { key: 'chat-friend', name: 'Friend', play: false })
    const late = headlessClient(base, { key: 'chat-late', name: 'Late guest', play: false })
    try {
      const code = await owner.online.createRoom('test')
      await owner.session.join(code)
      await friend.session.join(code)
      await until(() => owner.lobby().slots.length === 2, 3000, 'chat members seated')
      expect(owner.session.sendChat('Hello everyone')).toBe('sent')
      expect(friend.session.sendChat('Ready 🔥')).toBe('sent')
      await until(() => friend.lobby().chat?.length === 2, 3000, 'reliable room chat')
      expect(friend.lobby().chat).toEqual(owner.lobby().chat)
      owner.session.addBot('dummy')
      owner.session.updateSettings({ shopSeconds: 0.1 })
      await until(() => owner.lobby().slots.length === 3 && owner.lobby().settings?.shopSeconds === 0.1, 3000, 'the bot seat')
      owner.session.startMatch()
      await until(() => owner.shown()?.phase === 'fight', 5000, 'combat on the client')
      const fightTick = owner.shown()!.tick
      await until(() => srv.core.room(code)!.debug().tick >= fightTick, 5000, 'confirmed combat')
      await late.session.join(code)
      await until(() => !!late.lobby().waitingForRound && late.lobby().chat?.length === 2, 3000, 'waiting member receives history')
      expect(late.session.sendChat('Watching until next round')).toBe('sent')
      await until(() => owner.lobby().chat?.length === 3, 3000, 'waiting spectator chat')
      expect(owner.lobby().chat?.at(-1)).toMatchObject({ name: 'Late guest', text: 'Watching until next round' })
      expect(late.lobby().chat).toEqual(owner.lobby().chat)
    } finally { owner.session.leave(); friend.session.leave(); late.session.leave() }
  }, 15000)

  it('replicates owner-only timed votes and human-safe bot color swaps over real connections', async () => {
    const { base } = await start()
    const owner = headlessClient(base, { key: 'vote-owner', device: 'vote-owner-device', name: 'Owner', play: false })
    const guest = headlessClient(base, { key: 'vote-guest', device: 'vote-guest-device', name: 'Guest', play: false })
    try {
      const code = await owner.online.createRoom('test')
      await owner.session.join(code)
      await guest.session.join(code)
      await until(() => owner.lobby().slots.length === 2 && guest.lobby().slots.length === 2, 3000, 'two voting humans')
      owner.session.addBot('easy')
      await until(() => guest.lobby().slots.length === 3, 3000, 'the color donor bot')
      const ownerId = owner.lobby().localPlayer
      const guestId = guest.lobby().localPlayer
      const ownerColor = owner.lobby().slots.find((s) => s.id === ownerId)!.color
      const guestColor = guest.lobby().slots.find((s) => s.id === guestId)!.color
      const bot = guest.lobby().slots.find((s) => s.kind === 'bot')!
      guest.session.setPlayerColor(bot.color)
      await until(() => owner.lobby().slots.find((s) => s.id === guestId)?.color === bot.color, 3000, 'the confirmed color swap')
      expect(owner.lobby().slots.find((s) => s.id === bot.id)?.color).toBe(guestColor)
      guest.session.setPlayerColor(ownerColor)
      guest.session.startLobbyVote('startGold')
      await new Promise((r) => setTimeout(r, 150))
      expect(owner.lobby().slots.find((s) => s.id === guestId)?.color).toBe(bot.color)
      expect(owner.lobby().slots.find((s) => s.id === ownerId)?.color).toBe(ownerColor)
      expect(owner.lobby().vote).toBeNull()

      owner.session.startLobbyVote('startGold')
      await until(() => !!owner.lobby().vote && !!guest.lobby().vote, 3000, 'the authoritative vote')
      const vote = owner.lobby().vote!
      expect([...vote.eligible].sort()).toEqual([ownerId, guestId].sort())
      owner.session.castLobbyVote(vote.id, 'high')
      guest.session.castLobbyVote(vote.id, 'high')
      await until(() => Object.keys(owner.lobby().vote?.votes ?? {}).length === 2, 3000, 'both identified ballots')
      expect(owner.lobby().vote?.votes).toEqual({ [ownerId]: 'high', [guestId]: 'high' })
      owner.session.startMatch()
      await new Promise((r) => setTimeout(r, 100))
      expect(owner.screen()).toBe('lobby')
      expect(guest.screen()).toBe('lobby')
      expect(owner.lobby().vote?.id).toBe(vote.id)
      await until(() => owner.lobby().vote === null && guest.lobby().vote === null, 5000, 'the full ten-second vote deadline')
      expect(owner.lobby().voteResult).toMatchObject({ id: vote.id, reason: 'won', value: 60 })
      expect(guest.lobby().settings?.startGold).toBe(60)
      expect(owner.lobby().settings?.startGold).toBe(60)
      guest.session.setReady(true)
      owner.session.startMatch()
      await until(() => owner.screen() === 'match' && guest.screen() === 'match', 3000, 'starting after the vote closes')
    } finally {
      owner.session.leave()
      guest.session.leave()
    }
  }, 20000)

  /**
   * Why: the priority feature. A player opens a room on the server, owns it (host
   * controls without hosting), plays a full match with bots in predict mode against the
   * server's authority, starts a rematch, and leaves; the empty room closes.
   */
  it('create a room, own it, play a match and a rematch, leave; the empty room closes', async () => {
    const dataDir = tempDir('brawlock-match-analytics-')
    analyticsDirs.push(dataDir)
    const token = 'test-analytics-operator-token-0123456789'
    const { srv, base, http } = await start({ emptyRoomMs: 400, region: 'test' }, 'dev-server', { dataDir, maintenanceToken: token })
    const analytics = async () => (await fetch(`${http}/internal/analytics?days=1`, { headers: { authorization: `Bearer ${token}` } })).json()
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
    expect((await analytics()).matches).toEqual([expect.objectContaining({ queue: 'custom', started: 1, completed: 1, abandoned: 0 })])
    // the server announces itself: the connection monitor labels the link as the server
    const view = owner.session.netStats()!
    expect(view.server).toBe(true)
    expect(view.peers[0].playerId).toBe(-1)

    owner.session.rematch()
    await until(() => owner.screen() === 'match', 8000, 'the rematch to start')
    const info = (await (await fetch(`${http}/rooms/${code}`)).json()) as { exists: boolean; state: string; humans: number }
    expect(info).toMatchObject({ exists: true, state: 'match', humans: 1 })
    expect((await analytics()).matches).toEqual([expect.objectContaining({ started: 2, completed: 1, running: 1 })])

    owner.session.leave()
    await until(() => srv.core.stats().rooms === 0, 15000, 'the empty room to close')
    expect(await (await fetch(`${http}/rooms/${code}`)).json()).toEqual({ exists: false })
    expect((await analytics()).matches).toEqual([expect.objectContaining({ started: 2, completed: 1, running: 0, abandoned: 1 })])
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
    const guest = headlessClient(base, { key: 'tab-1', device: 'device-abc123', play: true })
    await guest.session.join(code)
    owner.session.addBot('easy')
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
    const { srv, base, http } = await start({ roomCreatesPerMin: 3, lookupsPerMin: 5, quickplaysPerMin: 2, msgsPerSec: 50 })
    // quick play and leaderboard reads per IP
    const quicks: number[] = []
    for (let i = 0; i < 3; i++) quicks.push((await fetch(`${http}/quickplay`, { method: 'POST' })).status)
    expect(quicks).toEqual([201, 200, 429])
    const codes: number[] = []
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${http}/rooms`, { method: 'POST' })).status)
    expect(codes).toEqual([201, 201, 201, 429])
    // guessing codes: lookups per IP are limited too
    const looks: number[] = []
    for (let i = 0; i < 6; i++) looks.push((await fetch(`${http}/rooms/ABCD${'EFGHJK'[i]}`)).status)
    expect(looks).toEqual([200, 200, 200, 200, 200, 429])

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

describe('public rooms and quick play (M4.3)', () => {
  it('keeps custom lobbies on the standard economy instead of the queue preset', async () => {
    const { base } = await start()
    const owner = headlessClient(base, { key: 'custom-economy', play: false })
    try {
      const code = await owner.online.createRoom('test')
      await owner.session.join(code)
      await until(() => owner.lobby().settings !== null, 3000, 'the custom lobby settings')
      expect(owner.screen()).toBe('lobby')
      expect(owner.lobby().settings).toMatchObject({ startGold: 30, roundGold: 10, killGold: 1, winGold: 2 })
    } finally { owner.session.leave() }
  }, 10000)

  it('fills a default quick game to ten with Hard bots plus one Brutal and one Medium, uses modest gold rewards and reuses it for a newcomer', async () => {
    const { base, srv } = await start({ quickplay: { ...DEFAULT_SERVER_CONFIG.quickplay, fillMs: 4000, startMs: 100 } })
    const a = headlessClient(base, { key: 'full-house-a', device: 'full-house-device-a', play: false })
    const b = headlessClient(base, { key: 'full-house-b', device: 'full-house-device-b', play: false })
    try {
      const opened = await a.online.quickPlay('test')
      await a.session.join(opened.code)
      await until(() => a.lobby().autoStart !== null && a.lobby().autoStart !== undefined, 3000, 'the quick lobby countdown')
      expect(a.screen()).toBe('lobby')
      expect(a.lobby().settings).toMatchObject({ startGold: 50, roundGold: 15, killGold: 2, winGold: 3 })
      expect(srv.core.room(opened.code)!.summary().elo).toEqual({ enabled: false, minSeconds: 120 })
      expect(srv.core.room(opened.code)!.summary().progress).toBeNull()
      await until(() => a.screen() === 'match' && a.lobby().slots.length === 10, 8000, 'a full-house quick start')
      expect(a.lobby().settings).toMatchObject({ startGold: 50, roundGold: 15, killGold: 2, winGold: 3 })
      expect(a.lobby().slots.filter((s) => s.kind === 'bot')).toHaveLength(9)
      const levels = a.lobby().slots.filter((s) => s.kind === 'bot').map((s) => s.difficulty)
      expect(levels.filter((d) => d === 'brutal')).toHaveLength(1)
      expect(levels.filter((d) => d === 'medium')).toHaveLength(1)
      expect(levels.filter((d) => d === 'hard')).toHaveLength(7)
      await until(() => !!a.shown()?.scores.some((s) => s.id === a.lobby().localPlayer), 3000, 'the first confirmed player score')
      expect(a.shown()?.scores.find((s) => s.id === a.lobby().localPlayer)?.gold).toBe(50)
      const listed = (await a.online.browse()).find((room) => room.code === opened.code)!
      expect(listed).toMatchObject({ phase: 'match', progress: { round: 1, phase: 'shop', final: false } })
      expect(listed.progress!.elapsedSeconds).toBeGreaterThanOrEqual(0)
      expect(await b.online.quickPlay('test')).toEqual({ code: opened.code, created: false })
      await b.session.join(opened.code)
      await until(() => a.lobby().slots.filter((s) => s.kind === 'human').length === 2, 3000, 'a human replacing a full-house bot')
      expect(a.lobby().slots).toHaveLength(10)
      expect(srv.core.stats().rooms).toBe(1)
    } finally { a.session.leave(); b.session.leave() }
  }, 15000)
  const FAST = { winScore: 1, shopSeconds: 1, lavaDps: 400, dmgMultiplier: 2, kbMultiplier: 1.6 }
  const quick = (q: Record<string, unknown>) => ({ quickplay: { fillMs: 2000, startMs: 1000, nextMs: 2000, seats: 8, fill: 4, bots: 'easy', ...q } })

  /** Why: a lone quick player must not wait for a second human forever: bots fill the table to 4 and the match starts by itself. */
  it('quick play: a newcomer reserves a bot and starts playing next round', async () => {
    const { base, srv } = await start(quick({ settings: { winScore: 50, shopSeconds: 3 } }))
    const a = headlessClient(base, { key: 'qa', device: 'device-qa-1', play: true })
    const r = await a.online.quickPlay('test')
    expect(r.created).toBe(true)
    await a.session.join(r.code)
    await until(() => a.lobby().quick === true, 3000, 'the authoritative quick room metadata')
    expect(a.lobby()).toMatchObject({ quick: true, public: true, role: 'client', status: 'open' })
    expect(a.lobby().autoStart).toMatchObject({ fill: true })
    await until(() => a.screen() === 'match', 8000, 'the bot-filled start')
    expect(a.lobby().slots.map((x) => x.kind).sort()).toEqual(['bot', 'bot', 'bot', 'human'])
    expect(a.lobby().slots.filter((x) => x.kind === 'bot').every((x) => x.difficulty === 'easy')).toBe(true)
    // nobody owns a quick room: lobby edits go nowhere
    a.session.addBot('brutal')
    const botIds = a.lobby().slots.filter((x) => x.kind === 'bot').map((x) => x.id)
    await until(() => a.shown()?.phase === 'fight', 8000, 'combat before reserving a seat')
    // The displayed fight may lead authority. Join after that tick is confirmed,
    // otherwise the server correctly allows immediate entry during its shop phase.
    const fightTick = a.shown()!.tick
    await until(() => srv.core.room(r.code)!.debug().tick >= fightTick, 3000, 'confirmed combat before reserving')
    // Keep the same game and reserve its bot; control changes at the next round.
    const b = headlessClient(base, { key: 'qb', device: 'device-qb-1', play: true })
    const r2 = await b.online.quickPlay('test', 'medium')
    expect(r2).toEqual({ code: r.code, created: false })
    await b.session.join(r2.code)
    await until(() => b.screen() === 'match' && a.lobby().slots.filter((x) => x.kind === 'human').length === 2, 3000, 'a bot seat to be reserved')
    expect(botIds).toContain(b.lobby().localPlayer)
    expect(b.session.debug().netMode).toBe('classic')
    expect(b.lobby().waitingForRound).toBe(true)
    const joinedRound = a.shown()!.round
    await until(() => b.session.debug().netMode === 'predict' && (b.shown()?.round ?? 0) > joinedRound, 50000, 'the newcomer to play from the next round')
    expect(b.shown()!.round).toBeGreaterThan(joinedRound)
    expect(b.lobby().waitingForRound).toBe(false)
    expect(a.session.debug().netMode).toBe('predict')
    expect(a.lobby().slots).toHaveLength(4)
    expect(srv.core.stats().rooms).toBe(1)
    a.session.leave()
    b.session.leave()
  }, 65000)

  it('quick play and Browse games reserve bots in a public owner game and play next round', async () => {
    const { base, srv } = await start()
    const owner = headlessClient(base, { key: 'public-owner', name: 'Mira', play: true })
    const code = await owner.online.createRoom('test')
    await owner.session.join(code)
    owner.session.addBot('easy')
    owner.session.addBot('easy')
    owner.session.setPublic(true)
    owner.session.updateSettings({ winScore: 50, shopSeconds: 3 })
    await until(() => owner.lobby().slots.length === 3 && owner.lobby().public === true && owner.lobby().settings?.winScore === 50, 3000, 'a public owner game')
    owner.session.startMatch()
    await until(() => owner.screen() === 'match', 5000, 'the owner match')
    await until(() => owner.shown()?.phase === 'fight', 8000, 'owner combat before reserving seats')
    const fightTick = owner.shown()!.tick
    await until(() => srv.core.room(code)!.debug().tick >= fightTick, 3000, 'confirmed owner combat before reserving')
    const bots = owner.lobby().slots.filter((x) => x.kind === 'bot').map((x) => x.id)
    const quickPlayer = headlessClient(base, { key: 'public-quick', name: 'Ann', play: true })
    expect(await quickPlayer.online.quickPlay('test')).toEqual({ code, created: false })
    await quickPlayer.session.join(code)
    await until(() => quickPlayer.screen() === 'match' && owner.lobby().slots.filter((x) => x.kind === 'human').length === 2, 3000, 'quick play takeover')
    expect(bots).toContain(quickPlayer.lobby().localPlayer)
    expect(quickPlayer.session.debug().netMode).toBe('classic')
    const browserPlayer = headlessClient(base, { key: 'public-browser', name: 'Bob', play: true })
    const listed = (await browserPlayer.online.browse()).find((r) => r.code === code)!
    expect(listed).toMatchObject({ host: 'Mira', phase: 'match', joinable: 1 })
    await browserPlayer.session.join(listed.code)
    await until(() => browserPlayer.screen() === 'match' && owner.lobby().slots.every((x) => x.kind === 'human'), 3000, 'browser takeover')
    expect(bots).toContain(browserPlayer.lobby().localPlayer)
    expect(browserPlayer.lobby().localPlayer).not.toBe(quickPlayer.lobby().localPlayer)
    expect(browserPlayer.session.debug().netMode).toBe('classic')
    expect(browserPlayer.lobby().waitingForRound).toBe(true)
    const joinedRound = owner.shown()!.round
    await until(() => [quickPlayer, browserPlayer].every((c) => c.session.debug().netMode === 'predict' && (c.shown()?.round ?? 0) > joinedRound), 50000, 'both newcomers to play next round')
    expect(browserPlayer.shown()!.round).toBeGreaterThan(joinedRound)
    expect(browserPlayer.lobby().waitingForRound).toBe(false)
    await until(() => [owner, quickPlayer, browserPlayer].every((c) => {
      const roster = c.shown()?.slots
      return roster?.some((s) => s.id === quickPlayer.lobby().localPlayer && s.name === 'Ann' && s.kind === 'human') === true
        && roster.some((s) => s.id === browserPlayer.lobby().localPlayer && s.name === 'Bob' && s.kind === 'human')
    }), 3000, 'the updated playable roster on every client')
    expect(srv.core.room(code)!.joinableSeats()).toBe(0)
    expect(srv.core.stats().rooms).toBe(1)
    // Empty lobby positions are not playable pawns in a match that has no bots left.
    const next = await browserPlayer.online.quickPlay('test')
    expect(next.created).toBe(true)
    expect(next.code).not.toBe(code)
    for (const c of [owner, quickPlayer, browserPlayer]) c.session.leave()
  }, 65000)

  it('quick play avoids owner lobbies that need a manual start', async () => {
    const { base } = await start(quick({ fillMs: 60000 }))
    const owner = headlessClient(base, { key: 'idle-owner', play: false })
    const code = await owner.online.createRoom('test')
    await owner.session.join(code)
    await until(() => owner.lobby().role === 'host' && owner.lobby().slots.length === 1, 3000, 'the owner lobby before editing')
    owner.session.addBot('easy')
    owner.session.setPublic(true)
    await until(() => owner.lobby().public === true && owner.lobby().slots.length === 2, 3000, 'a public manual lobby')
    const quickPlayer = headlessClient(base, { key: 'idle-quick', play: false })
    const assigned = await quickPlayer.online.quickPlay('test')
    expect(assigned.created).toBe(true)
    expect(assigned.code).not.toBe(code)
    owner.session.leave()
  }, 30000)

  it('quick play reserves bot seats before connection and releases them when a waiting player leaves', async () => {
    // Keep this round open: the test cancels a reservation before takeover,
    // rather than racing a bot killing the idle host during the HTTP requests.
    const { base, srv } = await start(quick({ fill: 2, fillMs: 1000, settings: { winScore: 50, shopSeconds: 10, dmgMultiplier: 0, kbMultiplier: 0, lavaDps: 0 } }))
    const owner = headlessClient(base, { key: 'reserve-owner', play: false })
    const first = await owner.online.quickPlay('test')
    await owner.session.join(first.code)
    await until(() => owner.screen() === 'match', 8000, 'a match with one replaceable bot')
    await until(() => owner.shown()?.phase === 'fight', 8000, 'combat before reserving the bot')
    const fightTick = owner.shown()!.tick
    await until(() => srv.core.room(first.code)!.debug().tick >= fightTick, 3000, 'confirmed combat before holding the bot')
    const late = headlessClient(base, { key: 'reserve-late', play: false })
    const held = await late.online.quickPlay('test')
    const overflow = await late.online.quickPlay('test')
    expect(held).toEqual({ code: first.code, created: false })
    expect(overflow.created).toBe(true)
    expect(overflow.code).not.toBe(first.code)
    const round = owner.shown()!.round
    const bot = owner.lobby().slots.find((s) => s.kind === 'bot')!
    await late.session.join(held.code)
    await until(() => late.screen() === 'match' && owner.lobby().slots.every((s) => s.kind === 'human'), 3000, 'a reserved next-round seat')
    expect(late.session.debug().netMode).toBe('classic')
    expect(srv.core.room(first.code)!.joinableSeats()).toBe(0)
    late.session.leave()
    await until(() => owner.lobby().slots.some((s) => s.id === bot.id && s.kind === 'bot'), 3000, 'the cancelled reservation to return to a bot')
    expect(owner.shown()!.round).toBe(round)
    expect(owner.shown()!.slots.find((s) => s.id === bot.id)).toMatchObject({ kind: 'bot', name: bot.name })
    expect(srv.core.room(first.code)!.joinableSeats()).toBe(1)
    expect(await late.online.quickPlay('test')).toEqual({ code: first.code, created: false })
    owner.session.leave()
  }, 30000)

  /** Why: two people pressing Quick play at about the same time play each other (topped up to 4), not two bot tables. */
  it('quick play: two players meet in one room, start after the short countdown, topped up with bots to 4', async () => {
    const { base, srv } = await start(quick({ startMs: 1500 }))
    const a = headlessClient(base, { key: 'qa', device: 'device-qa-2', play: false })
    const b = headlessClient(base, { key: 'qb', device: 'device-qb-2', play: false })
    // b asks before a has even connected: a's seat is held
    const ra = await a.online.quickPlay('test')
    const rb = await b.online.quickPlay('test')
    expect(rb).toEqual({ code: ra.code, created: false })
    await a.session.join(ra.code)
    await b.session.join(rb.code)
    await until(() => a.lobby().slots.length === 2, 3000, 'both seated')
    expect(a.lobby().autoStart).toMatchObject({ fill: false })
    await until(() => a.screen() === 'match' && b.screen() === 'match', 8000, 'the two-human start')
    expect(a.lobby().slots.map((x) => x.kind).sort()).toEqual(['bot', 'bot', 'human', 'human'])
    expect(srv.core.stats().rooms).toBe(1)
    a.session.leave()
    b.session.leave()
  }, 30000)

  /** Why: a quick room keeps going; people who arrive between matches replace bots first, then take free seats. */
  it('quick play: between matches newcomers replace bots first, then take free seats', async () => {
    const { base } = await start(quick({ fill: 3, fillMs: 1000, nextMs: 12000, settings: FAST }))
    const a = headlessClient(base, { key: 'qa', device: 'device-qa-3', play: true })
    const r = await a.online.quickPlay('test')
    await a.session.join(r.code)
    await until(() => a.screen() === 'match', 8000, 'the first match')
    expect(a.lobby().slots).toHaveLength(3)
    await until(() => a.screen() === 'results', 50000, 'the first match to finish')
    const kinds = () => {
      const k = a.lobby().slots.map((x) => x.kind)
      return { humans: k.filter((x) => x === 'human').length, bots: k.filter((x) => x === 'bot').length }
    }
    const late = ['c', 'd', 'e'].map((k) => headlessClient(base, { key: `q${k}`, device: `device-q${k}-3`, play: true }))
    const want = [
      { humans: 2, bots: 1 },
      { humans: 3, bots: 0 },
      { humans: 4, bots: 0 },
    ]
    for (let i = 0; i < late.length; i++) {
      const rc = await late[i].online.quickPlay('test')
      expect(rc).toEqual({ code: r.code, created: false })
      await late[i].session.join(rc.code)
      await until(() => kinds().humans === want[i].humans, 3000, `newcomer ${i + 1} seated`)
      expect(kinds()).toEqual(want[i])
    }
    for (const c of [a, ...late]) c.session.setReady(true)
    await until(() => [a, ...late].every((c) => c.screen() === 'match'), 15000, 'the next match with the newcomers')
    expect(kinds()).toEqual({ humans: 4, bots: 0 })
    for (const c of [a, ...late]) c.session.leave()
  }, 80000)

  /**
   * Why: an abandoned tab must not keep a quick room cycling matches against bots for hours.
   * A player who touched nothing for a whole game (3+ rounds) goes back to the menu when it
   * ends, with a reason, and the room has nobody left to start another match for.
   */
  it('quick play: a player idle for a whole game goes back to the menu when it ends', async () => {
    const { base, srv } = await start(quick({ fill: 3, fillMs: 500, nextMs: 4000, settings: { ...FAST, winScore: 3 } }))
    const a = headlessClient(base, { key: 'qi', device: 'device-qi-1', play: false })
    const r = await a.online.quickPlay('test')
    await a.session.join(r.code)
    await until(() => a.screen() === 'match', 8000, 'the bot-filled start')
    const room = srv.core.room(r.code)!
    await until(() => a.screen() === 'menu', 90000, 'the idle player to be sent back')
    expect(a.lobby()).toMatchObject({ status: 'error', error: expect.stringContaining('away for a whole game') })
    expect(a.results).toHaveLength(1)
    expect(a.results[0].rounds).toBeGreaterThanOrEqual(3)
    await until(() => room.humans() === 0, 3000, 'the seat to be freed')
    expect(room.screen()).not.toBe('match')
  }, 100000)

  /** Why: a break is not abandonment: one chat line (or any input) during the game keeps the seat for the next one. */
  it('quick play: a player who chats once during an otherwise idle game keeps the seat', async () => {
    const { base } = await start(quick({ fill: 3, fillMs: 500, nextMs: 4000, settings: { ...FAST, winScore: 3 } }))
    const a = headlessClient(base, { key: 'qj', device: 'device-qj-1', play: false })
    const r = await a.online.quickPlay('test')
    await a.session.join(r.code)
    await until(() => a.screen() === 'match', 8000, 'the bot-filled start')
    expect(a.session.sendChat('brb')).toBe('sent')
    await until(() => a.screen() === 'results', 90000, 'the game to end')
    a.session.setReady(true)
    await until(() => a.screen() === 'match' || a.screen() === 'menu', 15000, 'the next game')
    expect(a.screen()).toBe('match')
    expect(a.lobby().error).toBeNull()
    a.session.leave()
  }, 120000)

  /**
   * Why: players were pulled into the next game seconds after a match, before they could read
   * the results. Post-game never assumes anyone wants another game: the room only moves on once
   * every human pressed Ready (whoever does not want to wait takes New game: another room).
   */
  it('quick play: the next match waits until every player pressed Ready', async () => {
    const { base } = await start(quick({ fill: 3, fillMs: 500, nextMs: 1000, settings: { ...FAST, winScore: 1 } }))
    const a = headlessClient(base, { key: 'qr1', device: 'device-qr-1', play: true })
    const b = headlessClient(base, { key: 'qr2', device: 'device-qr-2', play: true })
    const r = await a.online.quickPlay('test')
    await a.session.join(r.code)
    await b.session.join(r.code)
    await until(() => a.screen() === 'match' && b.screen() === 'match', 12000, 'the first match')
    await until(() => a.screen() === 'results' && b.screen() === 'results', 60000, 'the first match to end')
    // well past the old nextMs: nobody pressed Ready, so nothing starts
    await new Promise((r) => setTimeout(r, 3000))
    expect([a.screen(), b.screen()]).toEqual(['results', 'results'])
    a.session.setReady(true)
    // one ready player never drags the other along
    await new Promise((r) => setTimeout(r, 3000))
    expect([a.screen(), b.screen()]).toEqual(['results', 'results'])
    b.session.setReady(true)
    await until(() => a.screen() === 'match' && b.screen() === 'match', 8000, 'the next match once both are ready')
    for (const c of [a, b]) c.session.leave()
  }, 120000)

  /** Why: results wait for Ready forever; an abandoned tab must not keep a room (and its seat) open for days. */
  it('quick play: a results screen nobody readied on closes the room after the idle time', async () => {
    const { base, srv } = await start(quick({ fill: 3, fillMs: 500, resultsIdleMs: 4000, settings: { ...FAST, winScore: 1 } }))
    const a = headlessClient(base, { key: 'qz1', device: 'device-qz-1', play: true })
    const r = await a.online.quickPlay('test')
    await a.session.join(r.code)
    await until(() => a.screen() === 'results', 60000, 'the match to end')
    await until(() => a.screen() === 'menu', 4000 / 4 + 4000, 'back to the menu after the results idle time')
    expect(a.lobby().error).toMatch(/results stayed open/)
    await until(() => !srv.core.room(r.code) || srv.core.room(r.code)!.humans() === 0, 3000, 'the room emptied')
  }, 90000)

  /** Why: New game from a results screen must find another room, not the one the player left. */
  it('quick play: exclude never returns the room being left', async () => {
    const { base } = await start(quick({ startMs: 60000, fillMs: 60000 }))
    const a = headlessClient(base, { key: 'qx1', device: 'device-qx-1', play: false })
    const first = await a.online.quickPlay('test')
    await a.session.join(first.code)
    const other = headlessClient(base, { key: 'qx2', device: 'device-qx-2', play: false })
    expect((await other.online.quickPlay('test')).code).toBe(first.code)
    const fresh = await other.online.quickPlay('test', undefined, first.code)
    expect(fresh.code).not.toBe(first.code)
    expect(fresh.created).toBe(true)
    a.session.leave()
  }, 30000)

  /** Why: a quick-play room enforces its configured human cap; the next player gets a new room, and a full-room link is refused. */
  it('quick play respects its configured room cap; the next player gets a new room', async () => {
    const { base } = await start(quick({ seats: 3, startMs: 60000 }))
    const cs = ['a', 'b', 'c', 'd'].map((k) => headlessClient(base, { key: `cap${k}`, device: `device-cap${k}`, play: false }))
    const codes = []
    for (const c of cs) codes.push(await c.online.quickPlay('test'))
    expect(codes.map((x) => x.created)).toEqual([true, false, false, true])
    expect(new Set(codes.slice(0, 3).map((x) => x.code)).size).toBe(1)
    for (const [i, c] of cs.slice(0, 3).entries()) await c.session.join(codes[i].code)
    const extra = headlessClient(base, { key: 'cape', device: 'device-cape', play: false })
    await extra.session.join(codes[0].code)
    expect(extra.lobby()).toMatchObject({ status: 'error' })
    expect(extra.lobby().error).toMatch(/full/i)
    expect(DEFAULT_SERVER_CONFIG.quickplay).toMatchObject({ seats: 10, fill: 10, bots: 'hard', mix: ['brutal', 'medium'], settings: { winScore: 3, startGold: 50, roundGold: 15, killGold: 2, winGold: 3 } })
    for (const c of cs) c.session.leave()
  }, 30000)

  /** Why: the browser lists public rooms only; a private coded room never shows; abusive polling is cut off. */
  it('public list: only public rooms, the owner toggles it, cached and rate limited; browse() tags the region', async () => {
    const { base, http } = await start({ listsPerMin: 8 })
    const list = async () => (await (await fetch(`${http}/rooms?public=1`)).json()) as { region: string; rooms: { code: string; host: string | null; quick: boolean; humans: number; phase: string }[] }
    const owner = headlessClient(base, { key: 'own', name: 'Ann', play: false })
    const code = await owner.online.createRoom('test')
    await owner.session.join(code)
    const q = await owner.online.quickPlay('test')
    let l = await list()
    expect(l.rooms.map((x) => x.code)).toEqual([q.code])
    expect(l.rooms[0]).toMatchObject({ quick: true, host: null, phase: 'lobby' })
    owner.session.setPublic(true)
    await until(() => owner.lobby().public === true, 3000, 'the room to turn public')
    await new Promise((res) => setTimeout(res, 1100 / TIME_SCALE + 50))
    l = await list()
    expect(l.rooms.find((x) => x.code === code)).toMatchObject({ host: 'Ann', humans: 1, quick: false, phase: 'lobby' })
    const browsed = await owner.online.browse()
    expect(browsed.map((x) => [x.code, x.region.id]).sort()).toEqual([[code, 'test'], [q.code, 'test']].sort())
    owner.session.setPublic(false)
    await until(() => owner.lobby().public === false, 3000, 'the room to turn private')
    await new Promise((res) => setTimeout(res, 1100 / TIME_SCALE + 50))
    expect((await list()).rooms.map((x) => x.code)).toEqual([q.code])
    // 4 lists so far (one through browse); 8 per minute, so the 9th is refused
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${http}/rooms?public=1`)).status)
    expect(codes).toEqual([200, 200, 200, 200, 429])
    expect((await fetch(`${http}/rooms`)).status).toBe(400)
    owner.session.leave()
  }, 30000)
})

describe('player-hosted rooms in Browse games (listings)', () => {
  const INFO = { code: 'MERCY', host: 'Mira', humans: 1, bots: 1, max: 10, phase: 'lobby', teamMode: 'ffa', gameMode: 'rounds', winScore: 5 }
  const post = (http: string, body: unknown) => fetch(`${http}/listings`, { method: 'POST', body: JSON.stringify(body) })

  /** Why: the directory is public and unauthenticated, so creation is rate limited, updates need the token, bodies are small. */
  it('HTTP: create (rate limited), heartbeat and delete need the token, size limit, CORS for PUT / DELETE', async () => {
    const { http } = await start({ listingCreatesPerMin: 2 })
    const r = await post(http, INFO)
    expect(r.status).toBe(201)
    const { id, token, ttlS, heartbeatS } = (await r.json()) as { id: string; token: string; ttlS: number; heartbeatS: number }
    expect({ ttlS, heartbeatS }).toEqual({ ttlS: 30, heartbeatS: 10 })
    expect((await post(http, { ...INFO, code: 'CRAFT' })).status).toBe(201)
    expect((await post(http, { ...INFO, code: 'THREE' })).status).toBe(429)
    const put = (body: unknown) => fetch(`${http}/listings/${id}`, { method: 'PUT', body: JSON.stringify(body) })
    expect((await put({ humans: 2 })).status).toBe(403)
    expect(await (await put({ token, humans: 2, phase: 'match' })).json()).toEqual({ ok: true })
    expect((await fetch(`${http}/listings/${id}`, { method: 'PUT', body: 'x'.repeat(5000) })).status).toBe(413)
    const pre = await fetch(`${http}/listings/${id}`, { method: 'OPTIONS' })
    expect(pre.headers.get('access-control-allow-methods')).toContain('PUT')
    expect(pre.headers.get('access-control-allow-methods')).toContain('DELETE')
    const listed = (await (await fetch(`${http}/rooms?public=1`)).json()) as { listings: { code: string; humans: number; phase: string; kind: string }[] }
    expect(listed.listings.find((x) => x.code === 'MERCY')).toMatchObject({ kind: 'p2p', humans: 2, phase: 'match' })
    expect(JSON.stringify(listed)).not.toContain(token)
    expect((await fetch(`${http}/listings/${id}`, { method: 'DELETE', body: JSON.stringify({ token: 'nope' }) })).status).toBe(403)
    expect((await fetch(`${http}/listings/${id}`, { method: 'DELETE', body: JSON.stringify({ token }) })).status).toBe(200)
    // unlisted means private at once (the list cache is dropped)
    const after = (await (await fetch(`${http}/rooms?public=1`)).json()) as { listings: { code: string }[] }
    expect(after.listings.map((x) => x.code)).toEqual(['CRAFT'])
    expect(await (await put({ token, humans: 3 })).json()).toEqual({ ok: true, gone: true })
  }, 20000)

  /**
   * Why: the point of listing a PC-hosted room: a stranger finds it in Browse games next
   * to server rooms and joins it peer-to-peer by its code (the server only lists it).
   */
  it('browse shows server rooms and listed PC rooms together; joining a PC room goes peer-to-peer', async () => {
    const { base, srv } = await start()
    const p2p = createMemoryNet()
    const host = headlessClient(base, { key: 'pch', device: 'device-pc-host', name: 'Mira', play: false, p2p })
    const guest = headlessClient(base, { key: 'pcg', device: 'device-pc-guest', name: 'Ann', play: false, p2p })
    // a server quick-play room to share the list with
    await host.online.quickPlay('test')
    // Mira hosts from her PC and lists the room (the lister, as the game session drives it)
    await host.session.openHost()
    const code = host.lobby().roomCode!
    expect(host.session.transport()).toBe('p2p')
    for (let i = 0; i < 9; i++) host.session.addBot('easy')
    expect(host.lobby().slots).toHaveLength(10)
    const listing = () => p2pListingTarget({
      listed: { code, region: 'test' }, code, role: host.lobby().role, status: host.lobby().status, public: true,
      transport: host.session.transport(), slots: host.lobby().slots, settings: host.lobby().settings!,
      screen: host.screen(), host: 'Mira', max: 10, joinable: host.session.joinableSeats(),
    })
    const lister = new Lister(host.online)
    lister.want(listing())
    await until(() => lister.state().status === 'listed', 3000, 'the listing')
    await new Promise((r) => setTimeout(r, 1100 / TIME_SCALE + 50))
    const rooms = await guest.online.browse()
    expect(rooms.map((r) => r.kind).sort()).toEqual(['p2p', 'server'])
    const pc = rooms.find((r) => r.kind === 'p2p')!
    expect(pc).toMatchObject({ code, host: 'Mira', quick: false, humans: 1, bots: 9, joinable: 9, phase: 'lobby', region: { id: 'test' } })
    // Starting a full bot-filled match must not remove the P2P directory entry.
    host.session.startMatch()
    await until(() => host.screen() === 'match', 3000, 'the PC match')
    lister.want(listing())
    await new Promise((r) => setTimeout(r, 2100))
    expect((await guest.online.browse()).find((r) => r.code === code)).toMatchObject({ kind: 'p2p', phase: 'match', joinable: 9 })
    // one click: a normal join by code, peer-to-peer (the server holds no such room)
    await guest.session.join(pc.code)
    await until(() => host.lobby().slots.filter((s) => s.kind === 'human').length === 2, 3000, 'Ann reserved a PC bot seat')
    expect(guest.session.transport()).toBe('p2p')
    expect(guest.routed()).toBeNull()
    expect(srv.core.stats().players).toBe(0)
    lister.want(null)
    await until(() => lister.state().status === 'off', 3000, 'unlisted')
    host.session.leave()
    guest.session.leave()
  }, 20000)
})

describe('lobby state from room to room (P0: the host lost its Rematch button)', () => {
  const FAST = { winScore: 1, shopSeconds: 1, lavaDps: 400, dmgMultiplier: 2.5, kbMultiplier: 1.6 }

  /** The results screen's control as Results.tsx decides it: the host / owner starts the rematch, others vote, quick play runs itself. */
  const control = (l: LobbyView) => (l.quick ? 'auto' : l.role !== 'client' ? 'rematch' : 'ready')

  async function finishWithRematch(host: ReturnType<typeof headlessClient>, guest: ReturnType<typeof headlessClient>) {
    host.session.updateSettings(FAST)
    await until(() => guest.lobby().settings?.winScore === 1, 3000, 'settings at the guest')
    host.session.startMatch()
    await until(() => host.screen() === 'match' && guest.screen() === 'match', 8000, 'the match')
    await until(() => host.screen() === 'results' && guest.screen() === 'results', 50000, 'results')
    expect(control(host.lobby())).toBe('rematch')
    expect(control(guest.lobby())).toBe('ready')
    guest.session.setReady(true)
    await until(() => host.lobby().ready[guest.lobby().localPlayer] === true, 3000, "the guest's vote at the host")
    host.session.rematch()
    await until(() => host.screen() === 'match' && guest.screen() === 'match', 8000, 'the rematch')
  }

  /**
   * Why: quick-play and listing state belong to one room. Left over in the next lobby,
   * it hid the host's Rematch button ("the next match starts by itself") while the
   * guests could still vote, so nobody could start the rematch (live playtest, 250026d).
   */
  it('quick play, then host peer-to-peer, then a server room: no stale room state, the host / owner always has Rematch', async () => {
    const { base } = await start({ quickplay: { ...DEFAULT_SERVER_CONFIG.quickplay, fillMs: 600_000 } })
    const p2p = createMemoryNet()
    const ann = headlessClient(base, { key: 'ann', device: 'device-ann-p0', name: 'Ann', play: true, p2p })
    const bob = headlessClient(base, { key: 'bob', device: 'device-bob-p0', name: 'Bob', play: true, p2p })

    // 1. both in a quick-play room
    const q = await ann.online.quickPlay('test')
    await ann.session.join(q.code)
    await bob.session.join(q.code)
    await until(() => ann.lobby().quick === true && bob.lobby().quick === true && !!ann.lobby().autoStart, 3000, 'the quick lobby')
    expect(control(ann.lobby())).toBe('auto')
    ann.session.leave()
    bob.session.leave()
    expect(ann.lobby()).toMatchObject({ role: 'offline', quick: false, public: false, autoStart: null })

    // 2. Ann hosts peer-to-peer: a plain room on both sides
    await ann.session.openHost()
    expect(ann.lobby()).toMatchObject({ role: 'host', status: 'open', quick: false, public: false, autoStart: null })
    await bob.session.join(ann.lobby().roomCode!)
    await until(() => ann.lobby().slots.length === 2, 3000, 'Bob seated')
    expect(bob.lobby()).toMatchObject({ role: 'client', quick: false, public: false, autoStart: null })
    await finishWithRematch(ann, bob)
    ann.session.leave()
    bob.session.leave()

    // 3. Bob owns a server room (after his quick-play and P2P rooms): owner = host role
    const code = await bob.online.createRoom('test')
    await bob.session.join(code)
    await until(() => bob.lobby().role === 'host', 3000, 'Bob owns the room')
    await ann.session.join(code)
    await until(() => bob.lobby().slots.length === 2, 3000, 'Ann seated')
    expect(bob.lobby()).toMatchObject({ quick: false, public: false, autoStart: null })
    expect(ann.lobby()).toMatchObject({ role: 'client', quick: false })
    await finishWithRematch(bob, ann)
    // still the owner's controls after the rematch
    expect(bob.lobby().role).toBe('host')
    ann.session.leave()
    bob.session.leave()
  }, 120000)
})

describe('ranked queue over real TCP', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) removeDir(d)
  })

  async function queue(http: string, query = '') {
    const res = await fetch(`${http}/ranked${query}`, { method: 'POST' })
    expect([200, 201]).toContain(res.status)
    return await res.json() as { code: string; created: boolean }
  }

  it('requires distinct device identities before counting humans and honors a preferred bot color on entry', async () => {
    const dir = tempDir('brawlock-ranked-identities-')
    dirs.push(dir)
    const { base, http, srv } = await start({}, 'dev-server', { dataDir: dir })
    const a = headlessClient(base, { key: 'identity-a', device: 'ranked-identity-device', play: false })
    const absent = headlessClient(base, { key: 'identity-absent', play: false })
    const duplicate = headlessClient(base, { key: 'identity-duplicate', device: 'ranked-identity-device', profileId: 'another-player-profile', play: false })
    let b: ReturnType<typeof headlessClient> | null = null
    try {
      const opened = await queue(http)
      const room = srv.core.room(opened.code)!
      await a.session.join(opened.code)
      await absent.session.join(opened.code)
      expect(absent.lobby().status).toBe('error')
      expect(absent.lobby().error).toMatch(/device identity/i)
      await duplicate.session.join(opened.code)
      expect(duplicate.lobby().status).toBe('error')
      expect(duplicate.lobby().error).toMatch(/device already/i)
      expect(room.humans()).toBe(1)
      expect(a.lobby().autoStart).toBeNull()
      const favorite = a.lobby().slots.filter((s) => s.kind === 'bot').at(-1)!
      b = headlessClient(base, { key: 'identity-b', device: 'ranked-identity-other', color: favorite.color, play: false })
      await b.session.join(opened.code)
      await until(() => room.humans() === 2 && !!a.lobby().autoStart, 3000, 'two distinct ranked devices')
      expect(b.lobby().localPlayer).toBe(favorite.id)
      expect(b.lobby().slots.find((s) => s.id === favorite.id)).toMatchObject({ kind: 'human', color: favorite.color })
    } finally { a.session.leave(); absent.session.leave(); duplicate.session.leave(); b?.session.leave() }
  }, 10000)

  it('prefills Brutal bots, waits for two humans, preserves and cancels the countdown, and closes running admission', async () => {
    const dir = tempDir('brawlock-ranked-queue-')
    dirs.push(dir)
    const { base, http, srv } = await start({
      ranked: { ...DEFAULT_SERVER_CONFIG.ranked, startMs: 6000, nextMs: 1200 },
    }, 'dev-server', { dataDir: dir })
    const a = headlessClient(base, { key: 'ranked-a', device: 'ranked-device-a', play: false })
    const b = headlessClient(base, { key: 'ranked-b', device: 'ranked-device-b', play: false })
    const c = headlessClient(base, { key: 'ranked-c', device: 'ranked-device-c', play: false })
    try {
      expect(DEFAULT_SERVER_CONFIG.ranked).toMatchObject({
        seats: 8, fill: 8, bots: 'brutal', minHumans: 2, startMs: 60_000,
        settings: { rankedRounds: 5, startGold: 50, roundGold: 15, killGold: 2, winGold: 3 },
      })
      const first = await queue(http, '?bots=easy&seats=2&fill=2&startGold=999&rankedRounds=1')
      const room = srv.core.room(first.code)!
      expect(room.isRanked()).toBe(true)
      expect(room.summary()).toMatchObject({ ranked: true, quick: true, humans: 0, bots: 8, max: 8, joinable: 8, rankedRounds: 5, elo: { enabled: true, minSeconds: 120 } })
      expect(await a.online.browseRegion('test')).toContainEqual(expect.objectContaining({ code: first.code, ranked: true, rankedRounds: 5, max: 8, bots: 8 }))
      await a.session.join(first.code)
      await until(() => a.lobby().slots.length === 8, 3000, 'the prefilled ranked lobby')
      expect(a.lobby()).toMatchObject({ role: 'client', ranked: true, quick: true, public: true, autoStart: null })
      expect(a.lobby().slots.filter((s) => s.kind === 'bot')).toHaveLength(7)
      expect(a.lobby().slots.filter((s) => s.kind === 'bot').every((s) => s.difficulty === 'brutal')).toBe(true)
      expect(a.lobby().settings).toMatchObject({ rankedRounds: 5, startGold: 50, roundGold: 15, killGold: 2, winGold: 3 })
      // fillMs is zero: a mistaken solo fill timer would already have fired.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(a.screen()).toBe('lobby')
      expect(a.lobby().autoStart).toBeNull()
      expect((await a.online.quickPlay('test')).code).not.toBe(first.code)
      a.session.updateSettings({ startGold: 999, winScore: 1 })
      a.session.removeSlot(a.lobby().slots.find((s) => s.kind === 'bot')!.id)
      a.session.startMatch()
      expect((await queue(http)).code).toBe(first.code)
      await b.session.join(first.code)
      await until(() => !!a.lobby().autoStart && room.humans() === 2, 3000, 'two-human ranked countdown')
      const deadline = a.lobby().autoStart!.at
      expect(a.lobby().autoStart!.fill).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await c.session.join(first.code)
      await until(() => room.humans() === 3 && a.lobby().slots.filter((s) => s.kind === 'human').length === 3, 3000, 'a third human')
      expect(Math.abs(a.lobby().autoStart!.at - deadline)).toBeLessThan(150)
      expect(a.lobby().settings?.startGold).toBe(50)
      expect(a.lobby().slots).toHaveLength(8)
      b.session.leave()
      c.session.leave()
      await until(() => room.humans() === 1 && a.lobby().autoStart === null, 3000, 'the canceled ranked countdown')
      await new Promise((resolve) => setTimeout(resolve, 1700))
      expect(room.screen()).toBe('lobby')
      expect(a.lobby().slots.filter((s) => s.kind === 'bot')).toHaveLength(7)
      await b.session.join(first.code)
      await until(() => !!a.lobby().autoStart, 3000, 'a fresh ranked countdown')
      expect(a.lobby().autoStart!.at).toBeGreaterThan(deadline)
      await until(() => a.screen() === 'match' && b.screen() === 'match', 4000, 'ranked automatic start')
      expect(room.summary()).toMatchObject({ ranked: true, quick: true, joinable: 0 })
      expect(room.joinableSeats()).toBe(0)
      await c.session.join(first.code)
      expect(c.lobby().status).toBe('error')
      expect(c.lobby().error).toMatch(/ranked.*(started|progress)/i)
      expect(room.humans()).toBe(2)
      const next = await queue(http)
      expect(next.created).toBe(true)
      expect(next.code).not.toBe(first.code)
    } finally { a.session.leave(); b.session.leave(); c.session.leave() }
  }, 20000)

  /** Why: a ranked lobby counts down 60 s for latecomers; players who are all ready should not have to sit it out. */
  it('every player Ready in the ranked lobby cuts the countdown to a few seconds', async () => {
    const dir = tempDir('brawlock-ranked-ready-')
    dirs.push(dir)
    const { base, http } = await start({
      ranked: { ...DEFAULT_SERVER_CONFIG.ranked, startMs: 60000, settings: { ...DEFAULT_SERVER_CONFIG.ranked.settings, rankedRounds: 0, winScore: 1 } },
    }, 'dev-server', { dataDir: dir })
    const a = headlessClient(base, { key: 'ranked-ready-a', device: 'ranked-ready-device-a', play: false })
    const b = headlessClient(base, { key: 'ranked-ready-b', device: 'ranked-ready-device-b', play: false })
    try {
      const opened = await queue(http)
      await a.session.join(opened.code)
      await b.session.join(opened.code)
      await until(() => a.lobby().autoStart != null, 3000, 'the ranked countdown')
      a.session.setReady(true)
      await new Promise((r) => setTimeout(r, 1500))
      expect(a.screen()).toBe('lobby')
      b.session.setReady(true)
      await until(() => a.screen() === 'match' && b.screen() === 'match', 9000, 'the match a few seconds after both are ready')
    } finally { a.session.leave(); b.session.leave() }
  }, 30000)

  it('reviews results until Ready, returns to a prefilled lobby, and requires two humans for a fresh match', async () => {
    const dir = tempDir('brawlock-ranked-rematch-')
    dirs.push(dir)
    const { base, http, srv } = await start({
      leaderboardMinSeconds: 1,
      ranked: {
        ...DEFAULT_SERVER_CONFIG.ranked, startMs: 1000, nextMs: 2400,
        settings: { ...DEFAULT_SERVER_CONFIG.ranked.settings, rankedRounds: 0, winScore: 1, shopSeconds: 1, lavaDps: 400, dmgMultiplier: 2, kbMultiplier: 1.6 },
      },
    }, 'dev-server', { dataDir: dir })
    const a = headlessClient(base, { key: 'ranked-rematch-a', device: 'ranked-rematch-device-a', play: true })
    const b = headlessClient(base, { key: 'ranked-rematch-b', device: 'ranked-rematch-device-b', play: true })
    try {
      const opened = await queue(http)
      const room = srv.core.room(opened.code)!
      await a.session.join(opened.code)
      await b.session.join(opened.code)
      await until(() => a.screen() === 'match' && b.screen() === 'match', 4000, 'ranked first match')
      b.session.leave()
      await until(() => a.screen() === 'results' && a.results.length === 1, 60000, 'ranked result review')
      expect(room.screen()).toBe('results')
      expect(a.lobby().autoStart).toBeNull()
      // the result stays up (past the old nextMs) until the player is ready for the next queue
      await new Promise((resolve) => setTimeout(resolve, 3000))
      expect(a.screen()).toBe('results')
      a.session.setReady(true)
      await until(() => a.screen() === 'lobby' && room.screen() === 'lobby', 3000, 'ranked returns to lobby once ready')
      expect(room.summary()).toMatchObject({ humans: 1, bots: 7, ranked: true, joinable: 7 })
      expect(a.lobby().autoStart).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(a.screen()).toBe('lobby')
      expect(a.results).toHaveLength(1)
      expect((await queue(http)).code).toBe(opened.code)
      const previousCountdowns = a.autoStarts.length
      await b.session.join(opened.code)
      expect(b.lobby().status, b.lobby().error ?? 'ranked reconnect status').toBe('open')
      expect(room.humans(), JSON.stringify({ room: room.summary(), a: a.lobby(), b: b.lobby() })).toBe(2)
      await until(() => a.autoStarts.length > previousCountdowns, 3000, 'ranked rematch lobby countdown')
      expect(a.autoStarts.at(-1)!.fill).toBe(false)
      await until(() => a.screen() === 'match' && b.screen() === 'match', 4000, 'ranked second match')
      expect(a.results).toHaveLength(1)
      expect(a.lobby().slots).toHaveLength(8)
    } finally { a.session.leave(); b.session.leave() }
  }, 75000)
})

describe('leaderboard over the server (M4.3)', () => {
  const FAST = { winScore: 1, shopSeconds: 1, lavaDps: 400, dmgMultiplier: 2, kbMultiplier: 1.6 }
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) removeDir(d)
  })

  async function playMatch(base: string, humans: { key: string; device: string; name: string }[], bots: number, ranked = false) {
    const cs = humans.map((h) => headlessClient(base, { ...h, play: true }))
    const code = ranked ? (await cs[0].online.rankedPlay('test')).code : await cs[0].online.createRoom('test')
    for (const c of cs) await c.session.join(code)
    await until(() => cs[0].lobby().slots.filter((s) => s.kind === 'human').length === humans.length, 3000, 'everyone seated')
    if (!ranked) {
      for (let i = 0; i < bots; i++) cs[0].session.addBot('easy')
      cs[0].session.updateSettings(FAST)
      await until(() => cs[0].lobby().slots.length === humans.length + bots && cs[0].lobby().settings?.winScore === 1, 3000, 'lobby set up')
      cs[0].session.startMatch()
    }
    await until(() => cs.every((c) => c.screen() === 'results'), 60000, 'the match to finish')
    const results = cs.map((c) => c.results.at(-1)!)
    for (const c of cs) c.session.leave()
    return results
  }

  /**
   * Why: the board is only worth something if it counts real server matches between
   * people: casual matches are ignored, the device id never leaks, and the
   * data survives the restart every deploy does.
   */
  it('counts eligible ranked matches only, never shows device ids, survives a restart', async () => {
    const dir = tempDir('brawlock-lb-e2e-')
    dirs.push(dir)
    const events: string[] = []
    const log = (_level: string, event: string, f?: Record<string, unknown>) => events.push(f?.reason ? `${event}:${String(f.reason)}` : event)
    let { base, http, srv } = await start({
      leaderboardMinSeconds: 1, region: 'test',
      ranked: { ...DEFAULT_SERVER_CONFIG.ranked, fill: 3, startMs: 1000, settings: { ...FAST, rankedRounds: 0 } },
    }, 'dev-server', { dataDir: dir, log })
    const ann = { key: 'ann', device: 'device-ann-0001', name: 'Ann' }
    const bob = { key: 'bob', device: 'device-bob-0001', name: 'Bob' }
    // Custom rooms stay casual, with one human or with two humans and a bot.
    const solo = await playMatch(base, [ann], 2)
    expect(solo[0].rating).toEqual({ status: 'unrated', reason: 'Casual games do not affect global Elo.' })
    const casual = await playMatch(base, [ann, bob], 1)
    expect(casual.map((r) => r.rating)).toEqual([
      { status: 'unrated', reason: 'Casual games do not affect global Elo.' },
      { status: 'unrated', reason: 'Casual games do not affect global Elo.' },
    ])
    expect(events).not.toContain('leaderboard.match')
    expect(((await (await fetch(`${http}/leaderboard`)).json()) as { entries: unknown[] }).entries).toEqual([])
    // Ranked queue: two humans and a bot are eligible.
    const rated = await playMatch(base, [ann, bob], 1, true)
    expect(rated.map((r) => r.rating)).toEqual([{ status: 'rated' }, { status: 'rated' }])
    await until(() => events.includes('leaderboard.match'), 3000, 'the recorded match')
    const read = async (h: string) => {
      const res = await fetch(`${h}/leaderboard?period=all&device=${ann.device}`)
      const text = await res.text()
      return { text, body: JSON.parse(text) as { region: string; entries: { name: string; tag: string; matches: number; rating: number; roundsPlayed: number }[]; you: { rank: number; name: string } | null } }
    }
    const first = await read(http)
    expect(first.body.entries.map((e) => e.name).sort()).toEqual(['Ann', 'Bob'])
    expect(first.body.entries.every((e) => e.matches === 1 && e.roundsPlayed >= 1 && /^[0-9a-z]{5}$/.test(e.tag))).toBe(true)
    expect(first.body.entries.map((e) => e.rating).reduce((x, y) => x + y)).toBeCloseTo(2000, -1)
    expect(first.body.you).toMatchObject({ name: 'Ann' })
    expect(first.text).not.toContain('device-')
    const c0 = headlessClient(base)
    const prof = (await (await fetch(`${http}/players/${bob.device}`)).json()) as { name: string; matches: number; recent: unknown[] }
    expect(prof).toMatchObject({ found: true, name: 'Bob', matches: 1 })
    expect(prof.recent).toHaveLength(1)
    expect(await (await fetch(`${http}/players/device-nobody-01`)).json()).toEqual({ found: false })
    expect(await c0.online.profile('test', 'device-nobody-01')).toBeNull()
    expect(await c0.online.profile('test', bob.device)).toMatchObject({ name: 'Bob', region: { id: 'test' } })
    expect((await fetch(`${http}/leaderboard?period=year`)).status).toBe(400)
    // the client API reads the same board
    const c = headlessClient(base)
    expect((await c.online.leaderboard('test', 'week', ann.device)).entries).toHaveLength(2)
    // A rename in a later lobby updates the existing device row and invalidates the
    // cached public board, without playing another match or rewriting past results.
    const renamedClient = headlessClient(base, { ...ann, play: false })
    const renameRoom = await renamedClient.online.createRoom('test')
    await renamedClient.session.join(renameRoom)
    expect(srv.core.room(renameRoom)!.summary().elo).toEqual({ enabled: false, minSeconds: 1 })
    renamedClient.session.setDisplayName('Ann renamed')
    await until(() => renamedClient.lobby().slots.some((s) => s.name === 'Ann renamed'), 3000, 'the current lobby rename')
    const renamed = await read(http)
    expect(renamed.body.entries).toEqual(first.body.entries.map((e) => e.name === 'Ann' ? { ...e, name: 'Ann renamed' } : e))
    expect(renamed.body.you).toMatchObject({ name: 'Ann renamed' })
    const renamedProfile = await renamedClient.online.profile('test', ann.device)
    expect(renamedProfile).toMatchObject({ name: 'Ann renamed', matches: 1 })
    renamedClient.session.leave()
    // pm2 reload: a new process on the same data directory
    await srv.close()
    servers = servers.filter((x) => x !== srv)
    ;({ base, http, srv } = await start({ region: 'test' }, 'dev-server', { dataDir: dir }))
    const after = await read(http)
    expect(after.body.entries).toEqual(renamed.body.entries)
  }, 150000)
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

describe('shared global ratings authority over TCP', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) removeDir(dir)
  })
  const directory = () => { const dir = tempDir('brawlock-global-rating-'); dirs.push(dir); return dir }
  const submission = (key = crypto.randomUUID()): RatingSubmission => ({
    key, room: 'ABCDE', region: 'us-west', at: Date.now(), minSeconds: 1,
    match: { ticks: 9000, rounds: 1, teamMode: 'ffa', gameMode: 'rounds', bots: 1,
      seats: [
        { player: 0, device: 'global-ann-device', name: 'Ann', roundsPlayed: 1, roundsWon: 1, kills: 1, deaths: 0, won: true },
        { player: 1, device: 'global-bob-device', name: 'Bob', roundsPlayed: 1, roundsWon: 0, kills: 0, deaths: 1, won: false },
      ], ranked: [{ groups: [[0], [1]], team: { 0: 0, 1: 1 } }] },
  })

  it('authenticates private mutations and lets the EU simulate locally while both regions expose one global board', async () => {
    const token = crypto.randomUUID() + crypto.randomUUID()
    const us = await start({ region: 'us-west', leaderboardMinSeconds: 1 }, 'dev-server', { dataDir: directory(), ratingAuthorityToken: token })
    const record = (body: unknown, headers: Record<string, string> = {}) => fetch(`${us.http}/internal/rating/record`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    expect((await record(submission())).status).toBe(403)
    expect((await record(submission(), { authorization: `Bearer ${token}`, origin: 'https://game.invalid' })).status).toBe(403)
    expect((await record({ ...submission(), match: { ticks: -1 } }, { authorization: `Bearer ${token}` })).status).toBe(400)
    expect((await record({ oversized: 'x'.repeat(129 * 1024) }, { authorization: `Bearer ${token}` })).status).toBe(413)
    expect(await (await record(submission(), { authorization: `Bearer ${token}` })).json()).toEqual({ status: 'rated' })
    const eu = await start({ region: 'eu', leaderboardMinSeconds: 1,
      ranked: { ...DEFAULT_SERVER_CONFIG.ranked, fill: 3, startMs: 400, settings: { rankedRounds: 0, winScore: 1, shopSeconds: 1, lavaDps: 400, dmgMultiplier: 2, kbMultiplier: 1.6 } },
    }, 'dev-server', { dataDir: directory(), ratingAuthorityUrl: us.http, ratingAuthorityToken: token, ratingAuthorityAllowInsecureForTests: true })
    const ann = headlessClient(eu.base, { key: 'global-ann', device: 'global-ann-device', name: 'Ann', play: true })
    const bob = headlessClient(eu.base, { key: 'global-bob', device: 'global-bob-device', name: 'Bob', play: true })
    try {
      const opened = await ann.online.rankedPlay('test')
      await ann.session.join(opened.code)
      await bob.session.join(opened.code)
      await until(() => ann.screen() === 'match' && bob.screen() === 'match', 4000, 'EU-local ranked match')
      expect(eu.srv.core.stats().rooms).toBe(1)
      expect(us.srv.core.stats().rooms).toBe(0)
      await until(() => ann.results.length === 1 && bob.results.length === 1, 60000, 'the EU result to wait for US commit')
      expect(ann.results[0].rating).toEqual({ status: 'rated' })
      expect(bob.results[0].rating).toEqual({ status: 'rated' })
      const read = async (http: string, region: string) => (await fetch(`${http}/leaderboard?region=${region}`)).json() as Promise<{ entries: { name: string; matches: number; rating: number; ratingChange7d: number }[] }>
      const global = await read(us.http, 'us-west')
      expect(await read(eu.http, 'eu')).toEqual(global)
      expect(global.entries.map((p) => p.matches)).toEqual([2, 2])
      // Both matches happened inside the same rolling window, including the US result read through EU.
      expect(global.entries.every((p) => p.ratingChange7d === p.rating - 1000)).toBe(true)
      expect(JSON.stringify(global)).not.toContain('global-ann-device')
      const profile = await (await fetch(`${eu.http}/players/global-ann-device`)).json() as { ratingChange7d: number; recent: { region: string }[] }
      expect(profile.recent.map((r) => r.region)).toEqual(['eu', 'us-west'])
      expect(profile.ratingChange7d).toBe(global.entries.find((p) => p.name === 'Ann')!.ratingChange7d)
      ann.session.setDisplayName('Ann across regions')
      await until(() => ann.lobby().slots.some((s) => s.name === 'Ann across regions'), 3000, 'EU rename accepted')
      // The public read is fresh from the authority; no regional cache can fork it.
      let renamed: { name?: string; matches?: number } = {}
      for (let attempt = 0; attempt < 40; attempt++) {
        renamed = await (await fetch(`${us.http}/players/global-ann-device`)).json() as typeof renamed
        if (renamed.name === 'Ann across regions') break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(renamed).toMatchObject({ name: 'Ann across regions', matches: 2 })
    } finally { ann.session.leave(); bob.session.leave() }
  }, 75000)

  it('durably retries an outage and a lost committed reply across restarts without double rating', async () => {
    const token = crypto.randomUUID() + crypto.randomUUID()
    const us = await start({ region: 'us-west', leaderboardMinSeconds: 1 }, 'dev-server', { dataDir: directory(), ratingAuthorityToken: token })
    const file = `${directory()}/rating-outbox.sqlite`
    const events: string[] = []
    const opts = { url: us.http, token, file, allowInsecureForTests: true, retryMs: 500, log: (_level: string, event: string) => { events.push(event) } }
    let client = remoteRatingAuthority(opts)
    const realFetch = globalThis.fetch
    const request = { ...submission(), region: 'eu' }
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url).endsWith('/internal/rating/record')) throw new Error('simulated authority outage')
        return realFetch(url, init)
      })
      expect(await client.record(request)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('saved and queued') })
      expect(client.pending()).toBe(1)
      client.close!()
      vi.restoreAllMocks()
      expect((await (await fetch(`${us.http}/leaderboard`)).json() as { entries: unknown[] }).entries).toEqual([])
      // The next process delivers the saved match, but loses the authority's reply.
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const response = await realFetch(url, init)
        if (String(url).endsWith('/internal/rating/record')) throw new Error('simulated lost committed reply')
        return response
      })
      client = remoteRatingAuthority(opts)
      await until(() => events.filter((e) => e === 'rating.outbox.pending').length === 2, 3000, 'lost committed reply to remain queued')
      expect(client.pending()).toBe(1)
      client.close!()
      vi.restoreAllMocks()
      const committed = await (await fetch(`${us.http}/leaderboard`)).json() as { entries: { matches: number }[] }
      expect(committed.entries.map((p) => p.matches)).toEqual([1, 1])
      // Third process repeats the same key. The atomic authority receipt prevents a second update.
      client = remoteRatingAuthority({ ...opts, retryMs: 20 })
      await until(() => client.pending() === 0, 4000, 'the durable retry receipt')
      expect(await (await fetch(`${us.http}/leaderboard`)).json()).toEqual(committed)
      expect(events).toContain('rating.outbox.delivered')
    } finally { client.close!(); vi.restoreAllMocks() }
  }, 15000)
})

describe('anonymous ICE credentials over HTTP', () => {
  it('serves only configured short-lived credentials, applies browser origins and bounds requests', async () => {
    const plain = await start()
    expect((await fetch(`${plain.http}/ice`)).status).toBe(503)
    const secret = crypto.randomUUID() + crypto.randomUUID()
    const origin = 'https://game.example'
    const { http } = await start({ allowedOrigins: [origin] }, 'independent-ice-build', {
      turnSecret: secret,
      turnUrls: ['turn:eu.brawlock.osc.link:3478?transport=udp', 'turn:eu.brawlock.osc.link:3478?transport=tcp', 'turns:eu.brawlock.osc.link:5349?transport=tcp'],
      turnTtlSeconds: 3600, clock: () => 1_700_000_000_000,
    })
    expect((await fetch(`${http}/ice`, { headers: { origin: 'https://other.example' } })).status).toBe(403)
    const accepted = await fetch(`${http}/ice`, { headers: { origin } })
    expect(accepted.status).toBe(200)
    expect(accepted.headers.get('cache-control')).toBe('no-store')
    expect(accepted.headers.get('vary')).toBe('Origin')
    expect(accepted.headers.get('access-control-allow-origin')).toBe(origin)
    const text = await accepted.text()
    const body = JSON.parse(text) as { expiresAt: number; iceServers: { urls: string | string[]; username?: string; credential?: string }[] }
    expect(body.expiresAt).toBe(1_700_003_600_000)
    expect(body.iceServers).toHaveLength(2)
    expect(body.iceServers[1].username).toMatch(/^1700003600:[a-f0-9-]{36}$/)
    expect(body.iceServers[1].credential).toMatch(/^[A-Za-z0-9+/]{27}=$/)
    expect(text).not.toContain(secret)
    expect((await fetch(`${http}/ice`)).status).toBe(200) // native/no-Origin clients
    for (let i = 0; i < 10; i++) expect((await fetch(`${http}/ice`)).status).toBe(200)
    expect((await fetch(`${http}/ice`)).status).toBe(429)
  }, 10000)
})

describe('cached server performance over HTTP', () => {
  it('publishes a finite native Node measurement without requiring any active match', async () => {
    const srv = await startServer({ port: 0, log: quiet })
    try {
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const body = await (await fetch(`http://127.0.0.1:${srv.port}/health`)).json() as { perf: Record<string, number> | null }
      expect(body.perf).not.toBeNull()
      expect(Object.values(body.perf!).every(Number.isFinite)).toBe(true)
      expect(body.perf!.windowMs).toBeGreaterThan(0)
      expect(body.perf!.sampleAt).toBeGreaterThan(0)
      expect(body.perf!.rssMb).toBeGreaterThan(0)
      expect(body.perf).toMatchObject({ simStepsPerSec: 0, simStepAvgMs: 0, simStepMaxMs: 0 })
    } finally { await srv.close() }
  }, 10000)

  it('adds null then the same cached sample to existing health, preserves CORS, and closes diagnostics', async () => {
    let sample: ReturnType<ServerPerfSampler['snapshot']> = null
    const perf = {
      snapshot: vi.fn(() => sample),
      wrapStep: vi.fn(<T extends (...args: any[]) => any>(step: T): T => step),
      close: vi.fn(),
    }
    const srv = await startServer({ port: 0, log: quiet, perf, config: { allowedOrigins: ['https://game.example'] } })
    const base = `http://127.0.0.1:${srv.port}`
    try {
      const initial = await fetch(`${base}/health`, { headers: { origin: 'https://game.example' } })
      expect(initial.headers.get('access-control-allow-origin')).toBe('https://game.example')
      expect(await initial.json()).toMatchObject({ ok: true, rooms: 0, players: 0, perf: null })
      expect(perf.wrapStep).toHaveBeenCalledOnce()
      // This is only Node glue: simulation core health and its route policy are unchanged.
      const core = await srv.core.http({ method: 'GET', path: '/health', ip: 'test', origin: null })
      expect(JSON.parse(core.body)).not.toHaveProperty('perf')
      sample = Object.freeze({ sampleAt: 1_700_000_000_000, windowMs: 1000, processCpuPct: 12.5,
        eventLoopP95Ms: 21, eventLoopMaxMs: 29, simStepAvgMs: 0.6, simStepMaxMs: 2, simStepsPerSec: 120, rssMb: 85 })
      for (let i = 0; i < 2; i++) expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ perf: sample })
      expect(perf.snapshot).toHaveBeenCalledTimes(3)
      const unknown = await fetch(`${base}/perf`)
      expect(unknown.status).toBe(404)
      expect(perf.snapshot).toHaveBeenCalledTimes(3)
      expect(perf.close).not.toHaveBeenCalled()
    } finally { await srv.close() }
    expect(perf.close).toHaveBeenCalledOnce()
  }, 10000)

  it('closes its sampler if the HTTP listener cannot start', async () => {
    const first = await startServer({ port: 0, log: quiet })
    const perf = {
      snapshot: () => null,
      wrapStep: <T extends (...args: any[]) => any>(step: T): T => step,
      close: vi.fn(),
    }
    try {
      await expect(startServer({ port: first.port, log: quiet, perf })).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(perf.close).toHaveBeenCalledOnce()
    } finally { await first.close() }
  }, 10000)
})

describe('automatic room last-human cleanup', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) removeDir(dir) })

  it.each([
    ['quick', 'lobby'], ['quick', 'running'], ['ranked', 'lobby'], ['ranked', 'running'],
  ] as const)('closes an empty %s %s room, removes its cached listing and stops its session', async (kind, phase) => {
    const dir = tempDir('brawlock-empty-queue-')
    dirs.push(dir)
    const { base, http, srv } = await start({
      emptyRoomMs: 60_000,
      quickplay: { ...DEFAULT_SERVER_CONFIG.quickplay, fillMs: phase === 'lobby' ? 60_000 : 100, startMs: 100,
        settings: { ...DEFAULT_SERVER_CONFIG.quickplay.settings, shopSeconds: 10, lavaDps: 0, dmgMultiplier: 0 } },
      ranked: { ...DEFAULT_SERVER_CONFIG.ranked, startMs: phase === 'lobby' ? 60_000 : 100,
        settings: { ...DEFAULT_SERVER_CONFIG.ranked.settings, shopSeconds: 10, lavaDps: 0, dmgMultiplier: 0 } },
    }, 'dev-server', { dataDir: dir })
    const a = headlessClient(base, { key: 'empty-a', device: 'empty-device-a', play: false })
    const b = headlessClient(base, { key: 'empty-b', device: 'empty-device-b', play: false })
    try {
      const opened = await (await fetch(`${http}/${kind === 'quick' ? 'quickplay' : 'ranked'}`, { method: 'POST' })).json() as { code: string }
      const room = srv.core.room(opened.code)!
      srv.core.sweep()
      expect(srv.core.room(opened.code)).toBe(room) // HTTP reservation before the first connection is not a departure.
      await a.session.join(opened.code)
      if (kind === 'ranked' && phase === 'running') await b.session.join(opened.code)
      await until(() => phase === 'running' ? a.screen() === 'match' : room.humans() === 1, 4000, 'the test queue phase')
      if (kind === 'quick' && phase === 'running') expect(room.seats()).toBe(10)
      expect((await a.online.browseRegion('test')).some((r) => r.code === opened.code)).toBe(true)
      const close = vi.spyOn(room, 'close')
      if (kind === 'ranked' && phase === 'running') {
        b.session.leave()
        await until(() => room.peers() === 1, 3000, 'one remaining human connection')
        expect(srv.core.room(opened.code)).toBe(room)
      }
      // This path closes the transport without a leave message, exercising network-loss policy too.
      if (kind === 'quick' && phase === 'running') a.session.openOffline()
      else a.session.leave()
      await until(() => srv.core.room(opened.code) === null, 3000, 'last-human queue removal')
      expect(close).toHaveBeenCalledOnce()
      expect(room.debug()).toMatchObject({ role: null, tick: -1 })
      expect(srv.core.stats()).toMatchObject({ rooms: 0, connections: 0 })
      expect((await a.online.browseRegion('test')).some((r) => r.code === opened.code)).toBe(false)
    } finally { a.session.leave(); b.session.leave() }
  }, 10000)

  it('preserves an existing pending queue reservation until its arriving player joins', async () => {
    const { base, srv } = await start({ quickplay: { ...DEFAULT_SERVER_CONFIG.quickplay, fillMs: 60_000 } })
    const a = headlessClient(base, { key: 'reserved-a', play: false })
    const b = headlessClient(base, { key: 'reserved-b', play: false })
    try {
      const first = await a.online.quickPlay('test')
      await a.session.join(first.code)
      const pending = await b.online.quickPlay('test')
      expect(pending).toMatchObject({ code: first.code, created: false })
      a.session.leave()
      await until(() => srv.core.stats().connections === 0, 3000, 'the first player to leave')
      srv.core.sweep()
      expect(srv.core.room(first.code)).not.toBeNull()
      await b.session.join(pending.code)
      expect(b.lobby().status).toBe('open')
      b.session.leave()
      await until(() => srv.core.room(first.code) === null, 3000, 'the final reserved player to leave')
    } finally { a.session.leave(); b.session.leave() }
  }, 10000)

  it('keeps custom rooms on their existing empty-room lifetime', async () => {
    const { base, srv } = await start({ emptyRoomMs: 60_000 })
    const room = await srv.createRoom({ auto: true, autoStartMs: 100, bots: ['dummy'], settings: { shopSeconds: 10, lavaDps: 0, dmgMultiplier: 0 } })
    const owner = headlessClient(base, { key: 'empty-custom', play: false })
    try {
      await owner.session.join(room.code)
      await until(() => owner.screen() === 'match', 4000, 'the custom match to start')
      owner.session.leave()
      await until(() => srv.core.stats().connections === 0, 3000, 'the custom owner to leave')
      srv.core.sweep()
      expect(room.isQuick()).toBe(false)
      expect(srv.core.room(room.code)).toBe(room)
    } finally { owner.session.leave() }
  }, 10000)

  it('removes a departed queue room once its existing unclaimed reservation expires', async () => {
    const { base, srv } = await start({ quickplay: { ...DEFAULT_SERVER_CONFIG.quickplay, fillMs: 60_000 } })
    const a = headlessClient(base, { key: 'expiry-a', play: false })
    const reserved = headlessClient(base, { key: 'expiry-b', play: false })
    try {
      const first = await a.online.quickPlay('test')
      await a.session.join(first.code)
      expect((await reserved.online.quickPlay('test')).code).toBe(first.code)
      a.session.leave()
      await until(() => srv.core.stats().connections === 0, 3000, 'the final actual connection to close')
      expect(srv.core.room(first.code)).not.toBeNull()
      // Existing reservation lifetime is 15 sim seconds; the server clock runs at TIME_SCALE.
      await new Promise((resolve) => setTimeout(resolve, 15_000 / TIME_SCALE))
      srv.core.sweep()
      expect(srv.core.room(first.code)).toBeNull()
    } finally { a.session.leave(); reserved.session.leave() }
  }, 10000)
})
