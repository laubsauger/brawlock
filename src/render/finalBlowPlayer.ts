/**
 * Plays a Final Blow (docs/moonshot/specs/final-blow.md) in the match world: a beat after a
 * displayed round win it takes the round's decider from the moments engine, plans the replay,
 * swaps the world onto a private source fed from the state ring at the plan's clock, slows the
 * world clock to the plan's speed and frames each segment with the cinematic camera; then it
 * swaps back to the live stream for the winner's hero shot. The sim and the session never pause.
 * Any key or click skips it.
 */
import { audio } from '../audio'
import { matchMoments, type Moment } from '../game/moments'
import { FB_DELAY, RESULTS_HOLD_MAX, planClock, planFinalBlow, resultsHold, type FinalBlowPlan } from '../game/finalBlow'
import type { TickEvents } from '../game/frame'
import { RING_SECONDS, matchRing } from '../game/stateRing'
import { useGame } from '../game/store'
import { trackEvent } from '../lib/analytics'
import { ticks } from '../sim/config'
import type { SimState } from '../sim/types'
import type { CamPose } from './cinematic/cam'
import { finalBlowPose, finalBlowYaw, pushTarget } from './finalBlowCamera'
import { createPrivateSource, globalSource, writeSubTick, type RenderSource } from './source'

/** What the player needs from the match world. */
export interface FinalBlowWorld {
  /** draw from `src`; pawns alive in `rewindTo` forget their death and victory first */
  setSource(src: RenderSource, rewindTo: SimState | null): void
  /** world clock speed (0 = frozen) */
  setTimeScale(k: number): void
  /** a cinematic camera pose in game units, or back to the gameplay camera */
  setPose(p: CamPose | null): void
  /** back on the live stream: winners celebrate, the hero shot, no stale events */
  returnToLive(): void
}

/** the push target follows the victim with this lag rate (1/s) */
const TARGET_RATE = 4
/** a round Final Blow ends this long after the live state left the round end (s) */
const LIVE_GRACE = 0.3

