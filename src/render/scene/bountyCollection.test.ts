import { describe, expect, it, vi } from 'vitest'
import { MatchWorld } from './MatchWorld'

const victim = { owner: 1, x: -200, y: 50, h: 20, floorH: 20 }
const collector = { owner: 0, x: 300, y: -100, h: 20, floorH: 20 }

function world(fx = 1, reducedMotion = false) {
  return {
    views: new Map([[1, victim], [2, collector]]),
    overlay: { callout: vi.fn() },
    particles: { budget: vi.fn((n: number) => n), spawn: vi.fn() },
    ground: { spawn: vi.fn() },
    opts: { fx }, reducedMotion: { matches: reducedMotion },
  }
}

function collect(w: ReturnType<typeof world>, amount: number) {
  const prototype = MatchWorld.prototype as unknown as {
    bountyCollection(this: ReturnType<typeof world>, victim: typeof collector, killer: number, amount: number, now: number): void
  }
  prototype.bountyCollection.call(w, victim, collector.owner, amount, 5)
}

describe('bounty collection presentation', () => {
  it('sends a fixed gold handful from victim to collector and labels the exact authoritative payout', () => {
    const w = world()
    collect(w, 3)
    expect(w.overlay.callout).toHaveBeenCalledWith('+3 bounty', collector.x, collector.y, collector.h + 125, 5)
    expect(w.particles.spawn).toHaveBeenCalledTimes(10)
    expect(w.ground.spawn).toHaveBeenCalledTimes(1)
    for (const args of w.particles.spawn.mock.calls as number[][]) {
      const [x, y, h, vx, vy, vh, life, , , , , , gravity] = args
      // Existing GPU particle integration lands every facet at the collector.
      expect(x + vx * life).toBeCloseTo(collector.x, 6)
      expect(y + vy * life).toBeCloseTo(collector.y, 6)
      expect(h + vh * life + gravity * life * life * 0.5).toBeCloseTo(collector.h + 85, 6)
      expect(args.every(Number.isFinite)).toBe(true)
    }
    const large = world()
    collect(large, 1000)
    expect(large.particles.spawn.mock.calls).toEqual(w.particles.spawn.mock.calls)
    expect(large.overlay.callout.mock.calls[0][0]).toBe('+1000 bounty')
  })

  it('keeps the payout readable with motion/FX disabled without emitting animated extras', () => {
    for (const w of [world(0), world(1, true)]) {
      collect(w, 2)
      expect(w.overlay.callout).toHaveBeenCalledOnce()
      expect(w.particles.spawn).not.toHaveBeenCalled()
      expect(w.ground.spawn).not.toHaveBeenCalled()
    }
  })
})
