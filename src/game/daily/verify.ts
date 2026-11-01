/**
 * The daily verifier (docs/moonshot/specs/daily.md): replays a tape against the day and the salt
 * and returns the score the sim gives. A claimed score never counts. Bundled per build for the
 * account service (scripts/daily-id.mjs), and used by the client to watch a run.
 */
import { hashState } from '../../sim/snapshot'
import { setTickRate } from '../../sim/types'
import { defineDay } from './calendar'
import { DAILY_HZ, DailyRun, type DailyResult } from './run'
import { readTape } from './tape'

export interface VerifyInput {
  day: number
  salt: number
  tape: unknown
}

export type VerifyOutput = ({ ok: true; commands: number; casts: number; hash: number } & DailyResult) | { ok: false; reason: string }

/** the name every verifier run uses for the human seat (names never change the sim) */
const VERIFY_PLAYER = { name: 'you', color: 0xff7700 }

export function verify(input: VerifyInput): VerifyOutput {
  const read = readTape(input.tape)
  if (!read.ok) return read
  if ((input.tape as { day?: number }).day !== input.day) return { ok: false, reason: 'wrong day' }
  setTickRate(DAILY_HZ)
  const run = new DailyRun(defineDay(input.day), input.salt >>> 0, VERIFY_PLAYER)
  while (!run.ended && run.state.tick < read.end) run.tick(read.byTick.get(run.state.tick) ?? [])
  if (!run.ended && read.abandoned) run.abandon()
  if (!run.ended) run.abandon()
  return { ok: true, commands: read.commands, casts: read.casts, hash: hashState({ ...run.state, events: [] }), ...run.result() }
}
