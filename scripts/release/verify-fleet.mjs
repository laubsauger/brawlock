#!/usr/bin/env node
// Read-only by default. Admission creates one temporary casual lobby on an empty region.
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const usage = 'Usage: node scripts/release/verify-fleet.mjs EXPECTED_NET EXPECTED_PROTOCOL REGION=HTTPS_ORIGIN... [--admission] [--origin HTTPS_ORIGIN] [--allow-local-http]'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fail = (message) => { throw new Error(message) }

function options(args) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22) fail('Node 22 or newer is required')
  const net = args.shift()
  const protocolText = args.shift()
  if (!net || !/^[A-Za-z0-9_-]{1,80}$/.test(net) || !/^[1-9][0-9]{0,3}$/.test(protocolText ?? '')) fail(usage)
  const result = { net, protocol: Number(protocolText), admission: false, origin: 'https://brawlock.osc.link', local: false, regions: [] }
  const seen = new Set()
  while (args.length) {
    const arg = args.shift()
    if (arg.startsWith('--')) {
      if (seen.has(arg)) fail('Duplicate option')
      seen.add(arg)
      if (arg === '--admission') result.admission = true
      else if (arg === '--allow-local-http') result.local = true
      else if (arg === '--origin' && args.length) result.origin = args.shift()
      else fail(usage)
    } else {
      const match = /^([a-z][a-z0-9-]{0,31})=(.+)$/.exec(arg)
      if (!match) fail(usage)
      result.regions.push({ region: match[1], origin: match[2] })
    }
  }
  function origin(value) {
    let url
    try { url = new URL(value) } catch { fail('Invalid origin') }
    if (url.origin !== value || url.username || url.password) fail('Use an exact origin without path, credentials or query')
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(result.local && local && url.protocol === 'http:')) fail('HTTPS is required; --allow-local-http permits loopback fixtures only')
    return value
  }
  result.origin = origin(result.origin)
  if (!result.regions.length) fail(usage)
  const regions = new Set(), origins = new Set()
  for (const entry of result.regions) {
    entry.origin = origin(entry.origin)
    if (regions.has(entry.region) || origins.has(entry.origin)) fail('Duplicate region or server origin')
    regions.add(entry.region); origins.add(entry.origin)
  }
  if (result.admission && (major < 24 || (major === 24 && minor < 11))) fail('--admission requires Node 24.11+ for explicit WebSocket Origin headers; read-only health supports Node 22+')
  if (result.admission && result.protocol < 8) fail('--admission requires the account-aware protocol (8 or newer)')
  return result
}

async function json(entry, path, opts, method = 'GET') {
  let response
  try {
    response = await fetch(entry.origin + path, { method, headers: { origin: opts.origin }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (!response.ok) { await response.body?.cancel(); fail(`HTTP ${response.status}`) }
    const reader = response.body.getReader()
    let size = 0
    const chunks = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 65536) { await reader.cancel(); fail('Response exceeds 64 KiB') }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    // Never echo a remote body, URL query, player identifier or token.
    fail(`${entry.region} ${path.split('?')[0]}: ${error instanceof Error && /^HTTP \d+$|^Response exceeds/.test(error.message) ? error.message : 'request failed or invalid JSON'}`)
  }
}

async function health(entry, opts) {
  const value = await json(entry, '/health', opts)
  if (value.ok !== true || value.build !== opts.net || value.protocol !== opts.protocol || value.region !== entry.region) fail(`${entry.region}: health identity/version mismatch`)
  for (const key of ['rooms', 'players', 'connections']) if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail(`${entry.region}: invalid health counters`)
  return { region: entry.region, origin: entry.origin, build: value.build, protocol: value.protocol,
    rooms: value.rooms, players: value.players, connections: value.connections, draining: value.maintenance?.draining === true }
}

export async function withGuestPlay(entry, opts, run) {
  const identity = { device: randomUUID(), controller: randomUUID() }
  let cookie = ''
  const request = async (body) => {
    let response
    try {
      response = await fetch(`${opts.origin}/api/play`, { method: 'POST',
        headers: { origin: opts.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ ...identity, ...body }), redirect: 'error', signal: AbortSignal.timeout(8000) })
      if (!response.ok) { await response.body?.cancel(); fail('rejected') }
      if (!cookie) cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
      return await response.json()
    } catch { fail(`${entry.region}: guest game permission request failed`) }
  }
  const permission = await request({ action: 'acquire', target: { mode: 'casual', region: entry.region, code: null } })
  if (permission.ok !== true || !/^[A-Za-z0-9_-]{43}$/.test(permission.token ?? '') || !cookie) fail(`${entry.region}: invalid guest game permission`)
  try { return await run(permission.token) }
  finally {
    const released = await request({ action: 'release', token: permission.token })
    if (released.ok !== true) fail(`${entry.region}: guest game permission was not released`)
  }
}

