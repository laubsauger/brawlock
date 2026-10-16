import { useEffect } from 'react'
import { useGame } from '../../game/store'
import { Hud, WaitingVeil } from '../hud/Hud'
import { Shop } from '../hud/Shop'
import { CharacterSheet, EscMenu, Scoreboard } from '../hud/Overlays'
import { AbilityCardHost, hideAbilityCard } from '../hud/AbilityCard'

/**
 * Match screen: the HUD and panels float above the match scene. The scene
 * itself (and input, and the arena cursor) lives in the App-level MatchLayer
 * so its warm-up from the lobby survives the switch; this layer passes
 * pointer events through to it except on interactive HUD parts. The shop and
 * the character sheet are docked panels, never full-screen: your warlock
 * stays visible in the middle.
 */
export function Match() {
  const shopOpen = useGame((s) => s.shopOpen)
  const characterOpen = useGame((s) => s.characterOpen)
  const scoreboardOpen = useGame((s) => s.scoreboardOpen)
  const paused = useGame((s) => s.paused)

  // leaving the match screen never leaves overlays behind for the next one
  useEffect(
    () => () => {
      const s = useGame.getState()
      s.toggle('shopOpen', false)
      s.toggle('characterOpen', false)
      s.toggle('scoreboardOpen', false)
      s.toggle('paused', false)
      hideAbilityCard()
    },
    [],
  )

  return (
    <div className="fade-in pointer-events-none relative h-full overflow-hidden" onContextMenu={(e) => e.preventDefault()}>
      <Hud />
      {shopOpen && <Shop />}
      {characterOpen && !shopOpen && <CharacterSheet />}
      {scoreboardOpen && <Scoreboard />}
      {paused && <EscMenu />}
      {/* last: "Entering the arena" covers the auto-opened shop too */}
      <WaitingVeil />
      <AbilityCardHost />
    </div>
  )
}
