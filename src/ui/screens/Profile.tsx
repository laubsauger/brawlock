import { FeedbackButton } from '../FeedbackButton'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { getHallOfFame, getMatchHistory, mergeRecordedDetail, recordedProfileStats, type Career, type CareerTotals, type Encounter, type HallOfFameKey, type MatchRecord, type RecordedProfileCoverage, type RecordedProfileDetail } from '../../game/stats'
import { getProfile } from '../../game/profile'
import { Sigil } from '../icons'
import { displayName } from '../data/catalog'
import { percent, ratingTrend, seconds, tiles } from '../lib/statFormat'
import { AwardsStrip, PlayerStatsDetail } from './statViews'
import { useGame } from '../../game/store'
import { Button, Kbd, Modal, Segmented } from '../widgets'
import { online, session, type LeaderboardPage, type Period, type PublicBoardRow, type ServerProfile } from '../../game/session'
import { hex } from '../lib/view'
import { ago, duration, readCareer, readEncounterList, readHistory, readLeaderboard, useStats } from '../lib/stats'
import { exportReplay, importReplay, useReplayIds, watchReplay } from '../lib/replays'
import { REPLAY_EXT, type ReplayMeta } from '../../game/replay/format'
import { replays } from '../../game/replay/store'
import { chooseName, NAME_MAX } from '../lib/name'
import { historyEloLabel } from '../lib/elo'
import { accountsEnabled } from '../../game/account'
import { Collection, MatchEmbers } from './Collection'
import { BuildIcons } from '../BuildIcons'
import { MatchQueueTabs, ServerMatches, type MatchQueueFilter } from './ServerMatches'

type Tab = 'matches' | 'stats' | 'rivals' | 'board' | 'replays'

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
        aria-label="Import replay file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void importReplay(f)
        }}
      />
      <Button size="sm" onClick={() => ref.current?.click()}>Import replay <span className="font-ui text-xs text-ash">{REPLAY_EXT}</span></Button>
    </div>
  )
}

/** Includes imported files even when they have no match-history record on this device. */
function Replays() {
  const [library, setLibrary] = useState<ReplayMeta[] | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void replays.list().then((list) => { if (live) setLibrary(list) })
    load()
    const off = replays.onChange(load)
    return () => { live = false; off() }
  }, [])
  return <div className="flex flex-col gap-3" data-testid="replay-library">
    <ImportReplay />
    {library === null ? <Empty>Loading saved replays…</Empty>
      : library.length === 0 ? <Empty>No saved replays yet. Import a shared {REPLAY_EXT} file, or finish a match to save one here.</Empty>
        : <ul className="flex flex-col gap-2">{library.map((replay) => <li key={replay.id} className="flex flex-wrap items-center justify-between gap-3 rounded bg-black/25 px-3 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="break-words font-semibold">{replay.players.map((player) => player.name).join(' · ')}</span>
            <span className="text-sm text-ash">{ago(replay.date)} · {duration(replay.durationSec)} · {replay.rounds} {replay.rounds === 1 ? 'round' : 'rounds'}</span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => void watchReplay(replay.id)}>Watch</Button>
            <Button size="sm" variant="ghost" onClick={() => void exportReplay(replay.id)}>Export</Button>
          </div>
        </li>)}</ul>}
  </div>
}

/**
 * The whole table of one past match: every player's score, knockouts, deaths, damage and gold,
 * best first; a row opens that player's detailed stats when they were stored.
 */
