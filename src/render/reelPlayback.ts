/**
 * Plays the results reel (docs/moonshot/specs/results-reel.md) in the match world: for each
 * chosen moment the letterbox closes, a private replay player re-simulates to the moment's first
 * tick in budgeted slices, then the moment plays on the Final Blow's camera and clock from a
 * private source; after the last one (or a skip, or a desync) the world returns to the live
 * source. Any key or click skips the rest.
 */
import { audio } from '../audio'
import { planClock } from '../game/finalBlow'
import { PREPARE_BUDGET_MS, REEL_GAP, reelSession, type ReelRequest, type ReelShot } from '../game/replay/reel'
import { ShotFramer } from './finalBlowCamera'
import type { FinalBlowWorld } from './finalBlowPlayer'
import { createPrivateSource, globalSource, writeSubTick } from './source'

interface Running {
  req: ReelRequest
  index: number
  /** 'gap': bars closed, preparing; 'play': the moment runs */
  phase: 'gap' | 'play'
  gapLeft: number
  elapsed: number
  source: ReturnType<typeof createPrivateSource> | null
  framer: ShotFramer | null
}

export class ReelPlayback {
  private run: Running | null = null
  private readonly onSkip = (e: Event) => {
    if (e instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    this.stop()
  }

  constructor(private readonly world: FinalBlowWorld) {}

  get active(): boolean {
    return this.run !== null
  }

  /** Once per rendered frame, before the world reads its source. */
  frame(dtReal: number): void {
    if (reelSession.takeStop() && this.run) return this.stop()
    const req = reelSession.takeRequest()
    if (req) this.start(req)
    const r = this.run
    if (!r) return
    if (!r.req.player.ok) return this.stop()
    const shot = r.req.shots[r.index]
    if (r.phase === 'gap') {
      r.gapLeft -= dtReal
      const ready = r.req.player.prepare(shot.plan.segments[0].from, PREPARE_BUDGET_MS)
      if (!ready || r.gapLeft > 0) return
      this.begin(r, shot)
    }
    r.elapsed += dtReal
    const c = planClock(shot.plan, r.elapsed)
    if (!c) return this.next(r)
    const player = r.req.player
    for (const b of player.advance(Math.ceil(c.tick))) {
      r.source!.pushEvents(b.tick, b.events)
      audio.playReplayEvents(b.events, { x: shot.camera.x, y: shot.camera.y, halfWidth: 1800, state: player.curr! })
    }
    const s0 = player.prev!
    const s1 = player.curr!
    const alpha = s1.tick > s0.tick ? Math.max(0, Math.min(1, (c.tick - s0.tick) / (s1.tick - s0.tick))) : 1
    writeSubTick(r.source!.buf, s0, s1, alpha, performance.now())
    this.world.setTimeScale(c.speed)
    audio.setReplay(true, c.speed > 0 && c.speed < 1)
    this.world.setPose(r.framer!.pose(c, s0, s1, alpha, dtReal))
  }

  stop(): void {
    const r = this.run
    this.run = null
    window.removeEventListener('keydown', this.onSkip, true)
    window.removeEventListener('pointerdown', this.onSkip, true)
    if (r?.source) {
      this.world.setSource(globalSource, null)
      this.world.setTimeScale(1)
      this.world.setPose(null)
      this.world.returnToLive()
      audio.setReplay(false, false)
    }
    reelSession.finish()
  }

  private start(req: ReelRequest): void {
    if (this.run) this.stop()
    this.run = { req, index: 0, phase: 'gap', gapLeft: REEL_GAP, elapsed: 0, source: null, framer: null }
    window.addEventListener('keydown', this.onSkip, true)
    window.addEventListener('pointerdown', this.onSkip, true)
  }

  /** the moment's first state is ready: a fresh source, pawns rewound to it */
  private begin(r: Running, shot: ReelShot): void {
    r.phase = 'play'
    r.elapsed = 0
    r.source = createPrivateSource(400)
    r.source.buf.localPlayer = -1
    r.framer = new ShotFramer(shot.camera, shot.plan)
    const first = r.req.player.curr!
    writeSubTick(r.source.buf, first, first, 1, performance.now())
    this.world.setSource(r.source, first)
    reelSession.showing(r.index, false)
  }

  private next(r: Running): void {
    if (r.index + 1 >= r.req.shots.length) return this.stop()
    r.index++
    r.phase = 'gap'
    r.gapLeft = REEL_GAP
    reelSession.showing(r.index, true)
  }
}
