import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { SpellId } from '../sim'
import { abilityStats, maxLevelOf } from './data/abilityStats'
import { displayName, isPassive, itemDef, spellDef } from './data/catalog'
import { LIBRARY_GROUPS, LIBRARY_ORDER, libraryGroupOf } from './data/library'
import { AbilityStatList, LevelTable, abilityNotes } from './hud/AbilityCard'
import { hasClip, loadMediaIndex, posterUrl, saveData, showClip, stopClip } from './lib/abilityMedia'
import { reducedMotion } from './lib/motion'
import { hoverSfx, sfx } from './lib/sound'
import { Sigil } from './icons'
import { Modal, Segmented } from './widgets'
import { trackEvent } from '../lib/analytics'

/**
 * Spell library: every spell and item in one browsable book, opened from the
 * main menu or How to play. A tile per spell grouped by spellbook column; the
 * selected one plays its preview clip (the same clips and posters as the
 * ability hover cards, Save-Data and reduced motion: poster until asked) next
 * to the description and numbers the ability card shows, for any level.
 */

type Entry = 'menu' | 'how_to_play'

let openFrom: Entry | null = null
const listeners = new Set<() => void>()
const publish = (next: Entry | null) => {
  openFrom = next
  for (const cb of listeners) cb()
}
/** the last spell looked at, so reopening continues where you left off */
let lastPick: SpellId = LIBRARY_ORDER[0]
let lastLevel = 1

