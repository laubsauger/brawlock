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
import { isPlaySupported, PLAY_REQUIREMENT } from './lib/playAccess'
import type { AccountGame } from '../net/accounts'

/** Reject before onboarding or reserving a matchmaking seat. Browsing stays available. */
function allowPlay(): boolean {
  if (isPlaySupported()) return true
  clearPendingRoom()
  useGame.getState().setScreen('menu')
  return false
}

function closeOverlays() {
  const s = useGame.getState()
  s.toggle('shopOpen', false)
  s.toggle('scoreboardOpen', false)
  s.toggle('characterOpen', false)
  s.toggle('paused', false)
}

export function continueRankedHere(game: AccountGame): Promise<void> {
  if (!allowPlay()) return Promise.resolve()
  closeOverlays()
  return session.useRankedHere(game)
}

export function playOffline(): void {
  if (!allowPlay()) return
  tutorial.request({ label: 'Play vs bots', run: () => session.openOffline() })
}

/** Choosing the lesson cancels the intercepted play action; it never queues first. */
export function guidedPractice(): void {
  if (!allowPlay()) return
  tutorial.dismiss()
  closeOverlays()
  session.openPractice()
}

export function playBotPractice(): void {
  if (!allowPlay()) return
  if (session.isActive()) { session.resume(); return }
  closeOverlays()
  void session.openOffline().then(() => {
    if (useGame.getState().lobby.status !== 'open' || useGame.getState().lobby.role !== 'offline') return
    session.addBot('easy'); session.addBot('easy'); session.startMatch()
  })
}

/** What the last attempt was, for the failure line ("Couldn't join casual matchmaking.") */
export type HostAction = 'pc' | 'server' | 'quick' | 'ranked'
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
export function hostGame(listed = true): void {
  if (!allowPlay()) return
  tutorial.request({
    label: 'Host from your PC',
    run: () => {
      lastAction = 'pc'
      setLastHost(null)
      void session.openHost().then((result) => {
        setLastHost(result)
        if (result.ok) session.setPublic(listed)
      })
    },
  })
}

/** Casual matchmaking: an open game on the server (or a new one, filled with bots). */
export function quickPlay(region: string): void {
  if (!allowPlay()) return
  tutorial.request({
    label: 'Find a casual match',
    run: () => {
      lastAction = 'quick'
      setLastHost(null)
      void session.quickPlay({ region }).then(setLastHost)
    },
  })
}

/**
 * New game from a results screen: leave this room for a fresh one of the same kind (casual never
 * returns to the room being left; ranked never offers a room on its results screen).
 */
export function newGame(): void {
  const lobby = useGame.getState().lobby
  const region = useGame.getState().settings.serverRegion
  if (!allowPlay()) return
  clearPendingRoom()
  session.leave()
  if (lobby.ranked) {
    rankedPlay(region)
    return
  }
  lastAction = 'quick'
  setLastHost(null)
  void session.quickPlay({ region, exclude: lobby.roomCode ?? undefined }).then(setLastHost)
}

/** Ranked keeps its fixed rules and waits for an opponent after the first-play guide. */
export function rankedPlay(region: string): void {
  if (!allowPlay()) return
  tutorial.request({
    label: 'Find a ranked opponent',
    run: () => {
      lastAction = 'ranked'
      setLastHost(null)
      void session.rankedPlay({ region }).then(setLastHost)
    },
  })
}

/** Host on a game server: a region id, or 'auto' (lowest ping among regions that are up). */
export function hostOnServer(region: string, listed = true): void {
  if (!allowPlay()) return
  tutorial.request({
    label: 'Host on a server',
    run: () => {
      lastAction = 'server'
      setLastHost(null)
      void session.openHostServer(region).then((result) => {
        setLastHost(result)
        if (result.ok) session.setPublic(listed)
      })
    },
  })
}

/** Join by room code (typed, pasted with dashes / spaces, or a whole ?room= link). */
export function joinRoom(text: string, onCancel?: () => void, route?: RoomRoute): { problem: string } | null {
  if (!allowPlay()) return { problem: PLAY_REQUIREMENT }
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
