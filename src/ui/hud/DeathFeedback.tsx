import { useEffect, useRef } from 'react'
import { eventsSince, frame } from '../../game/frame'
import { useGame } from '../../game/store'
import { TICK_HZ } from '../../sim'
import { reducedMotion } from '../lib/motion'
import { useTick } from '../lib/ticker'
import { slotName } from '../lib/view'
import { Skull } from './Announce'
import { deathNextStep, deathRecap } from './deathRecap'
import { SpectatorBets } from './SpectatorBets'

/** A confirmed local knockout gets its own readable beat, separate from round banners. */
export function DeathFeedback() {
  const panel = useRef<HTMLDivElement>(null)
  const recap = useRef<HTMLParagraphElement>(null)
  const next = useRef<HTMLParagraphElement>(null)
  const edge = useRef<HTMLDivElement>(null)
  const memory = useRef({ tick: -1, local: frame.localPlayer, shown: false, animations: [] as Animation[] })

  useEffect(() => {
    // A remount must not replay old deaths or their impact pulse.
    memory.current.tick = frame.curr?.tick ?? -1
    return () => memory.current.animations.forEach((a) => a.cancel())
  }, [])

  useTick(() => {
    const state = frame.curr
    if (!state || !panel.current || !recap.current || !next.current) return
    const m = memory.current
    const local = frame.localPlayer
    if (state.tick + TICK_HZ < m.tick) {
      m.tick = -1
      m.shown = false
      m.animations.forEach((a) => a.cancel())
    }
    if (local !== m.local) {
      // Taking a reserved bot seat must never replay that bot's earlier deaths.
      m.tick = state.tick
      m.local = local
      m.shown = false
      m.animations.forEach((a) => a.cancel())
    }
    for (const batch of eventsSince(m.tick)) {
      for (const e of batch.events) {
        if (e.type === 'respawn' && e.owner === local) m.shown = false
        if (e.type !== 'death' || e.owner !== local || e.cause === 'disconnect' || local < 0) continue
        if (state.phase !== 'fight' && state.phase !== 'roundEnd') continue
        const killer = e.killer !== null && e.killer !== local ? slotName(state, e.killer) : null
        recap.current.textContent = deathRecap(e, killer)
        m.shown = true
        m.animations.forEach((a) => a.cancel())
        m.animations = []
        if (!reducedMotion()) {
          m.animations.push(panel.current.animate(
            [{ opacity: 0, transform: 'translateY(10px) scale(1.04)' }, { opacity: 1, transform: 'none' }],
            { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' },
          ))
          const fx = useGame.getState().settings.fxIntensity
          if (edge.current && fx > 0) m.animations.push(edge.current.animate(
            [{ opacity: 0.65 * fx }, { opacity: 0.28 * fx, offset: 0.22 }, { opacity: 0 }],
            { duration: 850, easing: 'ease-out' },
          ))
        }
      }
      m.tick = Math.max(m.tick, batch.tick)
    }
    if (state.phase === 'shop' || state.phase === 'warmup' || state.phase === 'gameOver') m.shown = false
    panel.current.hidden = !m.shown
    if (!m.shown) {
      m.animations.forEach((a) => a.cancel())
      m.animations = []
      return
    }
    const pawn = state.pawns.find((p) => p.owner === local)
    const text = deathNextStep(state.settings.gameMode, state.phase, pawn?.respawnTicks ?? 0)
    if (next.current.textContent !== text) next.current.textContent = text
  })

  return (
    <>
      <div ref={edge} className="pointer-events-none absolute inset-0" style={{ opacity: 0, background: 'radial-gradient(ellipse at center, transparent 40%, rgba(145, 20, 8, .7) 100%)' }} aria-hidden />
      <div className="pointer-events-none absolute inset-x-3 top-[clamp(230px,30vh,280px)] flex justify-center sm:top-[clamp(88px,20vh,190px)] sm:[@media(max-height:520px)]:inset-x-auto sm:[@media(max-height:520px)]:left-3 sm:[@media(max-height:520px)]:top-16 sm:[@media(max-height:520px)]:w-[min(42vw,330px)]">
        <div ref={panel} hidden className="hud-scale w-full max-w-[360px] origin-top rounded border border-[#f38b69]/40 bg-[#1c1010]/90 px-4 py-3 text-center shadow-[0_8px_40px_#0008] max-sm:[@media(max-height:740px)]:py-2" role="status" aria-live="polite" aria-atomic="true">
          <div className="flex items-center justify-center gap-2 text-[#ffb69a]">
            <Skull size={22} />
            <span className="font-display text-xl font-bold tracking-wide max-sm:[@media(max-height:740px)]:text-base">You were knocked out</span>
          </div>
          <p ref={recap} className="mt-1 break-words text-[0.95rem] font-semibold text-[#f5ddcc] max-sm:[@media(max-height:740px)]:text-xs" />
          <p ref={next} className="mt-1 text-sm tabular-nums text-ash max-sm:[@media(max-height:740px)]:text-xs" aria-live="off" />
        </div>
      </div>
      <SpectatorBets />
    </>
  )
}
