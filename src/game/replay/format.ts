/**
 * Local replays (M4.4): the file format. A replay is the match's start state plus the
 * stepped input stream (the confirmed inputs every peer steps, and the `connected`
 * patches applied before a step), so the deterministic sim re-creates every tick.
 * State hashes every HASH_EVERY ticks catch a desync; round and kill markers feed the
 * timeline.
 *
 * Commands use the input stream's compact wire form (net/stream.ts encodeCmd), the JSON
 * is gzipped with CompressionStream when the runtime has it, and a `.brawlock` file is
 * exactly those bytes, so sharing a replay is copying a file.
 *
 * Replays only play with the build that recorded them: the sim / netcode id (__NET_ID__)
 * must match, because an older sim re-simulates the same inputs differently. They play at the
 * simulation rate they were recorded at (`hz`).
 */
import { decodeCmd, encodeCmd, type WireCmd } from '../../net/stream'
import { ticks, secondsOf } from '../../sim/config'
import { TICK_RATES, onTickRate, type TickRate, type InputCommand, type MatchSettings, type PlayerId, type PlayerInput, type PlayerSlot, type SimState } from '../../sim/types'

export const REPLAY_FORMAT = 'brawlock-replay'
export const REPLAY_VERSION = 1
/** state hash checkpoint interval, ticks (5 s) */
export let HASH_EVERY = 0
onTickRate(() => { HASH_EVERY = ticks(5) })
export const REPLAY_EXT = '.brawlock'

/** One recorded step: applied going from `tick` to `tick + 1`. Empty steps are not stored. */
export type ReplayStep = [tick: number, inputs: [player: PlayerId, cmds: WireCmd[]][], patches?: [player: PlayerId, on: 0 | 1][], slots?: PlayerSlot[]]

export interface ReplayData {
  format: typeof REPLAY_FORMAT
  v: typeof REPLAY_VERSION
  /** same id as the match's stats record (MatchRecord.id), so history rows find it */
  id: string
  /** sim / netcode id of the build that recorded it (__NET_ID__) */
  netId: string
  /** simulation rate of the recorded match */
  hz: TickRate
  /** ms since epoch */
  date: number
  /** who recorded it (-1 = spectator) */
  localPlayer: PlayerId
  seed: number | null
  settings: MatchSettings
  slots: PlayerSlot[]
  /** the state before the first recorded step */
  start: SimState
  /** state tick after the last recorded step */
  endTick: number
  steps: ReplayStep[]
  /** full state where the recorder's stream jumped (a keyframe heal): [tick, state] */
  resyncs: [number, SimState][]
  /** [tick, hash] of the state after the step reaching `tick`, events excluded */
  hashes: [number, number][]
  /** [tick, round] when each fight started */
  rounds: [number, number][]
  /** [tick, killer | null, victim] */
  kills: [number, PlayerId | null, PlayerId][]
  winners: PlayerId[]
}

/** Summary for lists, readable without decompressing the replay. */
export interface ReplayMeta {
  id: string
  date: number
  netId: string
  pinned: boolean
  localPlayer: PlayerId
  players: { id: PlayerId; name: string; color: number }[]
  winners: PlayerId[]
  rounds: number
  durationSec: number
  /** stored size, bytes */
  bytes: number
}

export function metaOf(d: ReplayData, bytes: number, pinned = false): ReplayMeta {
  return {
    id: d.id,
    date: d.date,
    netId: d.netId,
    pinned,
    localPlayer: d.localPlayer,
    players: d.slots.map((s) => ({ id: s.id, name: s.name, color: s.color })),
    winners: [...d.winners],
    rounds: d.rounds.length,
    durationSec: Math.round(secondsOf(d.endTick - d.start.tick)),
    bytes,
  }
}

export function encodeInputs(inputs: readonly PlayerInput[]): ReplayStep[1] {
  return inputs.map((i) => [i.player, i.cmds.map(encodeCmd)])
}

