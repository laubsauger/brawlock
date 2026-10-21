/**
 * Wire protocol: host-authoritative state sync, with optional client prediction
 * (predict.ts). JSON text frames.
 *
 * Reliable channel (ordered):
 *   client → host  hello   {name, version, key, profileId, color, device?, build?}   first message after connect
 *                          key: per-tab reconnect secret; profileId: stable per-browser player id;
 *                          device: persistent anonymous device id (reconnect after a browser
 *                          restart, future ranked); build: client build id (dedicated servers
 *                          refuse other release builds)
 *   host → client  welcome {playerId, server?}        slot assigned; server = {build}: a dedicated
 *                          server hosts this room (it has no seat; the first human owns the room)
 *   client → host  ctl     {op, player?, difficulty?, team?, settings?, public?}   room owner's
 *                          lobby controls on a dedicated server (add bots, settings, start,
 *                          rematch, public / private)
 *   host → client  lobby   {slots, settings, ready, pings, owner?, room?}   on every lobby change;
 *                          room (dedicated): {public, quick, auto} listing and quick-play state
 *   client → host  ready   {ready}                    "wants a rematch" toggle on the results screen
 *   client → host  wait    {wait}                     casual lobby countdown hold (own seat only)
 *   host → client  start   {match, seed, slots, settings, localPlayer}   per client; -1 = spectator
 *   host → client  end     {match, result}            game over, show results
 *   host → client  screen  {screen: 'lobby'}          host went back to the lobby
 *   host → client  notice  {text}                     transient info ("Bob disconnected")
 *   client → host  say     {text}                     room chat, sender resolved by host
 *   host → client  chat    {line}                     accepted room message
 *   host → client  chatlog {lines}                    bounded history on join / reconnect
 *   host → client  kick    {reason}
 *   either         leave   {}                         graceful goodbye
 *   host → client  error   {message}                  fatal (version mismatch, lobby full)
 *
 * Unreliable channel (unordered, no retransmit):
 *   client → host  input {match, inputs: InputFrame[], n?, s?}   all unacked frames, oldest first (redundancy)
 *     n     input packet counter (uplink loss stats)
 *     s     1 = stamped (prediction): the host applies each frame in the step from
 *           frame.tick (held until then, applied at once when late). Absent: on arrival.
 *   client → host  nstat {match, dl, sa, al, cp, ds}   ~4 Hz link report for the host's
 *                  monitor: downlink loss %, snapshot age ms, input ack lag ms,
 *                  prediction correction (game units), determinism check failures (null = n/a)
 *   host → client  pings {pings, ul?}               per-player RTT in ms, ~1 Hz (lobby and match);
 *                                                   ul = per-player uplink loss % seen by the host
 *   host → client  is    {m, n, a, to, r, i?, c?, h?}   input stream (stream.ts): the confirmed
 *                  steps [to - r, to), sent the tick they are stepped (empty stretches as a
 *                  heartbeat); a = this client's applied input seq. To clients that asked with `need`.
 *   client → host  need  {m, from, k?}   stream mode: send steps from tick `from` (start,
 *                  gap repair); k = 1: send a keyframe snapshot (desync heal)
 *   host → client  hint  {m, p, f}   another player's stamped input frames, relayed on
 *                  arrival before they are stepped ([tick, cmds][]): prediction hints
 *   host → client  snap  {match, n, iv, ack, ev, in?, state}
 *     n     snapshot counter (loss stats), iv snapshot interval in ticks
 *     ack   highest input seq the host applied for this client
 *     ev    events of the last EVENT_REDUNDANCY_TICKS ticks, so a lost snapshot never loses VFX/SFX
 *     in    every input the host stepped since the previous snapshot (PlayerInput.tick = the
 *           step's tick), so a client can re-simulate snapshot n-1 → n and compare hashes
 *     state full SimState with `events: []` (the client restores it from ev)
 *
 * Ping / pong live one layer down, in transport.ts ('#p<t>' / '#q<t>' frames on
 * the unreliable path), so every link measures RTT without app involvement.
 */
