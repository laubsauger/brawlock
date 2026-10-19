import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlayControl, PLAY_SCHEMA, PLAY_TTL_MS } from '../../server/play-control.mjs'
import { openTestDatabase } from '../../server/test-dir.mjs'
import { PlayControl, type PlayControlDeps, type PlayMode, type PlayTarget } from './playControl'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0; vi.useRealTimers() })
const target = (mode: PlayMode = 'casual'): PlayTarget => ({ mode, region: null, code: null })
const identity = (device = '1', userId: string | null = 'account-first', controller = 'a') => ({ device: device.repeat(64), userId, controller: controller.repeat(64) })
function fixture() {
  const db = openTestDatabase(':memory:'); cleanup.push(() => db.close())
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE account_regions(region TEXT PRIMARY KEY,instance TEXT);')
  db.exec(PLAY_SCHEMA)
  for (const user of ['account-first', 'account-second']) db.prepare('INSERT INTO user VALUES (?)').run(user)
  db.exec("INSERT INTO account_regions VALUES ('eu','instance-eu'),('us','instance-us')")
  let at = 100000
  const control = createPlayControl(db, { now: () => at })
  return { control, db, now: () => at, advance: (ms: number) => { at += ms } }
}

describe('global game ownership authority', () => {
  it.each<PlayMode>(['local', 'practice', 'host', 'p2p', 'server', 'casual', 'ranked'])('reserves the account and device for %s, independent of the next game mode', (mode) => {
    const f = fixture(), first = f.control.acquire(identity(), target(mode))
    expect(first.ok).toBe(true)
    expect(f.control.acquire(identity('2'), target('casual'))).toMatchObject({ ok: false, conflict: { kind: 'account', target: { mode } } })
    expect(f.control.acquire(identity('1', 'account-second', 'b'), target('local'))).toMatchObject({ ok: false, conflict: { kind: 'device' } })
    expect(f.control.acquire(identity('3', 'account-second'), target('local')).ok).toBe(true)
  })

  it('applies device exclusivity to guests and never lets an unrelated account revoke a game', () => {
    const f = fixture(), guest = identity('1', null), first = f.control.acquire(guest, target('host'))
    if (!first.ok) throw new Error('fixture failed')
    f.control.takeover(identity('2', 'account-second'), first.id)
    expect(f.control.heartbeat(first.token, target('host'), guest).ok).toBe(true)
    expect(f.control.acquire(identity('1', null, 'b'), target('practice')).ok).toBe(false)
    expect(f.control.heartbeat(first.token, target('host'), identity('1', 'account-first')).ok).toBe(false)
  })

  it('waits for both browser yield and server detach; one permission cannot attach to two regions or rooms', () => {
    const f = fixture(), actor = identity(), first = f.control.acquire(actor, target('server'))
    if (!first.ok) throw new Error('fixture failed')
    const attached = f.control.attach(first.token, 'eu', 'instance-eu', 'ABCDE', actor.userId)
    expect(() => f.control.attach(first.token, 'us', 'instance-us', 'FGHIJ', actor.userId)).toThrow('still closing')
    const second = identity('2')
    f.control.takeover(second, first.id)
    expect(f.control.check(first.token, attached.connection)).toEqual({ ok: false, transferring: true })
    expect(f.control.check(first.token, 'wrong-connection')).toEqual({ ok: false, transferring: false })
    expect(f.control.acquire(second, target('local')).ok).toBe(false)
    f.control.release(first.token)
    expect(f.control.acquire(second, target('local')).ok).toBe(false)
    f.control.detach('eu', 'wrong-generation', attached.connection)
    expect(f.control.acquire(second, target('local')).ok).toBe(false)
    f.control.detach('eu', 'instance-eu', attached.connection)
    expect(f.control.acquire(second, target('local')).ok).toBe(true)
  })

  it('expires unreachable owners, rejects their old permission, and preserves a live lease across authority reopen', () => {
    const f = fixture(), actor = identity(), first = f.control.acquire(actor, target('server'))
    if (!first.ok) throw new Error('fixture failed')
    const attached = f.control.attach(first.token, 'eu', 'instance-eu', 'ABCDE', actor.userId)
    const reopened = createPlayControl(f.db, { now: f.now })
    expect(reopened.acquire(identity('2'), target('host')).ok).toBe(false)
    f.advance(PLAY_TTL_MS + 1)
    expect(reopened.acquire(identity('2'), target('host')).ok).toBe(true)
    expect(reopened.check(first.token, attached.connection)).toEqual({ ok: false, transferring: false })
    expect(reopened.heartbeat(first.token, target('server'), actor).ok).toBe(false)
    expect(() => reopened.acquire(identity('2'), { ...target(), mode: 'unknown' as PlayMode })).toThrow('destination')
  })
})

