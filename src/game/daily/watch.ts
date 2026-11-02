/**
 * Watch a daily run (docs/moonshot/specs/daily.md): its tape re-simulated with this build's daily
 * code into a replay for the viewer. Client only (the verifier bundle has no use for replays).
 */
import type { CosmeticEquipment } from '../progressionCatalog'
import { ReplayRecorder } from '../replay/recorder'
import type { ReplayData } from '../replay/format'
import { setTickRate } from '../../sim/types'
import { defineDay } from './calendar'
import { DAILY_HZ, DailyRun } from './run'
import { readTape } from './tape'

export interface WatchInput {
  day: number
  salt: number
  tape: unknown
  /** the replay's id (the attempt) and date, for the viewer */
  id: string
  date: number
  netId: string
  /** who played it, as the board shows them */
  player: { name: string; color: number; cosmetics?: CosmeticEquipment }
}

/** The run as a replay, or null when the tape does not read. */
export function dailyReplay(w: WatchInput): ReplayData | null {
  const read = readTape(w.tape)
  if (!read.ok) return null
  setTickRate(DAILY_HZ)
  const run = new DailyRun(defineDay(w.day), w.salt >>> 0, w.player)
  const rec = new ReplayRecorder()
  rec.begin({ localPlayer: 0, slots: run.state.slots, settings: run.state.settings, seed: run.day.seed })
  while (!run.ended && run.state.tick < read.end) {
    const wave = run.wave
    run.tick(read.byTick.get(run.state.tick) ?? [], (inputs) => rec.step(run.state, inputs))
    rec.observe(run.state, run.state.events)
    // the director seated the next wave between steps
    if (run.wave !== wave && !run.ended) rec.resync(run.state)
  }
  return rec.finish(w.id, w.netId, run.result().waves > 0 ? [0] : [], w.date)
}
