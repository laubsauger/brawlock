import type { ReactNode } from 'react'
import { accuracy, totalKills, type Award, type PlayerMatchStats } from '../../game/stats'
import { Sigil } from '../icons'
import { displayName } from '../data/catalog'
import { AWARD_ICON, awardValue, causeLabel, percent, seconds, tiles } from '../lib/statFormat'

/**
 * Stat views shared by the results screen and "Your record": award cards,
 * the per-player stats panel and small building blocks. Reveals are CSS only
 * (staggered animation-delay) on boxes whose size is fixed from the start, so
 * nothing shifts while they appear.
 */

/** One award: icon, title, who won it (identity colour), value and blurb. */
/** The blurb already says the number: highlight it there instead of repeating it on its own line. */
function AwardBlurb({ award }: { award: Award }) {
  const n = /\d[\d,.]*%?/.exec(award.blurb)
  const value = (text: string) => <b className="tabular font-semibold text-[#ffd27a]">{text}</b>
  if (!n) return <>{value(awardValue(award))} · {award.blurb}</>
  return <>{award.blurb.slice(0, n.index)}{value(n[0])}{award.blurb.slice(n.index + n[0].length)}</>
}

export function AwardCard({ award, name, color, index = 0, compact = false }: { award: Award; name: string; color: string; index?: number; compact?: boolean }) {
  return (
    <div className={`award-card ${compact ? 'award-card-compact' : ''}`} style={{ animationDelay: `${index * 120}ms`, ['--hue' as string]: color }}>
      <span className="tile-icon shrink-0" style={{ width: compact ? 36 : 46, height: compact ? 36 : 46 }}>
        <Sigil id={AWARD_ICON[award.id] ?? 'fireball'} size={compact ? 32 : 40} />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="award-title">{award.title}</span>
        <span className="truncate text-[0.92rem] font-bold" style={{ color }}>
          {name}
        </span>
        <span className="mt-0.5 text-[0.8rem] leading-snug text-[#d4c1a8]"><AwardBlurb award={award} /></span>
      </span>
    </div>
  )
}

/** The awards of one match, 3-5 cards in a row (wrapping on narrow screens). */
export function AwardsStrip({ awards, who, compact = false }: { awards: readonly Award[]; who: (player: number) => { name: string; color: string }; compact?: boolean }) {
  if (awards.length === 0) return null
  return (
    <div className={`awards-strip ${compact ? 'awards-strip-compact' : ''}`} role="list" aria-label="Awards">
      {awards.map((a, i) => {
        const w = who(a.player)
        return (
          <div key={a.id} role="listitem">
            <AwardCard award={a} name={w.name} color={w.color} index={i} compact={compact} />
          </div>
        )
      })}
    </div>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[0.78rem] font-semibold text-ash">{label}</dt>
      <dd className="tabular truncate text-[0.98rem] font-semibold text-[#f0dfc8]">{children}</dd>
    </div>
  )
}

/** "Fireball 2 · Lava 1" (most first), or a dash. */
function byCause(m: Record<string, number>): string {
  const e = Object.entries(m).filter(([, n]) => n > 0)
  if (!e.length) return '–'
  return e
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${causeLabel(k)} ${n}`)
    .join(' · ')
}

/** One player's match details: kills by cause, accuracy, movement, lava, saves, top spell. */
export function PlayerStatsDetail({ stats }: { stats: PlayerMatchStats }) {
  const acc = accuracy(stats, 1)
  const top = stats.topSpell
  return (
    <dl className="player-stats grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4">
      <Stat label={`Kills by cause (${totalKills(stats)})`}>
        <span title={byCause(stats.killsByCause)}>{byCause(stats.killsByCause)}</span>
      </Stat>
      <Stat label="Accuracy">{percent(acc)}</Stat>
      <Stat label="Walked / pushed">
        {tiles(stats.walked)} / {tiles(stats.pushed)}
      </Stat>
      <Stat label="Longest flight">{tiles(stats.longestFlight)}</Stat>
      <Stat label="Time in lava">{seconds(stats.lavaSec)}</Stat>
      <Stat label="Teleport saves">{stats.teleportSaves}</Stat>
      <Stat label="Scourge hits">{stats.scourgeHits}</Stat>
      <Stat label="Top spell">
        {top ? (
          <span className="flex items-center gap-1.5">
            <Sigil id={top[0]} size={18} />
            {displayName(top[0])} · level {top[1]}
          </span>
        ) : (
          '–'
        )}
      </Stat>
    </dl>
  )
}
