/**
 * Records one match as a replay. Fed by the session's MatchRecorder hooks:
 * `step` with the state before each confirmed step, its inputs and `connected` patches
 * (P2P host / offline loop and the input-stream client both call it), `observe` with the
 * state after it. Peers that only receive snapshots (classic / snapshot netcode) never
 * step, so they record nothing and finish() returns null.
 *
 * Memory: one compact entry per non-empty step; the state is copied once at the start
 * (and again only if the stream jumps, e.g. a keyframe heal).
 */
import { cloneState, hashState } from '../../sim'
import type { MatchSettings, PlayerId, PlayerInput, PlayerSlot, SimEvent, SimState } from '../../sim/types'
import { HASH_EVERY, REPLAY_FORMAT, REPLAY_VERSION, encodeInputs, type ReplayData, type ReplayStep } from './format'

export interface ReplayStartInfo {
  localPlayer: PlayerId
  slots: PlayerSlot[]
  settings: MatchSettings
  seed?: number
}

/** hash of a state as the replay stores it (events are per-tick output, not state) */
export function replayHash(s: SimState): number {
  return hashState({ ...s, events: [] })
}

export class ReplayRecorder {
  private info: ReplayStartInfo | null = null
  private start: SimState | null = null
  private steps: ReplayStep[] = []
  private resyncs: [number, SimState][] = []
  private hashes: [number, number][] = []
  private rounds: [number, number][] = []
  private kills: [number, PlayerId | null, PlayerId][] = []
  /** state tick the next step must start from */
  private next = -1

  begin(info: ReplayStartInfo): void {
    this.info = { ...info, slots: info.slots.map((s) => ({ ...s })), settings: { ...info.settings } }
    this.start = null
    this.steps = []
    this.resyncs = []
    this.hashes = []
    this.rounds = []
    this.kills = []
    this.next = -1
  }

  get recording(): boolean {
    return this.info !== null
  }

  /** One confirmed step about to run from `before` (not yet patched). */
  step(before: SimState, inputs: readonly PlayerInput[], patches?: readonly (readonly [PlayerId, boolean])[]): void {
    if (!this.info) return
    if (!this.start) this.start = cloneState(before)
    else if (before.tick !== this.next) this.resyncs.push([before.tick, cloneState(before)])
    this.next = before.tick + 1
    const p = patches && patches.length ? patches.map(([id, on]) => [id, on ? 1 : 0] as [PlayerId, 0 | 1]) : undefined
    if (inputs.length === 0 && !p) return
    const entry: ReplayStep = [before.tick, encodeInputs(inputs)]
    if (p) entry[2] = p
    this.steps.push(entry)
  }

  /** The state after a step (and that step's events): checkpoints and timeline markers. */
  observe(state: SimState, events: readonly SimEvent[]): void {
    if (!this.info || !this.start) return
    if (state.tick % HASH_EVERY === 0) this.hashes.push([state.tick, replayHash(state)])
    for (const e of events) {
      if (e.type === 'phase' && e.phase === 'fight') this.rounds.push([state.tick, e.round])
      else if (e.type === 'death') this.kills.push([state.tick, e.killer, e.owner])
    }
  }

  /** The finished replay, or null when nothing was stepped here (snapshot client, abort). */
  finish(id: string, netId: string, winners: readonly PlayerId[], date = Date.now()): ReplayData | null {
    const info = this.info
    const start = this.start
    this.info = null
    if (!info || !start || this.next < 0) return null
    return {
      format: REPLAY_FORMAT,
      v: REPLAY_VERSION,
      id,
      netId,
      date,
      localPlayer: info.localPlayer,
      seed: info.seed ?? null,
      settings: info.settings,
      slots: info.slots,
      start,
      endTick: this.next,
      steps: this.steps,
      resyncs: this.resyncs,
      hashes: this.hashes,
      rounds: this.rounds,
      kills: this.kills,
      winners: [...winners],
    }
  }

  abort(): void {
    this.info = null
    this.start = null
  }
}
