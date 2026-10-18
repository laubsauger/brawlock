/**
 * Session core: lobby + match loop for offline, host and client roles.
 * Dependencies are injected so tests can run a host and a client in one process
 * over the in-memory transport; src/game/session.ts wires the real modules.
 *
 * Host / offline: fixed 60 Hz accumulator driven by the clock pulse (clock.ts: one
 *   per animation frame, a worker timer in background tabs), plus a one-shot pulse
 *   when the tick that applies an own command is due.
 *   Each tick: local input + remote inputs + bot commands → step → frame + audio
 *   → snapshot to clients (every tick, or every 2nd tick when large).
 * Client: own 60 Hz pulse; drains local input and sends every unacked frame
 *   (inputs.ts). Two net modes (deps.netMode):
 *   - 'predict' (default): full-world prediction (predict.ts). The client runs its
 *     own copy of the sim about one RTT ahead of the newest snapshot, applies its
 *     own inputs at once and stamps each frame with the tick it applied it in; the
 *     host runs stamped frames in that tick when they arrive in time. Every snapshot
 *     rolls the prediction back and re-simulates. Host fairness: the host's own
 *     inputs run `hostDelay` ticks late (median client one-way latency, capped),
 *     and the host sees its own predicted view, so it still feels instant.
 *   - 'classic' (escape hatch, ?net=classic): plays snapshots through the jitter
 *     buffer (jitter.ts) with an interpolation delay.
 * Both feed every authoritative tick to the MatchRecorder, which writes local stats
 * at game over (game/stats.ts). Link monitoring: netstats.ts.
 */
import type { Bot } from '../bots'
import type { Listener } from '../audio'
import type { LobbyView, MatchResult, NetRole, Screen } from '../game/store'
import {
  TICK_HZ,
  type BotDifficulty,
  type InputCommand,
  type MatchSettings,
  type PlayerId,
  type PlayerInput,
  type PlayerSlot,
  type SimEvent,
  type SimState,
} from '../sim/types'
import { cloneState, hashState } from '../sim/snapshot'
import type { StartClock } from './clock'
import { parseRoomCode } from './code'
import { InputReceiver, InputSender } from './inputs'
import { SnapshotBuffer } from './jitter'
import {
  GradeTracker,
  LossTracker,
  STATS_MS,
  WindowMax,
  DESYNC_HOLD_MS,
  SERVER_PLAYER_ID,
  gradeOf,
  type NetGradeEvent,
  type NetStatsView,
  type PeerNetStats,
} from './netstats'
import { LeadClock, Predictor, type LocalFrame } from './predict'
import { ArrivalClock, HASH_EVERY, HEARTBEAT_TICKS, REDUNDANCY, StreamFeed, StreamHistory, quantizeCmds, type StreamTick } from './stream'
import {
  EVENT_REDUNDANCY_TICKS,
  PROTOCOL_VERSION,
  decode,
  encode,
  encodeSnap,
  encodeStreamPacket,
  sanitizeColor,
  sanitizeFrames,
  sanitizeMetric,
  sanitizeName,
  sanitizeProfileId,
  sanitizeSettingsPatch,
  stateJsonWithoutEvents,
  type InputFrame,
  type Msg,
  type RoomState,
  type TickEvents,
} from './protocol'
import type { HostEndpoint, NetFactory, Transport, UnreliableMode } from './transport'

/**
 * 'predict' (default): prediction on the input stream (stream.ts): the host sends the
 * confirmed inputs, every peer steps the same sim. 'snapshot': prediction on full
 * snapshots (the M1 path, fallback). 'classic': interpolated snapshots, no prediction.
 */
export type NetMode = 'predict' | 'snapshot' | 'classic'

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** What the session reads / writes in the UI store. */
export interface UiPort {
  lobby(): LobbyView
  setLobby(patch: Partial<LobbyView>): void
  screen(): Screen
  setScreen(s: Screen): void
  setResult(r: MatchResult | null): void
  /** in-match menu open; pauses the sim offline only */
  paused(): boolean
  onScreen(cb: (s: Screen) => void): () => void
}

/** Where states and events go for render / HUD. */
export interface FrameSink {
  reset(): void
  setLocalPlayer(id: PlayerId): void
  pushState(state: SimState, at: number): void
  pushEvents(tick: number, events: SimEvent[]): void
  setNet(rttMs: number, lossPct: number): void
}

/** Local stats hook (game/stats.ts). Every peer records the matches it plays or watches. */
export interface MatchRecorder {
  /** `devices`: dedicated server only, the device id of each human seat that sent one */
  start(info: { localPlayer: PlayerId; slots: PlayerSlot[]; settings: MatchSettings; devices?: Record<PlayerId, string>; seed?: number }): void
  /**
   * Optional (local replays, game/replay): a confirmed step is about to run from `before`
   * (not yet patched) with these inputs; `patches` = the `connected` changes applied first.
   * Called by the P2P host / offline loop and the input-stream client, never for predicted
   * or re-simulated steps; snapshot-only clients never call it.
   */
  step?(before: SimState, inputs: readonly PlayerInput[], patches?: readonly (readonly [PlayerId, boolean])[]): void
  /** one played tick: its state and the events of every tick since the previous call */
  observe(state: SimState, events: readonly SimEvent[]): void
  finish(result: MatchResult): void
  /** match ended without a result (aborted, rematch mid-match, leave) */
  abort(): void
  /** a human seat's pawn is now played by a bot (its player left) or by its human again */
  control?(player: PlayerId, by: 'human' | 'bot'): void
}

export interface LocalProfile {
  /** stable per-browser player id (game/profile.ts) */
  id: string
  name: string
  /** preferred 0xRRGGBB, granted when free */
  color: number | null
}

export interface SessionDeps {
  ui: UiPort
  profile: () => LocalProfile
  recorder?: MatchRecorder
  frame: FrameSink
  input: { drain(): InputCommand[]; onCommand?(cb: (cmd: InputCommand) => void): () => void }
  audio: { playEvents(events: SimEvent[], listener: Listener): void }
  createMatch: (settings: MatchSettings, slots: PlayerSlot[], seed: number) => SimState
  step: (state: SimState, inputs: PlayerInput[]) => void
  createBot: (player: PlayerId, difficulty: BotDifficulty, seed: number) => Bot
  defaultSettings: MatchSettings
  net: NetFactory
  startClock: StartClock
  now: () => number
  random: () => number
  /** invite link for a room code */
  joinUrl: (code: string) => string
  /** stable per browser tab, lets a reloaded client reclaim its pawn */
  clientKey: () => string
  /** read at every match start; default 'predict' */
  netMode?: () => NetMode
  /** cap of the host fairness delay, ticks (default HOST_DELAY_CAP_TICKS; 0 disables it) */
  hostDelayCapTicks?: number
  /** host relays stamped input frames to the other players on arrival (prediction hints); default true */
  inputHints?: boolean
  /** persistent anonymous device id (game/device.ts): reconnect after a browser restart, future ranked */
  device?: () => string
  /** this build's id (vite define __BUILD_ID__, 'dev-…' for dev builds); dedicated servers refuse other release builds */
  build?: string
}

export interface SessionApi {
  openOffline(): void
  /** `dedicated`: host without a seat of its own (the dedicated server, src/net/dedicated.ts). */
  openHost(opts?: { dedicated?: boolean }): Promise<void>
  /** Join a room by code (typed text or invite link is normalized; invalid input lands in lobby.error). */
  join(code: string): Promise<void>
  addBot(difficulty: BotDifficulty): void
  removeSlot(player: PlayerId): void
  setBotDifficulty(player: PlayerId, difficulty: BotDifficulty): void
  setTeam(player: PlayerId, team: number): void
  updateSettings(patch: Partial<MatchSettings>): void
  startMatch(): void
  /**
   * Results screen, one click. Host / offline: start a new match right away with the
   * same slots and settings and a new seed (clients follow instantly). Client: same
   * as setReady(true).
   */
  rematch(): void
  /** Host / offline: everyone back to the lobby, slots kept. Client: own screen only, between matches. */
  backToLobby(): void
  /** "Wants a rematch" flag, shown to everyone in lobby.ready. Reset when a match starts. */
  setReady(ready: boolean): void
  leave(): void
  /** Link monitor rows, refreshed every STATS_MS (netstats.ts). null when not hosting or joined. */
  netStats(): NetStatsView | null
  /** Fires when a link's grade changes (with hysteresis). Returns unsubscribe. */
  onNetGrade(cb: (e: NetGradeEvent) => void): () => void
  /** How the current room runs: through a dedicated server or peer-to-peer; null offline / idle. */
  transport(): 'server' | 'p2p' | null
  /**
   * Server room: list it in the public room browser (true) or keep it to its code (false,
   * the default). The room owner only; ignored elsewhere.
   */
  setPublic(value: boolean): void
  /** Dedicated server host only: the room's listing and quick-play state (sent with the lobby); cap: humans at most (null: MAX_PLAYERS). */
  setRoom(patch: Partial<RoomState> & { cap?: number | null }): void
  roomState(): RoomState
}

