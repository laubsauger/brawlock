/**
 * The sound board's catalog, built from the live registries (RECIPES, HYBRID, AUDIO_ASSETS,
 * the announcer lines, ambience beds and music tracks), so a new sound shows up on its own.
 * Pure data: the page (soundboard.tsx) plays it, the test checks nothing is missing.
 *
 * Recipes are grouped by the spell that uses them (from the event mapping's spell, projectile
 * and modifier tables, or a spell id the sound's name starts with), per shop column; sounds of
 * several spells are "Shared spell sounds"; the rest by name (UI, lava, impacts, match flow).
 */
import { SPELLS } from '../../sim'
import { ANNOUNCER_TEXT, type AnnouncerLine } from '../../game/announcer'
import { AMBIENCE_KINDS, type AmbienceKind } from '../ambience'
import { AUDIO_ASSETS, AUDIO_CREDITS, type AssetId, type AudioCredit } from '../assets'
import { VOICES, announcerFile, type AnnouncerVoice } from '../engine'
import { MODIFIER_IDS, PROJECTILE_SOUNDS, SPELL_SOUNDS } from '../events'
import { HYBRID } from '../hybrid'
import { MUSIC_TRACKS, type MusicTrack } from '../music'
import { RECIPES, RECIPE_PARAMS, type RecipeParam, type SfxId } from '../synth'

interface Base {
  /** unique on the board */
  key: string
  label: string
  /** lower-case text the search box matches */
  search: string
}

export type BoardItem =
  | (Base & { kind: 'recipe'; id: SfxId; param?: RecipeParam; bus: 'sfx' | 'ui'; level: number; hybrid: AssetId[] })
  | (Base & { kind: 'sample'; id: AssetId; file: string; credit: AudioCredit | null; loop: boolean; duration: number; usedBy: SfxId[] })
  | (Base & { kind: 'announcer'; voice: AnnouncerVoice; line: AnnouncerLine; text: string; asset: AssetId | null; note: string | null })
  | (Base & { kind: 'ambience'; id: AmbienceKind; beds: AssetId[] })
  | (Base & { kind: 'music'; id: MusicTrack })

export interface BoardGroup {
  title: string
  items: BoardItem[]
}

export const ANNOUNCER_VOICES: readonly AnnouncerVoice[] = ['maverick', 'arena']
const VOICE_NAME: Record<AnnouncerVoice, string> = { maverick: 'Maverick', arena: 'Daniel (Arena)' }

/** Spell ids a sound belongs to, from the event mapping's tables and the sound's own name. */
function owners(): Map<SfxId, Set<string>> {
  const spells = Object.keys(SPELLS)
  // a projectile kind or modifier id names its spell as a prefix ('drainHeal' -> drain)
  const spellOf = (key: string) =>
    spells.filter((s) => key.toLowerCase().startsWith(s.toLowerCase())).sort((a, b) => b.length - a.length)[0]
  const out = new Map<SfxId, Set<string>>()
  const add = (id: SfxId | null | undefined, spell: string | undefined) => {
    if (!id || !spell) return
    const set = out.get(id) ?? new Set<string>()
    set.add(spell)
    out.set(id, set)
  }
  for (const [spell, s] of Object.entries(SPELL_SOUNDS)) add(s.cast, spell)
  for (const [kind, p] of Object.entries(PROJECTILE_SOUNDS)) for (const id of [p.travel, p.hit, p.expire]) add(id, spellOf(kind))
  for (const [mod, m] of Object.entries(MODIFIER_IDS)) for (const id of [m.on?.[0], m.off?.[0], m.loop?.[0]]) add(id, spellOf(mod))
  for (const id of Object.keys(RECIPES) as SfxId[]) add(id, spellOf(id))
  return out
}

function byName(id: string): string {
  if (/^(ui|buy)/.test(id)) return 'UI and shop'
  if (/lava|shrink|obstacle/i.test(id)) return 'Lava and arena'
  if (/^(hit|death|impact|explosion|fizzle|tink)/.test(id)) return 'Impacts and deaths'
  if (/round|gameOver|streak|respawn/.test(id)) return 'Match flow'
  return 'Other spell and cast sounds'
}

function recipeGroup(id: SfxId, own: Map<SfxId, Set<string>>): string {
  const spells = [...(own.get(id) ?? [])]
  if (spells.length > 1) return 'Shared spell sounds'
  if (spells.length === 1) {
    const def = SPELLS[spells[0]]
    // Fireball and Scourge are fixed-slot items in the sim
    return def.kind === 'item' ? 'Base spells and items' : `Spells, column ${def.column}`
  }
  return byName(id)
}

