import { useEffect, useState } from 'react'
import { session, type HistoryQueue, type MatchHistoryEntry } from '../../game/session'
import { TICK_HZ } from '../../sim'
import { BuildIcons } from '../BuildIcons'
import { ago, duration } from '../lib/stats'
import { hex } from '../lib/view'
import { Button, Segmented } from '../widgets'

export type MatchQueueFilter = 'all' | 'casual' | 'ranked'

export function MatchQueueTabs({ value, onChange }: { value: MatchQueueFilter; onChange: (value: MatchQueueFilter) => void }) {
  return <Segmented label="Match queue" value={value} onChange={onChange} options={[
    { value: 'all', label: 'All' },
    { value: 'casual', label: 'Casual' },
    { value: 'ranked', label: 'Ranked' },
  ]} />
}

const queueName: Record<HistoryQueue, string> = { ranked: 'Ranked', casual: 'Casual', custom: 'Custom' }
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`

/** Stored server results only: missing historical fields stay visibly unavailable. */
export function ServerMatchList({ matches, personal = true }: { matches: readonly MatchHistoryEntry[]; personal?: boolean }) {
  return <ul className="flex flex-col gap-2" aria-label="Online match history">{matches.map((match) => {
    const me = match.players.find((p) => p.player === match.self)
    const win = match.outcome === 'win'
    return <li key={match.id}>
      <details className="rounded-lg border-l-[3px] bg-black/25" style={{ borderLeftColor: win ? '#7fe39a' : '#ff6a55' }}>
        <summary className="cursor-pointer rounded px-3 py-3 focus-visible:outline-2 focus-visible:outline-gold">
          <span className="inline-flex w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-3 gap-y-1 align-middle">
            <b className={win ? 'text-heal' : 'text-[#ff9b8a]'}>{win ? 'Win' : match.outcome === 'forfeit' ? 'Loss · left game' : 'Loss'}</b>
            <span className="chip text-xs">{queueName[match.queue]}</span>
            <span className={`tabular text-sm ${match.delta !== null && match.delta > 0 ? 'text-heal' : match.delta !== null && match.delta < 0 ? 'text-[#ff9b8a]' : 'text-ash'}`}>
              {match.delta === null ? 'Not rated' : `${signed(match.delta)} Elo${match.rating === null ? '' : ` · ${match.rating}`}`}
            </span>
            <span className="min-w-0 basis-full break-words text-sm text-bone sm:basis-48 sm:flex-1">{match.players.map((p) => p.name).join(' · ')}</span>
            {me && <span className="tabular text-sm text-ash">{me.kills} / {me.deaths} K/D</span>}
            <span className="tabular text-sm text-ash">{duration(match.ticks / TICK_HZ)}</span>
            <span className="text-sm text-ash">{ago(match.at)}</span>
          </span>
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <p className="text-sm text-ash">{match.region} · {match.teamMode === 'ffa' ? 'Free for all' : match.teamMode === 'teams' ? 'Teams' : 'Shuffle'} · {match.gameMode === 'deathmatch' ? 'Deathmatch' : `${match.rounds} rounds`}</p>
          {match.outcome === 'forfeit' && <p className="text-sm text-[#ffb08a]">Left after at least 60 seconds of combat. Recorded as a loss when the match finished.</p>}
          <ul className="grid gap-2 lg:grid-cols-2" aria-label="Recorded players and equipment">{match.players.map((player) => <li key={player.player} className="min-w-0 rounded bg-black/20 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              {player.color !== undefined && <i className="h-2.5 w-2.5 rotate-45 rounded-[1px]" style={{ background: hex(player.color) }} aria-hidden />}
              <b className={player.player === match.self ? 'text-gold' : 'text-bone'}>{player.name}</b>
              {personal && player.player === match.self && <span className="text-xs text-ash">(you)</span>}
              {player.kind === 'bot' && <span className="text-xs text-ash">bot</span>}
              {player.forfeited ? <span className="text-xs text-[#ff9b8a]">left game · loss</span> : player.won && <span className="text-xs text-heal">won</span>}
              <span className="tabular ml-auto text-ash">{player.kills} / {player.deaths} K/D</span>
            </div>
            {(player.score !== undefined || (player.roundsWon !== undefined && player.roundsPlayed !== undefined)) && <p className="mt-1 text-xs text-ash">{[
              player.score !== undefined ? `Score ${player.score}` : null,
              player.roundsWon !== undefined && player.roundsPlayed !== undefined ? `Rounds ${player.roundsWon}/${player.roundsPlayed}` : null,
            ].filter((text) => text !== null).join(' · ')}</p>}
            {player.build ? <div className="mt-2" aria-label={`${player.name}'s recorded equipment`}><BuildIcons kit={player.build} size={25} /></div> : <p className="mt-2 text-xs text-ash">Equipment was not recorded for this player.</p>}
          </li>)}</ul>
          <p className="text-xs text-ash">Equipment shows the last recorded combat build, including upgrades and mastery levels.</p>
        </div>
      </details>
    </li>
  })}</ul>
}

/** The same authoritative history for your own record and a public player profile. */
export function ServerMatches({ queue, publicId }: { queue?: MatchQueueFilter; publicId?: string }) {
  const [filter, setFilter] = useState<MatchQueueFilter>('all')
  const selected = queue ?? filter
  const [response, setResult] = useState<{ key: string; matches: MatchHistoryEntry[]; error: string | null } | null>(null)
  const [revision, setRevision] = useState(0)
  const requestKey = JSON.stringify([selected, publicId, revision])
  const result = response?.key === requestKey ? response : null
  useEffect(() => {
    let active = true
    setResult(null)
    void session.matchHistory(selected === 'all' ? undefined : selected, publicId).then((matches) => {
      if (active) setResult({ key: requestKey, matches, error: null })
    }).catch((cause: unknown) => {
      if (active) setResult({ key: requestKey, matches: [], error: cause instanceof Error ? cause.message : String(cause) })
    })
    return () => { active = false }
  }, [selected, publicId, revision, requestKey])
  return <section className="flex flex-col gap-3" data-testid="server-matches">
    <div className="flex flex-wrap items-center justify-between gap-2">
      {queue === undefined ? <MatchQueueTabs value={selected} onChange={setFilter} /> : <p className="text-sm text-ash">Matches recorded by the game server.</p>}
      <Button size="sm" variant="ghost" onClick={() => setRevision((n) => n + 1)}>Refresh matches</Button>
    </div>
    {!result ? <p role="status" className="py-6 text-center text-ash">Loading online matches…</p>
      : result.error ? <p role="alert" className="py-3 text-[#ffb08a]">{result.error}</p>
        : result.matches.length === 0 ? <p className="py-6 text-center text-ash">No {selected === 'all' ? 'online' : selected} matches recorded yet.</p>
          : <ServerMatchList matches={result.matches} personal={!publicId} />}
  </section>
}
