import { useEffect, useSyncExternalStore } from 'react'
import { frame } from '../../game/frame'
import { useGame } from '../../game/store'
import { canInspect, goldVisible, inspectedLoadout, inspectionLabel, inspectStore, isSpectating, livingPlayers, cycle, type InspectedKit, type InspectedLoadout } from '../../game/inspect'
import { BuildIcons } from '../BuildIcons'
import { usePolled, useTick } from '../lib/ticker'
import { kbMultiplier, playerColor, playerGlyph, slotName } from '../lib/view'
import { colorblindPalette } from '../../game/playerPalette'
import { setSpectateTarget } from '../renderBridge'
import { abilityCardProps } from './AbilityCard'

/**
 * Other warlocks' revealed loadouts (last round in shop, live while down),
 * the inspect card that a click on a warlock opens, and spectating
 * while you are down: the camera follows a chosen player, "Watching Thorn ◂ ▸".
 */

export function useInspect() {
  return useSyncExternalStore(inspectStore.subscribe, inspectStore.get)
}

interface LoadoutView {
  ok: boolean
  name: string
  color: string
  glyph: string
  kit: InspectedKit | null
  gold: number | null
  hp: number
  maxHp: number
  kb: number
  alive: boolean
  kills: number
  deaths: number
  kind: InspectedLoadout['kind']
}

const EMPTY: LoadoutView = { ok: false, name: '', color: '#ccc', glyph: '', kit: null, gold: null, hp: 0, maxHp: 0, kb: 0, alive: false, kills: 0, deaths: 0, kind: 'unrevealed' }

function readLoadout(player: number): LoadoutView {
  const s = frame.curr
  if (!s || player < 0) return EMPTY
  const loadout = inspectedLoadout(s, frame.localPlayer, player, useGame.getState().screen === 'replay' ? 'replay' : 'live')
  if (!loadout) return EMPTY
  const slot = s.slots.find((x) => x.id === player)
  const pawn = s.pawns.find((p) => p.owner === player)
  const sc = s.scores.find((x) => x.id === player)
  if (!slot) return EMPTY
  return {
    ok: true,
    name: slot.name,
    color: playerColor(slot, s.settings.teamMode),
    glyph: playerGlyph(slot, s.settings.teamMode, colorblindPalette()),
    kit: loadout.kit,
    gold: loadout.kind === 'live' && goldVisible(s, frame.localPlayer, player) ? Math.floor(sc?.gold ?? 0) : null,
    hp: Math.round(pawn?.alive ? pawn.hp : 0),
    maxHp: Math.round(pawn?.maxHp ?? 0),
    kb: Math.round(pawn?.kbPoints ?? 0),
    alive: !!pawn?.alive,
    kills: sc?.kills ?? 0,
    deaths: sc?.deaths ?? 0,
    kind: loadout.kind,
  }
}

const loadoutKey = (v: LoadoutView) => JSON.stringify(v)

function useLoadout(player: number): LoadoutView {
  // Polling schedules updates, but a parent can render sooner (seat promotion,
  // phase change). Never display the previous occupant's hook-held view then.
  usePolled(() => readLoadout(player), loadoutKey, 4)
  return readLoadout(player)
}

/**
 * Icons of one player's kit: the six spell columns with level pips, the six
 * item slots, mastery levels and (yourself / allies only) gold. Polled at
 * 4 Hz; `cards` adds the hover ability cards (with that player's levels).
 */
export function Loadout({ player, size = 26, cards = false }: { player: number; size?: number; cards?: boolean }) {
  const v = useLoadout(player)
  if (!v.ok) return <span className="text-sm text-ash">Loadout unavailable</span>
  if (v.kind === 'unrevealed') return <span className="text-sm text-ash">{inspectionLabel(v.kind)}</span>
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1" title={inspectionLabel(v.kind)}>
      {v.kind === 'lastRound' && <span className="w-full text-xs text-ash">{inspectionLabel(v.kind)}</span>}
      {v.kit && <BuildIcons kit={v.kit} size={size} cardProps={cards ? (id, level, slot, kind) => abilityCardProps(() => ({ kind, id, context: 'inspect', slot, level, player, side: 'left' })) : undefined} />}
      {v.gold != null && (
        <span className="tabular flex items-center gap-1 text-[0.85rem] font-bold text-gold" title="Gold">
          <span className="coin" aria-hidden />
          {v.gold}
        </span>
      )}
    </span>
  )
}

/**
 * The inspect card: a clicked warlock's loadout, HP, knockback, kills and
 * deaths. Near the right edge (left of the shop when it is open). Esc, a
 * click on empty ground or on the same warlock closes it.
 */
