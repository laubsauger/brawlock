import { useRef } from 'react'
import { frame } from '../../game/frame'
import { useGame } from '../../game/store'
import type { Phase, PlayerSlot, SimState } from '../../sim/types'
import { TICK_HZ } from '../../sim/types'
import { usePolled, useTick } from '../lib/ticker'
import { hex } from '../lib/view'

const PHASE_LABEL: Record<Phase, string> = {
  warmup: 'Get ready',
  shop: 'Shop',
  fight: 'Fight',
  roundEnd: 'Round over',
  gameOver: 'Match over',
}

/**
 * Round shown to players. The original increments the round counter when a
 * fight starts, so during the shop phase the upcoming round is round + 1.
 */
export function displayRound(s: SimState): number {
  return s.phase === 'shop' || s.phase === 'warmup' ? s.round + 1 : Math.max(1, s.round)
}

function clock(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Phase start tick, for an elapsed clock in open-ended phases (fight in rounds mode). */
const phaseClock = { phase: '' as Phase | '', startTick: 0 }

export function PhasePlate() {
  const round = useRef<HTMLSpanElement>(null)
  const timer = useRef<HTMLSpanElement>(null)
  const phase = useRef<HTMLSpanElement>(null)
  const shrink = useRef<HTMLDivElement>(null)
  const last = useRef({ round: '', timer: '', phase: '', shrink: '', hot: false })

  useTick(() => {
    const s = frame.curr
    if (!s) return
    const l = last.current
    if (phaseClock.phase !== s.phase) {
      phaseClock.phase = s.phase
      phaseClock.startTick = s.tick
    }
    const r = `Round ${displayRound(s)}`
    if (r !== l.round && round.current) round.current.textContent = l.round = r

    const p = PHASE_LABEL[s.phase] ?? s.phase
    if (p !== l.phase && phase.current) {
      phase.current.textContent = l.phase = p
      phase.current.dataset.phase = s.phase
    }

    const t = s.phaseTicksLeft >= 0 ? clock(Math.ceil(s.phaseTicksLeft / TICK_HZ)) : clock((s.tick - phaseClock.startTick) / TICK_HZ)
    if (t !== l.timer && timer.current) timer.current.textContent = l.timer = t

    let sh = ''
    let hot = false
    if (s.phase === 'fight' && s.arena.nextShrinkTick >= 0) {
      const secs = Math.ceil((s.arena.nextShrinkTick - s.tick) / TICK_HZ)
      if (secs >= 0) {
        sh = secs <= 0 ? 'The arena crumbles' : `Arena shrinks in ${secs}s`
        hot = secs <= 3
      }
    }
    if (sh !== l.shrink && shrink.current) {
      shrink.current.textContent = l.shrink = sh
      shrink.current.style.visibility = sh ? 'visible' : 'hidden'
    }
    if (hot !== l.hot && shrink.current) {
      shrink.current.dataset.on = String(hot)
      l.hot = hot
    }
  })

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="hud-plate chamfer flex items-center gap-4 px-5 py-1.5" style={{ ['--c' as string]: '8px' }}>
        <span ref={round} className="text-[1.02rem] font-semibold text-ash" />
        <span ref={timer} className="tabular min-w-[3.2rem] text-center text-[1.6rem] leading-none font-bold text-bone" />
        <span ref={phase} className="chip text-[0.9rem] text-[#ffd890]" />
      </div>
      <div ref={shrink} className="shrink-warn hud-text-shadow text-[0.98rem] font-semibold text-[#ffbfa8]" style={{ visibility: 'hidden' }} />
    </div>
  )
}

interface StripPlayer {
  id: number
  name: string
  color: string
  team: number
}

function readPlayers(): StripPlayer[] {
  const s = frame.curr
  if (!s) return []
  return [...s.slots]
    .sort((a: PlayerSlot, b: PlayerSlot) => a.team - b.team || a.id - b.id)
    .map((p) => ({ id: p.id, name: p.name, color: hex(p.color), team: p.team }))
}

/** Live score + alive state for one player, written from the shared rAF. */
function useScoreRefs(id: number) {
  const score = useRef<HTMLSpanElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const last = useRef({ score: -1, alive: true })
  useTick(() => {
    const s = frame.curr
    if (!s) return
    const sc = s.scores.find((x) => x.id === id)?.score ?? 0
    const pawn = s.pawns.find((x) => x.owner === id)
    const alive = s.phase !== 'fight' || !!pawn?.alive
    const l = last.current
    if (sc !== l.score && score.current) {
      score.current.textContent = String(sc)
      if (l.score >= 0) score.current.animate([{ transform: 'scale(1.5)', color: '#fff6dc' }, { transform: 'scale(1)' }], { duration: 520, easing: 'cubic-bezier(.2,1.4,.4,1)' })
      l.score = sc
    }
    if (alive !== l.alive && root.current) {
      root.current.dataset.out = String(!alive)
      root.current.style.opacity = alive ? '1' : '0.5'
      l.alive = alive
    }
  })
  return { score, root }
}