export interface SessionDebug {
  role: NetRole | null
  peers: number
  matchId: number
  tick: number
  unreliable: string[]
  rttMs: number
  delayMs: number
  lossPct: number
  /** net mode of the running match ('classic' for spectators), null without one */
  netMode: NetMode | null
  /** client prediction: predicted tick minus newest snapshot tick */
  predictAhead: number
  /** client prediction: ticks re-simulated by the last / the largest rollback */
  resimTicks: number
  maxResimTicks: number
  /** client prediction: wall ms of the last rollback (clone + re-sim) and the largest so far */
  resimMs: number
  maxResimMs: number
  /** client prediction: own frames the host applied after their stamp; margin ticks of the lead clock */
  lateFrames: number
  marginTicks: number
  /** client prediction: lead the clock aims for (rtt + margin + 2 × jitter), and the snapshot jitter, ms */
  leadMs: number
  jitterMs: number
  /** host fairness delay on the host's own inputs, ticks */
  hostDelayTicks: number
  /** clock pulses handled since the session was created, and wall ms spent in them */
  pulses: number
  pulseMs: number
  /** client, predict mode: the confirmed timeline from the input stream (-1 when not streaming) */
  streamTick: number
  streamChecks: number
  streamDesyncs: number
  /** host: clients receiving the input stream */
  streamPeers: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Strong, distinct player colors on a dark arena. One per slot. */
export const PLAYER_COLORS = [
  0xff3b30, // red
  0x2e7bff, // blue
  0x14e0c8, // teal
  0xa24bff, // purple
  0xffd60a, // yellow
  0xff8c1a, // orange
  0x34c759, // green
  0xff4fa3, // pink
  0xe8e8f0, // white
  0xa86b32, // brown
]
export const MAX_PLAYERS = 10

const DT_MS = 1000 / TICK_HZ
/** at most this much backlog is simulated after a stall; the rest is dropped */
const MAX_CATCHUP_TICKS = 15
/** snapshots above this size go out every 2nd tick (hysteresis down to SNAP_SMALL) */
const SNAP_BIG = 6000
const SNAP_SMALL = 4500
/**
 * Keep ticking briefly after gameOver (the sim's roundEnd phase already showed the
 * banner) so clients play the gameOver tick's events before `end` arrives.
 */
const GAME_OVER_LINGER_MS = 600
const HELLO_TIMEOUT_MS = 10000
const NOTICE_MS = 6000
const NET_STATS_MS = 250
const LISTENER_HALF_WIDTH = 1200
const MAX_QUEUED_CMDS = 256
/** host broadcasts per-player pings this often */
const PING_BROADCAST_MS = 1000
/** stamped frames held on the host at most this far ahead of its tick */
const MAX_HOLD_TICKS = 30
const MAX_SCHED_FRAMES = 256
/**
 * Host fairness: the host's own inputs run this many ticks late at most. The delay
 * follows the median client one-way latency (rtt / 2), re-evaluated every second
 * and moved one tick at a time.
 */
export const HOST_DELAY_CAP_TICKS = 6
const HOST_DELAY_EVAL_TICKS = 60
/** client determinism check cadence (re-simulate one snapshot pair, compare hashes) */
const CHECK_MS = 500
/** the host is always the lobby's first slot */
const HOST_PLAYER_ID = 0
const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['dummy', 'easy', 'medium', 'hard', 'brutal', 'uber']

/** Lobby view of a plain room: not listed, not quick play. Every new lobby starts from it. */
const NO_ROOM: Pick<LobbyView, 'public' | 'quick' | 'autoStart'> = { public: false, quick: false, autoStart: null }

/** Lobby view fields of a server room's state (missing on older servers: a private owner room). */
function roomView(r: RoomState | undefined, now: number): Pick<LobbyView, 'public' | 'quick' | 'autoStart'> {
  return {
    public: r?.public === true,
    quick: r?.quick === true,
    autoStart: r?.auto && Number.isFinite(r.auto.inMs) ? { at: now + Math.max(0, r.auto.inMs), fill: r.auto.fill === true } : null,
  }
}

/** Release builds carry a commit id; dev builds ('dev-…') match anything. */
function isRelease(build: string | undefined): build is string {
  return typeof build === 'string' && build.length > 0 && !build.startsWith('dev-')
}

/** a checkpoint hash rides this many stream packets (loss) */
const HASH_REPEAT_TICKS = 8

// ---------------------------------------------------------------------------

interface RemotePeer {
  t: Transport
  playerId: PlayerId | null
  name: string
  key: string
  receiver: InputReceiver
  queued: InputCommand[]
  /** stamped frames waiting for their tick, seq order (non-decreasing `at`) */
  sched: { at: number; seq: number; cmds: InputCommand[] }[]
  lastAt: number
  /** client → host input packet loss */
  upLoss: LossTracker
  /** latest nstat report from this client, and when it came */
  report: Extract<Msg, { t: 'nstat' }> | null
  reportAt: number
  desyncAt: number
  /** input stream: this client asked for it (`need`); steps to resend from; keyframe due */
  stream: boolean
  needFrom: number
  keyframe: boolean
  /** stream packets sent (counter), and the `to` of the last three, newest first */
  streamN: number
  sentTo: number[]
  /** match id this peer received `start` for */
  matchId: number
  helloTimer: ReturnType<typeof setTimeout> | null
}

/** Host fairness: own inputs delayed by `delay` ticks, shown through a predictor. */
interface HostFairness {
  delay: number
  seq: number
  /** own frames not applied yet; tick = the step that applies it */
  queue: LocalFrame[]
  applied: number
  pred: Predictor | null
}

interface HostMatch {
  id: number
  seed: number
  state: SimState
  settings: MatchSettings
  slots: PlayerSlot[]
  humans: Set<PlayerId>
  bots: Map<PlayerId, Bot>
  /** humans whose pawn a bot drives because they left */
  takeover: Set<PlayerId>
  disconnected: Set<PlayerId>
  /** PlayerScore.connected changes, applied to the next tick's state */
  connectedPatch: Map<PlayerId, boolean>
  recent: TickEvents[]
  /** inputs stepped since the last snapshot went out (snap.in) */
  stepped: PlayerInput[]
  /** confirmed steps for the input stream, and the newest checkpoint hash [tick, hash] */
  history: StreamHistory
  hash: [number, number] | null
  /** host's own net mode at match start */
  netMode: NetMode
  fair: HostFairness
  snapN: number
  interval: number
  acc: number
  last: number
  endAt: number
  winners: PlayerId[] | null
  stop: (() => void) | null
}

interface ClientMatch {
  id: number
  localPlayer: PlayerId
  sender: InputSender
  buffer: SnapshotBuffer
  acc: number
  last: number
  lastStats: number
  stop: (() => void) | null
  netMode: NetMode
  /** predict mode with a pawn; null in classic mode and for spectators */
  pred: Predictor | null
  clock: LeadClock
  /** input packet counter */
  inN: number
  /** first send time per unacked frame seq, for the ack lag */
  sentAt: Map<number, number>
  ackLagMs: number | null
  corr: WindowMax
  rebases: number
  check: { prev: { n: number; state: SimState } | null; last: number; checks: number; desyncs: number; desyncAt: number }
  /** one-shot pulse for the tick that applies an own command (wakeClient) */
  wake: ReturnType<typeof setTimeout> | null
  /** predict mode: the confirmed timeline stepped from the input stream; null in other modes */
  stream: ClientStream | null
}

/** Client side of the input stream (stream.ts). */
interface ClientStream {
  /** confirmed state: the host's state for state.tick (ours, stepped in place) */
  state: SimState
  feed: StreamFeed
  /** highest own input seq that `state` includes */
  ack: number
  arrival: ArrivalClock
  loss: LossTracker
  lastAt: number
  /** checkpoint hashes: ours and the host's, by tick */
  hashes: Map<number, number>
  hostHashes: Map<number, number>
  /** newest checkpoint already compared (a host hash rides several packets) */
  checkedTo: number
  checks: number
  desyncs: number
  desyncAt: number
  /** last `need` sent (gap repair / keyframe request), and whether a keyframe is due */
  needAt: number
  keyframeAsked: boolean
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Bot names: themed and unique within the lobby, so the score strip, plates,
 * kill feed and banners can tell seven bots apart ("Ash, Cinder and Vex win",
 * not "Hard Bot and Hard Bot and Hard Bot"). The difficulty is shown as a tag
 * by the UI. Fallback when every name is taken: "Hard Bot 2".
 */
const BOT_NAMES = ['Ash', 'Cinder', 'Thorn', 'Vex', 'Sable', 'Rook', 'Wisp', 'Pyre', 'Slag', 'Hex', 'Morrow', 'Brand']

function botName(d: BotDifficulty, taken: readonly { name: string }[]): string {
  const used = new Set(taken.map((s) => s.name))
  const free = BOT_NAMES.find((n) => !used.has(n))
  if (free) return free
  for (let i = 2; ; i++) if (!used.has(`${cap(d)} Bot ${i}`)) return `${cap(d)} Bot ${i}`
}

/** Bots of one difficulty share a stats identity, so "you vs Hard bots" is a record. */
function botProfileId(d: BotDifficulty): string {
  return `bot:${d}`
}

function listenerFor(state: SimState, player: PlayerId): Listener {
  const pawn = state.pawns.find((p) => p.owner === player)
  return { x: pawn?.x ?? 0, y: pawn?.y ?? 0, halfWidth: LISTENER_HALF_WIDTH, localPlayer: player, state }
}

function winnersOf(state: SimState): PlayerId[] {
  for (const e of state.events) if (e.type === 'gameOver') return e.winners
  let best = -Infinity
  for (const s of state.scores) best = Math.max(best, s.score)
  return state.scores.filter((s) => s.score === best).map((s) => s.id)
}

export function createSession(deps: SessionDeps): SessionApi & { debug(): SessionDebug } {
  const { ui, frame: out } = deps

  let role: NetRole | null = null
  /** bumped on every open / leave; async continuations from an older epoch bail out */
  let epoch = 0
  let slots: PlayerSlot[] = []
  let settings: MatchSettings = { ...deps.defaultSettings }
  let localPlayer: PlayerId = 0
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let ready: Record<PlayerId, boolean> = {}
  let pings: Record<PlayerId, number> = {}
  let pingTimer: ReturnType<typeof setInterval> | null = null
  const rec = deps.recorder
  // host
  let endpoint: HostEndpoint | null = null
  let peers: RemotePeer[] = []
  const slotKeys = new Map<PlayerId, string>()
  /** persistent device id per seat: a returning device reclaims a disconnected seat */
  const slotDevices = new Map<PlayerId, string>()
  /** host without a seat (dedicated server): the first connected human owns the room */
  let dedicated = false
  // client: the room runs on a dedicated server; its owner seat; the code joined
  let serverRoom = false
  let owner: PlayerId = -1
  /** dedicated host: listing / quick-play state; `autoAt` is the session clock of the auto start */
  let roomInfo: { public: boolean; quick: boolean; autoAt: number | null; autoFill: boolean; cap: number | null } = { public: false, quick: false, autoAt: null, autoFill: false, cap: null }
  let joinedCode: string | null = null
  let unsubScreen: (() => void) | null = null
  let matchCounter = 0
  let match: HostMatch | null = null

  // client
  let link: Transport | null = null
  let cmatch: ClientMatch | null = null
  let welcomeDone: (() => void) | null = null
  let welcomeTimer: ReturnType<typeof setTimeout> | null = null
  /** this client's uplink loss as the host measured it (pings.ul) */
  let upLossSeen: number | null = null

  // link monitor (both roles)
  let statsTimer: ReturnType<typeof setInterval> | null = null
  let statsView: NetStatsView | null = null
  const grades = new Map<PlayerId, GradeTracker>()
  const gradeCbs = new Set<(e: NetGradeEvent) => void>()
  const netMode = (): NetMode => {
    const v = deps.netMode?.()
    return v === 'classic' || v === 'snapshot' ? v : 'predict'
  }
  /** clock pulse count and cost (debug) */
  const pulseStats = { n: 0, ms: 0 }
  const metered = (run: () => void) => {
    const a = deps.now()
    run()
    pulseStats.n++
    pulseStats.ms += deps.now() - a
  }
  const hostDelayCap = deps.hostDelayCapTicks ?? HOST_DELAY_CAP_TICKS

  // -------------------------------------------------------------------------
  // shared helpers
  // -------------------------------------------------------------------------

  const isAuthority = () => role === 'offline' || role === 'host'
  const canEdit = () => isAuthority() && match === null

  function freeId(): PlayerId {
    let id = 0
    while (slots.some((s) => s.id === id)) id++
    return id
  }

  function freeColor(preferred: number | null = null): number {
    if (preferred !== null && !slots.some((s) => s.color === preferred)) return preferred
    return PLAYER_COLORS.find((c) => !slots.some((s) => s.color === c)) ?? PLAYER_COLORS[slots.length % PLAYER_COLORS.length]
  }

  function addSlot(slot: Omit<PlayerSlot, 'color' | 'team' | 'id'>, preferredColor: number | null = null): PlayerSlot {
    const s: PlayerSlot = { id: freeId(), color: freeColor(preferredColor), team: slots.length % 2, ...slot }
    slots.push(s)
    return s
  }

  function broadcast(msg: Msg, onlyMatch = -1): void {
    const data = encode(msg)
    for (const p of peers) {
      if (p.playerId === null) continue
      if (onlyMatch >= 0 && p.matchId !== onlyMatch) continue
      p.t.sendReliable(data)
    }
  }

  function publishLobby(): void {
    ui.setLobby({ slots: slots.map((s) => ({ ...s })), settings: { ...settings }, localPlayer, ready: { ...ready }, pings: { ...pings } })
    if (role === 'host') broadcast(dedicated ? lobbyMsg() : { t: 'lobby', slots, settings, ready, pings })
  }

  /** Dedicated server: the lobby message with the owner and the room state. */
  function lobbyMsg(): Msg {
    return { t: 'lobby', slots, settings, ready, pings, owner: ownerId(), room: roomStateNow() }
  }

  function roomStateNow(): RoomState {
    const r = roomInfo
    return { public: r.public, quick: r.quick, auto: r.autoAt === null ? null : { inMs: Math.max(0, Math.round(r.autoAt - deps.now())), fill: r.autoFill } }
  }

  /** Dedicated server: the first connected human seat owns the room (lobby controls); quick-play rooms have no owner. */
  function ownerId(): PlayerId {
    if (!dedicated || roomInfo.quick) return -1
    const gone = match?.disconnected
    return slots.find((s) => s.kind === 'human' && !gone?.has(s.id))?.id ?? -1
  }

  /** Client in a server room that owns it: lobby actions go to the server as `ctl`. */
  function ownerCtl(msg: Extract<Msg, { t: 'ctl' }>): boolean {
    if (role !== 'client' || !serverRoom || owner !== localPlayer || localPlayer < 0 || !link) return false
    link.sendReliable(encode(msg))
    return true
  }

  /**
   * Host, ~1 Hz: per-player pings from each link's RTT. Always sent (unreliable, a
   * lost one is replaced a second later); the store only changes when a value does.
   */
  function updatePings(): void {
    if (role !== 'host') return
    const next: Record<PlayerId, number> = localPlayer >= 0 ? { [localPlayer]: 0 } : {}
    for (const p of peers) if (p.playerId !== null) next[p.playerId] = Math.round(p.t.rtt)
    setPings(next)
    const ul: Record<PlayerId, number> = {}
    for (const p of peers) {
      const v = p.playerId !== null ? p.upLoss.pct : null
      if (v !== null) ul[p.playerId!] = Math.round(v * 10) / 10
    }
    const data = encode({ t: 'pings', pings, ul })
    for (const p of peers) if (p.playerId !== null) p.t.sendUnreliable(data)
  }

  function setPings(next: Record<PlayerId, number>): void {
    const same =
      Object.keys(next).length === Object.keys(pings).length &&
      Object.entries(next).every(([k, v]) => pings[Number(k)] === v)
    if (same) return
    pings = next
    ui.setLobby({ pings: { ...pings } })
  }

  function setReadyFlags(next: Record<PlayerId, boolean>): void {
    ready = next
    publishLobby()
  }

  function showNotice(text: string, toClients = false): void {
    ui.setLobby({ notice: text })
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => {
      noticeTimer = null
      if (ui.lobby().notice === text) ui.setLobby({ notice: null })
    }, NOTICE_MS)
    if (toClients && role === 'host') broadcast({ t: 'notice', text })
  }

