import { describe, expect, it } from 'vitest'
import { GRADE_LIMITS } from '../../net/netstats'
import { pickRegion, pingGrade, regionProblem, type RegionStatus } from './servers'

const r = (id: string, state: RegionStatus['state'], rttMs: number | null): RegionStatus => ({ id, label: id.toUpperCase(), url: `wss://${id}`, state, rttMs, samples: [], healthy: null, versionOk: null, players: null, rooms: null, at: 0 })

describe('game-server region choice', () => {
  it('Auto picks the lowest ping among the regions that are up', () => {
    const s = [r('us-west', 'up', 168), r('eu', 'up', 34), r('asia', 'down', null)]
    expect(pickRegion(s, 'auto')?.id).toBe('eu')
  })

  it('never auto-picks a region that is down or on another version, even if its last ping was low', () => {
    const s = [r('us-west', 'up', 168), r('eu', 'mismatch', 20)]
    expect(pickRegion(s, 'auto')?.id).toBe('us-west')
  })

  it('keeps an explicit choice, so its problem can be shown instead of silently switching', () => {
    const s = [r('us-west', 'down', null), r('eu', 'up', 34)]
    expect(pickRegion(s, 'us-west')?.id).toBe('us-west')
    expect(regionProblem(pickRegion(s, 'us-west'))).toMatch(/not reachable/)
  })

  it('says why a server cannot host: down, another version, still checking', () => {
    expect(regionProblem(r('us-west', 'down', null))).toMatch(/not reachable/)
    expect(regionProblem(r('us-west', 'mismatch', 50))).toMatch(/different game version/)
    expect(regionProblem(r('us-west', 'checking', null))).toMatch(/Checking/)
    expect(regionProblem(r('us-west', 'up', 50))).toBeNull()
  })

  it('colours the ping with the netcode thresholds, so menu and in-match readouts agree', () => {
    const [good, ok, bad] = GRADE_LIMITS.ping
    expect(pingGrade(good - 1)).toBe('good')
    expect(pingGrade(ok - 1)).toBe('ok')
    expect(pingGrade(bad - 1)).toBe('bad')
    expect(pingGrade(bad + 1)).toBe('critical')
    expect(pingGrade(null)).toBeNull()
  })
})
