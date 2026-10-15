import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useGame } from '../../game/store'
import { useNet } from '../lib/netmonitor'
import { GRADE_BARS, GRADE_COLOR, GRADE_LABEL, peerLines, peerTitle, worstGrade, type NetGrade } from '../lib/netstats'

/** Four signal bars, lit and colored by grade. */
export function SignalBars({ grade, scale = 1 }: { grade: NetGrade | null; scale?: number }) {
  const lit = grade ? GRADE_BARS[grade] : 0
  const color = grade ? GRADE_COLOR[grade] : 'rgba(255,255,255,.3)'
  return (
    <span className="inline-flex items-end gap-[2px]" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <i
          key={i}
          className="block rounded-[1px]"
          style={{
            width: 3 * scale,
            height: (5 + i * 3) * scale,
            background: i < lit ? color : 'rgba(255,255,255,.14)',
          }}
        />
      ))}
    </span>
  )
}

/** Small warning triangle (HUD icon and warning toasts). */
export function WarnGlyph({ size = 16, color = '#ff8a3d' }: { size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden className="shrink-0">
      <path d="M8 1.5 15 14H1Z" fill={color} stroke="rgba(40,10,0,.8)" strokeWidth="1" strokeLinejoin="round" />
      <path d="M8 6v3.6" stroke="#2a0d03" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="8" cy="11.8" r="1" fill="#2a0d03" />
    </svg>
  )
}

/**
 * Always-visible connection readout, top left of the HUD: signal bars and ping
 * colored by grade, a warning icon while your link is degraded, and the full
 * numbers on hover. Client: the link to the host. Host: the worst client link.
 */
export function ConnIndicator() {
  const role = useGame((s) => s.lobby.role)
  const slots = useGame((s) => s.lobby.slots)
  // tooltip anchor (viewport px); the card is portaled to <body> so the shop docks never cover it
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setOpen({ x: r.left, y: r.bottom + 6 })
  }
  const v = useNet(
    (s) => {
      const peers = s.snap.peers
      const worst = worstGrade(peers)
      const pings = peers.flatMap((p) => (p.rttMs === null ? [] : [p.rttMs]))
      const ms = pings.length ? Math.round(Math.max(...pings)) : null
      return {
        role: s.snap.role,
        peers,
        worst,
        ms,
        warnings: s.warnings,
        flagged: [...s.flagged],
        source: s.snap.source,
      }
    },
    (x) => `${x.role}|${x.worst}|${x.ms}|${x.warnings.map((w) => w.text).join(',')}|${x.flagged.join(',')}|${open ? x.peers.map((p) => peerTitle(p)).join(';') : ''}`,
  )
  if (role === 'offline') return null
  const alert = v.warnings.length > 0 || v.flagged.length > 0
  const name = (id: number) => slots.find((s) => s.id === id)?.name ?? `Player ${id + 1}`
  const label = v.ms === null ? (role === 'host' ? 'Host' : '–') : `${v.ms} ms`
  return (
    <div className="interactive relative" onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={() => setOpen(null)}>
      <button
        type="button"
        className="hud-backing hud-text-shadow flex items-center gap-2 py-0.5 text-[0.92rem] font-semibold focus-visible:outline-2 focus-visible:outline-gold"
        aria-label={`Connection ${v.worst ? GRADE_LABEL[v.worst] : 'unknown'}, ${label}${alert ? ', warning' : ''}`}
        aria-expanded={!!open}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={() => setOpen(null)}
      >
        <SignalBars grade={v.worst} />
        {role === 'host' && <span className="text-bone/80">Host</span>}
        <span className="tabular" style={{ color: v.worst ? GRADE_COLOR[v.worst] : undefined }}>
          {role === 'host' && v.ms === null ? 'no clients' : label}
        </span>
        {alert && (
          <span className="net-alert" data-testid="net-alert">
            <WarnGlyph size={15} />
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div className="panel pop-in pointer-events-none fixed z-[75] w-[300px] p-3 text-[0.88rem]" style={{ left: open.x, top: open.y }} role="tooltip">
            {v.warnings.length > 0 && (
              <ul className="mb-2 flex flex-col gap-1">
                {v.warnings.map((w) => (
                  <li key={w.kind} className="flex items-center gap-2 font-semibold text-[#ffb08a]">
                    <WarnGlyph size={13} /> {w.text}
                  </li>
                ))}
              </ul>
            )}
            {v.peers.length === 0 && <p className="text-ash">{role === 'host' ? 'No other players connected.' : 'Waiting for the first measurement.'}</p>}
            {v.peers.map((p) => (
              <div key={p.playerId} className="border-t border-[rgba(255,170,100,0.1)] pt-1.5 first:border-t-0 first:pt-0">
                <div className="mb-0.5 flex items-center gap-2 font-semibold">
                  <SignalBars grade={p.grade} scale={0.8} />
                  <span className="truncate">{role === 'client' ? 'Link to the host' : name(p.playerId)}</span>
                  <span className="ml-auto" style={{ color: GRADE_COLOR[p.grade] }}>
                    {GRADE_LABEL[p.grade]}
                  </span>
                </div>
                {role === 'host' && v.flagged.includes(p.playerId) && <p className="text-[#ffb08a]">Unstable connection</p>}
                <dl className="tabular grid grid-cols-[1fr_auto] gap-x-3 text-bone/80">
                  {peerLines(p).map(([k, val]) => (
                    <div key={k} className="contents">
                      <dt className="text-ash">{k}</dt>
                      <dd className="text-right">{val}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
            <p className="mt-2 text-[0.8rem] text-ash">
              {v.source === 'derived' ? 'Estimated from ping and loss. ' : ''}
              Net graph: F3
            </p>
          </div>,
          document.body,
        )}
    </div>
  )
}
