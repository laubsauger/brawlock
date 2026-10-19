/** Protected regional operator endpoint over real loopback HTTP. No rendering. */
import { describe, expect, it } from 'vitest'
import { startServer } from '../../server/listen.mjs'
import { removeDir, tempDir } from '../../server/test-dir.mjs'

const secret = 'public-test-maintenance-secret-0123456789abcdef'

describe('regional maintenance operator boundary', () => {
  it('authenticates and bounds writes, advertises drain publicly, and preserves mode over restart', async () => {
    const dir = tempDir('brawlock-maintenance-tcp-')
    const options = { port: 0, build: 'dev-maintenance-http', dataDir: dir, maintenanceToken: secret,
      config: { region: 'eu', allowedOrigins: ['https://play.test'] }, log: () => {} }
    let server = await startServer(options)
    const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
    const call = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}${path}`, init)
    try {
      expect((await call('/internal/maintenance')).status).toBe(403)
      expect((await call('/internal/maintenance', { headers: { authorization: `Bearer ${'x'.repeat(secret.length)}` } })).status).toBe(403)
      expect((await call('/internal/maintenance', { headers: { ...headers, origin: 'https://play.test' } })).status).toBe(403)
      expect((await call('/internal/maintenance', { method: 'PUT', headers })).status).toBe(405)
      expect((await call('/internal/maintenance', { method: 'POST', headers: { authorization: headers.authorization, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415)
      expect((await call('/internal/maintenance', { method: 'POST', headers, body: JSON.stringify({ draining: true, message: 'x'.repeat(2500) }) })).status).toBe(413)
      expect((await call('/internal/maintenance', { method: 'POST', headers, body: JSON.stringify({ draining: true, message: null, room: 'ABCDE' }) })).status).toBe(400)
      const drain = await call('/internal/maintenance', { method: 'POST', headers, body: JSON.stringify({ draining: true, message: 'Europe is updating.' }) })
      expect(drain.status).toBe(200)
      expect(drain.headers.get('cache-control')).toBe('no-store')
      expect(drain.headers.get('access-control-allow-origin')).toBeNull()
      expect(await drain.json()).toMatchObject({ draining: true, ready: true, pendingResults: 0, pendingRatings: 0, pendingRewards: 0, pendingReleases: 0 })
      const health = await call('/health')
      expect(await health.json()).toMatchObject({ ok: true, maintenance: { draining: true, message: 'Europe is updating.' } })
      expect((await call('/quickplay', { method: 'POST', headers: { origin: 'https://play.test' } })).status).toBe(503)
      await server.close()
      server = await startServer(options)
      expect(await (await call('/internal/maintenance', { headers })).json()).toMatchObject({ draining: true, ready: true })
      expect((await call('/rooms', { method: 'POST', headers: { origin: 'https://play.test' } })).status).toBe(503)
      const reopen = await call('/internal/maintenance', { method: 'POST', headers, body: JSON.stringify({ draining: false, message: null }) })
      expect(await reopen.json()).toMatchObject({ draining: false, ready: false })
      expect((await call('/rooms', { method: 'POST', headers: { origin: 'https://play.test' } })).status).toBe(201)
    } finally { await server.close(); removeDir(dir) }
  })
})
