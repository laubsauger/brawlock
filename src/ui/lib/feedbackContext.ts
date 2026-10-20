import { eventLog, frame } from '../../game/frame'
import { inspectedLoadout } from '../../game/inspect'
import { session } from '../../game/session'
import { cleanBuild } from '../../game/stats'
import { useGame } from '../../game/store'
import type { FeedbackContext, FeedbackError, FeedbackEvent, FeedbackRender, FeedbackRules, FeedbackSettings } from '../../net/feedback'
import { SPELL_IDS } from '../../sim/spells/data'
import type { SimEvent } from '../../sim/types'
import { renderPerf } from '../renderBridge'
import { netState } from './netmonitor'

declare const __RELEASE__: { version: string }
declare const __BUILD_ID__: string
declare const __NET_ID__: string

const SETTINGS = ['quality', 'fxIntensity', 'screenShake', 'fpsCap', 'resolutionScale', 'uiScale', 'hudLayout', 'edgePan', 'muted', 'masterVolume', 'sfxVolume', 'musicVolume', 'ambienceVolume', 'announcerVolume', 'announcerVoice', 'castMode', 'moveCancelsCast', 'netMode'] as const satisfies readonly (keyof FeedbackSettings)[]
const RULES = ['teamMode', 'gameMode', 'winScore', 'rankedRounds', 'startGold', 'roundGold', 'killGold', 'winGold', 'lavaDps', 'kbMultiplier', 'dmgMultiplier', 'friction', 'shopSeconds', 'botsReplaceLeavers', 'spectatorBets', 'bounties'] as const satisfies readonly (keyof FeedbackRules)[]
const EVENT_TYPES = new Set<FeedbackEvent['type']>(['cast', 'castStart', 'projectileSpawn', 'projectileHit', 'projectileExpire', 'damage', 'heal', 'teleport', 'explosion', 'death', 'obstacleDestroyed', 'arenaShrink', 'phase', 'roundWin', 'gameOver', 'beam', 'shieldReflect', 'swap', 'modifier', 'spellHit'])
const SPELLS = new Set<string>([...SPELL_IDS, 'lava', 'obstacle', 'disconnect', 'unknown'])

function pick<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key]
  return out
}

function number(value: unknown, min: number, max: number, integer = false): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value)) ? value : null
}

