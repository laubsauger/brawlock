/**
 * Session contract: owns the running lobby / match for every role.
 * - offline: local sim loop, local player + bots
 * - host: local sim loop, remote players via net, bots
 * - client: sends inputs, receives snapshots
 * UI calls these functions; state for UI goes to the zustand store (lobby, screen)
 * and per-frame data goes to game/frame.ts.
 * Owned by the net workstream; signatures are the contract.
 *
 * Implementation: src/net/session.ts (createSession). This file wires the real
 * store, frame buffer, input, audio, sim, bots and PeerJS into it.
 *
 * Errors never reject: openHost / join resolve and report failures through
 * lobby.status = 'error' + lobby.error, with screen 'menu'.
 */
import { audio } from '../audio'
import { createBot } from '../bots'
import { startClock } from '../net/clock'
import { codeFromSearch } from '../net/code'
import { joinUrlFor, peerNet } from '../net/peer'
import { createSession, type MatchRecorder, type SessionApi } from '../net/session'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import { frame, pushEvents, pushState, resetFrame } from './frame'
import { input } from './input'
import { getProfile } from './profile'
import { MatchTracker, recordMatch } from './stats'
import { useGame } from './store'

export type { SessionApi } from '../net/session'
export { PLAYER_COLORS, MAX_PLAYERS } from '../net/session'
export { parseRoomCode, codeFromSearch, roomLink, CODE_LENGTH } from '../net/code'

const CLIENT_KEY = 'brawlock.clientKey'

function randomKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

/** Per tab (survives reloads): lets a reloaded client reclaim its pawn mid-match. */
function clientKey(): string {
  try {
    let k = sessionStorage.getItem(CLIENT_KEY)
    if (!k) {
      k = randomKey()
      sessionStorage.setItem(CLIENT_KEY, k)
    }
    return k
  } catch {
    return randomKey()
  }
}

/** Room code from a `?room=CODE` invite link, or null. */
export function roomCodeFromUrl(): string | null {
  return typeof location === 'undefined' ? null : codeFromSearch(location.search)
}

/** Feeds game/stats.ts: one tracker per match, recorded at game over. */
function createRecorder(): MatchRecorder {
  let tracker: MatchTracker | null = null
  return {
    start: (info) => {
      tracker = new MatchTracker(info)
    },
    observe: (state, events) => tracker?.observe(state, events),
    finish: (result) => {
      if (tracker) recordMatch(tracker.finish(result), getProfile().id)
      tracker = null
    },
    abort: () => {
      tracker = null
    },
  }
}

const impl = createSession({
  ui: {
    lobby: () => useGame.getState().lobby,
    setLobby: (p) => useGame.getState().setLobby(p),
    screen: () => useGame.getState().screen,
    setScreen: (s) => useGame.getState().setScreen(s),
    setResult: (r) => useGame.getState().setResult(r),
    paused: () => useGame.getState().paused,
    onScreen: (cb) =>
      useGame.subscribe((s, prev) => {
        if (s.screen !== prev.screen) cb(s.screen)
      }),
  },
  frame: {
    reset: resetFrame,
    setLocalPlayer: (id) => {
      frame.localPlayer = id
    },
    pushState,
    pushEvents,
    setNet: (rttMs, lossPct) => {
      frame.net.rttMs = rttMs
      frame.net.lossPct = lossPct
    },
  },
  profile: () => getProfile(),
  recorder: createRecorder(),
  input,
  audio,
  createMatch,
  step,
  createBot,
  defaultSettings: DEFAULT_SETTINGS,
  net: peerNet,
  startClock,
  now: () => performance.now(),
  random: Math.random,
  joinUrl: joinUrlFor,
  clientKey,
})

export const session: SessionApi = {
  openOffline: impl.openOffline,
  openHost: impl.openHost,
  join: impl.join,
  addBot: impl.addBot,
  removeSlot: impl.removeSlot,
  setBotDifficulty: impl.setBotDifficulty,
  setTeam: impl.setTeam,
  updateSettings: impl.updateSettings,
  startMatch: impl.startMatch,
  rematch: impl.rematch,
  backToLobby: impl.backToLobby,
  setReady: impl.setReady,
  leave: impl.leave,
}

// dev-only probe for two-tab testing from the console: __session.debug()
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __session: typeof impl }).__session = impl
}
