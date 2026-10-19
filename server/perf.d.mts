import type { ServerPerfSnapshot } from '../src/net/serverPerf'

export interface ServerPerfSampler {
  snapshot(): Readonly<ServerPerfSnapshot> | null
  /** Instrument a synchronous simulation step without changing its behavior. */
  wrapStep<T extends (...args: any[]) => any>(step: T): T
  close(): void
}

/** Injectable clocks/native counters let tests exercise exact windows without busy-loop load. */
export interface ServerPerfDependencies {
  now?: () => number
  wallNow?: () => number
  cpuUsage?: () => { user: number; system: number }
  rss?: () => number
  eventLoop?: { count: number; max: number; percentile(p: number): number; enable(): void; reset(): void; disable(): void }
  schedule?: (sample: () => void, ms: number) => { unref(): void }
  cancel?: (timer: { unref(): void }) => void
}

export function createServerPerf(deps?: ServerPerfDependencies): ServerPerfSampler
