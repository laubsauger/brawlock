import { useEffect, useState, type ReactNode } from 'react'
import type { MatchRecord } from '../../game/stats'
import { useGame } from '../../game/store'
import { Button, Kbd } from '../widgets'
import { hex } from '../lib/view'
import { ago, duration, readCareer, readEncounterList, readHistory, readLeaderboard, useStats } from '../lib/stats'
import { chooseName, NAME_MAX } from '../lib/name'

type Tab = 'matches' | 'rivals' | 'board'

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="well flex flex-col px-4 py-3">
      <span className="text-[0.9rem] font-semibold text-ash">{label}</span>
      <span className="tabular text-[1.7rem] leading-tight font-bold">{value}</span>
      {sub && <span className="text-[0.85rem] text-ash">{sub}</span>}
    </div>
  )
}

function pct(w: number, g: number): string {
  return g > 0 ? `${Math.round((w / g) * 100)}%` : '–'
}

function modeLabel(r: MatchRecord): string {
  const n = r.participants.length
  if (r.teamMode === 'teams') return `Teams, ${n} players`
  if (n === 2) return '1v1'
  return r.teamMode === 'ffa' ? `Free for all, ${n}` : `Shuffle, ${n}`
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-[1.05rem] text-ash">{children}</p>
}

function Matches() {
  const history = useStats(readHistory)
  if (history.length === 0) return <Empty>No matches yet. Play against bots or host a game; every match lands here.</Empty>
  return (
    <ul className="flex flex-col gap-1.5">
      {history.map((r) => {
        const me = r.participants.find((p) => p.player === r.self)
        const win = r.outcome === 'win'
        const others = [...r.participants].sort((a, b) => b.score - a.score)
        return (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-3 py-2.5"
            style={{ background: 'rgba(0,0,0,.25)', boxShadow: `inset 3px 0 0 ${win ? '#7fe39a' : r.outcome === 'loss' ? '#ff6a55' : '#a39080'}` }}
          >
            <span className={`w-14 text-[1.05rem] font-bold ${win ? 'text-heal' : r.outcome === 'loss' ? 'text-[#ff9b8a]' : 'text-ash'}`}>
              {win ? 'Win' : r.outcome === 'loss' ? 'Loss' : 'Watched'}
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
              {others.map((p) => (
                <span key={p.player} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rotate-45 rounded-[1px]" style={{ background: hex(p.color) }} aria-hidden />
                  <span className={`font-semibold ${p.player === r.self ? 'text-gold' : ''}`}>{p.name}</span>
                  <span className="tabular text-ash">{p.score}</span>
                </span>
              ))}
            </span>
            {me && (
              <span className="tabular text-[0.95rem] text-[#e6d3b8]" title="Your kills / deaths">
                {me.kills} / {me.deaths}
              </span>
            )}
            <span className="w-28 text-right text-[0.9rem] text-ash">{modeLabel(r)}</span>
            <span className="tabular w-12 text-right text-[0.9rem] text-ash">{duration(r.durationSec)}</span>
            <span className="w-24 text-right text-[0.9rem] text-ash">{ago(r.date)}</span>
          </li>
        )
      })}
    </ul>
  )
}

