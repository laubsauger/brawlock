import { useEffect, useRef, useState } from 'react'
import { input, inputViz } from '../game/input'
import { useGame } from '../game/store'
import { matchRenderReady, MatchViewSlot, recenterCamera } from './renderBridge'
import { useTick } from './lib/ticker'
import { localView } from './lib/view'
import { hueFor } from './data/catalog'
import { moveCursor, reticleCursor } from './lib/cursors'

/**
 * The match scene, mounted at App level from the lobby on and kept through
 * the match and results. In the lobby (and on results) it is hidden and warms
 * up (render's `prewarm`: compiles materials and pipelines, uploads textures);
 * Start then shows the SAME instance, so the match opens without the compile
 * freeze. A remount would lose the warm-up, which is why it does not live
 * inside the Match screen. Input and the arena cursor attach here during a match.
 */
export function MatchLayer() {
  const screen = useGame((s) => s.screen)
  if (screen !== 'lobby' && screen !== 'match' && screen !== 'results' && screen !== 'replay') return null
  // a replay shows the scene (no input: the viewer drives it)
  return <Layer live={screen === 'match'} shown={screen === 'match' || screen === 'replay'} />
}

function Layer({ live, shown }: { live: boolean; shown: boolean }) {
  const viewport = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = viewport.current
    if (!live || !el) return
    return input.attach(el, { recenter: recenterCamera })
  }, [live])

  // arena cursor: move claw, or a reticle in the spell's color while aiming
  // (red with a slash when it can't fire: cooldown, empty slot, dead).
  // Warlock spells are directional and Teleport clamps to its range, so range never invalidates.
  const cursorKey = useRef('')
  useTick(() => {
    const el = viewport.current
    if (!el) return
    if (!live) {
      if (cursorKey.current) el.style.cursor = cursorKey.current = ''
      return
    }
    const a = inputViz.aim
    let key = 'move'
    let value = ''
    if (a) {
      const pawn = localView()?.pawn
      const invalid = !a.spell || !pawn?.alive || (pawn.cooldowns[a.slot] ?? 0) > 0
      const hue = hueFor(a.spell)
      key = invalid ? 'invalid' : hue
      if (key !== cursorKey.current) value = reticleCursor(hue, invalid)
    } else if (key !== cursorKey.current) value = moveCursor()
    if (key === cursorKey.current) return
    cursorKey.current = key
    el.style.cursor = value
  })

  return (
    <div
      ref={viewport}
      className="absolute inset-0"
      style={live ? undefined : { pointerEvents: 'none' }}
      aria-hidden={!live || undefined}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MatchViewSlot prewarm={!shown} />
    </div>
  )
}

/**
 * Whether the match scene is warm: true once render reports ready, or after
 * `timeoutMs` so a slow or failing warm-up never blocks starting a match.
 */
export function useMatchRenderReady(timeoutMs = 6000): { ready: boolean; timedOut: boolean } {
  const [state, setState] = useState(() => ({ ready: matchRenderReady(), timedOut: false }))
  useEffect(() => {
    if (state.ready) return
    const t0 = performance.now()
    const id = window.setInterval(() => {
      if (matchRenderReady()) setState({ ready: true, timedOut: false })
      else if (performance.now() - t0 >= timeoutMs) setState({ ready: true, timedOut: true })
    }, 150)
    return () => window.clearInterval(id)
  }, [state.ready, timeoutMs])
  return state
}
