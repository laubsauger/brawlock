/**
 * Screen flow glue between UI buttons and the session (src/game/session.ts,
 * net workstream). The session owns lobby state and switches screens itself
 * (lobby on open / join, match on start, results after game over, menu with
 * lobby.error on a fatal error). These helpers only close in-match overlays
 * and keep the few UI-owned transitions in one place.
 */
import { useSyncExternalStore } from 'react'
import { session, type HostResult } from '../game/session'
import type { RoomRoute } from '../net/rejoin'
import { useGame } from '../game/store'
import { parseRoomCode } from '../net/code'
import { tutorial } from './lib/onboarding'
import { clearPendingRoom, rememberPendingRoom } from '../lib/pendingRoom'

function closeOverlays() {
  const s = useGame.getState()
  s.toggle('shopOpen', false)
  s.toggle('scoreboardOpen', false)
  s.toggle('characterOpen', false)
  s.toggle('paused', false)
}

export function playOffline(): void {
  tutorial.request({ label: 'Play vs bots', run: () => session.openOffline() })
}

/** What the last attempt was, for the failure line ("Couldn't join quick play.") */
export type HostAction = 'pc' | 'server' | 'quick'
let lastAction: HostAction | null = null
export function lastHostAction(): HostAction | null {
  return lastAction
}

/** The last host attempt's outcome, so a failure can offer the other mode in one click. */
let lastHost: HostResult | null = null
const hostSubs = new Set<() => void>()
function setLastHost(r: HostResult | null) {
  lastHost = r
  for (const f of hostSubs) f()
}
export function lastHostResult(): HostResult | null {
  return lastHost
}
/** React: the last host outcome (re-renders when an attempt finishes). */
export function useLastHostResult(): HostResult | null {
  return useSyncExternalStore(
    (cb) => {
      hostSubs.add(cb)
      return () => hostSubs.delete(cb)
    },
    () => lastHost,
  )
}

/** "Host from your PC" (peer-to-peer). Never switches to the game server by itself. */
export function hostGame(listed = false): void {
  tutorial.request({
    label: 'Host from your PC',
    run: () => {
      lastAction = 'pc'
      setLastHost(null)
      void session.openHost().then((result) => {
        setLastHost(result)
        if (result.ok && listed) session.setPublic(true)
      })
    },
  })
}

/** Quick play: an open game on the server (or a new one, filled with bots). */
export function quickPlay(region: string): void {
  tutorial.request({
    label: 'Find a game',
    run: () => {
      lastAction = 'quick'
      setLastHost(null)
      void session.quickPlay({ region }).then(setLastHost)
    },
  })
}

/** Host on a game server: a region id, or 'auto' (lowest ping among regions that are up). */
export function hostOnServer(region: string, listed = false): void {
  tutorial.request({
    label: 'Host on a server',
    run: () => {
      lastAction = 'server'
      setLastHost(null)
      void session.openHostServer(region).then((result) => {
        setLastHost(result)
        if (result.ok && listed) session.setPublic(true)
      })
    },
  })
}

/** Join by room code (typed, pasted with dashes / spaces, or a whole ?room= link). */
export function joinRoom(text: string, onCancel?: () => void, route?: RoomRoute): { problem: string } | null {
  const r = parseRoomCode(text)
  if ('problem' in r) return r
  rememberPendingRoom(r.code)
  tutorial.request({
    label: 'Join game',
    run: () => { void session.join(r.code, route).finally(() => clearPendingRoom(r.code)) },
    cancel: () => { clearPendingRoom(r.code); onCancel?.() },
  })
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
  clearPendingRoom()
  closeOverlays()
  session.leave()
}