  function tryCreateBot(id: PlayerId, d: BotDifficulty, seed: number): Bot | null {
    try {
      return deps.createBot(id, d, (seed ^ Math.imul(id + 1, 0x9e3779b1)) >>> 0)
    } catch (e) {
      console.warn(`[session] bot for player ${id} unavailable, its pawn idles`, e)
      return null
    }
  }

  /** Drop every connection, loop and timer. Leaves the store's lobby fields to the caller. */
  function teardown(): void {
    epoch++
    if (match) {
      match.stop?.()
      match = null
    }
    for (const p of peers) {
      if (p.helloTimer) clearTimeout(p.helloTimer)
      p.t.close()
    }
    peers = []
    endpoint?.close()
    endpoint = null
    unsubScreen?.()
    unsubScreen = null
    slotKeys.clear()
    slotDevices.clear()
    dedicated = false
    serverRoom = false
    owner = -1
    roomInfo = { public: false, quick: false, autoAt: null, autoFill: false, cap: null }
    joinedCode = null
    stopClientMatch()
    link?.close()
    link = null
    if (welcomeTimer) clearTimeout(welcomeTimer)
    welcomeTimer = null
    welcomeDone?.()
    welcomeDone = null
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = null
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = null
    if (statsTimer) clearInterval(statsTimer)
    statsTimer = null
    statsView = null
    grades.clear()
    upLossSeen = null
    ready = {}
    pings = {}
    rec?.abort()
    role = null
    out.reset()
    out.setLocalPlayer(-1)
    out.setNet(0, 0)
  }

  /** Fatal: back to the menu with a friendly message. */
  function fail(message: string): void {
    teardown()
    ui.setLobby({ role: 'offline', joinUrl: null, roomCode: null, status: 'error', error: message, notice: null, ...NO_ROOM })
    ui.setScreen('menu')
  }

  /** `seat`: false for a dedicated server, which hosts without playing (localPlayer -1). */
  function openLobby(r: NetRole, status: LobbyView['status'], seat = true): void {
    role = r
    settings = { ...deps.defaultSettings }
    localPlayer = seat ? 0 : -1
    slots = []
    ready = {}
    pings = r === 'host' && seat ? { 0: 0 } : {}
    const me = deps.profile()
    if (seat) addSlot({ name: me.name, kind: 'human', profileId: me.id }, me.color)
    ui.setResult(null)
    // a new lobby never inherits the last room's quick-play / listing state (it would hide the host's Rematch)
    ui.setLobby({ role: r, joinUrl: null, roomCode: null, status, error: null, notice: null, ...NO_ROOM })
    publishLobby()
    ui.setScreen('lobby')
  }

  // -------------------------------------------------------------------------
  // host: connections
  // -------------------------------------------------------------------------

  function acceptPeer(t: Transport): void {
    if (role !== 'host') {
      t.close()
      return
    }
    const p: RemotePeer = {
      t,
      playerId: null,
      name: '',
      key: '',
      receiver: new InputReceiver(),
      queued: [],
      sched: [],
      lastAt: 0,
      upLoss: new LossTracker(),
      report: null,
      reportAt: -1,
      desyncAt: -Infinity,
      stream: false,
      needFrom: -1,
      keyframe: false,
      streamN: 0,
      sentTo: [],
      matchId: -1,
      helloTimer: null,
    }
    peers.push(p)
    p.helloTimer = setTimeout(() => {
      if (p.playerId === null) {
        t.close()
        peers = peers.filter((x) => x !== p)
      }
    }, HELLO_TIMEOUT_MS)
    t.onMessage((d) => onClientMessage(p, d))
    t.onClose(() => peerGone(p, 'disconnected'))
  }

  function rejectPeer(p: RemotePeer, message: string): void {
    p.t.sendReliable(encode({ t: 'error', message }))
    p.t.close()
    peers = peers.filter((x) => x !== p)
  }

  function onClientMessage(p: RemotePeer, data: string): void {
    const m = decode(data)
    if (!m) return
    if (m.t === 'hello') onHello(p, m)
    else if (m.t === 'input') onInput(p, m)
    else if (m.t === 'nstat') onReport(p, m)
    else if (m.t === 'need') onNeed(p, m)
    else if (m.t === 'ctl') onCtl(p, m)
    else if (m.t === 'ready') {
      if (p.playerId !== null && !match) setReadyFlags({ ...ready, [p.playerId]: m.ready === true })
    }
    else if (m.t === 'leave') {
      p.t.close()
      peerGone(p, 'left')
    }
  }

  function sendStart(p: RemotePeer, m: HostMatch): void {
    const id = p.playerId!
    const plays = m.humans.has(id) && !m.disconnected.has(id)
    p.matchId = m.id
    p.receiver = new InputReceiver()
    p.queued = []
    p.sched = []
    p.lastAt = 0
    p.upLoss = new LossTracker()
    p.report = null
    p.reportAt = -1
    p.stream = false
    p.needFrom = -1
    p.keyframe = false
    p.streamN = 0
    p.sentTo = []
    p.t.sendReliable(
      encode({
        t: 'start',
        match: m.id,
        seed: m.seed,
        slots: m.slots,
        settings: m.settings,
        localPlayer: plays ? id : -1,
      }),
    )
  }

  function onHello(p: RemotePeer, m: Extract<Msg, { t: 'hello' }>): void {
    if (p.playerId !== null) return
    if (p.helloTimer) clearTimeout(p.helloTimer)
    p.helloTimer = null
    if (m.version !== PROTOCOL_VERSION) {
      rejectPeer(p, `Version mismatch (host v${PROTOCOL_VERSION}, you v${String(m.version)}). Reload the page to update.`)
      return
    }
    // a dedicated server runs one release; every other release build would mispredict
    if (dedicated && isRelease(deps.build) && isRelease(m.build) && m.build !== deps.build) {
      rejectPeer(p, 'This server runs a different version of the game. Reload the page; if that does not help, the server is being updated.')
      return
    }
    p.name = sanitizeName(m.name)
    p.key = typeof m.key === 'string' ? m.key.slice(0, 64) : ''
    const device = sanitizeProfileId(m.device)

    // a reloaded / reconnected client takes its pawn back (same tab key, or same device
    // after a browser restart)
    if (match && (p.key || device)) {
      const m2 = match
      const gone = [...m2.disconnected]
      const back = gone.find((id) => p.key && slotKeys.get(id) === p.key) ?? gone.find((id) => device && slotDevices.get(id) === device)
      if (back !== undefined) {
        peers = peers.filter((x) => x === p || x.playerId !== back)
        p.playerId = back
        slotKeys.set(back, p.key)
        m2.disconnected.delete(back)
        if (m2.takeover.delete(back)) {
          m2.bots.delete(back)
          rec?.control?.(back, 'human')
        }
        m2.connectedPatch.set(back, true)
        p.t.sendReliable(encode(welcomeFor(back)))
        p.t.sendReliable(encode(dedicated ? lobbyMsg() : { t: 'lobby', slots, settings, ready, pings }))
        sendStart(p, m2)
        showNotice(`${p.name} reconnected`, true)
        return
      }
    }

    if (slots.length >= MAX_PLAYERS || (roomInfo.cap !== null && slots.filter((s) => s.kind === 'human').length >= roomInfo.cap)) {
      rejectPeer(p, 'The lobby is full.')
      return
    }
    const profileId = sanitizeProfileId(m.profileId)
    const slot = addSlot({ name: p.name, kind: 'human', ...(profileId ? { profileId } : {}) }, sanitizeColor(m.color))
    slotKeys.set(slot.id, p.key)
    if (device) slotDevices.set(slot.id, device)
    p.playerId = slot.id
    p.t.sendReliable(encode(welcomeFor(slot.id)))
    publishLobby()
    // joined mid-match: spectate now, play from the next match
    if (match) sendStart(p, match)
    showNotice(`${p.name} joined`)
  }

