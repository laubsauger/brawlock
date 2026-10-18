import { frame } from '../../game/frame'
import { input } from '../../game/input'
import { BET_MAX_RETURN, BET_STAKE, betIdentityMatchesSlot, canSpectateBet } from '../../sim/bets'
import { teamOf } from '../../sim'
import { usePolled } from '../lib/ticker'
import { sfx } from '../lib/sound'
import { playerColor, teamName } from '../lib/view'

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
    round: state.round, phase: state.phase, choices,
    selected: bet ? (pick && state.settings.teamMode !== 'ffa' ? `${teamName(teamOf(state, pick.id))} team` : pick?.name ?? bet.pick.name) : null,
    pot: state.betting.bets.length * BET_STAKE,
    affordable: score.gold >= BET_STAKE,
    teams: state.settings.teamMode !== 'ffa',
    bounty: state.settings.bounties,
    payout: payout ? { amount: payout.amount, correct: payout.correct } : null,
    bountyAdded: settlement?.bountyAdded ?? 0,
  }
}

/** A small, authoritative side pot while the local player is knocked out. */
export function SpectatorBets() {
  // Poll only schedules renders; a seat/phase render must use current ownership.
  usePolled(read, JSON.stringify, 8)
  const value = read()
  if (!value) return null
  const place = (target: number) => {
    input.issue({ kind: 'spectateBet', round: value.round, target })
    sfx('click')
  }
  const result = value.payout
  return <div className="pointer-events-none absolute inset-x-3 flex justify-center sm:[@media(max-height:520px)]:inset-x-auto sm:[@media(max-height:520px)]:right-3 sm:[@media(max-height:520px)]:w-[min(52vw,440px)]" style={{ bottom: 'calc(var(--hud-bottom-h) * var(--ui-scale, 1) + 18px)' }}>
    <section data-testid="spectator-bets" className="interactive hud-scale w-full max-w-[440px] origin-bottom rounded border border-[#d6a44e]/30 bg-[#17100c]/95 px-3 py-2 text-sm shadow-lg" aria-label="Spectator betting">
    <div className="flex items-center justify-between gap-3">
      <span className="font-semibold text-[#e7c58c]">{value.teams ? 'Bet on which team wins' : 'Bet on who wins'}</span>
      <span className="shrink-0 text-xs tabular-nums text-gold">Total bets: {value.pot} gold</span>
    </div>
    {result ? <p role="status" className="mt-1 text-bone">{result.correct ? result.amount > BET_STAKE ? `You won: ${result.amount} gold returned · +${result.amount - BET_STAKE} gold profit` : `Correct pick · ${result.amount} gold returned (your stake)` : result.amount > 0 ? `Bet refunded: ${result.amount} gold` : `You lost your ${BET_STAKE} gold bet`}{value.bountyAdded > 0 ? ` · ${value.bountyAdded} gold added to bounties` : ''}</p>
      : value.selected ? <p role="status" className="mt-1 break-words text-bone">Your bet: {value.selected} · {BET_STAKE} gold placed</p>
        : value.phase === 'roundEnd' ? <p className="mt-1 text-ash">Betting closed for this round</p>
          : !value.affordable ? <p className="mt-1 text-ash">You need {BET_STAKE} gold to bet</p>
            : value.choices.length === 0 ? <p className="mt-1 text-ash">Betting closed for this round</p>
            : <><p className="mt-1 text-bone">Choose a {value.teams ? 'team' : 'player'} · costs {BET_STAKE} gold</p>
              <div className="mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto overscroll-contain">{value.choices.map((choice) => <button key={choice.player} type="button" className="flex min-w-0 max-w-full flex-[1_1_150px] items-center gap-2 rounded border border-white/15 bg-white/5 px-2 py-1 text-bone hover:border-gold/60 focus-visible:outline-2 focus-visible:outline-gold" onClick={() => place(choice.player)} title={`Bet ${BET_STAKE} gold on ${choice.name}. One bet per round; it cannot be changed.`}>
              <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: choice.color }} />
              <span className="shrink-0 text-gold">Bet {BET_STAKE} gold ·</span><span className="min-w-0 max-w-40 truncate">{choice.name}</span>
            </button>)}</div></>}
    <p className="mt-2 text-xs leading-snug text-bone" title="Correct bets get their gold back. Profit is paid in bet order while other bets cover it.">Win: up to {BET_MAX_RETURN} gold total back ({BET_MAX_RETURN - BET_STAKE} gold profit)</p>
    <p className="mt-1 text-[0.7rem] leading-snug text-ash">Wrong pick: lose {BET_STAKE} gold. One bet per round · profit depends on other bets.{value.bounty ? ' Leftover bets fund next round’s winner bounty.' : ' Unmatched bets are refunded.'}</p>
    </section>
  </div>
}
