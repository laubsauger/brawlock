/**
 * Session contract: owns the running lobby / match for every role.
 * - offline: local sim loop, local player + bots
 * - host: local sim loop, remote players via net, bots
 * - client: sends inputs, receives snapshots
 * UI calls these functions; state for UI goes to the zustand store (lobby, screen)
 * and per-frame data goes to game/frame.ts.
 * Owned by the net workstream; signatures are the contract.
 *
 * Implementation: src/net/session.ts (createSession). This file wires the real
 * store, frame buffer, input, audio, sim, bots and PeerJS into it.
 *
 * Errors never reject: openHost / openHostServer / join resolve and report failures
 * through lobby.status = 'error' + lobby.error, with screen 'menu'; the host calls also
 * resolve a typed HostResult.
 */
import { audio } from '../audio'
import { createBot } from '../bots'
import { startClock } from '../net/clock'
import { codeFromSearch } from '../net/code'
import { createPeerNet, joinUrlFor, peerNet } from '../net/peer'
import { serverUrlFrom, wsNet } from '../net/ws'
import { Online, ServerError, hybridNet, parseRegions, type LeaderboardPage, type RegionChoice, type RegionStatus, type ServerFailure, type ServerProfile, type ServerRegion } from '../net/online'
import type { Period } from '../net/leaderboard'
import type { BotDifficulty } from '../sim/types'
import { getDeviceId } from './device'
import { Lister, p2pListingTarget, type ListerState } from '../net/lister'
import { RejoinController, type RoomRoute } from '../net/rejoin'
import { MAX_PLAYERS } from '../net/session'
import { createSession, type MatchRecorder, type NetMode, type SessionApi } from '../net/session'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import { frame, pushEvents, pushState, resetFrame } from './frame'
import { input } from './input'
import { getProfile, safeLocalStorage, setPreferredColor } from './profile'
import { localEquipment } from './wardrobe'
import { isPlaySupported, PLAY_REQUIREMENT } from './playAccess'
import { clearPendingRoom } from '../lib/pendingRoom'
import { BUILD_UPDATE_REQUIRED, ensureCurrentBuild, getBuildUpdate, onBuildUpdate } from '../lib/buildVersion'
import { MatchTracker, recordMatch, recordUnfinishedMatch, updateProfileNames } from './stats'
import type { HistoryQueue, MatchHistoryEntry, GlobalMatchEntry } from '../net/leaderboard'
export type { HistoryQueue, MatchHistoryEntry, GlobalMatchEntry } from '../net/leaderboard'
import { createReplayHook } from './replay/hook'
import { useGame } from './store'
import { getAdmissionToken, saveAccountColor } from './account'
import { useAccount } from './accountState'
import { accountRatingKey } from '../net/accounts'
import { startPractice, stopPractice } from './practice'
import { clientKey } from './clientKey'
import { showRankedConflict } from './rankedControl'
import type { AccountGame } from '../net/accounts'
import { playControl, connectPlayControl } from './playControl'
import type { PlayTarget } from '../net/playControl'
import { roomProgress, type RoomProgress } from '../net/roomProgress'
import { trackEvent, type MatchAnalyticsMode } from '../lib/analytics'
import { savedRoomOptions } from './roomOptions'

export type { SessionApi, NetMode } from '../net/session'
export type { RegionChoice, RegionState, RegionStatus, ServerFailure, ServerRegion, PublicRoom, LeaderboardPage, ServerProfile } from '../net/online'
export type { Period, PublicBoardRow } from '../net/leaderboard'
export type { ListerState } from '../net/lister'
export type { RoomRoute, RejoinView } from '../net/rejoin'
export type { RoomSummary } from '../net/dedicated'
export { ServerError } from '../net/online'
export type { NetStatsView, PeerNetStats, NetGrade, NetGradeEvent, NetGradeReason } from '../net/netstats'
export { PLAYER_COLORS, MAX_PLAYERS } from '../net/session'
export { parseRoomCode, codeFromSearch, roomLink, CODE_LENGTH } from '../net/code'

/** Room code from a `?room=CODE` invite link, or null. */
export function roomCodeFromUrl(): string | null {
  return typeof location === 'undefined' ? null : codeFromSearch(location.search)
}

declare const __NET_ID__: string

/**
 * Dedicated game servers (M4.1, docs/M4.md §11), one per region: the build's
 * VITE_GAME_SERVERS (JSON `[{"id","label","url"}]`) or VITE_GAME_SERVER (one URL), or
 * `?server=ws://host:port` (testing, replaces them). Without any: peer-to-peer only.
 * Joining a code routes to the region holding that room, else peer-to-peer. Hosting is
 * always an explicit choice (openHost: peer-to-peer, openHostServer: a region); a failure
 * never switches mode by itself.
 */