  function welcomeFor(id: PlayerId): Msg {
    return dedicated ? { t: 'welcome', playerId: id, server: { build: deps.build ?? 'unknown' } } : { t: 'welcome', playerId: id }
  }

  /** Dedicated server: the room owner's lobby controls (validated, then the host API). */
  function onCtl(p: RemotePeer, m: Extract<Msg, { t: 'ctl' }>): void {
    if (!dedicated || p.playerId === null || p.playerId !== ownerId()) return
    const player = Number.isInteger(m.player) ? (m.player as PlayerId) : -1
    const difficulty = BOT_DIFFICULTIES.includes(m.difficulty as BotDifficulty) ? (m.difficulty as BotDifficulty) : null
    switch (m.op) {
      case 'addBot':
        if (difficulty) api.addBot(difficulty)
        break
      case 'removeSlot':
        if (player !== p.playerId) api.removeSlot(player)
        break
      case 'setBotDifficulty':
        if (difficulty) api.setBotDifficulty(player, difficulty)
        break
      case 'setTeam':
        if (typeof m.team === 'number') api.setTeam(player, m.team)
        break
      case 'settings':
        api.updateSettings(sanitizeSettingsPatch(m.settings, deps.defaultSettings))
        break
      case 'start':
        api.startMatch()
        break
      case 'rematch':
        if (!match || ui.screen() === 'results') api.rematch()
        break
      case 'lobby':
        api.backToLobby()
        break
      case 'visibility':
        api.setRoom({ public: m.public === true })
        break
    }
  }

  function onInput(p: RemotePeer, m: Extract<Msg, { t: 'input' }>): void {
    const mt = match
    const id = p.playerId
    if (!mt || id === null || m.match !== mt.id || p.matchId !== mt.id) return
    if (!mt.humans.has(id) || mt.disconnected.has(id)) return
    if (typeof m.n === 'number') p.upLoss.track(m.n)
    let hints: [number, InputCommand[]][] | null = null
    for (const f of p.receiver.accept(sanitizeFrames(m.inputs))) {
      if (m.s === 1) {
        const at = schedule(p, mt, f)
        if (f.cmds.length) (hints ??= []).push([at, f.cmds])
      } else for (const c of f.cmds) if (p.queued.length < MAX_QUEUED_CMDS) p.queued.push(c)
    }
    if (hints) relayHints(mt, id, hints, p)
  }

  /** Prediction hints: a player's stamped frames, to every other streaming client, on arrival. */
  function relayHints(mt: HostMatch, player: PlayerId, frames: [number, InputCommand[]][], from: RemotePeer | null): void {
    if (deps.inputHints === false) return
    let data: string | null = null
    for (const q of peers) {
      if (q === from || !q.stream || q.matchId !== mt.id || q.playerId === null) continue
      data ??= encode({ t: 'hint', m: mt.id, p: player, f: frames })
      q.t.sendUnreliable(data)
    }
  }

  /** Stream mode: a client wants steps from a tick (start, gap) or a keyframe (desync). */
  function onNeed(p: RemotePeer, m: Extract<Msg, { t: 'need' }>): void {
    const mt = match
    if (!mt || p.playerId === null || m.m !== mt.id || p.matchId !== mt.id) return
    p.stream = true
    if (m.k === 1 || !Number.isInteger(m.from) || !mt.history.covers(m.from)) p.keyframe = true
    else p.needFrom = p.needFrom < 0 ? m.from : Math.min(p.needFrom, m.from)
  }

  /**
   * A stamped frame runs in the step from its tick: held while early (up to
   * MAX_HOLD_TICKS), applied in the next step when late. Never reordered.
   */
  function schedule(p: RemotePeer, mt: HostMatch, f: InputFrame): number {
    const next = mt.state.tick
    if (p.sched.length >= MAX_SCHED_FRAMES) {
      for (const x of p.sched) x.at = next
      p.lastAt = next
    }
    let at = Math.floor(f.tick)
    if (!(at >= next)) at = next
    if (at > next + MAX_HOLD_TICKS) at = next + MAX_HOLD_TICKS
    if (at < p.lastAt) at = p.lastAt
    p.lastAt = at
    p.sched.push({ at, seq: f.seq, cmds: f.cmds })
    return at
  }

  function onReport(p: RemotePeer, m: Extract<Msg, { t: 'nstat' }>): void {
    const mt = match
    if (!mt || p.playerId === null || m.match !== mt.id || p.matchId !== mt.id) return
    const r: Extract<Msg, { t: 'nstat' }> = {
      t: 'nstat',
      match: m.match,
      dl: sanitizeMetric(m.dl),
      sa: sanitizeMetric(m.sa),
      al: sanitizeMetric(m.al),
      cp: sanitizeMetric(m.cp),
      ds: sanitizeMetric(m.ds),
    }
    const now = deps.now()
    if (r.ds !== null && r.ds > (p.report?.ds ?? 0)) p.desyncAt = now
    p.report = r
    p.reportAt = now
  }

  function peerGone(p: RemotePeer, why: 'left' | 'disconnected'): void {
    if (!peers.includes(p)) return
    if (p.helloTimer) clearTimeout(p.helloTimer)
    peers = peers.filter((x) => x !== p)
    const id = p.playerId
    if (id === null) return
    const m = match
    if (m && m.humans.has(id)) {
      // B21-style: keep the pawn (and the slot) so the player can come back
      m.disconnected.add(id)
      m.connectedPatch.set(id, false)
      let text = `${p.name} ${why === 'left' ? 'left' : 'disconnected'}`
      if (m.settings.botsReplaceLeavers) {
        const bot = tryCreateBot(id, 'medium', m.seed)
        if (bot) {
          m.bots.set(id, bot)
          m.takeover.add(id)
          text += ', a bot took over'
          rec?.control?.(id, 'bot')
        }
      }
      showNotice(text, true)
      // the room owner may have changed
      if (dedicated) publishLobby()
    } else {
      slots = slots.filter((s) => s.id !== id)
      slotKeys.delete(id)
      slotDevices.delete(id)
      publishLobby()
      showNotice(`${p.name} left`, true)
    }
  }

  // -------------------------------------------------------------------------
  // host / offline: match loop
  // -------------------------------------------------------------------------

  function hostPulse(m: HostMatch, now: number): void {
    if (match !== m) return
    if (role === 'offline' && ui.paused()) {
      m.last = now
      return
    }
    m.acc += now - m.last
    m.last = now
    if (m.acc > MAX_CATCHUP_TICKS * DT_MS) m.acc = MAX_CATCHUP_TICKS * DT_MS
    while (m.acc >= DT_MS && match === m) {
      m.acc -= DT_MS
      try {
        hostTick(m, now - m.acc)
      } catch (e) {
        console.error('[session] simulation error', e)
        abortMatch(m, `Simulation error: ${errMsg(e)}`)
        return
      }
    }
    if (match === m && m.endAt >= 0 && now >= m.endAt) finishMatch(m)
  }

  function hostTick(m: HostMatch, at: number): void {
    const cur = m.state
    const tick = cur.tick
    const inputs: PlayerInput[] = []
    const local = quantizeCmds(deps.input.drain())
    const f = m.fair
    if (local.length && m.humans.has(localPlayer)) {
      if (f.pred) {
        // fairness: runs `delay` ticks from now, already applied in the host's predicted view
        const frame = { seq: ++f.seq, tick: f.pred.stampNext(), cmds: local }
        f.queue.push(frame)
        f.pred.local(frame)
        relayHints(m, localPlayer, [[frame.tick, local]], null)
      } else inputs.push({ player: localPlayer, tick, cmds: local })
    }
    if (f.queue.length && f.queue[0].tick <= tick) {
      const cmds: InputCommand[] = []
      while (f.queue.length && f.queue[0].tick <= tick) {
        const q = f.queue.shift()!
        for (const c of q.cmds) cmds.push(c)
        f.applied = q.seq
      }
      inputs.push({ player: localPlayer, tick, cmds })
    }
    let acks: Map<PlayerId, number> | undefined
    for (const p of peers) {
      if (p.playerId === null || p.matchId !== m.id) continue
      let cmds = p.queued
      while (p.sched.length && p.sched[0].at <= tick) for (const c of p.sched.shift()!.cmds) cmds.push(c)
      if (cmds.length) {
        inputs.push({ player: p.playerId, tick, cmds })
        p.queued = []
        // the stream tells the client which of its frames this step includes
        ;(acks ??= new Map()).set(p.playerId, ackOf(p))
      }
    }
    for (const [id, bot] of m.bots) {
      try {
        const cmds = quantizeCmds(bot.think(cur))
        if (cmds.length) inputs.push({ player: id, tick, cmds })
      } catch (e) {
        console.error(`[session] bot ${id} crashed, its pawn idles`, e)
        m.bots.delete(id)
      }
    }

    // the previous state was handed to render: step a copy (plain data: cloneState is
    // the same deep copy as structuredClone, ~4× cheaper)
    const next = cloneState(cur)
    const patched = m.connectedPatch.size > 0
    let patches: [PlayerId, boolean][] | undefined
    if (m.connectedPatch.size) {
      patches = [...m.connectedPatch]
      for (const [id, c] of m.connectedPatch) {
        const sc = next.scores.find((s) => s.id === id)
        if (sc) sc.connected = c
      }
      m.connectedPatch.clear()
    }
    rec?.step?.(cur, inputs, patches)
    deps.step(next, inputs)
    m.state = next
    if (inputs.length) for (const i of inputs) m.stepped.push(i)
    const step: StreamTick = { tick, inputs }
    if (acks) step.acks = acks
    if (patches) step.patches = patches
    m.history.push(step)

    rec?.observe(next, next.events)
    if (next.events.length) m.recent.push({ tick: next.tick, events: next.events })
    if (m.netMode !== 'classic' && next.tick % HOST_DELAY_EVAL_TICKS === 0) updateHostDelay(m)
    if (!f.pred && f.delay > 0) f.pred = new Predictor(localPlayer, deps.step, cloneState, deps.now)
    if (f.pred) {
      // the host's view: its own delayed inputs predicted, display ticks `delay` ahead
      // only the host's own frames (at their stamps) stepped: the predicted view already holds `next`
      const confirms = !patched && inputs.every((i) => i.player === localPlayer)
      f.pred.offer(next, f.applied, next.events.length ? [{ tick: next.tick, events: next.events }] : [], confirms)
      const goal = next.tick + f.delay
      f.pred.advance(goal, (display, events) => {
        out.pushState(display, at + (display.tick - goal) * DT_MS)
        out.pushEvents(display.tick, events)
        deps.audio.playEvents(events, listenerFor(display, localPlayer))
      })
    } else {
      out.pushState(next, at)
      if (next.events.length) out.pushEvents(next.tick, next.events)
      // every tick, even without events: audio re-aims projectile travel loops
      deps.audio.playEvents(next.events, listenerFor(next, localPlayer))
    }
    while (m.recent.length && m.recent[0].tick <= next.tick - EVENT_REDUNDANCY_TICKS) m.recent.shift()
    sendToPeers(m, next)

    if (m.endAt < 0 && next.phase === 'gameOver') {
      m.endAt = at + GAME_OVER_LINGER_MS
      m.winners = winnersOf(next)
    }
  }

