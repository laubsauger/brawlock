import { useRef } from 'react'
import { frame } from '../../game/frame'
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


/** Scheduled ranked matches count rounds rather than racing to a win score. */
export function roundLabel(state: SimState): string {
  if (state.rankedFinal) return 'Final brawl'
  const number = displayRound(state)
  return state.settings.rankedRounds ? `Round ${number}/${state.settings.rankedRounds}` : `Round ${number}`
}

export function roundGoal(state: SimState): string {
  if (state.rankedFinal) return 'Match decider'
  if (state.settings.rankedRounds) return `${state.settings.rankedRounds} scheduled rounds`
  return state.settings.gameMode === 'hill' ? `first to ${state.settings.winScore} tickets` : `first to ${state.settings.winScore}`
}

/** The final field is authoritative, including during its preceding shop. */
export function finalBrawlInfo(state: SimState, local: number): { names: string; watching: boolean } | null {
  if (!state.rankedFinal) return null
  return {
    names: state.slots.filter((slot) => state.rankedFinal!.contenders.includes(slot.id)).map((slot) => slot.name).join(' · '),
    watching: !state.rankedFinal.contenders.includes(local),
  }
}

export function FinalBrawlStatus() {
  const value = usePolled(() => frame.curr ? finalBrawlInfo(frame.curr, frame.localPlayer) : null, JSON.stringify, 4)
  if (!value) return null
  return <div className="hud-backing mt-1 max-w-[calc((100vw_-_24px)/var(--ui-scale,1))] rounded px-2 py-1 text-center text-xs" role="status" aria-label="Final brawl contenders">
    <span className="font-semibold text-gold">Finalists: {value.names}</span>
    {value.watching && <span className="mt-0.5 block text-ash">Watching the final · inspect the contenders or bet during the fight</span>}
  </div>
}

