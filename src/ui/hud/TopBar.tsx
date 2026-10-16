import { useRef } from 'react'
import { frame } from '../../game/frame'
import { useGame } from '../../game/store'
import type { Phase, PlayerSlot, SimState } from '../../sim/types'
import { TICK_HZ } from '../../sim/types'
import { usePolled, useTick } from '../lib/ticker'
import { playerColor, playerGlyph, teamColor, teamName } from '../lib/view'
import { colorblindPalette } from '../../game/playerPalette'

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
      // the pulsing hot copy (::after) reads the same text
      shrink.current.dataset.text = sh
      shrink.current.style.visibility = sh ? 'visible' : 'hidden'
    }
    if (hot !== l.hot && shrink.current) {
      shrink.current.dataset.on = String(hot)
      l.hot = hot
    }
  })

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="hud-plate hud-top flex h-9 items-center gap-3 px-4">
        <span ref={round} className="text-[0.9rem] font-semibold text-ash" />
        <span ref={timer} className="tabular min-w-[2.9rem] text-center text-[1.35rem] leading-none font-bold text-bone" />
        <span ref={phase} className="chip text-[0.8rem] text-[#ffd890]" />
      </div>
      <div ref={shrink} className="shrink-warn hud-backing mt-0.5 text-[0.85rem] leading-tight font-semibold text-[#ffbfa8]" style={{ visibility: 'hidden' }} />
    </div>
  )
}

interface StripPlayer {
  id: number
  name: string
  color: string
  /** shape next to the name (colourblind palette only) */
  glyph: string
  team: number
}

/** In team modes every player wears the team colour (same as the banners and the arena), in FFA their own. */
function readPlayers(): StripPlayer[] {
  const s = frame.curr
  if (!s) return []
  const mode = s.settings.teamMode
  const cb = colorblindPalette()
  return [...s.slots]
    .sort((a: PlayerSlot, b: PlayerSlot) => a.team - b.team || a.id - b.id)
    .map((p) => ({ id: p.id, name: p.name, color: playerColor(p, mode), glyph: playerGlyph(p, mode, cb), team: p.team }))
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
      <span className="max-w-[8.5rem] truncate text-[0.95rem] font-semibold">
        {p.glyph && <span className="mr-1" style={{ color: p.color }} aria-hidden>{p.glyph}</span>}
        {p.name}
      </span>
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
      className={`flex h-9 items-stretch overflow-hidden transition-opacity ${side === 'right' ? 'flex-row-reverse' : ''}`}
      style={{ background: `linear-gradient(${toCenter}, ${p.color}55, rgba(14,8,5,.88) 70%)`, boxShadow: `inset 0 0 0 1px ${p.color}66, 0 6px 24px rgba(0,0,0,.45)` }}
    >
      <span className="w-1.5" style={{ background: p.color, boxShadow: `0 0 12px ${p.color}` }} aria-hidden />
      <span className={`flex min-w-[8rem] max-w-[13rem] flex-col justify-center px-2.5 ${side === 'right' ? 'items-end text-right' : ''}`}>
        <span className="hud-text-shadow truncate text-[0.95rem] leading-tight font-bold">
          {p.glyph && <span className="mr-1" aria-hidden>{p.glyph}</span>}
          {p.name}
        </span>
        {local && <span className="text-[0.68rem] leading-none font-semibold text-gold">You</span>}
      </span>
      <span ref={score} className="tabular hud-text-shadow grid w-10 place-items-center bg-black/35 text-[1.4rem] font-bold text-[#fff1d6]">
        0
      </span>
    </div>
  )
}

const playersKey = (ps: StripPlayer[]) => ps.map((p) => `${p.id}:${p.name}:${p.color}:${p.glyph}:${p.team}`).join('|')

/** Players grouped by team, in team order (readPlayers already sorts by team). */
function teamsOf(ps: StripPlayer[]): [number, StripPlayer[]][] {
  const groups = new Map<number, StripPlayer[]>()
  for (const p of ps) groups.set(p.team, [...(groups.get(p.team) ?? []), p])
  return [...groups]
}

/** One team in the score strip: a team-colour frame with the team's name, its players' pills inside. */
function TeamGroup({ team, players, local }: { team: number; players: StripPlayer[]; local: number }) {
  const color = teamColor(team)
  return (
    <div className="flex max-w-full items-stretch overflow-hidden rounded-[6px]" style={{ boxShadow: `inset 0 0 0 1.5px ${color}cc, 0 6px 24px rgba(0,0,0,.45)` }} aria-label={`${teamName(team)} team`}>
      <span className="hud-text-shadow flex items-center px-2 text-[0.78rem] font-bold tracking-wide uppercase" style={{ background: `${color}55`, color: '#fff3e0' }}>
        {teamName(team)}
      </span>
      <div className="flex flex-wrap gap-0.5 p-0.5">
        {players.map((p) => (
          <ScorePill key={p.id} p={p} local={p.id === local} />
        ))}
      </div>
    </div>
  )
}

/**
 * Top of the HUD, broadcast style. 1v1: both players flank the round clock
 * (you on the left). More players: the clock, then a strip of score pills.
 */
export function TopCenter() {
  const players = usePolled(readPlayers, playersKey, 2)
  const local = frame.localPlayer
  const winScore = frame.curr?.settings.winScore
  const teamMode = frame.curr?.settings.teamMode
  // with the shop open the strip wraps to rows rather than run under the right dock
  const shopOpen = useGame((s) => s.shopOpen)
  const stripStyle = shopOpen ? { maxWidth: 'var(--strip-max-w)' } : undefined
  if (players.length === 2) {
    const [a, b] = players[1].id === local ? [players[1], players[0]] : players
    return (
      <div className="flex flex-col items-center gap-0.5" aria-label="Scores">
        <div className="flex items-start gap-1">
          <BroadcastSide p={a} side="left" local={a.id === local} />
          <PhasePlate />
          <BroadcastSide p={b} side="right" local={b.id === local} />
        </div>
        {winScore ? <span className="hud-backing hud-text-shadow mt-0.5 text-[0.75rem] leading-tight font-semibold text-ash">First to {winScore}</span> : null}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-1">
      <PhasePlate />
      {teamMode && teamMode !== 'ffa' ? (
        <div className="flex flex-wrap justify-center gap-2" style={stripStyle} aria-label="Scores">
          {teamsOf(players).map(([team, ps]) => (
            <TeamGroup key={team} team={team} players={ps} local={local} />
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap justify-center gap-1" style={stripStyle} aria-label="Scores">
          {players.map((p) => (
            <ScorePill key={p.id} p={p} local={p.id === local} />
          ))}
        </div>
      )}
      {winScore ? <span className="hud-backing hud-text-shadow text-[0.82rem] font-semibold text-ash">First to {winScore}</span> : null}
    </div>
  )
}