  /** Highest input seq of this peer that the authoritative state includes (sched frames wait). */
  function ackOf(p: RemotePeer): number {
    return p.sched.length ? p.sched[0].seq - 1 : p.receiver.lastSeq
  }

  /**
   * After every step: the input stream to the clients that stream, snapshots to the
   * rest (snapshot / classic mode, spectators) and as keyframes. The stream goes out
   * the same tick it is stepped: no batching, nobody waits for anybody's inputs.
   */
  function sendToPeers(m: HostMatch, s: SimState): void {
    let snaps = false
    let streams = false
    for (const p of peers) {
      if (p.playerId === null || p.matchId !== m.id) continue
      if (p.stream && !p.keyframe) streams = true
      else snaps = true
    }
    if (snaps) sendSnapshots(m, s)
    else m.stepped.length = 0
    if (streams) sendStream(m, s)
  }

  function sendSnapshots(m: HostMatch, s: SimState): void {
    const keyframes = peers.some((p) => p.keyframe && p.matchId === m.id)
    if (s.tick % m.interval !== 0 && !keyframes) return
    const stateJson = stateJsonWithoutEvents(s)
    if (stateJson.length > SNAP_BIG) m.interval = 2
    else if (stateJson.length < SNAP_SMALL) m.interval = 1
    const evJson = JSON.stringify(m.recent)
    const inJson = JSON.stringify(m.stepped)
    m.stepped.length = 0
    const n = ++m.snapN
    for (const p of peers) {
      if (p.playerId === null || p.matchId !== m.id || (p.stream && !p.keyframe)) continue
      // frames still waiting for their tick are not in this state
      p.t.sendUnreliable(encodeSnap(m.id, n, m.interval, ackOf(p), evJson, stateJson, inJson))
      // a keyframe restarts the stream at this state's tick
      p.keyframe = false
    }
  }

  /** The newest REDUNDANCY steps every tick (shared body), a resend from `needFrom` once. */
  function sendStream(m: HostMatch, s: SimState): void {
    const to = s.tick
    const h = m.history
    if (h.end !== to) return
    // checkpoint hash: computed only when someone streams, repeated a few ticks against loss
    if (to % HASH_EVERY === 0) m.hash = [to, hashState({ ...s, events: [] })]
    const hashJson = m.hash && to - m.hash[0] < HASH_REPEAT_TICKS ? `,"h":${JSON.stringify(m.hash)}` : ''
    const bodies = new Map<number, string>()
    const body = (from: number) => {
      let b = bodies.get(from)
      if (b === undefined) {
        const { i, c } = h.slice(from, to)
        b = `"to":${to},"r":${to - from}${i.length ? `,"i":${JSON.stringify(i)}` : ''}${c.length ? `,"c":${JSON.stringify(c)}` : ''}${hashJson}`
        bodies.set(from, b)
      }
      return b
    }
    const recent = Math.max(to - REDUNDANCY, h.start)
    // a step with inputs goes out the tick it is stepped; empty stretches as a heartbeat
    const content = h.hasContent(recent, to) || to % HASH_EVERY === 0
    for (const p of peers) {
      if (p.playerId === null || p.matchId !== m.id || !p.stream || p.keyframe) continue
      let from: number
      if (p.needFrom >= 0 && p.needFrom < recent) {
        if (!h.covers(p.needFrom)) {
          p.keyframe = true
          p.needFrom = -1
          continue
        }
        from = p.needFrom
      } else {
        const last = p.sentTo.length ? p.sentTo[0] : -1
        if (!content && p.needFrom < 0 && last >= 0 && to - last < HEARTBEAT_TICKS) continue
        // reach back three packets: empty steps ride as many packets as steps with inputs
        // (the range costs nothing, empty steps are implied)
        const back = p.sentTo.length >= 2 ? p.sentTo[p.sentTo.length - 1] : recent
        from = Math.max(Math.min(recent, back), h.start)
      }
      p.needFrom = -1
      p.sentTo.unshift(to)
      if (p.sentTo.length > 2) p.sentTo.length = 2
      p.t.sendUnreliable(encodeStreamPacket(m.id, ++p.streamN, ackOf(p), body(from)))
    }
  }

  /**
   * Fairness: the host's own inputs run as late as a typical client's reach the
   * host (median one-way latency, capped). Set at match start (lobby probes know the
   * RTT), then moved one tick per evaluation.
   */
  function updateHostDelay(m: HostMatch, jump = false): void {
    // nothing to equalize when the host does not play (dedicated server, spectating host)
    if (!m.humans.has(localPlayer)) {
      m.fair.delay = 0
      return
    }
    const oneWay: number[] = []
    for (const p of peers) {
      const id = p.playerId
      if (id === null || p.matchId !== m.id || !m.humans.has(id) || m.disconnected.has(id) || p.t.rtt <= 0) continue
      oneWay.push(p.t.rtt / 2)
    }
    oneWay.sort((a, b) => a - b)
    const mid = oneWay.length >> 1
    const median = oneWay.length === 0 ? 0 : oneWay.length % 2 ? oneWay[mid] : (oneWay[mid - 1] + oneWay[mid]) / 2
    const target = Math.min(hostDelayCap, Math.round(median / DT_MS))
    m.fair.delay = jump ? target : m.fair.delay + Math.sign(target - m.fair.delay)
  }

  function finishMatch(m: HostMatch): void {
    m.stop?.()
    match = null
    const s = m.state
    const result: MatchResult = {
      winners: m.winners ?? winnersOf(s),
      slots: s.slots,
      scores: s.scores,
      rounds: s.round,
      ticks: s.tick,
    }
    recordResult(result)
    ready = {}
    ui.setResult(result)
    ui.setScreen('results')
    broadcast({ t: 'end', match: m.id, result }, m.id)
    // humans who left during the match free their lobby slot now
    if (m.disconnected.size) {
      slots = slots.filter((x) => !m.disconnected.has(x.id))
      for (const id of m.disconnected) slotKeys.delete(id)
      publishLobby()
    }
  }

  /** Local stats; a broken recorder must never break the session. */
  function recordResult(result: MatchResult): void {
    try {
      rec?.finish(result)
    } catch (e) {
      console.error('[session] recording match stats failed', e)
    }
  }

  /** End the running match without a result (rematch / back to lobby mid-match). */
  function stopMatch(m: HostMatch): void {
    m.stop?.()
    match = null
    rec?.abort()
  }

  function abortMatch(m: HostMatch, reason: string): void {
    m.stop?.()
    match = null
    rec?.abort()
    ui.setLobby({ error: reason })
    ui.setScreen('lobby')
    broadcast({ t: 'notice', text: reason })
    broadcast({ t: 'screen', screen: 'lobby' })
  }

  // -------------------------------------------------------------------------
  // client
  // -------------------------------------------------------------------------

  function stopClientMatch(): void {
    if (!cmatch) return
    cmatch.stop?.()
    cmatch = null
    rec?.abort()
  }

  function onHostMessage(data: string): void {
    const m = decode(data)
    if (!m) return
    switch (m.t) {
      case 'welcome':
        localPlayer = m.playerId
        // a dedicated server hosts the room: the invite link is a server room link too
        serverRoom = !!m.server
        ui.setLobby({ localPlayer, status: 'open', notice: null, ...(serverRoom && joinedCode ? { joinUrl: deps.joinUrl(joinedCode) } : {}) })
        if (welcomeTimer) clearTimeout(welcomeTimer)
        welcomeTimer = null
        welcomeDone?.()
        welcomeDone = null
        break
      case 'lobby':
        slots = m.slots
        settings = m.settings
        ready = m.ready ?? {}
        pings = m.pings ?? {}
        owner = typeof m.owner === 'number' ? m.owner : -1
        // the owner of a server room gets the host's lobby controls (sent to the server as ctl)
        ui.setLobby({
          slots: m.slots,
          settings: m.settings,
          localPlayer,
          ready: { ...ready },
          pings: { ...pings },
          role: serverRoom && owner === localPlayer && localPlayer >= 0 ? 'host' : 'client',
          // a P2P host sends no room state: a plain room
          ...roomView(serverRoom ? m.room : undefined, deps.now()),
        })
        break
      case 'pings':
        setPings(m.pings ?? {})
        upLossSeen = sanitizeMetric(m.ul?.[localPlayer])
        break
      case 'start':
        clientStart(m)
        break
      case 'snap': {
        const cm = cmatch
        if (!cm || m.match !== cm.id) return
        const now = deps.now()
        noteAck(cm, m.ack, now)
        cm.sender.ack(m.ack)
        if (cm.stream) {
          onKeyframe(cm, cm.stream, m, now)
          break
        }
        cm.buffer.push(m, now)
        if (cm.pred) cm.pred.offer(m.state, m.ack, m.ev, confirmsPrediction(cm, cm.pred, m))
        checkDeterminism(cm, m, now)
        break
      }
      case 'is': {
        const cm = cmatch
        if (cm?.stream && m.m === cm.id) onStream(cm, cm.stream, m)
        break
      }
      case 'hint': {
        const cm = cmatch
        if (!cm?.pred || m.m !== cm.id || !Array.isArray(m.f)) return
        for (const f of m.f) if (Array.isArray(f) && typeof f[0] === 'number' && Array.isArray(f[1])) cm.pred.hint(m.p, f[0], f[1])
        break
      }
      case 'end':
        if (cmatch && cmatch.id !== m.match) return
        if (cmatch) recordResult(m.result)
        stopClientMatch()
        ui.setResult(m.result)
        ui.setScreen('results')
        break
      case 'screen':
        if (!cmatch && ui.screen() === 'results') ui.setScreen('lobby')
        else if (cmatch) {
          stopClientMatch()
          ui.setScreen('lobby')
        }
        break
      case 'notice':
        showNotice(m.text)
        break
      case 'kick':
        fail(m.reason || 'The host removed you from the lobby.')
        break
      case 'leave':
        fail('The host closed the game.')
        break
      case 'error':
        fail(m.message)
        break
    }
  }

