import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { frame } from '../../game/frame'
import { input } from '../../game/input'
import { useGame } from '../../game/store'
import { TICK_HZ, type InputCommand, type SpellId } from '../../sim'
import { Sigil } from '../icons'
import {
  COLUMNS,
  ITEMS,
  MASTERIES,
  MASTERY_COST,
  MASTERY_MAX_LEVEL,
  MASTERY_HUE,
  SPELL_MAX_LEVEL,
  SPELLS,
  hueFor,
  levelStats,
  masteryValue,
  type MasteryId,
  type ShopItem,
  type ShopSpell,
  type Stat,
} from '../data/catalog'
import { bindLabel, slotKeyLabel, useBinds } from '../lib/keys'
import { sfx } from '../lib/sound'
import { usePolled, useTick } from '../lib/ticker'
import { canBuyNow, localView } from '../lib/view'
import { Button, Kbd, KeyCaps } from '../widgets'
import { CharacterBody } from './Overlays'
import { displayRound } from './TopBar'
import { slotDragProps, slotDropProps } from '../lib/slotDnd'
import { itemOffer, masteryAllOffer, masteryOffer, spellOffer, type Offer, type OfferState } from './shopOffers'

/**
 * The shop: two docked panels at the screen edges so the arena center (your
 * warlock practicing) stays visible. Right: the six spell columns. Left:
 * masteries and items, or your stats (C / K). Opens by itself in the shop
 * phase, B toggles it, arrow keys walk the cards, Enter buys.
 */

type CardState = OfferState

interface ShopView {
  ready: boolean
  gold: number
  /** owned spell per column 0..5 */
  spells: { id: SpellId | null; level: number }[]
  /** owned items by id -> level */
  items: Record<string, number>
  /** owned items by id -> hotbar slot (6..11), for key swaps */
  itemSlots: Record<string, number>
  freeItemSlots: number
  masteries: Record<MasteryId, number>
  phase: string
  open: boolean
}

function readShop(): ShopView {
  const v = localView()
  const pawn = v?.pawn
  const items: Record<string, number> = {}
  const itemSlots: Record<string, number> = {}
  let free = 0
  for (let i = 6; i < 12; i++) {
    const id = pawn?.slots[i]
    if (id) {
      items[id] = pawn?.levels[i] ?? 1
      itemSlots[id] = i
    } else free++
  }
  return {
    ready: !!pawn && !!v?.score,
    gold: Math.floor(v?.score?.gold ?? 0),
    spells: Array.from({ length: 6 }, (_, c) => ({ id: pawn?.slots[c] ?? null, level: pawn?.levels[c] ?? 0 })),
    items,
    itemSlots,
    freeItemSlots: pawn ? free : 0,
    masteries: { duration: 0, range: 0, lifesteal: 0, ...v?.score?.masteries },
    phase: v?.state.phase ?? '',
    open: v ? canBuyNow(v.state) : false,
  }
}

interface Detail {
  name: string
  hue: string
  icon: string
  desc: string
  cost: number | null
  costLabel: string
  stats: { label: string; from?: string; to: string }[]
  note?: string
  level?: { now: number; max: number }
}

function diffStats(before: Stat[] | null, after: Stat[]): Detail['stats'] {
  return after.map(([label, to], i) => ({ label, to, from: before?.[i]?.[1] }))
}

function stateNote(state: CardState): string | undefined {
  switch (state) {
    case 'soon':
      return 'Coming soon'
    case 'poor':
      return 'Not enough gold'
    case 'max':
      return 'Max level'
    case 'full':
      return 'No free item slot'
    case 'locked':
      return 'You already own a spell in this column'
    case 'closed':
      return 'Buying opens between rounds'
    default:
      return undefined
  }
}

function flash(el: HTMLElement, kind: 'buy' | 'deny') {
  el.dataset.flash = ''
  void el.offsetWidth
  el.dataset.flash = kind
}

function purchase(e: ReactMouseEvent<HTMLElement>, state: CardState, cmd: InputCommand) {
  if (state === 'ok') {
    input.issue(cmd)
    sfx('buy')
    flash(e.currentTarget, 'buy')
  } else if (state !== 'soon' && state !== 'locked' && state !== 'closed') {
    sfx('error')
    flash(e.currentTarget, 'deny')
  }
}

