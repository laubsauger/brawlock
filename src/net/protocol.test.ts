import { describe, expect, it } from 'vitest'
import type { InputCommand, MatchSettings, PlayerSlot, SimState } from '../sim/types'
import { DEFAULT_SETTINGS } from '../sim/config'
import { decodeCmd, encodeCmd } from './stream'
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  encodePlans,
  encodeSnap,
  encodeStreamPacket,
  sanitizeCommand,
  sanitizeFrames,
  sanitizeName,
  sanitizeSettingsPatch,
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
  spectatorBets: true,
  bounties: true,
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
    betting: { bets: [], bounties: [], credits: [], lastSettlement: null },
  }
}

describe('protocol', () => {
  it('carries fixed-stake spectator bets unchanged through validated inputs and confirmed stream commands', () => {
    const bet = { kind: 'spectateBet', round: 3, target: 9 }
    const frames = sanitizeFrames([{ seq: 1, tick: 120, cmds: [bet] }])
    expect(frames).toEqual([{ seq: 1, tick: 120, cmds: [bet] }])
    const wire = JSON.parse(JSON.stringify(encodeCmd(frames[0].cmds[0])))
    expect(decodeCmd(wire)).toEqual(bet)
    for (const malformed of [
      { kind: 'spectateBet', target: 1 },
      { kind: 'spectateBet', round: 3 },
      { ...bet, round: -1 },
      { ...bet, round: 1.5 },
      { ...bet, round: '3' },
      { ...bet, target: -1 },
      { ...bet, target: 1.5 },
      { ...bet, target: '9' },
      { ...bet, target: Infinity },
      { ...bet, stake: 10 },
      { ...bet, payout: 100 },
    ]) expect(sanitizeCommand(malformed)).toBeNull()
    expect(sanitizeCommand({ kind: 'spectateBet', round: 0, target: 0 })).toEqual({ kind: 'spectateBet', round: 0, target: 0 })
  })

  it('carries Fresh start bare: a client can never name its own refund', () => {
    const fresh = { kind: 'freshStart' }
    expect(sanitizeFrames([{ seq: 1, tick: 120, cmds: [fresh] }])).toEqual([{ seq: 1, tick: 120, cmds: [fresh] }])
    expect(decodeCmd(JSON.parse(JSON.stringify(encodeCmd(fresh as never))))).toEqual(fresh)
    expect(sanitizeCommand({ ...fresh, refund: 999 })).toBeNull()
    expect(sanitizeCommand({ ...fresh, gold: 999 })).toBeNull()
  })

  it('carries Shop Ready as a bare boolean: a client cannot send a timer or speak for another seat', () => {
    const ready = { kind: 'shopReady', ready: true }
    expect(sanitizeFrames([{ seq: 1, tick: 120, cmds: [ready] }])).toEqual([{ seq: 1, tick: 120, cmds: [ready] }])
    expect(decodeCmd(JSON.parse(JSON.stringify(encodeCmd(ready as never))))).toEqual(ready)
    expect(sanitizeCommand({ kind: 'shopReady', ready: false })).toEqual({ kind: 'shopReady', ready: false })
    for (const malformed of [{ kind: 'shopReady' }, { kind: 'shopReady', ready: 1 }, { kind: 'shopReady', ready: 'true' }, { ...ready, ticks: 90 }, { ...ready, player: 3 }])
      expect(sanitizeCommand(malformed)).toBeNull()
  })

  it('validates independent spectator-bet and bounty settings as booleans', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ spectatorBets: true, bounties: true })
    expect(sanitizeSettingsPatch({ spectatorBets: false, bounties: true }, DEFAULT_SETTINGS)).toEqual({ spectatorBets: false, bounties: true })
    expect(sanitizeSettingsPatch({ spectatorBets: true, bounties: false }, DEFAULT_SETTINGS)).toEqual({ spectatorBets: true, bounties: false })
    expect(sanitizeSettingsPatch({ spectatorBets: 'false', bounties: 1 }, DEFAULT_SETTINGS)).toEqual({})
  })

  it('round-trips every message type unchanged (JSON on both channels)', () => {
    const msgs: Msg[] = [
      { t: 'hello', name: 'Ann', version: PROTOCOL_VERSION, key: 'k', profileId: 'p-1234567', color: 0xff00ff },
      { t: 'rename', name: 'Ann again' },
      { t: 'welcome', playerId: 3, hz: 30 },
      { t: 'lobby', slots, settings, ready: { 1: true }, pings: { 0: 0, 1: 42 } },
      { t: 'ready', ready: true },
      { t: 'pings', pings: { 0: 0, 1: 42 } },
      { t: 'start', match: 1, seed: 0xdeadbeef, slots, settings, localPlayer: 1 },
      { t: 'input', match: 1, inputs: [{ seq: 1, tick: 10, cmds: [{ kind: 'move', x: 1.5, y: -2 }] }] },
      { t: 'snap', match: 1, n: 9, iv: 1, ack: 4, ev: [], state: fakeState(9) },
      { t: 'plan', m: 1, p: 1, n: 9, f: [[20, [{ kind: 'move', x: 1, y: -2 }, { kind: 'cast', slot: 0, x: 30, y: 40 }]]] },
      { t: 'plan', m: 1, p: 1, n: 21, f: [] },
      { t: 'plans', m: 1, plans: [{ p: 1, n: 9, f: [[20, [{ kind: 'move', x: 1, y: -2 }]]] }, { p: 2, n: 10, f: [] }] },
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
    expect(decode('{"t":"plans","m":1,"plans":[null]}')).toBeNull()
    expect(decode('{"t":"plan","m":1,"p":1,"n":0,"f":[[1,null]]}')).toBeNull()
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

describe('stream packets', () => {
  it('carry bot plans that decode to the same schedule as a plans message', () => {
    // Why: on lossless links the tick's bot plans ride the stream packet instead of their own
    // message; a client must predict the bots exactly as before.
    const plans = [
      { p: 3, n: 600, f: [[600, [{ kind: 'move' as const, x: 12.5, y: -40 }]], [611, [{ kind: 'cast' as const, slot: 0, x: 100, y: 25.25 }]]] as [number, InputCommand[]][] },
      { p: 7, n: 600, f: [] as [number, InputCommand[]][] },
    ]
    const packet = decode(encodeStreamPacket(4, 99, 12, '"to":601,"r":1', encodePlans(plans)))
    const message = decode(encode({ t: 'plans', m: 4, plans }))
    expect(packet).toMatchObject({ t: 'is', m: 4, n: 99, a: 12, to: 601, r: 1 })
    expect(packet && packet.t === 'is' && packet.p).toEqual(message && message.t === 'plans' && message.plans)
    expect(decode(encodeStreamPacket(4, 100, 12, '"to":602,"r":1'))).not.toHaveProperty('p')
    // a malformed plan is rejected like a malformed plans message
    expect(decode('{"t":"is","m":4,"n":1,"a":0,"to":2,"r":1,"p":[[1,"x",[]]]}')).toBeNull()
  })
})
