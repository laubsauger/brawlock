import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { countTo, reducedMotion } from '../lib/motion'
import { useGame, type MatchResult } from '../../game/store'
import type { MatchRecord } from '../../game/stats'
import { TICK_HZ } from '../../sim'
import { Button, Crown, Kbd } from '../widgets'
import { backToLobby, leaveToMenu, newGame, rematch, setReady } from '../flow'
import { playerColor, winnersText } from '../lib/view'
import { duration, readHistory } from '../lib/stats'
import { isTypingTarget } from '../lib/keys'
import { AwardsStrip, PlayerStatsDetail } from './statViews'
import { useReplayIds, watchReplay } from '../lib/replays'
import { accountsEnabled } from '../../game/account'
import { Collection, MatchEmbers } from './Collection'

interface Row {
  id: number
  name: string
  color: string
  kind: 'human' | 'bot'
  /** bots: difficulty tag */
  difficulty?: string
  score: number
  kills: number
  deaths: number
  /** whole-match damage when the match record has it */
  damage: number | null
  winner: boolean
}

/** The match record the session just stored for this result, if it is the same match. */
function recordFor(result: MatchResult): MatchRecord | null {
  const rec = readHistory()[0]
  if (!rec || Date.now() - rec.date > 10 * 60_000) return null
  const ids = new Set(result.slots.map((s) => s.id))
  if (rec.participants.length !== ids.size || !rec.participants.every((p) => ids.has(p.player))) return null
  return rec
}

function rowsOf(result: MatchResult, rec: MatchRecord | null): Row[] {
  return result.slots
    .map((slot) => {
      const sc = result.scores.find((s) => s.id === slot.id)
      const p = rec?.participants.find((x) => x.player === slot.id)
      return {
        id: slot.id,
        name: slot.name,
        // team modes: everyone wears the team colour, as in the match
        color: playerColor(slot, rec?.teamMode),
        kind: slot.kind,
        difficulty: slot.kind === 'bot' ? slot.difficulty : undefined,
        score: sc?.score ?? 0,
        kills: sc?.kills ?? 0,
        deaths: sc?.deaths ?? 0,
        damage: p ? Math.round(p.damage) : null,
        winner: result.winners.includes(slot.id),
      }
    })
    .sort((a, b) => Number(b.winner) - Number(a.winner) || b.score - a.score || b.kills - a.kills || (b.damage ?? 0) - (a.damage ?? 0) || a.deaths - b.deaths)
}

/** A stat that counts up from zero when the board appears, staggered per row. */
function CountUp({ value, delay = 0 }: { value: number; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => countTo(0, value, 900, (v) => ref.current && (ref.current.textContent = v.toLocaleString()), delay), [value, delay])
  return <span ref={ref}>{reducedMotion() ? value.toLocaleString() : '0'}</span>
}

/** Most damage, then most kills, then fewest deaths. */
function mvpOf(rows: Row[]): Row | null {
  const best = [...rows].sort((a, b) => (b.damage ?? 0) - (a.damage ?? 0) || b.kills - a.kills || a.deaths - b.deaths)[0]
  if (!best || (best.kills === 0 && !best.damage)) return null
  return best
}

