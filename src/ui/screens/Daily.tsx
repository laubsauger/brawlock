import { useEffect, useMemo, useState } from 'react'
import { accountsEnabled } from '../../game/account'
import { dayOf, defineDay, DAY_MS, type DailyBot, type DailyDay } from '../../game/daily/calendar'
import { claimRun, dailyOnline, fetchDaily, fetchRun, type DailyBoardRow, type DailySummary, type DailyVerified } from '../../game/daily/client'
import { playDaily, retryPending, useDaily, type DailyOutcome } from '../../game/daily/play'
import { BOUNTY_MAX, BOUNTY_SECONDS, CHAMPION_COLOR, DAILY_HZ, DAILY_LIVES, dayBuild } from '../../game/daily/run'
import { browserId, getProfile } from '../../game/profile'
import { dailyReplay } from '../../game/daily/watch'
import { BUILD_NET_ID } from '../../game/replay/viewer'
import { localEquipment } from '../../game/wardrobe'
import { watchReplayData } from '../lib/replays'
import { toast } from '../lib/toast'
import { useGame } from '../../game/store'
import { Sigil } from '../icons'
import { displayName } from '../data/catalog'
import { Button } from '../widgets'
import { WardrobeStage } from '../../render/WardrobeStage'
import { reducedMotion } from '../lib/motion'

