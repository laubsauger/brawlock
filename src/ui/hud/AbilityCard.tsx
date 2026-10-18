import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { SpellId } from '../../sim'
import { Sigil } from '../icons'
import { COLUMNS, MASTERIES, MASTERY_COST, MASTERY_HUE, MASTERY_MAX_LEVEL, displayName, hueFor, isPassive, itemDef, masteryValue, spellDef, type MasteryId } from '../data/catalog'
import { abilityDelta, maxLevelOf, type StatDelta } from '../data/abilityStats'
import { slotKeyLabel, useBinds } from '../lib/keys'
import { usePolled } from '../lib/ticker'
import { localView } from '../lib/view'
import { Kbd } from '../widgets'
import { hasClip, loadMediaIndex, posterUrl, saveData, showClip, stopClip } from '../lib/abilityMedia'
import { readShop } from './shopView'
import { itemOffer, masteryAllOffer, masteryOffer, spellOffer, type Offer, type OfferState } from './shopOffers'

/**
 * Hover card for spells, items and masteries: icon, name, role, level, the
 * key numbers at that level (sim data via abilityStats) and a short
 * description. In the shop it also shows what the next level changes and
 * the price. One card for the whole match screen, portaled to <body>,
 * placed so it never covers what you point at and never leaves the screen.
 *
 * Timing: appears after SHOW_DELAY_MS; moving straight to another card
 * switches content at once (no delay, no flicker); leaving hides it after a
 * short grace.
 */

export type CardKind = 'spell' | 'item' | 'mastery'
/** where the card goes relative to the anchor: above it (HUD), or beside the dock edge (shop) */
/** top: above the anchor; left / right: beside the shop dock edge; bar: beside the HUD spell bar */
export type CardSide = 'top' | 'left' | 'right' | 'bar'

export interface CardTarget {
  kind: CardKind
  id: string
  /** shop: offers and next level; hud: your hotbar; inspect: another warlock's kit (level given) */
  context: 'shop' | 'hud' | 'inspect'
  /** hotbar slot (HUD): its key cap and live level */
  slot?: number
  /** inspect: that warlock's level of it */
  level?: number
  side: CardSide
  /** anchor rect and the edge to sit beside (viewport px), read once on hover */
  anchor: { left: number; top: number; right: number; bottom: number }
  edge: number
  /** side 'bar': the HUD plate the card sits beside (viewport px) */
  bar?: { left: number; top: number; right: number; bottom: number }
}

const SHOW_DELAY_MS = 150
const HIDE_GRACE_MS = 90
const GAP = 10
const MARGIN = 8
/** px kept free at the top for the clock and score row (when the card fits below it) */
const TOP_HUD = 64

let target: CardTarget | null = null
const subs = new Set<() => void>()
let showTimer = 0
let hideTimer = 0

function set(t: CardTarget | null) {
  target = t
  for (const s of subs) s()
}

function subscribe(l: () => void) {
  subs.add(l)
  return () => subs.delete(l)
}

/** Hide the card at once (drag start, panel closing). */
export function hideAbilityCard() {
  window.clearTimeout(showTimer)
  window.clearTimeout(hideTimer)
  if (target) set(null)
}

function rectOf(el: Element) {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

/**
 * Props for an element that shows a card on hover or keyboard focus.
 * `edgeOf`: element whose side the card sits beside (the dock), else the element itself.
 */
export function abilityCardProps(get: () => Omit<CardTarget, 'anchor' | 'edge'> | null) {
  const open = (el: HTMLElement) => {
    const t = get()
    if (!t) return
    // the clip index loads on the first hover, while the card's show delay runs
    if (t.kind !== 'mastery') void loadMediaIndex()
    window.clearTimeout(hideTimer)
    window.clearTimeout(showTimer)
    const anchor = rectOf(el)
    const dock = el.closest('.dock, .inspect-card, [aria-label="Scoreboard"]')
    const d = dock ? rectOf(dock) : anchor
    const plate = t.side === 'bar' ? el.closest('.hud-bottom') : null
    const next: CardTarget = { ...t, anchor, edge: t.side === 'left' ? d.left : t.side === 'right' ? d.right : anchor.top, ...(plate ? { bar: rectOf(plate) } : null) }
    // already showing a card: switch right away so moving along a row never blinks
    if (target) set(next)
    else showTimer = window.setTimeout(() => set(next), SHOW_DELAY_MS)
  }
  const close = () => {
    window.clearTimeout(showTimer)
    window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => set(null), HIDE_GRACE_MS)
  }
  return {
    onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === 'touch' || e.buttons) return
      open(e.currentTarget)
    },
    onPointerLeave: close,
    onFocus: (e: FocusEvent<HTMLElement>) => open(e.currentTarget),
    onBlur: close,
  }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