export const spellLibrary = {
  open(entry: Entry): void {
    if (openFrom) return
    trackEvent('spell_library_view', { entry_point: entry })
    publish(entry)
  },
  close(): void {
    publish(null)
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
}

/** Mounted once beside the How to play guide (it can open over that guide). */
export function SpellLibrary() {
  const entry = useSyncExternalStore(spellLibrary.subscribe, () => openFrom)
  return entry ? <Library /> : null
}

function Library() {
  const [pick, setPick] = useState<SpellId>(lastPick)
  const [level, setLevel] = useState(lastLevel)
  const tiles = useRef(new Map<SpellId, HTMLElement>())
  const detail = useRef<HTMLElement>(null)
  useEffect(() => {
    // the clip index is shared with the hover cards; one fetch for both
    void loadMediaIndex()
  }, [])
  const choose = (id: SpellId, how: 'pointer' | 'key') => {
    if (id === pick) return
    lastPick = id
    setPick(id)
    if (how === 'key') {
      tiles.current.get(id)?.focus()
      return
    }
    sfx('click')
    // one column on a phone: the details sit above the grid, bring them back into view
    if (window.matchMedia('(max-width: 767px)').matches) detail.current?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }
  const onTileKey = (e: KeyboardEvent<HTMLElement>, id: SpellId) => {
    const at = LIBRARY_ORDER.indexOf(id)
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? LIBRARY_ORDER.length - 1 : null
    if (to !== null) {
      e.preventDefault()
      choose(LIBRARY_ORDER[Math.max(0, Math.min(LIBRARY_ORDER.length - 1, to))], 'key')
    }
  }
  const max = maxLevelOf(pick)
  const shown = Math.min(level, max)
  return (
    <Modal title="Spell library" onClose={spellLibrary.close} width="max-w-6xl" className="md:h-[min(820px,94dvh)]">
      <div className="spell-library flex h-full min-h-0 flex-col gap-4 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,25rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <div className="flex min-h-0 flex-col gap-3 md:overflow-y-auto md:pr-1" style={{ scrollbarWidth: 'thin' }}>
          <p className="text-[0.95rem] leading-snug text-[#e6d3b8]">Every spell in the arena, as it plays. In the shop you own one spell from each column and upgrade it between rounds.</p>
          <div role="listbox" aria-label="Spells and items" aria-orientation="horizontal" className="grid gap-3 sm:grid-cols-2">
            {LIBRARY_GROUPS.map((g) => (
              <section key={g.key} role="group" aria-labelledby={`library-${g.key}`} className={`library-group ${g.ids.length > 4 ? 'sm:col-span-2' : ''}`} style={{ ['--hue' as string]: g.hue }} data-current={g.ids.includes(pick) || undefined}>
                <h3 id={`library-${g.key}`} className="library-group-head">
                  <span className="library-gem" aria-hidden />
                  <span className="font-display font-bold tracking-[0.05em]" style={{ color: g.hue }}>{g.name}</span>
                  <span className="truncate text-[0.78rem] text-ash">{g.hint}</span>
                </h3>
                <div className="library-tiles">
                  {g.ids.map((id) => (
                    <div
                      key={id}
                      ref={(el) => {
                        if (el) tiles.current.set(id, el)
                        else tiles.current.delete(id)
                      }}
                      role="option"
                      aria-selected={id === pick}
                      tabIndex={id === pick ? 0 : -1}
                      className="library-tile"
                      data-passive={isPassive(id) || undefined}
                      onPointerEnter={(e) => e.pointerType !== 'touch' && hoverSfx()}
                      onClick={() => choose(id, 'pointer')}
                      onKeyDown={(e) => onTileKey(e, id)}
                    >
                      <span className="tile-icon" style={{ width: 54, height: 54 }}>
                        <Sigil id={id} size={46} />
                      </span>
                      <span className="tile-name">{displayName(id)}</span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
        <section ref={detail} aria-label={`${displayName(pick)} details`} className="library-detail max-md:order-first md:overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          <Details key={pick} id={pick} level={shown} onLevel={(l) => { lastLevel = l; setLevel(l) }} />
        </section>
      </div>
    </Modal>
  )
}

function Details({ id, level, onLevel }: { id: SpellId; level: number; onLevel: (level: number) => void }) {
  const group = libraryGroupOf(id)
  const hue = group?.hue ?? '#ffb36b'
  const spell = spellDef(id)
  const item = itemDef(id)
  const passive = isPassive(id)
  const max = maxLevelOf(id)
  const stats = abilityStats(id, level)
  const progression = max > 1 ? Array.from({ length: max }, (_, i) => ({ level: i + 1, stats: abilityStats(id, i + 1) })) : []
  const implemented = spell?.implemented ?? item?.implemented ?? true
  const starter = group?.key === 'starters'
  const role = !group ? null : starter ? 'Starting spell' : spell ? `${group.name} column` : 'Item'
  // starters come with every kit; their item price is only for upgrades
  const price = starter ? null : spell ? `${spell.buy} gold` : item ? `${item.cost} gold a level` : null
  return (
    <div className="library-swap flex flex-col gap-3" style={{ ['--hue' as string]: hue }}>
      <Clip id={id} passive={passive} />
      <header className="flex items-start gap-3">
        <span className="tile-icon shrink-0" style={{ width: 60, height: 60 }}>
          <Sigil id={id} size={52} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-[1.6rem] leading-tight font-bold tracking-[0.04em]" style={{ color: hue }}>{displayName(id)}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.78rem]">
            {role && <span className="library-chip">{role}</span>}
            {passive && <span className="library-chip text-[#bfe3ff]">Passive</span>}
            {!implemented && <span className="library-chip text-ash">Coming soon</span>}
            {price && <span className="library-chip text-[#ffd77a]"><span className="coin" aria-hidden />{price}</span>}
          </div>
        </div>
      </header>
      {(spell?.desc ?? item?.desc) && <p className="ability-card-desc text-[1rem]">{spell?.desc ?? item?.desc}</p>}
      {max > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[0.85rem] font-semibold text-bone">Numbers at level</span>
          <Segmented label="Level shown" value={String(level)} onChange={(v) => onLevel(Number(v))} options={Array.from({ length: max }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
        </div>
      )}
      <AbilityStatList stats={stats} />
      <LevelTable progression={progression} level={level} mode="browse" />
      {abilityNotes(stats, progression).map((note) => <p key={note} className="text-[0.72rem] leading-snug text-ash">{note}</p>)}
      {!passive && <p className="text-[0.72rem] leading-snug text-ash">Base numbers, before masteries, items and lobby multipliers.</p>}
    </div>
  )
}

/**
 * The preview stage: the poster at once, the shared clip over it while it
 * plays. Reduced motion or Save-Data: poster until Play is pressed (Save-Data
 * never fetches a clip). No clip (stat items) or nothing loads: the spell's
 * icon floats on its column colour instead of a broken box.
 */
function Clip({ id, passive }: { id: SpellId; passive: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [listed, setListed] = useState<boolean | undefined>(() => (passive ? false : hasClip(id)))
  const [posterOk, setPosterOk] = useState(true)
  const [clipOk, setClipOk] = useState(true)
  const [playing, setPlaying] = useState(() => !reducedMotion() && !saveData())
  useEffect(() => {
    if (passive) return
    let alive = true
    void loadMediaIndex().then((ids) => alive && setListed(ids.has(id)))
    return () => {
      alive = false
    }
  }, [id, passive])
  useEffect(() => {
    const el = box.current
    if (!listed || !playing || !el || saveData()) return
    showClip(el, id, () => setClipOk(false))
    return () => stopClip()
  }, [id, listed, playing])
  const art = listed === false || (!posterOk && (!clipOk || saveData()))
  if (art) {
    return (
      <div className="library-stage library-art" aria-hidden>
        <span className="library-float"><Sigil id={id} size={112} /></span>
        <span className="library-art-note">{passive ? 'A stat item: nothing to cast, always on' : 'Preview unavailable'}</span>
      </div>
    )
  }
  return (
    <div className="relative">
      <div ref={box} className="ability-media library-stage">
        {posterOk && <img src={posterUrl(id)} width={300} height={169} decoding="async" alt="" onError={() => setPosterOk(false)} />}
      </div>
      {listed && clipOk && !saveData() && (
        <button type="button" className="absolute right-2 bottom-2 rounded border border-white/15 bg-black/75 px-2 py-1 text-xs text-bone hover:bg-black focus-visible:outline-2 focus-visible:outline-gold" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
          {playing ? 'Pause clip' : 'Play clip'}
        </button>
      )}
    </div>
  )
}