interface Playing {
  plan: FinalBlowPlan
  decider: Moment
  source: ReturnType<typeof createPrivateSource>
  states: SimState[]
  events: TickEvents[]
  elapsed: number
  /** last recorded tick whose events were handed to the world */
  pushed: number
  yaw: number
  target: { x: number; y: number }
  /** back on the live stream (the match version's hero shot) */
  live: boolean
  /** seconds the live state has been out of the round end */
  outOfRoundEnd: number
  startedAt: number
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export class FinalBlowPlayer {
  private pending: { plan: FinalBlowPlan; decider: Moment; wait: number } | null = null
  private play: Playing | null = null
  private readonly onSkip = (e: Event) => {
    if (e instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    this.end(true)
  }

  constructor(private readonly world: FinalBlowWorld) {}

  /** A Final Blow is on screen (or about to start): the world skips its own round-end camera work. */
  get active(): boolean {
    return this.play !== null && !this.play.live
  }

  /** A displayed round win on the live stream. */
  onRoundWin(round: number, tick: number): void {
    if (this.play || this.pending) return
    // live matches only: the replay viewer owns its own time, and the ring must be this match's
    if (useGame.getState().screen !== 'match' || matchRing.newest < tick - ticks(1)) return
    const pref = useGame.getState().settings.finalBlow ?? 'round'
    if (pref === 'off' || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
    const decider = matchMoments.deciderOf(round)
    if (!decider) return
    const kind = decider.traits.includes('matchDecider') ? 'match' : 'round'
    if (pref === 'match' && kind !== 'match') return
    const plan = planFinalBlow(decider, matchRing.oldest, kind, reducedMotion())
    if (!plan) return
    // the results wait for the match version (per viewer; the session keeps its own timing)
    if (kind === 'match') resultsHold.hold(RESULTS_HOLD_MAX * 1000)
    this.pending = { plan, decider, wait: FB_DELAY }
  }

  /** Once per rendered frame, before the world reads its source. `paused`: the offline pause. */
  frame(dtReal: number, paused: boolean): void {
    if (this.pending && !paused) {
      this.pending.wait -= dtReal
      if (this.pending.wait <= 0) {
        const { plan, decider } = this.pending
        this.pending = null
        this.start(plan, decider)
      }
    }
    const p = this.play
    if (!p) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return this.end(false)
    if (!paused) p.elapsed += dtReal
    // a round replay gives way once the live game has moved on to the shop
    const live = globalSource.buf.curr
    if (p.plan.kind === 'round' && live && live.phase !== 'roundEnd' && live.phase !== 'gameOver') {
      p.outOfRoundEnd += dtReal
      if (p.outOfRoundEnd >= LIVE_GRACE) return this.end(false)
    }
    const c = planClock(p.plan, p.elapsed)
    if (c) return this.show(p, c, dtReal)
    if (p.elapsed < p.plan.seconds) {
      // the match version's closing hero shot plays on the live stream
      if (!p.live) this.toLive(p)
      return
    }
    this.end(false)
  }

  /** Stop at once (leaving, a new match, the world going away). */
  abort(): void {
    this.pending = null
    if (this.play) this.end(false)
    else resultsHold.release()
  }

  private start(plan: FinalBlowPlan, decider: Moment): void {
    const first = plan.segments[0].from
    const states = matchRing.statesIn(first, Infinity)
    if (states.length === 0) {
      resultsHold.release()
      return
    }
    const source = createPrivateSource(ticks(RING_SECONDS) + 30)
    source.buf.localPlayer = -1 // a neutral point of view: no hurt flash or shake from replayed hits
    const at = (s: SimState | undefined, pawn: number | null) => (pawn === null ? undefined : s?.pawns.find((q) => q.id === pawn))
    const atHit = states.find((s) => s.tick >= decider.tick) ?? states[states.length - 1]
    const hitter = at(atHit, decider.camera.other)
    const victim = at(atHit, decider.camera.subject)
    const hitterP = hitter?.alive ? { x: hitter.x, y: hitter.y } : null
    const victimP = victim ? { x: victim.x, y: victim.y } : { x: decider.camera.x, y: decider.camera.y }
    const target = pushTarget(hitterP, victimP)
    this.play = {
      plan, decider, source, states, events: matchRing.eventsIn(first - 1, Infinity),
      elapsed: 0, pushed: first, yaw: finalBlowYaw(target, decider.camera.dirX, decider.camera.dirY, hitterP, victimP),
      target, live: false, outOfRoundEnd: 0, startedAt: performance.now(),
    }
    this.world.setSource(source, states[0])
    useGame.setState({ finalBlow: { kind: plan.kind, hitter: decider.actors[0], victim: decider.victims[0], cause: decider.cause, traits: decider.traits, partial: plan.partial } })
    window.addEventListener('keydown', this.onSkip, true)
    window.addEventListener('pointerdown', this.onSkip, true)
  }

  private show(p: Playing, c: { tick: number; speed: number; segment: number }, dtReal: number): void {
    // states and events that arrived since the start (the death's last moments)
    const lastKept = p.states[p.states.length - 1].tick
    if (matchRing.newest > lastKept) for (const s of matchRing.statesIn(lastKept, Infinity)) if (s.tick > lastKept) p.states.push(s)
    const lastEvents = p.events.length > 0 ? p.events[p.events.length - 1].tick : p.pushed
    for (const b of matchRing.eventsIn(lastEvents, Infinity)) p.events.push(b)
    // the two kept states around the playback tick
    let i = 0
    while (i + 1 < p.states.length && p.states[i + 1].tick <= c.tick) i++
    const s0 = p.states[i]
    const s1 = p.states[Math.min(i + 1, p.states.length - 1)]
    const alpha = s1.tick > s0.tick ? Math.max(0, Math.min(1, (c.tick - s0.tick) / (s1.tick - s0.tick))) : 1
    // events of every recorded tick playback has passed, once (a cut skips what it jumps over)
    const now = Math.floor(c.tick)
    const seg = p.plan.segments[c.segment]
    if (p.pushed < seg.from) p.pushed = seg.from
    const ear = { x: p.target.x, y: p.target.y, halfWidth: 1800, state: s1 }
    for (const b of p.events) {
      if (b.tick <= p.pushed || b.tick > now) continue
      p.source.pushEvents(b.tick, b.events)
      audio.playReplayEvents(b.events, ear)
    }
    if (p.pushed < p.decider.tick && now >= p.decider.tick) audio.finalBlowImpact()
    if (now > p.pushed) p.pushed = now
    audio.setReplay(true, c.speed > 0 && c.speed < 1)
    writeSubTick(p.source.buf, s0, s1, alpha, performance.now())
    this.world.setTimeScale(c.speed)
    // the camera
    const lerpP = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha })
    const pawnNow = (id: number | null) => {
      if (id === null) return null
      const a = s0.pawns.find((q) => q.id === id)
      const b = s1.pawns.find((q) => q.id === id)
      return a && b ? lerpP(a, b) : a ?? b ?? null
    }
    const d = p.decider
    const victim = pawnNow(d.camera.subject) ?? { x: d.camera.x, y: d.camera.y }
    const hitState = p.states.find((s) => s.tick >= d.tick) ?? s1
    const hitterPawn = d.camera.other === null ? undefined : hitState.pawns.find((q) => q.id === d.camera.other)
    const hitter = hitterPawn?.alive ? { x: hitterPawn.x, y: hitterPawn.y } : null
    const want = pushTarget(hitter, victim)
    const k = 1 - Math.exp(-dtReal * Math.max(c.speed, 0.05) * TARGET_RATE)
    p.target.x += (want.x - p.target.x) * k
    p.target.y += (want.y - p.target.y) * k
    const deathState = p.states.find((s) => s.tick >= d.end) ?? s1
    const deathPawn = deathState.pawns.find((q) => q.id === d.camera.subject)
    const slowSeg = p.plan.segments.find((s) => s.speed < 1)
    const slow = slowSeg ? Math.max(0, Math.min(1, (c.tick - slowSeg.from) / (slowSeg.to - slowSeg.from))) : 1
    this.world.setPose(finalBlowPose({
      shot: seg.shot, reduced: p.plan.reduced, kind: p.plan.kind, yaw: p.yaw, slow, target: p.target, hitter, victim,
      death: deathPawn ? { x: deathPawn.x, y: deathPawn.y } : victim,
      hit: hitter ? { x: (hitter.x + victim.x) / 2, y: (hitter.y + victim.y) / 2 } : victim,
    }))
  }

  private toLive(p: Playing): void {
    p.live = true
    this.world.setSource(globalSource, null)
    this.world.setTimeScale(1)
    this.world.setPose(null)
    this.world.returnToLive()
    audio.setReplay(false, false)
  }

  private end(skipped: boolean): void {
    const p = this.play
    this.pending = null
    if (!p) return
    this.play = null
    window.removeEventListener('keydown', this.onSkip, true)
    window.removeEventListener('pointerdown', this.onSkip, true)
    if (!p.live) this.toLive(p)
    useGame.setState({ finalBlow: null })
    resultsHold.release()
    trackEvent('final_blow', { kind: p.plan.kind, skipped, seconds: Math.round((performance.now() - p.startedAt) / 100) / 10 })
  }
}