function configuredRegions(): ServerRegion[] {
  const test = typeof location === 'undefined' ? null : serverUrlFrom(location.search)
  if (test) return [{ id: 'test', label: 'Test server', url: test }]
  return parseRegions(import.meta.env.VITE_GAME_SERVERS, import.meta.env.VITE_GAME_SERVER)
}

/** The game-server regions with live health and ping (UI: host card, region setting, lobby chip). */
export const online = new Online({ regions: configuredRegions(), build: __NET_ID__ })
// warm the probe so the first join or host does not wait for it
if (online.configured) void online.probe()

/** Region of the current room's server, set by every join / host (null: peer-to-peer). */
let routed: ServerRegion | null = null
/** Consumed by exactly one dial. Explicit browser/rejoin routes never change backend. */
let nextJoinRoute: RoomRoute | null = null
let rankedTakeover = false
const network = hybridNet(online.configured ? createPeerNet(() => online.iceConfiguration()) : peerNet, online, (url) => wsNet(url, undefined, import.meta.env.VITE_ACCOUNTS_ENABLED === 'true' ? () => getAdmissionToken(false, rankedTakeover) : undefined, showRankedConflict, import.meta.env.VITE_ACCOUNTS_ENABLED === 'true' ? () => playControl.token() : undefined), (region) => { routed = region })

/** `?net=classic` / `?net=snapshot` / `?net=predict` overrides the Settings choice (escape hatch, testing). */
function netMode(): NetMode {
  if (typeof location !== 'undefined') {
    const v = new URLSearchParams(location.search).get('net')
    if (v === 'classic' || v === 'predict' || v === 'snapshot') return v
  }
  const m = useGame.getState().settings.netMode
  return m === 'classic' || m === 'snapshot' ? m : 'predict'
}

/** Feeds game/stats.ts (one tracker per match) and game/replay (the local replay), both recorded at game over. */
function createRecorder(): MatchRecorder {
  let tracker: MatchTracker | null = null
  let analyticsMode: MatchAnalyticsMode | null = null
  const replay = createReplayHook(__NET_ID__)
  return {
    start: (info) => {
      const lobby = useGame.getState().lobby
      analyticsMode = info.localPlayer < 0 ? null : lobby.role === 'offline' ? 'offline' : lobby.ranked ? 'ranked' : lobby.quick ? 'casual' : 'custom'
      if (analyticsMode) {
        trackEvent('match_start', { mode: analyticsMode,
          transport: lobby.role === 'offline' ? 'offline' : impl.transport()!, players: info.slots.filter((slot) => slot.kind === 'human').length, bots: info.slots.filter((slot) => slot.kind === 'bot').length })
      }
      tracker = new MatchTracker({ ...info, queue: lobby.role === 'offline' ? 'offline' : lobby.ranked ? 'ranked' : lobby.quick ? 'casual' : 'custom' })
      replay.start(info)
    },
    step: (before, inputs, patches, slots) => replay.step(before, inputs, patches, slots),
    observe: (state, events) => {
      tracker?.observe(state, events)
      replay.observe(state, events)
    },
    finish: (result) => {
      const rec = tracker ? tracker.finish(result) : null
      if (rec) recordMatch(rec, getProfile().id)
      if (rec && analyticsMode && rec.outcome !== 'spectator') trackEvent('match_complete', { mode: analyticsMode, outcome: rec.outcome, rounds: rec.rounds, duration_seconds: Math.round(rec.durationSec) })
      replay.finish(rec?.id ?? null, result.winners)
      tracker = null
      analyticsMode = null
    },
    abort: () => {
      if (tracker && analyticsMode) trackEvent('match_exit', { mode: analyticsMode })
      // Combat played before leaving still counts toward career totals, never as a game.
      // The tracker is dropped here, so a repeated abort or a later finish cannot add it twice.
      const part = tracker?.unfinishedPart()
      if (part) recordUnfinishedMatch({ ...part, date: Date.now() }, getProfile().id)
      tracker = null
      analyticsMode = null
      replay.abort()
    },
  }
}

