import { useEffect } from 'react'
import { useGame } from '../../game/store'
import { usePolled } from '../lib/ticker'
import { localView } from '../lib/view'

/** Any spell / item key moved from the preset (HUD drag, shop drag, Settings). */
export function slotsMoved(s: { settings: { keybinds?: object; keybindsAlt?: object } }): boolean {
  return [...Object.keys(s.settings.keybinds ?? {}), ...Object.keys(s.settings.keybindsAlt ?? {})].some((k) => /^(spell|item)\d$/.test(k))
}

/**
 * A new player's first match: a small note over the action bar that slot keys move at
 * any time, mid-match too. Gone for good once dismissed or once a slot key moves.
 */
export function RemapTip() {
  const seen = useGame((s) => s.settings.remapTipSeen)
  const moved = useGame(slotsMoved)
  const playing = usePolled(() => !!localView()?.pawn, String, 2)
  useEffect(() => {
    if (moved && !seen) useGame.getState().setSettings({ remapTipSeen: true })
  }, [moved, seen])
  if (seen || moved || !playing) return null
  return (
    <div className="remap-tip hud-backing pop-in" data-testid="remap-tip" role="note">
      <span>
        <b className="font-semibold text-[#ffd890]">Your keys, your layout.</b> Drag a spell or item onto another slot to swap their keys, or click a slot and press a key. Works mid-match too.
      </span>
      <button type="button" className="interactive remap-tip-ok" data-testid="remap-tip-dismiss" onClick={() => useGame.getState().setSettings({ remapTipSeen: true })}>
        Got it
      </button>
    </div>
  )
}