import type { BotDifficulty, InputCommand, MatchSettings, PlayerId, PlayerInput, PlayerSlot, SimState } from '../sim/types'
import type { TickEvents } from '../game/frame'
import { decodeCmd, encodeCmd, type WireCmd, type WireInput, type WirePatch, type WireSlot } from './stream'
import type { MatchResult } from '../game/store'
import type { LobbyVoteChoice, LobbyVoteSetting, LobbyVoteWire, LobbyVoteResult } from './lobbyVotes'
import type { ChatLine } from './chat'

/** Bump on any incompatible change; host rejects mismatching clients. */
export const PROTOCOL_VERSION = 8

/** Snapshots carry the events of this many most recent ticks. */
export const EVENT_REDUNDANCY_TICKS = 10

export interface InputFrame {
  /** per-client sequence, starts at 1 for every match */
  seq: number
  /**
   * Stamped packets (`s: 1`): the tick whose step applies this frame. Otherwise the
   * client's estimate of the host tick (informational).
   */
  tick: number
  cmds: InputCommand[]
}

export interface BotPlan {
  p: PlayerId
  n: number
  f: [number, InputCommand[]][]
}

export type { TickEvents }

/** A dedicated-server room's listing and quick-play state (lobby message). */
export interface RoomState {
  /** listed in the public room browser (GET /rooms?public=1) */
  public: boolean
  /** a quick-play room: the server runs it (no owner), it starts and refills by itself */
  quick: boolean
  ranked?: boolean
  /** Persistent regional update notice; null/absent when accepting new games. */
  maintenance?: string | null
  /** Casual lobby seats asking to keep the lobby open; any human Ready releases the hold. */
  waiting?: PlayerId[]
  /** quick play: the automatic start in this many ms from the message ('fill': the one-human countdown; bots top the table up either way); null = none pending */
  auto: { inMs: number; fill: boolean } | null
}

export type Msg =
  | { t: 'say'; text: string }
  | { t: 'chat'; line: ChatLine }
  | { t: 'chatlog'; lines: ChatLine[] }
  | { t: 'hello'; name: string; version: number; key: string; profileId: string; color: number | null; device?: string; build?: string }
  | { t: 'rename'; name: string }
  | { t: 'color'; color: number }
  | { t: 'vote'; id: number; choice: LobbyVoteChoice }
  | { t: 'welcome'; playerId: PlayerId; server?: { build: string } }
  | {
      t: 'lobby'
      slots: PlayerSlot[]
      settings: MatchSettings
      ready: Record<PlayerId, boolean>
      pings: Record<PlayerId, number>
      vote?: LobbyVoteWire | null
      voteResult?: LobbyVoteResult | null
      /** dedicated server: the room owner's seat (-1 none) */
      owner?: PlayerId
      /** dedicated server: how the room is listed and run */
      room?: RoomState
    }
  | {
      t: 'ctl'
      op: 'addBot' | 'removeSlot' | 'setBotDifficulty' | 'setTeam' | 'settings' | 'start' | 'rematch' | 'lobby' | 'visibility' | 'vote'
      setting?: LobbyVoteSetting
      player?: PlayerId
      difficulty?: BotDifficulty
      team?: number
      settings?: Partial<MatchSettings>
      /** op 'visibility': list the room in the public browser */
      public?: boolean
    }
  | { t: 'ready'; ready: boolean }
  | { t: 'wait'; wait: boolean }
  | { t: 'pings'; pings: Record<PlayerId, number>; ul?: Record<PlayerId, number> }
  | { t: 'start'; match: number; seed: number; slots: PlayerSlot[]; settings: MatchSettings; localPlayer: PlayerId; waiting?: boolean; fromTick?: number }
  | { t: 'input'; match: number; inputs: InputFrame[]; n?: number; s?: 1 }
  | {
      t: 'nstat'
      match: number
      dl: number | null
      sa: number | null
      al: number | null
      cp: number | null
      ds: number | null
    }
  | { t: 'snap'; match: number; n: number; iv: number; ack: number; ev: TickEvents[]; in?: PlayerInput[]; state: SimState }
  | { t: 'is'; m: number; n: number; a: number; to: number; r: number; i?: WireInput[]; c?: WirePatch[]; s?: WireSlot[]; h?: [number, number] }
  | { t: 'need'; m: number; from: number; k?: 1 }
  | { t: 'hint'; m: number; p: PlayerId; f: [number, InputCommand[]][] }
  /** A bot's complete pending schedule as of tick n; newer plans replace older future commands. */
  | { t: 'plan'; m: number; p: PlayerId; n: number; f: [number, InputCommand[]][] }
  | { t: 'plans'; m: number; plans: BotPlan[] }
  | { t: 'end'; match: number; result: MatchResult }
  | { t: 'screen'; screen: 'lobby' }
  | { t: 'notice'; text: string }
  | { t: 'kick'; reason: string }
  | { t: 'leave'; transfer?: boolean }
  | { t: 'error'; message: string }

