import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FleetSample, FleetView } from '../shared/monitoring'
import { FleetCard, MetricBar } from './FleetCard'

const bar = (value: number | null, fresh = true) => renderToStaticMarkup(createElement(MetricBar, {
  label: 'CPU', value, unit: '%', warning: 70, critical: 90, ceiling: 100, fresh,
}))
describe('compact fleet health indicators', () => {
  it('uses distinct normal, warning and critical bands with bounded bars and visible status text', () => {
    expect(bar(69)).toContain('metric-bar normal')
    expect(bar(70)).toContain('metric-bar elevated')
    expect(bar(90)).toContain('metric-bar critical')
    const saturated = bar(150)
    expect(saturated).toContain('width:100%')
    expect(saturated).toContain('150%')
    expect(saturated).toContain('<small>High</small>')
  })
  it('never presents missing or stale values as healthy', () => {
    for (const html of [bar(null), bar(10, false)]) {
      expect(html).toContain('metric-bar unknown')
      expect(html).not.toContain('metric-bar normal')
    }
    expect(bar(null)).toContain('width:0%')
  })
  it('leaves details closed by default and distinguishes high player latency from service availability', () => {
    const sample: FleetSample = { version: 1, uptimeSec: 300,
      release: { version: 'test', releaseDate: '2026-10-24', commit: 'abcdef' },
      host: { cpus: 2, totalMb: 2000, availableMb: 1000, cpuPct: 10, stealPct: 0, load1: .1 },
      hostCpuPeakPct: 20, processCpuPeakPct: 30, loopPeakMs: 21, stepPeakMs: .1, perf: null,
      players: 2, connections: 2, rooms: [{ mode: 'casual', phase: 'match', round: 1, humans: 2, bots: 8 }],
      links: { measured: 2, rttP95Ms: 300, rttMaxMs: 300, jitterMaxMs: 0, lossMaxPct: 0, correctionMaxPx: 0, snapshotAgeMaxMs: 0, critical: 0 },
    }
    const view: FleetView = { at: Date.now(), from: 0, through: Date.now(), grain: 10000, intervalMs: 10000, retentionDays: 30, regions: [], history: [], website: null,
      latest: { eu: { at: Date.now(), ok: true, sample } } }
    const html = renderToStaticMarkup(createElement(FleetCard, { id: 'eu', label: 'Europe', view }))
    expect(html).toContain('<details class="instance-details">')
    expect(html).not.toContain('<details open')
    expect(html).toContain('metric-bar critical')
    expect(html).not.toContain('Unavailable</span>')
    expect(html).toContain('50%')
    expect(html).toContain('8</b> bots')
  })
})
