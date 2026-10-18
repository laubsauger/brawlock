/**
 * Local replays end to end: real sessions (offline, P2P host + input-stream client) over the
 * in-memory transport with fake timers record a whole bot match; re-simulating the replay
 * must land on the exact authoritative final state, seeking must land on the states forward
 * play reaches, and another build must refuse to play it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LobbyView, MatchResult, Screen } from '../store'
import { createBot } from '../../bots'
import { cloneState, createMatch, step } from '../../sim'
import type { InputCommand, MatchSettings, SimState } from '../../sim/types'
import { codeFromSearch, roomLink } from '../../net/code'
import { createMemoryNet, mulberry32, type LinkOptions } from '../../net/memory'
import { createSession, type NetMode, type SessionDeps } from '../../net/session'
import type { NetFactory } from '../../net/transport'
import { HASH_EVERY, decodeReplay, encodeReplay, type ReplayData } from './format'
import { createReplayHook } from './hook'
import { KEYFRAME_EVERY, ReplayPlayer } from './player'
import { ReplayRecorder, replayHash } from './recorder'
import { REPLAY_KEEP, ReplayLibrary, memoryBackend } from './store'
import { ReplayViewer } from './viewer'

const NET_ID = 'test-net-1'

const SETTINGS: MatchSettings = {
  teamMode: 'ffa',
  gameMode: 'rounds',
  winScore: 1,
  startGold: 30,
  roundGold: 10,
  killGold: 0,
  winGold: 0,
  lavaDps: 100,
  kbMultiplier: 1,
  dmgMultiplier: 1,
  friction: 0.96,
  shopSeconds: 1,
  botsReplaceLeavers: false,
}

/** A session with its recorder wired to the replay hook, saving into its own library. */
function makePeer(net: NetFactory, name: string, key: string, mode: NetMode = 'predict') {
  const store = {
    lobby: { role: 'offline', joinUrl: null, roomCode: null, status: 'idle', error: null, slots: [], settings: null, localPlayer: 0, pings: {}, ready: {} } as unknown as LobbyView,
    screen: 'menu' as Screen,
  }
  const lib = new ReplayLibrary(memoryBackend())
  const hook = createReplayHook(NET_ID, lib)
  const saved: string[] = []
  /** hash of the last authoritative state this peer stepped / saw */
  const last = { tick: -1, hash: 0, state: null as SimState | null }
  /** every authoritative tick's hash (replays must reproduce each one) */
  const auth = new Map<number, number>()
  const results: MatchResult[] = []
  const queue: InputCommand[] = []
  const deps: SessionDeps = {
    ui: {
      lobby: () => store.lobby,
      setLobby: (p) => void (store.lobby = { ...store.lobby, ...p }),
      screen: () => store.screen,
      setScreen: (s) => void (store.screen = s),
      setResult: () => {},
      paused: () => false,
      onScreen: () => () => {},
    },
    profile: () => ({ id: `profile-${name}`, name, color: null }),
    recorder: {
      start: (info) => hook.start(info),
      step: (b, i, p) => hook.step(b, i, p),
      observe: (s, e) => {
        hook.observe(s, e)
        auth.set(s.tick, replayHash(s))
        if (s.tick >= last.tick) {
          last.tick = s.tick
          last.hash = replayHash(s)
          last.state = cloneState(s)
        }
      },
      finish: (r) => {
        results.push(r)
        const id = hook.finish(`match-${name}`, r.winners)
        if (id) saved.push(id)
      },
      abort: () => hook.abort(),
    },
    frame: { reset: () => {}, setLocalPlayer: () => {}, pushState: () => {}, pushEvents: () => {}, setNet: () => {} },
    input: { drain: () => queue.splice(0) },
    audio: { playEvents: () => {} },
    createMatch,
    step,
    createBot,
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
    netMode: () => mode,
  }
  return { session: createSession(deps), store, lib, saved, last, results, auth, hook }
}

async function untilResults(...peers: ReturnType<typeof makePeer>[]): Promise<void> {
  for (let s = 0; s < 400 && peers.some((p) => p.store.screen !== 'results'); s++) await vi.advanceTimersByTimeAsync(1000)
  await vi.advanceTimersByTimeAsync(500)
  for (const p of peers) expect(p.store.screen).toBe('results')
}

async function loadSaved(p: ReturnType<typeof makePeer>): Promise<ReplayData> {
  expect(p.saved).toHaveLength(1)
  await p.hook.flush() // the save is async (compression runs on real I/O, not fake timers)
  const d = await p.lib.load(p.saved[0])
  expect(d).not.toBeNull()
  return d!
}

