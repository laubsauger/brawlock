import { gunzipBase64, gzipBase64, removeDir, tempDir, writeTestFile } from '../../server/test-dir.mjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DAILY_CLOSE_MS, DAILY_EMBERS, DAILY_RANKED_ATTEMPTS, DAILY_STREAK_EMBERS, DAILY_TOKEN_MS, openDaily, streakOf } from '../../server/daily.mjs'
import { createVerifierPool } from '../../server/daily-verifier.mjs'
import { BotController } from '../bots/controller'
import { DAY_MS, LAUNCH_DAY, defineDay } from '../game/daily/calendar'
import { DAILY_HZ, DailyRun } from '../game/daily/run'
import { TapeRecorder } from '../game/daily/tape'
import { verify } from '../game/daily/verify'
import { dailyReplay } from '../game/daily/watch'
import { ReplayPlayer } from '../game/replay/player'
import { ticks } from '../sim/config'
import { setTickRate, TICK_HZ, type TickRate } from '../sim/types'

/**
 * The daily board (docs/moonshot/specs/daily.md): a score counts only when the server's own
 * replay of the tape gives it; attempts are capped and expire; the board lists named accounts;
 * the day's Embers come once, for showing up, more on every seventh day of a streak.
 */
const ORIGIN = 'https://brawlock.test'
let rate: TickRate
beforeEach(() => {
  rate = TICK_HZ
  setTickRate(DAILY_HZ)
})
afterEach(() => setTickRate(rate))

/** A Hard bot plays seat 0 for `seconds` under the issued salt: the tape the client would send. */
function play(day: number, salt: number, seconds: number, idle = false) {
  const run = new DailyRun(defineDay(day), salt, { name: 'you', color: 0xff7700 })
  const me = new BotController(0, 'hard', 99)
  const tape = new TapeRecorder(day, 'test')
  while (!run.ended && run.state.tick < ticks(seconds)) {
    const cmds = idle ? [] : me.think(run.state)
    tape.record(run.state.tick, cmds)
    run.tick(cmds)
  }
  const abandoned = !run.ended
  if (abandoned) run.abandon()
  const t = tape.finish(run.state.tick, abandoned)
  return { b64: gzipBase64(JSON.stringify(t)), result: run.result(), seconds: run.state.tick / DAILY_HZ }
}

