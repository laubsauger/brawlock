import { useEffect, useRef } from 'react'
import { dailyClock, useDaily } from '../../game/daily/play'
import { Sigil } from '../icons'
import { useTick } from '../lib/ticker'
import { bountyRule, dailyBot, dailyTime } from '../screens/Daily'
import { displayName } from '../data/catalog'
import { announce } from './Announce'

/**
 * The daily run's HUD (docs/moonshot/specs/daily.md): a pip per wave (the last a crown), lives as
 * flames, a clock that runs only in fights (written from rAF, never React state), the bounty spell
 * and its count. Each fight opens with a banner naming the wave. Hovering (or focusing) the card
 * opens the day's briefing: the omen, the waves, the champion and how the bounty pays.
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
      <div className="daily-hud-card hud-backing interactive pointer-events-auto flex flex-col gap-1 rounded px-3 py-2" tabIndex={0} aria-describedby="daily-briefing">
        <span className="text-xs tracking-[0.18em] text-ash uppercase">Daily #{run.day.number}{run.ranked ? '' : ' · practice'}</span>
        <div className="flex items-center gap-1.5" aria-label={`Wave ${Math.min(run.wave + 1, run.day.waves.length)} of ${run.day.waves.length}`}>
          {run.day.waves.map((_, i) => (
            <span key={i} className="daily-pip" data-state={i < run.wave ? 'cleared' : i === run.wave ? 'current' : 'next'} data-crown={i === run.day.waves.length - 1 || undefined} />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex gap-1" aria-label={`${run.lives} lives`}>
            {Array.from({ length: run.day.lives }, (_, i) => (
              <span key={i} className="daily-life" data-on={i < run.lives || undefined} />
            ))}
          </span>
          <span ref={clock} className="tabular text-lg font-semibold text-[#f0d9b8]">0:00.0</span>
          <span className="flex items-center gap-1 text-sm" title="Bounty knockouts">
            <Sigil id={run.day.bounty} size={20} />
            {run.bountyKos}
          </span>
        </div>
        <div id="daily-briefing" className="daily-briefing" role="tooltip" data-testid="daily-briefing">
          <p className="font-semibold text-[#ffe1a6]">{run.day.name}</p>
          <p className="text-[#f0d9b8]">{run.day.omen.flavour}</p>
          <ol className="mt-1.5 flex flex-col gap-0.5">
            {run.day.waves.map((w, i) => (
              <li key={i} data-state={i < run.wave ? 'cleared' : i === run.wave ? 'current' : 'next'} className={i === run.wave ? 'font-semibold text-[#ffcf7a]' : i < run.wave ? 'text-ash line-through' : ''}>
                <span className="text-ash">{w[0].champion ? 'Champion' : `Wave ${i + 1}`} ·</span> {w.map(dailyBot).join(' and ')}
              </li>
            ))}
          </ol>
          <p className="mt-1.5 text-ash">{run.day.champion.line}</p>
          <p className="mt-1.5 flex items-start gap-1.5"><Sigil id={run.day.bounty} size={18} /><span><b>Bounty: {displayName(run.day.bounty)}.</b> {bountyRule(run.day)}</span></p>
          <p className="mt-1 text-ash">{run.day.lives} lives: a lost fight replays the wave.</p>
        </div>
      </div>
    </div>
  )
}