/** The PlayerInputs of one stored step, exactly as stepped (tick-stamped like the stream). */
export function decodeInputs(step: ReplayStep): PlayerInput[] {
  const out: PlayerInput[] = []
  for (const [player, wire] of step[1]) {
    const cmds: InputCommand[] = []
    for (const w of wire) {
      const c = decodeCmd(w)
      if (c) cmds.push(c)
    }
    out.push({ player, tick: step[0], cmds })
  }
  return out
}

export type ReplayCheck = { ok: true } | { ok: false; reason: 'build'; netId: string } | { ok: false; reason: 'invalid' }

/** Can this build play it? */
export function checkReplay(d: ReplayData, netId: string): ReplayCheck {
  if (d.netId !== netId) return { ok: false, reason: 'build', netId: d.netId }
  return { ok: true }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Validate parsed JSON as a replay; null if it is not one (or is malformed). */
export function asReplay(v: unknown): ReplayData | null {
  if (!isObj(v) || v.format !== REPLAY_FORMAT || v.v !== REPLAY_VERSION) return null
  if (typeof v.id !== 'string' || typeof v.netId !== 'string' || !isNum(v.date) || !isNum(v.endTick)) return null
  if (!(TICK_RATES as readonly unknown[]).includes(v.hz)) return null
  const start = v.start
  if (!isObj(start) || !isNum(start.tick) || !Array.isArray(start.pawns) || !Array.isArray(start.scores)) return null
  if (!Array.isArray(v.steps) || !Array.isArray(v.slots) || !isObj(v.settings)) return null
  for (const s of v.steps) if (!Array.isArray(s) || !isNum(s[0]) || !Array.isArray(s[1])) return null
  const arr = (x: unknown) => (Array.isArray(x) ? x : [])
  return {
    ...(v as unknown as ReplayData),
    localPlayer: isNum(v.localPlayer) ? v.localPlayer : -1,
    seed: isNum(v.seed) ? v.seed : null,
    resyncs: arr(v.resyncs).filter((r) => Array.isArray(r) && isNum(r[0]) && isObj(r[1])) as [number, SimState][],
    hashes: arr(v.hashes).filter((h) => Array.isArray(h) && isNum(h[0]) && isNum(h[1])) as [number, number][],
    rounds: arr(v.rounds).filter((r) => Array.isArray(r) && isNum(r[0])) as [number, number][],
    kills: arr(v.kills).filter((k) => Array.isArray(k) && isNum(k[0])) as [number, PlayerId | null, PlayerId][],
    winners: arr(v.winners).filter(isNum),
  }
}

// ---------------------------------------------------------------------------
// bytes: gzip when available, plain UTF-8 JSON otherwise (both load)
// ---------------------------------------------------------------------------

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>)).arrayBuffer()
  return new Uint8Array(await out)
}

export async function encodeReplay(d: ReplayData): Promise<Uint8Array> {
  const raw = new TextEncoder().encode(JSON.stringify(d))
  if (typeof CompressionStream !== 'function') return raw
  try {
    return await pipe(raw, new CompressionStream('gzip'))
  } catch {
    return raw
  }
}

/** Decode `.brawlock` bytes (gzip or plain JSON). Null if they are not a replay. */
export async function decodeReplay(bytes: Uint8Array): Promise<ReplayData | null> {
  try {
    let raw = bytes
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream !== 'function') return null
      raw = await pipe(bytes, new DecompressionStream('gzip'))
    }
    return asReplay(JSON.parse(new TextDecoder().decode(raw)))
  } catch {
    return null
  }
}

/** File name for an export: brawlock-2026-10-18-Alice-vs-Bob.brawlock */
export function replayFileName(m: Pick<ReplayMeta, 'date' | 'players'>): string {
  const day = new Date(m.date).toISOString().slice(0, 10)
  const who = m.players.map((p) => p.name.replace(/[^A-Za-z0-9_-]+/g, '')).filter(Boolean).slice(0, 4).join('-vs-') || 'match'
  return `brawlock-${day}-${who}${REPLAY_EXT}`
}