function Rivals() {
  const list = useStats(readEncounterList)
  if (list.length === 0) return <Empty>Everyone you play against shows up here, with your record against them.</Empty>
  const sorted = [...list].sort((a, b) => b.lastSeen - a.lastSeen)
  return (
    <table className="tabular w-full text-left text-[1.02rem]">
      <thead className="text-sm text-ash">
        <tr>
          <th className="pb-2 font-semibold">Opponent</th>
          <th className="pb-2 text-right font-semibold">Played</th>
          <th className="pb-2 text-right font-semibold">You won</th>
          <th className="pb-2 text-right font-semibold">They won</th>
          <th className="pb-2 text-right font-semibold" title="Your kills on them / their kills on you">
            Kills
          </th>
          <th className="pb-2 text-right font-semibold">Last played</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((e) => (
          <tr key={e.profileId} className="border-t border-[rgba(255,170,100,0.08)]">
            <td className="py-2">
              <span className="flex items-center gap-2.5">
                <span className="h-3 w-3 rotate-45 rounded-[2px]" style={{ background: hex(e.lastColor) }} aria-hidden />
                <span className="font-semibold">{e.lastName}</span>
                {e.kind === 'bot' && <span className="chip">Bot, {e.difficulty ?? 'medium'}</span>}
              </span>
            </td>
            <td className="py-2 text-right">{e.games}</td>
            <td className={`py-2 text-right font-bold ${e.wins > e.losses ? 'text-heal' : ''}`}>{e.wins}</td>
            <td className={`py-2 text-right font-bold ${e.losses > e.wins ? 'text-[#ff9b8a]' : ''}`}>{e.losses}</td>
            <td className="py-2 text-right">
              {e.killsOn} / {e.deathsTo}
            </td>
            <td className="py-2 text-right text-ash">{ago(e.lastSeen)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Board() {
  const rows = useStats(readLeaderboard)
  return (
    <div>
      <p className="mb-3 text-[0.98rem] text-ash">
        Players you have played, rated from the matches on this device. A global leaderboard arrives with dedicated servers.
      </p>
      {rows.length === 0 ? (
        <Empty>Finish a match to get a rating.</Empty>
      ) : (
        <table className="tabular w-full text-left text-[1.02rem]">
          <thead className="text-sm text-ash">
            <tr>
              <th className="w-10 pb-2 font-semibold">#</th>
              <th className="pb-2 font-semibold">Player</th>
              <th className="pb-2 text-right font-semibold">Rating</th>
              <th className="pb-2 text-right font-semibold">Wins</th>
              <th className="pb-2 text-right font-semibold">Losses</th>
              <th className="pb-2 text-right font-semibold">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.profileId} className={`border-t border-[rgba(255,170,100,0.08)] ${r.self ? 'bg-[rgba(255,180,80,0.08)]' : ''}`}>
                <td className="py-2 font-bold text-ash">{i + 1}</td>
                <td className="py-2">
                  <span className="flex items-center gap-2.5">
                    <span className="h-3 w-3 rotate-45 rounded-[2px]" style={{ background: hex(r.color) }} aria-hidden />
                    <span className="font-semibold">{r.name}</span>
                    {r.self && <span className="chip text-gold">You</span>}
                    {r.kind === 'bot' && <span className="chip">Bot</span>}
                  </span>
                </td>
                <td className="py-2 text-right text-[1.12rem] font-bold text-gold">{Math.round(r.rating)}</td>
                <td className="py-2 text-right">{r.wins}</td>
                <td className="py-2 text-right">{r.losses}</td>
                <td className="py-2 text-right text-ash">{ago(r.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function Profile({ onBack }: { onBack: () => void }) {
  const career = useStats(readCareer)
  const name = useGame((s) => s.settings.playerName)
  const [draft, setDraft] = useState(name)
  const [tab, setTab] = useState<Tab>('matches')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useGame.getState().settingsOpen) onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const c = career
  const kd = c ? (c.deaths > 0 ? (c.kills / c.deaths).toFixed(2) : String(c.kills)) : '–'
  const tabs: { id: Tab; label: string }[] = [
    { id: 'matches', label: 'Matches' },
    { id: 'rivals', label: 'Rivals' },
    { id: 'board', label: 'Leaderboard' },
  ]

  return (
    <div className="screen-in flex h-full flex-col px-[max(16px,5vw)] py-[max(16px,4vh)]">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-5">
          <h1 className="display text-6xl leading-none text-[#ffd890]">Your record</h1>
          <input
            className="field w-56 text-[1.15rem] font-semibold"
            aria-label="Your name"
            maxLength={NAME_MAX}
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setDraft(chooseName(draft))}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </div>
        <Button sound="back" onClick={onBack}>
          Back <Kbd>Esc</Kbd>
        </Button>
      </header>

      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <Tile label="Matches" value={String(c?.games ?? 0)} />
        <Tile label="Wins" value={String(c?.wins ?? 0)} sub={c ? `${pct(c.wins, c.games)} win rate` : undefined} />
        <Tile label="Kills / deaths" value={kd} sub={c ? `${c.kills} / ${c.deaths}` : undefined} />
        <Tile label="Damage dealt" value={c ? Math.round(c.damage).toLocaleString() : '0'} />
        <Tile label="Win streak" value={String(c?.winStreak ?? 0)} sub={c ? `best ${c.bestWinStreak}` : undefined} />
        <Tile label="Time in the arena" value={c ? duration(c.seconds) : '0:00'} sub={c ? `${c.rounds} rounds` : undefined} />
        <Tile label="Against players" value={c ? `${c.vsHumans.wins}–${c.vsHumans.games - c.vsHumans.wins}` : '–'} sub={c ? pct(c.vsHumans.wins, c.vsHumans.games) : undefined} />
        <Tile label="Against bots" value={c ? `${c.vsBots.wins}–${c.vsBots.games - c.vsBots.wins}` : '–'} sub={c ? pct(c.vsBots.wins, c.vsBots.games) : undefined} />
      </div>

      <section className="panel flex min-h-0 flex-1 flex-col p-5">
        <div className="mb-3 flex gap-1" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {tab === 'matches' && <Matches />}
          {tab === 'rivals' && <Rivals />}
          {tab === 'board' && <Board />}
        </div>
      </section>
    </div>
  )
}
