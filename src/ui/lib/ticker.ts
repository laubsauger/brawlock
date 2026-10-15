import { useEffect, useRef, useState } from 'react'

/**
 * One shared requestAnimationFrame loop for every HUD widget. Widgets
 * subscribe and write DOM through refs; React never re-renders per frame.
 */
type TickFn = (now: number) => void

const subs = new Set<TickFn>()
let raf = 0

function loop(now: number) {
  raf = requestAnimationFrame(loop)
  for (const fn of subs) {
    try {
      fn(now)
    } catch (e) {
      // one broken widget must not take the whole HUD down
      console.error('[hud] tick failed', e)
    }
  }
}

export function onTick(fn: TickFn): () => void {
  subs.add(fn)
  if (!raf) raf = requestAnimationFrame(loop)
  return () => {
    subs.delete(fn)
    if (subs.size === 0 && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
}

/** Run `fn` every animation frame while mounted. Always calls the latest `fn`. */
export function useTick(fn: TickFn): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => onTick((now) => ref.current(now)), [])
}

/**
 * Poll a derived value at `hz` and re-render only when its key changes.
 * For low-frequency structure (owned spells, player list, shop state), never
 * for per-frame numbers.
 */
export function usePolled<T>(read: () => T, key: (v: T) => string, hz = 8): T {
  const [value, setValue] = useState<T>(read)
  const readRef = useRef(read)
  const keyRef = useRef(key)
  readRef.current = read
  keyRef.current = key
  const lastKey = useRef(key(value))
  useEffect(() => {
    let last = 0
    const interval = 1000 / hz
    return onTick((now) => {
      if (now - last < interval) return
      last = now
      const v = readRef.current()
      const k = keyRef.current(v)
      if (k !== lastKey.current) {
        lastKey.current = k
        setValue(() => v)
      }
    })
  }, [hz])
  return value
}
