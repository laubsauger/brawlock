import { describe, expect, it } from 'vitest'
import type { MatchSettings, PlayerSlot, SimState } from '../sim/types'
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  encodeSnap,
  sanitizeCommand,
  sanitizeFrames,
  sanitizeName,
  stateJsonWithoutEvents,
  type Msg,
} from './protocol'

const settings: MatchSettings = {
  teamMode: 'ffa',
  gameMode: 'rounds',
  winScore: 3,
  startGold: 30,
  roundGold: 10,
  killGold: 0,
  winGold: 0,
  lavaDps: 100,
  kbMultiplier: 1,
  dmgMultiplier: 1,
  friction: 0.96,
  shopSeconds: 30,
  botsReplaceLeavers: true,
}
const slots: PlayerSlot[] = [
  { id: 0, name: 'Host', color: 0xff0000, team: 0, kind: 'human' },
  { id: 1, name: 'Bot', color: 0x0000ff, team: 1, kind: 'bot', difficulty: 'easy' },
]

function fakeState(tick: number): SimState {
  return {
    tick,
    rng: 123456789,
    nextEntityId: 7,
    settings,
    slots,
    phase: 'fight',
    phaseTicksLeft: -1,
    round: 2,
    arena: { layer: 12, nextShrinkTick: 900, theme: 1 },
    scores: [],
    pawns: [],
    projectiles: [
      { id: 5, owner: 0, spell: 'fireball', x: 1.0000000000000002, y: -0.1, vx: 16.666, vy: 0, radius: 25, ticksLeft: 50, data: {} },
    ],
    obstacles: [],
    events: [{ type: 'projectileSpawn', id: 5, spell: 'fireball' }],
  }
}

describe('protocol', () => {
  it('round-trips every message type unchanged (JSON on both channels)', () => {
    const msgs: Msg[] = [
      { t: 'hello', name: 'Ann', version: PROTOCOL_VERSION, key: 'k', profileId: 'p-1234567', color: 0xff00ff },
      { t: 'welcome', playerId: 3 },
      { t: 'lobby', slots, settings, ready: { 1: true }, pings: { 0: 0, 1: 42 } },
      { t: 'ready', ready: true },
      { t: 'pings', pings: { 0: 0, 1: 42 } },
      { t: 'start', match: 1, seed: 0xdeadbeef, slots, settings, localPlayer: 1 },
      { t: 'input', match: 1, inputs: [{ seq: 1, tick: 10, cmds: [{ kind: 'move', x: 1.5, y: -2 }] }] },
      { t: 'snap', match: 1, n: 9, iv: 1, ack: 4, ev: [], state: fakeState(9) },
      { t: 'end', match: 1, result: { winners: [0], slots, scores: [], rounds: 3 } },
      { t: 'screen', screen: 'lobby' },
      { t: 'notice', text: 'hi' },
      { t: 'kick', reason: 'bye' },
      { t: 'leave' },
      { t: 'error', message: 'nope' },
    ]
    for (const m of msgs) expect(decode(encode(m))).toEqual(m)
  })

  it('shared-state snapshot encoding decodes to the same snapshot, events moved to ev', () => {
    const s = fakeState(42)
    const ev = [{ tick: 42, events: s.events }]
    const data = encodeSnap(1, 7, 2, 5, JSON.stringify(ev), stateJsonWithoutEvents(s))
    const m = decode(data)
    expect(m).toEqual({ t: 'snap', match: 1, n: 7, iv: 2, ack: 5, ev, state: { ...s, events: [] } })
    // floats survive exactly: the client sees bit-identical numbers
    expect(m?.t === 'snap' && m.state.projectiles[0].x).toBe(1.0000000000000002)
  })

  it('rejects garbage and unknown types instead of throwing', () => {
    expect(decode('')).toBeNull()
    expect(decode('{not json')).toBeNull()
    expect(decode('42')).toBeNull()
    expect(decode('{"t":"bogus"}')).toBeNull()
    expect(decode('#p123')).toBeNull()
  })
})

describe('client input validation (clients are untrusted)', () => {
  it('drops commands that would poison the sim', () => {
    expect(sanitizeCommand({ kind: 'move', x: 1, y: 2 })).toEqual({ kind: 'move', x: 1, y: 2 })
    expect(sanitizeCommand({ kind: 'move', x: null, y: 2 })).toBeNull() // NaN arrives as null in JSON
    expect(sanitizeCommand({ kind: 'move', x: 1e12, y: 2 })).toBeNull()
    expect(sanitizeCommand({ kind: 'cast', slot: 1.5, x: 0, y: 0 })).toBeNull()
    expect(sanitizeCommand({ kind: 'cast', slot: 99, x: 0, y: 0 })).toBeNull()
    expect(sanitizeCommand({ kind: 'buyMastery', mastery: 'everything' })).toBeNull()
    expect(sanitizeCommand({ kind: 'stop', extra: { nested: true } })).toBeNull()
    expect(sanitizeCommand('move')).toBeNull()
  })

  it('passes unknown but flat commands through, so new sim commands need no protocol change', () => {
    expect(sanitizeCommand({ kind: 'sellItem', slot: 6 })).toEqual({ kind: 'sellItem', slot: 6 })
  })

  it('orders frames by seq and drops malformed ones', () => {
    const f = sanitizeFrames([
      { seq: 3, tick: 1, cmds: [{ kind: 'stop' }] },
      { seq: 0, tick: 1, cmds: [] },
      { seq: 2, tick: 1, cmds: [{ kind: 'stop' }, { kind: 'move' }] },
      'junk',
    ])
    expect(f.map((x) => x.seq)).toEqual([2, 3])
    expect(f[0].cmds).toEqual([{ kind: 'stop' }])
  })

  it('cleans player names', () => {
    expect(sanitizeName('  Ann\u0000\u0007  ')).toBe('Ann')
    expect(sanitizeName('')).toBe('Warlock')
    expect(sanitizeName(5)).toBe('Warlock')
    expect(sanitizeName('x'.repeat(50))).toHaveLength(20)
  })
})
