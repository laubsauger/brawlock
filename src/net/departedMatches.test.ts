import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openLeaderboard } from '../../server/leaderboard-store.mjs'
import { createBot } from '../bots'
import { createMatch, DEFAULT_SETTINGS, step } from '../sim'
import { killPawn } from '../sim/combat'
import type { SimState } from '../sim/types'
import { createServerCore, DEFAULT_SERVER_CONFIG, type ServerCore } from './server'
import { decode, encode, PROTOCOL_VERSION, type Msg } from './protocol'
import { localRatingAuthority, type RatingAuthority, type RatingSubmission } from './ratingAuthority'

const cleanups: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
  vi.clearAllTimers()
  vi.useRealTimers()
})

/** Real authoritative simulation, protocol and SQLite with a controlled clock. */
function fixture(delayRecord = false) {
  let now = 0
  let state: SimState | null = null
  let winner: number | null = null
  const pulses = new Set<(now: number) => void>()
  const store = openLeaderboard(':memory:')
  const local = localRatingAuthority(store, { minSeconds: 120 })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const record = vi.fn(async (submission: RatingSubmission) => {
    if (delayRecord) await gate
    return local.record(submission)
  })
  const authority: RatingAuthority = { ...local, record }
  const settings = { shopSeconds: 0, rankedRounds: 0 as const, winScore: 1,
    lavaDps: 0, dmgMultiplier: 0, kbMultiplier: 0, botsReplaceLeavers: false }
  const core = createServerCore({ ...DEFAULT_SERVER_CONFIG, region: 'eu', build: 'dev-departures', leaderboardMinSeconds: 120,
    ranked: { ...DEFAULT_SERVER_CONFIG.ranked, bots: 'dummy', fill: 3, minHumans: 2, fillMs: 1, startMs: 1,
      settings: { ...DEFAULT_SERVER_CONFIG.ranked.settings, ...settings } },
  }, {
    ratingAuthority: authority,
    defaultSettings: DEFAULT_SETTINGS,
    createMatch: (...args) => (state = createMatch(...args)),
    step: (next, inputs) => {
      state = next
      step(next, inputs)
      if (winner !== null && next.phase === 'fight') {
        for (const pawn of next.pawns) if (pawn.owner !== winner && pawn.alive) killPawn(next, pawn, winner, 'fireball')
        winner = null
      }
    },
    createBot,
    startClock: (pulse) => { pulses.add(pulse); return () => { pulses.delete(pulse) } },
    now: () => now, random: () => 0.42, log: () => {},
  })
  cleanups.push(() => core.close())
  async function advance(ms: number) {
    for (let left = ms; left > 0;) {
      const dt = Math.min(left, 20)
      left -= dt; now += dt
      for (const pulse of pulses) pulse(now)
      await vi.advanceTimersByTimeAsync(dt)
    }
  }
  async function battle() {
    const room = await core.createRoom({ code: 'ABCDE', quick: 'dummy', ranked: true })
    const a = connect(core, room.code, 'alpha')
    const b = connect(core, room.code, 'bravo')
    await advance(100)
    for (let n = 0; state?.phase !== 'fight' && n < 500; n++) await advance(20)
    expect(state?.phase).toBe('fight')
    return { room, a, b }
  }
  return { core, store, record, release, advance, battle, state: () => state!, win: (player: number) => { winner = player } }
}

function connect(core: ServerCore, code: string, key: string) {
  const messages: Msg[] = []
  let receive!: (text: string) => void
  let onClose!: () => void
  let closed = false
  const socket = {
    send(text: string) {
      if (text.startsWith('#p')) receive?.(`#q${text.slice(2)}`)
      else if (text.startsWith('{')) { const message = decode(text); if (message) messages.push(message) }
    },
    close() { if (!closed) { closed = true; onClose?.() } },
    onText(callback: (text: string) => void) { receive = callback },
    onClose(callback: () => void) { onClose = callback },
  }
  core.attach({ kind: 'room', code }, socket, key)
  receive(encode({ t: 'hello', version: PROTOCOL_VERSION, name: key, key, profileId: `profile-${key}`,
    device: `device-${key}`, color: null, build: 'dev-departures' }))
  return { messages, close: socket.close }
}

