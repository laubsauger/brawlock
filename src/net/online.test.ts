import { describe, expect, it, vi } from 'vitest'
import { Online, hybridNet } from './online'
import { PROTOCOL_VERSION } from './protocol'
import type { NetFactory } from './transport'

const regions = [{ id: 'us-west', label: 'US West', url: 'wss://west.test' }, { id: 'eu', label: 'Europe', url: 'wss://eu.test' }]
const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('known room rediscovery and routing', () => {
  it('reads availability only in the selected region and exposes failures rather than an empty count', async () => {
    let status = 200
    const fetch = vi.fn(async (url: string) => url.endsWith('/health')
      ? response(200, { ok: true, protocol: PROTOCOL_VERSION, build: 'dev-test' })
      : response(status, { rooms: [{ code: 'ABCDE', joinable: 9, quick: true, phase: 'lobby' }], listings: [] }))
    const online = new Online({ regions, build: 'dev-test', fetch })
    expect(await online.browseRegion('eu')).toMatchObject([{ code: 'ABCDE', kind: 'server', region: { id: 'eu' } }])
    expect(fetch.mock.calls.every(([url]) => url.startsWith('https://eu.test/'))).toBe(true)
    status = 503
    await expect(online.browseRegion('eu')).rejects.toMatchObject({ reason: 'full' })
    await expect(online.browseRegion('missing')).rejects.toMatchObject({ reason: 'unavailable' })
  })
  it('looks up only the original server and cannot mistake a same-code room elsewhere for it', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/health')
      ? response(200, { ok: true, protocol: PROTOCOL_VERSION, build: 'dev-test' })
      : url.startsWith('https://west.test/') ? response(404, { exists: false }) : response(200, { exists: true }))
    const online = new Online({ regions, build: 'dev-test', fetch })
    expect(await online.roomExists('us-west', 'ABCDE')).toBe(false)
    expect(fetch.mock.calls.every(([url]) => url.startsWith('https://west.test/'))).toBe(true)
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/rooms/ABCDE'))).toBe(true)
    await expect(online.roomExists('missing', 'ABCDE')).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('preserves listed P2P routing and refuses to fall back when an exact server dial fails', async () => {
    const fetch = vi.fn(async () => response(200, { exists: true }))
    const online = new Online({ regions, build: 'dev-test', fetch })
    const peerJoin = vi.fn(async () => ({} as never))
    const serverJoin = vi.fn(async () => { throw new Error('Original server disconnected') })
    const p2p: NetFactory = { host: async () => ({} as never), join: peerJoin }
    const onRoute = vi.fn()
    const server = vi.fn((): NetFactory => ({ host: async () => ({} as never), join: serverJoin }))
    const net = hybridNet(p2p, online, server, onRoute)
    await net.joinAt('ABCDE', { kind: 'p2p' })
    expect(peerJoin).toHaveBeenCalledWith('ABCDE', undefined)
    expect(server).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await expect(net.joinAt('ABCDE', { kind: 'server', region: 'us-west' })).rejects.toThrow('Original server disconnected')
    expect(server).toHaveBeenCalledExactlyOnceWith('wss://west.test')
    expect(peerJoin).toHaveBeenCalledOnce()
    expect(onRoute.mock.calls).toEqual([[null], [regions[0]]])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rediscovers P2P listings independently of room fullness and keeps their kind and joinable count', async () => {
    const fetch = vi.fn(async (url: string) => response(200, url.endsWith('/health')
      ? { ok: true, protocol: PROTOCOL_VERSION, build: 'dev-test' }
      : { rooms: [], listings: [{ code: 'ABCDE', kind: 'p2p', humans: 1, bots: 9, max: 10, joinable: 9, phase: 'match' }, { code: 'FULLY', kind: 'p2p', humans: 10, bots: 0, max: 10, joinable: 0, phase: 'match' }] }))
    const online = new Online({ regions: [regions[0]], build: 'dev-test', fetch })
    expect(await online.browse()).toMatchObject([
      { code: 'FULLY', kind: 'p2p', humans: 10, joinable: 0 },
      { code: 'ABCDE', kind: 'p2p', humans: 1, bots: 9, joinable: 9 },
    ])
  })
})
