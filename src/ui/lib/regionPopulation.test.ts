import { describe, expect, it } from 'vitest'
import { regionPlayerLabel, regionPopulation, type RegionStatus } from './servers'

const region = (id: string, players: number | null, state: RegionStatus['state'] = 'up'): RegionStatus => ({ id, label: id, url: `wss://${id}.test`, state, rttMs: 20, samples: [], healthy: state === 'up', versionOk: true, players, rooms: 1, at: 0 })

describe('regional human population', () => {
  it('shows exact totals only when every region has a known count', () => {
    expect(regionPopulation([region('eu', 3), region('us', 2)])).toEqual({ total: 5, partial: false, label: '5 online' })
    expect(regionPlayerLabel(region('eu', 1))).toBe('1 player')
    expect(regionPlayerLabel(region('eu', 0))).toBe('0 players')
  })
  it('marks partial counts and never turns unknown/offline regions into zero', () => {
    expect(regionPopulation([region('eu', 3), region('us', null, 'checking')])).toEqual({ total: 3, partial: true, label: '3+ online' })
    expect(regionPopulation([region('eu', 3), region('us', 9, 'down')])).toEqual({ total: 3, partial: true, label: '3+ online' })
    expect(regionPopulation([region('eu', null, 'down')])).toEqual({ total: null, partial: true, label: '— online' })
    expect(regionPopulation([])).toEqual({ total: null, partial: false, label: '— online' })
    expect(regionPlayerLabel(region('eu', 8, 'down'))).toBe('— players')
  })
  it('includes connected humans finishing games in a draining region', () => {
    expect(regionPopulation([{ ...region('eu', 4), maintenance: { draining: true, message: null } }, region('us', 0)]).label).toBe('4 online')
  })
})