const TYPES = new Set<Msg['t']>([
  'say',
  'chat',
  'chatlog',
  'hello',
  'rename',
  'color',
  'vote',
  'welcome',
  'lobby',
  'ready',
  'wait',
  'pings',
  'start',
  'input',
  'nstat',
  'ctl',
  'snap',
  'is',
  'need',
  'hint',
  'plan',
  'plans',
  'end',
  'screen',
  'notice',
  'kick',
  'leave',
  'error',
])

export function encode(msg: Msg): string {
  if (msg.t === 'plan') return JSON.stringify({ ...msg, f: msg.f.map(([tick, cmds]) => [tick, cmds.map(encodeCmd)]) })
  if (msg.t === 'plans') return JSON.stringify({ t: msg.t, m: msg.m, plans: msg.plans.map((p) => [p.p, p.n, p.f.map(([tick, cmds]) => [tick - p.n, cmds.map(encodeCmd)])]) })
  return JSON.stringify(msg)
}

/** Parse a frame. Returns null for garbage. Shape checks for untrusted input are in sanitize*. */
export function decode(data: string): Msg | null {
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const t = (v as { t?: unknown }).t
  if (typeof t !== 'string' || !TYPES.has(t as Msg['t'])) return null
  if (t === 'plans') {
    const msg = v as Extract<Msg, { t: 'plans' }>
    if (!Array.isArray(msg.plans)) return null
    const plans: BotPlan[] = []
    for (const p of msg.plans as unknown[]) {
      if (!Array.isArray(p) || !Number.isInteger(p[0]) || !Number.isInteger(p[1]) || !Array.isArray(p[2])) return null
      const decoded = decodeBotPlan(p[0], p[1], p[2], true)
      if (!decoded) return null
      plans.push(decoded)
    }
    return { ...msg, plans }
  }
  if (t === 'plan') {
    const plan = v as Extract<Msg, { t: 'plan' }>
    const decoded = decodeBotPlan(plan.p, plan.n, plan.f, false)
    return decoded ? { ...plan, ...decoded } : null
  }
  return v as Msg
}

function decodeBotPlan(player: number, asOf: number, frames: unknown, relative: boolean): BotPlan | null {
  if (!Number.isInteger(player) || !Number.isInteger(asOf) || !Array.isArray(frames)) return null
  const f: BotPlan['f'] = []
  for (const frame of frames) {
    if (!Array.isArray(frame) || !Number.isInteger(frame[0]) || !Array.isArray(frame[1])) return null
    const cmds: InputCommand[] = []
    for (const wire of frame[1]) {
      const cmd = decodeCmd(wire as WireCmd)
      if (!cmd) return null
      cmds.push(cmd)
    }
    f.push([frame[0] + (relative ? asOf : 0), cmds])
  }
  return { p: player, n: asOf, f }
}

/**
 * Snapshot encoder that reuses one serialized state for every client (only
 * `ack` differs per client). `stateJson` must be JSON of the state with `events: []`,
 * `evJson` JSON of a TickEvents[], `inJson` (optional) JSON of a PlayerInput[].
 */
export function encodeSnap(match: number, n: number, iv: number, ack: number, evJson: string, stateJson: string, inJson?: string): string {
  const inputs = inJson === undefined ? '' : `,"in":${inJson}`
  return `{"t":"snap","match":${match},"n":${n},"iv":${iv},"ack":${ack},"ev":${evJson}${inputs},"state":${stateJson}}`
}

/**
 * Stream packet encoder: `body` is the JSON after the per-client fields (`"to":…,"r":…`
 * plus optional i / c / h), built once per tick and shared by every client.
 */
