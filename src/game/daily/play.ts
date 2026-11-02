/**
 * Playing the daily (docs/moonshot/specs/daily.md): an attempt token from the account service
 * (or a local salt offline), then the run in the match scene with the real renderer, input and
 * audio, like guided practice but without a pause: it runs in real time as online play does. The
 * human's commands go on a tape; at the end the tape is submitted and the server's verified score
 * replaces the local one. A submission that cannot reach the service waits and retries.
 */
import { create } from 'zustand'
import { audio } from '../../audio'
import { startClock } from '../../net/clock'
import { setTickRate, TICK_HZ, type Phase } from '../../sim/types'
import { frame, pushEvents, pushState, resetFrame } from '../frame'
import { input } from '../input'
import { browserId, getProfile } from '../profile'
import { useGame } from '../store'
import { localEquipment } from '../wardrobe'
import { dayOf, defineDay, type DailyDay } from './calendar'
import { DAILY_ID, requestAttempt, submitRun, type DailyVerified } from './client'
import { DAILY_HZ, DailyRun, type DailyResult } from './run'
import { TapeRecorder, type DailyTape } from './tape'

/** What the daily HUD shows; changes per event, never per frame (the clock reads `dailyClock`). */
export interface DailyRunView {
  day: DailyDay
  wave: number
  lives: number
  bountyKos: number
  phase: Phase
  ranked: boolean
}

export type DailyOutcomeState = 'pending' | 'verified' | 'rejected' | 'unranked' | 'offline' | 'retry'

export interface DailyOutcome {
  day: DailyDay
  result: DailyResult
  state: DailyOutcomeState
  verified?: DailyVerified
  /** why it was not ranked or verified */
  code?: string
  attempt?: string
  /** what Watch replays: the run's salt and tape */
  watch?: { salt: number; tape: DailyTape }
}

export const useDaily = create<{ run: DailyRunView | null; outcome: DailyOutcome | null }>(() => ({ run: null, outcome: null }))

/** fight ticks so far, for the HUD clock (read every frame, never React state) */
export const dailyClock = { fight: 0 }

interface Pending {
  attempt: string
  tape: DailyTape
  claimed: { waves: number; time: number }
  device: string
}
const PENDING_KEY = 'brawlock.daily.pending'
const readPending = (): Pending[] => {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as Pending[]
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
const writePending = (list: Pending[]) => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-5)))
  } catch {
    /* private mode: the run stays unsubmitted */
  }
}

let stop: (() => void) | null = null

/** The run in progress gives up (Abandon, or leaving the match). */
export function abandonDaily(): void {
  stop?.()
}

/** Today's (or `day`'s) daily: a token, then the run. `serverNow` keeps the day honest on a wrong local clock. */
export async function playDaily(serverOffset = 0): Promise<void> {
  if (stop) return
  const device = browserId()
  const day = dayOf(Date.now() + serverOffset)
  const token = await requestAttempt(day, device)
  const ranked = 'attempt' in token
  const salt = ranked ? token.salt : crypto.getRandomValues(new Uint32Array(1))[0]
  setTickRate(DAILY_HZ)
  const def = defineDay(day)
  const profile = getProfile()
  const run = new DailyRun(def, salt, { name: profile.name, color: profile.color ?? 0xff7700, cosmetics: localEquipment() ?? undefined })
  const tape = new TapeRecorder(day, DAILY_ID)
  const store = useGame.getState()
  for (const key of ['paused', 'shopOpen', 'characterOpen', 'scoreboardOpen'] as const) store.toggle(key, false)
  store.setLobby({ role: 'offline', status: 'open', slots: run.state.slots, settings: run.state.settings, localPlayer: 0, error: null, notice: null })
  store.setResult(null)
  input.drain()
  resetFrame()
  frame.localPlayer = 0
  pushState(run.state)
  dailyClock.fight = 0
  const view = (): DailyRunView => ({ day: def, wave: run.wave, lives: run.lives, bountyKos: run.bountyKos, phase: run.state.phase, ranked })
  useDaily.setState({ run: view(), outcome: null })
  store.setScreen('match')
  let last = performance.now()
  let acc = 0
  const dt = 1000 / TICK_HZ
  let finished = false
  const finish = (abandoned: boolean) => {
    if (finished) return
    finished = true
    stopClock()
    unsubscribe()
    stop = null
    if (abandoned) run.abandon()
    const recorded = tape.finish(run.state.tick, run.ended === 'abandoned')
    const result = run.result()
    useDaily.setState({ run: null, outcome: { day: def, result, state: ranked ? 'pending' : token.code === 'offline' ? 'offline' : 'unranked', code: ranked ? undefined : token.code, attempt: ranked ? token.attempt : undefined, watch: { salt, tape: recorded } } })
    input.drain()
    if (useGame.getState().screen === 'match') useGame.getState().setScreen('daily')
    resetFrame()
    if (ranked) void deliver({ attempt: token.attempt, tape: recorded, claimed: { waves: result.waves, time: result.timeTicks }, device })
  }
  const stopClock = startClock((now) => {
    // no pause: the daily runs in real time, also in a hidden tab
    acc += Math.min(100, Math.max(0, now - last))
    last = now
    while (acc >= dt && !finished) {
      acc -= dt
      const before = view()
      const cmds = input.drain()
      tape.record(run.state.tick, cmds)
      run.tick(cmds)
      dailyClock.fight = run.clockTicks
      pushState(run.state, now - acc)
      pushEvents(run.state.tick, run.state.events)
      const pawn = run.state.pawns.find((p) => p.owner === 0)!
      audio.playEvents(run.state.events, { x: pawn.x, y: pawn.y, halfWidth: 1800, localPlayer: 0, state: run.state })
      const after = view()
      if (after.wave !== before.wave || after.lives !== before.lives || after.bountyKos !== before.bountyKos || after.phase !== before.phase) {
        useDaily.setState({ run: after })
        if (after.phase !== before.phase) useGame.getState().toggle('shopOpen', after.phase === 'shop')
      }
      if (run.ended) finish(false)
    }
  })
  const unsubscribe = useGame.subscribe((next) => {
    if (next.screen !== 'match') finish(true)
  })
  stop = () => finish(true)
}

/** Submit a finished run; one that cannot reach the service waits for the next try. */
async function deliver(p: Pending): Promise<void> {
  const out = await submitRun(p.attempt, p.tape, p.claimed, p.device)
  const current = useDaily.getState().outcome
  const mine = current?.attempt === p.attempt
  if (out.status === 'retry') {
    writePending([...readPending().filter((x) => x.attempt !== p.attempt), p])
    if (mine) useDaily.setState({ outcome: { ...current!, state: 'retry' } })
    return
  }
  writePending(readPending().filter((x) => x.attempt !== p.attempt))
  if (!mine) return
  if (out.status === 'verified') useDaily.setState({ outcome: { ...current!, state: 'verified', verified: out } })
  else useDaily.setState({ outcome: { ...current!, state: 'rejected', code: out.code } })
}

/** Runs that could not be posted yet (the Daily screen retries them when it opens). */
export function retryPending(): void {
  for (const p of readPending()) void deliver(p)
}
