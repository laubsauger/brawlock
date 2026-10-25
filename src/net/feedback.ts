import type { InspectedKit } from '../game/inspect'
import { cleanBuild } from '../game/stats'
import { SPELL_IDS } from '../sim/spells/data'

export const FEEDBACK_BODY_BYTES = 512 * 1024
export const FEEDBACK_IMAGE_BYTES = 256 * 1024
export const FEEDBACK_IMAGE_DIMENSION = 1600
export const FEEDBACK_MESSAGE_MAX = 5000

export interface FeedbackDevice {
  userAgent: string
  language: string
  width: number
  height: number
  dpr: number
  touch: boolean
  cores: number | null
  memory: number | null
  online: boolean
}
export interface FeedbackSettings {
  quality?: 'low' | 'medium' | 'high' | 'ultra'
  fxIntensity?: number
  screenShake?: number
  fpsCap?: number
  resolutionScale?: number
  uiScale?: number
  hudLayout?: 'center' | 'right'
  edgePan?: boolean
  muted?: boolean
  masterVolume?: number
  sfxVolume?: number
  musicVolume?: number
  ambienceVolume?: number
  announcerVolume?: number
  announcerVoice?: 'maverick' | 'arena'
  castMode?: 'quick' | 'release' | 'normal'
  moveCancelsCast?: boolean
  netMode?: 'predict' | 'snapshot' | 'classic'
}
export interface FeedbackConnection {
  role: 'offline' | 'host' | 'client'
  transport: 'server' | 'p2p' | null
  region: string | null
  room: string | null
  ranked: boolean
  quick: boolean
  rttMs: number | null
  lossPct: number | null
  peers: number
}
export interface FeedbackRender {
  backend: 'webgpu' | 'webgl2' | 'unknown'
  fps?: number
  frameMs?: number
  drawCalls?: number
  triangles?: number
  geometries?: number
  textures?: number
  width?: number
  height?: number
}
export interface FeedbackRules {
  teamMode?: 'ffa' | 'teams' | 'shuffle'
  gameMode?: 'rounds' | 'deathmatch' | 'hill'
  winScore?: number
  rankedRounds?: number
  startGold?: number
  roundGold?: number
  killGold?: number
  winGold?: number
  lavaDps?: number
  kbMultiplier?: number
  dmgMultiplier?: number
  friction?: number
  shopSeconds?: number
  botsReplaceLeavers?: boolean
  spectatorBets?: boolean
  bounties?: boolean
}
export interface FeedbackGame {
  tick: number
  round: number
  phase: 'warmup' | 'shop' | 'fight' | 'roundEnd' | 'gameOver'
  phaseTicksLeft?: number
  players?: number
  humans?: number
  bots?: number
  alive?: number
  projectiles?: number
  obstacles?: number
  ownBuild?: InspectedKit | null
  rules?: FeedbackRules
}
export interface FeedbackEvent {
  tick: number
  type: 'cast' | 'castStart' | 'projectileSpawn' | 'projectileHit' | 'projectileExpire' | 'damage' | 'heal' | 'teleport'
    | 'explosion' | 'death' | 'obstacleDestroyed' | 'arenaShrink' | 'phase' | 'roundWin' | 'gameOver' | 'beam' | 'shieldReflect' | 'swap' | 'modifier' | 'spellHit'
  actor?: number
  target?: number
  spell?: string
  value?: number
}
export interface FeedbackError { at: number; name: string; message: string; stack?: string }
export interface FeedbackContext {
  version: 1
  capturedAt: number
  release: string
  build: string
  netcode: string
  screen: 'boot' | 'unsupported' | 'menu' | 'lobby' | 'match' | 'results' | 'credits' | 'replay'
  panel: string | null
  device: FeedbackDevice
  settings: FeedbackSettings
  connection: FeedbackConnection
  render: FeedbackRender | null
  game: FeedbackGame | null
  recentEvents: FeedbackEvent[]
  errors: FeedbackError[]
}
export interface FeedbackScreenshot { mime: 'image/jpeg' | 'image/png'; data: string; width: number; height: number }
export interface FeedbackSubmission {
  id: string
  kind: 'bug' | 'feedback'
  message: string
  contactEmail?: string
  context: FeedbackContext
  screenshot?: FeedbackScreenshot
}

export const FEEDBACK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
type Check = (value: unknown) => boolean
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const number = (min: number, max: number): Check => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const integer = (min: number, max: number): Check => (v) => number(min, max)(v) && Number.isSafeInteger(v)
const string = (min: number, max: number, multiline = false): Check => (v) => typeof v === 'string' && v.trim().length >= min && v.length <= max
  && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(v)
const boolean: Check = (v) => typeof v === 'boolean'
const oneOf = (...values: unknown[]): Check => (v) => values.includes(v)
const nullable = (check: Check): Check => (v) => v === null || check(v)
const shape = (checks: Record<string, Check>, required = Object.keys(checks)): Check => (v) => object(v)
  && required.every((key) => Object.hasOwn(v, key)) && Object.entries(v).every(([key, value]) => Object.hasOwn(checks, key) && checks[key](value))
