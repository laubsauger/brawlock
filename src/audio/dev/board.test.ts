/**
 * The sound board is only useful if it shows everything: every registry entry must be on it,
 * so a new sound can be checked by ear the moment it exists.
 */
import { describe, expect, it } from 'vitest'
import { ANNOUNCER_TEXT, type AnnouncerLine } from '../../game/announcer'
import { AMBIENCE_KINDS } from '../ambience'
import { AUDIO_ASSETS, type AssetId } from '../assets'
import { announcerFile } from '../engine'
import { HYBRID } from '../hybrid'
import { MUSIC_TRACKS } from '../music'
import { RECIPES, RECIPE_PARAMS, type SfxId } from '../synth'
import { ANNOUNCER_VOICES, buildBoard, type BoardItem } from './board'

const items = buildBoard().flatMap((g) => g.items)
const of = <K extends BoardItem['kind']>(kind: K) => items.filter((i): i is Extract<BoardItem, { kind: K }> => i.kind === kind)

describe('sound board: generated from the registries', () => {
  it('lists every recipe, recording, announcer line, ambience bed and music track', () => {
    expect(new Set(of('recipe').map((i) => i.id))).toEqual(new Set(Object.keys(RECIPES)))
    const assets = Object.keys(AUDIO_ASSETS) as AssetId[]
    expect(new Set(of('sample').map((i) => i.id))).toEqual(new Set(assets.filter((id) => !id.startsWith('announcer/'))))
    for (const voice of ANNOUNCER_VOICES)
      for (const line of Object.keys(ANNOUNCER_TEXT) as AnnouncerLine[])
        expect(of('announcer').some((i) => i.voice === voice && i.line === line), `${voice} ${line}`).toBe(true)
    // every announcer recording is reachable from some line
    const played = new Set(of('announcer').map((i) => i.asset))
    for (const id of assets.filter((a) => a.startsWith('announcer/'))) expect(played.has(id), id).toBe(true)
    expect(new Set(of('ambience').map((i) => i.id))).toEqual(new Set(AMBIENCE_KINDS))
    expect(new Set(of('music').map((i) => i.id))).toEqual(new Set(MUSIC_TRACKS))
    // every recording a hybrid recipe layers in is listed with that recipe
    for (const [id, def] of Object.entries(HYBRID))
      for (const layer of def!.layers) for (const a of layer.assets) expect(of('recipe').find((r) => r.id === id)!.hybrid).toContain(a)
  })

  it('keys are unique (one meter per row)', () => {
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
  })

  it('every recipe that reads its parameter declares it, with a usable range', () => {
    for (const id of Object.keys(RECIPES) as SfxId[]) {
      const takes = RECIPES[id].length >= 2
      expect(!!RECIPE_PARAMS[id], `${id} ${takes ? 'reads p but declares no RECIPE_PARAMS' : 'declares a param it never reads'}`).toBe(takes)
      const p = RECIPE_PARAMS[id]
      if (p) expect(p.value >= p.min && p.value <= p.max && p.step > 0, id).toBe(true)
    }
  })

  it('an announcer line without its own file says so (Arena falls back to Maverick)', () => {
    for (const a of of('announcer')) {
      const own = `announcer/${a.voice}_${a.line}`
      expect(a.asset).toBe(announcerFile(a.voice, a.line))
      if (a.asset === own) expect(a.note).toBeNull()
      else expect(a.note).toMatch(a.asset ? /plays maverick/ : /no voice file/)
    }
  })
})