let sessionScreen: 'lobby' | 'match' | 'results' = 'lobby'
let listingProgress: RoomProgress | null = null
const impl = createSession({
  ui: {
    lobby: () => useGame.getState().lobby,
    setLobby: (p) => useGame.getState().setLobby(p),
    screen: () => sessionScreen,
    setScreen: (s) => {
      if (s === 'lobby' || s === 'match' || s === 'results') sessionScreen = s
      useGame.getState().setScreen(s)
    },
    setResult: (r) => useGame.getState().setResult(r),
    paused: () => useGame.getState().paused,
    onScreen: (cb) =>
      useGame.subscribe((s, prev) => {
        if (s.screen !== prev.screen) cb(s.screen)
      }),
  },
  frame: {
    reset: () => { listingProgress = null; resetFrame() },
    setLocalPlayer: (id) => {
      frame.localPlayer = id
    },
    pushState: (state, at) => {
      pushState(state, at)
      if (!listed) return
      const next = roomProgress(state)
      const prev = listingProgress
      // Public P2P progress refreshes about every ten seconds, or immediately on a phase/round change.
      if (!prev || prev.phase !== next.phase || prev.round !== next.round || prev.final !== next.final || Math.floor(prev.elapsedSeconds / 10) !== Math.floor(next.elapsedSeconds / 10)) {
        listingProgress = next
        syncListing()
      }
    },
    pushEvents,
    setNet: (rttMs, lossPct) => {
      frame.net.rttMs = rttMs
      frame.net.lossPct = lossPct
    },
  },
  profile: () => ({ ...getProfile(), cosmetics: localEquipment() }),
  recorder: createRecorder(),
  input,
  audio,
  createMatch,
  step,
  createBot,
  defaultSettings: DEFAULT_SETTINGS,
  net: {
    host: () => network.host(),
    join(code, onStatus) {
      const route = nextJoinRoute
      nextJoinRoute = null
      return route ? network.joinAt(code, route, onStatus) : network.join(code, onStatus)
    },
  },
  startClock: (pulse) => startClock((now) => { if (playControl.valid()) pulse(now) }),
  mayRun: () => playControl.valid(),
  now: () => performance.now(),
  random: Math.random,
  joinUrl: joinUrlFor,
  clientKey,
  netMode,
  device: getDeviceId,
  build: __NET_ID__,
})

export type HostMode = 'p2p' | 'server'
export type HostFailure = ServerFailure | 'cancelled'

/**
 * Outcome of a host attempt. On failure the lobby also shows it (lobby.status 'error',
 * lobby.error), and `other` says whether the other mode is worth offering in one click
 * (peer-to-peer: always tried, its broker has no health check; server: a region up).
 */
export type HostResult =
  | { ok: true; mode: HostMode; region: RegionStatus | null }
  | { ok: false; mode: HostMode; reason: HostFailure; message: string; region: RegionStatus | null; other: { mode: HostMode; available: boolean; region: RegionStatus | null } }

/** A custom room the player just opened starts from the options they last chose (roomOptions.ts). */
function applySavedRoomOptions(): void {
  const saved = savedRoomOptions()
  if (Object.keys(saved).length) impl.updateSettings(saved)
}

/** Hosting: peer-to-peer (openHost) or on a game server region (openHostServer). Never switches by itself. */
export interface HostingApi {
  /** peer-to-peer through the PeerJS broker */
  openHost(): Promise<HostResult>
  /** a room on a game server: a region id, 'auto' (lowest ping among regions that are up), or the region setting when omitted */
  openHostServer(region?: RegionChoice): Promise<HostResult>
  /** the current room's region when it runs on a game server, with its live ping */
  region(): RegionStatus | null
  /**
   * "Listed publicly" of a room hosted from this PC (peer-to-peer): its listing on a game
   * server (Browse games), null when this is not a P2P host. Turned on with setPublic(true);
   * a new room starts unlisted. Never ranked or counted on the leaderboard.
   */
  listing(): (ListerState & { regionStatus: RegionStatus | null }) | null
  /**
   * Quick play (M4.3): an open quick-play room on a game server (region as for
   * openHostServer), or a new one there. The server starts it once 2 humans are in, or
   * fills the seats with bots (`bots`, default Brutal) after ~10 s. Casual: no global Elo.
   */
  /** `exclude`: never this room (New game from its results) */
  quickPlay(opts?: { region?: RegionChoice; bots?: BotDifficulty; exclude?: string; mode?: 'hill' }): Promise<HostResult>
  rankedPlay(opts?: { region?: RegionChoice }): Promise<HostResult>
  /** A region's ranked leaderboard, with this device's line. Throws ServerError. */
  leaderboard(period: Period, region?: RegionChoice): Promise<LeaderboardPage>
  /** This device's public profile on a region's server; null before its first counted match. Throws ServerError. */
  serverProfile(region?: RegionChoice): Promise<ServerProfile | null>
  /** An inspectable player profile addressed by its public ID, never its private device identity. */
  publicProfile(publicId: string, region?: RegionChoice): Promise<ServerProfile | null>
  matchHistory(queue?: HistoryQueue, publicId?: string): Promise<MatchHistoryEntry[]>
  recentMatches(queue?: HistoryQueue): Promise<GlobalMatchEntry[]>
}

