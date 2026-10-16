import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { frame } from '../../game/frame'
import { input } from '../../game/input'
import { useGame } from '../../game/store'
import { TICK_HZ, type InputCommand } from '../../sim'
import { Sigil } from '../icons'
import {
  COLUMNS,
  ITEMS,
  MASTERIES,
  MASTERY_MAX_LEVEL,
  MASTERY_HUE,
  SPELL_MAX_LEVEL,
  SPELLS,
  hueFor,
  isPassive,
  type MasteryId,
  type ShopItem,
} from '../data/catalog'
import { bindLabel, slotKeyLabel, useBinds } from '../lib/keys'
import { sfx } from '../lib/sound'
import { usePolled, useTick } from '../lib/ticker'
import { canBuyNow } from '../lib/view'
import { useMedia } from '../lib/media'
import { abilityCardProps, hideAbilityCard } from './AbilityCard'
import { Button, Kbd, KeyCaps } from '../widgets'
import { CharacterBody } from './Overlays'
import { displayRound } from './TopBar'
import { slotDragProps, slotDropProps } from '../lib/slotDnd'
import { itemOffer, masteryAllOffer, masteryOffer, spellOffer, type Offer, type OfferState } from './shopOffers'
import { readShop } from './shopView'

/**
 * The shop: two docked panels at the screen edges so the arena center (your
 * warlock practicing) stays visible. Right: the six spell columns. Left:
 * masteries and items, or your stats (C / K). Opens by itself in the shop
 * phase, B toggles it, arrow keys walk the cards, Enter buys.
 */

type CardState = OfferState

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
    <span className={`lvl-bars ${big ? 'big' : ''}`} role="img" aria-label={`Level ${level} of ${max}`} style={level > 0 ? undefined : { visibility: 'hidden' }}>
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
          {d.n > 0 ? `+${d.n}` : `−${-d.n}`}
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
  card,
  slot,
  passive = false,
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
  /** hover / focus handlers for the ability card */
  card: ReturnType<typeof abilityCardProps>
  /** hotbar slot of an owned spell / item: drag onto another to swap their keys */
  slot?: number
  /** passive item: round frame, "Passive" label */
  passive?: boolean
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
      data-passive={passive}
      data-nav={nav}
      aria-disabled={disabled}
      aria-label={label}
      {...card}
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
      {passive && <span className="tile-kind">Passive</span>}
      {/* the pip row is always there (empty until bought): buying never changes a tile's height */}
      {max > 1 && <LevelBars level={offer.level} max={max} />}
    </button>
  )
}

export function Shop() {
  const v = usePolled(readShop, (x) => JSON.stringify(x), 10)
  const binds = useBinds()
  const characterOpen = useGame((s) => s.characterOpen)
  const toggle = useGame((s) => s.toggle)
  // shorter screens: denser tiles so the tallest spell column fits without scrolling
  const compact = useMedia('(max-height: 820px)')
  // closing the shop never leaves a card floating
  useEffect(() => () => hideAbilityCard(), [])
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
  const itemOfferOf = (def: ShopItem) => itemOffer(def, v.items[def.id] ?? 0, v.gold, v.open, v.freeItemSlots)
  const masteryOfferOf = (id: MasteryId | 'all') =>
    id === 'all' ? masteryAllOffer(MASTERIES.map((m) => v.masteries[m.id]), v.gold, v.open) : masteryOffer(v.masteries[id], v.gold, v.open)

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
                        size={compact ? 50 : 58}
                        max={MASTERY_MAX_LEVEL}
                        nav={`${i},0`}
                        label={`${m.name} mastery, level ${o.level} of ${MASTERY_MAX_LEVEL}${o.price != null ? `, next level ${o.price} gold` : ''}`}
                        card={abilityCardProps(() => ({ kind: 'mastery', id: m.id, context: 'shop', side: 'right' }))}
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
                        size={compact ? 50 : 58}
                        nav="3,0"
                        label={`Raise all three masteries${o.price != null ? ` for ${o.price} gold` : ''}`}
                        card={abilityCardProps(() => ({ kind: 'mastery', id: 'all', context: 'shop', side: 'right' }))}
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
                        size={compact ? 52 : 62}
                        max={def.maxLevel}
                        nav={`${i % 3},${1 + Math.floor(i / 3)}`}
                        label={`${o.level ? 'Upgrade' : 'Buy'} ${def.name}${o.level ? `, level ${o.level} of ${def.maxLevel}` : ''}${o.state === 'soon' ? ', coming soon' : ''}`}
                        card={abilityCardProps(() => ({ kind: 'item', id: def.id, context: 'shop', side: 'right' }))}
                        onBuy={(e) => purchase(e, o.state, { kind: 'buyItem', item: def.id })}
                        slot={v.itemSlots[def.id]}
                        passive={isPassive(def.id)}
                      />
                    )
                  })}
                </div>
              </div>
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
                  {/* key first, then the column it casts: "Q Knockout", never read as the next column's key */}
                  <div className="col-head mb-0.5 flex items-center gap-1.5 rounded pt-1" title={`${col.hint}. Drop an owned spell here to swap keys.`} {...slotDropProps(c)}>
                    <Kbd>{slotKeyLabel(binds, c)}</Kbd>
                    <span className="truncate text-[0.98rem] font-bold" style={{ color: col.hue }}>
                      {col.name}
                    </span>
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
                        size={compact ? 56 : 68}
                        max={SPELL_MAX_LEVEL}
                        nav={`${c},${r}`}
                        label={`${def.name}${o.state === 'soon' ? ', coming soon' : o.owned ? `, level ${o.level} of ${SPELL_MAX_LEVEL}${o.price != null ? `, upgrade for ${o.price} gold` : ''}` : `, buy for ${def.buy} gold`}`}
                        card={abilityCardProps(() => ({ kind: 'spell', id: def.id, context: 'shop', side: 'left' }))}
                        onBuy={(e) => purchase(e, o.state, { kind: 'buySpell', spell: def.id })}
                        slot={o.owned ? c : undefined}
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>
          <p className="shop-hint px-5 pt-1 pb-2.5 text-[0.82rem] text-ash">Point at a card for its numbers. Click or Enter buys; arrow keys move between cards.</p>
        </div>
      </section>
    </>
  )
}
