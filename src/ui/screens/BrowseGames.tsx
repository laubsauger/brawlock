import { useEffect, useState } from 'react'
import { online, type PublicRoom } from '../../game/session'
import { useGame } from '../../game/store'
import { Button, Kbd } from '../widgets'
import { RegionPing } from '../RegionPing'
import { sfx } from '../lib/sound'
import { joinRoom } from '../flow'
import { liveEloLabel } from '../lib/elo'
import { isPlaySupported, PLAY_REQUIREMENT, usePlaySupported } from '../lib/playAccess'

/** how often the list refreshes (the server caches it ~1 s and allows 60 lists a minute) */
export const BROWSE_REFRESH_MS = 4000

const STATUS: Record<PublicRoom['phase'], { label: string; tone: string }> = {
  lobby: { label: 'Waiting', tone: 'bg-[rgba(127,227,154,0.14)] text-heal' },
  results: { label: 'Between matches', tone: 'bg-[rgba(255,197,72,0.14)] text-gold' },
  match: { label: 'In a match', tone: 'bg-[rgba(255,255,255,0.06)] text-ash' },
} as Record<string, { label: string; tone: string }>

const MODE: Record<string, string> = { ffa: 'Free for all', teams: 'Teams', shuffle: 'Shuffled teams' }

/** "Free for all · first to 5" */
export function roomMode(r: Pick<PublicRoom, 'teamMode' | 'gameMode' | 'winScore' | 'rankedRounds'>): string {
  const mode = MODE[r.teamMode] ?? r.teamMode
  if (r.rankedRounds) return `${mode} · ${r.rankedRounds} rounds · final if tied`
  return r.gameMode === 'rounds' || !r.gameMode ? `${mode} · first to ${r.winScore}` : `${mode} · ${r.gameMode}`
}

/**
 * Open games on the game servers: who hosts, how full, what mode, waiting /
 * between matches / in a match, and the ping of their region. One click joins.
 * Refreshes every few seconds while open.
 */
export function BrowseGames({ onBack, onHost }: { onBack: () => void; onHost: () => void }) {
  const playSupported = usePlaySupported()
  const [rooms, setRooms] = useState<PublicRoom[] | null>(null)
  const [joining, setJoining] = useState<string | null>(null)
  // a join that failed lands back here with lobby.error: say so and allow another try
  const failed = useGame((s) => (s.lobby.status === 'error' ? s.lobby.error : null))
  const setLobby = useGame((s) => s.setLobby)
  useEffect(() => {
    if (failed) setJoining(null)
  }, [failed])

  useEffect(() => {
    let alive = true
    const load = () => void online.browse().then((r) => alive && setRooms(r))
    load()
    const id = window.setInterval(load, BROWSE_REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onBack()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const join = (room: PublicRoom) => {
    if (!isPlaySupported()) return
    const code = room.code
    sfx('click')
    if (failed) setLobby({ status: 'idle', error: null })
    setJoining(code)
    const problem = joinRoom(code, () => setJoining(null), room.kind === 'p2p' ? { kind: 'p2p' } : { kind: 'server', region: room.region.id })
    if (problem) {
      setJoining(null)
      setLobby({ status: 'error', error: problem.problem })
    }
  }

  return (
    <div className="screen-in flex h-full flex-col px-[max(16px,5vw)] py-[max(16px,4vh)]">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="display text-6xl leading-none text-[#ffd890]">Browse games</h1>
          <p className="text-[1rem] text-[#e6d3b8]">Open games. Hosts choose whether their game is listed.</p>
          {!playSupported && <p data-testid="play-requirement" className="text-sm text-[#f3d3a1]">{PLAY_REQUIREMENT}</p>}
        </div>
        <div className="flex flex-wrap gap-3">
        <Button variant="primary" disabled={!playSupported} title={!playSupported ? PLAY_REQUIREMENT : undefined} onClick={() => { if (isPlaySupported()) onHost() }} data-testid="browse-host">Host a game</Button>
        <Button sound="back" onClick={onBack}>
          Back <Kbd>Esc</Kbd>
        </Button>
        </div>
      </header>
      <section className="panel panel-solid flex min-h-0 flex-1 flex-col p-5" aria-label="Open games">
        {failed && (
          <p role="alert" className="mb-3 rounded-md border border-[rgba(255,90,70,0.4)] bg-[rgba(90,12,10,0.55)] px-4 py-2 text-[#ffd3c9]">
            Couldn't join that game. {failed}
          </p>
        )}
        {rooms === null ? (
          <p className="py-10 text-center text-ash">Looking for games…</p>
        ) : rooms.length === 0 ? (
          <p className="py-10 text-center text-[1.05rem] text-ash">No open games right now. Host a game to open a lobby, or try Quick play.</p>
        ) : (
          <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto pr-1" data-testid="browse-list">
            {rooms.map((r) => {
              const st = STATUS[r.phase] ?? STATUS.match
              const elo = liveEloLabel(r)
              const rankedClosed = r.ranked && r.phase !== 'lobby'
              const full = r.humans >= r.max || rankedClosed
              const nextRound = r.phase === 'match' && r.joinable !== undefined && r.joinable > 0
              const watch = r.phase === 'match' && r.joinable === 0
              const joinLabel = nextRound ? 'Join next round' : watch ? 'Watch' : 'Join'
              const joinTitle = full ? 'This game is full' : nextRound ? 'Watch this round and take a bot seat for the next round' : watch ? 'Watch now and play from the next match' : undefined
              return (
                <li key={`${r.kind}:${r.code}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-[rgba(0,0,0,0.28)] px-4 py-2.5">
                  <span className="flex min-w-[12rem] flex-1 flex-col leading-tight">
                    <span className="truncate text-[1.08rem] font-bold">
                      {r.ranked ? 'Ranked' : r.quick ? 'Quick play · Casual' : r.host ? `${r.host}'s game` : 'Open game'}
                      {r.kind === 'p2p' && <span className="ml-2 align-middle text-[0.78rem] font-semibold tracking-wide text-ash uppercase">Player-hosted</span>}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.86rem] text-ash">
                      <span>{roomMode(r)}</span>
                      <span className={`chip px-2 py-0.5 text-[0.68rem] ${elo.tone}`} title={elo.title} aria-label={`${elo.label}: ${elo.title}`}>{elo.label}</span>
                    </span>
                  </span>
                  <span className="tabular w-36 text-[0.95rem] text-[#e6d3b8]" title={`${r.humans} players, ${r.bots} bots, ${r.max} seats`}>
                    {r.humans} {r.humans === 1 ? 'player' : 'players'}
                    {r.bots > 0 ? <span className="text-ash"> + {r.bots} bots</span> : null}
                  </span>
                  <span className={`chip w-36 justify-center ${st.tone}`}>{st.label}</span>
                  <span className="w-44">
                    {r.kind === 'p2p' ? (
                      <span className="text-[0.95rem] text-ash" title="Hosted from a player's PC: the ping shows once you join">
                        – <span className="text-[0.86rem]">near {r.region.label}</span>
                      </span>
                    ) : (
                      <RegionPing s={r.region} withName />
                    )}
                  </span>
                  <Button size="sm" variant={r.phase === 'match' ? 'default' : 'primary'} disabled={!playSupported || full || joining !== null} onClick={() => join(r)} title={!playSupported ? PLAY_REQUIREMENT : joinTitle}>
                    {joining === r.code ? 'Joining…' : rankedClosed ? 'In progress' : full ? 'Full' : joinLabel}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