const CANCELLED = 'Hosting was cancelled.'

function hostFailed(mode: HostMode, reason: HostFailure, message: string, region: RegionStatus | null, other: { mode: HostMode; available: boolean; region: RegionStatus | null }): HostResult {
  if (reason !== 'cancelled') {
    useGame.getState().setLobby({ status: 'error', error: message })
    useGame.getState().setScreen('menu')
  }
  return { ok: false, mode, reason, message, region, other }
}

async function serverOption(): Promise<{ mode: HostMode; available: boolean; region: RegionStatus | null }> {
  const region = online.configured ? await online.choose(useGame.getState().settings.serverRegion ?? 'auto') : null
  return { mode: 'server', available: region?.state === 'up', region }
}

const P2P_OPTION = { mode: 'p2p', available: true, region: null } as const

function blockUnsupportedPlay(): boolean {
  if (isPlaySupported()) return false
  clearPendingRoom()
  useGame.getState().setLobby({ status: 'error', error: PLAY_REQUIREMENT })
  return true
}

function unsupportedHost(mode: HostMode): HostResult {
  return hostFailed(mode, 'unavailable', PLAY_REQUIREMENT, null, { mode: mode === 'p2p' ? 'server' : 'p2p', available: false, region: null })
}

/** Did the action that just finished open a room of this transport (and nothing replaced it meanwhile)? */
function opened(t: 'server' | 'p2p'): boolean {
  const l = useGame.getState().lobby
  return l.status === 'open' && l.role !== 'offline' && impl.transport() === t
}

export type GameSession = Omit<SessionApi, 'openOffline' | 'openHost' | 'setRoom' | 'roomState' | 'joinableSeats' | 'join' | 'idleHumans' | 'dropIdle' | 'finishDeparted'> & HostingApi & {
  openOffline(): Promise<void>
  useRankedHere(game: AccountGame): Promise<void>
  /** A guided offline lesson without match records, rewards or matchmaking. */
  openPractice(): Promise<void>
  join(code: string, route?: RoomRoute): Promise<void>
  /** Show this tab's accepted room again without matchmaking or reconnecting. */
  resume(): boolean
  roomPhase(): 'lobby' | 'match' | 'results'
}

interface Opening { kind: string; promise: Promise<HostResult> | null }
let opening: Opening | null = null
let sessionGeneration = 0
let readyRequest = 0

/** Start/ready shortcuts must also wait for a fresh check, without affecting a replacement room. */
function withCurrentBuild(action: () => void): void {
  if (getBuildUpdate()) return
  const generation = sessionGeneration
  const screen = useGame.getState().screen
  void ensureCurrentBuild().then(() => {
    if (generation === sessionGeneration && useGame.getState().screen === screen && !getBuildUpdate()) action()
  }).catch((error: unknown) => {
    if (generation !== sessionGeneration) return
    useGame.getState().setLobby({ error: error instanceof Error ? error.message : 'Could not check the game version. Please try again.' })
  })
}

function cancelled(mode: HostMode): HostResult {
  return { ok: false, mode, reason: 'cancelled', message: CANCELLED, region: null,
    other: { mode: mode === 'server' ? 'p2p' : 'server', available: false, region: null } }
}

function resume(): boolean {
  if (getBuildUpdate()) return false
  if (!impl.isActive()) return false
  useGame.getState().setLobby({ status: 'open', error: null })
  useGame.getState().setScreen(sessionScreen)
  return true
}