  function clientStart(m: Extract<Msg, { t: 'start' }>): void {
    stopClientMatch()
    const now = deps.now()
    // spectators have nothing to predict: they watch the smooth delayed stream
    const mode: NetMode = m.localPlayer >= 0 ? netMode() : 'classic'
    const predicting = mode !== 'classic'
    const cm: ClientMatch = {
      id: m.match,
      localPlayer: m.localPlayer,
      sender: new InputSender(),
      buffer: new SnapshotBuffer(),
      acc: 0,
      last: now,
      lastStats: -Infinity,
      stop: null,
      netMode: mode,
      pred: predicting ? new Predictor(m.localPlayer, deps.step, cloneState, deps.now) : null,
      clock: new LeadClock(),
      inN: 0,
      sentAt: new Map(),
      ackLagMs: null,
      corr: new WindowMax(1000),
      rebases: 0,
      check: { prev: null, last: -Infinity, checks: 0, desyncs: 0, desyncAt: -Infinity },
      wake: null,
      stream: null,
    }
    if (mode === 'predict') {
      // the start state is deterministic: build it locally and ask for the stream from tick 0
      // (a host further along answers with a keyframe)
      try {
        const state = deps.createMatch(m.settings, m.slots, m.seed)
        cm.stream = {
          state,
          feed: new StreamFeed(),
          ack: 0,
          arrival: new ArrivalClock(),
          loss: new LossTracker(),
          lastAt: -Infinity,
          hashes: new Map(),
          hostHashes: new Map(),
          checkedTo: -1,
          checks: 0,
          desyncs: 0,
          desyncAt: -Infinity,
          needAt: now,
          keyframeAsked: false,
        }
        cm.stream.feed.reset(state.tick)
        cm.pred!.offer(cloneState(state), 0)
        link?.sendReliable(encode({ t: 'need', m: m.match, from: state.tick }))
      } catch (e) {
        console.warn('[session] input stream unavailable, using snapshots', e)
        cm.stream = null
      }
    }
    cmatch = cm
    ready = {}
    ui.setLobby({ ready: {} })
    rec?.start({ localPlayer: m.localPlayer, slots: m.slots, settings: m.settings, seed: m.seed })
    deps.input.drain()
    out.reset()
    out.setLocalPlayer(m.localPlayer)
    ui.setResult(null)
    ui.setScreen('match')
    const stopClock = deps.startClock((t) => metered(() => clientPulse(cm, t)))
    // send each command the moment it is issued instead of on the next 60 Hz
    // input tick; a microtask batches several commands from one DOM event
    let flushQueued = false
    const unsubscribe = deps.input.onCommand?.(() => {
      if (flushQueued) return
      flushQueued = true
      queueMicrotask(() => {
        flushQueued = false
        if (cmatch !== cm) return
        if (cm.pred) {
          predictInput(cm, deps.now(), false)
          wakeClient(cm)
        } else clientInputTick(cm, deps.now())
      })
    })
    cm.stop = () => {
      stopClock()
      unsubscribe?.()
      if (cm.wake !== null) clearTimeout(cm.wake)
      cm.wake = null
    }
  }

  /**
   * The clock pulses once per animation frame (clock.ts). An own command must not
   * wait for the first frame after its tick is due: wake a pulse right at that tick.
   */
  function wakeClient(cm: ClientMatch): void {
    const pred = cm.pred
    if (!pred || cm.wake !== null || pred.tick < 0) return
    const delay = Math.min(Math.max(0, cm.clock.timeOf(pred.tick + 1) - deps.now()), 2 * DT_MS) + 1
    cm.wake = setTimeout(() => {
      cm.wake = null
      if (cmatch === cm) metered(() => clientPulse(cm, deps.now()))
    }, delay)
  }

  function clientPulse(cm: ClientMatch, now: number): void {
    if (cmatch !== cm) return
    if (cm.pred) {
      predictPulse(cm, cm.pred, now)
      return
    }
    cm.acc += now - cm.last
    cm.last = now
    if (cm.acc > 100) cm.acc = 100
    while (cm.acc >= DT_MS) {
      cm.acc -= DT_MS
      clientInputTick(cm, now)
    }
    cm.buffer.pull(now, (state, at, evs) => {
      out.pushState(state, at)
      if (rec) rec.observe(state, evs.length === 1 ? evs[0].events : evs.flatMap((e) => e.events))
      for (const e of evs) out.pushEvents(e.tick, e.events)
      // once per played state, even without events: audio re-aims travel loops
      const played = evs.length === 0 ? [] : evs.length === 1 ? evs[0].events : evs.flatMap((e) => e.events)
      deps.audio.playEvents(played, listenerFor(state, cm.localPlayer))
    })
    if (now - cm.lastStats >= NET_STATS_MS) {
      cm.lastStats = now
      out.setNet(link?.rtt ?? 0, cm.buffer.lossPct)
    }
  }

  function clientInputTick(cm: ClientMatch, now: number): void {
    const cmds = quantizeCmds(deps.input.drain())
    const t = link
    if (cm.localPlayer < 0 || !t) return
    const b = cm.buffer
    const est = b.latestTick < 0 ? 0 : b.latestTick + Math.round((now - b.latestAt + t.rtt / 2) / DT_MS)
    const seq = cm.sender.add(est, cmds)
    if (seq) cm.sentAt.set(seq, now)
    if (cm.sender.unacked) t.sendUnreliable(encode({ t: 'input', match: cm.id, inputs: cm.sender.frames(), n: ++cm.inN }))
  }

  /**
   * Predict mode, every pulse (~4 ms): drain input, apply the newest snapshot
   * (rollback + re-sim), step the prediction to the lead clock's tick and hand every
   * new predicted tick to render / audio. Authoritative ticks still go to the
   * recorder through the jitter buffer.
   */
  function predictPulse(cm: ClientMatch, pred: Predictor, now: number): void {
    cm.acc += now - cm.last
    cm.last = now
    if (cm.acc > 100) cm.acc = 100
    let resend = false
    while (cm.acc >= DT_MS) {
      cm.acc -= DT_MS
      resend = true
    }
    // a command issued between pulses waits ≤ 1 pulse, not a whole tick
    predictInput(cm, now, resend)
    const b = cm.buffer
    const arrivals = cm.stream ? cm.stream.arrival : b
    const t = link
    if (t && !Number.isNaN(arrivals.baseMs)) {
      cm.clock.feedLate(pred.stats.lateFrames, now)
      cm.clock.update(now, arrivals.baseMs, t.rtt, arrivals.jitterMs)
      pred.advance(Math.floor(cm.clock.tickAt(now)), (display, events) => {
        out.pushState(display, cm.clock.timeOf(display.tick))
        out.pushEvents(display.tick, events)
        // once per displayed tick, even without events: audio re-aims travel loops
        deps.audio.playEvents(events, listenerFor(display, cm.localPlayer))
      })
      if (pred.stats.rebases !== cm.rebases) {
        cm.rebases = pred.stats.rebases
        cm.corr.add(now, pred.stats.ownCorrection)
      }
    }
    // stream mode records the confirmed timeline as it is stepped (advanceConfirmed)
    if (rec && !cm.stream) b.pull(now, (state, _at, evs) => rec.observe(state, evs.length === 1 ? evs[0].events : evs.flatMap((e) => e.events)))
    if (now - cm.lastStats >= NET_STATS_MS) {
      cm.lastStats = now
      out.setNet(link?.rtt ?? 0, cm.stream ? (cm.stream.loss.pct ?? 0) : b.lossPct)
    }
  }

  /** Own commands: applied in the next predicted step, stamped with that tick, sent at once. */
  function predictInput(cm: ClientMatch, now: number, resend: boolean): void {
    const cmds = quantizeCmds(deps.input.drain())
    const t = link
    const pred = cm.pred
    if (cm.localPlayer < 0 || !t || !pred) return
    if (cmds.length) {
      const tick = pred.stampNext()
      const seq = cm.sender.add(tick, cmds)
      pred.local({ seq, tick, cmds })
      cm.sentAt.set(seq, now)
    }
    if (cm.sender.unacked && (cmds.length || resend)) {
      t.sendUnreliable(encode({ t: 'input', match: cm.id, inputs: cm.sender.frames(), n: ++cm.inN, s: 1 }))
    }
  }

  function noteAck(cm: ClientMatch, ack: number, now: number): void {
    if (!cm.sentAt.size) return
    for (const [seq, at] of cm.sentAt) {
      if (seq > ack) continue
      const lag = now - at
      cm.ackLagMs = cm.ackLagMs === null ? lag : cm.ackLagMs * 0.8 + lag * 0.2
      cm.sentAt.delete(seq)
    }
  }

  /**
   * The host stepped nothing since the previous snapshot but this client's own
   * frames, each at its stamp (snap.in), and patched no `connected` flag: the
   * prediction already holds this state, no rollback needed. Off after any failed
   * determinism check (the prediction could not be trusted to equal the host's).
   */
  function confirmsPrediction(cm: ClientMatch, pred: Predictor, m: Extract<Msg, { t: 'snap' }>): boolean {
    const prev = cm.check.prev
    if (cm.check.desyncs > 0 || !prev || m.n !== prev.n + 1 || !Array.isArray(m.in)) return false
    const a = prev.state
    const b = m.state
    if (b.tick <= a.tick) return false
    for (let i = 0; i < b.scores.length; i++) if (a.scores[i]?.connected !== b.scores[i].connected) return false
    const stepped = new Map<number, InputCommand[]>()
    for (const x of m.in) {
      if (!x || x.player !== cm.localPlayer || !Array.isArray(x.cmds)) return false
      stepped.set(x.tick, x.cmds)
    }
    for (let t = a.tick; t < b.tick; t++) {
      if (JSON.stringify(stepped.get(t) ?? []) !== JSON.stringify(pred.ownAt(t))) return false
    }
    return !pred.lateBefore(b.tick, m.ack)
  }

  /**
   * Stream mode: a packet of confirmed steps. Step the confirmed state as far as the
   * steps reach, hand it to the predictor (a rollback only when the steps contain
   * something the prediction did not have), compare checkpoint hashes, ask for gaps.
   */
  function onStream(cm: ClientMatch, st: ClientStream, m: Extract<Msg, { t: 'is' }>): void {
    const now = deps.now()
    if (typeof m.to !== 'number' || typeof m.r !== 'number') return
    st.arrival.push(m.to, now)
    st.loss.track(m.n)
    st.lastAt = now
    if (typeof m.a === 'number') {
      noteAck(cm, m.a, now)
      cm.sender.ack(m.a)
    }
    if (Array.isArray(m.h) && typeof m.h[0] === 'number' && typeof m.h[1] === 'number' && m.h[0] > st.checkedTo) st.hostHashes.set(m.h[0], m.h[1])
    st.feed.accept(m.to - m.r, m.to, Array.isArray(m.i) ? m.i : [], Array.isArray(m.c) ? m.c : [])
    advanceConfirmed(cm, st, now)
    const gap = st.feed.gap()
    if (gap !== null) askStream(cm, st, now, gap, false)
  }

  /** `need`: steps from `from` (gap) or a keyframe; repeated at most every ~RTT. */
  function askStream(cm: ClientMatch, st: ClientStream, now: number, from: number, keyframe: boolean): void {
    const t = link
    if (!t || now - st.needAt < Math.max(60, t.rtt * 1.2)) return
    st.needAt = now
    t.sendUnreliable(encode(keyframe ? { t: 'need', m: cm.id, from, k: 1 } : { t: 'need', m: cm.id, from }))
  }

