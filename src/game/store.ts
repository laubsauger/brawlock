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

/**
 * Hotkey preset (docs/PLAN.md §6, tables in src/ui/lib/keys.ts).
 * Brawlock (default) = Fireball Q, Scourge W, spells E R T D F G, items Z X C V;
 * Dota = Q W E D F R + Z X C V B N, Modern = Q W E R D F + 1-6, Classic = D R T E C Y + 1-6.
 */
export type KeyPreset = 'brawlock' | 'dota' | 'modern' | 'classic'

/**
 * Dota cast modes. quick: the key casts at the cursor at once. release: hold
 * the key to aim (range ring), cast on release. normal: the key enters
 * targeting, left click casts, right click or Esc cancels.
 */
export type CastMode = 'quick' | 'release' | 'normal'

/** Graphics backend found at boot. 'fallback' = no WebGPU, three runs on WebGL2. */
export type GpuSupport = 'unknown' | 'webgpu' | 'fallback'

export interface Settings {
  quality: Quality
  /** 0..1, scales flashes and post fx (screen shake is screenShake only) */
  fxIntensity: number
  /** 0..1, camera shake and hit kick (render prefs; 0 = no shake at all) */
  screenShake: number
  /** frame rate cap in Hz, 0 = uncapped (render prefs) */
  fpsCap: 0 | 30 | 60 | 120 | 144
  /** 0.5..1, factor on the quality tier's pixel ratio (render prefs) */
  resolutionScale: number
  /** how far edge pan and camera peek may look away from your warlock (render prefs) */
  cameraReach: 'short' | 'normal' | 'far'
  /** 0.25..2, edge-pan speed factor (render prefs) */
  edgePanSpeed: number
  masterVolume: number
  sfxVolume: number
  musicVolume: number
  ambienceVolume: number
  /** announcer voice lines (First Blood, multi-kills, streaks) */
  announcerVolume: number
  announcerVoice: 'maverick' | 'arena'
  muted: boolean
  playerName: string
  showPerf: boolean
  keyPreset: KeyPreset
  /** per-action overrides on top of the preset: action id -> KeyboardEvent.code */
  keybinds: Partial<Record<string, string>>
  /** secondary key per action on top of the preset's secondary; '' = explicitly unbound */
  keybindsAlt: Partial<Record<string, string>>
  castMode: CastMode
  /** per-slot cast mode override, slot index 0..11 -> mode */
  castModeSlots: Partial<Record<number, CastMode>>
  /** HUD and in-match panel scale on top of the automatic resolution scale, 0.8..1.2 */
  uiScale: number
  /** bottom HUD cluster: centered like Dota, or tucked into the bottom-right corner */
  hudLayout: 'center' | 'right'
  /** audio: recorded layers on top of synthesis, or synthesis only */
  soundStyle: 'hybrid' | 'synth'
  /** net graph overlay (also F3): per-link ping, jitter and loss sparklines */
  netGraph: boolean
  /** key legend at the bottom left of the match HUD */
  showHints: boolean
  /** a move during a cast windup cancels the cast (original / Dota); off: the move waits for the spell */
  moveCancelsCast: boolean
  /** settings migrations already applied (see migrateSettings) */
  settingsVersion: number
  /** colourblind-safe player palette plus a shape per player (game/playerPalette.ts) */
  colorblindPalette: boolean
  /**
   * online netcode, read at every match start: 'predict' = client-side prediction on
   * the host's input stream (own inputs react at once, ~5-20 KB/s), 'snapshot' =
   * prediction on full snapshots (fallback), 'classic' = interpolated host snapshots
   * (escape hatch). `?net=predict|snapshot|classic` in the URL overrides it.
   */
  netMode: 'predict' | 'snapshot' | 'classic'
}

export type NetRole = 'offline' | 'host' | 'client'