/** Own the whole action, including region selection and its POST, before the first await. */
function openOnce(kind: string, mode: HostMode, run: (current: () => boolean) => Promise<HostResult>, rejoining = false, retry?: () => Promise<unknown>): Promise<HostResult> {
  if (getBuildUpdate()) return Promise.resolve(hostFailed(mode, 'error', BUILD_UPDATE_REQUIRED, null, { mode, available: false, region: null }))
  if (opening) {
    useGame.getState().setScreen('lobby')
    return opening.kind === kind && opening.promise ? opening.promise : Promise.resolve(cancelled(mode))
  }
  if (resume()) return Promise.resolve(cancelled(mode))
  stopPractice()
  if (useGame.getState().lobby.role === 'offline' && useGame.getState().lobby.status === 'open') impl.leave()
  const attempt: Opening = { kind, promise: null }
  sessionGeneration++
  opening = attempt
  if (!rejoining) rejoin.dismiss()
  const state = useGame.getState()
  state.setLobby({ role: 'client', status: 'connecting', roomCode: null, joinUrl: null, localPlayer: -1,
    slots: [], settings: null, ready: {}, pings: {}, public: false, quick: kind === 'quick' || kind === 'ranked', ranked: kind === 'ranked',
    autoStart: null, waitingForPlayers: [], waitingForRound: false, error: null, notice: kind === 'ranked' ? 'Finding a ranked lobby…' : kind === 'quick' ? 'Finding a game…' : 'Opening a room…' })
  state.setScreen('lobby')
  const current = () => opening === attempt
  const target: PlayTarget = { mode: kind === 'quick' ? 'casual' : kind === 'ranked' ? 'ranked' : kind === 'local' || kind === 'practice' ? kind : kind === 'p2p' ? 'host' : kind.startsWith('join:') ? 'join' : 'server', region: null, code: null }
  attempt.promise = (async () => {
    try {
      await ensureCurrentBuild()
      if (!current()) return cancelled(mode)
      const acquired = await playControl.acquire(target, retry ?? (() => openOnce(kind, mode, run, rejoining)))
      if (!current()) { if (acquired) await playControl.release(); return cancelled(mode) }
      if (!acquired) { state.setScreen('menu'); state.setLobby({ status: 'idle' }); return cancelled(mode) }
      const result = await run(current)
      if (current() && !result.ok) await playControl.release()
      return result
    } catch (error) {
      if (!current()) return cancelled(mode)
      const message = error instanceof Error ? error.message : 'Could not open your game.'
      state.setScreen('menu'); state.setLobby({ status: 'error', error: message })
      return hostFailed(mode, 'error', message, null, { mode: 'p2p', available: false, region: null })
    }
  })().finally(() => { if (current()) opening = null })
  return attempt.promise
}

async function dialRoom(code: string, route: RoomRoute | undefined, current: () => boolean): Promise<void> {
  nextJoinRoute = route ?? null
  await impl.join(code)
  if (current()) nextJoinRoute = null
}

async function joinRoom(code: string, route?: RoomRoute, rejoining = false): Promise<void> {
  if (blockUnsupportedPlay()) return
  const mode = route?.kind === 'server' ? 'server' : 'p2p'
  await openOnce(`join:${code}:${route?.kind ?? 'auto'}:${route?.kind === 'server' ? route.region : ''}`, mode, async (current) => {
    await dialRoom(code, route, current)
    if (!current()) return cancelled(mode)
    if (useGame.getState().lobby.status === 'open') return { ok: true, mode: impl.transport() === 'server' ? 'server' : 'p2p', region: routed ? online.region(routed.id) : null }
    return cancelled(mode) // The void join API reports failures through its existing lobby state.
  }, rejoining)
}

/** Rediscovery is read-only; the player must explicitly click Rejoin. */
export const rejoin = new RejoinController({
  storage: safeLocalStorage(),
  identity: () => ({ profileId: getProfile().id, deviceId: getDeviceId() }),
  exists: async (target) => target.route.kind === 'server'
    ? online.roomExists(target.route.region, target.code)
    : (await online.browse()).some((room) => room.kind === 'p2p' && room.code === target.code),
  join: async (target) => {
    await joinRoom(target.code, target.route, true)
    const lobby = useGame.getState().lobby
    return { ok: lobby.status === 'open' && lobby.roomCode === target.code && impl.transport() === target.route.kind && (target.route.kind !== 'server' || routed?.id === target.route.region), error: lobby.error ?? undefined }
  },
})

/** The region a server request goes to: the given choice or the region setting; auto = lowest ping. */
async function serverRegion(choice?: RegionChoice): Promise<RegionStatus> {
  if (!online.configured) throw new ServerError('unavailable', 'This build has no game server.')
  const region = await online.choose(choice ?? useGame.getState().settings.serverRegion ?? 'auto')
  if (!region) throw new ServerError('unavailable', 'No game server is reachable right now.')
  return region
}

