/**
 * Session core: lobby + match loop for offline, host and client roles.
 * Dependencies are injected so tests can run a host and a client in one process
 * over the in-memory transport; src/game/session.ts wires the real modules.
 *
 * Host / offline: fixed 60 Hz accumulator driven by a worker pulse (clock.ts).
 *   Each tick: local input + remote inputs + bot commands → step → frame + audio
 *   → snapshot to clients (every tick, or every 2nd tick when large).
 * Client: own 60 Hz pulse; drains local input and sends every unacked frame
 *   (inputs.ts), plays snapshots through the jitter buffer (jitter.ts).
 * Both feed every played tick to the MatchRecorder, which writes local stats at
 * game over (game/stats.ts).
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
import type { StartClock } from './clock'
import { parseRoomCode } from './code'
import { InputReceiver, InputSender } from './inputs'
import { SnapshotBuffer } from './jitter'
import {
  EVENT_REDUNDANCY_TICKS,
  PROTOCOL_VERSION,
  decode,
  encode,
  encodeSnap,
  sanitizeColor,
  sanitizeFrames,
  sanitizeName,
  sanitizeProfileId,
  stateJsonWithoutEvents,
  type Msg,
  type TickEvents,
} from './protocol'
import type { HostEndpoint, NetFactory, Transport } from './transport'

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
  start(info: { localPlayer: PlayerId; slots: PlayerSlot[]; settings: MatchSettings }): void
  /** one played tick: its state and the events of every tick since the previous call */
  observe(state: SimState, events: readonly SimEvent[]): void
  finish(result: MatchResult): void
  /** match ended without a result (aborted, rematch mid-match, leave) */
  abort(): void
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
}

export interface SessionApi {
  openOffline(): void
  openHost(): Promise<void>
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

// ---------------------------------------------------------------------------

interface RemotePeer {
  t: Transport
  playerId: PlayerId | null
  name: string
  key: string
  receiver: InputReceiver
  queued: InputCommand[]
  /** match id this peer received `start` for */
  matchId: number
  helloTimer: ReturnType<typeof setTimeout> | null
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
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function botName(d: BotDifficulty): string {
  return `${cap(d)} Bot`
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
  let unsubScreen: (() => void) | null = null
  let matchCounter = 0
  let match: HostMatch | null = null

  // client
  let link: Transport | null = null
  let cmatch: ClientMatch | null = null
  let welcomeDone: (() => void) | null = null
  let welcomeTimer: ReturnType<typeof setTimeout> | null = null

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
    if (role === 'host') broadcast({ t: 'lobby', slots, settings, ready, pings })
  }

  /**
   * Host, ~1 Hz: per-player pings from each link's RTT. Always sent (unreliable, a
   * lost one is replaced a second later); the store only changes when a value does.
   */
  function updatePings(): void {
    if (role !== 'host') return
    const next: Record<PlayerId, number> = { [localPlayer]: 0 }
    for (const p of peers) if (p.playerId !== null) next[p.playerId] = Math.round(p.t.rtt)
    setPings(next)
    const data = encode({ t: 'pings', pings })
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
    ui.setLobby({ role: 'offline', joinUrl: null, roomCode: null, status: 'error', error: message, notice: null })
    ui.setScreen('menu')
  }

  function openLobby(r: NetRole, status: LobbyView['status']): void {
    role = r
    settings = { ...deps.defaultSettings }
    localPlayer = 0
    slots = []
    ready = {}
    pings = r === 'host' ? { 0: 0 } : {}
    const me = deps.profile()
    addSlot({ name: me.name, kind: 'human', profileId: me.id }, me.color)
    ui.setResult(null)
    ui.setLobby({ role: r, joinUrl: null, roomCode: null, status, error: null, notice: null })
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
    p.name = sanitizeName(m.name)
    p.key = typeof m.key === 'string' ? m.key.slice(0, 64) : ''

    // a reloaded / reconnected client takes its pawn back
    if (match && p.key) {
      const m2 = match
      const back = [...m2.disconnected].find((id) => slotKeys.get(id) === p.key)
      if (back !== undefined) {
        peers = peers.filter((x) => x === p || x.playerId !== back)
        p.playerId = back
        m2.disconnected.delete(back)
        if (m2.takeover.delete(back)) m2.bots.delete(back)
        m2.connectedPatch.set(back, true)
        p.t.sendReliable(encode({ t: 'welcome', playerId: back }))
        p.t.sendReliable(encode({ t: 'lobby', slots, settings, ready, pings }))
        sendStart(p, m2)
        showNotice(`${p.name} reconnected`, true)
        return
      }
    }

    if (slots.length >= MAX_PLAYERS) {
      rejectPeer(p, 'The lobby is full.')
      return
    }
    const profileId = sanitizeProfileId(m.profileId)
    const slot = addSlot({ name: p.name, kind: 'human', ...(profileId ? { profileId } : {}) }, sanitizeColor(m.color))
    slotKeys.set(slot.id, p.key)
    p.playerId = slot.id
    p.t.sendReliable(encode({ t: 'welcome', playerId: slot.id }))
    publishLobby()
    // joined mid-match: spectate now, play from the next match
    if (match) sendStart(p, match)
    showNotice(`${p.name} joined`)
  }

