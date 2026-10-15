import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { frame } from '../../game/frame'
import { input } from '../../game/input'
import { useGame } from '../../game/store'
import { TICK_HZ, type InputCommand, type SpellId } from '../../sim'
import { Sigil } from '../icons'
import {
  COLUMNS,
  ITEMS,
  MASTERIES,
  MASTERY_ALL_COST,
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
import { keyLabel, slotKeyLabel, useBinds } from '../lib/keys'
import { sfx } from '../lib/sound'
import { usePolled, useTick } from '../lib/ticker'
import { canBuyNow, localView } from '../lib/view'
import { Button, Kbd } from '../widgets'
import { CharacterBody } from './Overlays'
import { displayRound } from './TopBar'

/**
 * The shop: two docked panels at the screen edges so the arena center (your
 * warlock practicing) stays visible. Right: the six spell columns. Left:
 * masteries and items, or your stats (C / K). Opens by itself in the shop
 * phase, B toggles it, arrow keys walk the cards, Enter buys.
 */

type CardState = 'ok' | 'poor' | 'owned' | 'max' | 'soon' | 'locked' | 'full' | 'closed'

interface ShopView {
  ready: boolean
  gold: number
  /** owned spell per column 0..5 */
  spells: { id: SpellId | null; level: number }[]
  /** owned items by id -> level */
  items: Record<string, number>
  freeItemSlots: number
  masteries: Record<MasteryId, number>
  phase: string
  open: boolean
}

function readShop(): ShopView {
  const v = localView()
  const pawn = v?.pawn
  const items: Record<string, number> = {}
  let free = 0
  for (let i = 6; i < 12; i++) {
    const id = pawn?.slots[i]
    if (id) items[id] = pawn?.levels[i] ?? 1
    else free++
  }
  return {
    ready: !!pawn && !!v?.score,
    gold: Math.floor(v?.score?.gold ?? 0),
    spells: Array.from({ length: 6 }, (_, c) => ({ id: pawn?.slots[c] ?? null, level: pawn?.levels[c] ?? 0 })),
    items,
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
  return <span ref={ref} className="tabular text-[1.15rem] font-semibold text-[#f0d9b8] data-[hot=true]:text-[#ffb08f]" />
}

function cost(n: number | null, st: CardState) {
  return n == null ? null : (
    <span className={`cost flex items-center gap-1 text-[1rem] ${st === 'poor' ? 'text-[#ff8f7a]' : ''}`}>
      <span className="coin" aria-hidden />
      {n}
    </span>
  )
}

function DetailView({ detail, empty }: { detail: Detail | null; empty: string }) {
  return (
    <footer className="min-h-[92px] border-t border-[rgba(255,170,100,0.12)] px-5 py-3" aria-live="polite">
      {detail ? (
        <div className="flex gap-3.5">
          <Sigil id={detail.icon} size={48} hue={detail.hue} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-[1.2rem] font-bold" style={{ color: detail.hue }}>
                {detail.name}
              </span>
              {detail.level && detail.level.now > 0 && (
                <span className="text-sm text-ash">
                  level {detail.level.now} of {detail.level.max}
                </span>
              )}
              {detail.cost != null && (
                <span className="text-[0.95rem] text-ash">
                  {detail.costLabel} for <span className="cost">{detail.cost} gold</span>
                </span>
              )}
            </div>
            <p className="text-[0.98rem] leading-snug text-[#e6d3b8]">{detail.desc}</p>
            {detail.note && <p className="mt-0.5 text-[0.92rem] font-semibold text-[#ffb08f]">{detail.note}</p>}
          </div>
          {detail.stats.length > 0 && (
            <dl className="tabular grid shrink-0 grid-cols-[auto_auto] content-start gap-x-3 gap-y-0.5 text-[0.98rem]">
              {detail.stats.map((s) => (
                <div key={s.label} className="contents">
                  <dt className="text-ash">{s.label}</dt>
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
        <p className="pt-1 text-[0.95rem] text-ash">{empty}</p>
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

function Card({
  state,
  hue,
  nav,
  label,
  onBuy,
  onHover,
  className = '',
  children,
}: {
  state: CardState
  hue: string
  nav: string
  label: string
  onBuy: (e: ReactMouseEvent<HTMLElement>) => void
  onHover: () => void
  className?: string
  children: ReactNode
}) {
  const disabled = state === 'soon' || state === 'locked' || state === 'closed'
  return (
    <button
      type="button"
      className={`shop-card spell-card ${className}`}
      style={{ ['--hue' as string]: hue }}
      data-state={state}
      data-nav={nav}
      aria-disabled={disabled}
      aria-label={label}
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onBuy}
    >
      {children}
    </button>
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

  // ---- spells ----------------------------------------------------------
  const spellState = (def: ShopSpell): CardState => {
    if (!def.implemented) return 'soon'
    if (!v.open) return 'closed'
    const col = v.spells[def.column]
    if (col.id && col.id !== def.id) return 'locked'
    if (col.id === def.id) {
      if (col.level >= SPELL_MAX_LEVEL) return 'max'
      return v.gold >= def.upgrades[col.level - 1] ? 'ok' : 'poor'
    }
    return v.gold >= def.buy ? 'ok' : 'poor'
  }
  const spellDetail = (def: ShopSpell): Detail => {
    const owned = v.spells[def.column].id === def.id ? v.spells[def.column].level : 0
    const next = Math.min(SPELL_MAX_LEVEL, owned + 1)
    return {
      name: def.name,
      hue: COLUMNS[def.column].hue,
      icon: def.id,
      desc: def.desc,
      cost: owned === 0 ? def.buy : owned >= SPELL_MAX_LEVEL ? null : def.upgrades[owned - 1],
      costLabel: owned === 0 ? 'Buy' : `Level ${next}`,
      stats: diffStats(owned ? levelStats(def.id, owned) : null, levelStats(def.id, next)),
      note: stateNote(spellState(def)) ?? (owned === 0 ? 'One spell per column, kept for the whole match.' : undefined),
      level: { now: owned, max: SPELL_MAX_LEVEL },
    }
  }

  // ---- items -----------------------------------------------------------
  const itemState = (def: ShopItem): CardState => {
    const owned = v.items[def.id] ?? 0
    if (!def.implemented) return 'soon'
    if (!v.open) return 'closed'
    if (owned >= def.maxLevel) return 'max'
    if (owned === 0 && v.freeItemSlots === 0) return 'full'
    return v.gold >= def.cost ? 'ok' : 'poor'
  }
  const itemDetail = (def: ShopItem): Detail => {
    const owned = v.items[def.id] ?? 0
    const next = Math.min(def.maxLevel, owned + 1)
    return {
      name: def.name,
      hue: hueFor(def.id),
      icon: def.id,
      desc: def.desc,
      cost: owned >= def.maxLevel ? null : def.cost,
      costLabel: owned === 0 ? 'Buy' : `Level ${next}`,
      stats: diffStats(owned ? levelStats(def.id, owned) : null, levelStats(def.id, next)),
      note: stateNote(itemState(def)),
      level: def.maxLevel > 1 ? { now: owned, max: def.maxLevel } : undefined,
    }
  }

  // ---- masteries -------------------------------------------------------
  const anyMaxed = MASTERIES.some((m) => v.masteries[m.id] >= MASTERY_MAX_LEVEL)
  const masteryState = (id: MasteryId | 'all'): CardState => {
    if (!v.open) return 'closed'
    if (id === 'all') return anyMaxed ? 'max' : v.gold >= MASTERY_ALL_COST ? 'ok' : 'poor'
    if (v.masteries[id] >= MASTERY_MAX_LEVEL) return 'max'
    return v.gold >= MASTERY_COST ? 'ok' : 'poor'
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
        cost: anyMaxed ? null : MASTERY_ALL_COST,
        costLabel: 'Buy',
        stats: MASTERIES.map((m) => ({ label: m.name, from: fmtMastery(m.id, v.masteries[m.id]), to: fmtMastery(m.id, Math.min(MASTERY_MAX_LEVEL, v.masteries[m.id] + 1)) })),
        note: stateNote(masteryState('all')),
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
      note: stateNote(masteryState(id)),
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

  return (
    <>
      {/* ---------------- left dock: masteries + items, or stats ---------------- */}
      <aside className="dock dock-left" aria-label={characterOpen ? 'Your warlock' : 'Masteries and items'}>
        <div className="panel flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 px-4 pt-3.5 pb-2" role="tablist">
            <button type="button" role="tab" className="tab" aria-selected={!characterOpen} onClick={() => toggle('characterOpen', false)}>
              Gear
            </button>
            <button type="button" role="tab" className="tab flex items-center gap-1.5" aria-selected={characterOpen} onClick={() => toggle('characterOpen', true)}>
              Stats <Kbd>{keyLabel(binds.character)}</Kbd>
            </button>
          </div>
          {characterOpen ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <CharacterBody />
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3" onKeyDown={navKeys}>
                <h3 className="mb-1.5 text-[1.05rem] font-bold text-[#ffd890]">Masteries</h3>
                <div className="flex flex-col gap-1.5">
                  {MASTERIES.map((m, i) => {
                    const st = masteryState(m.id)
                    return (
                      <Card
                        key={m.id}
                        state={st === 'max' ? 'owned' : st}
                        hue={MASTERY_HUE}
                        nav={`0,${i}`}
                        label={`${m.name} mastery, level ${v.masteries[m.id]} of ${MASTERY_MAX_LEVEL}`}
                        onHover={() => setHover({ kind: 'mastery', id: m.id })}
                        onBuy={(e) => purchase(e, st, { kind: 'buyMastery', mastery: m.id })}
                        className="flex items-center gap-2.5 px-2.5 py-2"
                      >
                        <Sigil id={m.id} size={32} />
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="text-[1rem] font-semibold">{m.name}</span>
                            <span className="tabular text-sm text-ash">{fmtMastery(m.id, v.masteries[m.id])}</span>
                          </span>
                          <LevelBars level={v.masteries[m.id]} max={MASTERY_MAX_LEVEL} />
                        </span>
                        {st !== 'max' && cost(MASTERY_COST, st)}
                      </Card>
                    )
                  })}
                  {(() => {
                    const st = masteryState('all')
                    return (
                      <Card
                        state={st === 'max' ? 'locked' : st}
                        hue={MASTERY_HUE}
                        nav="0,3"
                        label="Raise all three masteries"
                        onHover={() => setHover({ kind: 'mastery', id: 'all' })}
                        onBuy={(e) => purchase(e, st, { kind: 'buyMastery', mastery: 'all' })}
                        className="flex items-center gap-2.5 px-2.5 py-2"
                      >
                        <Sigil id="all" size={32} />
                        <span className="flex-1 text-[1rem] font-semibold">All three</span>
                        {st !== 'max' && cost(MASTERY_ALL_COST, st)}
                      </Card>
                    )
                  })()}
                </div>

                <h3 className="mt-4 mb-1.5 flex items-baseline justify-between text-[1.05rem] font-bold text-[#ffd890]">
                  Items <span className="text-sm font-medium text-ash">{v.freeItemSlots} free slots</span>
                </h3>
                <div className="grid grid-cols-2 gap-1.5">
                  {ITEMS.map((def, i) => {
                    const st = itemState(def)
                    const lvl = v.items[def.id] ?? 0
                    return (
                      <Card
                        key={def.id}
                        state={lvl > 0 && st !== 'poor' ? 'owned' : st}
                        hue={hueFor(def.id)}
                        nav={`${i % 2},${4 + Math.floor(i / 2)}`}
                        label={`${lvl ? 'Upgrade' : 'Buy'} ${def.name}${lvl ? `, level ${lvl} of ${def.maxLevel}` : ''}`}
                        onHover={() => setHover({ kind: 'item', id: def.id })}
                        onBuy={(e) => purchase(e, st, { kind: 'buyItem', item: def.id })}
                        className="flex flex-col gap-1 p-2"
                      >
                        <span className="flex items-center gap-1.5">
                          <Sigil id={def.id} size={26} />
                          <span className="min-w-0 flex-1 truncate text-[0.92rem] leading-tight font-semibold">{def.name}</span>
                        </span>
                        <span className="flex h-4 items-center justify-between gap-1">
                          {st === 'soon' ? (
                            <span className="text-[0.78rem] text-ash">Soon</span>
                          ) : def.maxLevel > 1 ? (
                            <LevelBars level={lvl} max={def.maxLevel} />
                          ) : lvl ? (
                            <span className="text-[0.78rem] text-gold">Owned</span>
                          ) : (
                            <span />
                          )}
                          {st !== 'soon' && st !== 'max' && cost(def.cost, st)}
                        </span>
                      </Card>
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
        <div className="panel flex min-h-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 pt-3.5 pb-2">
            <h2 className="display text-[2.4rem] leading-none text-[#ffd890]">Shop</h2>
            <GoldCounter gold={v.gold} />
            <ShopClock />
            <Button size="sm" variant="ghost" sound={null} className="ml-auto" onClick={close}>
              Close <Kbd>{keyLabel(binds.shop)}</Kbd>
            </Button>
          </header>
          {!v.open && (
            <p className="mx-4 mb-2 rounded-md bg-[rgba(255,140,60,0.1)] px-3 py-2 text-[0.98rem] font-semibold text-[#ffcf9a] ring-1 ring-[rgba(255,150,70,0.3)]" role="status">
              Shop opens between rounds. Look around now; buying unlocks in the next shop phase.
            </p>
          )}
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-6 gap-2 overflow-y-auto px-4 pb-3" onKeyDown={navKeys}>
            {COLUMNS.map((col, c) => {
              const owned = v.spells[c]
              const defs = SPELLS.filter((s) => s.column === c)
              const mine = defs.find((d) => d.id === owned.id)
              return (
                <div key={col.name} className="flex min-w-0 flex-col gap-1.5" aria-label={`${col.name} column`}>
                  <div className="flex items-center justify-between gap-1 pt-1" title={col.hint}>
                    <span className="truncate text-[0.98rem] font-bold" style={{ color: col.hue }}>
                      {col.name}
                    </span>
                    <Kbd>{slotKeyLabel(binds, c)}</Kbd>
                  </div>
                  {mine ? (
                    <>
                      {(() => {
                        const st = spellState(mine)
                        const next = owned.level >= SPELL_MAX_LEVEL ? null : mine.upgrades[owned.level - 1]
                        return (
                          <Card
                            state={st === 'poor' ? 'poor' : 'owned'}
                            hue={col.hue}
                            nav={`${c},0`}
                            label={`${mine.name}, level ${owned.level} of ${SPELL_MAX_LEVEL}. ${next == null ? 'Max level' : `Upgrade for ${next} gold`}`}
                            onHover={() => setHover({ kind: 'spell', id: mine.id })}
                            onBuy={(e) => purchase(e, st, { kind: 'buySpell', spell: mine.id })}
                            className="flex flex-col items-center gap-1.5 px-1.5 pt-3 pb-2 text-center"
                          >
                            <Sigil id={mine.id} size={48} />
                            <span className="w-full truncate text-[1.02rem] font-bold">{mine.name}</span>
                            <LevelBars level={owned.level} max={SPELL_MAX_LEVEL} big />
                            {next == null ? (
                              <span className="text-[0.82rem] font-semibold text-gold">Max level</span>
                            ) : (
                              <span className="flex items-center gap-1 text-[0.85rem] text-ash">Upgrade {cost(next, st)}</span>
                            )}
                          </Card>
                        )
                      })()}
                      {defs
                        .filter((d) => d !== mine)
                        .map((d) => (
                          <div key={d.id} className="flex items-center gap-1.5 px-1.5 py-0.5 opacity-30" aria-hidden title={`${d.name} (column taken)`}>
                            <Sigil id={d.id} size={20} dim />
                            <span className="truncate text-[0.85rem]">{d.name}</span>
                          </div>
                        ))}
                    </>
                  ) : (
                    defs.map((def, r) => {
                      const st = spellState(def)
                      return (
                        <Card
                          key={def.id}
                          state={st}
                          hue={col.hue}
                          nav={`${c},${r}`}
                          label={`${def.name}${st === 'soon' ? ', coming soon' : `, buy for ${def.buy} gold`}`}
                          onHover={() => setHover({ kind: 'spell', id: def.id })}
                          onBuy={(e) => purchase(e, st, { kind: 'buySpell', spell: def.id })}
                          className="flex flex-col gap-0.5 px-1 pt-1.5 pb-1"
                        >
                          <span className="flex items-center gap-1">
                            <span className="icon-wrap shrink-0">
                              <Sigil id={def.id} size={22} />
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[0.88rem] leading-tight font-semibold">{def.name}</span>
                          </span>
                          <span className="flex h-4 items-center justify-end">{st === 'soon' ? <span className="text-[0.78rem] text-ash">Soon</span> : cost(def.buy, st)}</span>
                        </Card>
                      )
                    })
                  )}
                </div>
              )
            })}
          </div>
          <DetailView
            detail={hover?.kind === 'spell' ? detail : null}
            empty="Point at a spell for exact numbers. Click or press Enter to buy; arrow keys move between cards."
          />
        </div>
      </section>
    </>
  )
}