export const session: GameSession = {
  async useRankedHere(game) {
    if (blockUnsupportedPlay()) return
    session.leave()
    rankedTakeover = true
    try { await joinRoom(game.room, { kind: 'server', region: game.region }, true) }
    finally { rankedTakeover = false }
  },
  sendChat: impl.sendChat,
  setWaitingForPlayers: impl.setWaitingForPlayers,
  async openPractice() {
    if (blockUnsupportedPlay() || resume()) return
    await openOnce('practice', 'p2p', async () => {
      nextJoinRoute = null; impl.leave()
      startPractice(getProfile(), () => playControl.valid())
      return { ok: true, mode: 'p2p', region: null }
    }, false, () => session.openPractice())
  },
  async openOffline() {
    if (blockUnsupportedPlay()) return
    if (resume()) return
    await openOnce('local', 'p2p', async () => {
      nextJoinRoute = null; impl.openOffline()
      applySavedRoomOptions()
      return { ok: true, mode: 'p2p', region: null }
    }, false, () => session.openOffline())
  },
  async openHost() {
    if (blockUnsupportedPlay()) return unsupportedHost('p2p')
    return openOnce('p2p', 'p2p', async (current) => {
      await impl.openHost()
      if (!current()) return cancelled('p2p')
      if (opened('p2p')) {
        applySavedRoomOptions()
        return { ok: true, mode: 'p2p', region: null }
      }
      const l = useGame.getState().lobby
      const other = await serverOption()
      if (!current()) return cancelled('p2p')
      if (l.status !== 'error') return hostFailed('p2p', 'cancelled', CANCELLED, null, other)
      return hostFailed('p2p', 'unavailable', l.error ?? 'Could not host peer-to-peer.', null, other)
    })
  },
  async openHostServer(choice) {
    if (blockUnsupportedPlay()) return unsupportedHost('server')
    return openOnce('server', 'server', async (current) => {
      const want = choice ?? useGame.getState().settings.serverRegion ?? 'auto'
      if (!online.configured) return hostFailed('server', 'unavailable', 'This build has no game server.', null, P2P_OPTION)
      const region = await online.choose(want)
      if (!current()) return cancelled('server')
      if (!region) return hostFailed('server', 'unavailable', 'No game server is reachable right now.', null, P2P_OPTION)
      let code: string
      try {
        code = await online.createRoom(region.id)
      } catch (e) {
        if (!current()) return cancelled('server')
        const reason = e instanceof ServerError ? e.reason : 'error'
        return hostFailed('server', reason, e instanceof Error ? e.message : String(e), online.region(region.id), P2P_OPTION)
      }
      if (!current()) return cancelled('server')
      await dialRoom(code, { kind: 'server', region: region.id }, current)
      if (!current()) return cancelled('server')
      if (opened('server')) {
        applySavedRoomOptions()
        return { ok: true, mode: 'server', region: online.region(routed?.id ?? region.id) }
      }
      const l = useGame.getState().lobby
      if (l.status !== 'error') return hostFailed('server', 'cancelled', CANCELLED, online.region(region.id), P2P_OPTION)
      return hostFailed('server', 'error', l.error ?? 'Could not join the game server room.', online.region(region.id), P2P_OPTION)
    })
  },
  region() {
    return impl.transport() === 'server' && routed ? online.region(routed.id) : null
  },
  async quickPlay(opts = {}) {
    if (blockUnsupportedPlay()) return unsupportedHost('server')
    return openOnce('quick', 'server', async (current) => {
      let region: RegionStatus
      let code: string
      try {
        region = await serverRegion(opts.region)
        if (!current()) return cancelled('server')
        code = (await online.quickPlay(region.id, opts.bots, opts.exclude, opts.mode)).code
      } catch (e) {
        if (!current()) return cancelled('server')
        const reason = e instanceof ServerError ? e.reason : 'error'
        return hostFailed('server', reason, e instanceof Error ? e.message : String(e), null, P2P_OPTION)
      }
      if (!current()) return cancelled('server')
      await dialRoom(code, { kind: 'server', region: region.id }, current)
      if (!current()) return cancelled('server')
      if (opened('server')) return { ok: true, mode: 'server', region: online.region(routed?.id ?? region.id) }
      const l = useGame.getState().lobby
      if (l.status !== 'error') return hostFailed('server', 'cancelled', 'Quick play was cancelled.', online.region(region.id), P2P_OPTION)
      return hostFailed('server', 'error', l.error ?? 'Could not join the quick-play room.', online.region(region.id), P2P_OPTION)
    })
  },
  async rankedPlay(opts = {}) {
    if (blockUnsupportedPlay()) return unsupportedHost('server')
    return openOnce('ranked', 'server', async (current) => {
      let region: RegionStatus
      let code: string
      try {
        region = await serverRegion(opts.region)
        if (!current()) return cancelled('server')
        const proof = import.meta.env.VITE_ACCOUNTS_ENABLED === 'true' ? await getAdmissionToken(true) : null
        if (!current()) return cancelled('server')
        code = (await online.rankedPlay(region.id, proof ?? undefined)).code
      } catch (e) {
        if (!current()) return cancelled('server')
        if (e instanceof ServerError && e.rankedConflict) showRankedConflict(e.rankedConflict)
        return hostFailed('server', e instanceof ServerError ? e.reason : 'error', e instanceof Error ? e.message : String(e), null, { mode: 'p2p', available: false, region: null })
      }
      if (!current()) return cancelled('server')
      await dialRoom(code, { kind: 'server', region: region.id }, current)
      if (!current()) return cancelled('server')
      if (opened('server')) return { ok: true, mode: 'server', region: online.region(routed?.id ?? region.id) }
      const l = useGame.getState().lobby
      return hostFailed('server', l.status === 'error' ? 'error' : 'cancelled', l.error ?? 'Ranked matchmaking was cancelled.', online.region(region.id), { mode: 'p2p', available: false, region: null })
    })
  },
  async leaderboard(period, choice) {
    const account = useAccount.getState().player
    return online.leaderboard((await serverRegion(choice)).id, period, account ? accountRatingKey(account.id) : getDeviceId())
  },
  async serverProfile(choice) {
    const account = useAccount.getState().player
    return online.profile((await serverRegion(choice)).id, account ? accountRatingKey(account.id) : getDeviceId())
  },
  async publicProfile(publicId, choice) {
    return online.publicProfile((await serverRegion(choice)).id, publicId)
  },
  async matchHistory(queue, publicId) {
    const account = useAccount.getState().player
    const identity = publicId ?? (account ? accountRatingKey(account.id) : getDeviceId())
    return online.matchHistory((await serverRegion()).id, identity, queue, publicId !== undefined)
  },
  async recentMatches(queue) {
    return online.recentMatches((await serverRegion()).id, queue)
  },
  setPublic(value) {
    const l = useGame.getState().lobby
    if (!(impl.transport() === 'p2p' && l.role === 'host' && l.roomCode)) {
      impl.setPublic(value)
      return
    }
    listed = null
    useGame.getState().setLobby({ public: value && online.configured })
    if (!value || !online.configured) {
      syncListing()
      return
    }
    const code = l.roomCode
    void online.choose(useGame.getState().settings.serverRegion ?? 'auto').then((r) => {
      const now = useGame.getState().lobby
      if (!now.public || now.roomCode !== code) return // switched off or left meanwhile
      if (!r || r.state !== 'up') {
        useGame.getState().setLobby({ public: false, notice: 'Could not list the game: no game server is reachable right now.' })
        return
      }
      listed = { code, region: r.id }
      syncListing()
    })
  },
  listing() {
    const l = useGame.getState().lobby
    if (!(impl.transport() === 'p2p' && l.role === 'host')) return null
    const st = lister.state()
    return { ...st, regionStatus: st.region ? online.region(st.region) : null }
  },
  join(code, route) {
    return joinRoom(code, route)
  },
  isActive: impl.isActive,
  resume,
  roomPhase: () => sessionScreen,
  setDisplayName: impl.setDisplayName,
  setPlayerColor(color) {
    setPreferredColor(color)
    impl.setPlayerColor(color)
    const profile = useAccount.getState().player?.profile
    if (profile) void saveAccountColor(color).catch(() => {
      useGame.getState().setLobby({ error: 'Your color changed for this game, but your account preference could not be saved. Update it in Account before your next game.' })
    })
  },
  startLobbyVote: impl.startLobbyVote,
  castLobbyVote: impl.castLobbyVote,
  addBot: impl.addBot,
  setMaxPlayers: impl.setMaxPlayers,
  removeSlot: impl.removeSlot,
  setBotDifficulty: impl.setBotDifficulty,
  setTeam: impl.setTeam,
  updateSettings: impl.updateSettings,
  startMatch() { withCurrentBuild(() => impl.startMatch()) },
  requestMatchStart() { withCurrentBuild(() => impl.requestMatchStart()) },
  rematch() { withCurrentBuild(() => impl.rematch()) },
  backToLobby: impl.backToLobby,
  setReady(ready) {
    const request = ++readyRequest
    if (ready) withCurrentBuild(() => { if (request === readyRequest) impl.setReady(true) })
    else if (!getBuildUpdate()) impl.setReady(false)
  },
  leave() {
    sessionGeneration++
    stopPractice()
    opening = null
    nextJoinRoute = null
    // a casual game stays rejoinable from the menu for a while; leaving ranked is final
    if (useGame.getState().lobby.ranked) rejoin.dismiss()
    else rejoin.left()
    impl.leave()
    void playControl.release().catch(() => {})
  },
  netStats: impl.netStats,
  onNetGrade: impl.onNetGrade,
  transport: impl.transport,
}

