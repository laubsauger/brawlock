import { useMemo } from 'react'
import { MenuBackdropSlot } from './renderBridge'

/**
 * Typographic wordmark. LOGO SLOT: when generated logo art lands, render it
 * here (keep the text as the accessible name) and every screen follows.
 */
export function Wordmark({ size = 'lg' }: { size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const fs = { sm: 'text-4xl', md: 'text-6xl', lg: 'text-[clamp(4.5rem,10vw,8.5rem)]', xl: 'text-[clamp(5rem,14vw,11rem)]' }[size]
  return (
    <h1 className={`wordmark select-none ${fs}`} aria-label="Brawlock">
      Brawlock
    </h1>
  )
}

/**
 * Persistent backdrop behind every non-match screen: CSS ember layer (always
 * there, instant) under the WebGPU lava scene from render, plus a veil that
 * keeps the menu column readable.
 */
export function Backdrop() {
  const embers = useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => {
        // deterministic spread, no Math.random flicker between renders
        const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1
        return {
          left: `${(r(1) * 100).toFixed(1)}%`,
          delay: `${(r(2) * 12).toFixed(2)}s`,
          dur: `${(7 + r(3) * 9).toFixed(2)}s`,
          drift: `${((r(4) - 0.5) * 140).toFixed(0)}px`,
          scale: 0.6 + r(5) * 1.2,
        }
      }),
    [],
  )
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div className="ember-backdrop absolute inset-0">
        {embers.map((e, i) => (
          <span
            key={i}
            className="ember"
            style={{
              left: e.left,
              animationDelay: e.delay,
              animationDuration: e.dur,
              transform: `scale(${e.scale})`,
              ['--drift' as string]: e.drift,
            }}
          />
        ))}
      </div>
      <div className="absolute inset-0">
        <MenuBackdropSlot />
      </div>
      <div className="backdrop-veil absolute inset-0" />
    </div>
  )
}
