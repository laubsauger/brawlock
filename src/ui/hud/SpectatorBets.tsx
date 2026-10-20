import { useState } from 'react'
import { frame } from '../../game/frame'
import { input } from '../../game/input'
import { useGame } from '../../game/store'
import { BET_MAX_RETURN, BET_STAKE, BET_TWO_STARTER_SECONDS, betIdentityMatchesSlot, canSpectateBet, spectateBetWindow } from '../../sim/bets'
import { teamOf, TICK_HZ } from '../../sim'
import { usePolled } from '../lib/ticker'
import { playerColor, teamName } from '../lib/view'
import { Button } from '../widgets'

function read() {
  const state = frame.curr
  const local = frame.localPlayer
  if (!state || !state.settings.spectatorBets || state.settings.gameMode !== 'rounds' || local < 0) return null
  const slot = state.slots.find((s) => s.id === local)
  const pawn = state.pawns.find((p) => p.owner === local)
  const score = state.scores.find((s) => s.id === local)
  if (!slot || slot.kind !== 'human' || !score?.connected || !pawn || pawn.alive || (state.phase !== 'fight' && state.phase !== 'roundEnd')) return null
  const bet = state.betting.bets.find((b) => betIdentityMatchesSlot(b.payer, slot))
  const settlement = state.betting.lastSettlement?.round === state.round ? state.betting.lastSettlement : null
  const payout = bet ? settlement?.payouts[state.betting.bets.indexOf(bet)] : null
  const pick = bet ? state.slots.find((s) => betIdentityMatchesSlot(bet.pick, s)) : null
  const teams = new Set<number>()
  const choices = state.pawns.filter((p) => {
    if (!p.alive || !canSpectateBet(state, local, p.owner)) return false
    const team = teamOf(state, p.owner)
    if (teams.has(team)) return false
    teams.add(team)
    return true
  }).map((p) => {
    const contender = state.slots.find((s) => s.id === p.owner)!
    return { player: p.owner, name: state.settings.teamMode === 'ffa' ? contender.name : `${teamName(teamOf(state, p.owner))} team`, color: playerColor(contender, state.settings.teamMode) }
  })
  return {
    occupant: slot.profileId ?? `${slot.id}:${slot.name}`,
    round: state.round, phase: state.phase, choices,
    window: spectateBetWindow(state),
    secondsLeft: state.betting.closeTick === undefined ? null : Math.max(0, Math.ceil((state.betting.closeTick - state.tick) / TICK_HZ)),
    selected: bet ? (pick && state.settings.teamMode !== 'ffa' ? `${teamName(teamOf(state, pick.id))} team` : pick?.name ?? bet.pick.name) : null,
    pot: state.betting.bets.length * BET_STAKE,
    affordable: score.gold >= BET_STAKE,
    teams: state.settings.teamMode !== 'ffa',
    bounty: state.settings.bounties,
    final: !!state.rankedFinal,
    payout: payout ? { amount: payout.amount, correct: payout.correct } : null,
    bountyAdded: settlement?.bountyAdded ?? 0,
  }
}

type BetView = NonNullable<ReturnType<typeof read>>

/** An immediately usable spectator prompt, above the hotbar and clear of combat. */
export function SpectatorBets() {
  const panelOpen = useGame((s) => s.shopOpen || s.characterOpen || s.scoreboardOpen || s.paused || s.settingsOpen)
  // Poll only schedules renders; a seat/phase render must use current ownership.
  usePolled(read, JSON.stringify, 8)
  const value = read()
  if (!value || panelOpen) return null
  return <BetPanel key={`${value.round}:${value.occupant}`} value={value} />
}