onBuildUpdate(() => {
  // A waiting lobby may auto-start remotely: release the seat as well as blocking its UI.
  // Ongoing matches are allowed to finish and checked again when their screen changes.
  const state = useGame.getState()
  if (state.screen !== 'match' && (opening || impl.isActive() || state.lobby.status === 'open')) session.leave()
})

connectPlayControl({
  lost(message, transfer) {
    sessionGeneration++
    stopPractice(); opening = null; nextJoinRoute = null; impl.leave(transfer)
    useGame.getState().setLobby({ status: 'error', error: message })
  },
  async resume(target) {
    if (!target.code || !target.region) throw new Error('This game cannot be resumed from another tab.')
    rankedTakeover = true
    try { await joinRoom(target.code, { kind: 'server', region: target.region }, true) }
    finally { rankedTakeover = false }
  },
})

// ---- player-hosted rooms in Browse games (listings.ts) ------------------------------------

const lister = new Lister(online)
/** the P2P room whose "Listed publicly" switch is on, and the region it is listed on */
let listed: { code: string; region: string } | null = null

/** What the listing should say now, or null: switched off or no longer this P2P host. */
function listingTarget(): ReturnType<typeof p2pListingTarget> {
  const st = useGame.getState()
  const l = st.lobby
  const set = l.settings ?? DEFAULT_SETTINGS
  return p2pListingTarget({ listed, role: l.role, status: l.status, code: l.roomCode, public: !!l.public,
    transport: impl.transport(), slots: l.slots, settings: set, screen: sessionScreen, host: getProfile().name,
    max: l.maxPlayers ?? MAX_PLAYERS, joinable: impl.joinableSeats(), progress: listingProgress })
}

