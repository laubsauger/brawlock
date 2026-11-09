import { useEffect, useRef, useState } from 'react'
import { frame } from '../../game/frame'
import { CATACLYSM_INFO, OMEN_INFO, REACTION_INFO, markReactionSeen, type ReactionId } from '../../game/wild'
import { TICK_HZ, bombHolder, type OmenId, type SimState } from '../../sim'
import { CATACLYSM_OMENS } from '../../sim/wild'
import { usePolled, useTick } from '../lib/ticker'
import { slotName } from '../lib/view'
import { OmenGlyph } from '../icons'

/**
 * Wild's HUD (docs/moonshot/specs/wild.md): the omen cards that turn over in the 3-2-1 countdown
 * and fly off when the fight starts (three at once under a Cataclysm banner), the badges under
 * the clock for the rest of the round, the Cursed Bomb's alert, the spirit's controls, and a
 * discovery card the first time this browser sees each spell reaction.
 */

/**
 * The card turns over this long before the fight, plus a little per extra omen, and flies up at
 * Fight!. Gone at Fight! after 3.5 s it was too quick to read (playtest 2026-11-02); held 2.5 s
 * into the fight it covered the opening moves (playtest 2026-11-05), so the reading time moved
 * into the countdown. The badges under the clock keep the rules.
 */
const REVEAL_SECONDS = 6
const REVEAL_PER_OMEN = 0.75

const readOmens = () => (frame.curr?.omens ?? []).join(' ')
const parse = (key: string) => (key ? key.split(' ') : []) as OmenId[]

export function OmenReveal() {
  const omens = parse(usePolled(readOmens, String, 4))
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef('off')
  useTick(() => {
    const s = frame.curr
    const el = ref.current
    if (!s || !el) return
    const prev = last.current
    const reveal = REVEAL_SECONDS + REVEAL_PER_OMEN * Math.max(0, (s.omens?.length ?? 1) - 1)
    const next = !s.omens?.length ? 'off'
      : s.phase === 'shop' && s.phaseTicksLeft <= reveal * TICK_HZ ? 'reveal'
      // it leaves only once it was shown (a late join mid-fight gets the badges alone)
      : s.phase === 'fight' && prev !== 'off' ? 'leave'
      : 'off'
    if (next !== prev) el.dataset.state = last.current = next
  })
  const cataclysm = omens.length >= CATACLYSM_OMENS
  return (
    <div ref={ref} className="omen-card" data-state="off" data-testid="omen-card" data-omen={omens.join(' ') || undefined} data-count={omens.length} data-cataclysm={cataclysm || undefined} aria-hidden={omens.length === 0}>
      {cataclysm && <div className="omen-card-banner" data-testid="cataclysm">
        <OmenGlyph id="cataclysm" size={26} color={CATACLYSM_INFO.color} />
        <span>{CATACLYSM_INFO.name}</span>
        <small>{CATACLYSM_INFO.rule}</small>
      </div>}
      <div className="omen-card-row">
        {omens.map((omen, i) => {
          const info = OMEN_INFO[omen]
          return <div key={omen} className="omen-card-face" style={{ ['--omen' as string]: info.color, animationDelay: `${i * 0.16}s` }}>
            <OmenGlyph id={omen} size={omens.length > 1 ? 40 : 54} color={info.color} />
            <div className="omen-card-name">{info.name}</div>
            <div className="omen-card-rule">{info.rule}</div>
          </div>
        })}
      </div>
    </div>
  )
}

const readBadge = () => {
  const s = frame.curr
  return s?.omens && (s.phase === 'shop' || s.phase === 'fight' || s.phase === 'roundEnd') ? s.omens.join(' ') : ''
}

/**
 * The round's omens under the clock. Hover (or focus) them for what each does: the card in the
 * countdown goes by fast, and three at once are a lot to take in.
 */
export function OmenBadge() {
  const omens = parse(usePolled(readBadge, String, 4))
  if (omens.length === 0) return null
  return (
    <div className="omen-badges interactive pointer-events-auto relative mt-1 flex items-center gap-1" tabIndex={0} data-testid="omen-badges" data-count={omens.length} aria-describedby="omen-briefing">
      {omens.map((omen) => {
        const info = OMEN_INFO[omen]
        return <div key={omen} className="hud-backing flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold" style={{ color: info.color }} data-testid="omen-badge" data-omen={omen} role="status" aria-label={`Omen: ${info.name}. ${info.rule}`}>
          <OmenGlyph id={omen} size={16} color={info.color} />
          <span>{info.name}</span>
        </div>
      })}
      <div id="omen-briefing" className="omen-briefing" role="tooltip" data-testid="omen-briefing">
        {omens.length >= CATACLYSM_OMENS && <p className="mb-1 font-semibold" style={{ color: CATACLYSM_INFO.color }} data-testid="omen-cataclysm">{CATACLYSM_INFO.name}: {CATACLYSM_INFO.rule.toLowerCase()}</p>}
        <ul className="flex flex-col gap-1.5">
          {omens.map((omen) => {
            const info = OMEN_INFO[omen]
            return <li key={omen} className="flex items-start gap-2" data-omen={omen}>
              <OmenGlyph id={omen} size={20} color={info.color} />
              <span><b className="font-semibold" style={{ color: info.color }}>{info.name}</b><br />{info.rule}</span>
            </li>
          })}
        </ul>
      </div>
    </div>
  )
}

