import { create } from 'zustand'
import type { BotDifficulty, MatchSettings, PlayerId, PlayerScore, PlayerSlot } from '../sim/types'

/**
 * App-level UI state. Components subscribe with narrow selectors
 * (useGame((s) => s.screen)) so unrelated changes never re-render them.
 * Per-frame values (hp, cooldowns, positions) do NOT live here: HUD reads
 * src/game/frame.ts from its own rAF and writes DOM directly.
 */

export type Screen = 'boot' | 'unsupported' | 'menu' | 'lobby' | 'match' | 'results' | 'credits'

export type Quality = 'low' | 'medium' | 'high' | 'ultra'

export interface Settings {
  quality: Quality
  /** 0..1, scales screen shake and post fx */
  fxIntensity: number
  masterVolume: number
  sfxVolume: number
  musicVolume: number
  muted: boolean
  playerName: string
  showPerf: boolean
}

export type NetRole = 'offline' | 'host' | 'client'

export interface LobbyView {
  role: NetRole
  /** shareable join link (host only) */
  joinUrl: string | null
  status: 'idle' | 'connecting' | 'open' | 'error'
  error: string | null
  slots: PlayerSlot[]
  settings: MatchSettings | null
  localPlayer: number
}

export interface MatchResult {
  winners: PlayerId[]
  slots: PlayerSlot[]
  scores: PlayerScore[]
  rounds: number
}

interface GameStore {
  screen: Screen
  /** set when a match ends, shown on the results screen */
  result: MatchResult | null
  settings: Settings
  lobby: LobbyView
  /** UI overlays inside a match */
  shopOpen: boolean
  scoreboardOpen: boolean
  characterOpen: boolean
  paused: boolean

  setScreen: (s: Screen) => void
  setResult: (r: MatchResult | null) => void
  setSettings: (s: Partial<Settings>) => void
  setLobby: (l: Partial<LobbyView>) => void
  toggle: (k: 'shopOpen' | 'scoreboardOpen' | 'characterOpen' | 'paused', v?: boolean) => void
}

const SETTINGS_KEY = 'brawlock.settings.v1'

const defaultSettings: Settings = {
  quality: 'high',
  fxIntensity: 1,
  masterVolume: 0.8,
  sfxVolume: 1,
  musicVolume: 0.6,
  muted: false,
  playerName: 'Warlock',
  showPerf: false,
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) }
  } catch {
    /* private mode or corrupt data: defaults */
  }
  return defaultSettings
}

export const useGame = create<GameStore>((set, get) => ({
  screen: 'boot',
  result: null,
  settings: loadSettings(),
  lobby: {
    role: 'offline',
    joinUrl: null,
    status: 'idle',
    error: null,
    slots: [],
    settings: null,
    localPlayer: 0,
  },
  shopOpen: false,
  scoreboardOpen: false,
  characterOpen: false,
  paused: false,

  setScreen: (screen) => set({ screen }),
  setResult: (result) => set({ result }),
  setSettings: (s) => {
    const settings = { ...get().settings, ...s }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      /* ignore */
    }
    set({ settings })
  },
  setLobby: (l) => set({ lobby: { ...get().lobby, ...l } }),
  toggle: (k, v) => set({ [k]: v ?? !get()[k] } as Partial<GameStore>),
}))

export const BOT_DIFFICULTIES: BotDifficulty[] = ['dummy', 'easy', 'medium', 'hard', 'brutal']