function syncListing(): void {
  const l = useGame.getState().lobby
  // the switch belongs to one room: any other room (or none) starts private again
  if (listed && (l.roomCode !== listed.code || l.role !== 'host' || impl.transport() !== 'p2p')) listed = null
  lister.want(listingTarget())
}
useGame.subscribe((s, prev) => {
  if (s.lobby.status === 'open' && s.lobby.roomCode) {
    const transport = impl.transport()
    const route: RoomRoute | null = transport === 'server' && routed ? { kind: 'server', region: routed.id }
      : transport === 'p2p' && s.lobby.role === 'client' ? { kind: 'p2p' } : null
    if (route) rejoin.connected({ code: s.lobby.roomCode, route, profileId: getProfile().id, deviceId: getDeviceId() })
  } else if (s.lobby.status === 'error' && prev.lobby.status === 'open') rejoin.disconnected()
  if (s.settings.playerName !== prev.settings.playerName) {
    impl.setDisplayName(s.settings.playerName)
    updateProfileNames([{ profileId: getProfile().id, name: s.settings.playerName }])
  }
  if (s.lobby.slots !== prev.lobby.slots) {
    const changed = s.lobby.slots.filter((slot) => slot.kind === 'human' && slot.profileId && !prev.lobby.slots.some((old) => old.profileId === slot.profileId && old.name === slot.name))
    updateProfileNames(changed.map((slot) => ({ profileId: slot.profileId!, name: slot.name })))
  }
  if (s.lobby !== prev.lobby || s.screen !== prev.screen) syncListing()
  if (s.lobby.status === 'open' && s.lobby.roomCode && (s.lobby !== prev.lobby || s.screen !== prev.screen)) {
    const transport = impl.transport()
    const target: PlayTarget = { mode: transport === 'p2p' ? s.lobby.role === 'host' ? 'host' : 'p2p' : s.lobby.ranked ? 'ranked' : s.lobby.quick ? 'casual' : 'server', region: transport === 'server' ? routed?.id ?? null : null, code: s.lobby.roomCode }
    void playControl.update(target).catch(() => { session.leave(); useGame.getState().setLobby({ status: 'error', error: 'Could not keep your game session active.' }) })
  }
  if (s.lobby.status === 'error' && prev.lobby.status === 'open') void playControl.release().catch(() => {})
})
// closing the tab: unlist now (the server's TTL drops it anyway if this does not get out)
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => lister.want(null))

// dev-only probes for two-tab / two-browser testing from the console: __session.debug(),
// __session.netStats(), __input.issue({kind: 'move', ...}), __frame.curr, __store.getState(),
// __game.openHostServer('auto'), __online.probe()
if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.assign(window, { __session: impl, __game: session, __online: online, __frame: frame, __input: input, __store: useGame })
}
