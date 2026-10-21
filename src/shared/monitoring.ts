import type { ServerPerfSnapshot } from '../net/serverPerf'
import type { summarizeLinks } from '../net/monitoring'
export interface FleetSample {
  version: 1
  at?: number
  uptimeSec: number
  release: { version: string; releaseDate: string; commit: string | null; net?: string }
  host: { cpus: number; totalMb: number; availableMb: number | null; cpuPct: number | null; stealPct: number | null; load1: number } | null
  hostCpuPeakPct: number | null
  processCpuPeakPct: number | null
  loopPeakMs: number | null
  stepPeakMs: number | null
  perf: ServerPerfSnapshot | null
  players?: number
  connections?: number
  rooms?: { mode: string; phase: string; round: number | null; humans: number; bots: number }[]
  links?: ReturnType<typeof summarizeLinks>
  maintenance?: { draining: boolean; ready: boolean }
  online?: { total: number; regions: Record<string, number> }
}
export type Metric = 'hostCpu' | 'processCpu' | 'memory' | 'loop' | 'step' | 'players' | 'bots' | 'rooms' | 'ping' | 'loss' | 'online'
export type HistoryPoint = { at: number; region: string; samples: number; failures: number } & Record<Metric, number | null>
export interface FleetView {
  at: number; from: number; through: number; grain: number; intervalMs: number
  regions: { id: string; label: string }[]
  latest: Record<string, { at: number; ok: boolean; error?: string; sample?: FleetSample }>
  history: HistoryPoint[]
  website: { ok: boolean; at: number; build?: string; version?: string; releaseDate?: string } | null
}