function BetPanel({ value }: { value: BetView }) {
  // Show the actual choices on knockout. A deliberate collapse lasts this round.
  const [expanded, setExpanded] = useState(true)
  const result = value.payout
  const open = value.window === 'open' && value.affordable && !value.selected && !result && value.choices.length > 0
  const status = result ? 'Settled' : value.selected ? 'Bet locked' : value.window !== 'open' ? 'Betting closed' : !value.affordable ? 'Not enough gold' : 'Betting open'
  const closedReason = value.window === 'roundEnded' ? 'Betting closed for this round'
    : value.window === 'timedOut' ? `Betting closed: the first ${BET_TWO_STARTER_SECONDS} seconds are over`
      : value.window === 'decided' ? 'Betting closed: only one team remains'
        : 'Betting closed: two warlocks left'
  const place = (target: number) => {
    // Phase and target may have changed between the last HUD poll and the click.
    const current = frame.curr
    if (current && current.round === value.round && canSpectateBet(current, frame.localPlayer, target)) {
      input.issue({ kind: 'spectateBet', round: value.round, target })
    }
  }
  return <div className="spectator-bets-dock pointer-events-none absolute inset-x-3 bottom-[calc(var(--hud-bottom-h)*var(--ui-scale,1)+18px)] flex justify-center max-sm:bottom-[calc(var(--hud-bottom-h)*var(--ui-scale,1)+18px+var(--room-chat-offset,0px))] max-sm:[display:var(--spectator-bets-display,flex)] sm:[@media(min-height:521px)_and_(max-width:1199px)]:bottom-[calc(var(--hud-bottom-h)*var(--ui-scale,1)+18px+var(--room-chat-offset,0px))] sm:[@media(min-height:521px)_and_(max-width:1199px)]:[display:var(--spectator-bets-display,flex)] sm:[@media(max-height:520px)]:inset-x-auto sm:[@media(max-height:520px)]:right-3 sm:[@media(max-height:520px)]:w-[min(52vw,540px)]">
    <section data-testid="spectator-bets" data-betting-state={result ? 'settled' : value.selected ? 'locked' : open ? 'open' : 'closed'} className="interactive hud-scale hud-plate w-[min(600px,calc((100vw-24px)/var(--ui-scale,1)))] shrink-0 origin-bottom rounded border border-gold/40 px-3 py-2.5 text-sm shadow-lg [@media(min-width:1200px)_and_(min-height:521px)]:w-[min(600px,calc((100vw-760px)/var(--ui-scale,1)))] sm:[@media(max-height:520px)]:w-full sm:[@media(max-height:520px)]:max-h-[calc((100dvh_-_100px)/var(--ui-scale,1))] sm:[@media(max-height:520px)]:overflow-y-auto" aria-label="Spectator betting" onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      const rules = event.currentTarget.querySelector('details')
      if (rules?.open) {
        event.preventDefault()
        event.stopPropagation()
        rules.open = false
        rules.querySelector('summary')?.focus()
      } else if (open && expanded) {
        event.preventDefault()
        event.stopPropagation()
        setExpanded(false)
        event.currentTarget.querySelector<HTMLButtonElement>('button[aria-controls="spectator-bet-choices"]')?.focus()
      }
    }}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-display text-lg font-bold text-[#e7c58c]">{value.teams ? 'Bet on which team wins' : 'Bet on who wins'}</span>
        <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-bold ${open ? 'border-[#8ccf85]/40 bg-[#223d1e] text-[#b4efa8]' : 'border-gold/20 text-ash'}`}>
          {open && <i className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}{status}
        </span>
      </header>
      {result ? <p role="status" className="mt-1 break-words text-bone">{result.correct ? result.amount > BET_STAKE ? `You won: ${result.amount} gold returned · +${result.amount - BET_STAKE} gold profit` : `Correct pick · ${result.amount} gold returned (your stake)` : result.amount > 0 ? `Bet refunded: ${result.amount} gold` : `You lost your ${BET_STAKE} gold bet`}{value.bountyAdded > 0 ? ` · ${value.bountyAdded} gold added to bounties` : ''}</p>
        : value.selected ? <p role="status" className="mt-1 break-words text-bone">Your bet: {value.selected} · {BET_STAKE} gold placed</p>
          : value.window !== 'open' ? <p className="mt-1 text-ash">{closedReason}</p>
            : !value.affordable ? <p className="mt-1 text-ash">You need {BET_STAKE} gold to bet</p> : null}
      {open && <>
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-xs text-bone">Choose a {value.teams ? 'team' : 'player'} · costs {BET_STAKE} gold <span className="text-gold">· up to {BET_MAX_RETURN} back</span></p>
          <button type="button" className="min-h-9 shrink-0 rounded px-2 text-xs text-gold hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-gold" aria-expanded={expanded} aria-controls="spectator-bet-choices" onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide picks' : 'Show picks'}</button>
        </div>
        {expanded && <div id="spectator-bet-choices" className="mt-1 grid grid-cols-3 gap-1.5 sm:grid-cols-4">{value.choices.map((choice) => <Button key={choice.player} size="sm" className="min-h-11 min-w-0 !px-2 !py-1 !text-left" onClick={() => place(choice.player)} title={`Bet ${BET_STAKE} gold on ${choice.name}. One bet per round; it cannot be changed.`} aria-label={`Bet ${BET_STAKE} gold on ${choice.name}`}>
          <span className="flex w-full min-w-0 items-center gap-1.5"><i className="h-2 w-2 shrink-0 rounded-full" style={{ background: choice.color }} aria-hidden /><span className="min-w-0 truncate text-sm">{choice.name}</span></span>
        </Button>)}</div>}
        <p className="mt-1 text-xs text-ash">{value.secondsLeft === null ? 'Closes when two warlocks remain.' : `Closes in ${value.secondsLeft}s.`} One pick per round.</p>
      </>}
      <details className="mt-1 text-xs text-ash">
        <summary className="cursor-pointer rounded py-1 focus-visible:outline-2 focus-visible:outline-gold">Payout rules <span className="ml-2 font-normal">· Total bets: {value.pot} gold</span></summary>
        <p className="mt-1 leading-snug text-bone" title="Correct bets get their gold back. Profit is paid in bet order while other bets cover it.">Win: up to {BET_MAX_RETURN} gold total back ({BET_MAX_RETURN - BET_STAKE} gold profit)</p>
        <p className="mt-1 leading-snug">Wrong pick: lose {BET_STAKE} gold. One bet per round · {value.secondsLeft === null ? 'bets close when two warlocks remain' : `bets close after ${BET_TWO_STARTER_SECONDS} seconds`} · earlier bets are paid first.{value.bounty ? value.final ? '' : ' Leftover bets fund next round’s winner bounty.' : ' Unmatched bets are refunded.'}</p>
      </details>
    </section>
  </div>
}
