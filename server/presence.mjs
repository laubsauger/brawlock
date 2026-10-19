import { PRESENCE_REGIONS, PRESENCE_TTL_MS } from '../src/shared/presence.ts'

/** Ephemeral browser leases; never persisted or used for account authorization. */
export function createPresence({ now = Date.now, maxDevices = 5000, perIp = 32 } = {}) {
  const devices = new Map()
  let order = 0
  function sweep() {
    const cutoff = now() - PRESENCE_TTL_MS
    for (const [id, entry] of devices) if (entry.at <= cutoff) devices.delete(id)
  }
  function snapshot() {
    sweep()
    const people = new Map()
    for (const entry of devices.values()) {
      const existing = people.get(entry.person)
      if (!existing || existing.order < entry.order) people.set(entry.person, entry)
    }
    const regions = Object.fromEntries(PRESENCE_REGIONS.map((id) => [id, 0]))
    for (const entry of people.values()) regions[entry.region]++
    return { regions, total: people.size }
  }
  return {
    snapshot,
    beat(body, accountId, ip) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
        || typeof body.device !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.device) || !PRESENCE_REGIONS.includes(body.region)) return { status: 400, error: 'Invalid online presence.' }
      sweep()
      const current = devices.get(body.device)
      const peers = [...devices.entries()].filter(([id, entry]) => id !== body.device && entry.ip === ip).length
      if ((!current && devices.size >= maxDevices) || peers >= perIp) return { status: 429, error: 'Online presence capacity reached.' }
      devices.set(body.device, { person: accountId ? `a:${accountId}` : `g:${body.device}`, ip, region: body.region, at: now(), order: ++order })
      return { status: 200, body: snapshot() }
    },
  }
}
