/**
 * Screen flow glue between UI buttons and the session (src/game/session.ts,
 * net workstream). The session owns lobby state and switches screens itself
 * (lobby on open / join, match on start, results after game over, menu with
 * lobby.error on a fatal error). These helpers only close in-match overlays
 * and keep the few UI-owned transitions in one place.
 */
import { session } from '../game/session'
import { useGame } from '../game/store'
import { parseRoomCode } from '../net/code'

function closeOverlays() {
  const s = useGame.getState()
  s.toggle('shopOpen', false)
  s.toggle('scoreboardOpen', false)
  s.toggle('characterOpen', false)
  s.toggle('paused', false)
}

export function playOffline(): void {
  session.openOffline()
}

export function hostGame(): void {
  void session.openHost()
}

/** Join by room code (typed, pasted with dashes / spaces, or a whole ?room= link). */
export function joinRoom(text: string): { problem: string } | null {
  const r = parseRoomCode(text)
  if ('problem' in r) return r
  void session.join(r.code)
  return null
}

export function startMatch(): void {
  closeOverlays()
  session.startMatch()
}

/**
 * Results screen, one click. Host / offline: new match with the same slots and
 * settings. Client: flags "ready for a rematch" for the host to see.
 */
export function rematch(): void {
  closeOverlays()
  if (typeof session.rematch === 'function') session.rematch()
  else session.startMatch()
}

/** Host / offline: everyone back to the lobby. Client: own screen only. */
export function backToLobby(): void {
  closeOverlays()
  if (typeof session.backToLobby === 'function') session.backToLobby()
  else useGame.getState().setScreen('lobby')
}

export function setReady(ready: boolean): void {
  if (typeof session.setReady === 'function') session.setReady(ready)
}

export function leaveToMenu(): void {
  closeOverlays()
  session.leave()
}
