import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimEvent } from '../sim/types'
import { audio } from './index'
import { AudioEngine, VOICES, busGains } from './engine'
import { HANDLED_EVENTS, IGNORED_EVENTS, PROJECTILE_SOUNDS, SPELL_SOUNDS, flightPath, kbIntensity, newCueMemory, planEvents, spatial } from './events'
import { PROJECTILE_BEHAVIORS, SPELL_BEHAVIORS } from '../sim/spells'
import { MusicLayer } from './music'
import { announcements, matchAnnouncer } from '../game/announcer'
import { AmbienceLayer, edgeProximity } from './ambience'
import { isLocationSafeAtLayer } from '../sim'
import { createSynth, RECIPES, Voice, type SfxId } from './synth'
import { HYBRID } from './hybrid'
import { AUDIO_ASSETS, AUDIO_CREDITS } from './assets'
import { asContext, MockAudioContext } from './mockContext'
import { MockMedia, mockVisibility } from './mockMedia'

beforeEach(() => {
  MockMedia.instances.length = 0
  vi.stubGlobal('Audio', MockMedia)
  vi.stubGlobal('document', mockVisibility())
})
afterEach(() => vi.unstubAllGlobals())

/** One sample of every SimEvent type. The mapped type makes this fail to compile when a type is added. */
const SAMPLES: { [K in SimEvent['type']]: Extract<SimEvent, { type: K }> } = {
  cast: { type: 'cast', pawn: 1, spell: 'fireball', x: 500, y: 0 },
  castStart: { type: 'castStart', pawn: 1, spell: 'scourge', ticks: 54, level: 3 },
  projectileSpawn: { type: 'projectileSpawn', id: 9, spell: 'fireball' },
  projectileHit: { type: 'projectileHit', id: 9, spell: 'fireball', x: 300, y: 0, target: 2 },
  projectileExpire: { type: 'projectileExpire', id: 9, spell: 'fireball', x: 900, y: 0 },
  damage: { type: 'damage', target: 2, amount: 70, source: 0, x: 300, y: 0, kb: 750 },
  heal: { type: 'heal', target: 1, amount: 10, x: 0, y: 0 },
  teleport: { type: 'teleport', pawn: 1, fromX: 0, fromY: 0, toX: 700, toY: 0 },
  explosion: { type: 'explosion', x: 0, y: 0, radius: 250, spell: 'scourge' },
  death: { type: 'death', pawn: 2, owner: 1, killer: 0 },
  obstacleDestroyed: { type: 'obstacleDestroyed', id: 40, x: 100, y: 100 },
  arenaShrink: { type: 'arenaShrink', layer: 14 },
  phase: { type: 'phase', phase: 'fight', round: 1 },
  roundWin: { type: 'roundWin', team: 0, players: [0] },
  gameOver: { type: 'gameOver', winners: [0] },
  beam: { type: 'beam', spell: 'lightning', owner: 0, fromX: 0, fromY: 0, toX: 600, toY: 0, target: 2, blocked: false },
  shieldReflect: { type: 'shieldReflect', pawn: 2, projectile: 9, x: 300, y: 0, reflected: true, stolen: true },
  swap: { type: 'swap', spell: 'swap', pawn: 1, other: 2, fromX: 0, fromY: 0, toX: 300, toY: 0 },
  modifier: { type: 'modifier', pawn: 2, id: 'shieldBubble', on: true, source: 1 },
  spellHit: { type: 'spellHit', spell: 'thrust', pawn: 1, target: 2, x: 280, y: 0 },
  projectileBounce: { type: 'projectileBounce', id: 9, spell: 'boomerang', x: 300, y: 0 },
  cooldownReset: { type: 'cooldownReset', pawn: 1, slot: 2, spell: 'recharge' },
  streak: { type: 'streak', pawn: 1, spell: 'recharge', value: 3 },
  castCancel: { type: 'castCancel', pawn: 2, spell: 'fireball', slot: 6, started: true },
  respawn: { type: 'respawn', pawn: 2, owner: 1, x: 900, y: 0 },
  purchase: { type: 'purchase', player: 0, pawn: 1, kind: 'spell', id: 'teleport', level: 1 },
}

const LISTENER = {
  x: 0,
  y: 0,
  halfWidth: 1000,
  localPlayer: 0,
  state: {
    pawns: [
      { id: 1, owner: 0, x: 0, y: 0 },
      { id: 2, owner: 1, x: 300, y: 0 },
    ] as never,
    projectiles: [{ id: 9, owner: 1, spell: 'fireball', x: 900, y: 0, vx: -1000, vy: 0, radius: 25, ticksLeft: 60, data: {} }],
  },
}

