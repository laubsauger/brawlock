/**
 * Input-stream netcode (M4.2, docs/M4.md §1.4): the authority (P2P host or dedicated
 * server) sends the confirmed, tick-stamped inputs it stepped instead of full
 * snapshots. Every peer steps the same deterministic sim from the same start state
 * (createMatch(settings, slots, seed), or a keyframe snapshot), so its confirmed
 * state equals the host's tick for tick; prediction runs on top as before.
 *
 * Wire packet `is` (protocol.ts), sent every tick, the tick it is stepped:
 *   n       packet counter per client (loss stats)
 *   to, r   the frames of the steps from tick to - r up to (not incl.) to: `to` is the
 *           host's state tick after its latest step. Ticks with inputs go out at once and
 *           ride REDUNDANCY packets; empty stretches go out every HEARTBEAT_TICKS and also
 *           ride three. A gap beyond that is asked for with `need` and resent from the
 *           history (or healed with a keyframe).
 *   i       [tick - from, player, cmds, ackSeq?] per input stepped (cmds in the compact
 *           form of encodeCmd); ackSeq (client players) = highest own input seq of that
 *           player applied by that step. Absent when no step in the range had inputs.
 *   c       [tick - from, player, connected 0|1]: the `connected` patch applied before a step
 *   h       [tick, hash] of the newest checkpoint state (every HASH_EVERY ticks)
 */
import { TICK_HZ, onTickRate, type InputCommand, type PlayerId, type PlayerInput, type PlayerSlot } from '../sim/types'
import { ticks } from '../sim/config'

let DT_MS = 0

/** Each step's inputs ride this many packets (one per tick): a gap needs 3 losses in a row. */
export const REDUNDANCY = 3
/**
 * Steps without inputs carry no action, so they need not go out every tick: without
 * new inputs a client gets a packet every HEARTBEAT_TICKS (ranges reach back three
 * packets, so empty steps ride three packets like the others). A step with inputs goes
 * out the tick it is stepped, always.
 */
export let HEARTBEAT_TICKS = 0
/** Host keeps this many steps for resends; an older gap gets a keyframe. */
export let HISTORY_TICKS = 0
/** State hash checkpoint interval, ticks. */
export let HASH_EVERY = 0
onTickRate(() => {
  DT_MS = 1000 / TICK_HZ
  HEARTBEAT_TICKS = ticks(0.05)
  HISTORY_TICKS = ticks(3)
  HASH_EVERY = ticks(1)
})

/** One confirmed step: the inputs and `connected` patches applied from `tick` to `tick + 1`. */
export interface StreamTick {
  tick: number
  inputs: PlayerInput[]
  /** per input player: the highest own input seq applied (client players only) */
  acks?: Map<PlayerId, number>
  patches?: [PlayerId, boolean][]
  /** Seat identity changes or between-round additions, applied before this step. */
  slots?: PlayerSlot[]
}

export type WireCmd = unknown[] | InputCommand
export type WireInput = [number, PlayerId, WireCmd[], number?]
export type WirePatch = [number, PlayerId, 0 | 1]
export type WireSlot = [number, PlayerSlot]

/**
 * Compact command form for the stream: the frequent kinds as positional arrays
 * (`['m', x, y]`, `['c', slot, x, y]`, `['s']`), anything else as is. decodeCmd
 * rebuilds the same object, same key order, so confirmed commands compare equal to
 * the ones the client predicted.
 */
export function encodeCmd(c: InputCommand): WireCmd {
  switch (c.kind) {
    case 'move':
      return ['m', c.x, c.y]
    case 'cast':
      return ['c', c.slot, c.x, c.y]
    case 'stop':
      return ['s']
    default:
      return c
  }
}

export function decodeCmd(w: WireCmd): InputCommand | null {
  if (!Array.isArray(w)) return w && typeof w === 'object' && typeof (w as InputCommand).kind === 'string' ? (w as InputCommand) : null
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  switch (w[0]) {
    case 'm':
      return num(w[1]) && num(w[2]) ? { kind: 'move', x: w[1] as number, y: w[2] as number } : null
    case 'c':
      return num(w[1]) && num(w[2]) && num(w[3]) ? ({ kind: 'cast', slot: w[1], x: w[2], y: w[3] } as InputCommand) : null
    case 's':
      return { kind: 'stop' }
    default:
      return null
  }
}

/**
 * Move and cast targets in 1/100 game units (pawn radius is 30): every peer steps the
 * same rounded numbers, which print in ~6 characters instead of 17. The session rounds
 * at the source (own input before predicting and sending, host input, bot output).
 */
export function quantizeCmds(cmds: InputCommand[]): InputCommand[] {
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i]
    if (c.kind === 'move' || c.kind === 'cast') {
      const x = Math.round(c.x * 100) / 100
      const y = Math.round(c.y * 100) / 100
      if (x !== c.x || y !== c.y) cmds[i] = { ...c, x, y }
    }
  }
  return cmds
}

/** Host side: the confirmed timeline of the last HISTORY_TICKS steps. */
export class StreamHistory {
  private steps: StreamTick[] = []

  /** First step still held, and one past the newest (empty: both = -1). */
  get start(): number {
    return this.steps.length ? this.steps[0].tick : -1
  }
  get end(): number {
    return this.steps.length ? this.steps[this.steps.length - 1].tick + 1 : -1
  }

  push(step: StreamTick): void {
    if (this.steps.length && step.tick !== this.end) this.steps = []
    this.steps.push(step)
    if (this.steps.length > HISTORY_TICKS) this.steps.shift()
  }

  /** Any inputs or patches in the steps [from, to)? */
  hasContent(from: number, to: number): boolean {
    const s0 = this.start
    for (let t = Math.max(from, s0); t < to; t++) {
      const st = this.steps[t - s0]
      if (st && (st.inputs.length || st.patches || st.slots)) return true
    }
    return false
  }

