import { describe, expect, it } from 'vitest'
import { GRADE_LIMITS } from '../../net/netstats'
import { pickRegion, pingGrade, queueRegion, regionProblem, type RegionStatus } from './servers'

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

  it('skips maintenance for Auto but preserves an explicit choice with its explanation', () => {
    const draining = { ...r('eu', 'up', 20), maintenance: { draining: true, message: 'New games are paused for maintenance.' } }
    const s = [draining, r('us-west', 'up', 168)]
    expect(pickRegion(s, 'auto')?.id).toBe('us-west')
    expect(regionProblem(pickRegion(s, 'eu'))).toBe(draining.maintenance.message)
    expect(regionProblem(pickRegion([draining], 'auto'))).toBe(draining.maintenance.message)
  })

  it('never moves a player off their region for maintenance until they accept the other one', () => {
    const eu = { ...r('eu', 'up', 30), maintenance: { draining: true, message: null } }
    const s = [eu, r('us-west', 'up', 170)]
    // Auto alone would pick US West; the menu holds Europe (shown as paused) and offers US West
    expect(pickRegion(s, 'auto')?.id).toBe('us-west')
    expect(queueRegion(s, 'auto', '', [])).toMatchObject({ region: { id: 'eu' }, home: { id: 'eu' }, detour: { id: 'us-west' }, held: true })
    expect(queueRegion(s, 'auto', '', ['eu'])).toMatchObject({ region: { id: 'us-west' }, held: false })
    // the region you last played in counts as home even when another one pings lower
    const us = { ...r('us-west', 'up', 170), maintenance: { draining: true, message: null } }
    expect(queueRegion([r('eu', 'up', 30), us], 'auto', 'us-west', [])).toMatchObject({ region: { id: 'us-west' }, detour: { id: 'eu' }, held: true })
    // no detour to offer: an open home, an explicit choice, or every region paused
    expect(queueRegion([r('eu', 'up', 30), us], 'auto', '', [])).toMatchObject({ region: { id: 'eu' }, detour: null, held: false })
    expect(queueRegion(s, 'eu', '', [])).toMatchObject({ region: { id: 'eu' }, detour: null, held: false })
    expect(queueRegion([eu], 'auto', '', [])).toMatchObject({ detour: null, held: false })
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