function setup(opts: { verifierIds?: string[] } = {}) {
  let clock = (LAUNCH_DAY + 10) * DAY_MS + 9 * 3600_000
  const sessions = new Map<string, { id: string; profile: { name: string; color: null } | null }>([
    ['ash', { id: 'acc-ash', profile: { name: 'Ash', color: null } }],
    ['moss', { id: 'acc-moss', profile: { name: 'Moss', color: null } }],
    ['nameless', { id: 'acc-nameless', profile: null }],
  ])
  const paid: [string, number, number][] = []
  const credited = new Set<string>()
  const daily = openDaily(':memory:', {
    origin: ORIGIN,
    speaker: async (request) => sessions.get(request.headers.get('cookie') ?? '') ?? null,
    names: (ids) => new Map(ids.map((id) => [id, [...sessions.values()].find((s) => s.id === id)?.profile?.name ?? null])),
    reward: (id, day, base) => {
      const key = `${id}:${day}`
      const duplicate = credited.has(key)
      if (!duplicate) {
        credited.add(key)
        paid.push([id, day, base])
      }
      return { duplicate, reward: { base, balance: 0 } }
    },
    verifier: { ids: () => opts.verifierIds ?? ['test'], run: async (_id, input) => verify(input) },
    now: () => clock,
  })
  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const res = await daily.handler(new Request(ORIGIN + path, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-brawlock-client-ip': '203.0.113.9', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, body: await res.json() as Record<string, any> }
  }
  const today = () => Math.floor(clock / DAY_MS)
  /** a token, a run under its salt, real time passing, the submission */
  const attemptAndSubmit = async (device: string, cookie?: string, seconds = 40, idle = false) => {
    const a = await call('POST', '/api/daily/attempt', { day: today(), dailyId: 'test', device }, cookie)
    if (a.status !== 201) return { attempt: a, submit: null, run: null }
    const run = play(today(), a.body.salt, seconds, idle)
    clock += Math.ceil(run.seconds * 1000) + 500
    const submit = await call('POST', '/api/daily/submit', { attempt: a.body.attempt, tape: run.b64, device, claimed: { waves: run.result.waves, time: run.result.timeTicks } }, cookie)
    clock += 21_000
    return { attempt: a, submit, run }
  }
  return { daily, call, attemptAndSubmit, paid, today, advance: (ms: number) => (clock += ms), set: (ms: number) => (clock = ms), get clock() { return clock } }
}

describe('daily board on the account service', () => {
  it('verifies the tape itself: the server score is the replay, and a resubmit returns it; another tape is refused', async () => {
    const d = setup()
    const { attempt, submit, run } = await attemptAndSubmit(d, 'device-ash-0001', 'ash')
    expect(submit!.status).toBe(200)
    expect([submit!.body.waves, submit!.body.time]).toEqual([run!.result.waves, run!.result.timeTicks])
    expect(submit!.body).toMatchObject({ status: 'verified', rank: 1, players: 1, listed: true })
    const again = await d.call('POST', '/api/daily/submit', { attempt: attempt.body.attempt, tape: run!.b64, device: 'device-ash-0001' }, 'ash')
    expect(again.body.waves).toBe(submit!.body.waves)
    const other = play(d.today(), 1, 5)
    expect((await d.call('POST', '/api/daily/submit', { attempt: attempt.body.attempt, tape: other.b64, device: 'device-ash-0001' }, 'ash')).status).toBe(409)
  })

  /** Why: Watch on the board replays a top-ten run from the tape the service hands out, with the client's own daily code. */
  it('hands out a top-ten run to Watch, which replays to its board score; other runs stay private', async () => {
    const d = setup()
    const { attempt, submit, run } = await attemptAndSubmit(d, 'device-ash-0003', 'ash', 60)
    expect(submit!.status).toBe(200)
    const got = await d.call('GET', `/api/daily/run/${attempt.body.attempt}`)
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ day: d.today(), dailyId: 'test', salt: attempt.body.salt })
    const replay = dailyReplay({ day: got.body.day, salt: got.body.salt, tape: JSON.parse(gunzipBase64(got.body.tape)), id: attempt.body.attempt, date: 0, netId: 'n', player: { name: 'Ash', color: 0 } })!
    const p = new ReplayPlayer(replay, 'n')
    while (!p.done) p.stepOnce()
    expect(p.desync).toBeNull()
    expect(p.state.tick).toBe(run!.result.endTick)
    expect((await d.call('GET', '/api/daily/run/nope')).status).toBe(400)
    expect((await d.call('GET', `/api/daily/run/${'a'.repeat(attempt.body.attempt.length)}`)).status).toBe(404)
  })

  /** Why: flags never reject a run, so the operator reviews them; a hidden run leaves the boards and Watch. The numbers are the spec's keep-or-cut measure. */
  it('lists flagged runs for the operator, hides and shows them, and counts the day', async () => {
    const d = setup()
    const a = await d.call('POST', '/api/daily/attempt', { day: d.today(), dailyId: 'test', device: 'device-flag-001' }, 'ash')
    const run = play(d.today(), a.body.salt, 40)
    d.advance(Math.ceil(run.seconds * 1000) + 500)
    // a claimed score that differs is flagged, never refused
    const submit = await d.call('POST', '/api/daily/submit', { attempt: a.body.attempt, tape: run.b64, device: 'device-flag-001', claimed: { waves: 5, time: 1 } }, 'ash')
    expect(submit.status).toBe(200)
    const admin = async (method: string, body?: unknown) => {
      const res = await d.daily.admin(new Request(ORIGIN + '/api/admin/daily', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))
      return { status: res.status, body: await res.json() as Record<string, any> }
    }
    const list = await admin('GET')
    expect(list.body.runs).toMatchObject([{ attempt: a.body.attempt, name: 'Ash', flags: ['claim differs'], hidden: false }])
    expect(list.body.days[0]).toMatchObject({ day: d.today(), players: 1, attemptsPerPlayer: 1, back1: null })
    expect((await admin('POST', { action: 'hide', attempt: a.body.attempt })).status).toBe(200)
    expect((await d.call('GET', '/api/daily?device=device-flag-001')).body.board.rows).toEqual([])
    expect((await d.call('GET', `/api/daily/run/${a.body.attempt}`)).status).toBe(404)
    expect((await admin('GET')).body.runs[0].hidden).toBe(true)
    expect((await admin('POST', { action: 'show', attempt: a.body.attempt })).status).toBe(200)
    expect((await d.call('GET', '/api/daily?device=device-flag-001')).body.board.rows).toHaveLength(1)
    expect((await admin('POST', { action: 'hide', attempt: 'f'.repeat(32) })).status).toBe(404)
    expect((await admin('POST', { action: 'delete', attempt: a.body.attempt })).status).toBe(400)
  })

  it('caps ranked attempts per day, limits the token rate, and refuses an unknown build', async () => {
    const d = setup()
    const take = () => d.call('POST', '/api/daily/attempt', { day: d.today(), dailyId: 'test', device: 'device-cap-0001' })
    expect((await take()).status).toBe(201)
    expect((await take()).body.code).toBe('rate')
    for (let i = 1; i < DAILY_RANKED_ATTEMPTS; i++) {
      d.advance(21_000)
      expect((await take()).status, `attempt ${i + 1}`).toBe(201)
    }
    d.advance(21_000)
    expect((await take()).body.code).toBe('cap')
    expect((await d.call('POST', '/api/daily/attempt', { day: d.today(), dailyId: 'old-build', device: 'device-x-0001' })).body.code).toBe('update')
    expect((await d.call('POST', '/api/daily/attempt', { day: d.today() - 1, dailyId: 'test', device: 'device-x-0001' })).body.code).toBe('day')
  })

  it('refuses runs faster than real time, expired tokens and closed days', async () => {
    const d = setup()
    const a = await d.call('POST', '/api/daily/attempt', { day: d.today(), dailyId: 'test', device: 'device-fast-001' })
    const run = play(d.today(), a.body.salt, 30)
    const fast = await d.call('POST', '/api/daily/submit', { attempt: a.body.attempt, tape: run.b64, device: 'device-fast-001' })
    expect([fast.status, fast.body.code]).toEqual([422, 'too fast'])

    d.advance(21_000)
    const b = await d.call('POST', '/api/daily/attempt', { day: d.today(), dailyId: 'test', device: 'device-late-001' })
    d.advance(DAILY_TOKEN_MS + 1000)
    const late = await d.call('POST', '/api/daily/submit', { attempt: b.body.attempt, tape: play(d.today(), b.body.salt, 5).b64, device: 'device-late-001' })
    expect([late.status, late.body.code]).toEqual([410, 'expired'])

    const day = d.today()
    d.set((day + 1) * DAY_MS - 60_000)
    const c = await d.call('POST', '/api/daily/attempt', { day, dailyId: 'test', device: 'device-close-01' })
    d.set((day + 1) * DAY_MS + DAILY_CLOSE_MS + 1000)
    const closed = await d.call('POST', '/api/daily/submit', { attempt: c.body.attempt, tape: play(day, c.body.salt, 5).b64, device: 'device-close-01' })
    expect([closed.status, closed.body.code]).toEqual([410, 'closed'])
  })

  it('a guest gets a rank but no row; signing in claims the run once, and only named accounts are listed', async () => {
    const d = setup()
    await attemptAndSubmit(d, 'device-moss-001', 'moss', 20)
    const guest = await attemptAndSubmit(d, 'device-guest-01', undefined, 40)
    expect(guest.submit!.body).toMatchObject({ listed: false })
    expect(guest.submit!.body.rank).toBeGreaterThanOrEqual(1)
    const board = async () => (await d.call('GET', `/api/daily?view=best&device=device-guest-01`)).body.board
    expect((await board()).rows.map((r: { name: string }) => r.name)).toEqual(['Moss'])
    const claim = () => d.call('POST', '/api/daily/claim', { attempt: guest.attempt.body.attempt, device: 'device-guest-01' }, 'ash')
    expect((await claim()).body.claimed).toBe(true)
    expect((await board()).rows.map((r: { name: string }) => r.name).sort()).toEqual(['Ash', 'Moss'])
    expect((await claim()).body.claimed).toBe(true)
    expect((await d.call('POST', '/api/daily/claim', { attempt: guest.attempt.body.attempt, device: 'device-guest-01' }, 'moss')).status).toBe(409)
    // an account without a player name plays as a guest and is never listed
    const nameless = await attemptAndSubmit(d, 'device-nameless', 'nameless', 10)
    expect(nameless.submit!.body.listed).toBe(false)
  })

  it('pays the day once per account, 75 on the seventh day of a streak, nothing for guests or idle runs', async () => {
    const d = setup()
    await attemptAndSubmit(d, 'device-guest-02', undefined, 60)
    await attemptAndSubmit(d, 'device-moss-002', 'moss', 60, true)
    expect(d.paid).toEqual([])
    for (let day = 0; day < 7; day++) {
      // the stand-in never presses Ready: 15 s of shop per wave, then enough fighting to earn the
      // day. Salts are random: in 60 s a quick wave clear left under 30 s of fighting about one run
      // in four (a flaky day); in 75 s every one of 280 seeded runs qualified
      await attemptAndSubmit(d, 'device-ash-0002', 'ash', 90)
      await attemptAndSubmit(d, 'device-ash-0002', 'ash', 90)
      d.set((d.today() + 1) * DAY_MS + 9 * 3600_000)
    }
    expect(d.paid.map(([, , base]) => base)).toEqual([...Array(6).fill(DAILY_EMBERS), DAILY_STREAK_EMBERS])
  })

  it('the real verifier pool runs a build bundle in a worker; a build it lacks is an update', async () => {
    const dir = tempDir('daily-verifiers-')
    try {
      const { dailyBundle } = await import('../../scripts/daily-id.mjs')
      const { id, code } = dailyBundle('.')
      writeTestFile(dir, `${id}.mjs`, code)
      const pool = createVerifierPool(dir, { timeoutMs: 20_000 })
      expect(pool.ids()).toEqual([id])
      const day = LAUNCH_DAY + 3
      const run = play(day, 5, 20)
      const tape = JSON.parse(gunzipBase64(run.b64))
      const out = await pool.run(id, { day, salt: 5, tape }) as { ok: boolean; waves: number; timeTicks: number }
      expect(out).toMatchObject({ ok: true, waves: run.result.waves, timeTicks: run.result.timeTicks })
      expect(await pool.run('000000000000', { day, salt: 5, tape })).toBeNull()
    } finally {
      removeDir(dir)
    }
  }, 30_000)
})

describe('daily streaks', () => {
  const days = (...d: number[]) => new Set(d)
  const up = () => false
  it('counts consecutive days, forgives one miss a week, and resets on a second miss inside it', () => {
    expect(streakOf(days(1, 2, 3, 4), up, 4, 0).count).toBe(4)
    // today not played yet does not break it
    expect(streakOf(days(1, 2, 3), up, 4, 0).count).toBe(3)
    expect(streakOf(days(1, 2, 4, 5), up, 5, 0)).toEqual({ count: 4, smoulder: true })
    expect(streakOf(days(1, 2, 4, 5, 7), up, 7, 0).count).toBe(1)
    expect(streakOf(days(1, 2, 4, 5, 6, 7, 8, 9, 10, 12), up, 12, 0).count).toBe(10)
  })

  it('days the service issued no tokens never break a streak', () => {
    expect(streakOf(days(1, 2, 5, 6), (d) => d === 3 || d === 4, 6, 0)).toEqual({ count: 4, smoulder: false })
  })
})

async function attemptAndSubmit(d: ReturnType<typeof setup>, device: string, cookie: string | undefined, seconds = 40, idle = false) {
  return d.attemptAndSubmit(device, cookie, seconds, idle)
}
