import { useMemo, useState, type CSSProperties } from 'react'
import { MenuBackdropSlot } from './renderBridge'

/**
 * Wordmark art (public/brand/wordmark.webp; the PNG master stays alongside).
 * Falls back to the typographic wordmark if the image fails to load.
 */
export function Wordmark({ size = 'lg' }: { size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    const fs = { sm: 'text-4xl', md: 'text-6xl', lg: 'text-[clamp(4.5rem,10vw,8.5rem)]', xl: 'text-[clamp(5rem,14vw,11rem)]' }[size]
    return (
      <h1 className={`wordmark select-none ${fs}`} aria-label="Brawlock">
        Brawlock
      </h1>
    )
  }
  // lg follows the screen height too, so the main menu fits on short screens (1280x720 with the server options)
  const width = { sm: '220px', md: '340px', lg: 'min(520px, 84vw, 58vh)', xl: 'min(640px, 86vw)' }[size]
  const src = `${import.meta.env.BASE_URL}brand/wordmark.webp`
  return (
    <h1 className={`brand-mark m-0 max-w-[calc(100vw-48px)] leading-none ${size === 'lg' ? 'brand-mark-live' : ''}`} style={{ width, '--brand-image': `url("${src}")` } as CSSProperties}>
      <img
        src={src}
        width={1200}
        height={364}
        alt="Brawlock"
        draggable={false}
        onError={() => setFailed(true)}
        className="block h-auto w-full select-none"
      />
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