export function Results() {
  const result = useGame((s) => s.result)
  const role = useGame((s) => s.lobby.role)
  const local = useGame((s) => s.lobby.localPlayer)
  const ready = useGame((s) => s.lobby.ready)
  // quick play: no host. Casual and ranked both wait here for every player's Ready.
  const quick = useGame((s) => !!s.lobby.quick)
  const ranked = useGame((s) => !!s.lobby.ranked)
  const maintenance = useGame((s) => s.lobby.maintenance ?? null)
  const isHost = role !== 'client'
  const rec = useMemo(() => (result ? recordFor(result) : null), [result])
  // the replay is saved a moment after the match (compressed): the button appears then
  const replayIds = useReplayIds()
  // one player's detail row open at a time (all closed at first, so the board fits at 1280x720)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [collectionOpen, setCollectionOpen] = useState(false)

  // Enter = rematch, the one-click loop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const lobby = useGame.getState().lobby
      if (e.key !== 'Enter' || e.repeat || collectionOpen || isTypingTarget(e.target) || useGame.getState().settingsOpen || lobby.maintenance) return
      if ((e.target as HTMLElement)?.tagName === 'BUTTON') return
      e.preventDefault()
      if (isHost && !lobby.quick) rematch()
      else setReady(!useGame.getState().lobby.ready?.[useGame.getState().lobby.localPlayer])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isHost, collectionOpen])

  if (!result) {
    return (
      <div className="screen-in grid h-full place-items-center">
        <div className="panel flex flex-col items-center gap-5 p-10">
          <p className="text-lg text-ash">No results for this match.</p>
          <Button onClick={leaveToMenu}>Back to menu</Button>
        </div>
      </div>
    )
  }

  const rows = rowsOf(result, rec)
  const mvp = mvpOf(rows)
  const inMatch = result.slots.some((s) => s.id === local)
  const won = result.winners.includes(local)
  const draw = result.winners.length === 0
  const title = draw ? 'Draw' : !inMatch ? 'Match over' : won ? 'Victory' : 'Defeat'
  const winnerNames = rows.filter((r) => r.winner).map((r) => r.name)
  const who = winnersText(result.slots, result.winners, rec?.teamMode)
  const top2 = rows.slice(0, 2)
  const line =
    draw
      ? 'Nobody took the match.'
      : rows.length === 2
        ? `${winnerNames[0]} takes it ${top2[0].score}–${top2[1].score}`
        : who
          ? `${who.text} ${who.plural ? 'win' : 'wins'}`
          : ''
  const roundsMode = rec ? rec.gameMode === 'rounds' : true
  const secs = result.ticks ? result.ticks / TICK_HZ : rec?.durationSec
  const online = role !== 'offline'
  const humans = rows.filter((r) => r.kind === 'human')
  const readyCount = humans.filter((r) => ready?.[r.id]).length
  const localReady = !!ready?.[local]

  return (
    // One screen, no page scroll: title, then the board beside a column of MVP / awards / Embers,
    // then the buttons. A long board scrolls inside its own panel; the buttons always stay in view.
    <div className="screen-in flex h-full flex-col items-center overflow-y-auto px-4 py-4 lg:px-8" style={{ justifyContent: 'safe center' }}>
      <h1
        className="wordmark shrink-0 text-center text-[clamp(2.8rem,min(9vw,9.5vh),6.5rem)] leading-none"
        style={won || !inMatch ? undefined : { filter: 'grayscale(.35) drop-shadow(0 0 18px rgba(196,26,36,.45)) drop-shadow(0 2px 0 rgba(40,0,0,.9))' }}
      >
        {title}
      </h1>
      <div className="mt-2 mb-4 flex shrink-0 flex-wrap items-center justify-center gap-3 text-center">
        <span className="text-xl font-semibold text-[#f0d9b8]">{line}</span>
        <span className="chip">{result.rounds === 1 ? '1 round' : `${result.rounds} rounds`}</span>
        {secs != null && <span className="chip tabular">{duration(secs)}</span>}
      </div>

      <div className="flex min-h-0 w-full max-w-6xl shrink flex-col items-center justify-center gap-4 lg:flex-row lg:items-start">
      <div className="panel flex max-h-full min-h-0 w-full max-w-3xl flex-col p-5" data-testid="results-board">
        <div className="min-h-0 overflow-y-auto">
        <table className="tabular w-full text-left text-[1.04rem]">
          <thead>
            <tr className="text-sm text-ash">
              <th className="pb-2 font-semibold">Warlock</th>
              <th className="pb-2 text-right font-semibold">{roundsMode ? rec?.settings.rankedRounds ? 'Scoring wins' : 'Rounds won' : 'Score'}</th>
              <th className="pb-2 text-right font-semibold">Kills</th>
              <th className="pb-2 text-right font-semibold">Deaths</th>
              <th className="pb-2 text-right font-semibold">Damage</th>
              {online && <th className="pb-2 text-right font-semibold">Rematch</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => {
              const stats = rec?.participants.find((p) => p.player === r.id)?.stats
              const open = expanded === r.id
              return (
              <Fragment key={r.id}>
              <tr
                className={`card-in border-t border-[rgba(255,170,100,0.08)] ${r.id === local ? 'bg-[rgba(255,180,80,0.07)]' : ''}`}
                style={{ animationDelay: `${150 + ri * 110}ms` }}
              >
                <td className="py-1.5 pr-2">
                  <span className="flex items-center gap-3">
                    {stats ? (
                      <button type="button" className="row-toggle" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${r.name}'s match stats`} onClick={() => setExpanded(open ? null : r.id)}>
                        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
                          <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.6" />
                        </svg>
                      </button>
                    ) : (
                      <span className="w-5" aria-hidden />
                    )}
                    <span className="h-3.5 w-3.5 shrink-0 rotate-45 rounded-[2px]" style={{ background: r.color, boxShadow: `0 0 8px ${r.color}88` }} aria-hidden />
                    <span className="truncate font-bold">{r.name}</span>
                    {r.winner && <Crown title="Winner" />}
                    {rec?.firstBlood === r.id && (
                      <span className="chip bg-[rgba(196,26,36,0.22)] text-[#ffb3a6]" title="First Blood: the match's first kill">
                        First Blood
                      </span>
                    )}
                    {r.id === local && <span className="chip text-gold">You</span>}
                    {r.difficulty && <span className="chip text-[0.72rem] text-ash capitalize">{r.difficulty}</span>}
                  </span>
                </td>
                <td className="py-1.5 text-right text-[1.2rem] font-bold text-gold">
                  <CountUp value={r.score} delay={250 + ri * 110} />
                </td>
                <td className="py-1.5 text-right">
                  <CountUp value={r.kills} delay={300 + ri * 110} />
                </td>
                <td className="py-1.5 text-right">
                  <CountUp value={r.deaths} delay={350 + ri * 110} />
                </td>
                <td className="py-1.5 text-right">{r.damage != null ? <CountUp value={r.damage} delay={400 + ri * 110} /> : '–'}</td>
                {online && (
                  <td className="py-1.5 text-right">
                    {r.kind === 'bot' ? (
                      <span className="text-sm text-ash">Bot</span>
                    ) : ready?.[r.id] ? (
                      <span className="chip bg-[rgba(127,227,154,0.14)] text-heal">Ready</span>
                    ) : (
                      <span className="text-sm text-ash">–</span>
                    )}
                  </td>
                )}
              </tr>
              {open && stats && (
                <tr>
                  <td colSpan={online ? 6 : 5} className="pb-2.5">
                    <div className="pop-in">
                      <PlayerStatsDetail stats={stats} />
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>

      {(mvp || (rec?.awards && rec.awards.length > 0) || (accountsEnabled && inMatch && result.progression)) && (
        <aside className="results-side flex max-h-full min-h-0 w-full max-w-3xl flex-col gap-3 overflow-y-auto lg:w-[22rem] lg:shrink-0" aria-label="Match highlights">
          {mvp && (
            <div
              className="flex shrink-0 flex-col gap-1 rounded-lg px-4 py-3"
              style={{ background: `linear-gradient(90deg, ${mvp.color}26, rgba(12,8,6,.82))`, boxShadow: `inset 0 0 0 1px ${mvp.color}55` }}
            >
              <span className="flex items-center gap-3">
                <span className="display text-3xl leading-none text-gold">MVP</span>
                <span className="h-4 w-4 shrink-0 rotate-45 rounded-[3px]" style={{ background: mvp.color, boxShadow: `0 0 12px ${mvp.color}` }} aria-hidden />
                <span className="truncate text-[1.25rem] font-bold">{mvp.name}</span>
              </span>
              <span className="tabular text-[0.98rem] text-[#e6d3b8]">
                {mvp.damage != null && (
                  <>
                    <CountUp value={mvp.damage} delay={200} /> damage,{' '}
                  </>
                )}
                {mvp.kills} {mvp.kills === 1 ? 'kill' : 'kills'}
              </span>
            </div>
          )}
          {rec?.awards && rec.awards.length > 0 && (
            <AwardsStrip compact awards={rec.awards} who={(id) => {
              const player = rows.find((r) => r.id === id)
              return { name: player ? `${player.name}${player.kind === 'bot' ? ' (bot)' : ''}` : '?', color: player?.color ?? '#ccc' }
            }} />
          )}
          {accountsEnabled && inMatch && result.progression && <MatchEmbers progression={result.progression} onCollection={() => setCollectionOpen(true)} />}
        </aside>
      )}
      </div>

      {maintenance ? <div className="mt-4 flex max-w-3xl shrink-0 flex-col items-center gap-3 rounded-lg border border-gold/30 bg-[#281d13] px-5 py-4 text-center" role="status" data-testid="results-maintenance">
        <p className="font-semibold text-gold">Region updating · match complete</p>
        <p className="text-sm text-bone">{maintenance}</p>
        <Button onClick={leaveToMenu}>Choose another region</Button>
      </div> : quick ? (
        <div className="mt-4 flex shrink-0 flex-col items-center gap-2">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Button variant={localReady ? 'default' : 'primary'} size="lg" sound={localReady ? 'back' : 'ready'} onClick={() => setReady(!localReady)} autoFocus data-testid="quick-ready">
              {localReady ? 'Not ready' : ranked ? 'Ready for the next ranked game' : 'Ready for the next match'} {!localReady && <Kbd>Enter</Kbd>}
            </Button>
            {humans.length > 1 && (
              <Button size="lg" onClick={newGame} title={ranked ? 'Leave this room and queue for another ranked game' : 'Leave this room for another casual game'} data-testid="new-game">
                New game
              </Button>
            )}
            {rec && replayIds.has(rec.id) && (
              <Button size="lg" onClick={() => void watchReplay(rec.id)}>
                Watch replay
              </Button>
            )}
            <Button variant="ghost" sound="back" onClick={leaveToMenu}>
              Leave
            </Button>
          </div>
          <p className="text-[0.98rem] text-ash" aria-live="polite" data-testid="quick-ready-status">
            {humans.length > 1 ? `${readyCount} of ${humans.length} ready · ` : ''}
            {localReady
              ? ranked ? 'Back to the ranked lobby when everyone is ready.' : 'Starting when everyone is ready.'
              : 'Take your time: nothing starts until you press Ready.'}
          </p>
        </div>
      ) : (
      <div className="mt-4 flex shrink-0 flex-wrap items-center justify-center gap-3">
        {isHost ? (
          <Button variant="primary" size="lg" sound="ready" onClick={rematch} autoFocus>
            Rematch <Kbd>Enter</Kbd>
          </Button>
        ) : (
          <Button variant={localReady ? 'default' : 'primary'} size="lg" sound={localReady ? 'back' : 'ready'} onClick={() => setReady(!localReady)} autoFocus>
            {localReady ? 'Waiting for the host…' : 'Rematch'} {!localReady && <Kbd>Enter</Kbd>}
          </Button>
        )}
        <Button size="lg" onClick={backToLobby}>
          Back to lobby
        </Button>
        {rec && replayIds.has(rec.id) && (
          <Button size="lg" onClick={() => void watchReplay(rec.id)}>
            Watch replay
          </Button>
        )}
        <Button variant="ghost" sound="back" onClick={leaveToMenu}>
          Leave
        </Button>
      </div>
      )}
      {online && !quick && !maintenance && humans.length > 1 && (
        <p className="mt-2 shrink-0 text-[0.98rem] text-ash" aria-live="polite">
          {isHost ? `${readyCount} of ${humans.length - 1} ${humans.length - 1 === 1 ? 'opponent wants' : 'players want'} a rematch.` : localReady ? 'The host sees that you are ready.' : 'The host starts the rematch.'}
        </p>
      )}
      {collectionOpen && <Collection onClose={() => setCollectionOpen(false)} />}
    </div>
  )
}
