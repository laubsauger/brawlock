import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getHallOfFame, getMatchHistory, type Career, type HallOfFameKey, type MatchRecord } from '../../game/stats'
import { getProfile } from '../../game/profile'
import { Sigil } from '../icons'
import { displayName } from '../data/catalog'
import { percent, ratingTrend, seconds, tiles } from '../lib/statFormat'
import { AwardsStrip, PlayerStatsDetail } from './statViews'
import { useGame } from '../../game/store'
import { Button, Kbd, Segmented } from '../widgets'
import { online, session, type LeaderboardPage, type Period, type PublicBoardRow, type ServerProfile } from '../../game/session'
import { hex } from '../lib/view'
import { ago, duration, readCareer, readEncounterList, readHistory, readLeaderboard, useStats } from '../lib/stats'
import { exportReplay, importReplay, useReplayIds, watchReplay } from '../lib/replays'
import { REPLAY_EXT } from '../../game/replay/format'
import { chooseName, NAME_MAX } from '../lib/name'

type Tab = 'matches' | 'stats' | 'rivals' | 'board'

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  // opaque plate: the 3D backdrop must not bleed through the numbers
  return (
    <div className="well flex flex-col bg-[rgba(18,11,8,0.92)] px-4 py-3">
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

/** Import a shared `.brawlock` replay file and watch it. */
function ImportReplay() {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="mb-2 flex justify-end">
      <input
        ref={ref}
        type="file"
        accept={REPLAY_EXT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void importReplay(f)
        }}
      />
      <button type="button" className="text-[0.9rem] text-[#ffcf9a] underline-offset-2 hover:underline" onClick={() => ref.current?.click()}>
        Import a replay ({REPLAY_EXT})
      </button>
    </div>
  )
}

