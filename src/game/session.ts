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
import { joinUrlFor, peerNet } from '../net/peer'
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
import { getProfile, setPreferredColor } from './profile'
import { MatchTracker, recordMatch, updateProfileNames } from './stats'
import { createReplayHook } from './replay/hook'
import { useGame } from './store'

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

const CLIENT_KEY = 'brawlock.clientKey'

function randomKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

/** Per tab (survives reloads): lets a reloaded client reclaim its pawn mid-match. */
function clientKey(): string {
  try {
    let k = sessionStorage.getItem(CLIENT_KEY)
    if (!k) {
      k = randomKey()
      sessionStorage.setItem(CLIENT_KEY, k)
    }
    return k
  } catch {
    return randomKey()
  }
}

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
const network = hybridNet(peerNet, online, (url) => wsNet(url), (region) => { routed = region })

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
  const replay = createReplayHook(__NET_ID__)
  return {
    start: (info) => {
      tracker = new MatchTracker(info)
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
      replay.finish(rec?.id ?? null, result.winners)
      tracker = null
    },
    abort: () => {
      tracker = null
      replay.abort()
    },
  }
}

const impl = createSession({
  ui: {
    lobby: () => useGame.getState().lobby,
    setLobby: (p) => useGame.getState().setLobby(p),
    screen: () => useGame.getState().screen,
    setScreen: (s) => useGame.getState().setScreen(s),
    setResult: (r) => useGame.getState().setResult(r),
    paused: () => useGame.getState().paused,
    onScreen: (cb) =>
      useGame.subscribe((s, prev) => {
        if (s.screen !== prev.screen) cb(s.screen)
      }),
  },
  frame: {
    reset: resetFrame,
    setLocalPlayer: (id) => {
      frame.localPlayer = id
    },
    pushState,
    pushEvents,
    setNet: (rttMs, lossPct) => {
      frame.net.rttMs = rttMs
      frame.net.lossPct = lossPct
    },
  },
  profile: () => getProfile(),
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
  startClock,
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
   * fills the seats with bots (`bots`, default Hard) after ~10 s. Same HostResult as hosting.
   */
  quickPlay(opts?: { region?: RegionChoice; bots?: BotDifficulty }): Promise<HostResult>
  /** A region's casual leaderboard (server games only), with this device's line. Throws ServerError. */
  leaderboard(period: Period, region?: RegionChoice): Promise<LeaderboardPage>
  /** This device's public profile on a region's server; null before its first counted match. Throws ServerError. */
  serverProfile(region?: RegionChoice): Promise<ServerProfile | null>
}

const CANCELLED = 'Hosting was cancelled.'

function hostFailed(mode: HostMode, reason: HostFailure, message: string, region: RegionStatus | null, other: { mode: HostMode; available: boolean; region: RegionStatus | null }): HostResult {
  if (reason !== 'cancelled') useGame.getState().setLobby({ status: 'error', error: message })
  return { ok: false, mode, reason, message, region, other }
}

async function serverOption(): Promise<{ mode: HostMode; available: boolean; region: RegionStatus | null }> {
  const region = online.configured ? await online.choose(useGame.getState().settings.serverRegion ?? 'auto') : null
  return { mode: 'server', available: region?.state === 'up', region }
}

const P2P_OPTION = { mode: 'p2p', available: true, region: null } as const

/** Did the action that just finished open a room of this transport (and nothing replaced it meanwhile)? */
function opened(t: 'server' | 'p2p'): boolean {
  const l = useGame.getState().lobby
  return l.status === 'open' && l.role !== 'offline' && impl.transport() === t
}

export type GameSession = Omit<SessionApi, 'openHost' | 'setRoom' | 'roomState' | 'joinableSeats' | 'join'> & HostingApi & {
  join(code: string, route?: RoomRoute): Promise<void>
}

async function joinRoom(code: string, route?: RoomRoute): Promise<void> {
  nextJoinRoute = route ?? null
  await impl.join(code)
  nextJoinRoute = null
}

/** Rediscovery is read-only; the player must explicitly click Rejoin. */
export const rejoin = new RejoinController({
  identity: () => ({ profileId: getProfile().id, deviceId: getDeviceId() }),
  exists: async (target) => target.route.kind === 'server'
    ? online.roomExists(target.route.region, target.code)
    : (await online.browse()).some((room) => room.kind === 'p2p' && room.code === target.code),
  join: async (target) => {
    await joinRoom(target.code, target.route)
    const lobby = useGame.getState().lobby
    return { ok: lobby.status === 'open' && impl.transport() === target.route.kind, error: lobby.error ?? undefined }
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
  openOffline() {
    rejoin.dismiss()
    impl.openOffline()
  },
  async openHost() {
    rejoin.dismiss()
    await impl.openHost()
    if (opened('p2p')) return { ok: true, mode: 'p2p', region: null }
    const l = useGame.getState().lobby
    if (l.status !== 'error') return hostFailed('p2p', 'cancelled', CANCELLED, null, await serverOption())
    return hostFailed('p2p', 'unavailable', l.error ?? 'Could not host peer-to-peer.', null, await serverOption())
  },
  async openHostServer(choice) {
    rejoin.dismiss()
    const want = choice ?? useGame.getState().settings.serverRegion ?? 'auto'
    if (!online.configured) return hostFailed('server', 'unavailable', 'This build has no game server.', null, P2P_OPTION)
    const region = await online.choose(want)
    if (!region) return hostFailed('server', 'unavailable', 'No game server is reachable right now.', null, P2P_OPTION)
    let code: string
    try {
      code = await online.createRoom(region.id)
    } catch (e) {
      const reason = e instanceof ServerError ? e.reason : 'error'
      return hostFailed('server', reason, e instanceof Error ? e.message : String(e), online.region(region.id), P2P_OPTION)
    }
    await joinRoom(code, { kind: 'server', region: region.id })
    if (opened('server')) return { ok: true, mode: 'server', region: online.region(routed?.id ?? region.id) }
    const l = useGame.getState().lobby
    if (l.status !== 'error') return hostFailed('server', 'cancelled', CANCELLED, online.region(region.id), P2P_OPTION)
    return hostFailed('server', 'error', l.error ?? 'Could not join the game server room.', online.region(region.id), P2P_OPTION)
  },
  region() {
    return impl.transport() === 'server' && routed ? online.region(routed.id) : null
  },
  async quickPlay(opts = {}) {
    rejoin.dismiss()
    let region: RegionStatus
    let code: string
    try {
      region = await serverRegion(opts.region)
      code = (await online.quickPlay(region.id, opts.bots)).code
    } catch (e) {
      const reason = e instanceof ServerError ? e.reason : 'error'
      return hostFailed('server', reason, e instanceof Error ? e.message : String(e), null, P2P_OPTION)
    }
    await joinRoom(code, { kind: 'server', region: region.id })
    if (opened('server')) return { ok: true, mode: 'server', region: online.region(routed?.id ?? region.id) }
    const l = useGame.getState().lobby
    if (l.status !== 'error') return hostFailed('server', 'cancelled', 'Quick play was cancelled.', online.region(region.id), P2P_OPTION)
    return hostFailed('server', 'error', l.error ?? 'Could not join the quick-play room.', online.region(region.id), P2P_OPTION)
  },
  async leaderboard(period, choice) {
    return online.leaderboard((await serverRegion(choice)).id, period, getDeviceId())
  },
  async serverProfile(choice) {
    return online.profile((await serverRegion(choice)).id, getDeviceId())
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
    rejoin.dismiss()
    return joinRoom(code, route)
  },
  setDisplayName: impl.setDisplayName,
  setPlayerColor: impl.setPlayerColor,
  startLobbyVote: impl.startLobbyVote,
  castLobbyVote: impl.castLobbyVote,
  addBot: impl.addBot,
  removeSlot: impl.removeSlot,
  setBotDifficulty: impl.setBotDifficulty,
  setTeam: impl.setTeam,
  updateSettings: impl.updateSettings,
  startMatch: impl.startMatch,
  rematch: impl.rematch,
  backToLobby: impl.backToLobby,
  setReady: impl.setReady,
  leave() {
    rejoin.dismiss()
    impl.leave()
  },
  netStats: impl.netStats,
  onNetGrade: impl.onNetGrade,
  transport: impl.transport,
}

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
    transport: impl.transport(), slots: l.slots, settings: set, screen: st.screen, host: getProfile().name,
    max: MAX_PLAYERS, joinable: impl.joinableSeats() })
}

function syncListing(): void {
  const l = useGame.getState().lobby
  // the switch belongs to one room: any other room (or none) starts private again
  if (listed && (l.roomCode !== listed.code || l.role !== 'host' || impl.transport() !== 'p2p')) listed = null
  lister.want(listingTarget())
}
useGame.subscribe((s, prev) => {
  if (s.lobby.status === 'open') {
    const local = s.lobby.slots.find((slot) => slot.id === s.lobby.localPlayer && slot.kind === 'human' && slot.profileId === getProfile().id)
    const previous = local && prev.lobby.slots.find((slot) => slot.id === local.id && slot.profileId === local.profileId)
    if (local && previous?.color !== local.color) setPreferredColor(local.color)
  }
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
})
// closing the tab: unlist now (the server's TTL drops it anyway if this does not get out)
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => lister.want(null))

// dev-only probes for two-tab / two-browser testing from the console: __session.debug(),
// __session.netStats(), __input.issue({kind: 'move', ...}), __frame.curr, __store.getState(),
// __game.openHostServer('auto'), __online.probe()
if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.assign(window, { __session: impl, __game: session, __online: online, __frame: frame, __input: input, __store: useGame })
}
