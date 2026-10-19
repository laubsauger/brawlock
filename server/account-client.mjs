// Regional server → single account authority. Browser cookies never cross regions.
import { randomUUID } from 'node:crypto'
import { accountRatingKey } from '../src/net/accounts.ts'
import { validCosmeticEquipment } from '../src/game/progressionCatalog.ts'
import { progressionOutbox } from './progression-outbox.mjs'

export function regionalAccounts({ url, token, region, log, rewardFile, requestMs = 4000, allowInsecureForTests = false }) {
  const base = new URL(url)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback && (allowInsecureForTests || base.hostname === '127.0.0.1')))) {
    throw new Error('Account authority must be an HTTPS origin or the local loopback service')
  }
  if (typeof token !== 'string' || token.length < 32) throw new Error('Account region token must contain at least 32 characters')
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(region)) throw new Error('Account admission requires a region ID')
  const instance = randomUUID()
  let registered = false
  let closed = false
  const pending = new Map()
  let flushing = null
  async function rpc(op, fields = {}) {
    if (closed) throw new Error('Account authority client is closed')
    const response = await fetch(`${base.origin}/internal/accounts`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ op, region, instance, ...fields }),
      signal: AbortSignal.timeout(requestMs), redirect: 'error',
    })
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length
      if (bytes > 16384) throw new Error('Account authority response is too large')
      chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = JSON.parse(raw)
    if (!response.ok) throw new Error(op === 'playAttach' ? 'Only one game can be connected at a time. Return to the menu and choose Use here.' : response.status === 401 || response.status === 403 ? 'Sign in again before joining ranked.' : 'Account verification is temporarily unavailable.')
    return body
  }
  function requireRegistered() {
    if (!registered) throw new Error('Account authority is not registered')
  }
  async function flush() {
    if (flushing) return flushing
    flushing = (async () => {
      for (const [key, { op, fields }] of pending) {
        if (closed) break
        try { await rpc(op, fields); pending.delete(key) }
        catch { log('warn', `accounts.${op}.pending`); break }
      }
    })().finally(() => { flushing = null })
    return flushing
  }
  const timer = setInterval(() => { if (registered && pending.size) void flush() }, 2000)
  timer.unref()
  const rewards = rewardFile ? progressionOutbox({ file: rewardFile, send: (receipt) => rpc('reward', { receipt }), log }) : null
  return {
    async attachPlay(playToken, room, accountId) {
      requireRegistered(); await flush()
      if (pending.size) throw new Error('Your previous game connection is still closing. Try again in a moment.')
      const reply = await rpc('playAttach', { playToken, room, accountId })
      if (typeof reply.connection !== 'string' || typeof reply.id !== 'string' || !Number.isFinite(reply.expiresAt) || !Number.isFinite(reply.serverTime)) throw new Error('Invalid game permission from the authority')
      return reply
    },
    async checkPlay(playToken, connectionId) {
      requireRegistered()
      const reply = await rpc('playCheck', { playToken, connectionId })
      if (reply.ok !== false && (reply.ok !== true || !Number.isFinite(reply.expiresAt) || !Number.isFinite(reply.serverTime))) throw new Error('Invalid game permission from the authority')
      return reply
    },
    detachPlay(connectionId) {
      if (!registered || closed) return
      pending.set(`playDetach:${connectionId}`, { op: 'playDetach', fields: { connectionId } })
      void flush()
    },
    async names(accountIds) {
      requireRegistered()
      const body = await rpc('names', { accountIds })
      if (!Array.isArray(body.names) || body.names.length !== accountIds.length) throw new Error('Invalid account name lookup')
      const names = new Map()
      for (const row of body.names) {
        if (!Array.isArray(row) || row.length !== 2 || !accountIds.includes(row[0]) || names.has(row[0]) || typeof row[1] !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{2,15}$/.test(row[1])) throw new Error('Invalid account name lookup')
        names.set(row[0], row[1])
      }
      return names
    },
    async reward(receipt) {
      requireRegistered()
      if (!rewards) throw new Error('Account progression requires durable reward storage')
      return rewards.record(receipt)
    },
    // Bind the game port FIRST: a second process must not fence a running one.
    async register() { await rpc('register'); registered = true },
    async verify(proof) {
      requireRegistered()
      if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(proof)) throw new Error('Sign in before joining ranked.')
      const body = await rpc('verify', { token: proof })
      const a = body.account
      if (!a || typeof a.id !== 'string' || a.ratingKey !== accountRatingKey(a.id)
        || typeof a.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{2,15}$/.test(a.name)
        || !(a.color === null || Number.isInteger(a.color) && a.color >= 0 && a.color <= 0xffffff)
        || !validCosmeticEquipment(a.cosmetics)
        || !a.connection || !/^[a-f0-9]{64}$/.test(a.connection.device) || !/^[a-f0-9]{64}$/.test(a.connection.controller)
        || typeof a.connection.takeover !== 'boolean') throw new Error('Account authority returned an invalid identity')
      return a
    },
    async game(accountId) {
      requireRegistered()
      await flush()
      if (pending.size) throw new Error('Your previous ranked game is still being released. Try again in a moment.')
      return (await rpc('game', { accountId })).game
    },
    async claim(accountId, room, connection) {
      requireRegistered()
      // Apply pending room releases before considering another ranked admission.
      await flush()
      if (pending.size) throw new Error('Your previous ranked game is still being released. Try again in a moment.')
      const body = await rpc('claim', { accountId, room, connection })
      if (body.ok === true || body.ok === false && body.game && typeof body.game.region === 'string' && /^[A-Z]{5}$/.test(body.game.room)) return body
      throw new Error('Account authority returned an invalid ranked reservation')
    },
    started(room, accountIds) {
      requireRegistered()
      pending.set(`started:${room}`, { op: 'started', fields: { room, accountIds } })
      void flush()
    },
    release(room, accountId) {
      if (!registered || closed) return
      const fields = { room, ...(accountId ? { accountId } : {}) }
      pending.set(`release:${room}:${accountId ?? '*'}`, { op: 'release', fields })
      void flush()
    },
    disconnected(room, accountId, controller) {
      if (!registered || closed) return
      pending.set(`disconnect:${room}:${accountId}:${controller}`, { op: 'disconnect', fields: { room, accountId, connection: { controller } } })
      void flush()
    },
    pending() { return { rewards: rewards?.pending() ?? 0, releases: pending.size } },
    close() { if (closed) return; closed = true; clearInterval(timer); rewards?.close() },
  }
}
