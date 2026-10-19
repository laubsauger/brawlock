/**
 * Player-hosted room listings: the server-side directory (lifecycle, token, limits,
 * validation) and the host-side lister that keeps a listing in step with the room.
 */
import { describe, expect, it } from 'vitest'
import { LISTING_TTL_MS, ListingDirectory, type ListingInfo } from './listings'
import { Lister, p2pListingTarget, type ListerTimers } from './lister'
import { ServerError, type Online } from './online'
import { DEFAULT_SETTINGS } from '../sim/config'

const INFO: ListingInfo = { code: 'ABCDE', host: 'Mira', humans: 1, bots: 2, max: 10, phase: 'lobby', teamMode: 'ffa', gameMode: 'rounds', winScore: 5 }

function directory(limits: Partial<ConstructorParameters<typeof ListingDirectory>[0]> = {}) {
  let now = 1000
  const dir = new ListingDirectory({ ttlMs: LISTING_TTL_MS, maxTotal: 100, perIp: 3, maxSeats: 10, ...limits }, () => now)
  return { dir, advance: (ms: number) => (now += ms) }
}

describe('listing directory (server)', () => {
  it('publishes validated match progress and clears it on returning to the lobby', () => {
    const { dir } = directory()
    const progress = { round: 3, elapsedSeconds: 245, phase: 'shop', final: false }
    const created = dir.create('ip', { ...INFO, phase: 'match', progress: { ...progress, privateData: 'must not leak' } })
    if (!created.ok) throw new Error(created.error)
    expect(dir.list()[0].progress).toEqual(progress)
    expect(JSON.stringify(dir.list())).not.toContain('privateData')
    for (const invalid of [false, {}, { ...progress, round: -1 }, { ...progress, round: 1.5 }, { ...progress, elapsedSeconds: -1 }, { ...progress, elapsedSeconds: Infinity }, { ...progress, phase: 'unknown' }, { ...progress, final: 'yes' }]) {
      expect(dir.beat(created.id, { token: created.token, progress: invalid })).toMatchObject({ ok: false, status: 400, error: 'bad progress' })
    }
    expect(dir.list()[0].progress).toEqual(progress)
    expect(dir.beat(created.id, { token: created.token, phase: 'lobby', progress: null })).toEqual({ ok: true })
    expect(dir.list()[0].progress).toBeNull()
  })

  it('publishes full bot-filled P2P rooms in lobby, match and results with their real reservable seats', () => {
    const input = {
      listed: { code: INFO.code, region: 'us-west' }, code: INFO.code, role: 'host', status: 'open', public: true,
      transport: 'p2p' as const, slots: [{ kind: 'human' as const }, ...Array.from({ length: 9 }, () => ({ kind: 'bot' as const }))],
      settings: DEFAULT_SETTINGS, host: INFO.host, max: 10, joinable: 9,
    }
    const { dir } = directory()
    for (const screen of ['lobby', 'match', 'results']) {
      const target = p2pListingTarget({ ...input, screen })!
      expect(target.info).toMatchObject({ humans: 1, bots: 9, max: 10, joinable: 9, phase: screen })
      const listed = dir.create('ip', target.info)
      if (!listed.ok) throw new Error(listed.error)
      expect(dir.list()).toMatchObject([{ kind: 'p2p', code: INFO.code, joinable: 9 }])
      expect(dir.remove(listed.id, { token: listed.token }).ok).toBe(true)
    }
    // Full humans remain discoverable to a disconnected participant; browser disables new joins.
    expect(p2pListingTarget({ ...input, screen: 'match', slots: Array.from({ length: 10 }, () => ({ kind: 'human' as const })), joinable: 0 })?.info).toMatchObject({ humans: 10, bots: 0, joinable: 0 })
    for (const patch of [{ public: false }, { transport: 'server' as const }, { role: 'client' }, { status: 'error' }, { code: 'OTHER' }]) {
      expect(p2pListingTarget({ ...input, screen: 'lobby', ...patch })).toBeNull()
    }
    expect(dir.create('ip', { ...INFO, joinable: -1 })).toMatchObject({ ok: false, error: 'bad joinable' })
    expect(dir.create('ip', { ...INFO, joinable: 11 })).toMatchObject({ ok: false, error: 'bad joinable' })
  })
  /** Why: the browser must only show rooms whose host is still there: a host that stops sending heartbeats drops off within the TTL. */
  it('create, heartbeat, expire, delete', () => {
    const { dir, advance } = directory()
    const c = dir.create('1.1.1.1', INFO)
    if (!c.ok) throw new Error(c.error)
    expect(c.id).toMatch(/^[0-9a-f]{12}$/)
    expect(c.token).toMatch(/^[0-9a-f]{32}$/)
    expect(dir.list()).toEqual([{ ...INFO, kind: 'p2p' }])
    // heartbeats keep it alive and carry changes
    advance(LISTING_TTL_MS - 1000)
    expect(dir.beat(c.id, { token: c.token, humans: 3, phase: 'match' })).toEqual({ ok: true })
    advance(LISTING_TTL_MS - 1000)
    expect(dir.list()).toMatchObject([{ humans: 3, phase: 'match' }])
    // silence: gone after the TTL, and the host is told to list again
    advance(LISTING_TTL_MS)
    expect(dir.list()).toEqual([])
    expect(dir.beat(c.id, { token: c.token })).toEqual({ ok: true, gone: true })
    // delete removes it at once
    const d = dir.create('1.1.1.1', INFO)
    if (!d.ok) throw new Error(d.error)
    expect(dir.remove(d.id, { token: d.token })).toEqual({ ok: true })
    expect(dir.list()).toEqual([])
    expect(dir.size).toBe(0)
  })

  /** Why: only the host that listed a room may change or remove it; the id alone is not enough. */
  it('the token is required for heartbeats and removal', () => {
    const { dir } = directory()
    const c = dir.create('1.1.1.1', INFO)
    if (!c.ok) throw new Error(c.error)
    expect(dir.beat(c.id, { humans: 4 })).toMatchObject({ ok: false, status: 403 })
    expect(dir.beat(c.id, { token: 'f'.repeat(32), humans: 4 })).toMatchObject({ ok: false, status: 403 })
    expect(dir.remove(c.id, null)).toMatchObject({ ok: false, status: 403 })
    expect(dir.list()).toMatchObject([{ humans: 1 }])
    // the code is the listing's identity
    expect(dir.beat(c.id, { token: c.token, code: 'QQQQQ' })).toMatchObject({ ok: false, status: 400 })
    // nothing private in the public view
    const view = JSON.stringify(dir.list())
    expect(view).not.toContain(c.token)
    expect(view).not.toContain(c.id)
    expect(view).not.toContain('1.1.1.1')
  })

  /** Why: one network cannot flood the directory; fields are bounded and the name is cleaned. */
  it('limits: per IP, per server, one listing per code; fields validated, name sanitized', () => {
    const { dir } = directory({ perIp: 2, maxTotal: 3 })
    const codes = ['AAAAA', 'BBBBB', 'CCCCC', 'DDDDD']
    expect(dir.create('ip-1', { ...INFO, code: codes[0] }).ok).toBe(true)
    expect(dir.create('ip-1', { ...INFO, code: codes[1] }).ok).toBe(true)
    expect(dir.create('ip-1', { ...INFO, code: codes[2] })).toMatchObject({ ok: false, status: 429 })
    expect(dir.create('ip-2', { ...INFO, code: codes[0] })).toMatchObject({ ok: false, status: 409 })
    expect(dir.create('ip-2', { ...INFO, code: codes[2] }).ok).toBe(true)
    expect(dir.create('ip-3', { ...INFO, code: codes[3] })).toMatchObject({ ok: false, status: 503 })
    const v = directory().dir
    expect(v.create('x', { ...INFO, code: 'nope!' })).toMatchObject({ status: 400, error: 'bad room code' })
    expect(v.create('x', { ...INFO, humans: 11 })).toMatchObject({ status: 400, error: 'bad humans' })
    expect(v.create('x', { ...INFO, phase: 'party' })).toMatchObject({ status: 400, error: 'bad phase' })
    expect(v.create('x', { ...INFO, teamMode: 'chaos' })).toMatchObject({ status: 400 })
    expect(v.create('x', 'hello')).toMatchObject({ status: 400 })
    expect(v.create('x', { ...INFO, host: '\u0007Mira the absolutely magnificent warlock' }).ok).toBe(true)
    expect(v.list()[0].host).toBe('Mira the absolutely ')
  })
})