  /** Can [from, end) be sent? */
  covers(from: number): boolean {
    return this.steps.length > 0 && from >= this.start && from <= this.end
  }

  /** Wire arrays for steps [from, to). */
  slice(from: number, to: number): { i: WireInput[]; c: WirePatch[]; s: WireSlot[] } {
    const i: WireInput[] = []
    const c: WirePatch[] = []
    const s: WireSlot[] = []
    const s0 = this.start
    for (let t = Math.max(from, s0); t < to; t++) {
      const st = this.steps[t - s0]
      if (!st) break
      for (const inp of st.inputs) {
        const q = st.acks?.get(inp.player)
        const cmds = inp.cmds.map(encodeCmd)
        i.push(q === undefined ? [t - from, inp.player, cmds] : [t - from, inp.player, cmds, q])
      }
      if (st.patches) for (const [id, on] of st.patches) c.push([t - from, id, on ? 1 : 0])
      if (st.slots) for (const slot of st.slots) s.push([t - from, slot])
    }
    return { i, c, s }
  }
}

/**
 * Client side: received steps and which ticks are covered. The confirmed state
 * needs step `next` to advance; steps are taken in order, each exactly once.
 */
export class StreamFeed {
  /** the next step the confirmed state needs */
  next = 0
  private steps = new Map<number, StreamTick>()
  /** covered tick intervals [from, to), merged, sorted, all ≥ next */
  private covered: [number, number][] = []

  /** The confirmed state is at `tick` (start or keyframe): drop everything older. */
  reset(tick: number): void {
    this.next = tick
    for (const t of this.steps.keys()) if (t < tick) this.steps.delete(t)
    this.covered = this.covered.filter(([, to]) => to > tick).map(([from, to]) => [Math.max(from, tick), to])
  }

  /** A packet's steps [from, to); `inputs` / `patches` as decoded from the wire. */
  accept(from: number, to: number, inputs: WireInput[], patches: WirePatch[], slots: WireSlot[] = []): void {
    if (to <= this.next || to <= from) return
    const lo = Math.max(from, this.next)
    const fresh: Map<number, StreamTick> = new Map()
    for (let t = lo; t < to; t++) {
      if (this.has(t)) continue
      fresh.set(t, { tick: t, inputs: [] })
    }
    if (fresh.size === 0) return
    for (const w of inputs) {
      if (!Array.isArray(w) || typeof w[0] !== 'number' || typeof w[1] !== 'number' || !Array.isArray(w[2])) continue
      const st = fresh.get(from + w[0])
      if (!st) continue
      const cmds: InputCommand[] = []
      for (const wc of w[2]) {
        const c = decodeCmd(wc)
        if (c) cmds.push(c)
      }
      st.inputs.push({ player: w[1], tick: st.tick, cmds })
      if (typeof w[3] === 'number') (st.acks ??= new Map()).set(w[1], w[3])
    }
    for (const w of patches) {
      if (!Array.isArray(w) || typeof w[0] !== 'number' || typeof w[1] !== 'number') continue
      const st = fresh.get(from + w[0])
      if (st) (st.patches ??= []).push([w[1], w[2] === 1])
    }
    for (const w of slots) {
      if (!Array.isArray(w) || typeof w[0] !== 'number' || !w[1] || !Number.isInteger(w[1].id)) continue
      const st = fresh.get(from + w[0])
      if (st) (st.slots ??= []).push(w[1])
    }
    for (const [t, st] of fresh) this.steps.set(t, st)
    this.cover(lo, to)
  }

  /** Step `next`, if received; advances `next`. */
  take(): StreamTick | null {
    const c = this.covered[0]
    if (!c || c[0] > this.next) return null
    const st = this.steps.get(this.next) ?? { tick: this.next, inputs: [] }
    this.steps.delete(this.next)
    this.next++
    if (this.next >= c[1]) this.covered.shift()
    else c[0] = this.next
    return st
  }

  /** First missing step while later ones are already here (ask for it), else null. */
  gap(): number | null {
    const c = this.covered[0]
    return c && c[0] > this.next ? this.next : null
  }

  /** One past the newest covered step (how far the host's stream got). */
  get head(): number {
    return this.covered.length ? this.covered[this.covered.length - 1][1] : this.next
  }

  private has(t: number): boolean {
    for (const [from, to] of this.covered) if (t >= from && t < to) return true
    return false
  }

  private cover(from: number, to: number): void {
    const all = [...this.covered, [from, to] as [number, number]].sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const r of all) {
      const last = merged[merged.length - 1]
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
      else merged.push([r[0], r[1]])
    }
    this.covered = merged
  }
}

/**
 * Local arrival time of host tick 0 over the fastest recent path (base) and the
 * mean deviation from it (jitter), from (host tick, arrival) samples. The lead
 * clock steers prediction from these, as it did from snapshot arrivals.
 */
export class ArrivalClock {
  private static readonly WINDOW = 120
  private samples: number[] = []
  private jitter = 8
  latestAt = 0
  latestTick = -1

  push(tick: number, arrival: number): void {
    const s = arrival - tick * DT_MS
    this.samples.push(s)
    if (this.samples.length > ArrivalClock.WINDOW) this.samples.shift()
    this.jitter = this.jitter * 0.95 + (s - this.min()) * 0.05
    if (tick > this.latestTick) {
      this.latestTick = tick
      this.latestAt = arrival
    }
  }

  get baseMs(): number {
    return this.samples.length ? this.min() : NaN
  }

  get jitterMs(): number {
    return this.jitter
  }

  private min(): number {
    let m = Infinity
    for (const s of this.samples) if (s < m) m = s
    return m
  }
}
