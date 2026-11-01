import { useEffect, useRef } from 'react'
import { dailyClock, useDaily } from '../../game/daily/play'
import { DAILY_LIVES } from '../../game/daily/run'
import { Sigil } from '../icons'
import { useTick } from '../lib/ticker'
import { dailyTime } from '../screens/Daily'
import { announce } from './Announce'

/**
 * The daily run's HUD (docs/moonshot/specs/daily.md): five wave pips (the last a crown), lives as
 * flames, a clock that runs only in fights (written from rAF, never React state), the bounty spell
 * and its count. Each fight opens with a banner naming the wave.
 */
export function DailyHud() {
  const run = useDaily((s) => s.run)
  const clock = useRef<HTMLSpanElement>(null)
  useTick(() => {
    if (clock.current) clock.current.textContent = dailyTime(dailyClock.fight)
  })
  const phase = run?.phase
  const wave = run?.wave ?? 0
  useEffect(() => {
    if (!run || phase !== 'fight' || wave >= run.day.waves.length) return
    const bots = run.day.waves[wave]
    announce.banner(bots[0].champion ? bots[0].name : `Wave ${wave + 1}`, bots[0].champion ? run.day.champion.line : bots.map((b) => b.name).join(' and '))
    // a banner per fight: the phase and the wave are the triggers
  }, [phase, wave])
  if (!run) return null
  return (
    <div className="hud-scale pointer-events-none absolute top-14 left-3 z-20" data-testid="daily-hud" data-wave={run.wave} data-lives={run.lives}>
      <div className="hud-backing flex flex-col gap-1 rounded px-3 py-2">
        <span className="text-xs tracking-[0.18em] text-ash uppercase">Daily #{run.day.number}{run.ranked ? '' : ' · practice'}</span>
        <div className="flex items-center gap-1.5" aria-label={`Wave ${Math.min(run.wave + 1, 5)} of 5`}>
          {run.day.waves.map((_, i) => (
            <span key={i} className="daily-pip" data-state={i < run.wave ? 'cleared' : i === run.wave ? 'current' : 'next'} data-crown={i === run.day.waves.length - 1 || undefined} />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex gap-1" aria-label={`${run.lives} lives`}>
            {Array.from({ length: DAILY_LIVES }, (_, i) => (
              <span key={i} className="daily-life" data-on={i < run.lives || undefined} />
            ))}
          </span>
          <span ref={clock} className="tabular text-lg font-semibold text-[#f0d9b8]">0:00.0</span>
          <span className="flex items-center gap-1 text-sm" title="Bounty knockouts">
            <Sigil id={run.day.bounty} size={20} />
            {run.bountyKos}
          </span>
        </div>
      </div>
    </div>
  )
}