/** Who holds the Cursed Bomb and how long it has, for the HUD (null: none armed or not fighting). */
export function bombView(s: SimState | null, local: number): { mine: boolean; holder: string; seconds: number; share: number } | null {
  if (!s || s.phase !== 'fight') return null
  const holder = bombHolder(s)
  const bomb = s.omenClock?.bomb
  if (holder === null || !bomb) return null
  return { mine: holder === local, holder: slotName(s, holder), seconds: bomb.fuse / TICK_HZ, share: bomb.full > 0 ? bomb.fuse / bomb.full : 0 }
}

/**
 * Cursed Bomb: the holder gets a loud alert with the fuse (and the screen's edge burns as it runs
 * down); everyone else a quiet line naming who has it.
 */
export function BombAlert() {
  const root = useRef<HTMLDivElement>(null)
  const who = useRef<HTMLSpanElement>(null)
  const secs = useRef<HTMLSpanElement>(null)
  const last = useRef('')
  useTick(() => {
    const el = root.current
    if (!el) return
    const v = bombView(frame.curr, frame.localPlayer)
    const state = !v ? 'off' : v.mine ? 'mine' : 'other'
    if (el.dataset.state !== state) el.dataset.state = state
    if (!v) return
    el.style.setProperty('--fuse', v.share.toFixed(3))
    const key = `${v.holder}|${v.seconds.toFixed(1)}`
    if (key === last.current) return
    last.current = key
    if (who.current) who.current.textContent = v.mine ? 'You hold the Cursed Bomb' : `${v.holder} holds the bomb`
    if (secs.current) secs.current.textContent = v.seconds >= 3 ? String(Math.ceil(v.seconds)) : v.seconds.toFixed(1)
  })
  return (
    <div ref={root} className="bomb-alert" data-state="off" data-testid="bomb-alert" role="status" aria-live="polite">
      <div className="bomb-alert-edge" aria-hidden />
      <div className="bomb-alert-chip hud-backing">
        <OmenGlyph id="cursedBomb" size={18} color={OMEN_INFO.cursedBomb.color} />
        <span ref={who} className="font-semibold" />
        <span ref={secs} className="bomb-alert-fuse tabular-nums" />
        <span className="bomb-alert-hint">Hit or touch a warlock to pass it</span>
      </div>
    </div>
  )
}

/** While the local warlock is a Vengeful Spirit: how to drift and when the bolt is ready. */
export function SpiritHud() {
  const root = useRef<HTMLDivElement>(null)
  const ready = useRef<HTMLSpanElement>(null)
  const last = useRef('')
  useTick(() => {
    const el = root.current
    if (!el) return
    const s = frame.curr
    const me = s?.pawns.find((p) => p.owner === frame.localPlayer)
    const sp = !me?.alive && s?.phase === 'fight' ? me?.spirit : undefined
    const state = !sp ? 'off' : sp.rise > 0 ? 'rising' : 'on'
    if (el.dataset.state !== state) el.dataset.state = state
    if (!sp) return
    const text = sp.rise > 0 ? 'Rising…' : sp.cd > 0 ? `Bolt in ${(sp.cd / TICK_HZ).toFixed(1)} s` : 'Bolt ready'
    if (text !== last.current && ready.current) {
      last.current = text
      ready.current.textContent = text
      el.dataset.ready = String(sp.rise <= 0 && sp.cd <= 0)
    }
  })
  return (
    <div ref={root} className="spirit-hud hud-backing" data-state="off" data-testid="spirit-hud" role="status">
      <OmenGlyph id="spirits" size={20} color={OMEN_INFO.spirits.color} />
      <span><b className="font-semibold text-[#cfe0ff]">You are a vengeful spirit.</b> Right-click to drift over the lava, any spell key to hurl a bolt at the living.</span>
      <span ref={ready} className="spirit-hud-ready tabular-nums" />
    </div>
  )
}

const CARD_MS = 4200

/** Set by ReactionCard while mounted; the HUD director calls it per reaction event. */
export const reactionCard = { show: (_id: ReactionId) => {} }

/** "Shatter! Lightning breaks a Snowball into four shards", once per reaction per browser. */
export function ReactionCard() {
  const [shown, setShown] = useState<ReactionId | null>(null)
  useEffect(() => {
    let timer = 0
    reactionCard.show = (id) => {
      if (!markReactionSeen(id)) return
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
