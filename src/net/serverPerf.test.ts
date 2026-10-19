import { describe, expect, it } from 'vitest'
import { decodeServerPerf } from './serverPerf'

const sample = { sampleAt: 1, windowMs: 1000, processCpuPct: 125, eventLoopP95Ms: 20.5, eventLoopMaxMs: 37, simStepAvgMs: 0.4, simStepMaxMs: 2, simStepsPerSec: 120, rssMb: 80 }

describe('server performance snapshots', () => {
  it('preserves valid multi-core CPU measurements and zero activity', () => {
    expect(decodeServerPerf(sample)).toEqual(sample)
    expect(decodeServerPerf({ ...sample, processCpuPct: 0, simStepAvgMs: 0, simStepMaxMs: 0, simStepsPerSec: 0 })).toMatchObject({ processCpuPct: 0, simStepsPerSec: 0 })
  })
  it('distinguishes an unsampled server from missing or invalid telemetry', () => {
    expect(decodeServerPerf(null)).toBeNull()
    for (const value of [undefined, {}, { ...sample, rssMb: NaN }, { ...sample, eventLoopMaxMs: -1 }, { ...sample, windowMs: 0 }]) expect(() => decodeServerPerf(value)).toThrow()
  })
})