export function encodeStreamPacket(match: number, n: number, ack: number, body: string): string {
  return `{"t":"is","m":${match},"n":${n},"a":${ack},${body}}`
}

/** A reported link metric: finite, clamped to 0..1e6, else null. */
export function sanitizeMetric(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), MAX_COORD) : null
}

/** JSON of a state without its events (they travel in `ev`). */
export function stateJsonWithoutEvents(state: SimState): string {
  return JSON.stringify({ ...state, events: [] })
}

// ---------------------------------------------------------------------------
// Validation of client → host data (clients are untrusted)
// ---------------------------------------------------------------------------

const MAX_FRAMES = 64
const MAX_CMDS_PER_FRAME = 16
const MAX_COORD = 1e6

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD
}

/**
 * Accept a command if it is a flat object with a string `kind` and primitive
 * fields. Known kinds get their required fields checked (a NaN move target would
 * poison the sim). Unknown kinds pass through so new sim commands work without a
 * protocol change; the sim ignores kinds it does not know.
 */
export function sanitizeCommand(c: unknown): InputCommand | null {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  const o = c as Record<string, unknown>
  if (typeof o.kind !== 'string' || o.kind.length > 32) return null
  const keys = Object.keys(o)
  if (keys.length > 8) return null
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number') {
      if (!isNum(v)) return null
    } else if (typeof v === 'string') {
      if (v.length > 64) return null
    } else if (typeof v !== 'boolean') {
      return null
    }
    out[k] = v
  }
  switch (o.kind) {
    case 'move':
      if (!isNum(o.x) || !isNum(o.y)) return null
      break
    case 'cast':
      if (!isNum(o.x) || !isNum(o.y) || !Number.isInteger(o.slot) || (o.slot as number) < 0 || (o.slot as number) > 15)
        return null
      break
    case 'buySpell':
      if (typeof o.spell !== 'string') return null
      break
    case 'buyItem':
      if (typeof o.item !== 'string') return null
      break
    case 'buyMastery':
      if (!['duration', 'range', 'lifesteal', 'all'].includes(o.mastery as string)) return null
      break
    case 'spectateBet':
      // Stake and payout belong to the authoritative sim, never to the client.
      if (keys.length !== 3 || !Number.isInteger(o.round) || (o.round as number) < 0 || !Number.isInteger(o.target) || (o.target as number) < 0) return null
      break
  }
  return out as unknown as InputCommand
}

/** Validate an input packet's frames; drops malformed frames and commands. */
export function sanitizeFrames(frames: unknown): InputFrame[] {
  if (!Array.isArray(frames)) return []
  const out: InputFrame[] = []
  for (const f of frames.slice(0, MAX_FRAMES)) {
    if (!f || typeof f !== 'object') continue
    const { seq, tick, cmds } = f as Record<string, unknown>
    if (!Number.isInteger(seq) || (seq as number) < 1 || !Array.isArray(cmds)) continue
    const clean: InputCommand[] = []
    for (const c of cmds.slice(0, MAX_CMDS_PER_FRAME)) {
      const s = sanitizeCommand(c)
      if (s) clean.push(s)
    }
    out.push({ seq: seq as number, tick: isNum(tick) ? tick : 0, cmds: clean })
  }
  out.sort((a, b) => a.seq - b.seq)
  return out
}

/**
 * A room owner's settings change (dedicated server, `ctl`): only known keys, each with
 * the default's type; strings short. createMatch sanitizes numeric ranges.
 */
export function sanitizeSettingsPatch(patch: unknown, defaults: MatchSettings): Partial<MatchSettings> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in defaults)) continue
    const d = (defaults as unknown as Record<string, unknown>)[k]
    if (typeof d === 'number' && isNum(v)) out[k] = v
    else if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v
    else if (typeof d === 'string' && typeof v === 'string' && v.length <= 16) out[k] = v
  }
  return out as Partial<MatchSettings>
}

export function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') return 'Warlock'
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20)
  return clean || 'Warlock'
}

/** A client's claimed profile id, or null. 'bot:' ids are reserved for bots. */
export function sanitizeProfileId(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < 8 || v.length > 64) return null
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return null
  return v
}

export function sanitizeColor(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : null
}