describe('audio: event mapping', () => {
  it('every SimEvent type either makes a sound or is ignored on purpose', () => {
    for (const type of Object.keys(SAMPLES) as SimEvent['type'][]) {
      const cues = planEvents([SAMPLES[type]], LISTENER)
      const ignored = type in IGNORED_EVENTS
      expect(ignored !== HANDLED_EVENTS.includes(type), `${type}: handled xor ignored`).toBe(true)
      if (ignored) expect(cues, type).toEqual([])
      else expect(cues.length, `${type} should make a sound`).toBeGreaterThan(0)
    }
  })

  it('every cue maps to a recipe and a voice budget', () => {
    const all = planEvents(Object.values(SAMPLES), LISTENER)
    for (const c of all) {
      if (c.id === null) continue
      expect(RECIPES[c.id], c.id).toBeTypeOf('function')
      expect(VOICES[c.id].max, c.id).toBeGreaterThan(0)
    }
    for (const id of Object.keys(RECIPES) as SfxId[]) expect(VOICES[id], id).toBeDefined()
  })

  it('pans by side and fades with distance, without going silent for nearby fights', () => {
    const l = { x: 0, y: 0, halfWidth: 1000 }
    expect(spatial(800, 0, l).pan).toBeGreaterThan(0.3)
    expect(spatial(-800, 0, l).pan).toBeLessThan(-0.3)
    expect(spatial(0, 0, l).gain).toBe(1)
    expect(spatial(3000, 0, l).gain).toBeLessThan(spatial(900, 0, l).gain)
    expect(spatial(900, 0, l).gain).toBeGreaterThan(0.6)
  })

  it('a harder knockback sounds bigger', () => {
    const soft = planEvents([{ ...SAMPLES.damage, kb: 300 }], LISTENER)[0]
    const hard = planEvents([{ ...SAMPLES.damage, kb: 2000 }], LISTENER)[0]
    expect(hard.param!).toBeGreaterThan(soft.param!)
    expect(kbIntensity(750)).toBeGreaterThan(0.5)
  })

  it('centers and emphasizes your own confirmed knockout even with the camera far away', () => {
    const event: SimEvent = { ...SAMPLES.death, owner: 0, x: 3000, y: 0 }
    const own = planEvents([event], LISTENER)[0]
    const other = planEvents([{ ...event, owner: 1 }], LISTENER)[0]
    expect(own).toMatchObject({ id: 'death', pan: 0, gain: 1.15, stopKey: 'windup:2' })
    expect(other.pan).toBeGreaterThan(0)
    expect(other.gain).toBeLessThan(own.gain)
  })

  it('a disconnect fades quietly instead of playing a knockout impact', () => {
    const cues = planEvents([{ ...SAMPLES.death, owner: 0, cause: 'disconnect' }], LISTENER)
    expect(cues).toHaveLength(1)
    expect(cues[0]).toMatchObject({ id: 'fade', stopKey: 'windup:2' })
    expect(cues[0].gain).toBeLessThan(1)
  })

  it('settles an exact bounty with two centered coins only for its collector, at fixed cost', () => {
    const death: SimEvent = { ...SAMPLES.death, killer: 0, bountyGold: 1 }
    const collect = planEvents([death], LISTENER)
    expect(collect.map((c) => c.id)).toEqual(['death', 'uiBuy', 'streakTick'])
    expect(collect.slice(1)).toMatchObject([{ pan: 0, delay: 0.13 }, { pan: 0, delay: 0.24 }])
    expect(planEvents([{ ...death, bountyGold: 1000 }], LISTENER)).toEqual(collect)
    for (const listener of [{ ...LISTENER, localPlayer: 1 }, { ...LISTENER, localPlayer: -1 }]) {
      expect(planEvents([death], listener).map((c) => c.id)).toEqual(['death'])
    }
    for (const bountyGold of [undefined, 0]) {
      expect(planEvents([{ ...death, bountyGold }], LISTENER).map((c) => c.id)).toEqual(['death'])
    }
    expect(planEvents([{ ...death, cause: 'disconnect' }], LISTENER).map((c) => c.id)).toEqual(['fade'])
  })

  it('confirms a reflected ownership reversal privately, without rewarding mere blocks', () => {
    const reversal: SimEvent = { ...SAMPLES.shieldReflect, pawn: 1 }
    expect(planEvents([reversal], LISTENER).map((c) => c.id)).toEqual(['reflect', 'streakTick'])
    expect(planEvents([{ ...reversal, pawn: 2 }], LISTENER).map((c) => c.id)).toEqual(['reflect'])
    for (const flags of [{ stolen: false }, { reflected: false }]) {
      expect(planEvents([{ ...reversal, ...flags }], LISTENER).map((c) => c.id)).toEqual(['reflect'])
    }
  })

  it('lava burn is only audible for the local pawn', () => {
    const lava = (target: number): SimEvent => ({ type: 'damage', target, amount: 25, source: null, x: 0, y: 0, kb: 0 })
    expect(planEvents([lava(1)], LISTENER).map((c) => c.id)).toEqual(['lavaSizzle'])
    expect(planEvents([lava(2)], LISTENER)).toEqual([])
    // without localPlayer the listener (centred on the local pawn) decides
    const bare = { x: 300, y: 0, halfWidth: 1000 }
    const at = (x: number): SimEvent => ({ type: 'damage', target: 7, amount: 25, source: null, x, y: 0, kb: 0 })
    expect(planEvents([at(310)], bare).map((c) => c.id)).toEqual(['lavaSizzle'])
    expect(planEvents([at(-600)], bare)).toEqual([])
  })

  it('places id-only events at the pawn when state is given', () => {
    const cast = planEvents([{ type: 'cast', pawn: 2, spell: 'fireball', x: -900, y: 0 }], { ...LISTENER, x: 0 })
    expect(cast[0].pan).toBeGreaterThan(0) // caster at x=300, not the target point at -900
  })

  it('purchases chime for the local player only: new buys, upgrades and masteries differ', () => {
    const buy = (player: number, kind: 'spell' | 'item' | 'mastery', level: number): SimEvent => ({
      type: 'purchase',
      player,
      pawn: player === 0 ? 1 : 2,
      kind,
      id: 'x',
      level,
    })
    expect(planEvents([buy(0, 'spell', 1)], LISTENER).map((c) => c.id)).toEqual(['buyNew'])
    expect(planEvents([buy(0, 'item', 3)], LISTENER).map((c) => c.id)).toEqual(['buyUpgrade'])
    expect(planEvents([buy(0, 'mastery', 2)], LISTENER).map((c) => c.id)).toEqual(['buyMastery'])
    // the opponent's shopping is private
    expect(planEvents([buy(1, 'spell', 1)], LISTENER)).toEqual([])
    // and louder than a UI tick
    expect(planEvents([buy(0, 'spell', 1)], LISTENER)[0].gain).toBeGreaterThan(1)
  })

  it('a fake cast reads to the opponent: windup inhale, then a snuff that cuts it', () => {
    const start = planEvents([{ type: 'castStart', pawn: 2, spell: 'fireball', ticks: 12 }], LISTENER)
    expect(start.map((c) => c.id)).toEqual(['castInhale'])
    const cancel = planEvents([SAMPLES.castCancel], LISTENER)
    expect(cancel.map((c) => c.id)).toEqual(['castSnuff'])
    expect(cancel[0].stopKey).toBe(start[0].key)
    // the enemy's cancel is audible at their position, not only for the local player
    expect(cancel[0].pan).toBeGreaterThan(0)
    // Scourge's long charge is cut the same way
    const scourge = planEvents([SAMPLES.castStart], LISTENER)[0]
    const cut = planEvents([{ type: 'castCancel', pawn: 1, spell: 'scourge', slot: 7, started: true }], LISTENER)[0]
    expect(cut.stopKey).toBe(scourge.key)
  })

  it("an opponent's Scourge charge is a faint cue, the caster hears the full windup", () => {
    // the original played no sound until the blast: the charge must not warn enemies like a siren
    // pawn 1 belongs to player 0 in LISTENER
    const as = (localPlayer: number) => ({ ...LISTENER, localPlayer })
    const mine = planEvents([{ ...SAMPLES.castStart, pawn: 1 }], as(0))[0]
    const theirs = planEvents([{ ...SAMPLES.castStart, pawn: 1 }], as(1))[0]
    expect(theirs.gain).toBeLessThan(mine.gain * 0.3)
    expect(theirs.gain).toBeGreaterThan(0)
  })

  it('the ambience slider moves only the lava bed, not effects or music', () => {
    // players turn the lava bed down without losing spell sounds; unset keeps the old calibration
    const base = busGains({ master: 1, sfx: 1, music: 1, muted: false })
    const quiet = busGains({ master: 1, sfx: 1, music: 1, ambience: 0, muted: false })
    expect(base.amb).toBe(base.sfx)
    expect(quiet.amb).toBe(0)
    expect(quiet.sfx).toBe(base.sfx)
    expect(quiet.music).toBe(base.music)
  })

  it('Scourge escalates with level: the starting-kit L1 is modest, the full blast is reserved for L3', () => {
    // everyone casts L1 Scourge every round; at full volume it drowns out the rest of the fight
    const windup = (level: number) => planEvents([{ ...SAMPLES.castStart, level }], LISTENER)[0]
    const blast = (level: number) => planEvents([{ ...SAMPLES.explosion, level }], LISTENER)[0]
    expect(windup(1).gain).toBeLessThan(windup(2).gain)
    expect(windup(2).gain).toBeLessThan(windup(3).gain)
    expect(blast(1).gain).toBeLessThan(blast(3).gain)
    // the recipe also gets the level, so L1 is a lighter sound, not only a quieter one
    expect([blast(1).param, blast(3).param]).toEqual([1, 3])
    // an event without a level (never sent by the sim) falls back to the modest L1
    expect(planEvents([{ ...SAMPLES.explosion, level: undefined }], LISTENER)[0].gain).toBe(blast(1).gain)
  })

  it('a fireball in flight is heard along its path, swoops as it passes, and stops on impact', () => {
    const [loop] = planEvents([SAMPLES.projectileSpawn], LISTENER)
    expect(loop.id).toBe('fireballTravel')
    expect(loop.param).toBeCloseTo(1) // 60 ticks of flight
    const path = loop.path!
    // flies from the right (x=900) across the listener at x=0 to the left
    expect(path[0].pan).toBeGreaterThan(0.3)
    expect(path.at(-1)!.pan).toBeLessThan(-0.05)
    // approaching sounds higher, receding lower (Doppler)
    expect(path[0].rate).toBeGreaterThan(1.05)
    expect(path.at(-1)!.rate).toBeLessThan(0.97)
    // the hit cuts the loop
    expect(planEvents([SAMPLES.projectileHit], LISTENER)[0].stopKey).toBe(loop.key)
    expect(planEvents([SAMPLES.projectileExpire], LISTENER)[0].stopKey).toBe(loop.key)
    // without state there is no flight to follow: only cast and impact are heard
    expect(planEvents([SAMPLES.projectileSpawn], { x: 0, y: 0, halfWidth: 1000 })).toEqual([])
    // a shot moving away from the listener only falls in pitch
    expect(flightPath(0, 0, 1000, 0, 0.5, { x: 0, y: 0, halfWidth: 1000 }).every((p) => p.rate <= 1)).toBe(true)
  })

  it('every spell the sim can cast has a designed sound set, every projectile a flight sound', () => {
    for (const spell of Object.keys(SPELL_BEHAVIORS)) {
      expect(SPELL_SOUNDS[spell], `${spell} has no cast sound decision`).toBeDefined()
    }
    for (const kind of Object.keys(PROJECTILE_BEHAVIORS)) {
      expect(PROJECTILE_SOUNDS[kind]?.travel, `${kind} projectile has no travel loop`).toBeDefined()
      expect(PROJECTILE_SOUNDS[kind]?.hit, `${kind} projectile has no hit decision`).not.toBeUndefined()
    }
  })

  it('return orbs hum on the way back and chime when absorbed, instead of thudding', () => {
    const memory = newCueMemory()
    const orbState = {
      ...LISTENER,
      state: {
        ...LISTENER.state,
        projectiles: [{ id: 33, owner: 0, spell: 'drain', kind: 'drainHeal', x: 300, y: 0, vx: -500, vy: 0, radius: 0, ticksLeft: 120, data: {} }],
      },
    }
    const [loop] = planEvents([{ type: 'projectileSpawn', id: 33, spell: 'drain' }], orbState, memory)
    expect(loop.id).toBe('orbTravel')
    const [absorb] = planEvents([{ type: 'projectileHit', id: 33, spell: 'drain', x: 0, y: 0, target: 1 }], orbState, memory)
    expect(absorb.id).toBe('orbAbsorb')
    expect(absorb.stopKey).toBe(loop.key)
    // a Drain bolt (moving) hitting an enemy is a wet hit, not a chime
    const bolt = { ...orbState, state: { ...orbState.state, projectiles: [{ ...orbState.state.projectiles[0], id: 34, kind: undefined, vx: 700 }] } }
    planEvents([{ type: 'projectileSpawn', id: 34, spell: 'drain' }], bolt, memory)
    expect(planEvents([{ type: 'projectileHit', id: 34, spell: 'drain', x: 300, y: 0, target: 2 }], bolt, memory)[0].id).toBe('drainHit')
  })

  it('Lightning detonating a Fireball is one big electric blast, not two explosions', () => {
    const cues = planEvents(
      [
        { type: 'projectileHit', id: 9, spell: 'fireball', x: 300, y: 0, target: null },
        { type: 'explosion', x: 300, y: 0, radius: 225, spell: 'lightning' },
      ],
      LISTENER,
    )
    expect(cues.filter((c) => c.id === 'explosion')).toHaveLength(1)
    expect(cues.some((c) => c.id === 'zapHit')).toBe(true)
  })

  it('a Link tether hums for as long as it holds and is cut when it breaks', () => {
    const on = planEvents([{ type: 'modifier', pawn: 2, id: 'link', on: true, source: 1 }], LISTENER)
    expect(on.map((c) => c.id)).toEqual(['linkLoop'])
    const off = planEvents([{ type: 'modifier', pawn: 2, id: 'link', on: false, source: 1 }], LISTENER)
    expect(off[0].stopKey).toBe(on[0].key)
  })

  it('one fireball blast plays once even if the sim emits hit and explosion', () => {
    const cues = planEvents(
      [
        { type: 'projectileHit', id: 9, spell: 'fireball', x: 300, y: 0, target: 2 },
        { type: 'explosion', x: 300, y: 0, radius: 225, spell: 'fireball' },
      ],
      LISTENER,
    )
    expect(cues.filter((c) => c.id === 'explosion')).toHaveLength(1)
  })
})

