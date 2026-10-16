/**
 * Global last-resort error capture (installed once from the app entry):
 * uncaught errors and unhandled promise rejections are logged with their full
 * stack the FIRST time each distinct message appears; repeats only bump a
 * counter, so a per-frame bug can never spam the console (QA saw 2143 copies
 * of one error). Summary for tooling: window.__errorCapture.
 */
interface Seen {
  count: number
  first: number
  stack: string
}

const seen = new Map<string, Seen>()

function record(kind: string, message: string, stack: string | undefined): void {
  const key = `${kind}: ${message}`
  const s = seen.get(key)
  if (s) {
    s.count++
    return
  }
  seen.set(key, { count: 1, first: performance.now(), stack: stack ?? '(no stack)' })
  console.error(`[${kind}] ${message}\n${stack ?? '(no stack)'}`)
}

export function installErrorCapture(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { __errorCapture?: unknown }
  if (w.__errorCapture) return
  window.addEventListener('error', (e) => {
    const err = e.error as Error | undefined
    record('uncaught', err?.message ?? e.message ?? String(e), err?.stack ?? `${e.filename}:${e.lineno}:${e.colno}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | undefined
    record('unhandledrejection', r?.message ?? String(e.reason), r?.stack)
  })
  w.__errorCapture = {
    /** distinct errors with counts and first stacks */
    summary: () => [...seen.entries()].map(([k, v]) => ({ error: k, count: v.count, atMs: Math.round(v.first), stack: v.stack })),
  }
}
