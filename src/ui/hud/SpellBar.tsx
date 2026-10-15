import { useRef } from 'react'
import { TICK_HZ, type SpellId } from '../../sim/types'
import { Sigil } from '../icons'
import { displayName, itemDef, knownCooldown, SPELL_MAX_LEVEL } from '../data/catalog'
import { slotKeyLabel, useBinds } from '../lib/keys'
import { usePolled, useTick } from '../lib/ticker'
import { localView } from '../lib/view'

export const SPELL_SLOTS = 6
export const ITEM_SLOTS = 6

interface SlotInfo {
  spell: SpellId | null
  level: number
}

/** Structure of the local hotbar; re-renders only when a spell / level changes. */
function readSlots(): SlotInfo[] {
  const pawn = localView()?.pawn
  return Array.from({ length: SPELL_SLOTS + ITEM_SLOTS }, (_, i) => ({
    spell: pawn?.slots[i] ?? null,
    level: pawn?.levels[i] ?? 0,
  }))
}

const slotsKey = (s: SlotInfo[]) => s.map((x) => `${x.spell ?? '-'}:${x.level}`).join('|')

function Slot({ index, info, keyLabel }: { index: number; info: SlotInfo; keyLabel: string }) {
  const root = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const total = useRef(0)
  const last = useRef({ cd: -1, casting: false, label: '' })

  const isItem = index >= SPELL_SLOTS
  const maxLevel = isItem ? (itemDef(info.spell)?.maxLevel ?? 1) : SPELL_MAX_LEVEL

  useTick(() => {
    const el = root.current
    if (!el || !info.spell) return
    const pawn = localView()?.pawn
    const cd = pawn?.cooldowns[index] ?? 0
    const prev = last.current
    // the sim only reports remaining ticks: learn the full cooldown when it (re)starts
    if (cd > prev.cd && cd > 0) {
      const known = knownCooldown(info.spell, info.level)
      total.current = Math.max(cd, prev.cd < 0 && known ? known * TICK_HZ : 0)
    }
    if (cd !== prev.cd) {
      const cooling = cd > 0
      el.dataset.cooling = String(cooling)
      if (cooling) {
        el.style.setProperty('--cd', String(Math.min(1, cd / Math.max(1, total.current))))
        const secs = cd / TICK_HZ
        const label = secs >= 1 ? String(Math.ceil(secs)) : secs.toFixed(1)
        if (label !== prev.label && text.current) {
          text.current.textContent = label
          prev.label = label
        }
      } else {
        if (text.current) text.current.textContent = ''
        prev.label = ''
        if (prev.cd > 0) {
          el.dataset.readyFlash = 'false'
          void el.offsetWidth
          el.dataset.readyFlash = 'true'
        }
      }
      prev.cd = cd
    }
    const casting = pawn?.cast?.slot === index
    if (casting !== prev.casting) {
      el.dataset.casting = String(casting)
      prev.casting = casting
    }
  })

  const name = displayName(info.spell)
  return (
    <div
      ref={root}
      className={`slot ${isItem ? 'item' : ''}`}
      data-empty={!info.spell}
      title={info.spell ? `${name}${maxLevel > 1 ? `, level ${info.level}` : ''}` : isItem ? 'Empty item slot' : 'Empty spell slot. Buy one in the shop (B)'}
    >
      {info.spell && (
        <div className="icon">
          <Sigil id={info.spell} size={isItem ? 31 : 42} />
        </div>
      )}
      <div className="cd" />
      <div ref={text} className="cd-text" />
      {keyLabel && <span className="hotkey">{keyLabel}</span>}
      {info.spell && maxLevel > 1 && (
        <div className="pips" aria-hidden>
          {Array.from({ length: maxLevel }, (_, i) => (
            <i key={i} data-on={i < info.level} />
          ))}
        </div>
      )}
    </div>
  )
}

export function SpellRow() {
  const slots = usePolled(readSlots, slotsKey, 6)
  const binds = useBinds()
  return (
    <div className="flex gap-1.5" aria-label="Spells">
      {slots.slice(0, SPELL_SLOTS).map((info, i) => (
        <Slot key={i} index={i} info={info} keyLabel={slotKeyLabel(binds, i)} />
      ))}
    </div>
  )
}

export function ItemGrid() {
  const slots = usePolled(readSlots, slotsKey, 6)
  const binds = useBinds()
  return (
    <div className="grid grid-cols-3 gap-1" aria-label="Items">
      {slots.slice(SPELL_SLOTS).map((info, i) => (
        <Slot key={i} index={SPELL_SLOTS + i} info={info} keyLabel={slotKeyLabel(binds, SPELL_SLOTS + i)} />
      ))}
    </div>
  )
}
