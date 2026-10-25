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
import { killPawn } from '../../sim/combat'
import { ticks } from '../../sim/config'
import { startRound } from '../../sim/mode'
import { applyRosterChanges } from '../../sim/roster'
import { TICK_HZ, setTickRate, type InputCommand, type MatchSettings, type PlayerInput, type PlayerSlot, type SimState } from '../../sim/types'
import { codeFromSearch, roomLink } from '../../net/code'
import { createMemoryNet, mulberry32, type LinkOptions } from '../../net/memory'
import { createSession, type NetMode, type SessionDeps } from '../../net/session'
import type { NetFactory } from '../../net/transport'
import { HASH_EVERY, decodeReplay, encodeReplay, metaOf, type ReplayData } from './format'
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
  spectatorBets: true,
  bounties: true,
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
      step: (b, i, p, slots) => hook.step(b, i, p, slots),
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

  it('records dead-player wager commands and replays pool settlement, remainder bounty creation and stale resends exactly', async () => {
    // 3 wins; 4 and the bystander 5 burn in the lava (bets need 3+ warlocks alive when placed)
    const slots: PlayerSlot[] = [0, 1, 2, 3, 4, 5].map((id) => ({
      id, name: `Human ${id}`, kind: 'human', color: id, team: id, profileId: `profile:${id}`,
    }))
    const state = createMatch({ ...SETTINGS, shopSeconds: 0.1, winScore: 99, roundGold: 0 }, slots, 11)
    startRound(state)
    for (const id of [0, 1, 2]) killPawn(state, state.pawns[id], 3, 'fireball')
    // Real sim lava resolves the final contenders, so playback needs no custom sim implementation.
    for (const contender of [state.pawns[4], state.pawns[5]]) {
      contender.x = 100000
      contender.invulnerable = false
      contender.modifiers = []
      contender.hp = 100
    }
    const recorder = new ReplayRecorder()
    recorder.begin({ localPlayer: 1, slots, settings: state.settings, seed: 11 })
    const hashes = new Map([[state.tick, replayHash(state)]])
    const wagers: PlayerInput[] = [0, 1, 2].map((player) => ({
      player, tick: 0, cmds: [{ kind: 'spectateBet', round: 1, target: player < 2 ? 3 : 4 }],
    }))
    for (let tick = 0; tick < 300; tick++) {
      const inputs = tick === 0 || tick === 1 || tick === 220 ? wagers : []
      recorder.step(state, inputs)
      step(state, inputs)
      recorder.observe(state, state.events)
      hashes.set(state.tick, replayHash(state))
    }
    expect(state.round).toBe(2)
    expect(state.betting.lastSettlement).toMatchObject({ round: 1, bountyAdded: 1 })
    expect(state.scores.slice(0, 3).map((s) => s.gold)).toEqual([30, 30, 29])
    const replay = recorder.finish('spectator-betting', NET_ID, [])!
    const decoded = (await decodeReplay(await encodeReplay(replay)))!
    expect(decoded.steps[0][1][0][1]).toEqual([{ kind: 'spectateBet', round: 1, target: 3 }])
    expect(decoded.resyncs).toEqual([])
    const player = new ReplayPlayer(decoded, NET_ID)
    while (!player.done) {
      player.stepOnce()
      expect(replayHash(player.state)).toBe(hashes.get(player.tick))
    }
    expect(player.state.betting).toEqual(state.betting)
    for (const tick of [1, 80, 0, replay.endTick, 20, replay.endTick]) {
      player.seek(tick)
      expect(replayHash(player.state)).toBe(hashes.get(tick))
    }
    expect(player.desync).toBeNull()
  })

  it('replays an empty-seat entrant with exact pawn, economy and seek state', async () => {
    const slots: PlayerSlot[] = [0, 1].map((id) => ({ id, name: `Player ${id}`, color: id + 1, team: id, kind: 'human' }))
    const state = createMatch(SETTINGS, slots, 11)
    const entrant: PlayerSlot = { id: 2, name: 'Late', color: 3, team: 2, kind: 'human', profileId: 'profile-late' }
    const recorder = new ReplayRecorder()
    recorder.begin({ localPlayer: 0, slots, settings: state.settings, seed: 11 })
    const hashes = new Map([[state.tick, replayHash(state)]])
    for (let tick = 0; tick < 90; tick++) {
      const added = tick === 20 ? [entrant] : undefined
      recorder.step(state, [], undefined, added)
      if (added) applyRosterChanges(state, added)
      step(state, [])
      recorder.observe(state, state.events)
      hashes.set(state.tick, replayHash(state))
    }
    const data = recorder.finish('late-entrant', NET_ID, [])!
    const player = new ReplayPlayer((await decodeReplay(await encodeReplay(data)))!, NET_ID)
    for (const tick of [20, 21, data.endTick, 0, 21, data.endTick]) {
      player.seek(tick)
      expect(replayHash(player.state)).toBe(hashes.get(tick))
      expect(player.state.pawns).toHaveLength(tick <= 20 ? 2 : 3)
    }
    expect(player.desync).toBeNull()
    expect(data.slots).toHaveLength(3)
  })

  it('retains stable profile IDs across a rename and uses the latest label only in replay summaries', async () => {
    const slots: PlayerSlot[] = [
      { id: 0, name: 'Before', color: 1, team: 0, kind: 'human', profileId: 'profile-stable-self' },
      { id: 1, name: 'Other', color: 2, team: 1, kind: 'human', profileId: 'profile-stable-other' },
    ]
    const state = createMatch(SETTINGS, slots, 11)
    const recorder = new ReplayRecorder()
    recorder.begin({ localPlayer: 0, slots, settings: state.settings, seed: 11 })
    for (let tick = 0; tick < 80; tick++) {
      const changed = tick === 20 ? [{ ...state.slots[0], name: 'After' }] : undefined
      recorder.step(state, [], undefined, changed)
      if (changed) state.slots = state.slots.map((s) => s.id === 0 ? changed[0] : s)
      step(state, [])
      recorder.observe(state, state.events)
    }
    const data = recorder.finish('renamed-match', NET_ID, [])!
    expect(data.start.slots[0]).toMatchObject({ name: 'Before', profileId: 'profile-stable-self' })
    expect(data.slots[0]).toMatchObject({ name: 'After', profileId: 'profile-stable-self' })
    expect(metaOf(data, 1).players[0]).toMatchObject({ id: 0, name: 'After' })
    const decoded = (await decodeReplay(await encodeReplay(data)))!
    const player = new ReplayPlayer(decoded, NET_ID)
    player.seek(20)
    expect(player.state.slots[0]).toMatchObject({ name: 'Before', profileId: 'profile-stable-self' })
    player.seek(21)
    expect(player.state.slots[0]).toMatchObject({ name: 'After', profileId: 'profile-stable-self' })
    player.seek(data.endTick)
    expect(replayHash(player.state)).toBe(replayHash(state))
    expect(player.desync).toBeNull()
  })

  it('replays a human taking over a bot, preserves slot patch metadata through shuffled teams, and seeks backward exactly', () => {
    const slots: PlayerSlot[] = [0, 1, 2, 3].map((id) => ({ id, name: `bot-${id}`, color: id, team: id, kind: 'bot', difficulty: 'hard' }))
    const state = createMatch({ ...SETTINGS, teamMode: 'shuffle', botsReplaceLeavers: true, winScore: 50 }, slots, 2)
    state.scores[1].connected = false // A bot holds the disconnected seat until takeover.
    const recorder = new ReplayRecorder()
    recorder.begin({ localPlayer: 0, slots, settings: state.settings, seed: 2 })
    const hashes = new Map([[state.tick, replayHash(state)]])
    const takeoverTick = 2
    const takeover: PlayerSlot = { ...state.slots[1], name: 'Late joiner', kind: 'human', difficulty: undefined, profileId: 'profile-late-joiner' }
    const recordedSlot = { ...takeover }
    for (let tick = 0; tick < KEYFRAME_EVERY + 20; tick++) {
      const inputs: PlayerInput[] = tick === takeoverTick + 1
        ? [{ player: takeover.id, tick, cmds: [{ kind: 'move', x: 300, y: 200 }] }]
        : []
      const changedSlots = tick === takeoverTick ? [takeover] : undefined
      const connections = tick === takeoverTick ? [[takeover.id, true] as const] : undefined
      recorder.step(state, inputs, connections, changedSlots)
      if (changedSlots) {
        state.slots = state.slots.map((slot) => slot.id === takeover.id ? { ...takeover } : slot)
        state.scores[1].connected = true
        // Session callers may reuse their patch objects after the recorder sees them.
        takeover.name = 'reused patch object'
        takeover.team = 999
      }
      step(state, inputs)
      recorder.observe(state, state.events)
      hashes.set(state.tick, replayHash(state))
    }
    // This seed changes the taken-over player's team at round start. Playback must not
    // let assignTeams mutate the slot object stored inside replay metadata.
    expect(state.slots[1].team).not.toBe(recordedSlot.team)
    const replay = recorder.finish('takeover', NET_ID, [])!
    expect(replay.resyncs).toEqual([])
    const patch = replay.steps.find(([tick]) => tick === takeoverTick)!
    expect(patch[1]).toEqual([]) // Takeover metadata is recorded without gameplay inputs.
    expect(patch[2]).toEqual([[takeover.id, 1]])
    expect(patch[3]).toEqual([recordedSlot])
    const metadata = JSON.stringify(replay.steps)
    const player = new ReplayPlayer(replay, NET_ID)
    while (!player.done) {
      player.stepOnce()
      expect(replayHash(player.state)).toBe(hashes.get(player.tick))
    }
    expect(player.state.slots[1]).toMatchObject({ kind: 'human', name: 'Late joiner', profileId: 'profile-late-joiner' })
    expect(player.desync).toBeNull()
    expect(JSON.stringify(replay.steps)).toBe(metadata)
    for (const tick of [1, takeoverTick + 1, KEYFRAME_EVERY, takeoverTick, 80, 0, replay.endTick]) {
      player.seek(tick)
      expect(player.tick).toBe(tick)
      expect(replayHash(player.state)).toBe(hashes.get(tick))
      expect(player.state.slots[1].kind).toBe(tick <= takeoverTick ? 'bot' : 'human')
      expect(player.state.scores[1].connected).toBe(tick > takeoverTick)
    }
    expect(player.desync).toBeNull()
    expect(JSON.stringify(replay.steps)).toBe(metadata)
  })

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
    // in the second before a checkpoint, the player who acted walks elsewhere instead (move
    // orders are absolute targets: an earlier detour can rejoin the recorded path before it)
    const checkpoint = 2 * HASH_EVERY
    const i = bad.steps.findIndex((s) => s[0] >= checkpoint - ticks(1) && s[1].length > 0)
    const t = bad.steps[i][0]
    const who = bad.steps[i][1][0][0]
    for (const s of bad.steps) if (s[0] >= t && s[0] < checkpoint) s[1] = [[who, [['m', 1500, 1500]]], ...s[1].filter(([p]) => p !== who)]
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
  /** Why: a client keeps the rate of the last room it joined; a replay must still play at the rate
   * it was recorded at, and a file without a rate this build runs is no replay. */
  it('records its simulation rate, plays at it and rejects a file without a supported rate', async () => {
    const d = recordDirect(3, 120)
    const recorded = TICK_HZ
    expect(d.hz).toBe(recorded)
    try {
      setTickRate(recorded === 30 ? 60 : 30)
      expect(new ReplayViewer(new ReplayLibrary(memoryBackend()), NET_ID).openData(d)).toBe('ready')
      expect(TICK_HZ).toBe(recorded)
    } finally {
      setTickRate(recorded)
    }
    expect(await decodeReplay(new TextEncoder().encode(JSON.stringify({ ...d, hz: 45 })))).toBeNull()
  })

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
