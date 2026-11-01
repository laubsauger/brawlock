/**
 * A daily run's tape (docs/moonshot/specs/daily.md): the human seat's commands, which with the day
 * and the attempt's salt are all a verifier needs to replay the run. Entries are
 * `[ticks since the previous entry, ...wire commands]` in the input stream's encoding; the tape ends
 * at the tick the run ended (or was abandoned).
 */
import { decodeCmd, encodeCmd, type WireCmd } from '../../net/stream'
import { ticks } from '../../sim/config'
import type { InputCommand } from '../../sim/types'
import { DAILY_MAX_SECONDS } from './run'

export const TAPE_VERSION = 1
/** limits a verifier enforces */
export const TAPE_MAX_PER_STEP = 16
export const TAPE_MAX_COMMANDS = 20_000

export interface DailyTape {
  v: typeof TAPE_VERSION
  day: number
  /** the verifier build the run was played on */
  dailyId: string
  entries: [number, ...WireCmd[]][]
  /** the tick the run ended at */
  end: number
  /** the player gave up there (the run ends at `end` whatever the sim says) */
  abandoned: boolean
}

export class TapeRecorder {
  private entries: [number, ...WireCmd[]][] = []
  private last = 0
  private count = 0

  constructor(
    private readonly day: number,
    private readonly dailyId: string,
  ) {}

  /** the commands applied in the step from `tick` */
  record(tick: number, cmds: readonly InputCommand[]): void {
    if (cmds.length === 0) return
    this.entries.push([tick - this.last, ...cmds.map(encodeCmd)])
    this.last = tick
    this.count += cmds.length
  }

  get commands(): number {
    return this.count
  }

  finish(end: number, abandoned: boolean): DailyTape {
    return { v: TAPE_VERSION, day: this.day, dailyId: this.dailyId, entries: this.entries.slice(), end, abandoned }
  }
}

/** The tape's commands by tick, or why it cannot be one. */
export function readTape(t: unknown): { ok: true; byTick: Map<number, InputCommand[]>; end: number; abandoned: boolean; commands: number; casts: number } | { ok: false; reason: string } {
  if (!t || typeof t !== 'object') return { ok: false, reason: 'malformed' }
  const tape = t as Partial<DailyTape>
  if (tape.v !== TAPE_VERSION || !Array.isArray(tape.entries) || !Number.isInteger(tape.end) || typeof tape.abandoned !== 'boolean') return { ok: false, reason: 'malformed' }
  if (tape.end! < 0 || tape.end! > ticks(DAILY_MAX_SECONDS)) return { ok: false, reason: 'too long' }
  const byTick = new Map<number, InputCommand[]>()
  let tick = 0
  let commands = 0
  let casts = 0
  for (const e of tape.entries) {
    if (!Array.isArray(e) || !Number.isInteger(e[0]) || (e[0] as number) < 0) return { ok: false, reason: 'malformed' }
    tick += e[0] as number
    if (tick > tape.end!) return { ok: false, reason: 'malformed' }
    const cmds: InputCommand[] = []
    for (const w of e.slice(1)) {
      const c = decodeCmd(w as WireCmd)
      if (!c) return { ok: false, reason: 'malformed' }
      if (c.kind === 'cast') casts++
      cmds.push(c)
    }
    const all = [...(byTick.get(tick) ?? []), ...cmds]
    if (all.length > TAPE_MAX_PER_STEP) return { ok: false, reason: 'too many commands in a tick' }
    commands += cmds.length
    if (commands > TAPE_MAX_COMMANDS) return { ok: false, reason: 'too many commands' }
    byTick.set(tick, all)
  }
  return { ok: true, byTick, end: tape.end!, abandoned: tape.abandoned!, commands, casts }
}