function Matches({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const history = useStats(readHistory)
  const replayIds = useReplayIds()
  const openRef = useRef<HTMLLIElement>(null)
  // a Hall of Fame link opens its match: bring it into view. Block body: Chrome 153+ returns a
  // Promise from scrollIntoView, which React would keep as the cleanup and crash on (effectCleanup.test)
  useEffect(() => {
    openRef.current?.scrollIntoView({ block: 'nearest' })
  }, [openId])
  if (history.length === 0)
    return (
      <>
        <ImportReplay />
        <Empty>No matches yet. Play against bots or host a game; every match lands here.</Empty>
      </>
    )
  return (
    <>
    <ImportReplay />
    <ul className="flex flex-col gap-1.5">
      {history.map((r) => {
        const me = r.participants.find((p) => p.player === r.self)
        const win = r.outcome === 'win'
        const others = [...r.participants].sort((a, b) => b.score - a.score)
        const open = openId === r.id
        const detail = (r.awards?.length ?? 0) > 0 || !!me?.stats
        const who = (id: number) => {
          const p = r.participants.find((x) => x.player === id)
          return { name: p?.name ?? '?', color: p ? hex(p.color) : '#ccc' }
        }
        return (
          <li key={r.id} ref={open ? openRef : undefined} className="rounded-lg" style={{ background: 'rgba(0,0,0,.25)', boxShadow: `inset 3px 0 0 ${win ? '#7fe39a' : r.outcome === 'loss' ? '#ff6a55' : '#a39080'}` }}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
              {detail ? (
                <button type="button" className="row-toggle" aria-expanded={open} aria-label={open ? 'Hide match details' : 'Show match details'} onClick={() => onOpen(open ? null : r.id)}>
                  <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
                    <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                </button>
              ) : (
                <span className="w-5" aria-hidden />
              )}
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
              {replayIds.has(r.id) && (
                <button type="button" className="text-[0.9rem] text-[#ffcf9a] underline-offset-2 hover:underline" aria-label="Watch the replay of this match" onClick={() => void watchReplay(r.id)}>
                  ▶ Replay
                </button>
              )}
              <span className="w-28 text-right text-[0.9rem] text-ash">{modeLabel(r)}</span>
              <span className="tabular w-12 text-right text-[0.9rem] text-ash">{duration(r.durationSec)}</span>
              <span className="w-24 text-right text-[0.9rem] text-ash">{ago(r.date)}</span>
            </div>
            {open && (
              <div className="pop-in flex flex-col gap-2 px-3 pb-3">
                {r.awards && r.awards.length > 0 && <AwardsStrip awards={r.awards} who={who} compact />}
                {me?.stats ? <PlayerStatsDetail stats={me.stats} /> : <p className="text-[0.9rem] text-ash">Detailed stats are kept for your 30 most recent matches.</p>}
                {replayIds.has(r.id) && (
                  <div className="flex gap-3 text-[0.9rem]">
                    <button type="button" className="text-[#ffcf9a] underline-offset-2 hover:underline" onClick={() => void watchReplay(r.id)}>
                      Watch replay
                    </button>
                    <button type="button" className="text-[#ffcf9a] underline-offset-2 hover:underline" onClick={() => void exportReplay(r.id)}>
                      Export ({REPLAY_EXT})
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
    </>
  )
}

/** Personal bests: how each one reads. */
const HALL: { key: HallOfFameKey; label: string; fmt: (v: number) => string }[] = [
  { key: 'mostKills', label: 'Most kills', fmt: (v) => String(v) },
  { key: 'mostDamage', label: 'Most damage', fmt: (v) => Math.round(v).toLocaleString() },
  { key: 'bestStreak', label: 'Longest kill streak', fmt: (v) => String(v) },
  { key: 'bestMulti', label: 'Best multi-kill', fmt: (v) => `${v} in a row` },
  { key: 'longestFlight', label: 'Longest flight', fmt: tiles },
  { key: 'mostPushed', label: 'Most pushed around', fmt: tiles },
  { key: 'mostWalked', label: 'Most walked', fmt: tiles },
  { key: 'bestAccuracy', label: 'Best accuracy', fmt: (v) => percent(v) },
  { key: 'mostScourgeHits', label: 'Most Scourge hits', fmt: (v) => String(v) },
  { key: 'mostTeleportSaves', label: 'Most Teleport saves', fmt: (v) => String(v) },
  { key: 'mostReflects', label: 'Most Shield reflects', fmt: (v) => String(v) },
  { key: 'longestAlive', label: 'Longest alive', fmt: seconds },
]

const readHall = () => {
  try {
    return getHallOfFame()
  } catch {
    return {}
  }
}

const readAllHistory = () => {
  try {
    return getMatchHistory(200)
  } catch {
    return []
  }
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="section-title text-[1rem]">{title}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">{children}</dl>
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[0.8rem] font-semibold text-ash">{label}</dt>
      <dd className="tabular text-[1.05rem] font-bold text-[#f0dfc8]">{value}</dd>
    </div>
  )
}

/** Small SVG line of your rating over the stored matches. */
function Sparkline({ values }: { values: number[] }) {
  const W = 220
  const H = 44
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = Math.max(1, hi - lo)
  const pts = values.map((v, i) => `${values.length === 1 ? W / 2 : (i / (values.length - 1)) * W},${H - 3 - ((v - lo) / span) * (H - 6)}`).join(' ')
  const up = values[values.length - 1] >= values[0]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Rating from ${Math.round(values[0])} to ${Math.round(values[values.length - 1])}`}>
      <polyline points={pts} fill="none" stroke={up ? '#7fe39a' : '#ff8a6a'} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** Career totals grouped like the data, per-spell cards, the Hall of Fame and the rating trend. */
function StatsTab({ career, onOpenMatch }: { career: Career | null; onOpenMatch: (id: string) => void }) {
  const hall = useStats(readHall)
  const history = useStats(readAllHistory)
  const board = useStats(readLeaderboard)
  const selfId = getProfile().id
  const current = board.find((r) => r.self)?.rating ?? null
  const trend = useMemo(() => ratingTrend(history, selfId, current), [history, selfId, current])
  // per-spell totals from the matches that kept detailed stats
  const spells = useMemo(() => {
    const m = new Map<string, [number, number]>()
    let n = 0
    for (const r of history) {
      const me = r.participants.find((p) => p.player === r.self)
      if (!me?.stats) continue
      n++
      for (const [id, [c, h]] of Object.entries(me.stats.spells)) {
        const t = m.get(id) ?? [0, 0]
        m.set(id, [t[0] + c, t[1] + h])
      }
    }
    return { list: [...m].filter(([, [c]]) => c > 0).sort((a, b) => b[1][0] - a[1][0]), matches: n }
  }, [history])
  const t = career?.totals
  if (!career || !t) return <Empty>Play a match and your career stats start here.</Empty>
  const ids = new Set(history.map((r) => r.id))
  const lavaDeaths = t.deathsByCause.lava ?? 0
  return (
    <div className="flex flex-col gap-5">
      {trend.length >= 2 ? (
        <div className="flex flex-wrap items-center gap-4">
          <h3 className="section-title text-[1rem]">Rating</h3>
          <Sparkline values={trend} />
          <span className="tabular text-[0.95rem] text-[#e6d3b8]">
            {Math.round(trend[0])} → <b className="text-gold">{Math.round(trend[trend.length - 1])}</b> over {trend.length} matches
          </span>
        </div>
      ) : (
        <p className="text-[0.9rem] text-ash">Your rating trend appears after two matches.</p>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Group title="Movement">
          <Fact label="Walked" value={tiles(t.walked)} />
          <Fact label="Pushed around" value={tiles(t.pushed)} />
          <Fact label="Teleported" value={tiles(t.teleported)} />
        </Group>
        <Group title="Combat">
          <Fact label="Kills" value={career.kills.toLocaleString()} />
          <Fact label="Damage dealt" value={Math.round(career.damage).toLocaleString()} />
          <Fact label="Damage taken" value={Math.round(t.damageTaken).toLocaleString()} />
          <Fact label="Knockbacks dealt" value={t.knockbacksDealt.toLocaleString()} />
          <Fact label="Knockbacks taken" value={t.knockbacksTaken.toLocaleString()} />
          <Fact label="First Bloods" value={String(t.firstBloods)} />
        </Group>
        <Group title="Spells">
          <Fact label="Casts" value={t.casts.toLocaleString()} />
          <Fact label="Hits" value={t.hits.toLocaleString()} />
          <Fact label="Accuracy" value={percent(t.casts ? t.hits / t.casts : null)} />
          <Fact label="Scourge hits" value={String(t.scourgeHits)} />
          <Fact label="Teleport saves" value={String(t.teleportSaves)} />
          <Fact label="Shield reflects" value={String(t.shieldReflects)} />
        </Group>
        <Group title="Survival">
          <Fact label="Time alive" value={seconds(t.aliveSec)} />
          <Fact label="Rounds survived" value={String(t.roundsSurvived)} />
          <Fact label="Time in lava" value={seconds(t.lavaSec)} />
          <Fact label="Ended up in lava" value={`${lavaDeaths} ${lavaDeaths === 1 ? 'time' : 'times'}`} />
          <Fact label="Own goals" value={String(t.selfKills)} />
          <Fact label="Pillars destroyed" value={String(t.pillarsDestroyed)} />
        </Group>
        <Group title="Economy">
          <Fact label="Gold earned" value={Math.round(t.goldEarned).toLocaleString()} />
          <Fact label="Gold spent" value={Math.round(t.goldSpent).toLocaleString()} />
        </Group>
      </div>

      {spells.list.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="section-title text-[1rem]">
            Spell by spell{' '}
            <span className="ml-1 font-ui text-[0.8rem] font-medium tracking-normal text-ash">{spells.matches === 1 ? 'from your last match' : `from your last ${spells.matches} matches`}</span>
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
            {spells.list.map(([id, [c, h]]) => (
              <div key={id} className="flex items-center gap-2.5 rounded-lg bg-[rgba(0,0,0,0.28)] px-2.5 py-2">
                <Sigil id={id} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.95rem] font-bold">{displayName(id)}</div>
                  <div className="tabular text-[0.8rem] text-ash">
                    {c} casts · {h} hits · {percent(h / c)}
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[rgba(255,255,255,0.08)]">
                    <div className="h-full rounded-full bg-[#ffc548]" style={{ width: `${Math.min(100, Math.round((h / c) * 100))}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="section-title text-[1rem]">Hall of Fame</h3>
        {Object.keys(hall).length === 0 ? (
          <p className="text-[0.9rem] text-ash">Personal bests show up after your first detailed match.</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1.5">
            {HALL.filter((h) => hall[h.key]).map((h) => {
              const e = hall[h.key]!
              return (
                <li key={h.key} className="flex items-baseline justify-between gap-2 rounded-md bg-[rgba(0,0,0,0.28)] px-3 py-1.5">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[0.8rem] font-semibold text-ash">{h.label}</span>
                    <span className="tabular text-[1.05rem] font-bold text-gold">{h.fmt(e.value)}</span>
                  </span>
                  {ids.has(e.matchId) ? (
                    <button type="button" className="text-[0.8rem] text-[#ffcf9a] underline-offset-2 hover:underline" onClick={() => onOpenMatch(e.matchId)}>
                      {new Date(e.date).toLocaleDateString()}
                    </button>
                  ) : (
                    <span className="text-[0.8rem] text-ash">{new Date(e.date).toLocaleDateString()}</span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
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

function LocalBoard() {
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

/** "Mira#K3P9Q": the tag small and dim. */
function NameTag({ name, tag }: { name: string; tag: string }) {
  return (
    <span className="font-semibold">
      {name}
      <span className="ml-0.5 text-[0.78em] font-medium text-ash/70">#{tag}</span>
    </span>
  )
}

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(Math.round(n))}`

function BoardRowView({ r, you, period }: { r: PublicBoardRow; you: boolean; period: Period }) {
  return (
    <tr className={`border-t border-[rgba(255,170,100,0.08)] ${you ? 'bg-[rgba(255,180,80,0.1)]' : ''}`} data-you={you || undefined}>
      <td className="py-2 font-bold text-ash">{r.rank}</td>
      <td className="py-2">
        <span className="flex items-center gap-2">
          <NameTag name={r.name} tag={r.tag} />
          {you && <span className="chip text-gold">You</span>}
        </span>
      </td>
      <td className="py-2 text-right text-[1.12rem] font-bold text-gold">{r.rating}</td>
      <td className={`py-2 text-right ${r.gain > 0 ? 'text-heal' : r.gain < 0 ? 'text-[#ff9b8a]' : 'text-ash'}`} title={period === 'week' ? 'Rating gained this week' : 'Above or below the starting rating'}>
        {signed(r.gain)}
      </td>
      <td className="py-2 text-right">{r.matches}</td>
      <td className="py-2 text-right">{r.wins}</td>
      <td className="py-2 text-right">
        {r.kills} / {r.deaths}
      </td>
    </tr>
  )
}

/** Casual global leaderboard of the game server (server games between people only). */
function GlobalBoard() {
  const [period, setPeriod] = useState<Period>('all')
  const [page, setPage] = useState<LeaderboardPage | null>(null)
  const [profile, setProfile] = useState<ServerProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setError(null)
    setPage(null)
    session
      .leaderboard(period)
      .then((p) => alive && setPage(p))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    session
      .serverProfile()
      .then((p) => alive && setProfile(p))
      .catch(() => alive && setProfile(null))
    return () => {
      alive = false
    }
  }, [period])
  const you = page?.you ?? null
  const isYou = (r: PublicBoardRow) => !!you && r.rank === you.rank && r.name === you.name && r.tag === you.tag
  const youListed = !!you && !!page?.entries.some(isYou)
  return (
    <div className="flex flex-col gap-3" data-testid="global-board">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[0.92rem] text-ash">Global counts games on our servers with at least 2 players for 2+ minutes. Bots never count.</p>
        <Segmented
          label="Period"
          value={period}
          options={[
            { value: 'all', label: 'All time' },
            { value: 'week', label: 'This week' },
          ]}
          onChange={setPeriod}
        />
      </div>
      {profile && (
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3 rounded-lg bg-[rgba(0,0,0,0.28)] px-4 py-3" data-testid="server-profile">
          <span className="flex flex-col">
            <span className="text-[0.8rem] font-semibold text-ash">You on {profile.region.label}</span>
            <NameTag name={profile.name} tag={profile.tag} />
          </span>
          <span className="flex flex-col">
            <span className="text-[0.8rem] font-semibold text-ash">Rating</span>
            <span className="tabular text-[1.3rem] font-bold text-gold">{profile.rating}</span>
          </span>
          <span className="flex flex-col">
            <span className="text-[0.8rem] font-semibold text-ash">Rank</span>
            <span className="tabular text-[1.3rem] font-bold">#{profile.rank}</span>
          </span>
          <span className="flex flex-col">
            <span className="text-[0.8rem] font-semibold text-ash">Matches</span>
            <span className="tabular text-[1.3rem] font-bold">
              {profile.wins}–{profile.matches - profile.wins}
            </span>
          </span>
          {profile.recent.length > 0 && (
            <ul className="flex min-w-[16rem] flex-1 flex-wrap gap-1" aria-label="Your last counted matches">
              {profile.recent.map((m) => (
                <li
                  key={m.at}
                  className={`tabular rounded px-1.5 py-0.5 text-[0.8rem] font-semibold ${m.won ? 'bg-[rgba(127,227,154,0.14)] text-heal' : 'bg-[rgba(255,106,85,0.14)] text-[#ff9b8a]'}`}
                  title={`${new Date(m.at).toLocaleString()}: ${m.won ? 'won' : 'lost'}, rounds ${m.roundsWon}/${m.roundsPlayed}, ${m.kills}/${m.deaths} K/D, rating ${m.rating}`}
                >
                  {m.won ? 'W' : 'L'} {signed(m.delta)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error ? (
        <Empty>{error}</Empty>
      ) : !page ? (
        <Empty>Loading the leaderboard…</Empty>
      ) : page.entries.length === 0 ? (
        <Empty>{period === 'week' ? 'Nobody has a counted game this week yet.' : 'No counted games yet. Play a game on our servers with a friend.'}</Empty>
      ) : (
        <table className="tabular w-full text-left text-[1.02rem]">
          <thead className="text-sm text-ash">
            <tr>
              <th className="w-12 pb-2 font-semibold">#</th>
              <th className="pb-2 font-semibold">Player</th>
              <th className="pb-2 text-right font-semibold">Rating</th>
              <th className="pb-2 text-right font-semibold">{period === 'week' ? 'This week' : 'Gain'}</th>
              <th className="pb-2 text-right font-semibold">Matches</th>
              <th className="pb-2 text-right font-semibold">Wins</th>
              <th className="pb-2 text-right font-semibold">K / D</th>
            </tr>
          </thead>
          <tbody>
            {page.entries.map((r) => (
              <BoardRowView key={`${r.rank}:${r.name}:${r.tag}`} r={r} you={isYou(r)} period={period} />
            ))}
            {you && !youListed && (
              <>
                <tr aria-hidden>
                  <td colSpan={7} className="py-1 text-center text-ash">
                    ⋯
                  </td>
                </tr>
                <BoardRowView r={you} you period={period} />
              </>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Leaderboard: this device's local ratings, or (server builds) the global casual board. */
function Board() {
  const [scope, setScope] = useState<'device' | 'global'>('device')
  return (
    <div className="flex flex-col gap-3">
      {online.configured && (
        <Segmented
          label="Leaderboard"
          value={scope}
          options={[
            { value: 'device', label: 'This device' },
            { value: 'global', label: 'Global' },
          ]}
          onChange={setScope}
        />
      )}
      {scope === 'global' && online.configured ? <GlobalBoard /> : <LocalBoard />}
    </div>
  )
}

export function Profile({ onBack }: { onBack: () => void }) {
  const career = useStats(readCareer)
  const name = useGame((s) => s.settings.playerName)
  const [draft, setDraft] = useState(name)
  const [tab, setTab] = useState<Tab>('matches')
  const [openMatch, setOpenMatch] = useState<string | null>(null)

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
    { id: 'stats', label: 'Stats' },
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

      <section className="panel panel-solid flex min-h-0 flex-1 flex-col p-5">
        <div className="mb-3 flex gap-1" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {tab === 'matches' && <Matches openId={openMatch} onOpen={setOpenMatch} />}
          {tab === 'stats' && (
            <StatsTab
              career={c}
              onOpenMatch={(id) => {
                setOpenMatch(id)
                setTab('matches')
              }}
            />
          )}
          {tab === 'rivals' && <Rivals />}
          {tab === 'board' && <Board />}
        </div>
      </section>
    </div>
  )
}
