import { useEffect, useRef, useState } from 'react'
import { frame } from '../../game/frame'
import { OMEN_INFO, REACTION_INFO, type ReactionId } from '../../game/wild'
import { TICK_HZ, type OmenId } from '../../sim'
import { safeLocalStorage } from '../../game/profile'
import { usePolled, useTick } from '../lib/ticker'
import { OmenGlyph } from '../icons'

/**
 * Wild's HUD (docs/moonshot/specs/wild.md): the omen card that turns over in the 3-2-1 countdown
 * and flies off when the fight starts, the badge under the clock for the rest of the round, and
 * a discovery card the first time this browser sees each spell reaction.
 */

/** the card turns over this long before the fight (the countdown) */
const REVEAL_SECONDS = 3.5

const readOmen = () => frame.curr?.omen ?? null

export function OmenReveal() {
  const omen = usePolled<OmenId | null>(readOmen, String, 4)
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef('off')
  useTick(() => {
    const s = frame.curr
    const el = ref.current
    if (!s || !el) return
    const prev = last.current
    const next = !s.omen ? 'off'
      : s.phase === 'shop' && s.phaseTicksLeft <= REVEAL_SECONDS * TICK_HZ ? 'reveal'
      // it leaves only once it was shown (a late join mid-fight gets the badge alone)
      : s.phase === 'fight' && prev !== 'off' ? 'leave'
      : 'off'
    if (next !== prev) el.dataset.state = last.current = next
  })
  const info = omen ? OMEN_INFO[omen] : null
  return (
    <div ref={ref} className="omen-card" data-state="off" data-testid="omen-card" data-omen={omen ?? undefined} aria-hidden={!info} style={{ ['--omen' as string]: info?.color ?? '#ffb347' }}>
      {info && <div className="omen-card-face">
        <OmenGlyph id={omen!} size={54} color={info.color} />
        <div className="omen-card-name">{info.name}</div>
        <div className="omen-card-rule">{info.rule}</div>
      </div>}
    </div>
  )
}

const readBadge = () => {
  const s = frame.curr
  return s?.omen && (s.phase === 'shop' || s.phase === 'fight' || s.phase === 'roundEnd') ? s.omen : null
}

/** The round's omen under the clock. */
export function OmenBadge() {
  const omen = usePolled<OmenId | null>(readBadge, String, 4)
  if (!omen) return null
  const info = OMEN_INFO[omen]
  return (
    <div className="hud-backing mt-1 flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold" style={{ color: info.color }} title={info.rule} data-testid="omen-badge" data-omen={omen} role="status" aria-label={`Omen: ${info.name}. ${info.rule}`}>
      <OmenGlyph id={omen} size={16} color={info.color} />
      <span>{info.name}</span>
    </div>
  )
}

const SEEN_KEY = 'brawlock.wild.reactions'
const CARD_MS = 4200

function seenReactions(): Set<string> {
  try {
    const v = JSON.parse(safeLocalStorage()?.getItem(SEEN_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Set by ReactionCard while mounted; the HUD director calls it per reaction event. */
export const reactionCard = { show: (_id: ReactionId) => {} }

/** "Shatter! Lightning breaks a Snowball into four shards", once per reaction per browser. */
export function ReactionCard() {
  const [shown, setShown] = useState<ReactionId | null>(null)
  useEffect(() => {
    let timer = 0
    const seen = seenReactions()
    reactionCard.show = (id) => {
      if (seen.has(id)) return
      seen.add(id)
      try {
        safeLocalStorage()?.setItem(SEEN_KEY, JSON.stringify([...seen]))
      } catch {
        /* storage blocked: it may show again next match */
      }
      window.clearTimeout(timer)
      setShown(id)
      timer = window.setTimeout(() => setShown(null), CARD_MS)
    }
    return () => {
      window.clearTimeout(timer)
      reactionCard.show = () => {}
    }
  }, [])
  if (!shown) return null
  const info = REACTION_INFO[shown]
  return (
    <div className="reaction-card hud-backing rounded px-3 py-2" data-testid="reaction-card" data-reaction={shown} role="status" aria-live="polite">
      <div className="text-[0.66rem] font-semibold tracking-wider text-ash uppercase">Spell reaction</div>
      <div className="text-base font-bold text-[#ffe2b0]">{info.name}!</div>
      <div className="text-xs text-[#e6d3b8]">{info.rule}</div>
    </div>
  )
}
