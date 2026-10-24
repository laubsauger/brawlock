/** Real renderless session used by TCP regressions and capacity clients. */
import type { LobbyView, MatchResult, Screen } from '../game/store'
import { createBot } from '../bots'
import { DEFAULT_SETTINGS, createMatch, step } from '../sim'
import type { SimState } from '../sim/types'
import { startClock } from '../net/clock'
import { Online, hybridNet, type ServerRegion } from '../net/online'
import { createSession } from '../net/session'
import type { NetFactory } from '../net/transport'
import { wsNet } from '../net/ws'

const noP2P: NetFactory = {
  host: () => Promise.reject(new Error('no p2p in this test')),
  join: () => Promise.reject(new Error('no p2p in this test')),
}

export interface ClientOpts {
  timeScale?: number
  onCommands?: (count: number) => void
  key?: string
  device?: string
  build?: string
  /** a bot plays the seat from the predicted view */
  play?: boolean
  /** extra regions next to `base` (multi-region builds) */
  regions?: ServerRegion[]
  name?: string
  profileId?: string
  color?: number
  /** peer-to-peer net (default: none) */
  p2p?: NetFactory
}

/** A headless browser client: the real session, the hybrid net, a bot at the keyboard. */
export function createHeadlessClient(base: string | null, opts: ClientOpts = {}) {
  const timeScale = opts.timeScale ?? 1
  let lobby = { role: 'offline', joinUrl: null, roomCode: null, status: 'idle', error: null, slots: [], settings: null, localPlayer: 0, pings: {}, ready: {} } as LobbyView
  let screen: Screen = 'menu'
  let shown: SimState | null = null
  const results: MatchResult[] = []
  let bot: ReturnType<typeof createBot> | null = null
  let thought = -1
  const online = new Online({ regions: [...(base ? [{ id: 'test', label: 'Test', url: base }] : []), ...(opts.regions ?? [])], build: opts.build ?? 'dev-test' })
  let routed: ServerRegion | null = null
  const notices: string[] = []
  const autoStarts: NonNullable<LobbyView['autoStart']>[] = []
  const session = createSession({
    ui: {
      lobby: () => lobby,
      setLobby: (p) => {
        lobby = { ...lobby, ...p }
        if (p.notice) notices.push(p.notice)
        if (p.autoStart) autoStarts.push({ ...p.autoStart })
      },
      screen: () => screen,
      setScreen: (s) => {
        screen = s
      },
      setResult: () => {},
      paused: () => false,
      onScreen: () => () => {},
    },
    profile: () => ({ id: opts.profileId ?? `profile-${opts.device ?? opts.key ?? 'headless'}`, name: opts.name ?? 'Headless', color: opts.color ?? null }),
    recorder: {
      start: (info) => {
        bot = opts.play !== false && info.localPlayer >= 0 ? createBot(info.localPlayer, 'hard', 99) : null
        thought = -1
      },
      observe: () => {},
      finish: (r) => {
        results.push(r)
      },
      abort: () => {},
    },
    frame: { reset: () => (shown = null), setLocalPlayer: () => {}, pushState: (s) => (shown = s), pushEvents: () => {}, setNet: () => {} },
    input: {
      drain: () => {
        const s = shown
        if (!bot || !s || s.tick === thought) return []
        thought = s.tick
        const commands = bot.think(s)
        opts.onCommands?.(commands.length)
        return commands
      },
    },
    audio: { playEvents: () => {} },
    createMatch,
    step,
    createBot,
    defaultSettings: DEFAULT_SETTINGS,
    net: hybridNet(opts.p2p ?? noP2P, online, (url) => wsNet(url), (r) => (routed = r)),
    startClock: (onPulse) => startClock((t) => onPulse(t * timeScale)),
    now: () => performance.now() * timeScale,
    random: Math.random,
    joinUrl: (c) => `http://test/?room=${c}`,
    clientKey: () => opts.key ?? 'headless-key',
    netMode: () => 'predict',
    device: opts.device ? () => opts.device! : undefined,
    build: opts.build ?? 'dev-test',
  })
  return { session, online, lobby: () => lobby, screen: () => screen, results, notices, autoStarts, shown: () => shown, routed: () => routed }
}
