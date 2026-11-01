import { frame } from '../../game/frame'
import { useGame, type FinalBlowView } from '../../game/store'
import { Sigil } from '../icons'
import { displayName } from '../data/catalog'
import { slotColor, slotGlyph, slotName } from '../lib/view'

/** trait chips, in this order; deciders are what every Final Blow is, so they get none */
const TRAITS: [string, string][] = [
  ['reflected', 'Reflected'],
  ['detonation', 'Detonation'],
  ['pillarBlast', 'Pillar blast'],
  ['longFlight', 'Long flight'],
  ['comeback', 'Comeback'],
]

function Who({ id }: { id: number }) {
  const s = frame.curr
  const glyph = slotGlyph(s, id)
  return (
    <b className="max-w-[12rem] truncate font-bold" style={{ color: slotColor(s, id) }}>
      {glyph && (
        <span className="mr-1" aria-hidden>
          {glyph}
        </span>
      )}
      {slotName(s, id)}
    </b>
  )
}

/** The Final Blow's frame (docs/moonshot/specs/final-blow.md, Rule 6): letterbox bars, who hit whom with what, a skip hint. */
export function FinalBlowPlate({ view }: { view?: FinalBlowView | null }) {
  const stored = useGame((s) => s.finalBlow)
  const fb = view === undefined ? stored : view
  if (!fb) return null
  const cause = fb.cause && fb.cause !== 'obstacle' && fb.cause !== 'lava' ? fb.cause : null
  const how = fb.cause === 'obstacle' ? 'a pillar blast' : cause ? displayName(cause) : 'a push'
  return (
    <div className="final-blow" data-testid="final-blow" data-state={fb.partial ? 'death' : 'hit'} data-kind={fb.kind} role="status" aria-label={`Replay: ${slotName(frame.curr, fb.hitter)} knocked out ${slotName(frame.curr, fb.victim)} with ${how}`}>
      <div className="final-blow-bar final-blow-top" />
      <div className="final-blow-bar final-blow-bottom">
        <div className="final-blow-lower">
          <span className="final-blow-kicker">{fb.kind === 'match' ? 'Match winner' : 'Replay'}</span>
          <div className="final-blow-line hud-text-shadow">
            <Who id={fb.hitter} />
            {cause ? <Sigil id={cause} size={26} /> : <span className="font-medium text-ash">{fb.cause === 'obstacle' ? 'pillar' : 'pushed'}</span>}
            <Who id={fb.victim} />
            {TRAITS.filter(([t]) => fb.traits.includes(t)).map(([t, label]) => (
              <span key={t} className="feed-tag" data-trait={t}>
                {label}
              </span>
            ))}
          </div>
        </div>
        <span className="final-blow-skip">Any key to skip</span>
      </div>
    </div>
  )
}
