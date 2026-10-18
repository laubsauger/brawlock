/**
 * Dedicated server room (M4.1, docs/M4.md): the normal host session (session.ts,
 * dedicated mode: no seat of its own) with headless ports. The first connected human
 * owns the room and drives it with the host's lobby controls (`ctl`). Optional auto
 * policy (`auto`, for the CLI and tests) for rooms without anyone clicking Start:
 * - the first human to join starts a countdown (autoStartMs); the match runs with the
 *   configured bots and settings
 * - results: a rematch follows after rematchMs while humans are connected
 * Quick-play rooms (`quick`, M4.3) are public and have no owner; the server runs them.
 * Up to `seats` humans (10); bots top the table up to `fill` players (10) when fewer:
 * - two or more humans: the match starts after startMs
 * - one human: the match starts after fillMs
 * - arrivals reserve bot seats during a match and start playing next round;
 *   between matches they can also take free seats
 * - results: after nextMs the next match starts
 * Always: a match nobody is connected to goes back to the lobby.
 * `onMatch` gets every finished match (the leaderboard, leaderboard.ts).
 * The same prediction, stamped inputs, snapshots and link monitor as P2P apply; the
 * server just never plays, so there is no host advantage to compensate.
 */
import type { LobbyView, MatchResult, Screen } from '../game/store'
import type { Bot } from '../bots'
import type { BotDifficulty, MatchSettings, PlayerId, PlayerInput, PlayerSlot, SimState } from '../sim/types'
import type { StartClock } from './clock'
import { MAX_PLAYERS, createSession, type SessionDebug } from './session'
import { ServerMatchTracker, type FinishedMatch } from './leaderboard'
import type { NetStatsView } from './netstats'
import type { HostEndpoint, Transport } from './transport'

export interface RoomOptions {
  /** 5-letter room code (code.ts) */
  code: string
  bots: BotDifficulty[]
  settings?: Partial<MatchSettings>
  /** start matches and rematches by themselves (CLI demo rooms, tests); owner rooms do not */
  auto?: boolean
  /** first human joined → match starts after this long */
  autoStartMs?: number
  /** results → rematch after this long */
  rematchMs?: number
  /** a quick-play room (public, no owner, runs itself) */
  quick?: QuickPlayPolicy
  /** listed in the public room browser from the start (quick-play rooms always are) */
  public?: boolean
  /** every finished match, with the device ids of its human seats */
  onMatch?: (m: FinishedMatch, result: MatchResult) => void
  /** Explicit server rating policy; absent when the caller supplies no policy. */
  elo?: { enabled: boolean; minSeconds: number }
  /** a connected device's display label, including lobby changes before the next match */
  onName?: (device: string, name: string) => void
  log?: (msg: string) => void
}

export interface QuickPlayPolicy {
  /** one human waiting: the match starts after this long (with bots) */
  fillMs: number
  /** two or more humans: the match starts after this long */
  startMs: number
  /** results: the next match starts after this long */
  nextMs: number
  /** humans per room, at most (quick play sends no more; MAX_PLAYERS caps it too) */
  seats: number
  /** bots top the table up to this many players when fewer humans are in */
  fill: number
  bots: BotDifficulty
}

/** One line of the public room browser (GET /rooms?public=1). */
export interface RoomSummary {
  code: string
  /** the owner's name; null for quick-play rooms */
  host: string | null
  humans: number
  bots: number
  max: number
  /** available seats, including unclaimed bots playable next round; absent on player-hosted listings */
  joinable?: number
  phase: Screen
  quick: boolean
  teamMode: MatchSettings['teamMode']
  gameMode: MatchSettings['gameMode']
  winScore: number
  /** Rating availability and minimum duration; never exposes device identities. */
  elo?: { enabled: boolean; minSeconds: number }
}

export interface RoomDeps {
  createMatch: (settings: MatchSettings, slots: PlayerSlot[], seed: number) => SimState
  step: (state: SimState, inputs: PlayerInput[]) => void
  createBot: (player: PlayerId, difficulty: BotDifficulty, seed: number) => Bot
  defaultSettings: MatchSettings
  startClock: StartClock
  now: () => number
  random: () => number
  /** this server's build id (welcome, version check) */
  build?: string
  /** tests: `now` runs this many times faster than the wall clock (room timers scale with it) */
  timeScale?: number
}

