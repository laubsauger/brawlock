import { describe, expect, it, vi } from 'vitest'
import { Online, hybridNet } from './online'
import { PROTOCOL_VERSION } from './protocol'
import type { NetFactory } from './transport'

const regions = [{ id: 'us-west', label: 'US West', url: 'wss://west.test' }, { id: 'eu', label: 'Europe', url: 'wss://eu.test' }]
const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('authoritative match history requests', () => {
  it('reads the global feed through one region and rejects leaked identities or personal outcomes', async () => {
    const entry = { id: crypto.randomUUID(), at: 1000, queue: 'casual', region: 'us', ticks: 3600, rounds: 1, teamMode: 'ffa', gameMode: 'rounds',
      players: [{ player: 0, name: 'Ash', kills: 1, deaths: 0, won: true }] }
    let body: unknown = { matches: [entry] }
    const fetch = vi.fn(async (url: string) => response(200, url.endsWith('/health') ? { ok: true, protocol: PROTOCOL_VERSION, build: 'dev-history' } : body))
    const online = new Online({ regions, build: 'dev-history', fetch })
    expect(await online.recentMatches('eu', 'casual')).toEqual([entry])
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('https://eu.test/matches?limit=10&queue=casual')
    for (const bad of [{ ...entry, room: 'ABCDE' }, { ...entry, self: 0 }, { ...entry, players: [{ ...entry.players[0], device: 'private-device' }] }]) {
      body = { matches: [bad] }
      await expect(online.recentMatches('eu')).rejects.toThrow(/invalid global match data/)
    }
    body = { matches: [] }
    expect(await online.recentMatches('eu')).toEqual([])
  })

  it('routes casual and ranked history to the selected identity and rejects corrupt public records', async () => {
    const id = crypto.randomUUID()
    const entry = { id, at: 1000, queue: 'casual', region: 'eu', ticks: 3600, rounds: 1, teamMode: 'ffa', gameMode: 'rounds',
      self: 0, outcome: 'forfeit', delta: null, rating: null,
      players: [{ player: 0, name: 'Ash', kills: 0, deaths: 1, won: false, forfeited: true }] }
    let body: unknown = { matches: [entry] }
    const fetch = vi.fn(async (url: string) => response(200, url.endsWith('/health')
      ? { ok: true, protocol: PROTOCOL_VERSION, build: 'dev-history' } : body))
    const online = new Online({ regions, build: 'dev-history', fetch })
    expect(await online.matchHistory('eu', 'private-player-000', 'casual')).toEqual([entry])
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('https://eu.test/players/private-player-000/history?limit=10&queue=casual')
    expect(await online.matchHistory('eu', id, 'ranked', true)).toEqual([entry])
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(`https://eu.test/profiles/${id}/history?limit=10&queue=ranked`)
    body = { matches: [{ ...entry, players: [{ ...entry.players[0], device: 'private-player-000' }] }] }
    await expect(online.matchHistory('eu', id, undefined, true)).rejects.toThrow('invalid match history data')
    body = { matches: [] }
    expect(await online.matchHistory('eu', id, undefined, true)).toEqual([])
    const calls = fetch.mock.calls.length
    await expect(online.matchHistory('eu', 'private-player-000', undefined, true)).rejects.toThrow('public player ID is invalid')
    expect(fetch).toHaveBeenCalledTimes(calls)
  })
})

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

