import { OPERATOR_EMAIL } from './operator.mjs'
// Single account authority. Deliberately separate from regional games and legacy Elo.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { passkey } from '@better-auth/passkey'
import { oneTimeToken } from 'better-auth/plugins/one-time-token'
import { ACCOUNT_REGIONS_SCHEMA, ACCOUNT_CONTROL_SCHEMA, ACCOUNT_STARTED_SCHEMA, accountRegions } from './account-regions.mjs'
import { accountRatingKey } from '../src/net/accounts.ts'
import { PROGRESSION_SCHEMA, PROGRESSION_V7_MIGRATION, ProgressionError, createProgression } from './progression.mjs'
import { PLAYER_COLORS } from '../src/net/lobbyColors.ts'
import { KeyedLimiter } from '../src/net/ratelimit.ts'
import { createPresence } from './presence.mjs'
import { openAnalytics } from './analytics.mjs'
import { PLAY_SCHEMA, createPlayControl } from './play-control.mjs'

const RESERVED = new Set(['admin', 'administrator', 'brawlock', 'moderator', 'server', 'system', 'support'])
const PROVIDERS = ['google', 'discord', 'microsoft']
const PROFILE_SCHEMA = `
CREATE TABLE player_profile (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  color INTEGER,
  created_at INTEGER NOT NULL
);
PRAGMA user_version = 1;
`

/** Restrict confusables deliberately: ASCII names, after compatibility normalization. */
export function accountName(raw) {
  if (typeof raw !== 'string' || raw.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) return null
  const name = raw.normalize('NFKC').trim()
  if (!/^[A-Za-z][A-Za-z0-9_]{2,15}$/.test(name)) return null
  const key = name.toLowerCase()
  return RESERVED.has(key) ? null : { name, key }
}