export interface Room {
  readonly code: string
  /** a client's link (one accepted socket) */
  accept(t: Transport): void
  /** humans in the lobby */
  humans(): number
  /** seats taken (humans and bots) */
  seats(): number
  /** seats a new human can take, including bot reservations for the next round */
  joinableSeats(): number
  isPublic(): boolean
  isQuick(): boolean
  summary(): RoomSummary
  /** connected links (humans and spectators) */
  peers(): number
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
    build: deps.build,
    ...(opts.onMatch ? { recorder: new ServerMatchTracker((m, result) => opts.onMatch!(m, result), opts.onName) } : {}),
  })
  const quick = opts.quick ?? null

  /** Lobby with humans: count down to a match. Results: rematch. Nobody left: idle. */
  function schedule(): void {
    if (quick) {
      scheduleQuick()
      return
    }
    if (closed || !opts.auto) return
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

  // ---- quick play ------------------------------------------------------------------
  let quickAt: number | null = null
  let quickFill = false

  function setQuickTimer(at: number | null, fill: boolean): void {
    if (startTimer) clearTimeout(startTimer)
    startTimer = null
    quickAt = at
    quickFill = fill
    if (at !== null) startTimer = setTimeout(quickFire, Math.max(0, at - deps.now()) / timeScale())
    session.setRoom({ auto: at === null || screen !== 'lobby' ? null : { inMs: Math.max(0, at - deps.now()), fill } })
  }

  /** wall ms per session ms (tests run the session clock faster than the wall clock) */
  function timeScale(): number {
    return deps.timeScale ?? 1
  }

  function scheduleQuick(): void {
    if (closed || !quick) return
    const n = humans()
    if (n === 0) {
      if (quickAt !== null) setQuickTimer(null, false)
      return
    }
    const now = deps.now()
    // between matches a newcomer replaces a bot at once (the seat count stays the table size)
    if (screen === 'lobby' || screen === 'results') rebalance(false)
    if (screen === 'lobby') {
      if (n >= 2) {
        const at = now + quick.startMs
        if (quickAt === null || quickFill || at < quickAt) setQuickTimer(quickAt !== null && !quickFill ? Math.min(quickAt, at) : at, false)
      } else if (quickAt === null) setQuickTimer(now + quick.fillMs, true)
    } else if (screen === 'results') {
      if (quickAt === null) setQuickTimer(now + quick.nextMs, false)
    } else if (quickAt !== null && screen === 'match') setQuickTimer(null, false)
  }

  function quickFire(): void {
    startTimer = null
    quickAt = null
    if (closed || !quick || humans() === 0 || session.debug().peers === 0) return
    if (screen === 'results') session.backToLobby()
    else if (screen !== 'lobby') return
    rebalance(true)
    if (opts.settings) session.updateSettings(opts.settings)
    session.setRoom({ auto: null })
    log(`room ${opts.code}: quick match starts (${humans()} human, ${lobby.slots.length - humans()} bot)`)
    session.startMatch()
  }

  /** Bots for the next match: the table topped up to `fill` players (`add`: false only trims). */
  function rebalance(add: boolean): void {
    if (!quick) return
    const want = Math.max(0, Math.min(quick.fill, MAX_PLAYERS) - humans())
    const bots = lobby.slots.filter((s) => s.kind === 'bot')
    for (const b of bots.slice(want)) session.removeSlot(b.id)
    if (add) for (let i = bots.length; i < want; i++) session.addBot(quick.bots)
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
  if (quick || opts.public) session.setRoom({ quick: !!quick, public: true, cap: quick ? quick.seats : null })

  return {
    code: opts.code,
    accept(t) {
      if (accept) accept(t)
      else backlog.push(t)
    },
    humans,
    seats: () => lobby.slots.length,
    joinableSeats: () => session.joinableSeats(),
    isPublic: () => session.roomState().public,
    isQuick: () => !!quick,
    summary() {
      const st = lobby.settings ?? deps.defaultSettings
      const ownerSlot = quick ? null : lobby.slots.find((x) => x.kind === 'human')
      return {
        code: opts.code,
        host: ownerSlot?.name ?? null,
        humans: humans(),
        bots: lobby.slots.length - humans(),
        max: quick ? Math.min(quick.seats, MAX_PLAYERS) : MAX_PLAYERS,
        joinable: session.joinableSeats(),
        phase: screen,
        quick: !!quick,
        teamMode: st.teamMode,
        gameMode: st.gameMode,
        winScore: st.winScore,
        ...(opts.elo ? { elo: { ...opts.elo } } : {}),
      }
    },
    peers: () => session.debug().peers,
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