const timestamp = integer(0, 9_000_000_000_000)
const dimension = integer(1, 32_768)
const ratio = number(0, 1)
const screen = oneOf('boot', 'unsupported', 'menu', 'lobby', 'match', 'results', 'credits', 'replay')
const settings = shape({
  quality: oneOf('low', 'medium', 'high', 'ultra'), fxIntensity: ratio, screenShake: ratio,
  fpsCap: oneOf(0, 30, 60, 120, 144), resolutionScale: number(0.25, 2), uiScale: number(0.5, 2),
  hudLayout: oneOf('center', 'right'), edgePan: boolean, muted: boolean,
  masterVolume: ratio, sfxVolume: ratio, musicVolume: ratio, ambienceVolume: ratio, announcerVolume: ratio,
  announcerVoice: oneOf('maverick', 'arena'), castMode: oneOf('quick', 'release', 'normal'),
  moveCancelsCast: boolean, netMode: oneOf('predict', 'snapshot', 'classic'),
}, [])
const device = shape({ userAgent: string(0, 512), language: string(0, 32), width: dimension, height: dimension,
  dpr: number(0.1, 8), touch: boolean, cores: nullable(integer(1, 256)), memory: nullable(number(0, 1024)), online: boolean })
const connection = shape({
  role: oneOf('offline', 'host', 'client'), transport: oneOf('server', 'p2p', null),
  region: nullable((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v)),
  room: nullable((v) => typeof v === 'string' && /^[A-Z]{5}$/.test(v)), ranked: boolean, quick: boolean,
  rttMs: nullable(number(0, 60_000)), lossPct: nullable(number(0, 100)), peers: integer(0, 10),
})
const render = shape({ backend: oneOf('webgpu', 'webgl2', 'unknown'), fps: number(0, 1000), frameMs: number(0, 60_000),
  drawCalls: integer(0, 1_000_000), triangles: integer(0, 1_000_000_000), geometries: integer(0, 1_000_000),
  textures: integer(0, 1_000_000), width: dimension, height: dimension }, ['backend'])
const rules = shape({
  teamMode: oneOf('ffa', 'teams', 'shuffle'), gameMode: oneOf('rounds', 'deathmatch', 'hill'), winScore: integer(1, 1000),
  rankedRounds: integer(0, 1000), startGold: number(0, 1_000_000), roundGold: number(0, 1_000_000),
  killGold: number(0, 1_000_000), winGold: number(0, 1_000_000), lavaDps: number(0, 1_000_000),
  kbMultiplier: number(0, 100), dmgMultiplier: number(0, 100), friction: ratio, shopSeconds: number(0, 3600),
  botsReplaceLeavers: boolean, spectatorBets: boolean, bounties: boolean,
}, [])
const build: Check = (v) => object(v) && Object.keys(v).every((k) => ['slots', 'levels', 'masteries'].includes(k))
  && object(v.masteries) && Object.keys(v.masteries).every((k) => ['duration', 'range', 'lifesteal'].includes(k)) && !!cleanBuild(v)
const game = shape({ tick: integer(0, 1_000_000_000), round: integer(0, 10000),
  phase: oneOf('warmup', 'shop', 'fight', 'roundEnd', 'gameOver'), phaseTicksLeft: integer(-1, 1_000_000_000),
  players: integer(0, 10), humans: integer(0, 10), bots: integer(0, 10), alive: integer(0, 10),
  projectiles: integer(0, 1_000_000), obstacles: integer(0, 1_000_000), ownBuild: nullable(build), rules,
}, ['tick', 'round', 'phase'])
const spells = new Set<string>([...SPELL_IDS, 'lava', 'obstacle', 'disconnect', 'unknown'])
const event = shape({ tick: integer(0, 1_000_000_000),
  type: oneOf('cast', 'castStart', 'projectileSpawn', 'projectileHit', 'projectileExpire', 'damage', 'heal', 'teleport',
    'explosion', 'death', 'obstacleDestroyed', 'arenaShrink', 'phase', 'roundWin', 'gameOver', 'beam', 'shieldReflect', 'swap', 'modifier', 'spellHit'),
  actor: integer(0, 1_000_000_000), target: integer(0, 1_000_000_000), spell: (v) => typeof v === 'string' && spells.has(v), value: number(-1e12, 1e12),
}, ['tick', 'type'])
const error = shape({ at: timestamp, name: string(1, 128), message: string(1, 1000, true),
  stack: (v) => string(0, 2400, true)(v) && (v as string).split('\n').length <= 8 && (v as string).split('\n').every((line) => line.length <= 300),
}, ['at', 'name', 'message'])
const context = shape({ version: oneOf(1), capturedAt: timestamp,
  release: (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,128}$/.test(v),
  build: (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,128}$/.test(v),
  netcode: (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,128}$/.test(v),
  screen, panel: nullable(string(1, 64)), device, settings, connection, render: nullable(render), game: nullable(game),
  recentEvents: (v) => Array.isArray(v) && v.length <= 50 && v.every(event),
  errors: (v) => Array.isArray(v) && v.length <= 8 && v.every(error),
})
const screenshot = shape({ mime: oneOf('image/jpeg', 'image/png'), width: integer(1, FEEDBACK_IMAGE_DIMENSION), height: integer(1, FEEDBACK_IMAGE_DIMENSION),
  data: (v) => typeof v === 'string' && v.length > 0 && v.length <= 4 * Math.ceil(FEEDBACK_IMAGE_BYTES / 3)
    && v.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v),
})

/** Complete allowlists keep auth, player identities and arbitrary state dumps out of diagnostics. */
export function validFeedbackSubmission(value: unknown): value is FeedbackSubmission {
  return shape({ id: (v) => typeof v === 'string' && FEEDBACK_UUID.test(v), kind: oneOf('bug', 'feedback'),
    message: string(3, FEEDBACK_MESSAGE_MAX, true), contactEmail: (v) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    context, screenshot,
  }, ['id', 'kind', 'message', 'context'])(value)
}
