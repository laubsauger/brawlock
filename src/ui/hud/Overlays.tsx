import { useRef, useState, type ReactNode } from 'react'
import { frame } from '../../game/frame'
import { useGame } from '../../game/store'
import { Sigil } from '../icons'
import { displayName, itemDef, levelStats, MASTERIES, MASTERY_MAX_LEVEL, masteryValue, SPELL_MAX_LEVEL, type MasteryId } from '../data/catalog'
import { PAWN_MAX_LIFE, PAWN_MOVE_SPEED } from '../../sim'
import { keyLabel, slotKeyLabel, useBinds } from '../lib/keys'
import { usePolled } from '../lib/ticker'
import { hex, kbMultiplier, localView, TEAM_NAMES } from '../lib/view'
import { leaveToMenu } from '../flow'
import { Button, Kbd, PingBars } from '../widgets'
import { sfx } from '../lib/sound'

/* ------------------------------------------------------------------------
 * Character sheet (C / K): live stats from the local PawnState and score.
 * --------------------------------------------------------------------- */

const BASE = { maxHp: PAWN_MAX_LIFE, regen: 5, speed: PAWN_MOVE_SPEED }

interface Sheet {
  ready: boolean
  hp: number
  maxHp: number
  regen: number
  speed: number
  kb: number
  kbFactor: number
  alive: boolean
  masteries: Record<MasteryId, number>
  owned: { slot: number; id: string; level: number }[]
}

function readSheet(): Sheet {
  const v = localView()
  const p = v?.pawn
  return {
    ready: !!p,
    hp: Math.round(p?.hp ?? 0),
    maxHp: Math.round(p?.maxHp ?? 0),
    regen: Math.round((p?.hpRegen ?? 0) * 10) / 10,
    speed: Math.round(p?.moveSpeed ?? 0),
    kb: Math.round(p?.kbPoints ?? 0),
    kbFactor: Math.round((p?.kbFactor ?? 1) * 100) / 100,
    alive: !!p?.alive,
    masteries: { duration: 0, range: 0, lifesteal: 0, ...v?.score?.masteries },
    owned: (p?.slots ?? []).flatMap((id, slot) => (id ? [{ slot, id, level: p?.levels[slot] ?? 1 }] : [])),
  }
}

/** A number that glows briefly whenever it changes (not on first show). */
function Num({ value, className = '' }: { value: string; className?: string }) {
  const first = useRef(value)
  return (
    <span key={value} className={`tabular ${value !== first.current ? 'stat-pulse' : ''} ${className}`}>
      {value}
    </span>
  )
}

function signed(n: number, digits = 0): string {
  return (n >= 0 ? '+' : '') + n.toFixed(digits)
}

function Tile({ label, value, sub, children }: { label: string; value: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="well flex flex-col gap-0.5 px-3 py-2">
      <span className="text-[0.85rem] font-semibold text-ash">{label}</span>
      <Num value={value} className="text-[1.35rem] leading-tight font-bold" />
      {children}
      {sub && <span className="text-[0.8rem] leading-tight text-ash/85">{sub}</span>}
    </div>
  )
}