/** Redact before truncating, so a clipped token cannot bypass the patterns. */
function text(value: string): string {
  return value
    .replace(/(?:https?|wss?):\/\/[^\s<>"')]+/gi, (url) => url.replace(/[?#].*$/, '').replace(/^((?:https?|wss?):\/\/)[^/@]+@/i, '$1[redacted]@'))
    .replace(/(\/[A-Za-z0-9_./%:-]+)[?#][^\s<>"')]+/g, '$1')
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi, 'Cookie: [redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|key|secret|password|authorization|cookie|session[_-]?id|account[_-]?id|profile[_-]?id|device[_-]?id)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1=[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\bsk[_-][A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

function errors(): FeedbackError[] {
  const capture = (window as unknown as { __errorCapture?: { summary(): unknown } }).__errorCapture
  if (!capture || typeof capture.summary !== 'function') return []
  const rows = capture.summary()
  if (!Array.isArray(rows)) return []
  return rows.slice(-8).flatMap((row): FeedbackError[] => {
    if (!row || typeof row.error !== 'string' || number(row.atMs, 0, 9_000_000_000_000) === null) return []
    const colon = row.error.indexOf(':')
    const name = text(colon < 0 ? 'Error' : row.error.slice(0, colon)).replace(/\s+/g, ' ').trim().slice(0, 128)
    const message = text(colon < 0 ? row.error : row.error.slice(colon + 1)).trim().slice(0, 1000)
    if (!name || !message) return []
    const stack = typeof row.stack === 'string' ? text(row.stack).split('\n').slice(0, 8).map((line) => line.slice(0, 300)).join('\n').slice(0, 2400) : undefined
    return [{ at: Math.round(performance.timeOrigin + row.atMs), name, message, ...(stack === undefined ? {} : { stack }) }]
  })
}

function eventSummary(tick: number, event: SimEvent): FeedbackEvent | null {
  if (!EVENT_TYPES.has(event.type as FeedbackEvent['type'])) return null
  const out: FeedbackEvent = { tick, type: event.type as FeedbackEvent['type'] }
  const e = event as unknown as Record<string, unknown>
  const actor = event.type === 'death' ? e.killer : event.type === 'damage' || event.type === 'modifier' ? e.source
    : event.type === 'obstacleDestroyed' ? e.by : 'pawn' in e ? e.pawn : 'owner' in e ? e.owner : e.id
  const target = event.type === 'death' || event.type === 'modifier' ? e.pawn : event.type === 'swap' ? e.other : event.type === 'obstacleDestroyed' ? e.id : e.target
  const spell = typeof e.spell === 'string' ? e.spell : e.cause
  const value = event.type === 'arenaShrink' ? e.layer : event.type === 'phase' ? e.round : event.type === 'roundWin' ? e.team
    : event.type === 'explosion' ? e.radius : event.type === 'castStart' ? e.ticks : event.type === 'modifier' ? Number(e.on) : e.amount ?? e.level
  if (number(actor, 0, 1_000_000_000, true) !== null) out.actor = actor as number
  if (number(target, 0, 1_000_000_000, true) !== null) out.target = target as number
  if (typeof spell === 'string' && SPELLS.has(spell)) out.spell = spell
  if (number(value, -1e12, 1e12) !== null) out.value = value as number
  return out
}

function rendering(): FeedbackRender | null {
  const perf = renderPerf()
  if (!perf) return null
  const out: FeedbackRender = { backend: perf.backend === 'webgpu' || perf.backend === 'webgl2' ? perf.backend : 'unknown' }
  if (number(perf.fps, 0, 1000) !== null) out.fps = perf.fps
  if (number(perf.drawCalls, 0, 1_000_000, true) !== null) out.drawCalls = perf.drawCalls
  if (number(perf.triangles, 0, 1_000_000_000, true) !== null) out.triangles = perf.triangles
  // frameMs is published by the renderer, beyond the bridge's narrower HUD type.
  if ('frameMs' in perf && number(perf.frameMs, 0, 60_000) !== null) out.frameMs = perf.frameMs as number
  return out
}

/** Capture at the click, before awaiting screenshot encoding or opening a modal. */
export function captureFeedbackContext(panel: string | null = null): FeedbackContext {
  const state = useGame.getState()
  const lobby = state.lobby
  const activeRoom = lobby.role !== 'offline' && (lobby.status === 'open' || lobby.status === 'connecting')
  const peers = activeRoom ? netState().snap.peers : []
  const rtts = peers.flatMap((peer) => number(peer.rttMs, 0, 60_000) === null ? [] : [peer.rttMs!])
  const losses = peers.flatMap((peer) => number(peer.lossPct, 0, 100) === null ? [] : [peer.lossPct!])
  const region = activeRoom ? session.region()?.id : null
  const game = ['match', 'replay', 'results'].includes(state.screen) ? frame.curr : null
  const kit = game && frame.localPlayer >= 0 ? inspectedLoadout(game, frame.localPlayer, frame.localPlayer, state.screen === 'replay' ? 'replay' : 'live')?.kit : null
  const recentEvents: FeedbackEvent[] = []
  if (game) for (let i = eventLog.length - 1; i >= 0 && recentEvents.length < 50; i--) {
    const entry = eventLog[i]
    if (entry.tick > game.tick) continue
    for (let j = entry.events.length - 1; j >= 0 && recentEvents.length < 50; j--) {
      const event = eventSummary(entry.tick, entry.events[j])
      if (event) recentEvents.push(event)
    }
  }
  const label = panel === null ? null : text(panel).replace(/\s+/g, ' ').trim().slice(0, 64)
  const device = navigator as Navigator & { deviceMemory?: number }
  return {
    version: 1, capturedAt: Date.now(), release: __RELEASE__.version, build: __BUILD_ID__, netcode: __NET_ID__, screen: state.screen, panel: label || null,
    device: {
      userAgent: text(device.userAgent).replace(/\s+/g, ' ').slice(0, 512), language: text(device.language).replace(/\s+/g, ' ').slice(0, 32),
      width: Math.min(32_768, Math.max(1, Math.round(window.innerWidth))), height: Math.min(32_768, Math.max(1, Math.round(window.innerHeight))),
      dpr: Math.min(8, Math.max(0.1, window.devicePixelRatio)), touch: device.maxTouchPoints > 0,
      cores: number(device.hardwareConcurrency, 1, 256, true), memory: number(device.deviceMemory, 0, 1024), online: device.onLine,
    },
    settings: pick(state.settings, SETTINGS),
    connection: {
      role: lobby.role, transport: activeRoom ? session.transport() : null,
      region: typeof region === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(region) ? region : null,
      room: activeRoom && lobby.roomCode && /^[A-Z]{5}$/.test(lobby.roomCode) ? lobby.roomCode : null,
      ranked: activeRoom && !!lobby.ranked, quick: activeRoom && !!lobby.quick,
      rttMs: rtts.length ? Math.max(...rtts) : null, lossPct: losses.length ? Math.max(...losses) : null, peers: peers.length,
    },
    render: rendering(),
    game: game ? {
      tick: game.tick, round: game.round, phase: game.phase, phaseTicksLeft: game.phaseTicksLeft,
      players: game.slots.length, humans: game.slots.filter((slot) => slot.kind === 'human').length, bots: game.slots.filter((slot) => slot.kind === 'bot').length,
      alive: game.pawns.filter((pawn) => pawn.alive).length, projectiles: game.projectiles.length, obstacles: game.obstacles.length,
      ownBuild: cleanBuild(kit) ?? null, rules: pick(game.settings, RULES),
    } : null,
    recentEvents: recentEvents.reverse(), errors: errors(),
  }
}