const recipeLabel = (id: SfxId, own: Map<SfxId, Set<string>>) => {
  const spells = [...(own.get(id) ?? [])].map((s) => SPELLS[s].name)
  return spells.length ? `${spells.join(', ')}: ${id}` : id
}

export function buildBoard(): BoardGroup[] {
  const own = owners()
  const groups = new Map<string, BoardItem[]>()
  const put = (title: string, item: BoardItem) => groups.set(title, [...(groups.get(title) ?? []), item])

  const usedBy = new Map<AssetId, SfxId[]>()
  for (const [id, def] of Object.entries(HYBRID) as [SfxId, NonNullable<(typeof HYBRID)[SfxId]>][])
    for (const layer of def.layers) for (const a of layer.assets) usedBy.set(a, [...(usedBy.get(a) ?? []), id])

  for (const id of Object.keys(RECIPES) as SfxId[]) {
    const label = recipeLabel(id, own)
    const hybrid = [...new Set((HYBRID[id]?.layers ?? []).flatMap((l) => l.assets))]
    put(recipeGroup(id, own), {
      kind: 'recipe',
      key: `recipe:${id}`,
      id,
      label,
      param: RECIPE_PARAMS[id],
      bus: VOICES[id].bus,
      level: VOICES[id].level,
      hybrid,
      search: `${label} ${hybrid.join(' ')}`.toLowerCase(),
    })
  }

  const assetIds = Object.keys(AUDIO_ASSETS) as AssetId[]
  for (const id of assetIds) {
    if (id.startsWith('announcer/')) continue
    const a = AUDIO_ASSETS[id]
    const credit = AUDIO_CREDITS[a.credit] ?? null
    put(a.loop ? 'Recordings: loops and beds' : 'Recordings: one-shots', {
      kind: 'sample',
      key: `sample:${id}`,
      id,
      label: id,
      file: `audio/${id}.ogg`,
      credit,
      loop: a.loop,
      duration: a.duration,
      usedBy: usedBy.get(id) ?? [],
      search: `${id} ${credit?.title ?? ''} ${credit?.creator ?? ''} ${(usedBy.get(id) ?? []).join(' ')}`.toLowerCase(),
    })
  }

  for (const voice of ANNOUNCER_VOICES) {
    for (const line of Object.keys(ANNOUNCER_TEXT) as AnnouncerLine[]) {
      const asset = announcerFile(voice, line)
      const own = `announcer/${voice}_${line}`
      const note = asset === null ? 'no voice file yet: banner only' : asset !== own ? `no ${VOICE_NAME[voice]} file: plays ${asset.slice('announcer/'.length).split('_')[0]}` : null
      put(`Announcer: ${VOICE_NAME[voice]}`, {
        kind: 'announcer',
        key: `announcer:${voice}:${line}`,
        voice,
        line,
        text: ANNOUNCER_TEXT[line],
        label: `${ANNOUNCER_TEXT[line]} (${line})`,
        asset,
        note,
        search: `${ANNOUNCER_TEXT[line]} ${line} ${voice} announcer`.toLowerCase(),
      })
    }
  }

  const beds = assetIds.filter((id) => id.startsWith('bed_'))
  for (const id of AMBIENCE_KINDS)
    put('Ambience', { kind: 'ambience', key: `ambience:${id}`, id, label: `${id} lava bed`, beds, search: `${id} ambience lava bed`.toLowerCase() })
  for (const id of MUSIC_TRACKS) put('Music', { kind: 'music', key: `music:${id}`, id, label: `${id} track`, search: `${id} music track`.toLowerCase() })

  const order = (t: string) => {
    if (t === 'Base spells and items') return 0
    const col = /^Spells, column (\d)/.exec(t)
    if (col) return Number(col[1])
    const voice = ANNOUNCER_VOICES.findIndex((v) => t === `Announcer: ${VOICE_NAME[v]}`)
    if (voice >= 0) return voice
    return ['Shared spell sounds', 'Other spell and cast sounds', 'Impacts and deaths', 'Lava and arena', 'Match flow', 'UI and shop'].indexOf(t) + 10
  }
  const rest = (t: string) => (t.startsWith('Recordings') ? 30 : t.startsWith('Announcer') ? 40 : t === 'Ambience' ? 50 : t === 'Music' ? 60 : 0)
  return [...groups.entries()]
    .map(([title, items]) => ({ title, items }))
    .sort((a, b) => rest(a.title) - rest(b.title) || order(a.title) - order(b.title) || a.title.localeCompare(b.title))
}
