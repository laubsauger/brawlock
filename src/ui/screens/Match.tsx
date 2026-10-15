import { useEffect, useRef } from 'react'
import { input, inputViz } from '../../game/input'
import { useGame } from '../../game/store'
import { MatchViewSlot, recenterCamera } from '../renderBridge'
import { Hud } from '../hud/Hud'
import { Shop } from '../hud/Shop'
import { CharacterSheet, EscMenu, Scoreboard } from '../hud/Overlays'
import { useTick } from '../lib/ticker'
import { localView } from '../lib/view'
import { hueFor } from '../data/catalog'
import { moveCursor, reticleCursor } from '../lib/cursors'

/**
 * Match screen: the render scene fills the viewport (input attaches there),
 * the HUD and panels float above it. The shop and the character sheet are
 * docked panels, never full-screen: your warlock stays visible in the middle.
 */
export function Match() {
  const viewport = useRef<HTMLDivElement>(null)
  const shopOpen = useGame((s) => s.shopOpen)
  const characterOpen = useGame((s) => s.characterOpen)
  const scoreboardOpen = useGame((s) => s.scoreboardOpen)
  const paused = useGame((s) => s.paused)

  useEffect(() => {
    const el = viewport.current
    if (!el) return
    return input.attach(el, { recenter: recenterCamera })
  }, [])

  // arena cursor: move claw, or a reticle in the spell's color while aiming
  // (red with a slash when it can't fire: cooldown, empty slot, dead).
  // Warlock spells are directional and Teleport clamps to its range, so range never invalidates.
  const cursorKey = useRef('')
  useTick(() => {
    const el = viewport.current
    if (!el) return
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

  // leaving the match screen never leaves overlays behind for the next one
  useEffect(
    () => () => {
      const s = useGame.getState()
      s.toggle('shopOpen', false)
      s.toggle('characterOpen', false)
      s.toggle('scoreboardOpen', false)
      s.toggle('paused', false)
    },
    [],
  )

  return (
    <div className="fade-in relative h-full overflow-hidden" onContextMenu={(e) => e.preventDefault()}>
      <div ref={viewport} className="absolute inset-0">
        <MatchViewSlot />
      </div>
      <Hud />
      {shopOpen && <Shop />}
      {characterOpen && !shopOpen && <CharacterSheet />}
      {scoreboardOpen && <Scoreboard />}
      {paused && <EscMenu />}
    </div>
  )
}