export function accountOptions({ database, origin, secret, providers }) {
  const url = new URL(origin)
  if (url.origin !== origin || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
    throw new Error('Accounts require an exact HTTPS origin (HTTP localhost is allowed for development)')
  }
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Accounts require a secret of at least 32 characters')
  if (!providers || !Object.keys(providers).length || Object.keys(providers).some((id) => !PROVIDERS.includes(id))) {
    throw new Error('Configure at least one supported account provider')
  }
  for (const config of Object.values(providers)) {
    if (!config || typeof config.clientId !== 'string' || !config.clientId.trim() || typeof config.clientSecret !== 'string' || !config.clientSecret.trim()) {
      throw new Error('Each account provider requires a client ID and secret')
    }
  }
  return {
    appName: 'Brawlock', database, secret, baseURL: origin,
    logger: { level: 'warn', log: (level, message) => {
      // Provider errors can include personal data. Correlate without persisting it.
      const code = createHash('sha256').update(message).digest('hex').slice(0, 12)
      console.error(JSON.stringify({ level, event: 'accounts.library', code }))
    } },
    basePath: '/api/auth', trustedOrigins: [origin],
    socialProviders: providers,
    emailAndPassword: { enabled: false },
    account: { accountLinking: { enabled: true, disableImplicitLinking: true, allowUnlinkingAll: false } },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: {
      cookiePrefix: 'brawlock',
      useSecureCookies: url.protocol === 'https:',
      ipAddress: { ipAddressHeaders: ['x-brawlock-client-ip'] },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    plugins: [oneTimeToken({ storeToken: 'hashed', expiresIn: 1, disableClientRequest: true, disableSetSessionCookie: true }), passkey({ rpID: url.hostname, rpName: 'Brawlock', origin,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      // The plugin's cryptographic verifier accepts possession-only credentials;
      // enforce the PIN/biometric policy on the verified authenticator flags too.
      registration: { afterVerification: ({ verification }) => {
        if (!verification.registrationInfo?.userVerified) throw new APIError('UNAUTHORIZED', { message: 'Verify your identity with your passkey to continue.' })
      } },
      authentication: { afterVerification: ({ verification }) => {
        if (!verification.authenticationInfo.userVerified) throw new APIError('UNAUTHORIZED', { message: 'Verify your identity with your passkey to continue.' })
      } },
    })],
  }
}

/** Explicit additive migration; a normal startup refuses an incomplete schema. */
export async function openAccounts({ file, origin, secret, providers, regionsToken = '', migrate = false }) {
  if (regionsToken && regionsToken.length < 32) throw new Error('Account region token must contain at least 32 characters')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  let analytics
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const options = accountOptions({ database: db, origin, secret, providers })
    const plan = await getMigrations(options)
    if (plan.schemaProblems.length || plan.unsafeChanges.length) throw new Error('Account schema requires a reviewed migration')
    const version = Number(db.prepare('PRAGMA user_version').get().user_version)
    if (![0, 1, 2, 3, 4, 5, 6, 7].includes(version)) throw new Error('Unsupported account profile schema version')
    const pending = plan.toBeCreated.length || plan.toBeAdded.length || plan.toBeAddedIndexes.length || version !== 7
    if (pending && !migrate) throw new Error('Account schema is not ready; run accounts:migrate before starting')
    if (migrate) {
      await plan.runMigrations()
      if (version === 0) db.exec(`BEGIN IMMEDIATE; ${PROFILE_SCHEMA} COMMIT;`)
      if (version < 2) db.exec(`BEGIN IMMEDIATE; ${ACCOUNT_REGIONS_SCHEMA} PRAGMA user_version = 2; COMMIT;`)
      if (version < 3) db.exec(`BEGIN IMMEDIATE; ${PROGRESSION_SCHEMA} PRAGMA user_version = 3; COMMIT;`)
      if (version < 4) db.exec(`BEGIN IMMEDIATE; ${ACCOUNT_CONTROL_SCHEMA} PRAGMA user_version = 4; COMMIT;`)
      if (version < 5) db.exec(`BEGIN IMMEDIATE; ${PLAY_SCHEMA} PRAGMA user_version = 5; COMMIT;`)
      if (version < 6) db.exec(`BEGIN IMMEDIATE; ${ACCOUNT_STARTED_SCHEMA} PRAGMA user_version = 6; COMMIT;`)
      // wardrobe slots and the retired colour robes' refund (progression.mjs)
      if (version < 7) db.exec(`BEGIN IMMEDIATE; ${PROGRESSION_V7_MIGRATION} PRAGMA user_version = 7; COMMIT;`)
    }
    const auth = betterAuth(options)
    // The library starts this check in the background. Await it explicitly so a
    // startup failure cannot be hidden and a migration command can close safely.
    const context = await auth.$context
    await context.checkSchema?.()
    const getProfile = db.prepare('SELECT name, color FROM player_profile WHERE user_id = ?')
    const regions = accountRegions(db)
    const play = createPlayControl(db)
    const ticketKey = (token) => createHash('sha256').update(token).digest('hex')
    const controlKey = (kind, id) => createHmac('sha256', secret).update(`${kind}:${id}`).digest('hex')
    const browserDevice = (request, supplied) => {
      const cookies = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith('brawlock.ranked_device='))
      if (cookies.length > 1) throw new Error('Invalid browser verification')
      if (cookies.length) {
        const value = cookies[0].slice('brawlock.ranked_device='.length)
        if (!/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value)) throw new Error('Invalid browser verification')
        const [device, signature] = value.split('.')
        if (!timingSafeEqual(Buffer.from(signature), Buffer.from(controlKey('browser-cookie', device)))) throw new Error('Invalid browser verification')
        return { device, headers: {} }
      }
      const device = controlKey('device', supplied)
      return { device, headers: { 'set-cookie': `brawlock.ranked_device=${device}.${controlKey('browser-cookie', device)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${origin.startsWith('https:') ? '; Secure' : ''}` } }
    }
    const saveTicket = db.prepare('INSERT INTO ranked_admissions VALUES (?,?,?,?,?,?)')
    const consumeTicket = db.prepare('DELETE FROM ranked_admissions WHERE token=? RETURNING *')
    const progression = createProgression(db)
    const claim = db.prepare('INSERT INTO player_profile(user_id, name, name_key, color, created_at) VALUES (?, ?, ?, ?, ?)')
    const rename = db.prepare('UPDATE player_profile SET name = ?, name_key = ?, color = ? WHERE user_id = ?')
    const names = new KeyedLimiter(6, 6 / 60)
    const admissions = new KeyedLimiter(12, 12 / 60)
    const purchases = new KeyedLimiter(20, 20 / 60)
    const presence = createPresence()
    analytics = openAnalytics(join(dirname(file), 'analytics.sqlite'))
    const presenceWrites = new KeyedLimiter(120, 120 / 60)
    const playWrites = new KeyedLimiter(120, 120 / 60)
    const json = (status, body, extra = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...extra } })
    const handler = async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/api/play') {
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
        if (request.headers.get('origin') !== origin) return json(403, { error: 'Origin required.' })
        const ip = request.headers.get('x-brawlock-client-ip')
        if (!ip) return json(400, { error: 'Missing trusted connection address.' })
        playWrites.sweep(Date.now())
        if (!playWrites.take(ip, Date.now())) return json(429, { error: 'Too many game session updates.' })
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, { error: 'Expected JSON.' })
        const raw = await request.text()
        if (Buffer.byteLength(raw, 'utf8') > 1024) return json(413, { error: 'Game session request is too large.' })
        let body
        try { body = JSON.parse(raw) } catch { return json(400, { error: 'Expected JSON.' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['action', 'device', 'controller', 'target', 'token', 'id'].includes(key))
          || typeof body.device !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.device)
          || typeof body.controller !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.controller)) return json(400, { error: 'Invalid game session request.' })
        let browser
        try { browser = browserDevice(request, body.device) } catch { return json(400, { error: 'Browser verification failed. Clear this site’s cookies and sign in again.' }) }
        if (body.action === 'release') {
          try { play.release(body.token); return json(200, { ok: true }, browser.headers) }
          catch { return json(400, { error: 'Invalid game permission.' }) }
        }
        const session = request.headers.has('cookie') ? await auth.api.getSession({ headers: request.headers }) : null
        const identity = { userId: session?.user.id ?? null, device: browser.device, controller: controlKey('controller', `${browser.device}:${body.controller}`) }
        try {
          if (body.action === 'acquire') { const result = play.acquire(identity, body.target); return json(result.ok ? 200 : 409, result, browser.headers) }
          if (body.action === 'heartbeat') { const result = play.heartbeat(body.token, body.target, identity); return json(result.ok ? 200 : 409, result, browser.headers) }
          if (body.action === 'takeover' && typeof body.id === 'string' && /^[a-f0-9-]{36}$/.test(body.id)) return json(200, play.takeover(identity, body.id), browser.headers)
          return json(400, { error: 'Invalid game session action.' })
        } catch { return json(400, { error: 'Invalid game permission or destination.' }) }
      }
      if (url.pathname === '/internal/analytics') {
        const received = Buffer.from(request.headers.get('authorization') ?? '')
        const expected = Buffer.from(`Bearer ${regionsToken}`)
        if (!regionsToken || request.headers.has('origin') || received.length !== expected.length || !timingSafeEqual(received, expected)) return json(403, { error: 'Forbidden.' })
        if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
        const days = Number(url.searchParams.get('days') ?? 30)
        if (!Number.isInteger(days) || days < 1 || days > 365) return json(400, { error: 'days must be an integer from 1 to 365' })
        return json(200, { source: 'accounts', ...analytics.report(days), live: presence.snapshot(),
          accounts: { registered: db.prepare('SELECT COUNT(*) AS n FROM user').get().n, profiles: db.prepare('SELECT COUNT(*) AS n FROM player_profile').get().n } })
      }
      if (url.pathname === '/internal/accounts') {
        const received = Buffer.from(request.headers.get('authorization') ?? '')
        const expected = Buffer.from(`Bearer ${regionsToken}`)
        if (!regionsToken || request.headers.has('origin') || received.length !== expected.length || !timingSafeEqual(received, expected)) return json(403, { error: 'Forbidden.' })
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
        const raw = await request.text()
        if (Buffer.byteLength(raw, 'utf8') > 16384) return json(413, { error: 'Request is too large.' })
        let body
        try { body = JSON.parse(raw) } catch { return json(400, { error: 'Expected JSON.' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.op !== 'string'
          || Object.keys(body).some((key) => !['op', 'region', 'instance', 'token', 'accountId', 'accountIds', 'room', 'receipt', 'connection', 'playToken', 'connectionId'].includes(key))) return json(400, { error: 'Invalid account operation.' })
        try {
          if (body.op === 'register') { regions.register(body.region, body.instance); play.register(body.region, body.instance); return json(200, { ok: true }) }
          if (body.op === 'playAttach') return json(200, play.attach(body.playToken, body.region, body.instance, body.room, body.accountId ?? null))
          if (body.op === 'playCheck') return json(200, play.check(body.playToken, body.connectionId))
          if (body.op === 'playDetach') { play.detach(body.region, body.instance, body.connectionId); return json(200, { ok: true }) }
          if (body.op === 'claim') return json(200, regions.claim(body.region, body.instance, body.accountId, body.room, body.connection))
          if (body.op === 'started') { regions.started(body.region, body.instance, body.room, body.accountIds); return json(200, { ok: true }) }
          if (body.op === 'disconnect') { regions.disconnect(body.region, body.instance, body.accountId, body.room, body.connection?.controller); return json(200, { ok: true }) }
          if (body.op === 'release') { regions.release(body.region, body.instance, body.room, body.accountId); return json(200, { ok: true }) }
          if (body.op === 'game') return json(200, { game: regions.game(body.accountId) })
          if (body.op === 'names') {
            if (!Array.isArray(body.accountIds) || body.accountIds.length > 101 || new Set(body.accountIds).size !== body.accountIds.length) return json(400, { error: 'Invalid name lookup.' })
            const names = body.accountIds.map((id) => {
              accountRatingKey(id)
              const profile = getProfile.get(id)
              if (!profile) throw new Error('Account name not found')
              return [id, profile.name]
            })
            return json(200, { names })
          }
          if (body.op === 'reward') return json(200, progression.recordMatch(body.receipt))
          if (body.op !== 'verify' || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.token)) return json(400, { error: 'Invalid account operation.' })
          let session
          try { session = await auth.api.verifyOneTimeToken({ body: { token: body.token } }) }
          catch { return json(401, { error: 'Sign in again before joining ranked.' }) }
          const ticket = consumeTicket.get(ticketKey(body.token))
          if (!ticket || ticket.expires <= Date.now() || ticket.user_id !== session.user.id) return json(401, { error: 'Reload the game to update account verification.' })
          const profile = getProfile.get(session.user.id)
          if (!profile) return json(403, { error: 'Choose your account player name first.' })
          return json(200, { account: { id: session.user.id, ...profile, ratingKey: accountRatingKey(session.user.id), cosmetics: progression.equipment(session.user.id),
            connection: { device: ticket.device, controller: ticket.controller, takeover: ticket.takeover === 1 } } })
        } catch (error) {
          if (error instanceof ProgressionError) return json(error.status, { error: error.message })
          return json(409, { error: 'The ranked account reservation is no longer valid.' })
        }
      }
      // No CORS: the client and authority must share the approved first-party origin.
      const requestOrigin = request.headers.get('origin')
      if (requestOrigin && requestOrigin !== origin) return json(403, { error: 'Untrusted origin.' })
      if (url.pathname.startsWith('/api/auth/one-time-token/')) return json(404, { error: 'Not found.' })
      if (url.pathname.startsWith('/api/auth/')) return auth.handler(request)
      if (url.pathname === '/api/account/config' && request.method === 'GET') {
        return json(200, { providers: PROVIDERS.filter((id) => Object.hasOwn(providers, id)) })
      }
      if (url.pathname === '/api/presence') {
        if (request.method === 'GET') return json(200, presence.snapshot())
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
        if (requestOrigin !== origin) return json(403, { error: 'Origin required.' })
        const ip = request.headers.get('x-brawlock-client-ip')
        if (!ip) return json(400, { error: 'Missing trusted connection address.' })
        const now = Date.now()
        presenceWrites.sweep(now)
        if (!presenceWrites.take(ip, now)) return json(429, { error: 'Too many online updates.' })
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, { error: 'Expected JSON.' })
        const raw = await request.text()
        if (Buffer.byteLength(raw, 'utf8') > 512) return json(413, { error: 'Request is too large.' })
        let body
        try { body = JSON.parse(raw) } catch { return json(400, { error: 'Expected JSON.' }) }
        const session = request.headers.has('cookie') ? await auth.api.getSession({ headers: request.headers }) : null
        const result = presence.beat(body, session?.user.id ?? null, ip)
        if (result.status === 200) analytics.presence({ device: body.device, accountId: session?.user.id ?? null, region: body.region,
          build: body.build, net: body.net, screen: body.screen, online: result.body.total, sample: presence.segments() })
        return json(result.status, result.body ?? { error: result.error })
      }
      const admission = url.pathname === '/api/account/admission'
      const collection = ['/api/progression', '/api/progression/purchase', '/api/progression/equip'].includes(url.pathname)
      if (url.pathname !== '/api/account' && !admission && !collection) return json(404, { error: 'Not found.' })
      if (!['GET', 'POST', 'PATCH'].includes(request.method)) return json(405, { error: 'Method not allowed.' })
      if (request.method !== 'GET' && requestOrigin !== origin) return json(403, { error: 'Origin required.' })
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session) return json(401, { error: 'Sign in to manage your account.' })
      const userId = session.user.id // Never accept account IDs or names from session hints/device IDs.
      if (collection) {
        if (url.pathname === '/api/progression') return request.method === 'GET' ? json(200, progression.snapshot(userId)) : json(405, { error: 'Method not allowed.' })
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
        purchases.sweep(Date.now())
        if (!purchases.take(userId, Date.now())) return json(429, { error: 'Too many collection changes. Try again in a minute.' })
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, { error: 'Expected JSON.' })
        const raw = await request.text()
        if (Buffer.byteLength(raw, 'utf8') > 1024) return json(413, { error: 'Request is too large.' })
        let body
        try { body = JSON.parse(raw) } catch { return json(400, { error: 'Expected JSON.' }) }
        try { return json(200, url.pathname.endsWith('/purchase') ? progression.purchase(userId, body) : progression.equip(userId, body)) }
        catch (error) { if (error instanceof ProgressionError) return json(error.status, { error: error.message }); throw error }
      }
      if (admission) {
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
        if (!getProfile.get(userId)) return json(403, { error: 'Choose your account player name first.' })
        admissions.sweep(Date.now())
        if (!admissions.take(userId, Date.now())) return json(429, { error: 'Too many connection attempts. Wait a moment and try again.' })
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, { error: 'Expected JSON.' })
        const raw = await request.text()
        if (Buffer.byteLength(raw, 'utf8') > 512) return json(413, { error: 'Connection request is too large.' })
        let body
        try { body = JSON.parse(raw) } catch { return json(400, { error: 'Expected JSON.' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['device', 'controller', 'takeover'].includes(key))
          || typeof body.device !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.device)
          || typeof body.controller !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.controller)
          || body.takeover !== undefined && typeof body.takeover !== 'boolean') return json(400, { error: 'Reload the game to update connection verification.' })
        let browser
        try { browser = browserDevice(request, body.device) }
        catch { return json(400, { error: 'Browser verification failed. Clear this site’s cookies and sign in again.' }) }
        const connection = { device: browser.device, controller: controlKey('controller', `${browser.device}:${body.controller}`), takeover: body.takeover === true }
        const ticket = await auth.api.generateOneTimeToken({ headers: request.headers })
        db.prepare('DELETE FROM ranked_admissions WHERE expires<=?').run(Date.now())
        saveTicket.run(ticketKey(ticket.token), userId, connection.device, connection.controller, Number(connection.takeover), Date.now() + 60000)
        return json(200, ticket, browser.headers)
      }
      if (request.method === 'GET') return json(200, { id: userId, email: session.user.email, profile: getProfile.get(userId) ?? null, game: regions.activeGame(userId) })
      const now = Date.now()
      names.sweep(now)
      if (!names.take(userId, now)) return json(429, { error: 'Too many profile changes. Try again in a minute.' }, { 'retry-after': '60' })
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, { error: 'Expected JSON.' })
      const raw = await request.text()
      if (Buffer.byteLength(raw, 'utf8') > 1024) return json(413, { error: 'Profile request is too large.' })
      let body
      try { body = JSON.parse(raw) } catch { return json(400, { error: 'Expected JSON.' }) }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['name', 'color'].includes(key))) {
        return json(400, { error: 'Unexpected profile fields.' })
      }
      if (body.color !== null && !PLAYER_COLORS.includes(body.color)) return json(400, { error: 'Choose a player color.' })
      if (request.method === 'PATCH') {
        const current = getProfile.get(userId)
        if (!current) return json(409, { error: 'Claim your player name first.' })
        const name = accountName(Object.hasOwn(body, 'name') ? body.name : current.name)
        if (!name) return json(400, { error: 'Use 3–16 letters, numbers or underscores, starting with a letter. This name may also be reserved.' })
        try { rename.run(name.name, name.key, body.color, userId) }
        catch (error) {
          if (error.errcode !== 1555 && error.errcode !== 2067) throw error
          return json(409, { error: 'That name is already taken.' })
        }
      } else {
        const name = accountName(body.name)
        if (!name) return json(400, { error: 'Use 3–16 letters, numbers or underscores, starting with a letter. This name may also be reserved.' })
        try { claim.run(userId, name.name, name.key, body.color, now) }
        catch (error) {
          if (error.errcode !== 1555 && error.errcode !== 2067) throw error
          return json(409, { error: getProfile.get(userId) ? 'This account already has a reserved name.' : 'That name is already taken.' })
        }
      }
      return json(200, { id: userId, email: session.user.email, profile: getProfile.get(userId), game: regions.activeGame(userId) })
    }
    const admin = async (request) => {
      if (!request.headers.has('cookie')) return null
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session) return null
      // Check the authoritative record, not a supplied email or browser session hint.
      const user = db.prepare('SELECT email,emailVerified FROM user WHERE id=?').get(session.user.id)
      const google = db.prepare("SELECT 1 FROM account WHERE userId=? AND providerId='google'").get(session.user.id)
      return user?.emailVerified && user.email.toLowerCase() === OPERATOR_EMAIL && google
        ? { email: user.email } : false
    }
    const activityReport = (days) => ({ source: 'accounts', ...analytics.report(days), live: presence.snapshot(),
      accounts: { registered: db.prepare('SELECT COUNT(*) AS n FROM user').get().n, profiles: db.prepare('SELECT COUNT(*) AS n FROM player_profile').get().n } })
    // Operator dashboard: current account names; a deleted account reads null.
    const profileNames = (ids) => new Map(ids.map((id) => [id, getProfile.get(id)?.name ?? null]))
    return { auth, handler, admin, activityReport, profileNames, presence: () => presence.snapshot(), close: () => { analytics.close(); db.close() } }
  } catch (error) {
    analytics?.close()
    db.close()
    throw error
  }
}
