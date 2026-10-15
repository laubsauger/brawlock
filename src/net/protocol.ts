/**
 * Wire protocol, M0 (host-authoritative state sync). JSON text frames.
 *
 * Reliable channel (ordered):
 *   client → host  hello   {name, version, key}       first message after connect
 *   host → client  welcome {playerId}                 slot assigned
 *   host → client  lobby   {slots, settings}          on every lobby change
 *   host → client  start   {match, seed, slots, settings, localPlayer}   per client; -1 = spectator
 *   host → client  end     {match, result}            game over, show results
 *   host → client  screen  {screen: 'lobby'}          host went back to the lobby
 *   host → client  notice  {text}                     transient info ("Bob disconnected")
 *   host → client  kick    {reason}
 *   either         leave   {}                         graceful goodbye
 *   host → client  error   {message}                  fatal (version mismatch, lobby full)
 *
 * Unreliable channel (unordered, no retransmit):
 *   client → host  input {match, inputs: InputFrame[]}   all unacked frames, oldest first (redundancy)
 *   host → client  snap  {match, n, iv, ack, ev, state}
 *     n     snapshot counter (loss stats), iv snapshot interval in ticks
 *     ack   highest input seq the host applied for this client
 *     ev    events of the last EVENT_REDUNDANCY_TICKS ticks, so a lost snapshot never loses VFX/SFX
 *     state full SimState with `events: []` (the client restores it from ev)
 *
 * Ping / pong live one layer down, in transport.ts ('#p<t>' / '#q<t>' frames on
 * the unreliable path), so every link measures RTT without app involvement.
 */
import type { InputCommand, MatchSettings, PlayerId, PlayerSlot, SimState } from '../sim/types'
import type { TickEvents } from '../game/frame'
import type { MatchResult } from '../game/store'

/** Bump on any incompatible change; host rejects mismatching clients. */
export const PROTOCOL_VERSION = 1

/** Snapshots carry the events of this many most recent ticks. */
export const EVENT_REDUNDANCY_TICKS = 10

export interface InputFrame {
  /** per-client sequence, starts at 1 for every match */
  seq: number
  /** client's estimate of the host tick (informational in M0) */
  tick: number
  cmds: InputCommand[]
}

export type { TickEvents }

export type Msg =
  | { t: 'hello'; name: string; version: number; key: string }
  | { t: 'welcome'; playerId: PlayerId }
  | { t: 'lobby'; slots: PlayerSlot[]; settings: MatchSettings }
  | { t: 'start'; match: number; seed: number; slots: PlayerSlot[]; settings: MatchSettings; localPlayer: PlayerId }
  | { t: 'input'; match: number; inputs: InputFrame[] }
  | { t: 'snap'; match: number; n: number; iv: number; ack: number; ev: TickEvents[]; state: SimState }
  | { t: 'end'; match: number; result: MatchResult }
  | { t: 'screen'; screen: 'lobby' }
  | { t: 'notice'; text: string }
  | { t: 'kick'; reason: string }
  | { t: 'leave' }
  | { t: 'error'; message: string }

const TYPES = new Set<Msg['t']>([
  'hello',
  'welcome',
  'lobby',
  'start',
  'input',
  'snap',
  'end',
  'screen',
  'notice',
  'kick',
  'leave',
  'error',
])

export function encode(msg: Msg): string {
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
  return v as Msg
}

/**
 * Snapshot encoder that reuses one serialized state for every client (only
 * `ack` differs per client). `stateJson` must be JSON of the state with `events: []`,
 * `evJson` JSON of a TickEvents[].
 */
export function encodeSnap(match: number, n: number, iv: number, ack: number, evJson: string, stateJson: string): string {
  return `{"t":"snap","match":${match},"n":${n},"iv":${iv},"ack":${ack},"ev":${evJson},"state":${stateJson}}`
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

export function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') return 'Warlock'
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20)
  return clean || 'Warlock'
}
