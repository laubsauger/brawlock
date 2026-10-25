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
 * - two or more humans: the match starts after startMs, counted from the second human's arrival
 * - one human: the match starts after fillMs
 * - casual lobbies can wait for more humans; any human Ready releases the hold
 * - arrivals reserve bot seats during a match and start playing next round;
 *   between matches they can also take free seats
 * - results: nothing moves by itself. The room goes on (casual: next match; ranked: back to its
 *   lobby) only once every human pressed Ready; nobody is ever pulled into a game they did not
 *   ready for. Players who do not want to wait take New game (another room) or leave.
 * - lobby: everyone Ready (and enough humans) cuts the countdown to READY_START_MS.
 * Ranked quick rooms prefill bots, require minHumans, and return to a fresh lobby
 * countdown between matches. A lone ranked player never starts against only bots.
 * Always: a match nobody is connected to goes back to the lobby.
 * Rooms that run themselves (quick play, ranked queues, `auto`) never carry an abandoned tab
 * into the next match: when a match ends, a human who did nothing during all of it (no input,
 * no chat, at least `idleRounds` complete rounds) goes back to the menu with a notice. Nobody
 * is removed during a match, however long the break; one input or chat line keeps the seat.
 * `onMatch` gets every finished match (the leaderboard, leaderboard.ts).
 * The same prediction, stamped inputs, snapshots and link monitor as P2P apply; the
 * server just never plays, so there is no host advantage to compensate.
 */
import type { LobbyView, MatchResult, Screen } from '../game/store'
import type { Bot } from '../bots'
import type { BotDifficulty, MatchSettings, PlayerId, PlayerInput, PlayerSlot, SimState } from '../sim/types'
import type { StartClock } from './clock'
import { MAX_PLAYERS, createSession, type MatchRecorder, type SessionDebug } from './session'
import { ServerMatchTracker, type FinishedMatch } from './leaderboard'
import type { NetStatsView } from './netstats'
import type { HostEndpoint, Transport } from './transport'
import { roomProgress, type RoomProgress } from './roomProgress'

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
  /** a ranked queue room: lobby-only admission, minimum humans, fresh countdowns */
  ranked?: boolean
  /** listed in the public room browser from the start (quick-play rooms always are) */
  public?: boolean
  /** every finished match, with the device ids of its human seats */
  onMatch?: (m: FinishedMatch, result: MatchResult) => void | Promise<void>
  onMatchStart?: MatchRecorder['start']
  onMatchAbort?: () => void
  /** ranked and quick play: the human-controlled combat of a match that ended without a result */
  onMatchActivity?: (m: FinishedMatch) => Promise<unknown>
  onMatchJoin?: (device: string) => void
  /** Pending connection reservations keep a transferring player's active match intact. */
  hasPendingConnections?: () => boolean
  /** Explicit server rating policy; absent when the caller supplies no policy. */
  elo?: { enabled: boolean; minSeconds: number }
  /** self-running rooms: at least this many complete rounds of a whole idle match before a human goes back to the menu (0: never; default IDLE_ROUNDS) */
  idleRounds?: number
  /** self-running rooms: a results screen nobody readied on closes after this long (default RESULTS_IDLE_MS) */
  resultsIdleMs?: number
  /** a connected device's display label, including lobby changes before the next match */
  onName?: (device: string, name: string) => void
  requireRankedAccount?: boolean
  log?: (msg: string) => void
}

export interface QuickPlayPolicy {
  /** one human waiting: the match starts after this long (with bots) */
  fillMs: number
  /** two or more humans: the match starts after this long */
  startMs: number
  /** unused since results wait for Ready (kept for configs that still set it) */
  nextMs: number
  /** humans per room, at most (quick play sends no more; MAX_PLAYERS caps it too) */
  seats: number
  /** bots top the table up to this many players when fewer humans are in */
  fill: number
  bots: BotDifficulty
  /** results nobody readied on close after this long (default RESULTS_IDLE_MS) */
  resultsIdleMs?: number
  /** the table's first bots, one each, before the rest use `bots` (default table only) */
  mix?: readonly BotDifficulty[]
  /** minimum humans before any countdown can start; casual quick play defaults to one */
  minHumans?: number
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
  progress?: RoomProgress | null
  quick: boolean
  ranked?: boolean
  teamMode: MatchSettings['teamMode']
  gameMode: MatchSettings['gameMode']
  winScore: number
  /** Scheduled ranked rounds before any tied-leader final; absent for score-race matches. */
  rankedRounds?: number
  /** Rating availability and minimum duration; never exposes device identities. */
  elo?: { enabled: boolean; minSeconds: number }
}

