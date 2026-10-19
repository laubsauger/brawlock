import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { rejoin } from '../../game/session'
import { Button, Modal } from '../widgets'
import { isPlaySupported, PLAY_REQUIREMENT, usePlaySupported } from '../lib/playAccess'

/** Explicit recovery: discovery never dials, and declining the popup keeps the menu shortcut. */
export function RejoinPrompt() {
  const playSupported = usePlaySupported()
  const room = useSyncExternalStore(rejoin.subscribe, rejoin.get, () => null)
  const prompted = useRef<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!room || room.status !== 'available' || !playSupported) return
    const key = `${room.kind}:${room.code}`
    if (prompted.current === key) return
    prompted.current = key
    setOpen(true)
  }, [room?.kind, room?.code, room?.status, playSupported])
  if (!room) return null
  const busy = room.status === 'checking' || room.status === 'joining'
  const label = room.status === 'checking' ? 'Checking your game…' : room.status === 'joining' ? 'Rejoining…' : room.status === 'unavailable' ? 'Check again' : 'Rejoin game'
  const join = () => {
    if (!isPlaySupported()) return
    if (room.status === 'available') void rejoin.join()
    else void rejoin.refresh()
  }
  const explanation = 'Return to the same room. If a round is underway, you may watch until the next round.'
  return <>
    <section className="mt-3 mb-1 rounded-lg border border-gold/50 bg-[#24190f]/95 px-4 py-3 shadow-[0_0_24px_rgba(255,170,60,.10)]" aria-label="Rejoin your game" data-testid="rejoin-game">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-semibold text-[#ffe0a9]">{room.status === 'unavailable' ? 'Previous game unavailable' : 'Back to your game?'}</h2>
          <span className="text-xs text-ash">{room.code} · {room.kind === 'server' ? 'Game server' : 'Player hosted'}</span>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="primary" disabled={!playSupported || busy} title={!playSupported ? PLAY_REQUIREMENT : undefined} onClick={join}>{label}</Button>
          <Button size="sm" variant="ghost" disabled={room.status === 'joining'} onClick={rejoin.dismiss}>Dismiss</Button>
        </div>
      </div>
      <p className="mt-1.5 text-xs leading-snug text-ash">{playSupported ? explanation : PLAY_REQUIREMENT}</p>
      {room.error && <p className="mt-1 text-xs leading-snug text-[#ffb08a]" role="status">{room.error}</p>}
    </section>
    {open && playSupported && room.status !== 'unavailable' && createPortal(<Modal title="Rejoin your game" width="max-w-lg" onClose={() => setOpen(false)}>
      <p className="text-[#f0dfc8]">You were connected to room <b className="tabular text-gold">{room.code}</b>. Rejoin where you left off.</p>
      <p className="mt-2 text-sm leading-snug text-ash">{explanation}</p>
      {room.error && <p className="mt-2 text-sm text-[#ffb08a]" role="status">{room.error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button disabled={room.status === 'joining'} onClick={() => setOpen(false)}>Stay in menu</Button>
        <Button variant="primary" disabled={busy} onClick={join}>{label}</Button>
      </div>
    </Modal>, document.body)}
  </>
}
