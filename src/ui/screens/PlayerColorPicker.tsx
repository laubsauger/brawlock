import { session } from '../../game/session'
import { PLAYER_COLOR_OPTIONS, planPlayerColor } from '../../net/lobbyColors'
import type { PlayerSlot } from '../../sim/types'

/** A saved preference, requested by the session as soon as the lobby is joined. */
export function PreferredColorPicker({ color, onChange }: { color: number | null; onChange: (color: number) => void }) {
  return <fieldset className="min-w-0">
    <legend className="mb-2 text-sm font-semibold text-ash">Preferred color</legend>
    <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="Preferred player color">
      {PLAYER_COLOR_OPTIONS.map((choice) => <button key={choice.color} type="button"
        className="relative h-9 w-9 shrink-0 rounded border-2 hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        style={{ background: `#${choice.color.toString(16).padStart(6, '0')}`, borderColor: choice.color === color ? '#fff7df' : '#1b100a' }}
        title={choice.name} aria-label={choice.name} aria-pressed={choice.color === color} onClick={() => onChange(choice.color)}>
        {choice.color === color && <span aria-hidden className="font-bold text-white" style={{ textShadow: '0 1px 3px #000' }}>✓</span>}
      </button>)}
    </div>
    <p className="mt-2 text-xs leading-snug text-ash">Selected when you join a lobby, if another human hasn’t taken it. Bots swap with you.</p>
  </fieldset>
}

/** Selection stays authoritative: this component neither recolors slots nor saves preferences. */
export function PlayerColorPicker({ local, slots, editable }: { local: PlayerSlot; slots: readonly PlayerSlot[]; editable: boolean }) {
  if (local.kind !== 'human') return null
  return <fieldset className="flex min-w-0 flex-col gap-2" disabled={!editable}>
    <legend className="mb-1 text-sm font-semibold text-ash">Your color</legend>
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Player colors">
      {PLAYER_COLOR_OPTIONS.map(({ color, name }) => {
        const selected = local.color === color
        const owner = slots.find((slot) => slot.id !== local.id && slot.color === color)
        const blocked = owner?.kind === 'human'
        const label = selected ? `${name}, selected` : blocked ? `${name}, used by ${owner.name}` : owner ? `${name}, swaps with ${owner.name} (bot)` : `${name}, available`
        return <button
          key={color}
          type="button"
          className="relative h-8 w-8 shrink-0 rounded border-2 transition-transform enabled:hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-35"
          style={{ background: `#${color.toString(16).padStart(6, '0')}`, borderColor: selected ? '#fff7df' : 'rgba(0,0,0,.55)', boxShadow: selected ? '0 0 0 1px #16100b, 0 0 10px rgba(255,214,140,.2)' : undefined }}
          aria-label={label}
          aria-pressed={selected}
          disabled={!editable || blocked}
          title={editable ? label : `${label} · Change colors in the lobby`}
          onClick={() => {
            if (!editable || selected || !planPlayerColor(slots, local.id, color)) return
            session.setPlayerColor(color)
          }}
        >
          {selected && <span className="absolute inset-0 grid place-items-center text-base font-bold text-white" style={{ textShadow: '0 1px 3px #000, 0 0 3px #000' }} aria-hidden>✓</span>}
          {blocked && <span className="absolute inset-0 grid place-items-center font-bold text-white" style={{ textShadow: '0 1px 3px #000' }} aria-hidden>×</span>}
        </button>
      })}
    </div>
    <p className="text-xs leading-snug text-ash">Other players keep their colors. Bots will swap with you.</p>
  </fieldset>
}
