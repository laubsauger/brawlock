import { useEffect, useRef } from 'react'
import { session } from '../../game/session'
import { useGame } from '../../game/store'
import { LOBBY_VOTE_CHOICES, LOBBY_VOTE_SETTINGS } from '../../net/lobbyVotes'
import { useTick } from '../lib/ticker'
import { sfx } from '../lib/sound'

/** Everyone sees the same proposal; only humans present when it opened can vote. */
export function LobbyVote() {
  const vote = useGame((s) => s.lobby.vote)
  const result = useGame((s) => s.lobby.voteResult)
  const local = useGame((s) => s.lobby.localPlayer)
  const countdown = useRef<HTMLSpanElement>(null)
  const lastHeard = useRef<number | null>(null)
  useEffect(() => {
    if (vote && vote.id !== lastHeard.current) {
      lastHeard.current = vote.id
      sfx('ready')
    }
  }, [vote])
  useTick((now) => {
    if (vote && countdown.current) countdown.current.textContent = `${Math.max(0, Math.ceil((vote.closesAt - now) / 1000))}s`
  })
  if (!vote) {
    if (!result) return null
    const why = result.reason === 'won' ? 'Vote passed' : result.reason === 'tie' ? 'Tied vote · kept host value' : result.reason === 'noVotes' ? 'No votes · kept host value' : 'Vote cancelled · host value kept'
    return <p role="status" className="mb-3 text-sm text-gold">{why} · {LOBBY_VOTE_SETTINGS[result.setting].label}: {result.value} gold</p>
  }
  const eligible = vote.eligible.includes(local)
  const selected = vote.votes[local]
  const definition = LOBBY_VOTE_SETTINGS[vote.setting]
  const cast = vote.eligible.filter((id) => vote.votes[id]).length
  return <section className="panel mb-3 flex flex-wrap items-center justify-between gap-3 border-gold/50 px-4 py-3" aria-label="Lobby vote" role="region">
    <div>
      <p className="font-bold text-gold" role="status">Lobby vote · {definition.label} <span ref={countdown} className="ml-2 tabular text-bone">10s</span></p>
      <p className="text-xs text-ash">{cast}/{vote.eligible.length} voted · Tie or no votes keeps {vote.current} gold.{!eligible && ' You joined after this vote opened.'}</p>
    </div>
    <div className="flex flex-wrap gap-2" role="group" aria-label={`Vote on ${definition.label}`}>
      {LOBBY_VOTE_CHOICES.map((choice) => <button key={choice} type="button" disabled={!eligible} aria-pressed={selected === choice} className={`rounded border px-3 py-2 text-sm disabled:opacity-40 ${selected === choice ? 'border-gold bg-gold/15 text-gold' : 'border-bone/20 bg-black/20 hover:border-gold/70'}`} onClick={() => { sfx('click'); session.castLobbyVote(vote.id, choice) }}>
        <span className="capitalize">{choice}</span> <strong>{definition.values[choice]}</strong>
      </button>)}
    </div>
  </section>
}
