import type { HTMLAttributes } from 'react'
import type { InspectedKit } from '../game/inspect'
import { displayName, itemDef, MASTERIES, MASTERY_MAX_LEVEL, SPELL_MAX_LEVEL } from './data/catalog'
import { Sigil } from './icons'

function Pips({ level, max }: { level: number; max: number }) {
  if (max <= 1) return null
  return (
    <span className="loadout-pips" aria-hidden>
      {Array.from({ length: max }, (_, i) => (
        <i key={i} data-on={i < level} />
      ))}
    </span>
  )
}

/** Render a supplied build without consulting the current match or player. */
export function BuildIcons({ kit, size = 26, cardProps }: {
  kit: InspectedKit
  size?: number
  cardProps?: (id: string, level: number, slot: number, kind: 'spell' | 'item') => HTMLAttributes<HTMLElement>
}) {
  const icon = (slot: number, kind: 'spell' | 'item') => {
    const id = kit.slots[slot] ?? null
    const level = kit.levels[slot] ?? 0
    const max = kind === 'spell' ? SPELL_MAX_LEVEL : (itemDef(id)?.maxLevel ?? 1)
    const title = id ? `${displayName(id)} level ${level} of ${max}` : undefined
    return (
      <span
        key={slot}
        {...(id ? cardProps?.(id, level, slot, kind) : null)}
        className="loadout-slot"
        data-empty={!id}
        data-ability={id ?? undefined}
        style={{ width: size, height: size + (max > 1 ? 4 : 0) }}
        title={title}
        aria-label={title}
      >
        {id ? <Sigil id={id} size={size} /> : <span className="loadout-empty" style={{ width: size, height: size }} />}
        {id && <Pips level={level} max={max} />}
      </span>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="flex gap-0.5" aria-label="Spells">
        {[0, 1, 2, 3, 4, 5].map((slot) => icon(slot, 'spell'))}
      </span>
      <span className="flex gap-0.5" aria-label="Items">
        {[6, 7, 8, 9, 10, 11].map((slot) => icon(slot, 'item'))}
      </span>
      <span className="tabular flex gap-1 text-[0.72rem] font-semibold text-ash" title={MASTERIES.map((m) => `${m.name} mastery ${kit.masteries[m.id]} of ${MASTERY_MAX_LEVEL}`).join(', ')}>
        {MASTERIES.map((m) => (
          <span key={m.id} className={kit.masteries[m.id] ? 'text-[#ffcf9a]' : ''} title={`${m.name} mastery ${kit.masteries[m.id]} of ${MASTERY_MAX_LEVEL}`} data-mastery={m.id}>
            {m.name[0]}
            {kit.masteries[m.id]}
          </span>
        ))}
      </span>
    </span>
  )
}