describe('lister (host side)', () => {
  /** A fake game server API and a fake clock: what the lister sends, and when. */
  function setup() {
    let now = 0
    const timers: { at: number; fn: () => void }[] = []
    const clock: ListerTimers = {
      now: () => now,
      set: (fn, ms) => {
        const t = { at: now + ms, fn }
        timers.push(t)
        return t
      },
      clear: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number])
        if (i >= 0) timers.splice(i, 1)
      },
    }
    const calls: string[] = []
    let beatReply: 'ok' | 'gone' | Error = 'ok'
    let listReply: Error | null = null
    let n = 0
    const online = {
      listRoom: async (region: string, info: ListingInfo) => {
        calls.push(`list ${region} ${info.humans}`)
        if (listReply) throw listReply
        return { id: `id${++n}`, token: 'tok', heartbeatMs: 10_000 }
      },
      beatListing: async (region: string, id: string, _t: string, info: Partial<ListingInfo>) => {
        calls.push(`beat ${region} ${id} ${info.humans}`)
        if (beatReply instanceof Error) throw beatReply
        return beatReply
      },
      unlistRoom: async (region: string, id: string) => {
        calls.push(`unlist ${region} ${id}`)
      },
    } as unknown as Online
    const lister = new Lister(online, clock)
    const flush = () => new Promise((r) => setTimeout(r, 0))
    const advance = async (ms: number) => {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const t = timers[0]
        if (!t || t.at > end) break
        timers.shift()
        now = t.at
        t.fn()
        await flush()
      }
      now = end
      await flush()
    }
    return { lister, calls, advance, flush, setBeat: (r: typeof beatReply) => (beatReply = r), setList: (e: Error | null) => (listReply = e) }
  }
  const T = (humans: number, region = 'us-west') => ({ region, info: { ...INFO, humans } })

  /** Why: the listing must follow the room (players, phase) without flooding the server, and vanish the moment the room goes private. */
  it('lists, heartbeats every 10 s, sends changes at most every 2 s, unlists at once', async () => {
    const { lister, calls, advance, flush } = setup()
    lister.want(T(1))
    await flush()
    expect(calls).toEqual(['list us-west 1'])
    expect(lister.state()).toEqual({ status: 'listed', region: 'us-west', error: null })
    await advance(10_000)
    expect(calls.at(-1)).toBe('beat us-west id1 1')
    // a change goes out soon, but not more than one beat per 2 s
    lister.want(T(2))
    await flush()
    lister.want(T(3))
    await advance(1000)
    expect(calls.filter((c) => c.startsWith('beat'))).toHaveLength(1)
    await advance(1500)
    expect(calls.at(-1)).toBe('beat us-west id1 3')
    // private again: removed at once
    lister.want(null)
    await flush()
    expect(calls.at(-1)).toBe('unlist us-west id1')
    expect(lister.state().status).toBe('off')
    await advance(60_000)
    expect(calls.at(-1)).toBe('unlist us-west id1')
  })

  /** Why: a server restart forgets listings; the host lists again by itself. A failure shows and retries. */
  it('expired: lists again; a refused or failed request shows as an error and retries', async () => {
    const { lister, calls, advance, flush, setBeat, setList } = setup()
    lister.want(T(1))
    await flush()
    setBeat('gone')
    await advance(10_000)
    expect(calls.slice(-2)).toEqual(['beat us-west id1 1', 'list us-west 1'])
    setBeat('ok')
    // another region: moved
    lister.want(T(1, 'eu'))
    await flush()
    expect(calls.slice(-2)).toEqual(['unlist us-west id2', 'list eu 1'])
    lister.want(null)
    await flush()
    setList(new ServerError('limited', 'Too many listed games from your network.'))
    lister.want(T(1))
    await flush()
    expect(lister.state()).toEqual({ status: 'error', region: 'us-west', error: 'Too many listed games from your network.' })
    setList(null)
    await advance(15_000)
    expect(lister.state().status).toBe('listed')
  })
})
