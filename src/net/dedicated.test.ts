/**
 * The dedicated server prototype end to end: a real local server (server/listen.mjs,
 * real TCP WebSocket) and a headless client session in predict mode joining its room
 * through wsNet, like a browser with `?server=ws://...`. Real timers: real sockets.
 * Both sides run their session clocks TIME_SCALE× faster than wall time (same code
 * paths, the match just finishes in a few seconds).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { LobbyView, MatchResult, Screen } from '../game/store'
import { createBot } from '../bots'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import type { SimState } from '../sim/types'
import { startServer, type DedicatedServer } from '../../server/listen.mjs'
import { startClock } from './clock'
import { createSession } from './session'
import { wsNet } from './ws'

const TIME_SCALE = 4
let server: DedicatedServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const until = async (pred: () => boolean, ms: number, what: string) => {
  const t0 = performance.now()
  while (!pred()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** A headless client: the real session in predict mode; a bot plays its seat from the predicted view. */
function headlessClient(url: string, timeScale = 1) {
  let lobby = { role: 'offline', joinUrl: null, roomCode: null, status: 'idle', error: null, slots: [], settings: null, localPlayer: 0, pings: {}, ready: {} } as LobbyView
  let screen: Screen = 'menu'
  let shown: SimState | null = null
  let localPlayer = -1
  const results: MatchResult[] = []
  let bot: ReturnType<typeof createBot> | null = null
  let thought = -1
  const session = createSession({
    ui: {
      lobby: () => lobby,
      setLobby: (p) => {
        lobby = { ...lobby, ...p }
      },
      screen: () => screen,
      setScreen: (s) => {
        screen = s
      },
      setResult: () => {},
      paused: () => false,
      onScreen: () => () => {},
    },
    profile: () => ({ id: 'profile-headless', name: 'Headless', color: null }),
    recorder: {
      start: (info) => {
        localPlayer = info.localPlayer
        bot = localPlayer >= 0 ? createBot(localPlayer, 'hard', 99) : null
        thought = -1
      },
      observe: () => {},
      finish: (r) => {
        results.push(r)
      },
      abort: () => {},
    },
    frame: {
      reset: () => {
        shown = null
      },
      setLocalPlayer: () => {},
      pushState: (s) => {
        shown = s
      },
      pushEvents: () => {},
      setNet: () => {},
    },
    // bots think once per tick
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
    net: wsNet(url),
    startClock: (onPulse) => startClock((t) => onPulse(t * timeScale)),
    random: Math.random,
    joinUrl: (c) => c,
    clientKey: () => 'headless-key',
    netMode: () => 'predict',
    now: () => performance.now() * timeScale,
  })
  return { session, lobby: () => lobby, screen: () => screen, results, shown: () => shown, localPlayer: () => localPlayer }
}

describe('dedicated server prototype', () => {
  /**
   * Why: M4 runs the same session as P2P on a server. A client must be able to join a
   * server room over WebSocket, be seated (the server takes no seat), play a full match
   * with prediction against the server's authority and the server's bots, and agree on
   * the result, with no desync.
   */
  it('a headless client completes a match against the local server', async () => {
    server = await startServer({
      port: 0,
      bots: ['brutal'],
      // short and deadly so a full match takes seconds
      settings: { winScore: 1, shopSeconds: 1, lavaDps: 400, dmgMultiplier: 2, kbMultiplier: 1.6 },
      autoStartMs: 200,
      rematchMs: 60000,
      timeScale: TIME_SCALE,
      log: () => {},
    })
    const room = await server.room('ABCDE')
    const client = headlessClient(`ws://127.0.0.1:${server.port}`, TIME_SCALE)
    await client.session.join('ABCDE')
    expect(client.lobby().status).toBe('open')
    // seat 0: the dedicated server has none of its own
    expect(client.lobby().localPlayer).toBe(0)

    await until(() => client.screen() === 'match', 5000, 'the match to start')
    expect(client.session.debug().netMode).toBe('predict')
    const t0 = performance.now()
    let ahead = 0
    const probe = setInterval(() => (ahead = Math.max(ahead, client.session.debug().predictAhead)), 250)
    await until(() => client.screen() === 'results', 50000, 'the match to finish').finally(() => clearInterval(probe))
    // the client really predicted (ran ahead of the server's snapshots)
    expect(ahead).toBeGreaterThan(0)

    expect(client.results).toHaveLength(1)
    expect(room.results()).toHaveLength(1)
    expect(client.results[0]).toEqual(room.results()[0])
    expect(client.results[0].winners.length).toBeGreaterThan(0)
    expect(client.results[0].slots.map((s) => s.kind).sort()).toEqual(['bot', 'human'])
    console.log(`[dedicated] match of ${client.results[0].ticks} ticks in ${((performance.now() - t0) / 1000).toFixed(1)} s wall (${TIME_SCALE}× sim speed)`)
    const link = client.session.netStats()!.peers[0]
    expect(link.channel).toBe('reliable')
    expect(link.desyncs ?? 0).toBe(0)
    const hostView = room.netStats()!.peers.find((p) => p.playerId === 0)!
    expect(hostView.rttMs).not.toBeNull()
    client.session.leave()
  }, 60000)

  it('rejects a bad room path and keeps serving', async () => {
    server = await startServer({ port: 0, bots: [], log: () => {} })
    const bad = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/not-a-code`)
      ws.onopen = () => resolve('open')
      ws.onerror = () => resolve('error')
    })
    expect(bad).toBe('error')
    const ok = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/QWERT`)
      ws.onopen = () => {
        ws.close()
        resolve('open')
      }
      ws.onerror = () => resolve('error')
    })
    expect(ok).toBe('open')
  })
})