export function MatchScoreboard({ r }: { r: MatchRecord }) {
  const [open, setOpen] = useState<number | null>(null)
  const rows = [...r.participants].sort((a, b) => b.score - a.score || b.kills - a.kills || b.damage - a.damage)
  return (
    <table className="w-full text-[0.9rem]" aria-label="Final standings">
      <thead>
        <tr className="text-left text-[0.72rem] uppercase tracking-wider text-ash">
          <th className="py-1 pl-6 font-semibold">Player</th>
          <th className="py-1 text-right font-semibold">Score</th>
          <th className="py-1 text-right font-semibold" title="Knockouts / deaths">K / D</th>
          <th className="py-1 text-right font-semibold">Damage</th>
          <th className="py-1 pr-1 text-right font-semibold" title="Gold earned this match">Gold</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const expanded = open === p.player
          return (
            <Fragment key={p.player}>
              <tr className="border-t border-white/5">
                <td className="py-1">
                  <span className="flex items-center gap-1.5">
                    {p.stats || p.build ? (
                      <button type="button" className="row-toggle" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} ${p.name}'s match details`} onClick={() => setOpen(expanded ? null : p.player)}>
                        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
                      </button>
                    ) : <span className="w-5" aria-hidden />}
                    <span className="h-2.5 w-2.5 rotate-45 rounded-[1px]" style={{ background: hex(p.color) }} aria-hidden />
                    <span className={`font-semibold ${p.player === r.self ? 'text-gold' : 'text-bone'}`}>{p.name}</span>
                    {p.player === r.self && <span className="text-[0.75rem] text-ash">(you)</span>}
                    {p.kind === 'bot' && <span className="text-[0.75rem] text-ash">bot</span>}
                    {p.won && <span className="text-[0.75rem] text-heal">won</span>}
                  </span>
                </td>
                <td className="tabular py-1 text-right">{p.score}</td>
                <td className="tabular py-1 text-right">{p.kills} / {p.deaths}</td>
                <td className="tabular py-1 text-right">{Math.round(p.damage).toLocaleString()}</td>
                <td className="tabular py-1 pr-1 text-right">{p.stats ? p.stats.goldEarned : '–'}</td>
              </tr>
              {expanded && (p.stats || p.build) && (
                <tr><td colSpan={5} className="pb-2 pl-6">
                  {p.build && <div className="mb-3 mt-2" aria-label={`${p.name}'s recorded equipment`}><BuildIcons kit={p.build} size={26} /></div>}
                  {p.stats && <PlayerStatsDetail stats={p.stats} />}
                </td></tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function Matches({ openId, onOpen, source, onSource }: { openId: string | null; onOpen: (id: string | null) => void; source: 'online' | 'device'; onSource: (source: 'online' | 'device') => void }) {
  const [queue, setQueue] = useState<MatchQueueFilter>('all')
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      {online.configured && <Segmented label="Match history source" value={source} onChange={onSource} options={[{ value: 'online', label: 'Online' }, { value: 'device', label: 'This device' }]} />}
      <MatchQueueTabs value={queue} onChange={setQueue} />
    </div>
    {source === 'online' ? <ServerMatches queue={queue} /> : <LocalMatches key={queue} queue={queue} openId={openId} onOpen={onOpen} />}
  </div>
}

function LocalMatches({ openId, onOpen, queue }: { openId: string | null; onOpen: (id: string | null) => void; queue: MatchQueueFilter }) {
  const stored = useStats(readHistory)
  const history = queue === 'all' ? stored : stored.filter((match) => match.queue === queue)
  const [collectionOpen, setCollectionOpen] = useState(false)
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
        <Empty>{stored.length === 0 ? 'No matches yet. Play against bots or host a game; every match lands here.' : `No ${queue} matches recorded on this device.`}</Empty>
      </>
    )
  return (
    <>
    <ImportReplay />
    <p className="text-sm text-ash">Saved on this device.{queue === 'all' && stored.some((match) => !match.queue) && ' Earlier matches without a recorded queue appear in All.'}</p>
    <ul className="flex flex-col gap-1.5">
      {history.map((r) => {
        const me = r.participants.find((p) => p.player === r.self)
        const win = r.outcome === 'win'
        const others = [...r.participants].sort((a, b) => b.score - a.score)
        const open = openId === r.id
        const elo = historyEloLabel(r)
        const detail = r.participants.length > 0
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
              <span className={`chip px-2 py-0.5 text-[0.68rem] ${elo.tone}`} title={elo.title} aria-label={`${elo.label}: ${elo.title}`}>{elo.label}</span>
              <span className="text-xs text-ash">{r.queue === 'ranked' ? 'Ranked' : r.queue === 'casual' ? 'Casual' : r.queue === 'custom' ? 'Custom' : r.queue === 'offline' ? 'Offline' : 'Queue not recorded'}</span>
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
                {elo.title && <p className="text-[0.85rem] leading-snug text-ash">{elo.title}</p>}
                <MatchScoreboard r={r} />
                {r.awards && r.awards.length > 0 && <AwardsStrip awards={r.awards} who={who} compact />}
                {accountsEnabled && r.progression && <MatchEmbers progression={r.progression} onCollection={() => setCollectionOpen(true)} />}
                {me?.stats ? <PlayerStatsDetail stats={me.stats} /> : <p className="text-[0.9rem] text-ash">No detailed stats are stored for this match.</p>}
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
    {collectionOpen && <Collection onClose={() => setCollectionOpen(false)} />}
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
      <RecordedStatsGroups totals={t} kills={career.kills} damage={career.damage} spells={spells} spellCaption={spells.matches === 1 ? 'from your last match' : `from your last ${spells.matches} matches`} hall={hall} matchIds={ids} onOpenMatch={onOpenMatch} />
    </div>
  )
}

function RecordedStatsGroups({ totals: t, kills, damage, spells, spellCaption, hall, matchIds, onOpenMatch }: {
  totals: CareerTotals; kills: number; damage: number
  spells: { list: [string, [number, number]][]; matches: number }; spellCaption: string
  hall: Career['hallOfFame']; matchIds?: ReadonlySet<string>; onOpenMatch?: (id: string) => void
}) {
  const lavaDeaths = t.deathsByCause.lava ?? 0
  return <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Group title="Movement">
          <Fact label="Walked" value={tiles(t.walked)} />
          <Fact label="Pushed around" value={tiles(t.pushed)} />
          <Fact label="Teleported" value={tiles(t.teleported)} />
        </Group>
        <Group title="Combat">
          <Fact label="Kills" value={kills.toLocaleString()} />
          <Fact label="Damage dealt" value={Math.round(damage).toLocaleString()} />
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
            <span className="ml-1 font-ui text-[0.8rem] font-medium tracking-normal text-ash">{spellCaption}</span>
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
          <p className="text-[0.9rem] text-ash">No personal bests in the recorded matches.</p>
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
                  {onOpenMatch && matchIds?.has(e.matchId) ? (
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
  </>
}

/** The same counter definitions for covered server matches and retained local records.
 * `activity` (server only): the human-controlled part of unfinished or partly played ranked
 * games, added into the same totals; match counts and results stay complete matches only. */
export function DetailedProfileStats({ coverage, detail, activity = null, source }: { coverage: RecordedProfileCoverage; detail: RecordedProfileDetail | null; activity?: RecordedProfileDetail | null; source: 'server' | 'device' }) {
  const shown = mergeRecordedDetail(detail, activity)
  const partial = activity?.matches ?? 0
  const complete = detail?.matches ?? 0
  const spells: { list: [string, [number, number]][]; matches: number } = {
    list: shown ? Object.entries(shown.spells).filter(([, [casts]]) => casts > 0).sort((a, b) => b[1][0] - a[1][0]) : [],
    matches: coverage.detailedMatches,
  }
  const games = (n: number) => `${n} ${n === 1 ? 'game' : 'games'}`
  return <div className="flex flex-col gap-5" data-testid="recorded-profile-stats">
    <div className="rounded border border-white/10 bg-black/20 px-3 py-2 text-sm">
      <p className="font-semibold text-bone">{source === 'server' ? 'Recorded by the game server' : 'Recorded on this device'}</p>
      <p className="mt-1 text-ash">{coverage.detailedMatches} of {coverage.totalMatches} {source === 'server' ? 'ranked' : 'stored'} matches have detailed stats.{partial > 0 && ` The totals also include the human-controlled part of ${games(partial)} left unfinished or partly played.`}</p>
      <p className="mt-1 text-xs text-ash">{source === 'server'
        ? 'Complete ranked matches played as a human from start to finish, plus the time a human controlled the seat in aborted, unrated or partly played ranked games (those add no result, Elo or Embers). These combat details include bots; ranked K/D excludes bot combat. Earlier matches have results only.'
        : 'Only retained match records are included, with details kept for the latest 30 matches on this device. These are observed match stats, including bot combat.'}</p>
    </div>
    {!shown ? <p className="text-sm text-ash">No detailed stats are available in this coverage yet.</p> : <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Detailed matches" value={String(complete)} sub={partial > 0 ? `+ ${partial} partial` : undefined} />
        <Tile label="Recorded match time" value={duration(shown.seconds)} />
        <Tile label="Damage dealt" value={Math.round(shown.damage).toLocaleString()} />
        <Tile label="Accuracy" value={percent(shown.totals.casts ? shown.totals.hits / shown.totals.casts : null)} />
      </div>
      <RecordedStatsGroups totals={shown.totals} kills={Object.values(shown.totals.killsByCause).reduce((a, b) => a + b, 0)} damage={shown.damage} spells={spells}
        spellCaption={partial > 0 ? `from ${complete} complete and ${partial} partial ${partial + complete === 1 ? 'game' : 'games'}` : `from ${complete} recorded ${complete === 1 ? 'match' : 'matches'}`} hall={shown.hallOfFame} />
    </>}
  </div>
}

function DeviceProfile({ player, onClose, encounter }: { player: { profileId: string; name: string; kind: 'human' | 'bot' }; onClose: () => void; encounter?: Encounter }) {
  const history = useStats(readAllHistory)
  const recorded = useMemo(() => recordedProfileStats(history, player.profileId), [history, player.profileId])
  return createPortal(<Modal title={player.name} onClose={onClose} width="max-w-4xl" className="h-[min(760px,92dvh)]">
    <p className="mb-4 text-sm text-ash">{encounter && <>Your head-to-head record: {encounter.wins} wins · {encounter.losses} losses · {encounter.games} encounters. </>}{player.kind === 'bot' ? 'Bots are grouped by difficulty. Matches with multiple bots in that group cannot be attributed to an individual and are omitted below.' : 'Local records are separate from a public ranked profile.'}</p>
    <DetailedProfileStats {...recorded} source="device" />
  </Modal>, document.body)
}

function PublicProfile({ publicId, name, onClose }: { publicId: string; name: string; onClose: () => void }) {
  const [profile, setProfile] = useState<ServerProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (!publicId) {
      setLoading(false)
      setError('This leaderboard entry is missing its public profile ID. Refresh the leaderboard.')
      return
    }
    void session.publicProfile(publicId).then((value) => {
      if (!alive) return
      setProfile(value)
      setLoading(false)
    }).catch((cause: unknown) => {
      if (!alive) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoading(false)
    })
    return () => { alive = false }
  }, [publicId])
  return createPortal(<Modal title={profile ? `${profile.name}#${profile.tag}` : name} onClose={onClose} width="max-w-4xl" className="h-[min(760px,92dvh)]">
    {error ? <p role="alert" className="text-[#ffb08a]">{error}</p> : loading ? <p role="status" className="text-ash">Loading public profile…</p> : !profile ? <p className="text-ash">This public profile is no longer available.</p> : <>
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Ranked results">
        <Tile label="Global Elo" value={String(profile.rating)} sub={`Rank #${profile.rank}`} />
        <div className="well flex flex-col px-4 py-3"><span className="text-sm text-ash">Last 7 days</span><EloChange7d change={profile.ratingChange7d} /></div>
        <Tile label="Ranked matches" value={String(profile.matches)} sub={`${profile.wins} wins`} />
        <Tile label="Ranked K / D" value={`${profile.kills} / ${profile.deaths}`} sub="Bot combat excluded" />
      </div>
      <section className="mb-5 flex flex-col gap-3" aria-label="Recent online matches">
        <h3 className="section-title text-lg">Recent matches</h3>
        <ServerMatches publicId={publicId} />
      </section>
      {!profile.coverage || profile.detail === undefined ? <p role="alert" className="text-[#ffb08a]">The server returned incomplete profile details. Refresh and try again.</p> : <DetailedProfileStats coverage={profile.coverage} detail={profile.detail} activity={profile.activity ?? null} source="server" />}
    </>}
  </Modal>, document.body)
}

function Rivals() {
  const list = useStats(readEncounterList)
  const [selected, setSelected] = useState<Encounter | null>(null)
  if (list.length === 0) return <Empty>Everyone you play against shows up here, with your record against them.</Empty>
  const sorted = [...list].sort((a, b) => b.lastSeen - a.lastSeen)
  return (
    <><table className="tabular w-full text-left text-[1.02rem]">
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
                <button type="button" className="rounded font-semibold text-left underline-offset-2 hover:text-gold hover:underline focus-visible:outline-2 focus-visible:outline-gold" onClick={() => setSelected(e)} aria-label={`View recorded stats for ${e.lastName}`}>{e.lastName}</button>
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
    {selected && <DeviceProfile player={{ profileId: selected.profileId, name: selected.lastName, kind: selected.kind }} encounter={selected} onClose={() => setSelected(null)} />}</>
  )
}

function LocalBoard() {
  const rows = useStats(readLeaderboard)
  const [selected, setSelected] = useState<(typeof rows)[number] | null>(null)
  return (
    <div>
      <p className="mb-3 text-[0.98rem] text-ash">
        Players you have played, rated from matches saved on this device.{online.configured && ' Choose Global for the dedicated-server standings.'}
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
                    <button type="button" className="rounded text-left font-semibold underline-offset-2 hover:text-gold hover:underline focus-visible:outline-2 focus-visible:outline-gold" aria-label={`View recorded stats for ${r.name}`} onClick={() => setSelected(r)}>{r.name}</button>
                    {r.self && <span className="chip text-gold">You</span>}
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
      {selected && <DeviceProfile player={selected} onClose={() => setSelected(null)} />}
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

/** Counted global Elo movement, measured over a rolling seven-day window. */
export function EloChange7d({ change }: { change: number }) {
  const value = change === 0 ? '0' : signed(change)
  return <span
    className={`whitespace-nowrap text-[0.76rem] font-semibold ${change > 0 ? 'text-heal' : change < 0 ? 'text-[#ff9b8a]' : 'text-ash'}`}
    title="Net Elo change over the last 7 days"
    aria-label={`${value} Elo over the last 7 days`}
  >{value} <span className="text-[0.68rem] font-normal opacity-75">7d</span></span>
}

function BoardRowView({ r, you, period, onOpen }: { r: PublicBoardRow; you: boolean; period: Period; onOpen: (row: PublicBoardRow) => void }) {
  return (
    <tr className={`border-t border-[rgba(255,170,100,0.08)] ${you ? 'bg-[rgba(255,180,80,0.1)]' : ''}`} data-you={you || undefined}>
      <td className="py-2 font-bold text-ash">{r.rank}</td>
      <td className="py-2">
        <span className="flex items-center gap-2">
          <button type="button" className="rounded text-left underline-offset-2 hover:text-gold hover:underline focus-visible:outline-2 focus-visible:outline-gold" onClick={() => onOpen(r)} aria-label={`View public profile for ${r.name}#${r.tag}`}><NameTag name={r.name} tag={r.tag} /></button>
          {you && <span className="chip text-gold">You</span>}
        </span>
      </td>
      <td className="py-2 text-right"><span className="inline-flex items-baseline justify-end gap-2"><span className="text-[1.12rem] font-bold text-gold">{r.rating}</span><EloChange7d change={r.ratingChange7d} /></span></td>
      <td className={`py-2 text-right ${r.gain > 0 ? 'text-heal' : r.gain < 0 ? 'text-[#ff9b8a]' : 'text-ash'}`} title={period === 'week' ? 'Rating gained over the last 7 days' : 'Above or below the starting rating'}>
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

/** Global leaderboard of completed eligible ranked games. */
function GlobalBoard() {
  const [period, setPeriod] = useState<Period>('all')
  const [page, setPage] = useState<LeaderboardPage | null>(null)
  const [profile, setProfile] = useState<ServerProfile | null>(null)
  const [selected, setSelected] = useState<PublicBoardRow | null>(null)
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
  const isYou = (r: PublicBoardRow) => !!you && r.publicId === you.publicId
  const youListed = !!you && !!page?.entries.some(isYou)
  return (
    <div className="flex flex-col gap-3" data-testid="global-board">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[0.92rem] text-ash">Ranked games count with at least 2 human players for 2+ minutes. Your Elo is shared across regions. Bots never count.</p>
        <Segmented
          label="Period"
          value={period}
          options={[
            { value: 'all', label: 'All time' },
            { value: 'week', label: 'Last 7 days' },
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
            <span className="inline-flex items-baseline gap-2"><span className="tabular text-[1.3rem] font-bold text-gold">{profile.rating}</span><EloChange7d change={profile.ratingChange7d} /></span>
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
        <Empty>{period === 'week' ? 'Nobody has a counted game in the last 7 days yet.' : 'No counted games yet. Play a game on our servers with a friend.'}</Empty>
      ) : (
        <table className="tabular w-full text-left text-[1.02rem]">
          <thead className="text-sm text-ash">
            <tr>
              <th className="w-12 pb-2 font-semibold">#</th>
              <th className="pb-2 font-semibold">Player</th>
              <th className="pb-2 text-right font-semibold">Rating</th>
              <th className="pb-2 text-right font-semibold">{period === 'week' ? 'Last 7 days' : 'Gain'}</th>
              <th className="pb-2 text-right font-semibold">Matches</th>
              <th className="pb-2 text-right font-semibold">Wins</th>
              <th className="pb-2 text-right font-semibold">K / D</th>
            </tr>
          </thead>
          <tbody>
            {page.entries.map((r) => (
              <BoardRowView key={r.publicId} r={r} you={isYou(r)} period={period} onOpen={setSelected} />
            ))}
            {you && !youListed && (
              <>
                <tr aria-hidden>
                  <td colSpan={7} className="py-1 text-center text-ash">
                    ⋯
                  </td>
                </tr>
                <BoardRowView r={you} you period={period} onOpen={setSelected} />
              </>
            )}
          </tbody>
        </table>
      )}
      {selected && <PublicProfile key={selected.publicId} publicId={selected.publicId} name={selected.name} onClose={() => setSelected(null)} />}
    </div>
  )
}

/** Leaderboard: this device's local ratings, or (server builds) the global casual board. */
function Board({ initialScope = 'device' }: { initialScope?: 'device' | 'global' }) {
  const [scope, setScope] = useState<'device' | 'global'>(initialScope)
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

export function Profile({ onBack, initialTab = 'matches', initialBoardScope = 'device' }: { onBack: () => void; initialTab?: Tab; initialBoardScope?: 'device' | 'global' }) {
  const career = useStats(readCareer)
  const name = useGame((s) => s.settings.playerName)
  const [draft, setDraft] = useState(name)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [openMatch, setOpenMatch] = useState<string | null>(null)
  const [matchSource, setMatchSource] = useState<'online' | 'device'>(online.configured ? 'online' : 'device')

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
    { id: 'replays', label: 'Replays' },
  ]

  return (
    <div className="screen-in mx-auto flex h-full w-full max-w-[1440px] flex-col px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-5">
          <h1 className="display text-6xl leading-none text-[#ffd890]">{tab === 'replays' ? 'Watch replay' : tab === 'board' ? 'Leaderboards' : 'Your record'}</h1>
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
        <div className="flex flex-wrap items-center gap-2">
          <FeedbackButton />
          <Button sound="back" onClick={onBack}>
            Back <Kbd>Esc</Kbd>
          </Button>
        </div>
      </header>

      <section data-testid="profile-panel" className="panel panel-solid flex min-h-0 flex-1 flex-col p-5">
        <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Profile sections">
          {tabs.map((t) => (
            <button key={t.id} id={`profile-tab-${t.id}`} type="button" role="tab" aria-controls="profile-content" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {/* The rotated 9px title marker and its 6px glow need 8px of paint room
            inside this scrollport; equal padding keeps the content aligned. */}
        <div id="profile-content" role="tabpanel" aria-labelledby={`profile-tab-${tab}`} className="-ml-2 min-h-0 flex-1 overflow-y-auto pl-2 pr-1">
          {(tab === 'stats' || (tab === 'matches' && matchSource === 'device')) && <div role="group" aria-label="Career summary" className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
            <Tile label="Matches" value={String(c?.games ?? 0)} />
            <Tile label="Wins" value={String(c?.wins ?? 0)} sub={c ? `${pct(c.wins, c.games)} win rate` : undefined} />
            <Tile label="Kills / deaths" value={kd} sub={c ? `${c.kills} / ${c.deaths}` : undefined} />
            <Tile label="Damage dealt" value={c ? Math.round(c.damage).toLocaleString() : '0'} />
            <Tile label="Win streak" value={String(c?.winStreak ?? 0)} sub={c ? `best ${c.bestWinStreak}` : undefined} />
            <Tile label="Time in the arena" value={c ? duration(c.seconds) : '0:00'} sub={c ? `${c.rounds} rounds` : undefined} />
            <Tile label="Against players" value={c ? `${c.vsHumans.wins}–${c.vsHumans.games - c.vsHumans.wins}` : '–'} sub={c ? pct(c.vsHumans.wins, c.vsHumans.games) : undefined} />
            <Tile label="Against bots" value={c ? `${c.vsBots.wins}–${c.vsBots.games - c.vsBots.wins}` : '–'} sub={c ? pct(c.vsBots.wins, c.vsBots.games) : undefined} />
          </div>}
          {tab === 'matches' && <Matches openId={openMatch} onOpen={setOpenMatch} source={matchSource} onSource={setMatchSource} />}
          {tab === 'stats' && (
            <StatsTab
              career={c}
              onOpenMatch={(id) => {
                setOpenMatch(id)
                setMatchSource('device')
                setTab('matches')
              }}
            />
          )}
          {tab === 'rivals' && <Rivals />}
          {tab === 'board' && <Board initialScope={initialBoardScope} />}
          {tab === 'replays' && <Replays />}
        </div>
      </section>
    </div>
  )
}