function ScorePill({ p, local }: { p: StripPlayer; local: boolean }) {
  const { score, root } = useScoreRefs(p.id)
  return (
    <div
      ref={root}
      className="hud-plate flex items-center gap-2 rounded-[5px] py-1 pr-2.5 pl-1.5 transition-opacity"
      style={local ? { boxShadow: `inset 0 0 0 1px ${p.color}aa, 0 6px 24px rgba(0,0,0,.45)` } : undefined}
    >
      <span className="h-5 w-1.5 rounded-sm" style={{ background: p.color, boxShadow: `0 0 8px ${p.color}` }} aria-hidden />
      <span className="max-w-[8.5rem] truncate text-[0.95rem] font-semibold">{p.name}</span>
      <span ref={score} className="tabular inline-block text-[1.1rem] font-bold text-gold">
        0
      </span>
    </div>
  )
}

/** Broadcast plate for a 1v1: name toward the edge, big score toward the clock. */
function BroadcastSide({ p, side, local }: { p: StripPlayer; side: 'left' | 'right'; local: boolean }) {
  const { score, root } = useScoreRefs(p.id)
  const toCenter = side === 'left' ? 'to left' : 'to right'
  return (
    <div
      ref={root}
      className={`flex h-[46px] items-stretch overflow-hidden transition-opacity ${side === 'right' ? 'flex-row-reverse' : ''}`}
      style={{ background: `linear-gradient(${toCenter}, ${p.color}55, rgba(14,8,5,.88) 70%)`, boxShadow: `inset 0 0 0 1px ${p.color}66, 0 6px 24px rgba(0,0,0,.45)` }}
    >
      <span className="w-1.5" style={{ background: p.color, boxShadow: `0 0 12px ${p.color}` }} aria-hidden />
      <span className={`flex min-w-[9rem] max-w-[14rem] flex-col justify-center px-3 ${side === 'right' ? 'items-end text-right' : ''}`}>
        <span className="hud-text-shadow truncate text-[1.05rem] leading-tight font-bold">{p.name}</span>
        {local && <span className="text-[0.75rem] leading-tight font-semibold text-gold">You</span>}
      </span>
      <span ref={score} className="tabular hud-text-shadow grid w-12 place-items-center bg-black/35 text-[1.7rem] font-bold text-[#fff1d6]">
        0
      </span>
    </div>
  )
}

const playersKey = (ps: StripPlayer[]) => ps.map((p) => `${p.id}:${p.name}:${p.color}:${p.team}`).join('|')

/**
 * Top of the HUD, broadcast style. 1v1: both players flank the round clock
 * (you on the left). More players: the clock, then a strip of score pills.
 */
export function TopCenter() {
  const players = usePolled(readPlayers, playersKey, 2)
  const local = frame.localPlayer
  const winScore = frame.curr?.settings.winScore
  if (players.length === 2) {
    const [a, b] = players[1].id === local ? [players[1], players[0]] : players
    return (
      <div className="flex flex-col items-center gap-1" aria-label="Scores">
        <div className="flex items-start gap-2">
          <BroadcastSide p={a} side="left" local={a.id === local} />
          <PhasePlate />
          <BroadcastSide p={b} side="right" local={b.id === local} />
        </div>
        {winScore ? <span className="hud-text-shadow text-[0.82rem] font-semibold text-ash">First to {winScore}</span> : null}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <PhasePlate />
      <div className="flex flex-wrap justify-center gap-1.5" aria-label="Scores">
        {players.map((p) => (
          <ScorePill key={p.id} p={p} local={p.id === local} />
        ))}
      </div>
      {winScore ? <span className="hud-text-shadow text-[0.82rem] font-semibold text-ash">First to {winScore}</span> : null}
    </div>
  )
}

/** Own ping and loss for online roles. */
export function NetReadout() {
  const role = useGame((s) => s.lobby.role)
  const ref = useRef<HTMLSpanElement>(null)
  const dot = useRef<HTMLSpanElement>(null)
  const last = useRef('')
  const lastAt = useRef(0)
  useTick((now) => {
    if (role === 'offline' || !ref.current) return
    if (now - lastAt.current < 250) return // 4 Hz is plenty
    lastAt.current = now
    const { rttMs, lossPct } = frame.net
    const text = role === 'host' && rttMs <= 0 ? 'Host' : `${Math.round(rttMs)} ms${lossPct >= 0.5 ? `  ${lossPct.toFixed(0)}% loss` : ''}`
    if (text === last.current) return
    last.current = text
    ref.current.textContent = text
    if (dot.current) dot.current.style.background = rttMs < 90 && lossPct < 2 ? '#7fe39a' : rttMs < 160 && lossPct < 6 ? '#ffc548' : '#ff5a4a'
  })
  if (role === 'offline') return null
  return (
    <div className="hud-text-shadow flex items-center gap-2 text-[0.92rem] font-semibold text-bone/85" title="Round trip time to the host and packet loss">
      <span ref={dot} className="h-2 w-2 rounded-full bg-heal" aria-hidden />
      <span ref={ref} className="tabular" />
    </div>
  )
}