describe('dedicated departure settlement', () => {
  it('closes a ranked lobby peek immediately without a match, history row or Elo result', async () => {
    const f = fixture()
    const room = await f.core.createRoom({ code: 'ABCDE', quick: 'dummy', ranked: true })
    const a = connect(f.core, room.code, 'alpha')
    expect(room.screen()).toBe('lobby')
    a.close()
    expect(f.core.room(room.code)).toBeNull()
    expect(f.record).not.toHaveBeenCalled()
    expect(f.store.history('device-alpha', { limit: 10 })).toEqual([])
    expect(f.store.players(['device-alpha']).size).toBe(0)
  })

  it('saves both qualifying first-round departures as losses before removing the empty ranked room', async () => {
    const f = fixture()
    const { room, a, b } = await f.battle()
    await f.advance(61_000)
    a.close(); b.close()
    await vi.waitFor(() => expect(f.core.room(room.code)).toBeNull())
    expect(f.record).toHaveBeenCalledOnce()
    const match = f.record.mock.calls[0][0].match
    expect(match).toMatchObject({ abandoned: true, ranked: [] })
    expect(match.seats.map((s) => [s.forfeited, s.won])).toEqual([[true, false], [true, false]])
    for (const device of ['device-alpha', 'device-bravo']) {
      expect(f.store.players([device]).get(device)).toMatchObject({ matches: 1, wins: 0, rating: 980 })
      expect(f.store.history(device, { queue: 'ranked', limit: 10 })[0]).toMatchObject({ outcome: 'forfeit', delta: -20, rating: 980 })
    }
  })

  it('keeps a departed human’s build and records their loss when the remaining player finishes', async () => {
    const f = fixture()
    const { room, a, b } = await f.battle()
    await f.advance(61_000)
    const fireball = f.state().pawns[0].slots.indexOf('fireball')
    f.state().pawns[0].levels[fireball] = 2
    await f.advance(20)
    a.close()
    f.state().pawns[0].levels[fireball] = 5
    await f.advance(20)
    f.win(1)
    await f.advance(4000)
    await vi.waitFor(() => expect(room.screen()).toBe('results'))
    expect(f.record).toHaveBeenCalledOnce()
    const history = f.store.history('device-alpha', { limit: 10 })[0]
    expect(history).toMatchObject({ outcome: 'forfeit', delta: -20 })
    expect(history.players.find((p) => p.player === 0)?.build?.levels[fireball]).toBe(2)
    expect(f.store.history('device-bravo', { limit: 10 })[0]).toMatchObject({ outcome: 'win', delta: 20 })
    expect(b.messages.some((m) => m.t === 'end' && m.result.winners.includes(1))).toBe(true)
    b.close()
  })

  it.each([59_000, 61_000])('applies the one-minute participation threshold after %i ms of combat', async (combatMs) => {
    const f = fixture()
    const { room, a, b } = await f.battle()
    await f.advance(combatMs)
    a.close(); b.close()
    await vi.waitFor(() => expect(f.core.room(room.code)).toBeNull())
    const counted = combatMs >= 60_000
    expect(f.store.players(['device-alpha']).has('device-alpha')).toBe(counted)
    expect(f.store.history('device-alpha', { limit: 10 })[0].outcome).toBe(counted ? 'forfeit' : 'loss')
  })

  it('preserves an authoritative victory when the last connection closes during the result linger', async () => {
    const f = fixture()
    const { room, a, b } = await f.battle()
    await f.advance(121_000)
    f.win(0)
    for (let n = 0; f.state().phase !== 'gameOver' && n < 250; n++) await f.advance(20)
    expect(f.state().phase).toBe('gameOver')
    expect(room.screen()).toBe('match') // End delivery deliberately lingers for 600 ms.
    a.close(); b.close()
    await vi.waitFor(() => expect(f.core.room(room.code)).toBeNull())
    expect(f.record).toHaveBeenCalledOnce()
    expect(f.record.mock.calls[0][0].match.abandoned).not.toBe(true)
    expect(f.store.history('device-alpha', { limit: 10 })[0]).toMatchObject({ outcome: 'win', delta: 20 })
    expect(f.store.history('device-bravo', { limit: 10 })[0]).toMatchObject({ outcome: 'loss', delta: -20 })
  })

  it('keeps an empty room and pending result until delayed persistence finishes, then commits once', async () => {
    const f = fixture(true)
    const { room, a, b } = await f.battle()
    await f.advance(61_000)
    const cachedAdmission = f.core.admit(`/ws?room=${room.code}`, 'cached-visitor', null)
    expect(cachedAdmission.kind).toBe('room')
    a.close(); b.close()
    expect(f.core.admit(`/ws?room=${room.code}`, 'fresh-visitor', null)).toMatchObject({ kind: 'message' })
    await expect(f.core.authorize(room.code, null)).rejects.toThrow('room is closing')
    const lateMessages: string[] = []
    f.core.attach(cachedAdmission, { send: (text) => lateMessages.push(text), close() {}, onText() {}, onClose() {} }, 'cached-visitor')
    expect(lateMessages.map(decode)).toContainEqual(expect.objectContaining({ t: 'error' }))
    expect(f.core.stats().players).toBe(0)
    expect(f.record).toHaveBeenCalledOnce()
    expect(f.core.maintenance().pendingResults).toBe(1)
    expect(f.core.room(room.code)).toBe(room)
    expect(f.store.history('device-alpha', { limit: 10 })).toEqual([])
    f.core.sweep()
    await f.advance(1000)
    expect(f.core.room(room.code)).toBe(room)
    expect(f.record).toHaveBeenCalledOnce()
    f.release()
    await vi.waitFor(() => expect(f.core.room(room.code)).toBeNull())
    expect(f.core.maintenance().pendingResults).toBe(0)
    expect(f.store.history('device-alpha', { limit: 10 })).toHaveLength(1)
    expect(f.store.players(['device-alpha']).get('device-alpha')?.matches).toBe(1)
  })
})
