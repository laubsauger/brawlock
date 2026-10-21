import { describe, expect, it } from 'vitest'
import { startServer } from '../../server/listen.mjs'
import { removeDir, tempDir } from '../../server/test-dir.mjs'
import { summarizeLinks } from './monitoring'
import type { PeerNetStats } from './netstats'

const token = 'test-monitoring-token-0123456789abcdef'
describe('private regional monitoring', () => {
  it('rejects unauthenticated and browser calls while returning bounded anonymous fleet metrics to the authority', async () => {
    const dir = tempDir('brawlock-monitoring-tcp-')
    const server = await startServer({ port: 0, dataDir: dir, ratingAuthorityToken: token, config: { region: 'eu' }, log: () => {} })
    const url = `http://127.0.0.1:${server.port}/internal/monitoring`, headers = { authorization: `Bearer ${token}` }
    try {
      expect((await fetch(url)).status).toBe(403)
      expect((await fetch(url, { headers: { ...headers, origin: 'https://game.test' } })).status).toBe(403)
      expect((await fetch(url, { headers, method: 'POST' })).status).toBe(405)
      await server.createRoom({ code: 'ABCDE' })
      const response = await fetch(url, { headers }), value = await response.json()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(value).toMatchObject({ version: 1, region: 'eu', players: 0, connections: 0, rooms: [{ humans: 0, bots: 0, phase: 'lobby' }], links: { measured: 0, rttP95Ms: null } })
      expect(value.release.version).toMatch(/^0\./)
      expect(JSON.stringify(value)).not.toMatch(/Private operator name|ABCDE|playerId|accountId|Bearer/)
      expect((await fetch(url + '?reportDays=999', { headers })).status).toBe(400)
      const activity = await (await fetch(url + '?reportDays=30', { headers })).json()
      expect(activity).toMatchObject({ source: 'eu', version: 3, days: 30 })
    } finally { await server.close(); removeDir(dir) }
  })
  it('retains missing RTT as null and excludes identities from player-link aggregates', () => {
    const row: PeerNetStats = { playerId: 7, rttMs: null, jitterMs: null, lossPct: null, snapshotAgeMs: null, channel: null, inputAckLagMs: null, correctionPx: null, desyncs: null, grade: 'good' }
    expect(summarizeLinks([{ role: 'host', peers: [row] }])).toMatchObject({ measured: 0, rttP95Ms: null })
    const aggregate = summarizeLinks([{ role: 'host', peers: [{ ...row, rttMs: 160, lossPct: 2 }, { ...row, playerId: 8, rttMs: 300, jitterMs: 40, grade: 'critical' }] }])
    expect(aggregate).toMatchObject({ measured: 2, rttP95Ms: 300, jitterMaxMs: 40, lossMaxPct: 2, critical: 1 })
    expect(aggregate).not.toHaveProperty('playerId')
  })
})
