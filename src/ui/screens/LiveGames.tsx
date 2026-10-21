import type { PublicRoom } from '../../game/session'
import { Button } from '../widgets'
import { PLAY_REQUIREMENT, usePlaySupported } from '../lib/playAccess'
import { roomActivity } from '../lib/roomActivity'
import { roomJoin, roomTitle, useRoomJoin } from './BrowseGames'

/** At most this many games on the menu; the rest are one click away in Browse games. */
const SHOWN = 3

/** Open games with people in them that a newcomer can still join or watch, best first. */
export function liveGames(rooms: readonly PublicRoom[]): PublicRoom[] {
  // the list arrives sorted: open lobbies, then between matches, then running; nearer first
  return rooms.filter((r) => r.humans > 0 && !roomJoin(r).closed).slice(0, SHOWN)
}

/**
 * Main menu card under the player card: real people playing right now, one click to join,
 * and the way into Browse games. Hidden while nobody is playing.
 */
export function LiveGames({ rooms, onSeeAll }: { rooms: readonly PublicRoom[] | null; onSeeAll: () => void }) {
  const playSupported = usePlaySupported()
  const { joining, join } = useRoomJoin()
  const shown = rooms ? liveGames(rooms) : []
  if (!shown.length) return null
  return (
    <section className="menu-live-games" aria-label="Open games" data-testid="live-games">
      <header className="flex items-center justify-between gap-2 px-3.5 pt-2.5 pb-1.5">
        <span className="flex items-center gap-2 text-[0.72rem] font-semibold tracking-[0.12em] text-[#d9bf9c] uppercase">
          <span aria-hidden className="browse-live-dot h-1.5 w-1.5 rounded-full bg-[#ffcd9f]" />
          Open games
        </span>
        <button type="button" className="text-[0.8rem] text-[#e8c79a] hover:text-[#ffe3b8]" onClick={onSeeAll} data-testid="live-games-all">See all games ›</button>
      </header>
      <ul className="flex flex-col">
        {shown.map((r) => {
          // short labels keep the room line readable; the tooltip says a running match seats you next round
          const entry = roomJoin(r)
          const activity = roomActivity(r)
          const where = r.kind === 'p2p' ? `near ${r.region.label}` : r.region.rttMs != null ? `${r.region.label} · ${r.region.rttMs} ms` : r.region.label
          return (
            <li key={`${r.kind}:${r.code}`} className="flex items-center gap-3 border-t border-[#b58b55]/15 px-3.5 py-2">
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[0.98rem] font-bold text-bone">{roomTitle(r)}</span>
                <span className="truncate text-[0.78rem] text-ash">
                  {r.humans} {r.humans === 1 ? 'player' : 'players'} · {activity.label} · {where}
                </span>
              </span>
              <Button size="sm" variant={r.phase === 'match' ? 'default' : 'primary'} disabled={!playSupported || joining !== null} onClick={() => join(r)} title={!playSupported ? PLAY_REQUIREMENT : entry.title}>
                {joining === r.code ? 'Joining…' : entry.label === 'Join next round' ? 'Join' : entry.label}
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
