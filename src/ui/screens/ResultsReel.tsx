import { frame } from '../../game/frame'
import type { Moment, MomentTrait } from '../../game/moments'
import { reelSession } from '../../game/replay/reel'
import { useGame, type ReelView } from '../../game/store'
import { Sigil } from '../icons'
import { slotColor, slotName } from '../lib/view'
import { Button } from '../widgets'

const TRAITS: [MomentTrait, string][] = [
  ['reflected', 'Reflected'],
  ['detonation', 'Detonation'],
  ['pillarBlast', 'Pillar blast'],
  ['longFlight', 'Long flight'],
  ['comeback', 'Comeback'],
]

/** What a moment is called on its caption (spec Rule 12). */
export function momentLabel(m: Moment): string {
  switch (m.kind) {
    case 'knockout':
      return m.traits.includes('matchDecider') ? 'Final blow' : m.traits.includes('roundDecider') ? 'Round decider' : 'Knockout'
    case 'multiKnockout':
      return m.count >= 4 ? `${m.count}× knockout` : m.count === 3 ? 'Triple knockout' : 'Double knockout'
    case 'denied':
      return 'Denied'
    case 'clutch':
      return `Clutch 1v${m.count}`
    case 'closeCall':
      return 'Close call'
  }
}

function Who({ id }: { id: number }) {
  return (
    <b className="max-w-[12rem] truncate font-bold" style={{ color: slotColor(frame.curr, id) }}>
      {slotName(frame.curr, id)}
    </b>
  )
}

/**
 * Highlights mode of the results screen (docs/moonshot/specs/results-reel.md): the match scene
 * plays behind letterbox bars, the title stays, a caption names each moment; pips and Skip.
 */
export function ResultsReel({ title, moment, view: given }: { title: string; moment?: Moment | null; view?: ReelView }) {
  const stored = useGame((s) => s.reel)
  const view = given ?? stored
  if (view.state !== 'playing') return null
  const m = moment === undefined ? reelSession.current() : moment
  const cause = m?.cause && m.cause !== 'obstacle' && m.cause !== 'lava' ? m.cause : null
  return (
    <div className="final-blow" data-testid="results-reel" data-state={view.state} data-index={view.index} data-count={view.count} data-closed={view.closed || undefined}>
      <div className="final-blow-bar final-blow-top flex items-center justify-center">
        <span className="wordmark text-[clamp(1.4rem,4vh,2.4rem)] leading-none">{title}</span>
      </div>
      {view.closed && <div className="reel-curtain" />}
      <div className="final-blow-bar final-blow-bottom">
        {m && !view.closed ? (
          <div className="final-blow-lower" data-kind={m.kind}>
            <span className="final-blow-kicker">
              {momentLabel(m)} · Round {m.round}
            </span>
            <div className="final-blow-line hud-text-shadow">
              <Who id={m.actors[0]} />
              {m.victims.length > 0 && (cause ? <Sigil id={cause} size={26} /> : <span className="font-medium text-ash">→</span>)}
              {m.victims.slice(0, 3).map((v) => (
                <Who key={v} id={v} />
              ))}
              {TRAITS.filter(([t]) => m.traits.includes(t)).map(([t, label]) => (
                <span key={t} className="feed-tag" data-trait={t}>
                  {label}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <span />
        )}
        <div className="pointer-events-auto flex items-center gap-3">
          <span className="flex gap-1.5" aria-label={`Highlight ${view.index + 1} of ${view.count}`}>
            {Array.from({ length: view.count }, (_, i) => (
              <span key={i} className="reel-pip" data-on={i <= view.index || undefined} />
            ))}
          </span>
          <Button size="sm" variant="ghost" onClick={() => reelSession.finish()} data-testid="reel-skip">
            Skip
          </Button>
        </div>
      </div>
    </div>
  )
}