describe('audio: no AudioContext (node, old browsers)', () => {
  it('every API call is a safe no-op', () => {
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined()
    expect(() => {
      audio.setVolumes({ master: 1, sfx: 1, music: 1, muted: false })
      audio.music('menu')
      audio.unlock()
      audio.playEvents(Object.values(SAMPLES), LISTENER)
      audio.ui('click')
      audio.ui('fight')
      audio.music('fight')
      audio.music('none')
      audio.test()
      audio.setMode('synth')
      audio.setMode('hybrid')
    }).not.toThrow()
  })
})

describe('audio: synthesis against a strict WebAudio mock', () => {
  afterEach(() => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext
    vi.useRealTimers()
  })

  it('every recipe schedules valid automation and stops every source it starts', () => {
    for (const id of Object.keys(RECIPES) as SfxId[]) {
      for (const p of [0, 0.3, 1, 1.6]) {
        const m = new MockAudioContext()
        const s = createSynth(asContext(m))
        const out = m.createGain()
        const v = new Voice(s, out as never, 0.01)
        RECIPES[id](v, p)
        expect(v.stopAt, id).toBeGreaterThan(0.01)
        expect(m.leakingSources(), `${id} leaks sources`).toEqual([])
        expect(m.sources().length, `${id} makes sound`).toBeGreaterThan(0)
        for (const src of m.sources()) expect(src.stopped!, id).toBeLessThanOrEqual(v.stopAt)
      }
    }
  })

  it.each([
    { id: 'hit', param: 0.7, sources: 6, nodes: 20 },
    { id: 'hit', param: 1.3, sources: 8, nodes: 28 },
    { id: 'scourgeWindup', param: 0.9, sources: 5, nodes: 16 },
    { id: 'scourgeBlast', param: 3, sources: 10, nodes: 30 },
    { id: 'death', param: 1, sources: 14, nodes: 38 },
  ] as const)('$id keeps its body within the reduced audio-node budget', ({ id, param, sources, nodes }) => {
    const m = new MockAudioContext()
    const synth = createSynth(asContext(m))
    const out = m.createGain()
    const before = m.nodes.length
    const voice = new Voice(synth, out as never, 0.01)
    RECIPES[id](voice, param)
    expect(m.sources().length).toBeLessThanOrEqual(sources)
    expect(m.nodes.length - before).toBeLessThanOrEqual(nodes)
    expect(m.leakingSources()).toEqual([])
  })

  it('homing propulsion stays in warm bands with amplitude pulses instead of a high pitch drone', () => {
    const m = new MockAudioContext()
    const synth = createSynth(asContext(m))
    const out = m.createGain()
    const before = m.nodes.length
    const voice = new Voice(synth, out as never, 0.01, 0)
    RECIPES.homingTravel(voice, 2)
    const nodes = m.nodes.slice(before)
    const oscillators = nodes.filter((n) => n.kind === 'osc') as ReturnType<MockAudioContext['createOscillator']>[]
    const audible = oscillators.filter((n) => n.frequency.value >= 20)
    expect(audible).toHaveLength(1)
    expect(audible[0].frequency.value).toBeGreaterThanOrEqual(150)
    expect(audible[0].frequency.value).toBeLessThanOrEqual(350)
    expect(audible[0].type).toBe('triangle')
    expect(audible[0].frequency.inputs).toHaveLength(0) // No persistent vibrato / FM whine.
    const filters = nodes.filter((n) => n.kind === 'biquad') as ReturnType<MockAudioContext['createBiquadFilter']>[]
    expect(filters).toHaveLength(1)
    expect(filters[0].frequency.value).toBeLessThanOrEqual(900)
    expect(filters[0].Q.value).toBeLessThanOrEqual(1) // Air, not a narrow resonant whistle.
    const lfo = oscillators.find((n) => n.frequency.value < 20)!
    expect(lfo.frequency.value).toBeGreaterThanOrEqual(3)
    expect(lfo.frequency.value).toBeLessThanOrEqual(8)
    const depth = lfo.outputs[0] as ReturnType<MockAudioContext['createGain']>
    const modulated = nodes.find((n) => n.kind === 'gain' &&
      (n as ReturnType<MockAudioContext['createGain']>).gain.inputs.includes(depth)) as ReturnType<MockAudioContext['createGain']>
    expect(modulated).toBeDefined()
    expect(modulated.gain.value - depth.gain.value).toBeGreaterThan(0)
    expect(modulated.gain.value + depth.gain.value).toBeLessThanOrEqual(1)
    expect(voice.buffers[0].node.buffer).toBe(synth.banks.pink)
    expect(nodes.length).toBeLessThanOrEqual(9)
    expect(m.sources()).toHaveLength(3)
    expect(m.leakingSources()).toEqual([])
    expect(voice.stopAt).toBeCloseTo(2.01)
    // The shared travel envelope still fades in and out for the full requested flight.
    const envelope = nodes[0] as ReturnType<MockAudioContext['createGain']>
    expect(envelope.gain.calls.find((c) => c.fn === 'linearRamp' && c.v === 1)?.t).toBeCloseTo(0.06)
    expect(envelope.gain.calls.at(-1)?.v).toBe(0.001)
    expect(envelope.gain.calls.at(-1)?.t).toBeCloseTo(voice.stopAt)
  })

  it('engine: unlock builds the graph, voices are limited, mute silences', () => {
    vi.useFakeTimers()
    ;(globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext
    const e = new AudioEngine()
    const contexts = MockAudioContext.instances.length
    e.playEvents([SAMPLES.cast], LISTENER) // before unlock: nothing
    e.music('menu')
    expect(MockAudioContext.instances.length).toBe(contexts)
    e.unlock()
    const m = MockAudioContext.instances.at(-1)!
    expect(e.ready).toBe(true)
    const before = m.sources().length
    // 20 hits in one tick: the voice budget caps them
    const hits = Array.from({ length: 20 }, (_, i) => ({ ...SAMPLES.damage, x: i * 10 }))
    e.playEvents(hits, LISTENER)
    const thuds = m.nodes.filter((n) => n.kind === 'panner').length
    expect(thuds).toBeLessThanOrEqual(VOICES.hit.max)
    expect(m.sources().length).toBeGreaterThan(before)
    // a cancelled windup fades its own voice out
    e.playEvents([SAMPLES.castStart], LISTENER)
    const keyedOut = m.nodes
      .filter((n) => n.kind === 'gain')
      .map((n) => n as unknown as { gain: { value: number; calls: { fn: string; v: number }[] } })
      .find((n) => n.gain.value > 0.69 && n.gain.value < 0.71) // scourgeWindup level 0.7 x gain 1
    expect(keyedOut).toBeDefined()
    e.playEvents([{ type: 'castCancel', pawn: 1, spell: 'scourge', slot: 7, started: true }], LISTENER)
    expect(keyedOut!.gain.calls.some((c) => c.fn === 'setTarget' && c.v === 0)).toBe(true)
    // a travel loop follows its projectile when it turns (a later call with the new heading)
    e.playEvents([SAMPLES.projectileSpawn], LISTENER)
    const pans = m.nodes.filter((n) => n.kind === 'panner') as unknown as { pan: { calls: { fn: string; v: number }[] } }[]
    const loopPan = pans.at(-1)!
    const panCalls = loopPan.pan.calls.length
    const turned = { ...LISTENER, state: { ...LISTENER.state, projectiles: [{ ...LISTENER.state.projectiles[0], x: 0, y: 0, vx: 1000, vy: 0 }] } }
    e.playEvents([], turned)
    const after = loopPan.pan.calls.slice(panCalls)
    expect(after.length).toBeGreaterThan(2)
    expect(after.at(-1)!.v).toBeGreaterThan(0.2) // now heading right
    // and stops when the projectile is gone without an event we saw
    e.playEvents([], { ...LISTENER, state: { ...LISTENER.state, projectiles: [] } })
    e.setVolumes({ master: 1, sfx: 1, music: 1, muted: true })
    const muted = m.sources().length
    e.playEvents([SAMPLES.explosion], LISTENER)
    expect(m.sources().length).toBe(muted)
    // music requested before unlock is playing; switching it off releases the layer and
    // the lookahead scheduler stops itself once the fade is over
    for (let i = 0; i < 20; i++) {
      m.currentTime += 0.05
      vi.advanceTimersByTime(50)
    }
    e.music('none')
    m.currentTime += 3
    vi.advanceTimersByTime(100)
    expect(m.leakingSources()).toEqual([])
    vi.runAllTimers() // only one-shot cleanups remain: would abort if the interval survived
  })

  it('cues issued right after unlock, while the context is resuming, are played once it runs', async () => {
    vi.useFakeTimers()
    class Suspended extends MockAudioContext {
      constructor() {
        super()
        this.state = 'suspended'
      }
    }
    ;(globalThis as { AudioContext?: unknown }).AudioContext = Suspended
    const e = new AudioEngine()
    e.music('menu') // the menu screen asks for music before any gesture
    e.unlock()
    e.ui('uiReady') // the splash "ready" chime, same gesture
    const m = MockAudioContext.instances.at(-1)!
    const before = m.sources().length
    expect(m.state).toBe('suspended') // still resuming: nothing may have played yet
    for (let i = 0; i < 4; i++) await Promise.resolve() // resume() settles, queue flushes
    expect(m.state).toBe('running')
    expect(m.sources().length).toBeGreaterThan(before)
    // The prepared menu song streams through one media source, alongside lava ambience.
    expect(m.nodes.filter((n) => n.kind === 'media')).toHaveLength(1)
    expect(MockMedia.instances.at(-1)!.paused).toBe(false)
    e.music('none')
    m.currentTime += 3
    vi.advanceTimersByTime(200)
    vi.runAllTimers()
  })

  it('test() unlocks and plays an audible reference through the SFX path', () => {
    vi.useFakeTimers()
    ;(globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext
    const e = new AudioEngine()
    e.test()
    const m = MockAudioContext.instances.at(-1)!
    expect(e.ready).toBe(true)
    expect(m.sources().length).toBeGreaterThan(10)
    vi.runAllTimers()
  })

  it('music crossfades: the old layer is released and stops its drone', () => {
    vi.useFakeTimers()
    const m = new MockAudioContext()
    const s = createSynth(asContext(m))
    const bus = m.createGain()
    const menu = new MusicLayer(s, bus as never, 'menu')
    menu.schedule(5)
    const fight = new MusicLayer(s, bus as never, 'fight')
    fight.setIntensity(1)
    fight.schedule(5)
    menu.release(1.6)
    // every menu source is stopped; only the fight layer's bed keeps running, within the
    // CPU budget of 12 continuous oscillators per layer (drone, pad, two LFOs)
    const running = m.leakingSources()
    expect(running.length).toBeGreaterThan(0)
    expect(running.length).toBeLessThanOrEqual(12)
    vi.runAllTimers()
  })
})

describe('audio: lava ambience', () => {
  afterEach(() => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext
    vi.useRealTimers()
  })

  it('edge proximity: 1 on lava, 0 in the middle, rising and pointing at the lava near the edge', () => {
    const safe = (x: number, y: number) => isLocationSafeAtLayer(15, x, y) // radius 1400
    expect(edgeProximity(2000, 0, safe).proximity).toBe(1)
    expect(edgeProximity(0, 0, safe).proximity).toBe(0)
    // tiles reach x = 1440 at this layer: 40 units from the lava
    const near = edgeProximity(1400, 0, safe)
    expect(near.proximity).toBeGreaterThan(0.5)
    expect(near.pan).toBeGreaterThan(0.5) // lava to the right
    expect(edgeProximity(-1400, 0, safe).pan).toBeLessThan(-0.5)
    // further in, quieter
    expect(edgeProximity(1300, 0, safe).proximity).toBeLessThan(near.proximity)
  })

  it('the bed follows the music: menu bed, then the match bed, then silence with every source stopped', () => {
    vi.useFakeTimers()
    ;(globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext
    const e = new AudioEngine()
    e.unlock()
    const m = MockAudioContext.instances.at(-1)!
    e.music('menu')
    const menuSources = m.leakingSources().length
    e.music('fight')
    expect(m.leakingSources().length).toBeGreaterThan(menuSources) // match bed adds the edge layer
    e.music('none')
    m.currentTime += 4
    vi.advanceTimersByTime(200)
    expect(m.leakingSources()).toEqual([])
    vi.runAllTimers()
  })

  it('the edge sizzle swells as the local pawn nears the lava and stays silent in the middle', () => {
    const m = new MockAudioContext()
    const s = createSynth(asContext(m))
    const amb = new AmbienceLayer(s, m.createGain() as never, 'match')
    amb.setEdge(0, 0)
    amb.setEdge(0.8, 0.6)
    const targets = m.nodes
      .filter((n) => n.kind === 'gain')
      .flatMap((n) => (n as unknown as { gain: { calls: { fn: string; v: number }[] } }).gain.calls)
      .filter((c) => c.fn === 'setTarget')
    expect(targets.some((c) => c.v === 0)).toBe(true)
    expect(targets.some((c) => Math.abs(c.v - 0.64 * 1.8) < 1e-9)).toBe(true) // 0.8^2 x edge boost
    amb.schedule(5) // bubbles schedule cleanly
    amb.release(1)
    expect(m.leakingSources()).toEqual([])
  })
})

describe('audio: recordings (hybrid mode)', () => {
  afterEach(() => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('every asset a hybrid layer uses ships as Opus and AAC, and every shipped file is credited (CC0, or generated for the announcer)', async () => {
    // node's fs without node typings in the app tsconfig
    const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
      existsSync(p: URL): boolean
      readdirSync(p: URL): string[]
      statSync(p: URL): { size: number; isDirectory(): boolean }
    }
    const dir = new URL('../../public/audio/', import.meta.url)
    const file = (name: string) => new URL(name, dir)
    for (const def of Object.values(HYBRID)) {
      for (const layer of def!.layers) {
        for (const id of layer.assets) {
          expect(AUDIO_ASSETS[id], id).toBeDefined()
          expect(fs.existsSync(file(`${id}.ogg`)), `${id}.ogg`).toBe(true)
          expect(fs.existsSync(file(`${id}.m4a`)), `${id}.m4a`).toBe(true)
        }
      }
    }
    for (const [id, a] of Object.entries(AUDIO_ASSETS)) {
      const credit = AUDIO_CREDITS[a.credit]
      expect(credit, `${id} has no credit`).toBeDefined()
      // the only non-CC0 class: the announcer, generated with ElevenLabs on the user's account;
      // every downloaded recording stays CC0, and no recording may claim the generated class
      if (id.startsWith('announcer/')) expect(credit.license, id).toBe('ElevenLabs')
      else expect(credit.license, id).toBe('CC0')
      expect(fs.existsSync(file(`${id}.ogg`)), `${id}.ogg`).toBe(true)
      expect(fs.existsSync(file(`${id}.m4a`)), `${id}.m4a`).toBe(true)
      expect(credit.creator.length, id).toBeGreaterThan(0)
      expect(credit.url, id).toMatch(/^https:\/\//)
    }
    // Effects/voices stay small; streamed songs have a separate budget.
    let bytes = 0
    for (const f of fs.readdirSync(dir)) {
      if (f === 'music') continue
      const st = fs.statSync(file(f))
      if (st.isDirectory()) for (const g of fs.readdirSync(file(`${f}/`))) bytes += fs.statSync(file(`${f}/${g}`)).size
      else bytes += st.size
    }
    expect(bytes).toBeLessThan(6e6)
  })

  it('plays pure synth until samples load, then layers recordings; synth mode turns them off', async () => {
    vi.useFakeTimers()
    ;(globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext
    vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    const e = new AudioEngine()
    e.unlock()
    const m = MockAudioContext.instances.at(-1)!
    const decoded = () => m.sources().filter((n) => (n as unknown as { buffer?: { length: number } }).buffer?.length === Math.floor(m.sampleRate * 0.5))
    const fire = { id: 'fireballCast' as const, gain: 1, pan: 0 }
    e.play(fire)
    expect(decoded()).toHaveLength(0) // fallback: nothing loaded yet
    await e.samples.load(m as never, '/')
    expect(e.samples.size).toBe(Object.keys(AUDIO_ASSETS).length)
    e.play(fire)
    expect(decoded().length).toBeGreaterThan(0)
    const layered = decoded().length
    e.setMode('synth')
    e.play({ ...fire, delay: 0.5 })
    expect(decoded().length).toBe(layered)
    expect(e.mode).toBe('synth')
    vi.runAllTimers()
  })
})

describe('audio: announcer', () => {
  afterEach(() => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext
    vi.unstubAllGlobals()
    vi.useRealTimers()
    matchAnnouncer.reset()
  })

  const kill = (tick: number): { events: SimEvent[]; listener: Parameters<typeof audio.playEvents>[1] } => ({
    events: [{ type: 'death', pawn: 2, owner: 1, killer: 0 }],
    listener: { x: 0, y: 0, halfWidth: 1000, localPlayer: 0, state: { pawns: [], tick } },
  })

  it('the HUD gets the same line even while audio is locked (no AudioContext)', () => {
    const heard: string[] = []
    const off = announcements.subscribe((a) => heard.push(a.text))
    const k = kill(600)
    audio.playEvents(k.events, k.listener)
    off()
    expect(heard).toEqual(['First Blood!'])
  })

  it('a line with no voice file yet still reaches the HUD (round flow before pack 2 is recorded)', () => {
    const heard: string[] = []
    const off = announcements.subscribe((a) => heard.push(a.text))
    audio.playEvents([{ type: 'phase', phase: 'fight', round: 1 }], { x: 0, y: 0, halfWidth: 1000, localPlayer: 0, state: { pawns: [], tick: 900 } })
    off()
    expect(heard).toEqual(['Fight!'])
  })

  it('with audio running, a line plays on the announcer bus and ducks the effects', async () => {
    vi.useFakeTimers()
    ;(globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext
    vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    const e = new AudioEngine()
    e.setAnnouncerVoice('maverick')
    e.unlock()
    const m = MockAudioContext.instances.at(-1)!
    await e.samples.load(m as never, '/')
    const before = m.sources().length
    const k = kill(600)
    e.playEvents(k.events, k.listener)
    const voice = m.sources().slice(before).find((n) => (n as unknown as { outputs: unknown[] }).outputs.length > 0)
    expect(voice).toBeDefined()
    // the duck stage dips by -4 dB
    const duckDips = m.nodes
      .filter((n) => n.kind === 'gain')
      .flatMap((n) => (n as unknown as { gain: { calls: { fn: string; v: number }[] } }).gain.calls)
      .filter((c) => c.fn === 'setTarget' && Math.abs(c.v - 0.63) < 1e-9)
    expect(duckDips.length).toBeGreaterThan(0)
    vi.runAllTimers()
  })
})