  function onInput(p: RemotePeer, m: Extract<Msg, { t: 'input' }>): void {
    const mt = match
    const id = p.playerId
    if (!mt || id === null || m.match !== mt.id || p.matchId !== mt.id) return
    if (!mt.humans.has(id) || mt.disconnected.has(id)) return
    for (const f of p.receiver.accept(sanitizeFrames(m.inputs))) {
      for (const c of f.cmds) if (p.queued.length < MAX_QUEUED_CMDS) p.queued.push(c)
    }
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
        }
      }
      showNotice(text, true)
    } else {
      slots = slots.filter((s) => s.id !== id)
      slotKeys.delete(id)
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
    const local = deps.input.drain()
    if (local.length && m.humans.has(localPlayer)) inputs.push({ player: localPlayer, tick, cmds: local })
    for (const p of peers) {
      if (p.queued.length && p.playerId !== null && p.matchId === m.id) {
        inputs.push({ player: p.playerId, tick, cmds: p.queued })
        p.queued = []
      }
    }
    for (const [id, bot] of m.bots) {
      try {
        const cmds = bot.think(cur)
        if (cmds.length) inputs.push({ player: id, tick, cmds })
      } catch (e) {
        console.error(`[session] bot ${id} crashed, its pawn idles`, e)
        m.bots.delete(id)
      }
    }

    // the previous state was handed to render: step a copy
    const next = structuredClone(cur)
    if (m.connectedPatch.size) {
      for (const [id, c] of m.connectedPatch) {
        const sc = next.scores.find((s) => s.id === id)
        if (sc) sc.connected = c
      }
      m.connectedPatch.clear()
    }
    deps.step(next, inputs)
    m.state = next

    out.pushState(next, at)
    rec?.observe(next, next.events)
    if (next.events.length) {
      out.pushEvents(next.tick, next.events)
      m.recent.push({ tick: next.tick, events: next.events })
    }
    // every tick, even without events: audio re-aims projectile travel loops
    deps.audio.playEvents(next.events, listenerFor(next, localPlayer))
    while (m.recent.length && m.recent[0].tick <= next.tick - EVENT_REDUNDANCY_TICKS) m.recent.shift()
    if (peers.length) sendSnapshots(m, next)

    if (m.endAt < 0 && next.phase === 'gameOver') {
      m.endAt = at + GAME_OVER_LINGER_MS
      m.winners = winnersOf(next)
    }
  }

  function sendSnapshots(m: HostMatch, s: SimState): void {
    if (s.tick % m.interval !== 0) return
    const stateJson = stateJsonWithoutEvents(s)
    if (stateJson.length > SNAP_BIG) m.interval = 2
    else if (stateJson.length < SNAP_SMALL) m.interval = 1
    const evJson = JSON.stringify(m.recent)
    const n = ++m.snapN
    for (const p of peers) {
      if (p.playerId === null || p.matchId !== m.id) continue
      p.t.sendUnreliable(encodeSnap(m.id, n, m.interval, p.receiver.lastSeq, evJson, stateJson))
    }
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
        ui.setLobby({ localPlayer, status: 'open', notice: null })
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
        ui.setLobby({ slots: m.slots, settings: m.settings, localPlayer, ready: { ...ready }, pings: { ...pings } })
        break
      case 'pings':
        setPings(m.pings ?? {})
        break
      case 'start':
        clientStart(m)
        break
      case 'snap': {
        const cm = cmatch
        if (!cm || m.match !== cm.id) return
        cm.sender.ack(m.ack)
        cm.buffer.push(m, deps.now())
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
    const cm: ClientMatch = {
      id: m.match,
      localPlayer: m.localPlayer,
      sender: new InputSender(),
      buffer: new SnapshotBuffer(),
      acc: 0,
      last: now,
      lastStats: -Infinity,
      stop: null,
    }
    cmatch = cm
    ready = {}
    ui.setLobby({ ready: {} })
    rec?.start({ localPlayer: m.localPlayer, slots: m.slots, settings: m.settings })
    deps.input.drain()
    out.reset()
    out.setLocalPlayer(m.localPlayer)
    ui.setResult(null)
    ui.setScreen('match')
    const stopClock = deps.startClock((t) => clientPulse(cm, t))
    // send each command the moment it is issued instead of on the next 60 Hz
    // input tick; a microtask batches several commands from one DOM event
    let flushQueued = false
    const unsubscribe = deps.input.onCommand?.(() => {
      if (flushQueued) return
      flushQueued = true
      queueMicrotask(() => {
        flushQueued = false
        if (cmatch === cm) clientInputTick(cm, deps.now())
      })
    })
    cm.stop = () => {
      stopClock()
      unsubscribe?.()
    }
  }

  function clientPulse(cm: ClientMatch, now: number): void {
    if (cmatch !== cm) return
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
    const cmds = deps.input.drain()
    const t = link
    if (cm.localPlayer < 0 || !t) return
    const b = cm.buffer
    const est = b.latestTick < 0 ? 0 : b.latestTick + Math.round((now - b.latestAt + t.rtt / 2) / DT_MS)
    cm.sender.add(est, cmds)
    if (cm.sender.unacked) t.sendUnreliable(encode({ t: 'input', match: cm.id, inputs: cm.sender.frames() }))
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

    async openHost() {
      teardown()
      const my = ++epoch
      openLobby('host', 'connecting')
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
          }),
        )
      })
    },

    addBot(difficulty) {
      if (!canEdit() || slots.length >= MAX_PLAYERS) return
      addSlot({ name: botName(difficulty), kind: 'bot', difficulty, profileId: botProfileId(difficulty) })
      publishLobby()
    },

    removeSlot(player) {
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
      if (!canEdit()) return
      const s = slots.find((x) => x.id === player)
      if (!s || s.kind !== 'bot') return
      const autoName = s.difficulty !== undefined && s.name === botName(s.difficulty)
      s.difficulty = difficulty
      s.profileId = botProfileId(difficulty)
      if (autoName) s.name = botName(difficulty)
      publishLobby()
    },

    setTeam(player, team) {
      if (!canEdit()) return
      const s = slots.find((x) => x.id === player)
      if (!s || !Number.isInteger(team) || team < 0 || team >= MAX_PLAYERS) return
      s.team = team
      publishLobby()
    },

    updateSettings(patch) {
      if (!canEdit()) return
      settings = { ...settings, ...patch }
      publishLobby()
    },

    startMatch() {
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
      rec?.start({ localPlayer, slots: mSlots, settings: mSettings })
      for (const p of peers) if (p.playerId !== null) sendStart(p, m)
      deps.input.drain()
      out.reset()
      out.setLocalPlayer(localPlayer)
      out.setNet(0, 0)
      out.pushState(state, now)
      ui.setLobby({ error: null })
      ui.setResult(null)
      ui.setScreen('match')
      m.stop = deps.startClock((t) => hostPulse(m, t))
    },

    rematch() {
      if (role === 'client') {
        api.setReady(true)
        return
      }
      if (!isAuthority()) return
      if (match) stopMatch(match)
      api.startMatch()
    },

    backToLobby() {
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
      })
      ui.setScreen('menu')
    },

    debug(): SessionDebug {
      const cm = cmatch
      return {
        role,
        peers: peers.length,
        matchId: match?.id ?? cm?.id ?? -1,
        tick: match?.state.tick ?? cm?.buffer.latestTick ?? -1,
        unreliable: link ? [link.unreliableMode] : peers.map((p) => p.t.unreliableMode),
        rttMs: link ? link.rtt : Math.max(0, ...peers.map((p) => p.t.rtt)),
        delayMs: cm?.buffer.delayMs ?? 0,
        lossPct: cm?.buffer.lossPct ?? 0,
      }
    },
  }
  return api
}
