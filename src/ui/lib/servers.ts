/**
 * Game-server regions for the host card, the region setting and the lobby
 * chip, on top of the netcode's region API (game/session `online`): the
 * configured regions, their health (up / down / other version) and ping,
 * re-probed while a screen asks for it. Builds without a server have no
 * regions, and every caller hides.
 */
import { useEffect, useState } from 'react'
import { online, type RegionStatus } from '../../game/session'
import { useGame } from '../../game/store'
import { gradeOf, type NetGrade } from './netstats'

export type { RegionState, RegionStatus } from '../../game/session'

/** Last known status per region, in config order. */
export function regionStatus(): RegionStatus[] {
  return online.configured ? online.status() : []
}

/**
 * The region a "game server" host goes to, for display (the session decides
 * with the same rule, online.choose): the chosen one, or Auto = the lowest
 * ping among the regions that are up.
 */
export function pickRegion(statuses: RegionStatus[], choice: string): RegionStatus | null {
  if (choice !== 'auto') return statuses.find((s) => s.id === choice) ?? null
  const up = statuses.filter((s) => s.state === 'up' && !s.maintenance?.draining)
  if (up.length) return up.reduce((a, b) => ((a.rttMs ?? Infinity) <= (b.rttMs ?? Infinity) ? a : b))
  return statuses[0] ?? null
}

/** Ping grade with the netcode's thresholds (GRADE_LIMITS via gradeOf). */
export function pingGrade(rttMs: number | null): NetGrade | null {
  if (rttMs == null) return null
  return gradeOf({ playerId: 0, rttMs, jitterMs: null, lossPct: null, snapshotAgeMs: null, channel: null, inputAckLagMs: null, correctionPx: null, desyncs: null })
}

/** Why a region cannot host right now, or null when it can. */
export function regionProblem(s: Pick<RegionStatus, 'state' | 'label' | 'maintenance'> | null): string | null {
  if (!s) return 'No game server is set up for this build.'
  if (s.state === 'down') return `The game server in ${s.label} is not reachable right now.`
  if (s.state === 'mismatch') return `The game server in ${s.label} runs a different game version.`
  if (s.state === 'checking') return `Checking the game server in ${s.label}…`
  if (s.maintenance?.draining) return s.maintenance.message ?? `${s.label} is preparing an update. Choose another region for a new game.`
  return null
}

/** Human connections in games/lobbies; never retain a stale count for an offline region. */
export function regionPlayerCount(s: RegionStatus): number | null {
  return (s.state === 'up' || s.state === 'mismatch') && s.players !== null && Number.isSafeInteger(s.players) && s.players >= 0 ? s.players : null
}

export function regionPlayerLabel(s: RegionStatus): string {
  const count = regionPlayerCount(s)
  return count === null ? '— players' : `${count} ${count === 1 ? 'player' : 'players'}`
}

export function regionPopulation(statuses: readonly RegionStatus[]): { total: number | null; partial: boolean; label: string } {
  const known = statuses.map(regionPlayerCount).filter((count): count is number => count !== null)
  const total = known.length ? known.reduce((sum, count) => sum + count, 0) : null
  const partial = known.length < statuses.length
  return { total, partial, label: total === null ? '— online' : `${total}${partial ? '+' : ''} online` }
}

/**
 * React: live region status, re-probed every `everyMs` while mounted (the
 * menu: every few seconds; nothing at all in builds without a server).
 */
export function useRegions(everyMs = 5000): RegionStatus[] {
  const [s, setS] = useState<RegionStatus[]>(regionStatus)
  useEffect(() => {
    if (!online.configured) return
    const off = online.subscribe(() => setS(online.status()))
    void online.probe()
    const id = window.setInterval(() => void online.probe(), everyMs)
    return () => {
      off()
      window.clearInterval(id)
    }
  }, [everyMs])
  return s
}

/** The region setting ('auto' or a region id). */
export function useRegionChoice(): string {
  return useGame((s) => s.settings.serverRegion ?? 'auto')
}
