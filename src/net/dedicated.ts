/**
 * Dedicated server room (M4 prototype, docs/M4.md): the normal host session
 * (session.ts, dedicated mode: no seat of its own) with headless ports, plus a tiny
 * room policy because nobody sits at the host to click Start:
 * - the first human to join starts a countdown (autoStartMs); the match runs with the
 *   configured bots and settings
 * - results: a rematch follows after rematchMs while humans are connected
 * - everyone gone: back to the lobby, idle until the next join
 * The same prediction, stamped inputs, snapshots and link monitor as P2P apply; the
 * server just never plays, so there is no host advantage to compensate.
 */
import type { LobbyView, MatchResult, Screen } from '../game/store'
import type { Bot } from '../bots'
import type { BotDifficulty, MatchSettings, PlayerId, PlayerInput, PlayerSlot, SimState } from '../sim/types'
import type { StartClock } from './clock'
import { createSession, type SessionDebug } from './session'
import type { NetStatsView } from './netstats'
import type { HostEndpoint, Transport } from './transport'

export interface RoomOptions {
  /** 5-letter room code (code.ts) */
  code: string
  bots: BotDifficulty[]
  settings?: Partial<MatchSettings>
  /** first human joined → match starts after this long */
  autoStartMs?: number
  /** results → rematch after this long */
  rematchMs?: number
  log?: (msg: string) => void
}

export interface RoomDeps {
  createMatch: (settings: MatchSettings, slots: PlayerSlot[], seed: number) => SimState
  step: (state: SimState, inputs: PlayerInput[]) => void
  createBot: (player: PlayerId, difficulty: BotDifficulty, seed: number) => Bot
  defaultSettings: MatchSettings
  startClock: StartClock
  now: () => number
  random: () => number
}

export interface Room {
  readonly code: string
  /** a client's link (one accepted socket) */
  accept(t: Transport): void
  /** humans in the lobby */
  humans(): number
  screen(): Screen
  results(): MatchResult[]
  netStats(): NetStatsView | null
  debug(): SessionDebug
  close(): void
}

const AUTO_START_MS = 3000
const REMATCH_MS = 6000
const EMPTY_CHECK_MS = 1000

export async function createRoom(opts: RoomOptions, deps: RoomDeps): Promise<Room> {
  const log = opts.log ?? (() => {})
  let lobby: LobbyView = {
    role: 'host',
    joinUrl: null,
    roomCode: null,
    status: 'idle',
    error: null,
    slots: [],
    settings: null,
    localPlayer: -1,
    pings: {},
    ready: {},
  }
  let screen: Screen = 'menu'
  const results: MatchResult[] = []
  let accept: ((t: Transport) => void) | null = null
  const backlog: Transport[] = []
  let startTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const endpoint: HostEndpoint = {
    id: opts.code,
    onConnection(cb) {
      accept = cb
      for (const t of backlog.splice(0)) cb(t)
    },
    close() {
      accept = null
    },
  }

  const humans = () => lobby.slots.filter((s) => s.kind === 'human').length

  const session = createSession({
    ui: {
      lobby: () => lobby,
      setLobby: (p) => {
        const before = humans()
        lobby = { ...lobby, ...p }
        if (humans() !== before) {
          log(`room ${opts.code}: ${humans()} human(s)`)
          schedule()
        }
      },
      screen: () => screen,
      setScreen: (s) => {
        screen = s
        schedule()
      },
      setResult: (r) => {
        if (r) results.push(r)
      },
      paused: () => false,
      onScreen: () => () => {},
    },
    profile: () => ({ id: 'dedicated-server', name: 'Server', color: null }),
    frame: { reset() {}, setLocalPlayer() {}, pushState() {}, pushEvents() {}, setNet() {} },
    input: { drain: () => [] },
    audio: { playEvents() {} },
    createMatch: deps.createMatch,
    step: deps.step,
    createBot: deps.createBot,
    defaultSettings: deps.defaultSettings,
    net: {
      host: async () => endpoint,
      join: () => Promise.reject(new Error('a room does not join')),
    },
    startClock: deps.startClock,
    now: deps.now,
    random: deps.random,
    joinUrl: (code) => code,
    clientKey: () => 'dedicated-server',
    netMode: () => 'predict',
  })

  /** Lobby with humans: count down to a match. Results: rematch. Nobody left: idle. */
  function schedule(): void {
    if (closed) return
    if (startTimer) clearTimeout(startTimer)
    startTimer = null
    const n = humans()
    if (n === 0) return
    if (screen === 'lobby') startTimer = setTimeout(start, opts.autoStartMs ?? AUTO_START_MS)
    else if (screen === 'results') startTimer = setTimeout(rematch, opts.rematchMs ?? REMATCH_MS)
  }

  function start(): void {
    startTimer = null
    if (closed || screen !== 'lobby' || humans() === 0) return
    const bots = lobby.slots.filter((s) => s.kind === 'bot').length
    for (let i = bots; i < opts.bots.length; i++) session.addBot(opts.bots[i])
    if (opts.settings) session.updateSettings(opts.settings)
    log(`room ${opts.code}: match starts (${humans()} human, ${opts.bots.length} bot)`)
    session.startMatch()
  }

  function rematch(): void {
    startTimer = null
    if (closed || screen !== 'results') return
    if (humans() === 0) session.backToLobby()
    else session.rematch()
  }

  // a match nobody watches anymore goes back to the lobby
  const empty = setInterval(() => {
    if (closed) return
    const d = session.debug()
    if (screen === 'match' && d.peers === 0) {
      log(`room ${opts.code}: empty, back to the lobby`)
      session.backToLobby()
    }
  }, EMPTY_CHECK_MS)

  await session.openHost({ dedicated: true })

  return {
    code: opts.code,
    accept(t) {
      if (accept) accept(t)
      else backlog.push(t)
    },
    humans,
    screen: () => screen,
    results: () => results,
    netStats: () => session.netStats(),
    debug: () => session.debug(),
    close() {
      closed = true
      if (startTimer) clearTimeout(startTimer)
      clearInterval(empty)
      session.leave()
    },
  }
}