describe('opaque public profile lookup', () => {
  const publicId = '12345678-1234-4123-8123-123456789abc'
  const profile = { found: true, publicId, matches: 4, detail: null,
    coverage: { detailedMatches: 0, totalMatches: 4, firstDetailedAt: null, lastDetailedAt: null } }
  it('uses only the requested public ID and distinguishes an unknown player from a bad response', async () => {
    let body: unknown = profile
    const fetch = vi.fn(async (url: string) => response(200, url.endsWith('/health')
      ? { ok: true, protocol: PROTOCOL_VERSION, build: 'dev-profile' } : body))
    const online = new Online({ regions, build: 'dev-profile', fetch })
    expect(await online.publicProfile('eu', publicId)).toMatchObject({ publicId, coverage: profile.coverage, detail: null, region: { id: 'eu' } })
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(`https://eu.test/profiles/${publicId}`)
    body = { found: false }
    expect(await online.publicProfile('eu', publicId)).toBeNull()
    body = { ...profile, publicId: '23456789-1234-4123-8123-123456789abc' }
    await expect(online.publicProfile('eu', publicId)).rejects.toThrow('different player profile')
    body = { ...profile, publicId: undefined }
    await expect(online.publicProfile('eu', publicId)).rejects.toThrow('invalid player profile data')
    body = { ...profile, coverage: undefined }
    await expect(online.publicProfile('eu', publicId)).rejects.toThrow('invalid player profile data')
  })

  it('refuses raw private IDs and short tags before making any request', async () => {
    const fetch = vi.fn(async () => response(200, {}))
    const online = new Online({ regions, build: 'dev-profile', fetch })
    for (const id of ['device-private-000', 'abcde', '../players/device-private-000']) {
      await expect(online.publicProfile('eu', id)).rejects.toThrow('public player ID is invalid')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports missing public IDs as a board data error instead of silently disabling inspection', async () => {
    let entries: unknown[] = [{ name: 'Old row without identity' }]
    const fetch = vi.fn(async (url: string) => response(200, url.endsWith('/health')
      ? { ok: true, protocol: PROTOCOL_VERSION, build: 'dev-profile' } : { entries, you: null }))
    const online = new Online({ regions, build: 'dev-profile', fetch })
    await expect(online.leaderboard('eu', 'all')).rejects.toThrow('invalid leaderboard player data')
    entries = [{ publicId }]
    expect((await online.leaderboard('eu', 'all')).entries).toEqual(entries)
  })
})


describe('authenticated relay configuration', () => {
  const credentials = () => ({ iceServers: [{ urls: 'stun:eu.test:3478' }, { urls: ['turn:eu.test:3478?transport=udp', 'turns:eu.test:5349?transport=tcp'], username: 'expires:user', credential: 'temporary-password' }], expiresAt: Date.now() + 3600_000 })
  it('shares concurrent loads, accepts a healthy regional provider and caches expiring credentials', async () => {
    const fetch = vi.fn(async (url: string) => url.includes('west') ? response(503, {}) : response(200, credentials()))
    const online = new Online({ regions, build: 'different-game-version', fetch })
    const [a, b] = await Promise.all([online.iceConfiguration(), online.iceConfiguration()])
    expect(a).toEqual(b)
    expect(fetch).toHaveBeenCalledTimes(2)
    a.iceServers!.length = 0
    expect((await online.iceConfiguration()).iceServers).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([url]) => url.endsWith('/ice'))).toBe(true)
  })
  it('rejects malformed, expired and STUN-only responses without registering peers, then permits a fresh attempt', async () => {
    for (const bad of [{ ...credentials(), expiresAt: 1 }, { ...credentials(), iceServers: [{ urls: 'stun:eu.test:3478' }] }, { ...credentials(), iceServers: [{ urls: 'https://invalid.test' }] }, null]) {
      const fetch = vi.fn().mockResolvedValueOnce(response(200, bad)).mockResolvedValueOnce(response(200, credentials()))
      const online = new Online({ regions: [regions[0]], build: 'dev', fetch })
      await expect(online.iceConfiguration()).rejects.toThrow('connection relay')
      expect((await online.iceConfiguration()).iceServers).toHaveLength(2)
    }
  })
  it('refreshes credentials before expiry', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const fetch = vi.fn(async () => response(200, credentials()))
      const online = new Online({ regions: [regions[0]], build: 'dev', fetch })
      await online.iceConfiguration()
      clock.mockReturnValue(1_000_000 + 3600_000 - 30_000)
      await online.iceConfiguration()
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { clock.mockRestore() }
  })
  it('accepts the server’s minimum 60-second TTL while renewing it before reuse', async () => {
    const fetch = vi.fn(async () => response(200, { ...credentials(), expiresAt: Date.now() + 59_000 }))
    const online = new Online({ regions: [regions[0]], build: 'dev', fetch })
    expect((await online.iceConfiguration()).iceServers).toHaveLength(2)
    await online.iceConfiguration()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