  function advanceConfirmed(cm: ClientMatch, st: ClientStream, now: number): void {
    const pred = cm.pred
    if (!pred) return
    const events: TickEvents[] = []
    let confirms = st.desyncs === 0
    let stepped = 0
    for (;;) {
      const step = st.feed.take()
      if (!step) break
      const s = st.state
      if (confirms) confirms = !step.patches && stepWasPredicted(pred, step, cm.localPlayer)
      rec?.step?.(s, step.inputs, step.patches)
      if (step.patches) {
        for (const [id, on] of step.patches) {
          const sc = s.scores.find((x) => x.id === id)
          if (sc) sc.connected = on
        }
      }
      deps.step(s, step.inputs)
      const q = step.acks?.get(cm.localPlayer)
      if (q !== undefined && q > st.ack) st.ack = q
      rec?.observe(s, s.events)
      if (s.events.length) events.push({ tick: s.tick, events: s.events })
      if (s.tick % HASH_EVERY === 0) st.hashes.set(s.tick, hashState({ ...s, events: [] }))
      stepped++
    }
    if (stepped === 0) return
    checkHashes(cm, st, now)
    // own frames stamped before the confirmed tick must all be in it
    if (confirms && pred.lateBefore(st.state.tick, st.ack)) confirms = false
    pred.offer(cloneState(st.state), st.ack, events, confirms)
  }

  /** The prediction already applied exactly this step: own frames at their stamps, hinted inputs at theirs. */
  function stepWasPredicted(pred: Predictor, step: StreamTick, me: PlayerId): boolean {
    let own = false
    for (const inp of step.inputs) {
      const expected = inp.player === me ? pred.ownAt(step.tick) : pred.hintAt(step.tick, inp.player)
      if (!expected || JSON.stringify(expected) !== JSON.stringify(inp.cmds)) return false
      if (inp.player === me) own = true
    }
    if (!own && pred.ownAt(step.tick).length) return false
    for (const p of pred.hintedAt(step.tick)) if (!step.inputs.some((i) => i.player === p)) return false
    return true
  }

  function checkHashes(cm: ClientMatch, st: ClientStream, now: number): void {
    for (const [tick, host] of st.hostHashes) {
      const mine = st.hashes.get(tick)
      if (mine === undefined) {
        if (tick < st.state.tick - 2 * HASH_EVERY) st.hostHashes.delete(tick)
        continue
      }
      st.hostHashes.delete(tick)
      if (tick > st.checkedTo) st.checkedTo = tick
      st.checks++
      if (mine !== host) {
        if (st.desyncs === 0) console.warn(`[session] state hash mismatch at tick ${tick}: asking for a keyframe`)
        st.desyncs++
        st.desyncAt = now
        st.keyframeAsked = true
        st.needAt = -Infinity
        askStream(cm, st, now, st.feed.next, true)
      }
    }
    for (const tick of st.hashes.keys()) if (tick < st.state.tick - 2 * HASH_EVERY) st.hashes.delete(tick)
  }

  /** Stream mode: a snapshot is a keyframe (join, reconnect, gap beyond the host's history, desync heal). */
  function onKeyframe(cm: ClientMatch, st: ClientStream, m: Extract<Msg, { t: 'snap' }>, now: number): void {
    // an older snapshot than our confirmed state is only useful when we asked for one
    if (m.state.tick < st.feed.next && !st.keyframeAsked) return
    if (m.state.tick <= st.state.tick && !st.keyframeAsked) return
    st.state = cloneState(m.state)
    st.state.events = []
    st.feed.reset(m.state.tick)
    st.ack = m.ack
    st.keyframeAsked = false
    st.hashes.clear()
    st.hostHashes.clear()
    st.checkedTo = m.state.tick
    st.lastAt = now
    st.arrival.push(m.state.tick, now)
    cm.pred?.offer(m.state, m.ack, m.ev)
    advanceConfirmed(cm, st, now)
    // keep the stream coming from here
    askStream(cm, st, now, st.feed.next, false)
  }

  /**
   * ~2×/s: re-simulate the previous snapshot with the inputs the host stepped
   * (snap.in) and compare state hashes. A mismatch means this engine's sim
   * diverges from the host's (prediction would mispredict everything).
   */
  function checkDeterminism(cm: ClientMatch, m: Extract<Msg, { t: 'snap' }>, now: number): void {
    const prev = cm.check.prev
    if (prev && m.n < prev.n) return
    cm.check.prev = { n: m.n, state: m.state }
    if (!prev || m.n !== prev.n + 1 || !Array.isArray(m.in) || now - cm.check.last < CHECK_MS) return
    const a = prev.state
    const b = m.state
    if (b.tick - a.tick < 1 || b.tick - a.tick > 4 || a.phase === 'gameOver') return
    // the host patches `connected` between steps; such pairs cannot be replayed
    for (let i = 0; i < b.scores.length; i++) if (a.scores[i]?.connected !== b.scores[i].connected) return
    cm.check.last = now
    try {
      const s = cloneState(a)
      while (s.tick < b.tick) {
        const tick = s.tick
        deps.step(s, m.in.filter((x) => x && x.tick === tick))
      }
      cm.check.checks++
      if (hashState({ ...s, events: [] }) !== hashState({ ...b, events: [] })) {
        if (cm.check.desyncs === 0) console.warn(`[session] determinism check failed at tick ${b.tick}`)
        cm.check.desyncs++
        cm.check.desyncAt = now
      }
    } catch (e) {
      console.warn('[session] determinism check skipped', e)
    }
  }

  // -------------------------------------------------------------------------
  // link monitor
  // -------------------------------------------------------------------------

  function channelOf(mode: UnreliableMode): PeerNetStats['channel'] {
    return mode === 'raw' ? 'unreliable' : mode === 'reliable' ? 'reliable' : null
  }

  function worst(a: number | null, b: number | null): number | null {
    return a === null ? b : b === null ? a : Math.max(a, b)
  }

  function graded(row: Omit<PeerNetStats, 'grade'>, recentDesync: boolean): PeerNetStats {
    let tr = grades.get(row.playerId)
    if (!tr) grades.set(row.playerId, (tr = new GradeTracker()))
    const change = tr.update(gradeOf({ ...row, recentDesync }), row.playerId)
    if (change) {
      for (const cb of gradeCbs) {
        try {
          cb(change)
        } catch (e) {
          console.error('[session] net grade listener failed', e)
        }
      }
    }
    return { ...row, grade: tr.grade }
  }

  /** Every STATS_MS: rebuild the monitor view; a client also reports its side to the host. */
  function updateNetStats(): void {
    const now = deps.now()
    if (role === 'host') {
      const rows: PeerNetStats[] = []
      for (const p of peers) {
        if (p.playerId === null) continue
        const inMatch = match !== null && p.matchId === match.id
        const r = inMatch ? p.report : null
        const since = r ? now - p.reportAt : null
        rows.push(
          graded(
            {
              playerId: p.playerId,
              rttMs: p.t.rtt > 0 ? p.t.rtt : null,
              jitterMs: p.t.rtt > 0 ? p.t.rttJitter : null,
              lossPct: inMatch ? worst(p.upLoss.pct, r?.dl ?? null) : null,
              // the client's report, or how overdue it is when the client went quiet
              snapshotAgeMs: since === null ? null : since > 4 * STATS_MS ? since : r!.sa,
              channel: channelOf(p.t.unreliableMode),
              inputAckLagMs: r?.al ?? null,
              correctionPx: r?.cp ?? null,
              desyncs: r?.ds ?? null,
            },
            now - p.desyncAt < DESYNC_HOLD_MS,
          ),
        )
      }
      statsView = dedicated ? { role: 'host', peers: rows, server: true } : { role: 'host', peers: rows }
    } else if (role === 'client' && link) {
      const t = link
      const cm = cmatch
      const b = cm?.buffer
      const st = cm?.stream ?? null
      const fresh = st ? st.lastAt > -Infinity : b !== undefined && b.latestTick >= 0
      const downLoss = st ? st.loss.pct : fresh ? b!.lossPct : null
      const checks = st ? st.checks + st.desyncs : cm ? cm.check.checks + cm.check.desyncs : 0
      const desyncs = st ? st.desyncs : (cm?.check.desyncs ?? 0)
      const desyncAt = st ? st.desyncAt : (cm?.check.desyncAt ?? -Infinity)
      const row = graded(
        {
          // a dedicated server has no seat: the connection monitor labels it as the server
          playerId: serverRoom ? SERVER_PLAYER_ID : HOST_PLAYER_ID,
          rttMs: t.rtt > 0 ? t.rtt : null,
          jitterMs: t.rtt > 0 ? t.rttJitter : null,
          lossPct: cm ? worst(downLoss, upLossSeen) : null,
          snapshotAgeMs: fresh ? now - (st ? st.lastAt : b!.latestAt) : null,
          channel: channelOf(t.unreliableMode),
          inputAckLagMs: cm?.ackLagMs ?? null,
          correctionPx: cm?.pred ? cm.corr.value(now) : null,
          desyncs: cm && checks > 0 ? desyncs : null,
        },
        cm !== null && now - desyncAt < DESYNC_HOLD_MS,
      )
      statsView = serverRoom ? { role: 'client', peers: [row], server: true } : { role: 'client', peers: [row] }
      if (cm) {
        t.sendUnreliable(
          encode({
            t: 'nstat',
            match: cm.id,
            dl: downLoss,
            sa: row.snapshotAgeMs,
            al: row.inputAckLagMs,
            cp: row.correctionPx,
            ds: row.desyncs,
          }),
        )
      }
    }
  }

