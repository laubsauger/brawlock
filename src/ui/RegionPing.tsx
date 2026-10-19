import { GRADE_COLOR } from './lib/netstats'
import { pingGrade, type RegionState, type RegionStatus } from './lib/servers'
import { SignalBars } from './hud/ConnIndicator'

const STATE_DOT: Record<RegionState, { color: string; label: string }> = {
  up: { color: '#7fe39a', label: 'Online' },
  down: { color: '#ff5a4a', label: 'Offline' },
  mismatch: { color: '#ffb347', label: 'Other game version' },
  checking: { color: '#9a8775', label: 'Checking' },
}

/** Health dot plus signal bars and ping coloured by the netcode grade, for one region. */
export function RegionPing({ s, withName = false }: { s: RegionStatus; withName?: boolean }) {
  const draining = s.maintenance?.draining === true
  const grade = s.state === 'up' && !draining ? pingGrade(s.rttMs) : null
  const dot = draining && s.state === 'up' ? { color: '#ffb347', label: 'Updating · reconnects available' } : STATE_DOT[s.state]
  const ms = draining && s.state === 'up' ? 'Updating' : s.state === 'up' ? (s.rttMs != null ? `${s.rttMs} ms` : '…') : dot.label.toLowerCase()
  return (
    <span className="font-ui flex shrink-0 items-center gap-2 tracking-normal whitespace-nowrap normal-case" aria-label={`${s.label}: ${dot.label}${s.rttMs != null && s.state === 'up' ? `, ${s.rttMs} ms` : ''}`}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot.color, boxShadow: `0 0 6px ${dot.color}` }} aria-hidden />
      {withName && <span className="text-[#cdb8a4]">{s.label} ·</span>}
      <span className="tabular font-semibold" style={{ color: grade ? GRADE_COLOR[grade] : dot.color }}>
        {ms}
      </span>
      {s.state === 'up' && !draining && <SignalBars grade={grade} scale={0.8} />}
    </span>
  )
}

