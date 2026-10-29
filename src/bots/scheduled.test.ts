import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, createMatch, step, ticks } from '../sim'
import type { BotDifficulty, PlayerInput, PlayerSlot } from '../sim/types'
import { isTileAt, TILE_SIZE } from '../sim/arena'
import { layerRadius, nearestTileCentre } from './arena'
import { BotController, reactionDelayBounds } from './controller'
import { makePawn, makeState } from './fixtures'

describe('bot scheduled decisions', () => {
  it('exposes an order before execution and releases exactly that order at its planned tick', () => {
    const state = makeState([makePawn(0, 0, 0), makePawn(1, 900, 0)])
    const bot = new BotController(0, 'hard', 1)
    expect(bot.think(state)).toEqual([])
    const [planned] = bot.scheduled()
    expect(planned.cmds.length).toBeGreaterThan(0)
    // one reaction delay after the decision at tick 0, as drawn for this preset (reactionDelayTicks)
    const [earliest, latest] = reactionDelayBounds(bot.params)
    expect(planned.at).toBeGreaterThanOrEqual(earliest)
    expect(planned.at).toBeLessThanOrEqual(latest)
    for (let tick = 1; tick < planned.at; tick++) {
      state.tick = tick
      expect(bot.think(state)).toEqual([])
    }
    state.tick = planned.at
    expect(bot.think(state)).toEqual(planned.cmds)
    expect(bot.scheduled().some((frame) => frame.at === planned.at)).toBe(false)
    // A retained schedule remains valid after the live queue releases the order.
    expect(planned.cmds.length).toBeGreaterThan(0)
  })

  it('does not let consumers mutate queued commands', () => {
    const state = makeState([makePawn(0, 0, 0), makePawn(1, 900, 0)])
    const bot = new BotController(0, 'hard', 1)
    bot.think(state)
    const [snapshot] = bot.scheduled()
    const original = structuredClone(snapshot)
    const command = snapshot.cmds[0]
    if (command.kind === 'move' || command.kind === 'cast') command.x = 99999
    snapshot.cmds.push({ kind: 'stop' })
    snapshot.at = 99999
    expect(bot.scheduled()[0]).toEqual(original)
  })

  it('clears old plans on rewind and game over', () => {
    const state = makeState([makePawn(0, 0, 0), makePawn(1, 900, 0)], { tick: 100 })
    const bot = new BotController(0, 'hard', 1)
    bot.think(state)
    expect(bot.scheduled()[0].at).toBeGreaterThan(100)
    state.tick = 0
    bot.think(state)
    expect(bot.scheduled().length).toBeGreaterThan(0)
    expect(bot.scheduled().every((frame) => frame.at < 100)).toBe(true)
    state.phase = 'gameOver'
    state.tick = 1
    bot.think(state)
    expect(bot.scheduled()).toEqual([])
  })

  it('changes scheduledVersion whenever the future changes other than by due orders leaving', () => {
    // The host skips re-reading a bot's plan while the version holds (session hostTick). If any
    // queue change slipped past the version, clients would predict a stale bot plan.
    const diffs: BotDifficulty[] = ['hard', 'brutal', 'medium', 'easy', 'uber', 'hard']
    const slots: PlayerSlot[] = diffs.map((d, id) => ({ id, name: `b${id}`, color: id, team: id, kind: 'bot', difficulty: d }))
    const state = createMatch({ ...DEFAULT_SETTINGS }, slots, 7)
    const bots = diffs.map((d, id) => new BotController(id, d, 7))
    const seen = bots.map((b) => ({ version: b.scheduledVersion, future: JSON.stringify(b.scheduled()) }))
    let changes = 0
    for (let i = 0; i < ticks(90); i++) {
      const inputs: PlayerInput[] = []
      for (const [k, b] of bots.entries()) {
        const cmds = b.think(state)
        if (cmds.length) inputs.push({ player: b.player, tick: state.tick, cmds })
        const future = JSON.stringify(b.scheduled())
        if (b.scheduledVersion === seen[k].version) {
          const kept = JSON.parse(seen[k].future).filter((f: { at: number }) => f.at > state.tick)
          expect(future).toBe(JSON.stringify(kept))
        } else changes++
        seen[k] = { version: b.scheduledVersion, future }
      }
      step(state, inputs)
    }
    // and it is not bumped every tick (that would only cost the skipped work again)
    expect(changes).toBeGreaterThan(50)
    expect(changes).toBeLessThan(ticks(90) * bots.length * 0.3)
  })
})

describe('nearest tile centre', () => {
  it('matches a full grid scan on empty, tiny, small, mid and full layers, ties included', () => {
    // brute force: the scan nearestTileCentre used before it kept per-layer tile lists
    const scan = (layer: number, x: number, y: number, interior: boolean) => {
      const n = Math.ceil(layerRadius(layer) / TILE_SIZE)
      let best: { x: number; y: number } | null = null
      let bestD = Infinity
      for (let gx = -n; gx <= n; gx++) {
        for (let gy = -n; gy <= n; gy++) {
          if (!isTileAt(layer, gx, gy)) continue
          let d = (gx * TILE_SIZE - x) ** 2 + (gy * TILE_SIZE - y) ** 2
          const inner = isTileAt(layer, gx + 1, gy) && isTileAt(layer, gx - 1, gy) && isTileAt(layer, gx, gy + 1) && isTileAt(layer, gx, gy - 1)
          if (interior && !inner) d += (TILE_SIZE * 1.5) ** 2
          if (d < bestD) {
            bestD = d
            best = { x: gx * TILE_SIZE, y: gy * TILE_SIZE }
          }
        }
      }
      return best
    }
    // layer 1 has no tiles, 2 only the centre one, 21 is the largest
    const mismatches: string[] = []
    for (const layer of [1, 2, 6, 11, 21]) {
      // x on tile centres and exactly between them (equal distances); y also off the grid
      for (let x = -2400; x <= 2400; x += 96) {
        for (let y = -2400; y <= 2400; y += 336) {
          for (const interior of [true, false]) {
            const got = nearestTileCentre(layer, x, y, interior)
            const want = scan(layer, x, y, interior)
            if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`layer ${layer} (${x}, ${y}) interior ${interior}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`)
          }
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})