export function InspectCard() {
  const { inspect } = useInspect()
  // keyed by player: the polled loadout starts from that player's values, not the previous one's
  return inspect < 0 ? null : <InspectBody key={inspect} player={inspect} />
}

function InspectBody({ player }: { player: number }) {
  const shopOpen = useGame((s) => s.shopOpen)
  const v = useLoadout(player)
  // a player who left: close
  useEffect(() => {
    if (!v.ok) inspectStore.set({ inspect: -1 })
  }, [v.ok])
  useTick(() => {
    if (!canInspect(frame.curr, frame.localPlayer, player)) inspectStore.set({ inspect: -1 })
  })
  if (!v.ok) return null
  const mult = kbMultiplier(v.kb)
  return (
    <div
      className="inspect-card hud-plate interactive pop-in absolute"
      // below the kill feed at its fullest (5 rows under the fullscreen button), so they never overlap.
      // The card is zoomed with the HUD scale, and CSS zoom scales these offsets too: unscaled values here
      style={{ top: 232, right: shopOpen ? 'calc(var(--dock-right-w, 700px) + 22px)' : 12, ['--hue' as string]: v.color }}
      role="dialog"
      aria-label={`${v.name}'s loadout`}
      data-testid="inspect-card"
    >
      <header className="mb-1.5 flex items-center gap-2">
        <span className="h-3 w-3 rotate-45 rounded-[2px]" style={{ background: v.color, boxShadow: `0 0 8px ${v.color}` }} aria-hidden />
        <span className="truncate text-[1.05rem] font-bold" style={{ color: v.color }}>
          {v.glyph && <span className="mr-1">{v.glyph}</span>}
          {v.name}
        </span>
        {!v.alive && <span className="chip text-[0.72rem] text-ash">out</span>}
        <button type="button" className="ml-auto rounded px-1.5 text-[0.85rem] text-ash hover:text-bone" aria-label="Close" onClick={() => inspectStore.set({ inspect: -1 })}>
          ✕
        </button>
      </header>
      {v.kind === 'live' && <div className="tabular mb-2 grid grid-cols-3 gap-2 text-[0.82rem]">
        <span className="flex flex-col">
          <span className="text-ash">Health</span>
          <b className="text-[0.98rem]">
            {v.hp}
            <span className="text-ash"> / {v.maxHp}</span>
          </b>
        </span>
        <span className="flex flex-col" title={`${v.kb} knockback points`}>
          <span className="text-ash">Knockback</span>
          <b className="text-[0.98rem] text-[#ffcf8a]">×{mult.toFixed(2)}</b>
        </span>
        <span className="flex flex-col">
          <span className="text-ash">Kills / deaths</span>
          <b className="text-[0.98rem]">
            {v.kills} / {v.deaths}
          </b>
        </span>
      </div>}
      <Loadout player={player} size={30} cards />
    </div>
  )
}

/**
 * Spectating while your warlock is down (or as a spectator): which player the
 * camera follows (your pick, else the first one standing), sent to render on
 * change, and the "Watching Thorn ◂ ▸" chip.
 */
export function SpectateChip() {
  const { follow } = useInspect()
  const watching = usePolled(
    () => {
      const s = frame.curr
      const local = frame.localPlayer
      if (!isSpectating(s, local)) return -1
      const live = livingPlayers(s, local)
      return live.includes(follow) ? follow : (live[0] ?? -1)
    },
    String,
    6,
  )
  // tell render; back to automatic when you are playing again
  useEffect(() => {
    setSpectateTarget(watching >= 0 ? watching : null)
  }, [watching])
  // back in the game (respawn, next round): forget the pick
  useTick(() => {
    if (inspectStore.get().follow >= 0 && !isSpectating(frame.curr, frame.localPlayer)) inspectStore.set({ follow: -1 })
  })
  if (watching < 0) return null
  const step = (dir: 1 | -1) => inspectStore.set({ follow: cycle(livingPlayers(frame.curr, frame.localPlayer), watching, dir) })
  return (
    <div className="watch-chip interactive" data-testid="watching">
      <button type="button" aria-label="Previous player" onClick={() => step(-1)}>
        ◂
      </button>
      <span>
        Watching <b style={{ color: playerColorOf(watching) }}>{slotName(frame.curr, watching)}</b>
      </span>
      <button type="button" aria-label="Next player" onClick={() => step(1)}>
        ▸
      </button>
    </div>
  )
}

function playerColorOf(id: number): string {
  const s = frame.curr
  const slot = s?.slots.find((x) => x.id === id)
  return s && slot ? playerColor(slot, s.settings.teamMode) : '#ccc'
}