export async function admit(entry, code, opts, playToken) {
  const url = new URL('/ws', entry.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('room', code)
  const profileId = randomUUID()
  const socket = new WebSocket(url, { headers: { origin: opts.origin } })
  let closed = false
  const closeDone = new Promise((resolve) => socket.addEventListener('close', () => { closed = true; resolve() }, { once: true }))
  try {
    await new Promise((resolve, reject) => {
      let verified = false, playerId = null, leaving = false, finished = false
      const timer = setTimeout(() => finish(new Error('account/guest admission timed out')), 5000)
      function finish(error) {
        if (finished) return
        finished = true
        clearTimeout(timer)
        error ? reject(error) : resolve()
      }
      const send = (value) => socket.send(JSON.stringify(value))
      socket.addEventListener('open', () => send({ t: 'account', token: null, playToken }), { once: true })
      socket.addEventListener('error', () => finish(new Error('WebSocket connection failed')), { once: true })
      socket.addEventListener('close', () => { if (!leaving) finish(new Error('WebSocket closed before admission')) }, { once: true })
      socket.addEventListener('message', (event) => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 65536) fail('invalid WebSocket message')
          if (event.data.startsWith('#p')) { socket.send('#q' + event.data.slice(2)); return }
          if (event.data.startsWith('#')) return
          let message
          try { message = JSON.parse(event.data) } catch { fail('invalid WebSocket JSON') }
          if (!message || typeof message !== 'object') fail('invalid WebSocket message')
          if (message.t === 'start') fail('match started before verification could leave')
          if (message.t === 'error' || message.t === 'kick') fail('server rejected guest admission')
          if (message.t === 'account-ready') {
            if (verified) fail('duplicate account acknowledgement')
            verified = true
            send({ t: 'hello', version: opts.protocol, build: opts.net, key: randomUUID(), profileId, device: randomUUID(), name: 'Fleet QA', color: null })
          } else if (message.t === 'welcome') {
            if (!verified || !Number.isSafeInteger(message.playerId) || message.server?.build !== opts.net) fail('invalid welcome identity/version')
            playerId = message.playerId
          } else if (message.t === 'lobby' && !leaving) {
            const self = message.slots?.find((slot) => slot.id === playerId)
            if (!verified || playerId === null || message.room?.quick !== true || message.room.ranked === true || self?.kind !== 'human' || self.profileId !== profileId || self.guest !== true) fail('casual lobby/canonical guest identity mismatch')
            leaving = true
            send({ t: 'leave' })
            socket.close(1000)
            // Give queued messages a turn so an unexpected start still fails this check.
            setImmediate(() => finish())
          }
        } catch (error) { finish(error) }
      })
    })
  } finally {
    if (!closed && socket.readyState < 2) socket.close()
    await Promise.race([closeDone, sleep(2000)])
    if (!closed) fail(`${entry.region}: WebSocket did not close within two seconds`)
  }
}

async function until(predicate, ms, message) {
  const deadline = Date.now() + ms
  do {
    if (await predicate()) return
    await sleep(200)
  } while (Date.now() < deadline)
  fail(message)
}

async function admission(entry, opts) {
  const current = await health(entry, opts)
  if (current.rooms || current.players || current.connections || current.draining) fail(`${entry.region}: --admission requires an empty, open region (zero rooms, players and connections)`)
  return withGuestPlay(entry, opts, async (playToken) => {
    const created = await json(entry, '/quickplay', opts, 'POST')
    if (created.created !== true || created.region !== entry.region || !/^[A-Z]{5}$/.test(created.code ?? '')) fail(`${entry.region}: expected a newly created casual room`)
    let error
    try { await admit(entry, created.code, opts, playToken) } catch (cause) { error = cause }
    try {
      await until(async () => (await json(entry, `/rooms/${created.code}`, opts)).exists === false, 20000, `${entry.region}: temporary room was not removed`)
      await until(async () => {
        const value = await json(entry, '/rooms?public=1', opts)
        if (!Array.isArray(value.rooms)) fail(`${entry.region}: invalid public room listing`)
        return !value.rooms.some((room) => room.code === created.code)
      }, 4000, `${entry.region}: temporary room remains in public listing`)
    } catch (cleanupError) { fail(`${entry.region}: admission cleanup failed${error ? ' after admission failure' : ''}; ${cleanupError.message}`) }
    if (error) fail(`${entry.region}: ${error.message}`)
    return { guestAdmission: true, casualLobby: true, leftBeforeCombat: true, roomRemoved: true, listingRemoved: true }
  })
}

export async function main(args = process.argv.slice(2)) {
  const opts = options(args)
  const regions = []
  for (const entry of opts.regions) regions.push(await health(entry, opts))
  if (opts.admission) for (let i = 0; i < regions.length; i++) regions[i].admission = await admission(opts.regions[i], opts)
  console.log(JSON.stringify({ ok: true, expected: { net: opts.net, protocol: opts.protocol }, regions }))
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Fleet verification failed' }))
  process.exitCode = 1
})
