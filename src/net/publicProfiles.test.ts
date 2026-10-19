import { afterEach, describe, expect, it } from 'vitest'
import { startServer, type DedicatedServer } from '../../server/listen.mjs'
import { openLeaderboard } from '../../server/leaderboard-store.mjs'
import { remoteRatingAuthority } from '../../server/rating-client.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'
import { createMatch, DEFAULT_SETTINGS, step, type PlayerInput, type PlayerSlot } from '../sim'
import { ServerMatchTracker, type FinishedMatch, type PublicBoardRow } from './leaderboard'
import { localRatingAuthority, validRatingSubmission, type RatingSubmission } from './ratingAuthority'
import { Online, type ServerProfile } from './online'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const slots: PlayerSlot[] = [
  { id: 0, name: 'Same name', kind: 'human', team: 0, color: 0xff6600, profileId: 'private-local-profile-0' },
  { id: 1, name: 'Same name', kind: 'human', team: 1, color: 0x0088ff, profileId: 'private-local-profile-1' },
  { id: 2, name: 'Practice bot', kind: 'bot', team: 2, color: 0x88cc00 },
]
const devices = { 0: 'private-device-0000', 1: 'private-device-1111' }
let fixture: FinishedMatch | null = null

/** A real five-round sim, with a reflected bot shot, three intentional misses,
 * upgrades, seven direct hits and two lava losses. No handcrafted counters. */
function playedMatch(): FinishedMatch {
  if (fixture) return structuredClone(fixture)
  const settings = { ...DEFAULT_SETTINGS, rankedRounds: 5 as const, shopSeconds: 0, startGold: 100, kbMultiplier: 0 }
  const state = createMatch(settings, slots, 42)
  let finished: FinishedMatch | null = null
  const tracker = new ServerMatchTracker((m) => { finished = m })
  tracker.start({ slots, settings, devices })
  tracker.observe(state, [])
  let placed = 0
  let opening = false
  let misses = 0
  for (let tick = 0; tick < 10000 && state.phase !== 'gameOver'; tick++) {
    const inputs: PlayerInput[] = []
    if (tick === 0) inputs.push({ player: 0, tick, cmds: [{ kind: 'buyItem', item: 'fireball' }, { kind: 'buySpell', spell: 'shield' }] })
    if (state.phase === 'fight') {
      if (placed !== state.round) {
        placed = state.round
        state.obstacles = []
        state.arena.nextShrinkTick = -1
        for (const pawn of state.pawns) {
          pawn.x = pawn.owner === 1 ? 280 : 0
          pawn.y = pawn.owner === 2 ? 280 : 0
          pawn.invulnerable = false
          pawn.modifiers = []
          pawn.hpRegen = 0 // Practice targets do not heal during the deliberate misses.
          if (pawn.owner !== 0 || state.round % 2 === 0) pawn.hp = 1
        }
      }
      const caster = state.pawns[0]
      const fireball = caster.slots.indexOf('fireball')
      const cast = (slot: number, x: number, y: number): PlayerInput => ({ player: 0, tick, cmds: [{ kind: 'cast', slot, x, y }] })
      if (state.round === 1 && !opening) {
        inputs.push(cast(caster.slots.indexOf('shield'), caster.x, caster.y),
          { player: 2, tick, cmds: [{ kind: 'cast', slot: fireball, x: caster.x, y: caster.y }] })
        opening = true
      } else if (state.round % 2 === 0 && !state.pawns[2].alive) {
        if (caster.alive && !caster.moveTarget) inputs.push({ player: 0, tick, cmds: [{ kind: 'move', x: 0, y: -3000 }] })
      } else if (state.round !== 1 || !state.pawns[2].alive) {
        if (caster.cooldowns[fireball] === 0 && !caster.cast) {
          if (state.round === 1 && misses < 3) {
            inputs.push(cast(fireball, 0, -1000))
            misses++
          } else {
            const target = state.pawns[2].alive ? state.pawns[2] : state.pawns[1]
            if (target.alive) inputs.push(cast(fireball, target.x, target.y))
          }
        }
      }
    }
    step(state, inputs)
    tracker.observe(state, state.events)
  }
  expect(state.phase).toBe('gameOver')
  expect(state.round).toBe(5)
  tracker.finish({ winners: [0], slots, scores: state.scores, rounds: state.round, ticks: state.tick })
  fixture = finished!
  expect(fixture.seats[0].stats?.shieldReflects).toBe(1)
  expect(fixture.seats[0].stats?.spells.fireball).toEqual([10, 7])
  expect(fixture.seats[0].stats?.topSpell).toEqual(['fireball', 2])
  expect(fixture.seats[0].stats?.goldSpent).toBeGreaterThan(0)
  return structuredClone(fixture)
}

