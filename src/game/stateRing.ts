/**
 * The last RING_SECONDS of confirmed states and every tick's events, for the Final Blow replay
 * (docs/moonshot/specs/final-blow.md). States are cloned on the way in, because the stream
 * client steps its confirmed state in place, and kept at most RING_RATE per second (every second
 * state at 60 Hz). A kept state is never mutated, so a plan can hold references to the states it
 * needs while the ring drops old ones.
 */
import { cloneState } from '../sim/snapshot'
import { ticks } from '../sim/config'
import { TICK_HZ, type SimEvent, type SimState } from '../sim/types'
import type { TickEvents } from './frame'

/** how far back the ring reaches (s): holds 97% of measured round deciders */
export const RING_SECONDS = 8
/** kept states per second at most */
export const RING_RATE = 30

export class StateRing {
  private states: SimState[] = []
  private events: TickEvents[] = []
  private lastKept = -Infinity
  private lastTick = -Infinity

  reset(): void {
    this.states = []
    this.events = []
    this.lastKept = -Infinity
    this.lastTick = -Infinity
  }

  /** One confirmed tick (or several, from a snapshot client): the state after it and its events. */
  observe(state: SimState, events: readonly SimEvent[]): void {
    // a new match or a seek back starts over
    if (state.tick < this.lastTick - ticks(1)) this.reset()
    this.lastTick = state.tick
    if (events.length > 0) this.events.push({ tick: state.tick, events: events.slice() })
    const every = Math.max(1, Math.round(TICK_HZ / RING_RATE))
    if (state.tick - this.lastKept >= every) {
      this.states.push(cloneState({ ...state, events: [] }))
      this.lastKept = state.tick
    }
    const oldest = state.tick - ticks(RING_SECONDS)
    let s = 0
    while (s < this.states.length && this.states[s].tick < oldest) s++
    if (s > 0) this.states.splice(0, s)
    let e = 0
    while (e < this.events.length && this.events[e].tick < oldest) e++
    if (e > 0) this.events.splice(0, e)
  }

  /** tick of the oldest kept state; Infinity when empty */
  get oldest(): number {
    return this.states.length > 0 ? this.states[0].tick : Infinity
  }

  /** tick of the newest kept state; -Infinity when empty */
  get newest(): number {
    return this.states.length > 0 ? this.states[this.states.length - 1].tick : -Infinity
  }

  /** The kept states from the last one at or before `from` through `to`, oldest first. */
  statesIn(from: number, to: number): SimState[] {
    let first = 0
    for (let i = 0; i < this.states.length; i++) if (this.states[i].tick <= from) first = i
    return this.states.slice(first).filter((s) => s.tick <= to)
  }

  /** Event batches with `from < tick <= to`, in tick order. */
  eventsIn(from: number, to: number): TickEvents[] {
    return this.events.filter((e) => e.tick > from && e.tick <= to)
  }
}

/** The match's ring, fed by the match recorder next to the moments engine. */
export const matchRing = new StateRing()
