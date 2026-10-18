// coturn REST credentials: timestamp:user and base64(HMAC-SHA1(shared secret, username)).
// https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf
import { createHmac, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { KeyedLimiter } from '../src/net/ratelimit.ts'

const MAX_TTL_SECONDS = 24 * 60 * 60
const ICE_URL = /^(stun|stuns|turn|turns):(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/

/** No public/library ICE provider is substituted when configuration is missing or invalid. */
export function turnCredentialIssuer({ secret, urls, ttlSeconds = MAX_TTL_SECONDS, now = Date.now, randomId = randomUUID }) {
  if (typeof secret !== 'string' || secret.trim().length < 32 || secret.length > 4096 || /[\r\n\0]/.test(secret.trim())) throw new Error('TURN shared secret must contain at least 32 characters on one line')
  const key = secret.trim()
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 12) throw new Error('TURN_URLS must be a nonempty JSON array with at most 12 ICE URLs')
  const parsed = urls.map((url) => {
    const m = typeof url === 'string' && url.length <= 256 ? ICE_URL.exec(url) : null
    if (!m || (m[3] && (Number(m[3]) < 1 || Number(m[3]) > 65535)) || ((m[1] === 'stun' || m[1] === 'stuns') && m[4]) || (m[1] === 'turns' && m[4] === 'udp')) throw new Error('TURN_URLS contains an invalid STUN/TURN URL')
    const hostValid = m[2].startsWith('[') ? isIP(m[2].slice(1, -1)) === 6
      : m[2].length <= 253 && m[2].split('.').every((part) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))
    if (!hostValid) throw new Error('TURN_URLS contains an invalid host')
    return { url, scheme: m[1], host: m[2], port: m[3] }
  })
  const relay = parsed.filter((v) => v.scheme === 'turn' || v.scheme === 'turns')
  if (relay.length === 0) throw new Error('TURN_URLS must include a TURN relay URL')
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_TTL_SECONDS) throw new Error('TURN_TTL_SECONDS must be between 60 and 86400')
  const stun = parsed.filter((v) => v.scheme === 'stun' || v.scheme === 'stuns').map((v) => v.url)
  // coturn's configured relay listener also serves STUN on the same host/port.
  if (stun.length === 0) stun.push(`${relay[0].scheme === 'turns' ? 'stuns' : 'stun'}:${relay[0].host}${relay[0].port ? `:${relay[0].port}` : ''}`)
  return () => {
    const expires = Math.floor(now() / 1000) + ttlSeconds
    const username = `${expires}:${randomId()}`
    const credential = createHmac('sha1', key).update(username).digest('base64')
    return { iceServers: [
      { urls: stun.length === 1 ? stun[0] : [...stun] },
      { urls: relay.map((v) => v.url), username, credential },
    ], expiresAt: expires * 1000 }
  }
}

/** Shared policy for the listener and pure origin/rate tests. No credentials enter logs. */
export function iceCredentialEndpoint({ issue, allowedOrigins, now = () => performance.now() }) {
  const limiter = new KeyedLimiter(12, 12 / 60)
  return {
    handle({ method, origin, ip }) {
      const permitted = origin === null || allowedOrigins === null || allowedOrigins.includes(origin)
      const headers = {
        'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Origin',
        'access-control-allow-origin': allowedOrigins === null ? '*' : permitted && origin ? origin : 'null',
        'access-control-allow-methods': 'GET, OPTIONS',
      }
      if (!permitted) return { status: 403, headers, body: { error: 'origin not allowed' } }
      if (method === 'OPTIONS') return { status: 204, headers, body: null }
      if (method !== 'GET') return { status: 405, headers, body: { error: 'method not allowed' } }
      if (!limiter.take(ip, now())) return { status: 429, headers: { ...headers, 'retry-after': '5' }, body: { error: 'Too many ICE requests. Try again shortly.' } }
      if (!issue) return { status: 503, headers, body: { error: 'TURN relay credentials are not configured on this server.' } }
      return { status: 200, headers, body: issue() }
    },
    sweep() { limiter.sweep(now()) },
  }
}
