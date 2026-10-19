/** Cached process measurements; CPU 100% means one full core, RSS uses MiB. */
export interface ServerPerfSnapshot {
  sampleAt: number
  windowMs: number
  processCpuPct: number
  eventLoopP95Ms: number
  eventLoopMaxMs: number
  simStepAvgMs: number
  simStepMaxMs: number
  simStepsPerSec: number
  rssMb: number
}

const FIELDS = ['sampleAt', 'windowMs', 'processCpuPct', 'eventLoopP95Ms', 'eventLoopMaxMs', 'simStepAvgMs', 'simStepMaxMs', 'simStepsPerSec', 'rssMb'] as const

/** null means the server has not completed its first measurement window. */
export function decodeServerPerf(value: unknown): ServerPerfSnapshot | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('Server performance measurements are unavailable')
  const row = value as Record<string, unknown>
  for (const field of FIELDS) {
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0) throw new Error(`Invalid server performance field: ${field}`)
  }
  if ((row.sampleAt as number) <= 0 || (row.windowMs as number) <= 0) throw new Error('Invalid server performance sample window')
  return Object.fromEntries(FIELDS.map((field) => [field, row[field]])) as unknown as ServerPerfSnapshot
}
