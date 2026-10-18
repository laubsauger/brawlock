import { describe, expect, it } from 'vitest'
import { iceCredentialEndpoint, turnCredentialIssuer } from '../../server/turn-credentials.mjs'

// Deliberately public fixture, independently computed with Python hmac/hashlib.
const secret = '0123456789abcdef0123456789abcdef'
const urls = ['turn:eu.brawlock.osc.link:3478?transport=udp', 'turn:eu.brawlock.osc.link:3478?transport=tcp', 'turns:eu.brawlock.osc.link:5349?transport=tcp']

describe('coturn REST credentials', () => {
  it('issues a 24-hour timestamp username and the exact coturn HMAC-SHA1 password', () => {
    const issue = turnCredentialIssuer({ secret, urls, now: () => 1_700_000_000_999, randomId: () => '00000000-0000-4000-8000-000000000001' })
    const credentials = issue()
    expect(credentials.expiresAt).toBe(1_700_086_400_000)
    expect(credentials.iceServers[0]).toEqual({ urls: 'stun:eu.brawlock.osc.link:3478' })
    expect(credentials.iceServers[1]).toMatchObject({ urls,
      username: '1700086400:00000000-0000-4000-8000-000000000001',
      credential: 'ciJsPYgY7+lkifAIUvg9XrtP/Us=',
    })
    expect(JSON.stringify(credentials)).not.toContain(secret)
  })

  it('uses fresh anonymous usernames and honors a shorter configured expiry', () => {
    const issue = turnCredentialIssuer({ secret, urls, ttlSeconds: 3600, now: () => 1_700_000_000_000 })
    const a = issue()
    const b = issue()
    expect(a.expiresAt).toBe(1_700_003_600_000)
    expect(a.iceServers[1].username).not.toBe(b.iceServers[1].username)
    expect(a.iceServers[1].credential).not.toBe(b.iceServers[1].credential)
  })

  it('rejects malformed or unbounded configuration instead of returning another provider', () => {
    expect(() => turnCredentialIssuer({ secret: '', urls })).toThrow(/secret/)
    expect(() => turnCredentialIssuer({ secret, urls: [] })).toThrow(/array/)
    for (const bad of ['https://relay.invalid', 'turn://relay.invalid', 'turn:user:password@relay.invalid', 'turn:bad..host', 'turn:[::::]', 'turn:relay.invalid:65536', 'turns:relay.invalid?transport=udp', 'turn:relay.invalid?transport=quic']) {
      expect(() => turnCredentialIssuer({ secret, urls: [bad] })).toThrow()
    }
    expect(() => turnCredentialIssuer({ secret, urls, ttlSeconds: 86401 })).toThrow(/TTL/)
    expect(() => turnCredentialIssuer({ secret, urls, ttlSeconds: NaN })).toThrow(/TTL/)
    expect(() => turnCredentialIssuer({ secret, urls: ['stun:relay.invalid:3478'] })).toThrow(/relay/)
  })
})

describe('ICE credential endpoint policy', () => {
  const request = { method: 'GET', origin: 'https://game.example', ip: 'client-ip' }
  const issue = turnCredentialIssuer({ secret, urls })

  it('allows configured and native origins, rejects other browsers and never caches credentials', () => {
    const endpoint = iceCredentialEndpoint({ issue, allowedOrigins: ['https://game.example'] })
    const accepted = endpoint.handle(request)
    expect(accepted.status).toBe(200)
    expect(accepted.headers).toMatchObject({ 'cache-control': 'no-store', vary: 'Origin', 'access-control-allow-origin': request.origin })
    expect(endpoint.handle({ ...request, origin: null }).status).toBe(200)
    const blocked = endpoint.handle({ ...request, origin: 'https://other.example' })
    expect(blocked.status).toBe(403)
    expect(JSON.stringify(blocked)).not.toContain('credential')
    expect(endpoint.handle({ ...request, method: 'OPTIONS' }).status).toBe(204)
    expect(endpoint.handle({ ...request, method: 'POST' }).status).toBe(405)
  })

  it('bounds requests per IP, refills at 12/minute and keeps independent clients available', () => {
    let now = 0
    const endpoint = iceCredentialEndpoint({ issue, allowedOrigins: null, now: () => now })
    for (let i = 0; i < 12; i++) expect(endpoint.handle(request).status).toBe(200)
    expect(endpoint.handle(request).status).toBe(429)
    expect(endpoint.handle({ ...request, ip: 'another-client' }).status).toBe(200)
    now = 5000
    expect(endpoint.handle(request).status).toBe(200)
    expect(endpoint.handle(request).status).toBe(429)
    now += 60_000
    endpoint.sweep()
    expect(endpoint.handle(request).status).toBe(200)
  })

  it('returns an explicit service error when TURN is unconfigured', () => {
    const endpoint = iceCredentialEndpoint({ allowedOrigins: null })
    const response = endpoint.handle(request)
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ error: expect.stringContaining('not configured') })
    expect(JSON.stringify(response.body)).not.toContain('iceServers')
  })
})