/** Level pips; pips gained since the last render fill in with a pop. */
function LevelBars({ level, max, big }: { level: number; max: number; big?: boolean }) {
  const prev = useRef(level)
  const from = prev.current
  useEffect(() => {
    prev.current = level
  }, [level])
  return (
    <span className={`lvl-bars ${big ? 'big' : ''}`} role="img" aria-label={`Level ${level} of ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <i key={i} data-on={i < level} data-new={level > from && i >= from && i < level} />
      ))}
    </span>
  )
}

/** Gold that ticks toward its new value, with a floating -N / +N. */
function GoldCounter({ gold }: { gold: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef(gold)
  const [deltas, setDeltas] = useState<{ key: number; n: number }[]>([])
  const key = useRef(0)
  useEffect(() => {
    const from = shown.current
    if (from === gold) return
    const k = ++key.current
    setDeltas((d) => [...d.slice(-2), { key: k, n: gold - from }])
    const t = window.setTimeout(() => setDeltas((d) => d.filter((x) => x.key !== k)), 1100)
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const f = Math.min(1, (now - t0) / 450)
      const val = Math.round(from + (gold - from) * (1 - (1 - f) * (1 - f)))
      shown.current = val
      if (ref.current) ref.current.textContent = String(val)
      if (f < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(t)
      shown.current = gold
      if (ref.current) ref.current.textContent = String(gold)
    }
  }, [gold])
  return (
    <span className="relative flex items-center gap-2 text-[1.9rem] leading-none font-bold text-gold" aria-label={`${gold} gold`}>
      <span className="coin" aria-hidden />
      <span ref={ref} className="tabular">
        {gold}
      </span>
      {deltas.map((d) => (
        <span key={d.key} className={`gold-delta tabular text-lg ${d.n < 0 ? 'text-[#ff9b7a]' : 'text-heal'}`} aria-hidden>
          {d.n > 0 ? `+${d.n}` : d.n}
        </span>
      ))}
    </span>
  )
}

/** "Round 3 in 0:21" while shopping, from the shared rAF. */
function ShopClock() {
  const ref = useRef<HTMLSpanElement>(null)
  const last = useRef('')
  useTick(() => {
    const s = frame.curr
    if (!s || !ref.current) return
    let t = ''
    if (s.phase === 'shop' || s.phase === 'warmup') {
      const secs = Math.max(0, Math.ceil(s.phaseTicksLeft / TICK_HZ))
      t = `Round ${displayRound(s)} in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
    } else if (s.phase === 'fight') t = canBuyNow(s) ? 'You are out: buy for the next round' : 'Round in progress'
    else if (s.phase === 'roundEnd') t = 'Round over'
    if (t !== last.current) {
      ref.current.textContent = last.current = t
      ref.current.dataset.hot = String(s.phase === 'shop' && s.phaseTicksLeft <= 5 * TICK_HZ)
    }
  })
  return <span ref={ref} className="tabular ink-sm text-[1.15rem] font-semibold text-[#f0d9b8] data-[hot=true]:text-[#ffb08f]" />
}

/**
 * Gear dock detail card. Stacked, never side by side: the dock is narrow, so
 * the title row, meta row, description and stat list each get the full width
 * (a side-by-side stat column squeezed the text to one word per line).
 */