describe('browser game ownership controller', () => {
  function browserFixture() {
    vi.useFakeTimers()
    const f = fixture()
    let owner: string | null = null, published = target()
    const listeners = new Map<string, () => void>(), stopped: string[] = [], conflicts: unknown[] = [], resumed: PlayTarget[] = []
    function browser(id: string, actor: ReturnType<typeof identity>, configure?: (deps: PlayControlDeps) => void) {
      const deps: PlayControlDeps = {
        enabled: true, now: f.now,
        async request(body) {
          const b = body as { action: string; target: PlayTarget; token: string; id: string }
          if (b.action === 'acquire') return f.control.acquire(actor, b.target)
          if (b.action === 'heartbeat') return f.control.heartbeat(b.token, b.target, actor)
          if (b.action === 'takeover') return f.control.takeover(actor, b.id)
          f.control.release(b.token); return { ok: true }
        },
        async lock() {
          if (owner) return null
          owner = id
          return () => { if (owner === id) owner = null }
        },
        localTarget: () => published, publish: (t) => { if (t) published = t },
        listen: (cb) => { listeners.set(id, cb); return () => { listeners.delete(id) } },
        yieldOthers: () => { for (const [other, cb] of listeners) if (other !== id) cb() },
        every: (fn, ms) => setInterval(fn, ms), cancel: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
        delay: async (ms) => { f.advance(ms) }, lost: () => stopped.push(id), conflict: (c) => conflicts.push(c), resume: async (t) => { resumed.push(t) },
      }
      configure?.(deps)
      const control = new PlayControl(deps); cleanup.push(() => { void control.release() })
      return control
    }
    return { ...f, browser, stopped, conflicts, resumed }
  }

  it('blocks a second tab for a different mode, then stops the old game before starting the new one', async () => {
    const f = browserFixture(), first = f.browser('first', identity()), second = f.browser('second', identity('1', 'account-first', 'b'))
    expect(await first.acquire(target('host'), async () => {})).toBe(true)
    const retry = vi.fn(async () => { expect(first.valid()).toBe(false); expect(second.valid()).toBe(true) })
    expect(await second.acquire(target('practice'), retry)).toBe(false)
    await second.takeover()
    expect(f.stopped).toEqual(['first'])
    expect(retry).toHaveBeenCalledOnce()
  })

  it('does not release a successor game when an abandoned acquisition fails late', async () => {
    const f = browserFixture()
    let reject!: (error: Error) => void
    const first = f.browser('first', identity(), (deps) => {
      const request = deps.request
      let pending = true
      deps.request = (body, keepalive) => {
        if (pending && (body as { action: string }).action === 'acquire') { pending = false; return new Promise((_yes, no) => { reject = no }) }
        return request(body, keepalive)
      }
    })
    const abandoned = first.acquire(target('local'), async () => {})
    await Promise.resolve(); await Promise.resolve()
    await first.release()
    expect(await first.acquire(target('practice'), async () => {})).toBe(true)
    const failure = expect(abandoned).rejects.toThrow('old request failed')
    reject(new Error('old request failed')); await failure
    expect(first.valid()).toBe(true)
    expect(f.control.acquire(identity('2'), target('host')).ok).toBe(false)
  })

  it('stops at the conservative permission deadline even if no heartbeat timer ran', async () => {
    const f = browserFixture(), first = f.browser('first', identity())
    await first.acquire(target('local'), async () => {})
    f.advance(29000)
    expect(first.valid()).toBe(false)
    expect(f.stopped).toEqual(['first'])
    expect(() => first.token()).toThrow('Open one game')
  })

  it('reopens an existing server game during a transfer instead of creating a second game', async () => {
    const f = browserFixture(), first = f.browser('first', identity()), second = f.browser('second', identity('1', 'account-first', 'b'))
    const existing = { mode: 'casual' as const, region: 'eu', code: 'ABCDE' }
    await first.acquire(existing, async () => {})
    const retry = vi.fn(async () => {})
    await second.acquire(target('local'), retry)
    await second.takeover()
    expect(retry).not.toHaveBeenCalled()
    expect(f.resumed).toEqual([existing])
  })
})