interface CardModel {
  icon: string
  name: string
  hue: string
  /** role line: shop column, "Item", "Passive item", "Mastery" */
  role: string
  roleHint?: string
  level: number
  max: number
  passive: boolean
  stats: StatDelta[]
  desc: string
  /** shop: what clicking does and what it costs, or why it can't */
  action?: { text: string; price: number | null; tone: 'ok' | 'muted' | 'warn' }
  keyLabel?: string
}

function stateText(state: OfferState): string | null {
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
      return null
  }
}

function actionOf(o: Offer): CardModel['action'] {
  const why = stateText(o.state)
  if (o.state === 'ok' || o.state === 'poor') {
    const text = o.level === 0 ? 'Buy' : `Upgrade to level ${o.level + 1}`
    return { text: o.state === 'poor' ? `${text}: not enough gold` : text, price: o.price, tone: o.state === 'ok' ? 'ok' : 'warn' }
  }
  return why ? { text: why, price: null, tone: o.state === 'max' ? 'muted' : 'warn' } : undefined
}

const pct = (id: MasteryId, lvl: number) => {
  const v = masteryValue(id, lvl)
  return id === 'lifesteal' ? `${Math.round(v * 100)}%` : `+${Math.round((v - 1) * 100)}%`
}

function modelFor(t: CardTarget, keyOf: (slot: number) => string): CardModel | null {
  const view = localView()
  const rangeLvl = view?.score?.masteries.range ?? 0
  if (t.kind === 'mastery') {
    const shop = readShop()
    if (t.id === 'all') {
      const o = masteryAllOffer(MASTERIES.map((m) => shop.masteries[m.id]), shop.gold, shop.open)
      return {
        icon: 'all',
        name: 'All three masteries',
        hue: MASTERY_HUE,
        role: 'Mastery bundle',
        level: 0,
        max: 0,
        passive: false,
        stats: MASTERIES.map((m) => {
          const lvl = shop.masteries[m.id]
          return { label: m.name, value: pct(m.id, lvl), next: lvl < MASTERY_MAX_LEVEL ? pct(m.id, lvl + 1) : undefined }
        }),
        desc: 'One level of every mastery for less than buying them one by one.',
        action: actionOf(o),
      }
    }
    const m = MASTERIES.find((x) => x.id === t.id)
    if (!m) return null
    const lvl = shop.masteries[m.id]
    const o = masteryOffer(lvl, shop.gold, shop.open)
    return {
      icon: m.id,
      name: `${m.name} mastery`,
      hue: MASTERY_HUE,
      role: 'Mastery',
      level: lvl,
      max: MASTERY_MAX_LEVEL,
      passive: false,
      stats: [{ label: m.name, value: pct(m.id, lvl), next: lvl < MASTERY_MAX_LEVEL ? pct(m.id, lvl + 1) : undefined }],
      desc: m.desc,
      action: o.price != null || o.state !== 'ok' ? actionOf({ ...o, price: o.price ?? MASTERY_COST }) : undefined,
    }
  }

  const id = t.id as SpellId
  const sDef = spellDef(id)
  const iDef = itemDef(id)
  const max = maxLevelOf(id)
  let level = 0
  let action: CardModel['action']
  if (t.context === 'inspect') {
    level = t.level ?? 1
  } else if (t.context === 'hud' && t.slot != null) {
    level = view?.pawn?.levels[t.slot] ?? 1
  } else {
    const shop = readShop()
    if (sDef) {
      const o = spellOffer(sDef, shop.spells[sDef.column], shop.gold, shop.open)
      level = o.owned ? o.level : 0
      action = actionOf(o)
    } else if (iDef) {
      const o = itemOffer(iDef, shop.items[id] ?? 0, shop.gold, shop.open, shop.freeItemSlots)
      level = o.level
      action = actionOf(o)
    }
  }
  const passive = isPassive(id)
  const col = sDef ? COLUMNS[sDef.column] : null
  return {
    icon: id,
    name: displayName(id),
    hue: hueFor(id),
    role: col ? col.name : passive ? 'Passive item' : 'Item',
    roleHint: col?.hint,
    level,
    max,
    passive,
    // shop: the next level's change; HUD: just what you have now
    stats: t.context === 'shop' ? abilityDelta(id, level, max, rangeLvl) : abilityDelta(id, level, level, rangeLvl),
    desc: sDef?.desc ?? iDef?.desc ?? '',
    action,
    keyLabel: t.slot != null && !passive && t.context === 'hud' ? keyOf(t.slot) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Card position for a size: beside the dock edge or above the anchor, flipped and clamped to the viewport. */
export function placeCard(t: Pick<CardTarget, 'side' | 'anchor' | 'edge' | 'bar'>, w: number, h: number, vw: number, vh: number): { x: number; y: number } {
  const clampX = (x: number) => Math.min(Math.max(MARGIN, x), vw - w - MARGIN)
  // stay below the clock and score row when the screen is tall enough for it
  const top = Math.max(MARGIN, Math.min(TOP_HUD, vh - h - MARGIN))
  const clampY = (y: number) => Math.min(Math.max(top, y), vh - h - MARGIN)
  const a = t.anchor
  const midY = (a.top + a.bottom) / 2
  if (t.side === 'bar' && t.bar) {
    // beside the HUD plate, bottoms level, so the arena centre stays clear: left of it, else right;
    // a plate tucked into the corner (HUD layout "right") would push the card over the centre, so
    // then it goes above the plate, flush with its right edge
    const b = t.bar
    const y = clampY(b.bottom - h)
    const clear = (x: number) => !(x < vw / 2 && vw / 2 < x + w && y < vh / 2 && vh / 2 < y + h)
    const leftX = b.left - GAP - w
    const rightX = b.right + GAP
    if (leftX >= MARGIN && clear(leftX)) return { x: leftX, y }
    if (rightX + w <= vw - MARGIN && clear(rightX)) return { x: rightX, y }
    const aboveY = b.top - GAP - h
    if (aboveY >= top) return { x: clampX(b.right - w), y: aboveY }
    if (leftX >= MARGIN) return { x: leftX, y }
  }
  if (t.side === 'left' || t.side === 'right') {
    // beside the dock, level with the card; flip to the other side if there is no room
    const leftX = t.edge - GAP - w
    const rightX = t.edge + GAP
    const fitsLeft = leftX >= MARGIN
    const fitsRight = rightX + w <= vw - MARGIN
    const x = t.side === 'left' ? (fitsLeft ? leftX : fitsRight ? rightX : null) : fitsRight ? rightX : fitsLeft ? leftX : null
    if (x !== null) return { x, y: clampY(midY - h / 2) }
  }
  // above the anchor, else below it; horizontally centred on it
  const x = clampX((a.left + a.right) / 2 - w / 2)
  const above = a.top - GAP - h
  if (above >= MARGIN) return { x, y: above }
  const below = a.bottom + GAP
  if (below + h <= vh - MARGIN) return { x, y: below }
  return { x, y: clampY(above) }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function Pips({ level, max }: { level: number; max: number }) {
  return (
    <span className="lvl-bars" aria-hidden>
      {Array.from({ length: max }, (_, i) => (
        <i key={i} data-on={i < level} />
      ))}
    </span>
  )
}

/**
 * The card's preview: the poster at once, the shared clip over it once it
 * plays (Save-Data: poster only). No entry in the clip index, or nothing
 * loads: the slot collapses rather than showing a broken box.
 */
function AbilityMedia({ id }: { id: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [listed, setListed] = useState<boolean | undefined>(() => hasClip(id))
  const [posterOk, setPosterOk] = useState(true)
  const [clipOk, setClipOk] = useState(true)
  useEffect(() => {
    let alive = true
    void loadMediaIndex().then((ids) => alive && setListed(ids.has(id)))
    return () => {
      alive = false
    }
  }, [id])
  useEffect(() => {
    const el = box.current
    if (!listed || !el || saveData()) return
    showClip(el, id, () => setClipOk(false))
    // card hidden or switched: pause, drop the clip, free the decoder
    return () => stopClip()
  }, [id, listed])
  if (listed === false || (!posterOk && (!clipOk || saveData()))) return null
  return (
    <div ref={box} className="ability-media">
      {posterOk && <img src={posterUrl(id)} width={300} height={169} loading="lazy" decoding="async" alt="" onError={() => setPosterOk(false)} />}
    </div>
  )
}

/** The match screen's single ability card (mount once). */
export function AbilityCardHost() {
  const t = useSyncExternalStore(subscribe, () => target)
  // pressing a HUD slot starts a drag or a key capture: the card gets out of the way
  // (shop cards stay up while you click to buy, so the new level shows at once)
  useEffect(() => {
    if (t?.context !== 'hud') return
    const onDown = () => hideAbilityCard()
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [t?.context])
  if (!t) return null
  // keyed by what it shows: a new target mounts fresh, so it never shows the previous card's numbers
  return createPortal(<Card key={`${t.kind}:${t.id}:${t.slot ?? ''}:${t.context}:${t.level ?? ''}`} t={t} />, document.body)
}

function Card({ t }: { t: CardTarget }) {
  const binds = useBinds()
  // live: buying or levelling up while the card is open updates it
  const model = usePolled(
    () => modelFor(t, (s) => slotKeyLabel(binds, s)),
    (m) => JSON.stringify(m),
    8,
  )
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  // measure once per target / content change (hover only, never per frame)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const p = placeCard(t, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight)
    setPos((old) => (old && Math.abs(old.x - p.x) < 0.5 && Math.abs(old.y - p.y) < 0.5 ? old : p))
  }, [t, model])
  if (!model) return null
  const levelText = model.max > 1 ? (model.level > 0 ? `Level ${model.level} of ${model.max}` : `${model.max} levels`) : null
  return (
    <div
      ref={ref}
      className="ability-card panel pointer-events-none fixed top-0 left-0 z-[80]"
      style={{ ['--hue' as string]: model.hue, transform: pos ? `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)` : undefined, visibility: pos ? 'visible' : 'hidden' }}
      role="tooltip"
      data-ability-card={model.icon}
    >
      {/* preview clip: full card width, fixed 300x169 box (no layout shift), masteries have none */}
      {t.kind !== 'mastery' && <AbilityMedia id={model.icon} />}
      <header className="ability-card-head">
        <span className="tile-icon shrink-0" style={{ width: 48, height: 48 }}>
          <Sigil id={model.icon} size={42} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="ability-card-name truncate" style={{ color: model.hue }}>
              {model.name}
            </span>
            {model.keyLabel && <Kbd>{model.keyLabel}</Kbd>}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-[0.8rem] leading-tight text-ash">
            <span className={model.passive ? 'font-semibold text-[#bfe3ff]' : 'font-semibold'}>{model.role}</span>
            {model.roleHint && <span className="truncate">{model.roleHint}</span>}
          </div>
          {levelText && (
            <div className="mt-0.5 flex items-center gap-2 text-[0.8rem] text-ash">
              {model.max > 1 && <Pips level={model.level} max={model.max} />}
              <span>{levelText}</span>
            </div>
          )}
        </div>
      </header>
      {model.stats.length > 0 && (
        <dl className="ability-card-stats tabular">
          {model.stats.map((s) => (
            <div key={s.label} className="contents">
              <dt>{s.label}</dt>
              <dd>
                {s.next !== undefined ? (
                  <>
                    <span className="text-ash">{s.value}</span> <span className="text-ember">›</span> <span className="text-heal">{s.next}</span>
                  </>
                ) : (
                  s.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {model.desc && <p className="ability-card-desc">{model.desc}</p>}
      {model.action && (
        <p className={`ability-card-action ${model.action.tone === 'ok' ? 'text-[#ffe0ad]' : model.action.tone === 'warn' ? 'text-[#ffb08f]' : 'text-ash'}`}>
          {model.action.text}
          {model.action.price != null && (
            <span className="cost ml-auto inline-flex items-center gap-1">
              <span className="coin" aria-hidden />
              {model.action.price}
            </span>
          )}
        </p>
      )}
    </div>
  )
}