const submission = (key = 'public-detail-match-0001'): RatingSubmission => ({ key, region: 'eu', room: 'ABCDE', at: 100_000, minSeconds: 1, match: playedMatch() })
const dirs: string[] = []
const servers: DedicatedServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const dir of dirs.splice(0)) removeDir(dir)
})
const directory = () => { const dir = tempDir('brawlock-public-profile-'); dirs.push(dir); return dir }

describe('authoritative public detailed profiles', () => {
  it('persists actual tracked stats once, preserves them through reopen and combines delayed regions', async () => {
    const file = `${directory()}/leaderboard.sqlite`
    let store = openLeaderboard(file)
    let authority = localRatingAuthority(store, { minSeconds: 1, clock: () => 100_000 })
    const request = submission()
    expect(validRatingSubmission(request)).toBe(true)
    expect(await authority.record(request)).toEqual({ status: 'rated' })
    const board = (await authority.read('/leaderboard')).body as { entries: PublicBoardRow[] }
    const row = board.entries.find((p) => p.tag === store.players([devices[0]]).get(devices[0])!.tag)!
    expect(row.publicId).toMatch(UUID)
    expect(board.entries[1].publicId).not.toBe(row.publicId)
    const read = async () => (await authority.read(`/profiles/${row.publicId}`)).body as ServerProfile & { found: boolean }
    const profile = await read()
    expect(profile).toMatchObject({ found: true, publicId: row.publicId, matches: 1, kills: 3,
      coverage: { detailedMatches: 1, totalMatches: 1, firstDetailedAt: request.at, lastDetailedAt: request.at } })
    expect(profile.detail).toMatchObject({ matches: 1, damage: request.match.seats[0].stats!.damageDealt,
      seconds: Math.round(request.match.ticks / 60), spells: { fireball: [10, 7], shield: [1, 0] },
      totals: { goldSpent: request.match.seats[0].stats!.goldSpent, shieldReflects: 1, killsByCause: { fireball: 8 } },
      hallOfFame: { mostKills: { value: 8, date: request.at, matchId: '1' }, bestAccuracy: { value: 0.7 } } })
    expect(JSON.stringify(profile)).not.toMatch(/private-device|private-local-profile|public-detail-match/)
    expect(await authority.record(structuredClone(request))).toEqual({ status: 'rated' })
    expect(await read()).toEqual(profile)
    const conflict = structuredClone(request)
    conflict.match.seats[0].stats!.goldSpent++
    await expect(authority.record(conflict)).rejects.toThrow('idempotency key conflicts')
    expect(await read()).toEqual(profile)
    authority.close!()
    store = openLeaderboard(file)
    authority = localRatingAuthority(store, { minSeconds: 1, clock: () => 100_000 })
    expect(await read()).toEqual(profile)
    expect(await authority.record(request)).toEqual({ status: 'rated' })
    expect(await read()).toEqual(profile)
    const delayed = { ...submission('public-detail-delayed-0001'), at: 90_000, region: 'us-west' }
    await authority.record(delayed)
    const combined = await read()
    expect(combined.coverage).toEqual({ detailedMatches: 2, totalMatches: 2, firstDetailedAt: 90_000, lastDetailedAt: 100_000 })
    expect(combined.detail!.spells.fireball).toEqual([20, 14])
    expect(combined.detail!.totals.goldSpent).toBe(2 * profile.detail!.totals.goldSpent)
    expect(combined.detail!.hallOfFame.mostKills).toMatchObject({ value: 8, date: 90_000, matchId: '2' })
    authority.close!()
  })

  it('omits incomplete human control and late joins, while preserving their basic rated results', () => {
    const settings = { ...DEFAULT_SETTINGS, rankedRounds: 5 as const }
    const state = createMatch(settings, slots, 42)
    let result: FinishedMatch | null = null
    const tracker = new ServerMatchTracker((m) => { result = m })
    tracker.start({ slots, settings, devices })
    tracker.observe(state, [])
    tracker.control(0, 'bot')
    tracker.control(0, 'human')
    const joined = { ...slots[2], kind: 'human' as const }
    state.slots[2] = joined
    tracker.join(joined, 'private-device-2222')
    tracker.observe(state, [{ type: 'roundWin', players: [0], team: 0 }])
    tracker.finish({ winners: [0], slots: state.slots, scores: state.scores, rounds: 1, ticks: 600 })
    const seats = (result as unknown as FinishedMatch).seats
    expect(seats.find((s) => s.player === 0)).toMatchObject({ won: true, roundsPlayed: 1 })
    expect(seats.find((s) => s.player === 0)).not.toHaveProperty('stats')
    expect(seats.find((s) => s.player === 2)).not.toHaveProperty('stats')
    expect(seats.find((s) => s.player === 1)?.stats).toBeDefined()
    // A fresh match does not inherit the previous coverage exclusions.
    tracker.start({ slots, settings, devices })
    tracker.observe(state, [])
    tracker.finish({ winners: [0], slots, scores: state.scores, rounds: 1, ticks: 600 })
    expect((result as unknown as FinishedMatch).seats[0].stats).toBeDefined()
  })

  it('rejects malformed/oversized optional detail while accepting legacy submissions without it', () => {
    const request = submission()
    const mutate = (patch: Record<string, unknown>) => ({ ...request, match: { ...request.match,
      seats: [{ ...request.match.seats[0], stats: { ...request.match.seats[0].stats, ...patch } }, request.match.seats[1]],
    } })
    for (const patch of [{ walked: Infinity }, { damageDealt: -1 }, { goldSpent: '7' }, { extra: 1 },
      { aliveSec: request.match.ticks + 1 }, { spells: { fireball: [1, 2] } }, { spells: { unknown: [1, 0] } },
      { killsByCause: { '<script>': 1 } }, { deathsByCause: Array(100).fill(1) }, { topSpell: ['private-player-id', 7] }, { topSpell: ['fireball', 8] }]) {
      expect(validRatingSubmission(mutate(patch))).toBe(false)
    }
    const legacy = structuredClone(request)
    for (const seat of legacy.match.seats) delete seat.stats
    expect(validRatingSubmission(legacy)).toBe(true)
  })

  it('upgrades the raw legacy schema without changing original rows and keeps opaque IDs across reopens', async () => {
    const file = `${directory()}/legacy.sqlite`
    const original = openTestDatabase(file)
    original.exec(`CREATE TABLE matches (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, region TEXT NOT NULL, room TEXT NOT NULL, ticks INTEGER NOT NULL, rounds INTEGER NOT NULL, humans INTEGER NOT NULL, bots INTEGER NOT NULL);
      CREATE TABLE results (match_id INTEGER NOT NULL REFERENCES matches(id), device TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL, region TEXT NOT NULL, won INTEGER NOT NULL, rounds_played INTEGER NOT NULL, rounds_won INTEGER NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, delta REAL NOT NULL, rating REAL NOT NULL, PRIMARY KEY(match_id, device));
      CREATE TABLE players (device TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT NOT NULL, rating REAL NOT NULL, matches INTEGER NOT NULL, wins INTEGER NOT NULL, rounds_played INTEGER NOT NULL, rounds_won INTEGER NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);
      INSERT INTO matches VALUES(1, 1000, 'us-west', 'ABCDE', 9000, 1, 2, 0);
      INSERT INTO players VALUES('legacy-device-000', 'Same', 'abcde', 1100, 1, 1, 1, 1, 2, 0, 1000, 1000), ('legacy-device-111', 'Same', 'abcde', 900, 1, 0, 1, 0, 0, 2, 1000, 1000);
      INSERT INTO results VALUES(1, 'legacy-device-000', 'Same', 1000, 'us-west', 1, 1, 1, 2, 0, 100, 1100);`)
    const snapshot = () => ['players', 'matches', 'results'].map((name) => ({ schema: original.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name), rows: original.prepare(`SELECT * FROM ${name}`).all() }))
    const before = snapshot()
    let publicIds: string[] = []
    for (let reopen = 0; reopen < 2; reopen++) {
      const authority = localRatingAuthority(openLeaderboard(file), { minSeconds: 1 })
      const board = (await authority.read('/leaderboard')).body as { entries: PublicBoardRow[] }
      const ids = board.entries.map((row) => row.publicId)
      expect(ids).toHaveLength(2)
      expect(ids.every((id) => UUID.test(id))).toBe(true)
      expect(new Set(ids).size).toBe(2) // Same name and colliding short tag do not merge identities.
      if (reopen === 0) publicIds = ids
      else expect(ids).toEqual(publicIds)
      const profile = (await authority.read(`/profiles/${ids[0]}`)).body as ServerProfile
      expect(profile).toMatchObject({ rating: 1100, matches: 1, kills: 2, detail: null,
        coverage: { totalMatches: 1, detailedMatches: 0, firstDetailedAt: null, lastDetailedAt: null } })
      expect(snapshot()).toEqual(before)
      authority.close!()
    }
    original.close()
  })

  it('forwards public profiles through the shared authority and delivers a legacy queued match', async () => {
    const token = crypto.randomUUID() + crypto.randomUUID()
    const us = await startServer({ port: 0, build: 'dev-public-profiles', dataDir: directory(), ratingAuthorityToken: token,
      config: { leaderboardMinSeconds: 1 }, log: () => {} })
    servers.push(us)
    const usHttp = `http://127.0.0.1:${us.port}`
    const outboxFile = `${directory()}/old-outbox.sqlite`
    const old = { ...submission('old-queued-public-match'), at: 90_000 }
    for (const seat of old.match.seats) delete seat.stats
    const db = openTestDatabase(outboxFile)
    db.exec('CREATE TABLE rating_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, op TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT)')
    db.prepare('INSERT INTO rating_outbox(key,op,payload) VALUES(?,?,?)').run(old.key, 'record', JSON.stringify(old))
    db.close()
    const outbox = remoteRatingAuthority({ url: usHttp, token, file: outboxFile, allowInsecureForTests: true, log: () => {} })
    try {
      expect((await outbox.flush()).get(old.key)).toEqual({ status: 'rated' })
      expect(outbox.pending()).toBe(0)
      expect(await outbox.record(submission())).toEqual({ status: 'rated' })
      expect(await outbox.record(submission())).toEqual({ status: 'rated' })
      const eu = await startServer({ port: 0, build: 'dev-public-profiles', dataDir: directory(), ratingAuthorityUrl: usHttp,
        ratingAuthorityToken: token, ratingAuthorityAllowInsecureForTests: true, config: { leaderboardMinSeconds: 1 }, log: () => {} })
      servers.push(eu)
      const euHttp = `http://127.0.0.1:${eu.port}`
      const board = await (await fetch(`${usHttp}/leaderboard`)).json() as { entries: PublicBoardRow[] }
      expect(await (await fetch(`${euHttp}/leaderboard`)).json()).toEqual(board)
      const id = board.entries[0].publicId
      const profile = await (await fetch(`${usHttp}/profiles/${id}`)).json() as ServerProfile
      expect(profile.coverage).toMatchObject({ totalMatches: 2, detailedMatches: 1 })
      expect(profile.detail!.spells.fireball).toEqual([10, 7])
      expect(await (await fetch(`${euHttp}/profiles/${id}`)).json()).toEqual(profile)
      const online = new Online({ regions: [{ id: 'eu', label: 'Europe', url: `ws://127.0.0.1:${eu.port}` }], build: 'dev-public-profiles' })
      expect(await online.publicProfile('eu', id)).toMatchObject({ publicId: id, detail: profile.detail, coverage: profile.coverage })
      expect((await fetch(`${euHttp}/profiles/${devices[0]}`)).status).toBe(400)
      expect((await fetch(`${euHttp}/profiles/${board.entries[0].tag}`)).status).toBe(400)
      expect((await fetch(`${euHttp}/profiles/%E0%A4`)).status).toBe(400)
      expect(await (await fetch(`${euHttp}/profiles/${crypto.randomUUID()}`)).json()).toEqual({ found: false })
      expect(JSON.stringify(profile)).not.toMatch(/private-device|private-local-profile/)
    } finally { outbox.close!() }
  })
})
