import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SimEvent } from '../sim/types'
import { audio } from './index'
import { AudioEngine, VOICES } from './engine'
import { HANDLED_EVENTS, IGNORED_EVENTS, kbIntensity, planEvents, spatial } from './events'
import { MusicLayer } from './music'
import { createSynth, RECIPES, type SfxId } from './synth'
import { asContext, MockAudioContext } from './mockContext'

/** One sample of every SimEvent type. The mapped type makes this fail to compile when a type is added. */
const SAMPLES: { [K in SimEvent['type']]: Extract<SimEvent, { type: K }> } = {
  cast: { type: 'cast', pawn: 1, spell: 'fireball', x: 500, y: 0 },
  castStart: { type: 'castStart', pawn: 1, spell: 'scourge', ticks: 54 },
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
        const dur = RECIPES[id](s, out as never, 0.01, p)
        expect(dur, id).toBeGreaterThan(0)
        expect(m.leakingSources(), `${id} leaks sources`).toEqual([])
        expect(m.sources().length, `${id} makes sound`).toBeGreaterThan(0)
        for (const src of m.sources()) expect(src.stopped!, id).toBeLessThanOrEqual(0.01 + dur + 0.2)
      }
    }
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
    // every menu source is stopped; only the fight drone keeps running
    const running = m.leakingSources()
    expect(running.length).toBeGreaterThan(0)
    expect(running.length).toBeLessThanOrEqual(4)
    vi.runAllTimers()
  })
})
