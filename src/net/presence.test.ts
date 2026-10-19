import { describe, expect, it } from 'vitest'
import { createPresence } from '../../server/presence.mjs'
import { parsePresence, PRESENCE_TTL_MS } from '../shared/presence'

describe('online visitor leases', () => {
  it('rejects malformed public counts instead of substituting game connections', () => {
    expect(parsePresence({ regions: { eu: 1, 'us-west': 2 }, total: 3 }).total).toBe(3)
    for (const value of [null, { regions: {}, total: 0 }, { regions: { eu: 1, 'us-west': 0 }, total: 0 }, { regions: { eu: -1, 'us-west': 2 }, total: 1 }]) {
      expect(() => parsePresence(value)).toThrow('Invalid online population')
    }
  })
  it('counts menu visitors, deduplicates tabs/accounts, and moves regions without double counting', () => {
    const presence = createPresence()
    const beat = (device: string, account: string | null, region = 'eu') => presence.beat({ device, region }, account, 'address')
    expect(beat('browser_1', null).body).toEqual({ regions: { eu: 1, 'us-west': 0 }, total: 1 })
    expect(beat('browser_1', null).body!.total).toBe(1)
    expect(beat('browser_1', 'verified_account').body!.total).toBe(1)
    expect(beat('browser_2', 'verified_account', 'us-west').body).toEqual({ regions: { eu: 0, 'us-west': 1 }, total: 1 })
    expect(beat('browser_3', null).body!.total).toBe(2)
    // Logout leaves another signed-in device counted independently.
    expect(beat('browser_1', null).body!.total).toBe(3)
  })
  it('expires abandoned tabs without persistent writes or a reliable unload request', () => {
    let now = 0
    const presence = createPresence({ now: () => now })
    presence.beat({ device: 'browser_1', region: 'eu' }, null, 'address')
    now = PRESENCE_TTL_MS - 1
    expect(presence.snapshot().total).toBe(1)
    now++
    expect(presence.snapshot()).toEqual({ regions: { eu: 0, 'us-west': 0 }, total: 0 })
  })
  it('bounds anonymous populations and refuses identity/region spoof fields', () => {
    const presence = createPresence({ maxDevices: 2, perIp: 1 })
    expect(presence.beat({ device: 'browser_1', region: 'eu', accountId: 'forged' }, null, 'address').status).toBe(400)
    expect(presence.beat({ device: 12345678, region: 'eu' }, null, 'address').status).toBe(400)
    expect(presence.beat({ device: 'browser_1', region: 'moon' }, null, 'address').status).toBe(400)
    expect(presence.beat({ device: 'browser_1', region: 'eu' }, null, 'address').status).toBe(200)
    expect(presence.beat({ device: 'browser_2', region: 'eu' }, null, 'address').status).toBe(429)
    expect(presence.beat({ device: 'browser_2', region: 'eu' }, null, 'other').status).toBe(200)
    expect(presence.beat({ device: 'browser_3', region: 'eu' }, null, 'third').status).toBe(429)
  })
})