function playToEnd(d: ReplayData): ReplayPlayer {
  const p = new ReplayPlayer(d, NET_ID)
  expect(p.playable).toBe(true)
  while (!p.done) p.stepOnce()
  return p
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const LINK: LinkOptions = { latencyMs: 40, jitterMs: 10, loss: 0.02, seed: 7 }

describe('record -> replay reproduces the match', () => {
  it('offline: the replay re-simulates to the exact final state', async () => {
    const net = createMemoryNet({})
    const solo = makePeer(net, 'Solo', 'k')
    solo.session.openOffline()
    solo.session.addBot('hard')
    solo.session.addBot('hard')
    solo.session.startMatch()
    await untilResults(solo)
    const d = await loadSaved(solo)
    expect(d.seed).not.toBeNull()
    expect(d.hashes.length).toBeGreaterThan(3)
    expect(d.rounds.length).toBeGreaterThanOrEqual(1)
    expect(d.kills.length).toBeGreaterThanOrEqual(1)
    const p = playToEnd(d)
    expect(p.desync).toBeNull()
    expect(replayHash(p.state)).toBe(solo.auth.get(p.tick))
    expect(p.state.phase).toBe('gameOver')
    solo.session.leave()
  }, 30000)

  it('input-stream client: its replay matches the host’s authoritative match', async () => {
    const net = createMemoryNet(LINK)
    const host = makePeer(net, 'Hosty', 'host-key')
    const client = makePeer(net, 'Clienta', 'client-key')
    await host.session.openHost()
    const code = codeFromSearch(new URL(host.store.lobby.joinUrl!).search)!
    const joined = client.session.join(code)
    await vi.advanceTimersByTimeAsync(800)
    await joined
    host.session.addBot('hard')
    host.session.startMatch()
    await untilResults(host, client)
    const hostReplay = playToEnd(await loadSaved(host))
    const clientReplay = playToEnd(await loadSaved(client))
    expect(hostReplay.desync).toBeNull()
    expect(clientReplay.desync).toBeNull()
    // each replay ends where its recorder stopped; both equal the host's state at that tick
    expect(replayHash(hostReplay.state)).toBe(host.auth.get(hostReplay.tick))
    expect(replayHash(clientReplay.state)).toBe(host.auth.get(clientReplay.tick))
    expect(clientReplay.state.phase).toBe('gameOver')
    host.session.leave()
    client.session.leave()
  }, 60000)

  it('snapshot-only clients record nothing (no inputs are stepped there)', async () => {
    const net = createMemoryNet(LINK)
    const host = makePeer(net, 'Hosty', 'host-key', 'classic')
    const client = makePeer(net, 'Clienta', 'client-key', 'classic')
    await host.session.openHost()
    const code = codeFromSearch(new URL(host.store.lobby.joinUrl!).search)!
    const joined = client.session.join(code)
    await vi.advanceTimersByTimeAsync(800)
    await joined
    host.session.addBot('hard')
    host.session.startMatch()
    await untilResults(host, client)
    expect(host.saved).toHaveLength(1)
    expect(client.saved).toHaveLength(0)
    host.session.leave()
    client.session.leave()
  }, 60000)
})

// ---------------------------------------------------------------------------
/** a replay recorded straight from the sim loop (same semantics as the host loop) */
function recordDirect(seed: number, ticks: number): ReplayData {
  const slots = [0, 1, 2].map((i) => ({ id: i, name: `b${i}`, color: 0, team: i, kind: 'bot' as const, difficulty: 'hard' as const }))
  const s = createMatch({ ...SETTINGS, winScore: 50 }, slots, seed)
  const bots = slots.map((sl) => createBot(sl.id, 'hard', seed + sl.id))
  const rec = new ReplayRecorder()
  rec.begin({ localPlayer: 0, slots, settings: s.settings, seed })
  for (let i = 0; i < ticks; i++) {
    const inputs = bots.flatMap((b) => {
      const cmds = b.think(s)
      return cmds.length ? [{ player: b.player, tick: s.tick, cmds }] : []
    })
    rec.step(s, inputs)
    step(s, inputs)
    rec.observe(s, s.events)
  }
  return rec.finish('direct', NET_ID, [])!
}

describe('seeking and verification', () => {
  const d = recordDirect(11, KEYFRAME_EVERY * 4 + 123)

  it('seeking forward, backward and across keyframes lands on the forward-play state', () => {
    const forward = new Map<number, number>()
    const f = new ReplayPlayer(d, NET_ID)
    while (!f.done) {
      f.stepOnce()
      if (f.tick % 97 === 0 || f.tick === f.endTick) forward.set(f.tick, replayHash(f.state))
    }
    const p = new ReplayPlayer(d, NET_ID)
    const targets = [...forward.keys()]
    // a mix of forward jumps, rewinds and keyframe boundaries
    const order = [targets[20], targets[3], targets[targets.length - 1], targets[1], targets[12], targets[12], targets[0]]
    for (const t of order) {
      p.seek(t)
      expect(p.tick).toBe(t)
      expect(replayHash(p.state)).toBe(forward.get(t))
    }
    expect(p.desync).toBeNull()
  })

  it('a tampered input stream is flagged as a desync at the next checkpoint', () => {
    const bad: ReplayData = JSON.parse(JSON.stringify(d))
    const i = bad.steps.findIndex((s) => s[0] > HASH_EVERY && s[1].length > 0)
    const t = bad.steps[i][0]
    bad.steps[i][1] = [[0, [['m', 1500, 1500]]]]
    const p = playToEnd(bad)
    expect(p.desync).not.toBeNull()
    expect(p.desync!.tick).toBeGreaterThan(t)
    expect(p.desync!.tick).toBeLessThanOrEqual(Math.ceil((t + 1) / HASH_EVERY) * HASH_EVERY + HASH_EVERY)
  })

  it('a replay from another build is refused and never plays', () => {
    const p = new ReplayPlayer(d, 'some-newer-build')
    expect(p.playable).toBe(false)
    expect(p.check).toEqual({ ok: false, reason: 'build', netId: NET_ID })
    const t = p.tick
    expect(p.stepOnce()).toEqual([])
    p.seek(p.endTick)
    expect(p.tick).toBe(t)
  })
})

describe('library and files', () => {
  it('a .brawlock file round-trips (gzip) and junk is rejected', async () => {
    const d = recordDirect(3, 600)
    const bytes = await encodeReplay(d)
    expect(bytes[0]).toBe(0x1f) // gzip
    expect(JSON.stringify(await decodeReplay(bytes))).toBe(JSON.stringify(d))
    expect(await decodeReplay(new TextEncoder().encode('{"format":"nope"}'))).toBeNull()
    expect(await decodeReplay(new Uint8Array([1, 2, 3]))).toBeNull()
    // plain JSON (no CompressionStream at export) loads too
    expect((await decodeReplay(new TextEncoder().encode(JSON.stringify(d))))?.id).toBe(d.id)
  })

  it(`keeps the newest ${REPLAY_KEEP} plus pinned ones; imports are pinned`, async () => {
    const lib = new ReplayLibrary(memoryBackend())
    const base = recordDirect(5, 120)
    for (let i = 0; i < REPLAY_KEEP + 5; i++) await lib.save({ ...base, id: `r${i}`, date: 1000 + i }, i === 0)
    const list = await lib.list()
    expect(list).toHaveLength(REPLAY_KEEP + 1)
    expect(list.some((m) => m.id === 'r0' && m.pinned)).toBe(true) // the oldest survives: pinned
    expect(list.some((m) => m.id === 'r1')).toBe(false)
    const file = await lib.exportFile('r24')
    expect(file!.name).toMatch(/^brawlock-.*\.brawlock$/)
    const other = new ReplayLibrary(memoryBackend())
    const imported = await other.importFile(file!.bytes)
    expect(imported).toMatchObject({ id: 'r24', pinned: true })
    expect((await other.load('r24'))?.endTick).toBe(base.endTick)
  })
})

describe('viewer', () => {
  it('plays into the frame buffer, seeks exactly, follows players or a free camera', async () => {
    const { frame } = await import('../frame')
    const d = recordDirect(17, KEYFRAME_EVERY + 200)
    const v = new ReplayViewer(new ReplayLibrary(memoryBackend()), NET_ID)
    const focus: ({ x: number; y: number } | null)[] = []
    v.sinks = { cameraFocus: (p) => focus.push(p) }
    expect(v.openData(d)).toBe('ready')
    expect(frame.localPlayer).toBe(0) // the recorder's own player
    expect(frame.curr?.tick).toBe(d.start.tick)
    v.play()
    expect(v.advance(1)).toBe(12) // capped per frame
    v.setSpeed(4)
    v.advance(0.1) // 0.4 s of replay = 24 ticks, capped at 12
    expect(v.tick()).toBe(d.start.tick + 24)
    expect(frame.curr?.tick).toBe(v.tick())
    // seek back and forth: frame shows exactly the forward-play state
    const forward = new ReplayPlayer(d, NET_ID)
    forward.seek(700)
    v.seek(700)
    expect(replayHash(frame.curr!)).toBe(replayHash(forward.state))
    v.seek(10)
    expect(frame.curr?.tick).toBe(10)
    v.follow(2)
    expect(frame.localPlayer).toBe(2)
    v.follow(-1)
    expect(frame.localPlayer).toBe(-1)
    expect(focus.at(-1)).not.toBeNull()
    v.pan(100, 0)
    expect(focus.at(-1)!.x).toBe(focus.at(-2)!.x + 100)
    v.close()
    expect(v.get().status).toBe('idle')
    expect(focus.at(-1)).toBeNull()
  })

  it('refuses a replay from another build with a clear status', () => {
    const d = { ...recordDirect(2, 60), netId: 'old-build' }
    const v = new ReplayViewer(new ReplayLibrary(memoryBackend()), NET_ID)
    expect(v.openData(d)).toBe('mismatch')
    expect(v.get()).toMatchObject({ status: 'mismatch', netId: 'old-build', playing: false })
    v.play()
    expect(v.advance(1)).toBe(0)
  })
})