/** Stats content, shared by the standalone sheet and the shop's Stats tab. */
export function CharacterBody() {
  const s = usePolled(readSheet, (x) => JSON.stringify(x), 6)
  const binds = useBinds()
  if (!s.ready) return <p className="py-4 text-ash">Your warlock is not in the arena yet.</p>
  const mult = kbMultiplier(s.kb)
  const hpFrac = s.maxHp > 0 ? Math.min(1, (s.alive ? s.hp : 0) / s.maxHp) : 0
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Health" value={`${s.alive ? s.hp : 0} / ${s.maxHp}`} sub={s.maxHp !== BASE.maxHp ? `Base ${BASE.maxHp}, items ${signed(s.maxHp - BASE.maxHp)}` : undefined}>
          <span className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-black/50">
            <span className="block h-full rounded-full bg-gradient-to-r from-[#8e0f17] to-[#ff6b57] transition-[width] duration-300" style={{ width: `${hpFrac * 100}%` }} />
          </span>
        </Tile>
        <Tile label="Regeneration" value={`${s.regen.toFixed(1)}/s`} sub={s.regen !== BASE.regen ? `Base ${BASE.regen.toFixed(1)}, ${signed(s.regen - BASE.regen, 1)}` : 'Base'} />
        <Tile label="Move speed" value={String(s.speed)} sub={s.speed !== BASE.speed ? `Base ${BASE.speed}, ${signed(s.speed - BASE.speed)}` : 'Base'} />
        <Tile
          label="Knockback taken"
          value={`×${s.kbFactor.toFixed(2)}`}
          sub={s.kbFactor < 1 ? 'Lowered by Armor or Cursed Ring' : s.kbFactor > 1 ? 'Raised by an active effect' : 'Armor lowers this'}
        />
      </div>

      <section className="well px-3 py-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[0.95rem] font-semibold text-ash">Knockback points</span>
          <Num value={String(s.kb)} className="text-[1.35rem] font-bold" />
        </div>
        <div className="kb-frame mt-1.5" data-hot={s.kb >= 1000}>
          <div className="kb-fill" style={{ transform: `scaleX(${Math.min(1, s.kb / 2000)})`, ['--kb-span' as string]: `${100 / Math.max(Math.min(1, s.kb / 2000), 0.05)}%` }} />
        </div>
        <p className="mt-2 text-[0.92rem] leading-snug text-[#e6d3b8]">
          Hits push you <Num value={`×${mult.toFixed(2)}`} className="font-bold text-[#ffcf8a]" /> as far. Damage you take adds points, healing sheds some, respawning
          clears them.
        </p>
      </section>

      <section>
        <h3 className="mb-1.5 text-[1rem] font-bold text-[#ffd890]">Masteries</h3>
        <div className="flex flex-col gap-1">
          {MASTERIES.map((m) => {
            const lvl = s.masteries[m.id]
            const val = masteryValue(m.id, lvl)
            return (
              <div key={m.id} className="flex items-center gap-2.5 py-0.5" title={m.desc}>
                <Sigil id={m.id} size={24} />
                <span className="flex-1 font-semibold">{m.name}</span>
                <span className="lvl-bars" aria-label={`Level ${lvl} of ${MASTERY_MAX_LEVEL}`}>
                  {Array.from({ length: MASTERY_MAX_LEVEL }, (_, i) => (
                    <i key={i} data-on={i < lvl} />
                  ))}
                </span>
                <Num value={m.id === 'lifesteal' ? `${Math.round(val * 100)}%` : `×${val.toFixed(2)}`} className="w-12 text-right font-bold" />
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 text-[1rem] font-bold text-[#ffd890]">Spells and items</h3>
        <div className="flex flex-col gap-1">
          {s.owned.map((o) => {
            const max = o.slot < 6 ? SPELL_MAX_LEVEL : (itemDef(o.id)?.maxLevel ?? 1)
            const stats = levelStats(o.id, o.level)
            const next = o.level < max ? levelStats(o.id, o.level + 1) : null
            return (
              <div key={o.slot} className="flex items-center gap-2.5 py-1">
                <Sigil id={o.id} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-bold">{displayName(o.id)}</span>
                    {max > 1 && (
                      <span className="text-[0.82rem] text-ash">
                        level {o.level}/{max}
                      </span>
                    )}
                  </span>
                  {stats.length > 0 && (
                    <span className="block truncate text-[0.85rem] text-ash" title={next ? `Next level: ${next.map(([k, x]) => `${k} ${x}`).join(', ')}` : undefined}>
                      {stats.map(([k, x]) => `${k} ${x}`).join(', ')}
                    </span>
                  )}
                </span>
                <Kbd>{slotKeyLabel(binds, o.slot)}</Kbd>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

export function CharacterSheet() {
  const binds = useBinds()
  const toggle = useGame((st) => st.toggle)
  return (
    <aside className="dock dock-left" aria-label="Your warlock">
      <div className="panel flex min-h-0 flex-1 flex-col">
        <header className="flex items-center justify-between px-4 pt-3.5 pb-2">
          <h2 className="display text-[2rem] leading-none text-[#ffd890]">Your warlock</h2>
          <Button size="sm" variant="ghost" sound="back" onClick={() => toggle('characterOpen', false)}>
            Close <Kbd>{keyLabel(binds.character)}</Kbd>
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <CharacterBody />
        </div>
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------------
 * Scoreboard (hold Tab)
 * --------------------------------------------------------------------- */

interface BoardRow {
  id: number
  name: string
  color: string
  team: number
  kind: 'human' | 'bot'
  score: number
  kills: number
  deaths: number
  dmg: number
  alive: boolean
  connected: boolean
}

function readBoard(): BoardRow[] {
  const s = frame.curr
  if (!s) return []
  return s.slots
    .map((slot) => {
      const sc = s.scores.find((x) => x.id === slot.id)
      return {
        id: slot.id,
        name: slot.name,
        color: hex(slot.color),
        team: slot.team,
        kind: slot.kind,
        score: sc?.score ?? 0,
        kills: sc?.kills ?? 0,
        deaths: sc?.deaths ?? 0,
        dmg: Math.round(sc?.damageThisRound ?? 0),
        alive: !!s.pawns.find((p) => p.owner === slot.id)?.alive,
        connected: sc?.connected ?? true,
      }
    })
    .sort((a, b) => b.score - a.score || b.kills - a.kills || a.id - b.id)
}

export function Scoreboard() {
  const rows = usePolled(readBoard, (r) => JSON.stringify(r), 4)
  const role = useGame((s) => s.lobby.role)
  const pings = useGame((s) => s.lobby.pings)
  const state = frame.curr
  const teamMode = state?.settings.teamMode
  const winScore = state?.settings.winScore
  const local = frame.localPlayer
  const ping = (r: BoardRow) => {
    if (r.kind === 'bot') return <span className="text-sm text-ash">Bot</span>
    if (!r.connected) return <span className="text-sm text-[#ff9b8a]">Left</span>
    if (role === 'offline') return <span className="text-sm text-ash">–</span>
    return <PingBars ms={pings?.[r.id]} host={r.id === 0} />
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center p-4">
      <div className="panel fade-in w-[min(820px,100%)] p-6" role="dialog" aria-label="Scoreboard">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="display text-3xl leading-none text-[#ffd890]">Scoreboard</h2>
          {state && (
            <span className="text-[0.98rem] text-ash">
              Round {Math.max(1, state.round)}
              {winScore ? `, first to ${winScore}` : ''}
            </span>
          )}
        </div>
        <table className="tabular w-full text-left text-[1.02rem]">
          <thead className="text-sm text-ash">
            <tr>
              <th className="pb-2 font-semibold">Warlock</th>
              {teamMode === 'teams' && <th className="pb-2 font-semibold">Team</th>}
              <th className="pb-2 text-right font-semibold">Score</th>
              <th className="pb-2 text-right font-semibold">K / D</th>
              <th className="pb-2 text-right font-semibold" title="Damage dealt this round">
                Damage
              </th>
              <th className="pb-2 pl-4 text-right font-semibold">Ping</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-t border-[rgba(255,170,100,0.08)] ${r.id === local ? 'bg-[rgba(255,180,80,0.07)]' : ''} ${r.alive ? '' : 'text-bone/55'}`}
                style={{ boxShadow: `inset 3px 0 0 ${r.color}` }}
              >
                <td className="py-2 pl-3">
                  <span className="flex items-center gap-2.5">
                    <span className="h-3 w-3 rotate-45 rounded-[2px]" style={{ background: r.color }} aria-hidden />
                    <span className="font-semibold">{r.name}</span>
                    {r.id === local && <span className="chip text-gold">You</span>}
                    {!r.alive && <span className="text-sm text-ash">out</span>}
                  </span>
                </td>
                {teamMode === 'teams' && <td className="py-2 text-ash">{TEAM_NAMES[r.team] ?? r.team + 1}</td>}
                <td className="py-2 text-right text-[1.15rem] font-bold text-gold">{r.score}</td>
                <td className="py-2 text-right">
                  {r.kills} / {r.deaths}
                </td>
                <td className="py-2 text-right">{r.dmg}</td>
                <td className="py-2 pl-4 text-right">{ping(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="text-ash">No players yet.</p>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------
 * In-match menu (Esc)
 * --------------------------------------------------------------------- */

export function EscMenu() {
  const role = useGame((s) => s.lobby.role)
  const toggle = useGame((s) => s.toggle)
  const [confirm, setConfirm] = useState(false)
  const offline = role === 'offline'
  return (
    <div className="scrim fade-in interactive pointer-events-auto absolute inset-0 z-40 grid place-items-center p-4">
      <div className="panel pop-in flex w-[min(380px,100%)] flex-col gap-3 p-7" role="dialog" aria-label="Menu">
        <h2 className="display text-5xl leading-none text-[#ffd890]">{offline ? 'Paused' : 'Menu'}</h2>
        <p className="mb-2 text-[0.95rem] text-ash">{offline ? 'The arena waits for you.' : 'The match keeps running while this is open.'}</p>
        {confirm ? (
          <>
            <p className="text-[1.05rem]">{role === 'host' ? 'Leaving ends the match for everyone.' : 'Leave this match and return to the main menu?'}</p>
            <Button variant="danger" sound="back" onClick={leaveToMenu} autoFocus>
              Leave match
            </Button>
            <Button onClick={() => setConfirm(false)}>Stay</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={() => toggle('paused', false)} autoFocus>
              Resume <Kbd>Esc</Kbd>
            </Button>
            <Button onClick={() => toggle('settingsOpen', true)}>Settings</Button>
            <Button
              variant="danger"
              onClick={() => {
                sfx('back')
                setConfirm(true)
              }}
              sound={null}
            >
              Leave match
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