export interface LobbyView {
  role: NetRole
  /** shareable join link (host only) */
  joinUrl: string | null
  /** 5-letter room code (host: its room, client: the room joined), null offline */
  roomCode: string | null
  status: 'idle' | 'connecting' | 'open' | 'error'
  error: string | null
  slots: PlayerSlot[]
  settings: MatchSettings | null
  localPlayer: number
  /**
   * Transient, non-fatal session message for lobby / HUD toasts ("Bob disconnected,
   * a bot took over", join retries). Written by the session, cleared after a few seconds.
   */
  notice?: string | null
  /** round-trip ping per player in ms, measured by the host (host 0, bots absent). ~1 Hz. */
  pings: Record<number, number>
  /** players who asked for a rematch on the results screen; reset when a match starts */
  ready: Record<number, boolean>
}

export interface MatchResult {
  winners: PlayerId[]
  slots: PlayerSlot[]
  scores: PlayerScore[]
  rounds: number
  /** match length in sim ticks (60 Hz) */
  ticks?: number
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
  /** settings modal, reachable from menu and the in-match menu */
  settingsOpen: boolean
  gpu: GpuSupport

  setScreen: (s: Screen) => void
  setResult: (r: MatchResult | null) => void
  setSettings: (s: Partial<Settings>) => void
  setLobby: (l: Partial<LobbyView>) => void
  toggle: (k: 'shopOpen' | 'scoreboardOpen' | 'characterOpen' | 'paused' | 'settingsOpen', v?: boolean) => void
  setGpu: (g: GpuSupport) => void
}

const SETTINGS_KEY = 'brawlock.settings.v1'

const defaultSettings: Settings = {
  quality: 'high',
  fxIntensity: 1,
  screenShake: 1,
  fpsCap: 0,
  resolutionScale: 1,
  cameraReach: 'normal',
  edgePanSpeed: 1,
  masterVolume: 0.8,
  sfxVolume: 1,
  musicVolume: 0.6,
  ambienceVolume: 1,
  announcerVolume: 0.8,
  announcerVoice: 'maverick',
  muted: false,
  playerName: 'Warlock',
  showPerf: false,
  keyPreset: 'brawlock',
  keybinds: {},
  keybindsAlt: {},
  castMode: 'quick',
  castModeSlots: {},
  uiScale: 1,
  hudLayout: 'center',
  soundStyle: 'hybrid',
  netGraph: false,
  showHints: true,
  moveCancelsCast: true,
  settingsVersion: 2,
  colorblindPalette: false,
  netMode: 'predict',
}

const isEmpty = (o: object | undefined) => !o || Object.keys(o).length === 0

/**
 * One-time upgrades of saved settings. v2: the default keys moved from the
 * Dota preset to Brawlock (Fireball Q, Scourge W). Players still on the old
 * default with no key of their own move over once; anyone with custom keys or
 * another preset keeps theirs.
 */
export function migrateSettings(saved: Partial<Settings>): Settings {
  const s = { ...defaultSettings, ...saved, settingsVersion: saved.settingsVersion ?? 1 }
  if (s.settingsVersion < 2) {
    if (s.keyPreset === 'dota' && isEmpty(s.keybinds) && isEmpty(s.keybindsAlt)) s.keyPreset = 'brawlock'
    s.settingsVersion = 2
  }
  return s
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>
      const s = migrateSettings(saved)
      // store the result right away, so a migration runs once
      if (s.settingsVersion !== saved.settingsVersion) localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
      return s
    }
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
    roomCode: null,
    status: 'idle',
    error: null,
    slots: [],
    settings: null,
    localPlayer: 0,
    pings: {},
    ready: {},
  },
  shopOpen: false,
  scoreboardOpen: false,
  characterOpen: false,
  paused: false,
  settingsOpen: false,
  gpu: 'unknown',

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
  setGpu: (gpu) => set({ gpu }),
}))

export const BOT_DIFFICULTIES: BotDifficulty[] = ['dummy', 'easy', 'medium', 'hard', 'brutal', 'uber']
