import { useRef } from 'react'
import { useTick } from '../lib/ticker'
import { kbMultiplier, localView } from '../lib/view'

/** Knockback points where the meter reads full. Points keep counting past it. */
const KB_METER_FULL = 2000
/** Points above which the meter starts to glow: hits push you 2x+. */
const KB_HOT = 1000

/**
 * HP bar with a lagging damage trail, regen readout, and the knockback
 * points meter. All numbers written from the shared rAF through refs.
 */
export function Vitals() {
  const hpFrame = useRef<HTMLDivElement>(null)
  const hpFill = useRef<HTMLDivElement>(null)
  const hpTrail = useRef<HTMLDivElement>(null)
  const hpText = useRef<HTMLSpanElement>(null)
  const regenText = useRef<HTMLSpanElement>(null)
  const kbFrame = useRef<HTMLDivElement>(null)
  const kbFill = useRef<HTMLDivElement>(null)
  const kbMult = useRef<HTMLSpanElement>(null)
  const kbPts = useRef<HTMLSpanElement>(null)
  const st = useRef({ hp: -1, max: -1, regen: -1, kb: -1, trail: 1, trailShown: -1, trailHoldUntil: 0, frac: 1, lastNow: 0, low: false, hot: false })

  useTick((now) => {
    const pawn = localView()?.pawn
    const s = st.current
    const dt = s.lastNow ? Math.min(0.1, (now - s.lastNow) / 1000) : 0
    s.lastNow = now
    if (!pawn) return

    const hp = Math.max(0, Math.round(pawn.alive ? pawn.hp : 0))
    const max = Math.round(pawn.maxHp)
    const frac = max > 0 ? Math.min(1, hp / max) : 0
    if (hp !== s.hp || max !== s.max) {
      if (frac < s.frac) s.trailHoldUntil = now + 380 // hold the trail, then bleed down
      s.frac = frac
      s.hp = hp
      s.max = max
      if (hpFill.current) hpFill.current.style.transform = `scaleX(${frac})`
      if (hpText.current) hpText.current.textContent = `${hp} / ${max}`
      const low = pawn.alive && frac < 0.25
      if (low !== s.low && hpFrame.current) {
        hpFrame.current.dataset.low = String(low)
        s.low = low
      }
    }
    if (s.trail > s.frac && now > s.trailHoldUntil) s.trail = Math.max(s.frac, s.trail - dt * 0.9)
    if (s.trail < s.frac) s.trail = s.frac
    if (s.trail !== s.trailShown && hpTrail.current) {
      hpTrail.current.style.transform = `scaleX(${s.trail})`
      s.trailShown = s.trail
    }

    const regen = Math.round(pawn.hpRegen * 10) / 10
    if (regen !== s.regen && regenText.current) {
      regenText.current.textContent = `+${regen.toFixed(1)}/s`
      s.regen = regen
    }

    const kb = Math.round(pawn.kbPoints)
    if (kb !== s.kb) {
      s.kb = kb
      const f = Math.min(1, kb / KB_METER_FULL)
      if (kbFill.current) kbFill.current.style.transform = `scaleX(${f})`
      if (kbFrame.current) kbFrame.current.style.setProperty('--kb-span', `${100 / Math.max(f, 0.05)}%`)
      if (kbMult.current) kbMult.current.textContent = `×${kbMultiplier(kb).toFixed(2)}`
      if (kbPts.current) kbPts.current.textContent = String(kb)
      const hot = kb >= KB_HOT
      if (hot !== s.hot && kbFrame.current) {
        kbFrame.current.dataset.hot = String(hot)
        s.hot = hot
      }
    }
  })

  return (
    <div className="flex flex-col gap-1.5">
      <div ref={hpFrame} className="hp-frame" role="meter" aria-label="Health">
        <div ref={hpTrail} className="hp-trail" />
        <div ref={hpFill} className="hp-fill" />
        <div className="hud-text-shadow absolute inset-0 flex items-center justify-between px-2.5 text-[0.98rem] font-bold">
          <span ref={hpText} className="tabular">
            –
          </span>
          <span ref={regenText} className="tabular text-[0.85rem] font-semibold text-[#ffe0cc]/85" />
        </div>
      </div>
      <div
        className="flex items-center gap-2.5"
        title="Knockback points. Every hit you take adds points, and every point makes the next hit push you further. They reset when you respawn."
      >
        <span className="text-[0.82rem] font-semibold text-ash">Knockback</span>
        <div ref={kbFrame} className="kb-frame flex-1" role="meter" aria-label="Knockback points">
          <div ref={kbFill} className="kb-fill" style={{ transform: 'scaleX(0)' }} />
        </div>
        <span ref={kbMult} className="tabular w-12 text-right text-[0.98rem] font-bold text-[#ffcf8a]">
          ×1.00
        </span>
        <span ref={kbPts} className="tabular w-10 text-right text-[0.82rem] text-ash">
          0
        </span>
      </div>
    </div>
  )
}

export function Gold() {
  const ref = useRef<HTMLSpanElement>(null)
  const last = useRef(-1)
  useTick(() => {
    const g = localView()?.score?.gold
    if (g == null || g === last.current || !ref.current) return
    last.current = g
    ref.current.textContent = String(Math.floor(g))
  })
  return (
    <div className="flex items-center gap-1.5 text-[1.15rem] font-bold text-gold" title="Gold">
      <span className="coin" aria-hidden />
      <span ref={ref} className="tabular">
        0
      </span>
    </div>
  )
}