/** m:ss.t from daily ticks */
export function dailyTime(ticks: number): string {
  const s = Math.max(0, ticks) / DAILY_HZ
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
const bot = (b: DailyBot) => `${b.name} (${cap(b.tier)})`

/** "Brawlock Daily #12 · Blood Moon over Rook / ■■■■□ Wave 4 · 3:12.6 · 4th of 11 / site" */
export function shareText(day: DailyDay, waves: number, time: number, verified: DailyVerified | undefined): string {
  const squares = Array.from({ length: day.waves.length }, (_, i) => (i < waves ? '■' : '□')).join('')
  const rank = verified?.rank ? ` · ${ordinal(verified.rank)} of ${verified.players}` : ''
  return `Brawlock Daily #${day.number} · ${day.name}\n${squares} Wave ${waves} · ${dailyTime(time)}${rank}\nbrawlock.osc.link`
}

/** Replay your own last run from its tape. */
function watchOwn(outcome: DailyOutcome): void {
  if (!outcome.watch) return
  const profile = getProfile()
  const d = dailyReplay({ day: outcome.day.day, salt: outcome.watch.salt, tape: outcome.watch.tape, id: outcome.attempt ?? `daily-${outcome.day.day}`, date: Date.now(), netId: BUILD_NET_ID,
    player: { name: profile.name, color: profile.color ?? 0xff7700, cosmetics: localEquipment() ?? undefined } })
  if (d) watchReplayData(d)
  else toast('That run cannot be replayed.', 'warn')
}

/** Replay a top-ten run from the board (the service hands over its tape). */
async function watchRow(row: DailyBoardRow): Promise<void> {
  const r = await fetchRun(row.attempt)
  if (r.status === 'build') return void toast('That run was played on another version of the game.', 'warn')
  if (r.status !== 'ok') return void toast('That run is not available to watch.', 'warn')
  const d = dailyReplay({ day: r.day, salt: r.salt, tape: r.tape, id: row.attempt, date: Date.now(), netId: BUILD_NET_ID, player: { name: row.name ?? 'Warlock', color: 0xff7700 } })
  if (d) watchReplayData(d)
  else toast('That run cannot be replayed.', 'warn')
}

/** The result of the last run (spec: pending, then verified or why not). */
export function DailyResult({ outcome, onClaim }: { outcome: DailyOutcome; onClaim?: () => void }) {
  const { result, state, verified } = outcome
  const waves = verified?.waves ?? result.waves
  const time = verified?.time ?? result.timeTicks
  const [copied, setCopied] = useState(false)
  const status =
    state === 'pending' ? 'Verifying…'
      : state === 'retry' ? 'Waiting to post this run…'
      : state === 'verified' ? verified?.listed ? `Verified · ${verified.rank ? `${ordinal(verified.rank)} of ${verified.players} today` : 'on the board'}` : `Verified · would place ${verified?.rank ? ordinal(verified.rank) : '–'} of ${verified?.players ?? 0}`
      : state === 'rejected' ? `This run could not be verified${outcome.code ? ` (${outcome.code})` : ''}`
      : state === 'offline' ? 'Offline · not on the board'
      : outcome.code === 'cap' ? 'Practice · today’s ranked attempts are used up'
      : outcome.code === 'update' ? 'Practice · update the game to post scores'
      : 'Practice · not on the board'
  return (
    <section className="panel w-full p-5" data-testid="daily-result" data-state={state} aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-sm tracking-[0.18em] text-ash uppercase">Your run</p>
          <p className="wordmark text-[clamp(1.8rem,5vh,2.8rem)] leading-none" data-waves={waves}>
            Wave {waves} · {dailyTime(time)}
          </p>
        </div>
        <div className="text-right">
          <p className="font-semibold text-[#f0d9b8]">{status}</p>
          {verified?.reward && (
            <p className="text-[#ffcf7a]" data-testid="daily-reward">
              +{verified.reward.embers} Embers · Day {verified.reward.day}
            </p>
          )}
          {result.bountyKos > 0 && <p className="text-sm text-ash">{Math.min(BOUNTY_MAX, result.bountyKos)} bounty knockouts · −{Math.min(BOUNTY_MAX, result.bountyKos) * BOUNTY_SECONDS} s</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {outcome.watch && (
          <Button size="sm" onClick={() => watchOwn(outcome)} data-testid="daily-watch-own">
            Watch your run
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => {
          void navigator.clipboard?.writeText(shareText(outcome.day, waves, time, verified)).then(() => setCopied(true), () => {})
        }}>
          {copied ? 'Copied' : 'Share'}
        </Button>
        {state === 'verified' && verified && !verified.listed && onClaim && (
          <Button size="sm" onClick={onClaim} data-testid="daily-claim">
            Sign in to post this run
          </Button>
        )}
      </div>
    </section>
  )
}

/** The week strip: seven squares filled by waves cleared; the seventh day of a streak carries 75. */
function Week({ you }: { you: NonNullable<DailySummary['you']> }) {
  return (
    <div className="flex items-end gap-1.5" aria-label={`Streak: ${you.streak.count} days`}>
      {you.week.map((d) => (
        <span key={d.day} className="daily-day" data-waves={d.waves ?? undefined} title={d.waves === null ? 'Not played' : `Wave ${d.waves}`}>
          {d.waves ?? ''}
        </span>
      ))}
      <span className="ml-2 text-sm text-[#ffb35c]" data-smoulder={you.streak.smoulder || undefined}>
        {you.streak.count > 0 ? `${you.streak.smoulder ? 'Smouldering · ' : ''}${you.streak.count}-day streak` : 'No streak yet'}
        {you.streak.nextReward > 0 && ` · next ${you.streak.nextReward} Embers`}
      </span>
    </div>
  )
}

/**
 * The daily Gauntlet (docs/moonshot/specs/daily.md): today's champion, omen, waves and bounty,
 * the board, and Play. The last run's result sits on top.
 */
export function Daily() {
  const outcome = useDaily((s) => s.outcome)
  const setScreen = useGame((s) => s.setScreen)
  const [summary, setSummary] = useState<DailySummary | null>(null)
  const [view, setView] = useState<'best' | 'first' | 'yesterday'>('best')
  const [starting, setStarting] = useState(false)
  const device = useMemo(() => browserId(), [])
  const outcomeState = outcome?.state

  useEffect(() => {
    retryPending()
  }, [])
  useEffect(() => {
    let live = true
    const today = summary?.day
    void fetchDaily(device, view === 'first' ? 'first' : 'best', view === 'yesterday' && today !== undefined ? today - 1 : undefined).then((s) => {
      if (live && s) setSummary((prev) => (view === 'yesterday' && prev ? { ...prev, board: s.board } : s))
    })
    return () => { live = false }
    // refetch when a verification lands, so the board and the streak include it
  }, [device, view, outcomeState])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setScreen('menu')
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setScreen])

  const offset = summary ? summary.serverNow - Date.now() : 0
  const today = summary?.day ?? dayOf(Date.now())
  const day = useMemo(() => defineDay(today), [today])
  const champOutfit = useMemo(() => { const c = day.champion.cosmetics; return { head: c.head, back: c.back, robe: c.robe, emblem: c.emblem, staff: c.staff } }, [day])
  const champSpells = useMemo(() => [...new Set(dayBuild(day, day.waves[day.waves.length - 1][0]).steps.filter((st) => st.kind === 'spell').map((st) => st.id))], [day])
  const hoursLeft = Math.max(0, ((today + 1) * DAY_MS - (Date.now() + offset)) / 3_600_000)
  const you = summary?.you ?? null
  const playState = !dailyOnline ? 'offline' : !you || you.attempts === 0 ? 'fresh' : you.ranked > 0 ? 'played' : 'unranked'
  const play = async () => {
    setStarting(true)
    await playDaily(offset)
    setStarting(false)
  }
  const claim = outcome?.attempt && accountsEnabled
    ? async () => {
      const r = await claimRun(outcome.attempt!, device)
      if (r) useDaily.setState({ outcome: { ...outcome, verified: r } })
    }
    : undefined

  return (
    <div className="screen-in flex h-full flex-col items-center overflow-y-auto px-4 py-4 lg:px-8">
      <div className="flex w-full max-w-5xl flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm tracking-[0.2em] text-ash uppercase">Daily #{day.number}</p>
            <h1 className="wordmark text-[clamp(2rem,6vh,3.4rem)] leading-tight">{day.name}</h1>
            <p className="text-[#f0d9b8]">{day.omen.flavour}</p>
          </div>
          <Button sound="back" variant="ghost" onClick={() => setScreen('menu')}>
            Back
          </Button>
        </div>

        {outcome && outcome.day.day === day.day && <DailyResult outcome={outcome} onClaim={claim} />}

        <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <section className="panel flex flex-col gap-3 p-5">
            <div className="flex items-stretch gap-4">
              <div className="relative h-44 w-36 shrink-0 overflow-hidden rounded-md border border-[#d23cff]/25" data-testid="daily-champion-stage">
                <WardrobeStage className="absolute inset-0" color={CHAMPION_COLOR} outfit={champOutfit} view="full" autoTurn={reducedMotion() ? 0 : 0.45} />
              </div>
              <div className="min-w-0">
                <h2 className="section-title">The champion</h2>
                <p className="text-xl font-semibold text-[#e7b5ff]">{day.champion.name}</p>
                <p className="text-ash">{day.champion.line} · {cap(day.champion.tier)} · {cap(day.waves[4][0].build)} build</p>
                <div className="mt-2 flex flex-wrap gap-1" aria-label="Champion spells">
                  {champSpells.map((id) => <span key={id} title={displayName(id)}><Sigil id={id} size={28} /></span>)}
                </div>
              </div>
            </div>
            <div>
              <h2 className="section-title">Five waves · {DAILY_LIVES} lives</h2>
              <ol className="text-[0.98rem] leading-relaxed" data-testid="daily-waves">
                {day.waves.map((w, i) => (
                  <li key={i}>
                    <span className="text-ash">Wave {i + 1} ·</span> {w.map(bot).join(' and ')}
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex items-center gap-3">
              <Sigil id={day.bounty} size={40} />
              <p>
                <b>Bounty: {displayName(day.bounty)}.</b> Each knockout it causes takes {BOUNTY_SECONDS} s off your time ({BOUNTY_MAX} at most).
              </p>
            </div>
            {you && <Week you={you} />}
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <Button variant="primary" size="lg" disabled={starting} onClick={() => void play()} data-testid="daily-play" data-state={playState}>
                {playState === 'fresh' ? 'Play' : playState === 'played' ? 'Play again' : playState === 'unranked' ? 'Play for practice' : 'Play offline'}
              </Button>
              <span className="text-sm text-ash">
                {playState === 'offline' ? 'Offline · not on the board' : `${you ? `${you.ranked} ranked attempts left · ` : ''}new day in ${Math.floor(hoursLeft)} h ${Math.floor((hoursLeft % 1) * 60)} min`}
              </span>
            </div>
          </section>

          <section className="panel flex flex-col gap-2 p-5" data-testid="daily-board">
            <div className="flex items-center justify-between gap-2">
              <h2 className="section-title">Board</h2>
              <div className="seg" role="group" aria-label="Board">
                {(['best', 'first', 'yesterday'] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
                    {v === 'best' ? 'Best' : v === 'first' ? 'First try' : 'Yesterday'}
                  </button>
                ))}
              </div>
            </div>
            {!dailyOnline ? (
              <p className="text-ash">This build plays offline: scores are not posted.</p>
            ) : !summary ? (
              <p className="text-ash">Loading the board…</p>
            ) : summary.board.rows.length === 0 ? (
              <p className="text-ash">Nobody on the board yet. Be the first.</p>
            ) : (
              <table className="tabular w-full text-left">
                <tbody>
                  {summary.board.rows.map((r) => (
                    <tr key={r.attempt} className="border-b border-white/5">
                      <td className="w-10 py-1 text-ash">{r.rank}</td>
                      <td className="py-1 font-semibold">{r.name}</td>
                      <td className="py-1 text-right">Wave {r.waves}</td>
                      <td className="py-1 pl-3 text-right">{dailyTime(r.time)}</td>
                      <td className="w-16 py-1 pl-2 text-right">
                        {r.rank <= 10 && (
                          <button type="button" className="text-sm text-[#ffcf7a] hover:underline" onClick={() => void watchRow(r)} data-testid="daily-watch" aria-label={`Watch ${r.name ?? 'this'} run`}>
                            Watch
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {summary.board.you && !summary.board.rows.some((r) => r.attempt === summary.board.you!.attempt) && (
                    <tr className="text-[#ffcf7a]">
                      <td className="py-1">{summary.board.you.rank}</td>
                      <td className="py-1 font-semibold">You</td>
                      <td className="py-1 text-right">Wave {summary.board.you.waves}</td>
                      <td className="py-1 pl-3 text-right">{dailyTime(summary.board.you.time)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
            {summary && <p className="mt-auto text-sm text-ash">{summary.board.players} players today</p>}
          </section>
        </div>
      </div>
    </div>
  )
}