export interface RoomDeps {
  /** lossless stream peers get a packet every this many ticks (session.ts sendStream; default 1) */
  streamEvery?: number
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
  isRanked(): boolean
  hasProfile(profileId: string): boolean
  summary(): RoomSummary
  /** connected links (humans and spectators) */
  peers(): number
  screen(): Screen
  results(): MatchResult[]
  netStats(): NetStatsView | null
  setMaintenance(message: string | null): void
  debug(): SessionDebug
  settleDeparted(): Promise<void>
  close(): void
}

const AUTO_START_MS = 3000
const REMATCH_MS = 6000
const EMPTY_CHECK_MS = 1000
/** a whole match without touching anything, and never fewer rounds than this */
const IDLE_ROUNDS = 3
/** a quick or ranked lobby where every human pressed Ready starts this soon */
const READY_START_MS = 10_000
const IDLE_REASON = 'You were away for a whole game, so you left the room. Join again any time.'
/** results wait for Ready; a room left on its results this long closes (an abandoned tab, nobody playing) */
const RESULTS_IDLE_MS = 30 * 60_000
const RESULTS_IDLE_REASON = 'The results stayed open for a long time, so you left the room. Join again any time.'

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
  /** when the room entered its results screen (null: elsewhere) */
  let resultsSince: number | null = null
  let progress: RoomProgress | null = null
  const results: MatchResult[] = []
  let accept: ((t: Transport) => void) | null = null
  const backlog: Transport[] = []
  let startTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let maintenance: string | null = null

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
  const readyHumans = () => lobby.slots.filter((s) => s.kind === 'human' && lobby.ready?.[s.id]).length
  const tracker = opts.onMatch ? new ServerMatchTracker(opts.onMatch, opts.onName, { partial: opts.ranked === true || !!opts.quick, onAbort: opts.onMatchActivity }) : undefined

  const session = createSession({
    ui: {
      lobby: () => lobby,
      setLobby: (p) => {
        const before = humans()
        const readyBefore = readyHumans()
        const waitingBefore = (lobby.waitingForPlayers ?? []).join(',')
        lobby = { ...lobby, ...p }
        if (humans() !== before) {
          log(`room ${opts.code}: ${humans()} human(s)`)
          schedule()
        } else if ((p.ready && readyHumans() !== readyBefore) || (lobby.waitingForPlayers ?? []).join(',') !== waitingBefore) schedule()
      },
      screen: () => screen,
      setScreen: (s) => {
        if (s !== screen) resultsSince = s === 'results' ? deps.now() : null
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
    frame: { reset() { progress = null }, setLocalPlayer() {}, pushState(state) { progress = roomProgress(state) }, pushEvents() {}, setNet() {} },
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
    streamEvery: deps.streamEvery,
    now: deps.now,
    random: deps.random,
    joinUrl: (code) => code,
    clientKey: () => 'dedicated-server',
    netMode: () => 'predict',
    build: deps.build,
    requireRankedAccount: opts.requireRankedAccount,
    ...(tracker ? { recorder: {
      start: (info) => { tracker.start(info); opts.onMatchStart?.(info) },
      observe: (state, events) => tracker.observe(state, events),
      finish: (result) => tracker.finish(result),
      abort: () => { tracker.abort(); opts.onMatchAbort?.() },
      control: (player, by) => tracker.control(player, by),
      join: (slot, device) => { tracker.join(slot, device); if (device) opts.onMatchJoin?.(device) },
      displayName: (slot, device) => tracker.displayName(slot, device),
    } satisfies MatchRecorder } : {}),
  })
  const quick = opts.quick ?? null

  /** Lobby with humans: count down to a match. Results: rematch. Nobody left: idle. */
  function schedule(): void {
    if (maintenance) return
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
    if (closed || maintenance || screen !== 'lobby' || humans() === 0) return
    const bots = lobby.slots.filter((s) => s.kind === 'bot').length
    for (let i = bots; i < opts.bots.length; i++) session.addBot(opts.bots[i])
    if (opts.settings) session.updateSettings(opts.settings)
    log(`room ${opts.code}: match starts (${humans()} human, ${opts.bots.length} bot)`)
    session.startMatch()
  }

  function rematch(): void {
    startTimer = null
    if (closed || maintenance || screen !== 'results') return
    session.backToLobby()
    if (humans() > 0) session.startMatch()
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
    // shown in the lobby, and on the results screen as the Ready grace countdown
    session.setRoom({ auto: at === null || screen === 'match' ? null : { inMs: Math.max(0, at - deps.now()), fill } })
  }

  /** wall ms per session ms (tests run the session clock faster than the wall clock) */
  function timeScale(): number {
    return deps.timeScale ?? 1
  }

  function scheduleQuick(): void {
    if (closed || maintenance || !quick) return
    const n = humans()
    const waiting = lobby.waitingForPlayers ?? []
    const activeWaiting = waiting.filter((id) => lobby.slots.some((s) => s.id === id && s.kind === 'human'))
    if (waiting.length && (screen !== 'lobby' || readyHumans() > 0 || activeWaiting.length !== waiting.length)) {
      // Updating the authoritative room state schedules again with the cleared/pruned requests.
      session.setRoom({ waiting: screen === 'lobby' && readyHumans() === 0 ? activeWaiting : [] })
      return
    }
    if (opts.ranked && screen === 'results') {
      // The result stays up until every human pressed Ready; then back to the ranked lobby,
      // the queue for the next game.
      if (n === 0 || readyHumans() < n) {
        if (quickAt !== null) setQuickTimer(null, false)
        return
      }
      if (quickAt === null) setQuickTimer(deps.now() + READY_START_MS, false)
      return
    }
    // Ranked players can see the full bot table while waiting for another human.
    if (screen === 'lobby' || screen === 'results') rebalance(opts.ranked === true)
    if (n === 0) {
      if (quickAt !== null) setQuickTimer(null, false)
      return
    }
    const now = deps.now()
    if (screen === 'lobby') {
      if (!opts.ranked && activeWaiting.length > 0) {
        if (quickAt !== null) setQuickTimer(null, false)
        return
      }
      if (n < (quick.minHumans ?? 1)) {
        if (quickAt !== null) setQuickTimer(null, false)
        return
      }
      if (n >= 2) {
        // a second human replaces the solo countdown with the full startMs (more time for others to
        // join; Ready cuts it short); later arrivals never lengthen it
        const at = now + quick.startMs
        if (quickAt === null || quickFill) setQuickTimer(at, false)
        else if (at < quickAt) setQuickTimer(at, false)
      } else if (quickAt === null) setQuickTimer(now + quick.fillMs, true)
      // everyone ready: no need to sit out the rest of the countdown
      const soon = now + READY_START_MS
      if (readyHumans() >= n && quickAt !== null && quickAt > soon) setQuickTimer(soon, quickFill)
    } else if (screen === 'results') {
      // the next match only once every human pressed Ready
      if (readyHumans() >= n) {
        if (quickAt === null) setQuickTimer(now + READY_START_MS, false)
      } else if (quickAt !== null) setQuickTimer(null, false)
    } else if (quickAt !== null && screen === 'match') setQuickTimer(null, false)
  }

  function quickFire(): void {
    startTimer = null
    quickAt = null
    if (closed || maintenance || !quick || session.debug().peers === 0) return
    if (screen === 'results' && readyHumans() < humans()) { session.setRoom({ auto: null }); return }
    if (opts.ranked && screen === 'results') {
      session.backToLobby()
      if (quickAt === null) session.setRoom({ auto: null })
      return
    }
    if (humans() < (quick.minHumans ?? 1)) return
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
    if (!add) return
    // the mix seats first (one each), the rest use the table's level; trimming above removes
    // the newest bots first, so the mix stays seated longest
    const have = new Map<BotDifficulty, number>()
    for (const b of bots.slice(0, want)) if (b.difficulty) have.set(b.difficulty, (have.get(b.difficulty) ?? 0) + 1)
    for (let i = bots.length; i < want; i++) {
      const pick = (quick.mix ?? []).find((d) => {
        const need = (quick.mix ?? []).filter((x) => x === d).length
        return (have.get(d) ?? 0) < need
      }) ?? quick.bots
      have.set(pick, (have.get(pick) ?? 0) + 1)
      session.addBot(pick)
    }
  }

  let departureSettlement: Promise<void> | null = null
  function settleDeparted(): Promise<void> {
    if (departureSettlement) return departureSettlement
    if (session.debug().peers > 0 || opts.hasPendingConnections?.()) return Promise.resolve()
    departureSettlement = session.finishDeparted().then(() => {
      if (!closed && session.debug().peers === 0 && screen === 'results') session.backToLobby()
    }).finally(() => { departureSettlement = null })
    return departureSettlement
  }

  const idleRounds = quick || opts.auto ? (opts.idleRounds ?? IDLE_ROUNDS) : 0
  const resultsIdleMs = quick || opts.auto ? (quick?.resultsIdleMs ?? opts.resultsIdleMs ?? RESULTS_IDLE_MS) : 0

  // a match nobody watches anymore goes back to the lobby; between matches, idle humans go back to the menu
  const empty = setInterval(() => {
    if (closed) return
    if (resultsIdleMs > 0 && screen === 'results' && resultsSince !== null && deps.now() - resultsSince >= resultsIdleMs) {
      const left = lobby.slots.filter((s) => s.kind === 'human').map((s) => s.id)
      resultsSince = null
      if (left.length) log(`room ${opts.code}: results open ${Math.round(resultsIdleMs / 60_000)} min, ${left.length} human(s) back to the menu`)
      for (const id of left) session.dropIdle(id, RESULTS_IDLE_REASON)
      return
    }
    const d = session.debug()
    if (screen === 'match' && d.peers === 0 && !opts.hasPendingConnections?.()) {
      log(`room ${opts.code}: empty, back to the lobby`)
      void settleDeparted()
      return
    }
    if (idleRounds <= 0 || screen === 'match') return
    const idle = session.idleHumans(idleRounds)
    if (idle.length === 0) return
    log(`room ${opts.code}: ${idle.length} idle human(s) back to the menu`)
    for (const id of idle) session.dropIdle(id, IDLE_REASON)
  }, EMPTY_CHECK_MS)

  await session.openHost({ dedicated: true })
  if ((quick || opts.ranked) && opts.settings) session.updateSettings(opts.settings)
  if (quick || opts.public) session.setRoom({ quick: !!quick, ranked: opts.ranked === true, public: true, cap: quick ? quick.seats : null })

  const joinableSeats = () => opts.ranked && screen === 'match' ? 0 : session.joinableSeats()

  return {
    code: opts.code,
    accept(t) {
      if (accept) accept(t)
      else backlog.push(t)
    },
    humans,
    seats: () => lobby.slots.length,
    joinableSeats,
    isPublic: () => session.roomState().public,
    isQuick: () => !!quick,
    isRanked: () => opts.ranked === true,
    hasProfile: (profileId) => lobby.slots.some((slot) => slot.kind === 'human' && slot.profileId === profileId),
    summary() {
      const st = lobby.settings ?? deps.defaultSettings
      const ownerSlot = quick ? null : lobby.slots.find((x) => x.kind === 'human')
      return {
        code: opts.code,
        host: ownerSlot?.name ?? null,
        humans: humans(),
        bots: lobby.slots.length - humans(),
        max: lobby.maxPlayers ?? MAX_PLAYERS,
        joinable: joinableSeats(),
        phase: screen,
        progress: screen === 'match' || screen === 'results' ? progress : null,
        quick: !!quick,
        ...(opts.ranked !== undefined ? { ranked: opts.ranked } : {}),
        teamMode: st.teamMode,
        gameMode: st.gameMode,
        winScore: st.winScore,
        ...(st.rankedRounds ? { rankedRounds: st.rankedRounds } : {}),
        ...(opts.elo ? { elo: { ...opts.elo } } : {}),
      }
    },
    peers: () => session.debug().peers,
    screen: () => screen,
    results: () => results,
    netStats: () => session.netStats(),
    setMaintenance(message) {
      maintenance = message
      if (startTimer) clearTimeout(startTimer)
      startTimer = null; quickAt = null
      session.setRoom({ maintenance: message, auto: null })
      if (!message) schedule()
    },
    debug: () => session.debug(),
    settleDeparted,
    close() {
      closed = true
      if (startTimer) clearTimeout(startTimer)
      clearInterval(empty)
      session.leave()
    },
  }
}