function DetailView({ detail, empty }: { detail: Detail | null; empty: string }) {
  return (
    <footer className="gear-detail border-t border-[rgba(255,170,100,0.12)] px-4 py-3" aria-live="polite">
      {detail ? (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <span className="tile-icon shrink-0" style={{ width: 52, height: 52, ['--hue' as string]: detail.hue }}>
              <Sigil id={detail.icon} size={46} hue={detail.hue} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[1.1rem] leading-tight font-bold" style={{ color: detail.hue }}>
                {detail.name}
              </div>
              <div className="flex flex-wrap gap-x-2.5 text-[0.86rem] leading-snug text-ash">
                {detail.level && detail.level.now > 0 && (
                  <span className="whitespace-nowrap">
                    Level {detail.level.now} of {detail.level.max}
                  </span>
                )}
                {detail.cost != null && (
                  <span className="whitespace-nowrap">
                    {detail.costLabel} for <span className="cost">{detail.cost} gold</span>
                  </span>
                )}
              </div>
            </div>
          </div>
          <p className="text-[0.95rem] leading-snug text-[#e6d3b8]">{detail.desc}</p>
          {detail.note && <p className="text-[0.9rem] font-semibold text-[#ffb08f]">{detail.note}</p>}
          {detail.stats.length > 0 && (
            <dl className="tabular grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-[0.92rem]">
              {detail.stats.map((s) => (
                <div key={s.label} className="contents">
                  <dt className="min-w-0 text-ash">{s.label}</dt>
                  <dd className="text-right font-semibold whitespace-nowrap">
                    {s.from !== undefined && s.from !== s.to ? (
                      <>
                        <span className="text-ash">{s.from}</span> <span className="text-ember">›</span> <span className="text-heal">{s.to}</span>
                      </>
                    ) : (
                      s.to
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : (
        <p className="text-[0.95rem] text-ash">{empty}</p>
      )}
    </footer>
  )
}

/** Arrow keys move focus between cards in a grid of [data-nav="col,row"] buttons. */
function navKeys(e: ReactKeyboardEvent<HTMLElement>) {
  const k = e.key
  if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return
  const cur = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]')
  if (!cur) return
  e.preventDefault()
  const [c, r] = cur.dataset.nav!.split(',').map(Number)
  const dc = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0
  const dr = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const el of e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')) {
    const [cc, rr] = el.dataset.nav!.split(',').map(Number)
    if (dc && Math.sign(cc - c) !== dc) continue
    if (dr && (cc !== c || Math.sign(rr - r) !== dr)) continue
    const score = dc ? Math.abs(cc - c) * 100 + Math.abs(rr - r) : Math.abs(rr - r)
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  best?.focus()
}

/** Spell / item / mastery tile: the painted icon is the hero; cost badge, tag, name, pips. */
function IconTile({
  id,
  name,
  hue,
  offer,
  size,
  max = 1,
  nav,
  label,
  onBuy,
  onHover,
  slot,
}: {
  id: string
  name: string
  hue: string
  offer: Offer
  size: number
  max?: number
  nav: string
  label: string
  onBuy: (e: ReactMouseEvent<HTMLElement>) => void
  onHover: () => void
  /** hotbar slot of an owned spell / item: drag onto another to swap their keys */
  slot?: number
}) {
  // clicks are gated by the offer state only; ownership is styling
  const disabled = offer.state === 'soon' || offer.state === 'locked' || offer.state === 'closed' || offer.state === 'max'
  const showCost = offer.price != null && offer.state !== 'soon' && offer.state !== 'locked'
  return (
    <button
      type="button"
      className="shop-card icon-tile"
      style={{ ['--hue' as string]: hue }}
      data-state={offer.state}
      data-owned={offer.owned}
      data-nav={nav}
      aria-disabled={disabled}
      aria-label={label}
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onBuy}
      {...(slot != null ? slotDragProps(slot) : {})}
    >
      <span className="tile-icon" style={{ width: size, height: size }}>
        <Sigil id={id} size={size - 6} />
        {showCost && (
          <span className="tile-cost tabular">
            {offer.owned ? '+' : ''}
            <span className="coin" aria-hidden />
            {offer.price}
          </span>
        )}
        {offer.tag && (
          <span className="tile-tag">
            {offer.tag === 'Soon' && (
              <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden>
                <path d="M3.5 5V3.8a2.5 2.5 0 0 1 5 0V5M2.5 5h7v5.5h-7Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            )}
            {offer.tag}
          </span>
        )}
      </span>
      <span className="tile-name">{name}</span>
      {max > 1 && offer.level > 0 && <LevelBars level={offer.level} max={max} />}
    </button>
  )
}

/** Hovered spell: big icon, description, and every level's numbers (current and next highlighted). */
function SpellDetail({ def, owned, state }: { def: ShopSpell; owned: number; state: CardState }) {
  const hue = COLUMNS[def.column].hue
  const rows = Array.from({ length: SPELL_MAX_LEVEL }, (_, i) => levelStats(def.id, i + 1))
  const labels = rows[0].map(([l]) => l)
  const next = owned < SPELL_MAX_LEVEL ? owned + 1 : 0
  const price = owned === 0 ? def.buy : owned >= SPELL_MAX_LEVEL ? null : def.upgrades[owned - 1]
  return (
    <div className="spell-detail-row flex gap-4">
      <span className="tile-icon shrink-0" style={{ width: 84, height: 84, ['--hue' as string]: hue }}>
        <Sigil id={def.id} size={78} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-display text-[1.25rem] font-bold tracking-[0.04em]" style={{ color: hue }}>
            {def.name}
          </span>
          <span className="text-sm text-ash">{COLUMNS[def.column].name}</span>
          {owned > 0 && <span className="text-sm text-ash">level {owned} of {SPELL_MAX_LEVEL}</span>}
          {price != null && def.implemented && (
            <span className="text-[0.95rem] text-ash">
              {owned === 0 ? 'Buy' : `Level ${next}`} for <span className="cost">{price} gold</span>
            </span>
          )}
        </div>
        <p className="mb-2 text-[0.98rem] leading-snug text-[#e6d3b8]">{def.desc}</p>
        {stateNote(state) && <p className="mb-2 text-[0.9rem] font-semibold text-[#ffb08f]">{stateNote(state)}</p>}
        {labels.length > 0 && (
          <div className="overflow-x-auto">
          <table className="tabular w-full min-w-[320px] text-[0.86rem]">
            <thead>
              <tr className="text-ash">
                <th className="pr-2 text-left font-semibold">Level</th>
                {rows.map((_, i) => (
                  <th key={i} className={`px-1 text-right font-semibold ${i + 1 === owned ? 'text-gold' : i + 1 === next ? 'text-heal' : ''}`}>
                    {i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((label, r) => (
                <tr key={label} className="border-t border-[rgba(255,170,100,0.08)]">
                  <td className="pr-2 text-ash">{label}</td>
                  {rows.map((row, i) => (
                    <td
                      key={i}
                      className={`px-1 text-right ${i + 1 === owned ? 'font-bold text-gold' : i + 1 === next ? 'font-bold text-heal' : 'text-[#d9c6ad]'}`}
                    >
                      {row[r]?.[1] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}

type Hover = { kind: 'spell' | 'item' | 'mastery'; id: string } | null

export function Shop() {
  const v = usePolled(readShop, (x) => JSON.stringify(x), 10)
  const binds = useBinds()
  const characterOpen = useGame((s) => s.characterOpen)
  const toggle = useGame((s) => s.toggle)
  const [hover, setHover] = useState<Hover>(null)
  const right = useRef<HTMLElement>(null)

  // arrow keys from anywhere step into the spell grid (no focus stealing on open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.key.startsWith('Arrow')) return
      if (document.activeElement?.closest('.dock')) return
      const first = right.current?.querySelector<HTMLElement>('[data-nav]:not([aria-disabled="true"])')
      if (first) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = () => {
    sfx('back')
    toggle('shopOpen', false)
  }

  // ---- offers: purchasability + ownership per entry (shopOffers.ts) ----
  const spellOfferOf = (def: ShopSpell) => spellOffer(def, v.spells[def.column], v.gold, v.open)
  const itemOfferOf = (def: ShopItem) => itemOffer(def, v.items[def.id] ?? 0, v.gold, v.open, v.freeItemSlots)
  const masteryOfferOf = (id: MasteryId | 'all') =>
    id === 'all' ? masteryAllOffer(MASTERIES.map((m) => v.masteries[m.id]), v.gold, v.open) : masteryOffer(v.masteries[id], v.gold, v.open)

  const spellDetail = (def: ShopSpell): Detail => {
    const o = spellOfferOf(def)
    const next = Math.min(SPELL_MAX_LEVEL, o.level + 1)
    return {
      name: def.name,
      hue: COLUMNS[def.column].hue,
      icon: def.id,
      desc: def.desc,
      cost: o.price,
      costLabel: o.level === 0 ? 'Buy' : `Level ${next}`,
      stats: diffStats(o.level ? levelStats(def.id, o.level) : null, levelStats(def.id, next)),
      note: stateNote(o.state) ?? (o.level === 0 ? 'One spell per column, kept for the whole match.' : undefined),
      level: { now: o.level, max: SPELL_MAX_LEVEL },
    }
  }

  const itemDetail = (def: ShopItem): Detail => {
    const o = itemOfferOf(def)
    const next = Math.min(def.maxLevel, o.level + 1)
    return {
      name: def.name,
      hue: hueFor(def.id),
      icon: def.id,
      desc: def.desc,
      cost: o.state === 'soon' ? null : o.price,
      costLabel: o.level === 0 ? 'Buy' : `Level ${next}`,
      stats: diffStats(o.level ? levelStats(def.id, o.level) : null, levelStats(def.id, next)),
      note: stateNote(o.state),
      level: def.maxLevel > 1 ? { now: o.level, max: def.maxLevel } : undefined,
    }
  }

  const fmtMastery = (id: MasteryId, lvl: number) => {
    const val = masteryValue(id, lvl)
    return id === 'lifesteal' ? `${Math.round(val * 100)}%` : `+${Math.round((val - 1) * 100)}%`
  }
  const masteryDetail = (id: MasteryId | 'all'): Detail => {
    if (id === 'all') {
      return {
        name: 'All three',
        hue: MASTERY_HUE,
        icon: 'all',
        desc: 'One level of every mastery, 2 gold cheaper than buying them one by one. Unavailable once any mastery is maxed.',
        cost: masteryOfferOf('all').price,
        costLabel: 'Buy',
        stats: MASTERIES.map((m) => ({ label: m.name, from: fmtMastery(m.id, v.masteries[m.id]), to: fmtMastery(m.id, Math.min(MASTERY_MAX_LEVEL, v.masteries[m.id] + 1)) })),
        note: stateNote(masteryOfferOf('all').state),
      }
    }
    const m = MASTERIES.find((x) => x.id === id)!
    const lvl = v.masteries[id]
    return {
      name: `${m.name} mastery`,
      hue: MASTERY_HUE,
      icon: id,
      desc: m.desc,
      cost: lvl >= MASTERY_MAX_LEVEL ? null : MASTERY_COST,
      costLabel: `Level ${Math.min(MASTERY_MAX_LEVEL, lvl + 1)}`,
      stats: [{ label: m.name, from: fmtMastery(id, lvl), to: fmtMastery(id, Math.min(MASTERY_MAX_LEVEL, lvl + 1)) }],
      note: stateNote(masteryOfferOf(id).state),
      level: { now: lvl, max: MASTERY_MAX_LEVEL },
    }
  }

  const detailFor = (h: Hover): Detail | null => {
    if (!h) return null
    if (h.kind === 'mastery') return masteryDetail(h.id as MasteryId | 'all')
    if (h.kind === 'spell') {
      const d = SPELLS.find((x) => x.id === h.id)
      return d ? spellDetail(d) : null
    }
    const d = ITEMS.find((x) => x.id === h.id)
    return d ? itemDetail(d) : null
  }
  const detail = detailFor(hover)

  if (!v.ready) {
    return (
      <div className="dock dock-right">
        <div className="panel p-6 text-ash">Your warlock is not in the arena yet.</div>
      </div>
    )
  }

  const spellHover = hover?.kind === 'spell' ? SPELLS.find((x) => x.id === hover.id) : undefined

  return (
    <>
      {/* ---------------- left dock: masteries + items, or stats ---------------- */}
      <aside className="dock dock-left" aria-label={characterOpen ? 'Your warlock' : 'Masteries and items'}>
        <div className="panel dock-panel flex flex-col">
          <div className="flex items-center gap-1 px-4 pt-3.5 pb-2" role="tablist">
            <button type="button" role="tab" className="tab" aria-selected={!characterOpen} onClick={() => toggle('characterOpen', false)}>
              Gear
            </button>
            <button type="button" role="tab" className="tab flex items-center gap-1.5" aria-selected={characterOpen} onClick={() => toggle('characterOpen', true)}>
              Stats <KeyCaps label={bindLabel(binds, 'character')} />
            </button>
          </div>
          {characterOpen ? (
            <div className="min-h-0 flex-auto overflow-y-auto px-4 pb-4">
              <CharacterBody />
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-auto overflow-y-auto px-3 pb-3" onKeyDown={navKeys}>
                <h3 className="section-title mb-2 px-1">Masteries</h3>
                <div className="tile-grid-4">
                  {MASTERIES.map((m, i) => {
                    const o = masteryOfferOf(m.id)
                    return (
                      <IconTile
                        key={m.id}
                        id={m.id}
                        name={m.name}
                        hue={MASTERY_HUE}
                        offer={o}
                        size={58}
                        max={MASTERY_MAX_LEVEL}
                        nav={`${i},0`}
                        label={`${m.name} mastery, level ${o.level} of ${MASTERY_MAX_LEVEL}${o.price != null ? `, next level ${o.price} gold` : ''}`}
                        onHover={() => setHover({ kind: 'mastery', id: m.id })}
                        onBuy={(e) => purchase(e, o.state, { kind: 'buyMastery', mastery: m.id })}
                      />
                    )
                  })}
                  {(() => {
                    const o = masteryOfferOf('all')
                    return (
                      <IconTile
                        id="all"
                        name="All three"
                        hue={MASTERY_HUE}
                        offer={o}
                        size={58}
                        nav="3,0"
                        label={`Raise all three masteries${o.price != null ? ` for ${o.price} gold` : ''}`}
                        onHover={() => setHover({ kind: 'mastery', id: 'all' })}
                        onBuy={(e) => purchase(e, o.state, { kind: 'buyMastery', mastery: 'all' })}
                      />
                    )
                  })()}
                </div>

                <h3 className="section-title mt-4 mb-2 px-1">
                  Items <span className="ml-auto font-ui text-sm font-medium tracking-normal text-ash">{v.freeItemSlots} free slots</span>
                </h3>
                <div className="tile-grid-3">
                  {ITEMS.map((def, i) => {
                    const o = itemOfferOf(def)
                    return (
                      <IconTile
                        key={def.id}
                        id={def.id}
                        name={def.name}
                        hue={hueFor(def.id)}
                        offer={o}
                        size={62}
                        max={def.maxLevel}
                        nav={`${i % 3},${1 + Math.floor(i / 3)}`}
                        label={`${o.level ? 'Upgrade' : 'Buy'} ${def.name}${o.level ? `, level ${o.level} of ${def.maxLevel}` : ''}${o.state === 'soon' ? ', coming soon' : ''}`}
                        onHover={() => setHover({ kind: 'item', id: def.id })}
                        onBuy={(e) => purchase(e, o.state, { kind: 'buyItem', item: def.id })}
                        slot={v.itemSlots[def.id]}
                      />
                    )
                  })}
                </div>
              </div>
              <DetailView detail={hover && hover.kind !== 'spell' ? detail : null} empty="Point at a mastery or item to see what the next level does." />
            </>
          )}
        </div>
      </aside>

      {/* ---------------- right dock: spells ---------------- */}
      <section ref={right} className="dock dock-right" aria-label="Shop">
        <div className="panel dock-panel flex flex-col">
          <header className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 pt-3.5 pb-2">
            <h2 className="display text-[2.4rem] leading-none">Shop</h2>
            <GoldCounter gold={v.gold} />
            <ShopClock />
            <Button size="sm" variant="ghost" sound={null} className="ml-auto" onClick={close}>
              Close <KeyCaps label={bindLabel(binds, 'shop')} />
            </Button>
          </header>
          {!v.open && (
            <p className="mx-4 mb-2 rounded-md bg-[rgba(255,140,60,0.1)] px-3 py-2 text-[0.98rem] font-semibold text-[#ffcf9a] ring-1 ring-[rgba(255,150,70,0.3)]" role="status">
              Shop opens between rounds. Look around now; buying unlocks in the next shop phase.
            </p>
          )}
          <div className="spell-grid min-h-0 flex-auto overflow-y-auto px-4 pb-3" onKeyDown={navKeys}>
            {COLUMNS.map((col, c) => {
              const owned = v.spells[c]
              const defs = SPELLS.filter((s) => s.column === c)
              return (
                <div key={col.name} className="flex min-w-0 flex-col gap-0.5" aria-label={`${col.name} column`}>
                  <div className="col-head mb-0.5 flex items-center justify-between gap-1 rounded pt-1" title={`${col.hint}. Drop an owned spell here to swap keys.`} {...slotDropProps(c)}>
                    <span className="truncate text-[0.98rem] font-bold" style={{ color: col.hue }}>
                      {col.name}
                    </span>
                    <Kbd>{slotKeyLabel(binds, c)}</Kbd>
                  </div>
                  {defs.map((def, r) => {
                    const o = spellOffer(def, owned, v.gold, v.open)
                    return (
                      <IconTile
                        key={def.id}
                        id={def.id}
                        name={def.name}
                        hue={col.hue}
                        offer={o}
                        size={68}
                        max={SPELL_MAX_LEVEL}
                        nav={`${c},${r}`}
                        label={`${def.name}${o.state === 'soon' ? ', coming soon' : o.owned ? `, level ${o.level} of ${SPELL_MAX_LEVEL}${o.price != null ? `, upgrade for ${o.price} gold` : ''}` : `, buy for ${def.buy} gold`}`}
                        onHover={() => setHover({ kind: 'spell', id: def.id })}
                        onBuy={(e) => purchase(e, o.state, { kind: 'buySpell', spell: def.id })}
                        slot={o.owned ? c : undefined}
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>
          <footer className="spell-detail border-t border-[rgba(255,170,100,0.12)] px-5 py-3" aria-live="polite">
            {spellHover ? (
              <SpellDetail
                def={spellHover}
                owned={v.spells[spellHover.column].id === spellHover.id ? v.spells[spellHover.column].level : 0}
                state={spellOfferOf(spellHover).state}
              />
            ) : (
              <p className="pt-1 text-[0.95rem] text-ash">Point at a spell for its numbers at every level. Click or press Enter to buy; arrow keys move between cards.</p>
            )}
          </footer>
        </div>
      </section>
    </>
  )
}