  function startStats(): void {
    if (statsTimer) clearInterval(statsTimer)
    statsTimer = setInterval(updateNetStats, STATS_MS)
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  const api: SessionApi & { debug(): SessionDebug } = {
    openOffline() {
      teardown()
      epoch++
      openLobby('offline', 'open')
    },

    async openHost(opts) {
      teardown()
      const my = ++epoch
      openLobby('host', 'connecting', !opts?.dedicated)
      dedicated = !!opts?.dedicated
      let ep: HostEndpoint
      try {
        ep = await deps.net.host()
      } catch (e) {
        if (my === epoch) fail(errMsg(e))
        return
      }
      if (my !== epoch) {
        ep.close()
        return
      }
      endpoint = ep
      ep.onConnection(acceptPeer)
      pingTimer = setInterval(updatePings, PING_BROADCAST_MS)
      startStats()
      unsubScreen = ui.onScreen((s) => {
        if (role === 'host' && s === 'lobby' && !match) broadcast({ t: 'screen', screen: 'lobby' })
      })
      ui.setLobby({ joinUrl: deps.joinUrl(ep.id), roomCode: ep.id, status: 'open' })
    },

    async join(input: string) {
      const parsed = parseRoomCode(input)
      if ('problem' in parsed) {
        fail(parsed.problem)
        return
      }
      const code = parsed.code
      teardown()
      const my = ++epoch
      joinedCode = code
      role = 'client'
      slots = []
      localPlayer = -1
      ui.setResult(null)
      ui.setLobby({
        role: 'client',
        joinUrl: null,
        roomCode: code,
        status: 'connecting',
        error: null,
        notice: 'Connecting to host…',
        slots: [],
        settings: null,
        localPlayer: -1,
        ready: {},
        pings: {},
        ...NO_ROOM,
      })
      ui.setScreen('lobby')
      let t: Transport
      try {
        t = await deps.net.join(code, (msg) => {
          if (my === epoch) ui.setLobby({ notice: msg })
        })
      } catch (e) {
        if (my === epoch) fail(errMsg(e))
        return
      }
      if (my !== epoch) {
        t.close()
        return
      }
      link = t
      t.onMessage(onHostMessage)
      startStats()
      t.onClose((reason) => {
        if (link !== t) return
        fail(reason === 'timeout' ? 'Lost connection to the host (timed out).' : 'Lost connection to the host.')
      })
      await new Promise<void>((resolve) => {
        welcomeDone = resolve
        welcomeTimer = setTimeout(() => {
          welcomeTimer = null
          if (my === epoch) fail('The host did not answer. Ask for a fresh link and try again.')
          resolve()
        }, HELLO_TIMEOUT_MS)
        const me = deps.profile()
        t.sendReliable(
          encode({
            t: 'hello',
            name: sanitizeName(me.name),
            version: PROTOCOL_VERSION,
            key: deps.clientKey(),
            profileId: me.id,
            color: me.color,
            ...(deps.device ? { device: deps.device() } : {}),
            ...(deps.build ? { build: deps.build } : {}),
          }),
        )
      })
    },

    addBot(difficulty) {
      if (ownerCtl({ t: 'ctl', op: 'addBot', difficulty })) return
      if (!canEdit() || slots.length >= MAX_PLAYERS) return
      addSlot({ name: botName(difficulty, slots), kind: 'bot', difficulty, profileId: botProfileId(difficulty) })
      publishLobby()
    },

    removeSlot(player) {
      if (ownerCtl({ t: 'ctl', op: 'removeSlot', player })) return
      if (!canEdit() || player === localPlayer) return
      const s = slots.find((x) => x.id === player)
      if (!s) return
      if (s.kind === 'human') {
        const p = peers.find((x) => x.playerId === player)
        if (p) {
          p.t.sendReliable(encode({ t: 'kick', reason: 'The host removed you from the lobby.' }))
          p.t.close()
          peers = peers.filter((x) => x !== p)
        }
        slotKeys.delete(player)
      }
      slots = slots.filter((x) => x.id !== player)
      publishLobby()
    },

    setBotDifficulty(player, difficulty) {
      if (ownerCtl({ t: 'ctl', op: 'setBotDifficulty', player, difficulty })) return
      if (!canEdit()) return
      const s = slots.find((x) => x.id === player)
      if (!s || s.kind !== 'bot') return
      // names no longer carry the difficulty, so a bot keeps its name
      s.difficulty = difficulty
      s.profileId = botProfileId(difficulty)
      publishLobby()
    },

    setTeam(player, team) {
      if (ownerCtl({ t: 'ctl', op: 'setTeam', player, team })) return
      if (!canEdit()) return
      const s = slots.find((x) => x.id === player)
      if (!s || !Number.isInteger(team) || team < 0 || team >= MAX_PLAYERS) return
      s.team = team
      publishLobby()
    },

    updateSettings(patch) {
      if (ownerCtl({ t: 'ctl', op: 'settings', settings: patch })) return
      if (!canEdit()) return
      settings = { ...settings, ...patch }
      publishLobby()
    },

    startMatch() {
      if (ownerCtl({ t: 'ctl', op: 'start' })) return
      if (!isAuthority() || match || slots.length === 0) return
      const seed = Math.floor(deps.random() * 0x100000000) >>> 0
      const mSlots = slots.map((s) => ({ ...s }))
      const mSettings = { ...settings }
      let state: SimState
      try {
        state = deps.createMatch(mSettings, mSlots, seed)
      } catch (e) {
        console.error('[session] createMatch failed', e)
        ui.setLobby({ error: `Could not start the match: ${errMsg(e)}` })
        return
      }
      const now = deps.now()
      const m: HostMatch = {
        id: ++matchCounter,
        seed,
        state,
        settings: mSettings,
        slots: mSlots,
        humans: new Set(mSlots.filter((s) => s.kind === 'human').map((s) => s.id)),
        bots: new Map(),
        takeover: new Set(),
        disconnected: new Set(),
        connectedPatch: new Map(),
        recent: [],
        stepped: [],
        history: new StreamHistory(),
        hash: null,
        netMode: role === 'host' ? netMode() : 'classic',
        fair: { delay: 0, seq: 0, queue: [], applied: 0, pred: null },
        snapN: 0,
        interval: 1,
        acc: 0,
        last: now,
        endAt: -1,
        winners: null,
        stop: null,
      }
      for (const s of mSlots) {
        if (s.kind !== 'bot') continue
        const bot = tryCreateBot(s.id, s.difficulty ?? 'medium', seed)
        if (bot) m.bots.set(s.id, bot)
      }
      match = m
      ready = {}
      publishLobby()
      rec?.start({ localPlayer, slots: mSlots, settings: mSettings, seed, ...(dedicated ? { devices: Object.fromEntries(mSlots.flatMap((x) => (slotDevices.has(x.id) ? [[x.id, slotDevices.get(x.id)!]] : []))) } : {}) })
      for (const p of peers) if (p.playerId !== null) sendStart(p, m)
      if (m.netMode !== 'classic') updateHostDelay(m, true)
      deps.input.drain()
      out.reset()
      out.setLocalPlayer(localPlayer)
      out.setNet(0, 0)
      out.pushState(state, now)
      ui.setLobby({ error: null })
      ui.setResult(null)
      ui.setScreen('match')
      const stopClock = deps.startClock((t) => metered(() => hostPulse(m, t)))
      // own command: pulse when the tick that applies it is due, not on the frame after
      let wake: ReturnType<typeof setTimeout> | null = null
      const unsubscribe = deps.input.onCommand?.(() => {
        if (wake !== null || match !== m) return
        const delay = Math.min(Math.max(0, DT_MS - m.acc - (deps.now() - m.last)), 2 * DT_MS) + 1
        wake = setTimeout(() => {
          wake = null
          if (match === m) metered(() => hostPulse(m, deps.now()))
        }, delay)
      })
      m.stop = () => {
        stopClock()
        unsubscribe?.()
        if (wake !== null) clearTimeout(wake)
      }
    },

    rematch() {
      if (ownerCtl({ t: 'ctl', op: 'rematch' })) return
      if (role === 'client') {
        api.setReady(true)
        return
      }
      if (!isAuthority()) return
      if (match) stopMatch(match)
      api.startMatch()
    },

    backToLobby() {
      if (ownerCtl({ t: 'ctl', op: 'lobby' })) return
      if (role === 'client') {
        if (!cmatch) ui.setScreen('lobby')
        return
      }
      if (!isAuthority()) return
      if (match) {
        stopMatch(match)
        out.reset()
      }
      setReadyFlags({})
      ui.setScreen('lobby')
      // the host's onScreen hook also broadcasts this; one extra frame is harmless
      if (role === 'host') broadcast({ t: 'screen', screen: 'lobby' })
    },

    setReady(flag: boolean) {
      if (role === 'client') {
        // between matches only: the host ignores it mid-match, so don't show it either
        if (!link || localPlayer < 0 || cmatch) return
        ready = { ...ready, [localPlayer]: flag }
        ui.setLobby({ ready: { ...ready } })
        link.sendReliable(encode({ t: 'ready', ready: flag }))
      } else if (isAuthority() && !match) {
        setReadyFlags({ ...ready, [localPlayer]: flag })
      }
    },

    leave() {
      if (role === 'host') broadcast({ t: 'leave' })
      else if (role === 'client') link?.sendReliable(encode({ t: 'leave' }))
      teardown()
      slots = []
      ui.setResult(null)
      ui.setLobby({
        role: 'offline',
        joinUrl: null,
        roomCode: null,
        status: 'idle',
        error: null,
        notice: null,
        slots: [],
        settings: null,
        localPlayer: 0,
        ready: {},
        pings: {},
        ...NO_ROOM,
      })
      ui.setScreen('menu')
    },

    netStats() {
      return statsView
    },

    transport() {
      if (role === 'client') return link ? (serverRoom ? 'server' : 'p2p') : null
      if (role === 'host') return dedicated ? 'server' : 'p2p'
      return null
    },

    setPublic(value: boolean) {
      if (ownerCtl({ t: 'ctl', op: 'visibility', public: value })) return
      if (role === 'host' && dedicated) api.setRoom({ public: value })
    },

    setRoom(patch) {
      if (role !== 'host' || !dedicated) return
      if (patch.public !== undefined) roomInfo.public = patch.public
      if (patch.quick !== undefined) roomInfo.quick = patch.quick
      if (patch.cap !== undefined) roomInfo.cap = patch.cap
      if (patch.auto !== undefined) {
        roomInfo.autoAt = patch.auto === null ? null : deps.now() + patch.auto.inMs
        roomInfo.autoFill = patch.auto?.fill ?? false
      }
      ui.setLobby(roomView(roomStateNow(), deps.now()))
      publishLobby()
    },

    roomState() {
      return roomStateNow()
    },

    onNetGrade(cb) {
      gradeCbs.add(cb)
      return () => {
        gradeCbs.delete(cb)
      }
    },

    debug(): SessionDebug {
      const cm = cmatch
      const pred = cm?.pred
      return {
        role,
        peers: peers.length,
        matchId: match?.id ?? cm?.id ?? -1,
        tick: match?.state.tick ?? cm?.buffer.latestTick ?? -1,
        unreliable: link ? [link.unreliableMode] : peers.map((p) => p.t.unreliableMode),
        rttMs: link ? link.rtt : Math.max(0, ...peers.map((p) => p.t.rtt)),
        delayMs: cm?.buffer.delayMs ?? 0,
        lossPct: cm?.buffer.lossPct ?? 0,
        netMode: match?.netMode ?? cm?.netMode ?? null,
        predictAhead: pred && pred.tick >= 0 ? pred.tick - pred.base : 0,
        resimTicks: pred?.stats.resimTicks ?? 0,
        maxResimTicks: pred?.stats.maxResimTicks ?? 0,
        resimMs: pred?.stats.resimMs ?? 0,
        maxResimMs: pred?.stats.maxResimMs ?? 0,
        lateFrames: pred?.stats.lateFrames ?? 0,
        marginTicks: cm?.clock.marginTicks ?? 0,
        leadMs: cm?.clock.leadMs ?? 0,
        jitterMs: cm?.buffer.jitterMs ?? 0,
        hostDelayTicks: match?.fair.delay ?? 0,
        pulses: pulseStats.n,
        pulseMs: pulseStats.ms,
        streamTick: cm?.stream ? cm.stream.state.tick : -1,
        streamChecks: cm?.stream?.checks ?? 0,
        streamDesyncs: cm?.stream?.desyncs ?? 0,
        streamPeers: peers.filter((p) => p.stream && match !== null && p.matchId === match.id).length,
      }
    },
  }
  return api
}