function clock(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Phase start tick, for an elapsed clock in open-ended phases (fight in rounds mode). */
const phaseClock = { phase: '' as Phase | '', startTick: 0 }

/**
 * The clock plate: round (with a quiet "first to N" under it), time left and
 * the phase. Text is written from the shared rAF, no React renders per frame.
 */
export function PhasePlate() {
  const round = useRef<HTMLSpanElement>(null)
  const timer = useRef<HTMLSpanElement>(null)
  const goal = useRef<HTMLSpanElement>(null)
  const phase = useRef<HTMLSpanElement>(null)
  const last = useRef({ round: '', timer: '', phase: '', goal: '' })

  useTick(() => {
    const s = frame.curr
    if (!s) return
    const l = last.current
    if (phaseClock.phase !== s.phase) {
      phaseClock.phase = s.phase
      phaseClock.startTick = s.tick
    }
    const r = roundLabel(s)
    if (r !== l.round && round.current) round.current.textContent = l.round = r
    const g = roundGoal(s)
    if (g !== l.goal && goal.current) goal.current.textContent = l.goal = g

    const p = PHASE_LABEL[s.phase] ?? s.phase
    if (p !== l.phase && phase.current) {
      phase.current.textContent = l.phase = p
      phase.current.dataset.phase = s.phase
    }

    const t = s.phaseTicksLeft >= 0 ? clock(Math.ceil(s.phaseTicksLeft / TICK_HZ)) : clock((s.tick - phaseClock.startTick) / TICK_HZ)
    if (t !== l.timer && timer.current) timer.current.textContent = l.timer = t
  })

  return (
    <div className="hud-plate hud-top flex h-9 shrink-0 items-center gap-3 px-4">
      <span className="flex flex-col items-end leading-none">
        <span ref={round} className="text-[0.86rem] font-semibold text-ash" />
        <span ref={goal} className="mt-0.5 text-[0.66rem] font-semibold whitespace-nowrap text-ash/75">{frame.curr ? roundGoal(frame.curr) : null}</span>
      </span>
      <span ref={timer} className="tabular min-w-[2.9rem] text-center text-[1.35rem] leading-none font-bold text-bone" />
      <span ref={phase} className="chip text-[0.8rem] text-[#ffd890]" />
    </div>
  )
}

/** "Arena shrinks in 4s" (hot pulse in the last 3 s); shares the row under the clock with the KO callout. */
export function ShrinkWarning() {
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef({ text: '', hot: false })
  useTick(() => {
    const s = frame.curr
    const el = ref.current
    if (!s || !el) return
    let sh = ''
    let hot = false
    if (s.phase === 'fight' && s.arena.nextShrinkTick >= 0) {
      const secs = Math.ceil((s.arena.nextShrinkTick - s.tick) / TICK_HZ)
      if (secs >= 0) {
        sh = secs <= 0 ? 'The arena crumbles' : `Arena shrinks in ${secs}s`
        hot = secs <= 3
      }
    }
    const l = last.current
    if (sh !== l.text) {
      el.textContent = l.text = sh
      // the pulsing hot copy (::after) reads the same text
      el.dataset.text = sh
      el.style.display = sh ? '' : 'none'
    }
    if (hot !== l.hot) {
      el.dataset.on = String(hot)
      l.hot = hot
    }
  })
  return <div ref={ref} className="shrink-warn hud-backing text-[0.85rem] leading-tight font-semibold text-[#ffbfa8]" style={{ display: 'none' }} />
}

interface StripPlayer {
  id: number
  name: string
  color: string
  /** shape next to the name (colourblind palette only) */
  glyph: string
  team: number
  /** a bot plays this seat (a bot slot, or a human seat a bot took over) */
  bot: boolean
}

/** In team modes every player wears the team colour (same as the banners and the arena), in FFA their own. */
function readPlayers(): StripPlayer[] {
  const s = frame.curr
  if (!s) return []
  const mode = s.settings.teamMode
  const cb = colorblindPalette()
  return [...s.slots]
    .sort((a: PlayerSlot, b: PlayerSlot) => a.team - b.team || a.id - b.id)
    .map((p) => ({ id: p.id, name: p.name, color: playerColor(p, mode), glyph: playerGlyph(p, mode, cb), team: p.team,
      bot: p.kind === 'bot' || s.scores.find((x) => x.id === p.id)?.connected === false }))
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

/** normal: up to 2 a side; compact: 3; tight: 4-5 (short names, smaller type) */
type Density = 'normal' | 'compact' | 'tight'
const PILL: Record<Density, { box: string; name: string; score: string; bar: string }> = {
  normal: { box: 'h-9 gap-2 pr-2.5 pl-1.5', name: 'max-w-[8.5rem] text-[0.95rem]', score: 'text-[1.1rem]', bar: 'h-5 w-1.5' },
  compact: { box: 'h-9 gap-1.5 pr-2 pl-1.5', name: 'max-w-[5.6rem] text-[0.88rem]', score: 'text-[1.05rem]', bar: 'h-5 w-1.5' },
  tight: { box: 'h-9 gap-1 pr-1.5 pl-1', name: 'max-w-[3.9rem] text-[0.8rem]', score: 'text-[0.98rem]', bar: 'h-4 w-1' },
}

function ScorePill({ p, local, density = 'normal', inGroup = false }: { p: StripPlayer; local: boolean; density?: Density; inGroup?: boolean }) {
  const { score, root } = useScoreRefs(p.id)
  const d = PILL[density]
  return (
    <div
      ref={root}
      // inside a team frame (2 px padding each side) a pill is 4 px shorter, so the group matches the clock height
      className={`hud-plate flex shrink-0 items-center rounded-[5px] transition-opacity ${inGroup ? d.box.replace('h-9', 'h-8') : d.box}`}
      style={local ? { boxShadow: `inset 0 0 0 1px ${p.color}aa, 0 6px 24px rgba(0,0,0,.45)` } : undefined}
      title={p.name}
    >
      <span className={`shrink-0 rounded-sm ${d.bar}`} style={{ background: p.color, boxShadow: `0 0 8px ${p.color}` }} aria-hidden />
      <span className={`truncate font-semibold ${d.name}`}>
        {p.glyph && <span className="mr-1" style={{ color: p.color }} aria-hidden>{p.glyph}</span>}
        {p.bot && <span className="bot-mark mr-1" title="Bot" aria-label="Bot" />}
        {p.name}
      </span>
      <span ref={score} className={`tabular inline-block font-bold text-gold ${d.score}`}>
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
          {p.bot && <span className="bot-mark mr-1" title="Bot" aria-label="Bot" />}
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

const playersKey = (ps: StripPlayer[]) => ps.map((p) => `${p.id}:${p.name}:${p.color}:${p.glyph}:${p.team}:${p.bot}`).join('|')

/** Players grouped by team, in team order (readPlayers already sorts by team). */
function teamsOf(ps: StripPlayer[]): [number, StripPlayer[]][] {
  const groups = new Map<number, StripPlayer[]>()
  for (const p of ps) groups.set(p.team, [...(groups.get(p.team) ?? []), p])
  return [...groups]
}

/** One team: a team-colour frame with the team's name on the outer edge, its players' pills inside. */
function TeamGroup({ team, players, local, side, density }: { team: number; players: StripPlayer[]; local: number; side: 'left' | 'right'; density: Density }) {
  const color = teamColor(team)
  return (
    <div
      className={`flex max-w-full items-stretch overflow-hidden rounded-[6px] ${side === 'right' ? 'flex-row-reverse' : ''}`}
      style={{ boxShadow: `inset 0 0 0 1.5px ${color}cc, 0 6px 24px rgba(0,0,0,.45)` }}
      aria-label={`${teamName(team)} team`}
    >
      <span
        className={`hud-text-shadow flex items-center font-bold tracking-wide uppercase ${density === 'tight' ? 'px-1 text-[0.62rem] [writing-mode:vertical-rl] rotate-180' : 'px-2 text-[0.74rem]'}`}
        style={{ background: `${color}55`, color: '#fff3e0' }}
      >
        {teamName(team)}
      </span>
      <div className={`flex flex-wrap gap-0.5 p-0.5 ${side === 'right' ? 'flex-row' : 'justify-end'}`}>
        {players.map((p) => (
          <ScorePill key={p.id} p={p} local={p.id === local} density={density} inGroup />
        ))}
      </div>
    </div>
  )
}

/**
 * Split the players around the clock. You sit on the left, nearest the clock.
 * Teams: your team on the left, the others on the right (more teams
 * alternate sides). FFA: everyone else alternates right / left in slot order,
 * so pills never jump around when scores change. Left lists run outer ->
 * inner (you last), right lists inner -> outer.
 */
export function splitSides<P extends { id: number; team: number }>(players: P[], local: number, teams: boolean): { left: P[]; right: P[] } {
  const me = players.find((p) => p.id === local)
  if (teams) {
    const order: number[] = []
    for (const p of players) if (!order.includes(p.team)) order.push(p.team)
    const myTeam = me?.team ?? order[0]
    const others = order.filter((t) => t !== myTeam)
    const leftTeams = [myTeam]
    const rightTeams: number[] = []
    others.forEach((t, i) => (i % 2 === 0 ? rightTeams : leftTeams).push(t))
    // left: outer teams first, your team innermost with you nearest the clock
    const left = leftTeams
      .slice()
      .reverse()
      .flatMap((t) => {
        const ps = players.filter((p) => p.team === t && p.id !== local)
        return t === myTeam && me ? [...ps, me] : ps
      })
    const right = rightTeams.flatMap((t) => players.filter((p) => p.team === t))
    return { left, right }
  }
  const others = players.filter((p) => p.id !== local)
  const right: P[] = []
  const leftInner: P[] = []
  others.forEach((p, i) => (i % 2 === 0 ? right : leftInner).push(p))
  const left = [...leftInner.reverse(), ...(me ? [me] : [])]
  return { left, right }
}

/** One side of the top row; teams render as team-framed groups (label on the outer edge). */
function Side({ players, side, local, teams, density }: { players: StripPlayer[]; side: 'left' | 'right'; local: number; teams: boolean; density: Density }) {
  const groups = teams ? teamsOf(players) : null
  return (
    <div className={`flex min-w-0 flex-1 flex-wrap items-start gap-1 ${side === 'left' ? 'justify-end' : 'justify-start'}`} aria-label={side === 'left' ? 'Scores, your side' : 'Scores'}>
      {groups
        ? groups.map(([team, ps]) => <TeamGroup key={team} team={team} players={ps} local={local} side={side} density={density} />)
        : players.map((p) => <ScorePill key={p.id} p={p} local={p.id === local} density={density} />)}
    </div>
  )
}

/**
 * Top of the HUD, one row: score pills to the left and right of the clock
 * (you on the left, nearest the clock), "first to N" inside the clock plate.
 * 1v1 keeps the broadcast look. Many players make the pills compact; a side
 * wraps to a second row only when it really does not fit.
 */
export function TopCenter() {
  const players = usePolled(readPlayers, playersKey, 2)
  const local = frame.localPlayer
  const teamMode = frame.curr?.settings.teamMode
  const teams = !!teamMode && teamMode !== 'ffa'
  if (players.length === 2 && !teams) {
    const [a, b] = players[1].id === local ? [players[1], players[0]] : players
    return (
      <div className="flex items-start gap-1" aria-label="Scores">
        <BroadcastSide p={a} side="left" local={a.id === local} />
        <PhasePlate />
        <BroadcastSide p={b} side="right" local={b.id === local} />
      </div>
    )
  }
  const { left, right } = splitSides(players, local, teams)
  const perSide = Math.max(left.length, right.length)
  const density: Density = perSide >= 4 ? 'tight' : perSide >= 3 ? 'compact' : 'normal'
  return (
    <div className="flex w-[var(--top-row-w)] max-w-[var(--top-row-w)] items-start justify-center gap-1">
      <Side players={left} side="left" local={local} teams={teams} density={density} />
      <PhasePlate />
      <Side players={right} side="right" local={local} teams={teams} density={density} />
    </div>
  )
}
