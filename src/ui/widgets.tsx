import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { hoverSfx, sfx } from './lib/sound'
import type { UiSound } from '../audio'
import { GRADE_BARS, GRADE_COLOR, peerTitle, type PeerNet } from './lib/netstats'

type Variant = 'default' | 'primary' | 'danger' | 'ghost'
type Size = 'sm' | 'md' | 'lg'

export function Button({
  variant = 'default',
  size = 'md',
  sound = 'click',
  className = '',
  onClick,
  onMouseEnter,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; sound?: UiSound | null }) {
  const cls = [
    'btn',
    variant === 'primary' && 'btn-primary',
    (variant === 'default' || variant === 'danger') && 'btn-secondary',
    variant === 'danger' && 'btn-danger',
    variant === 'ghost' && 'btn-ghost',
    size === 'sm' && 'btn-sm',
    size === 'lg' && 'btn-lg',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button
      type="button"
      className={cls}
      onMouseEnter={(e) => {
        if (!rest.disabled) hoverSfx()
        onMouseEnter?.(e)
      }}
      onClick={(e) => {
        if (sound) sfx(sound)
        onClick?.(e)
      }}
      {...rest}
    >
      {typeof children === 'string' ? <span className="btn-label">{children}</span> : children}
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="switch"
      onClick={() => {
        sfx('click')
        onChange(!checked)
      }}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
  label: string
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          onMouseEnter={() => !disabled && hoverSfx()}
          onClick={() => {
            if (o.value === value) return
            sfx('click')
            onChange(o.value)
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  label,
  format,
  disabled,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  label: string
  format?: (v: number) => string
  disabled?: boolean
}) {
  const fill = ((value - min) / (max - min)) * 100
  return (
    <div className={`flex items-center gap-3${disabled ? ' opacity-40' : ''}`}>
      <input
        type="range"
        className="slider"
        disabled={disabled}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ['--fill' as string]: `${fill}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="tabular w-12 text-right text-sm font-semibold text-bone/80">{format ? format(value) : Math.round(value * 100) + '%'}</span>
    </div>
  )
}

/**
 * Numeric option field. Commits on blur / Enter, clamps to [min, max];
 * invalid text snaps back to the last good value.
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 1,
  integer = true,
  disabled,
  label,
}: {
  value: number
  onCommit: (v: number) => void
  min: number
  max: number
  step?: number
  integer?: boolean
  disabled?: boolean
  label: string
}) {
  const [text, setText] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(String(value))
  }, [value])
  const commit = () => {
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n)) {
      setText(String(value))
      return
    }
    let v = Math.min(max, Math.max(min, n))
    if (integer) v = Math.round(v)
    else v = Math.round(v / step) * step
    v = Number(v.toFixed(4))
    setText(String(v))
    if (v !== value) onCommit(v)
  }
  return (
    <input
      className="field tabular w-24 text-right"
      inputMode={integer ? 'numeric' : 'decimal'}
      aria-label={label}
      disabled={disabled}
      value={text}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        commit()
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(String(value))
          ;(e.target as HTMLInputElement).blur()
        }
        e.stopPropagation()
      }}
    />
  )
}

/** Labeled row used by settings and match options. */
export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId()
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 py-1.5" aria-describedby={hint ? id : undefined}>
      <div className="min-w-0">
        <div className="text-[1.02rem] font-semibold text-bone">{label}</div>
        {hint && (
          <div id={id} className="text-sm leading-snug text-ash">
            {hint}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

/**
 * Centered modal over a scrim. Esc closes (stopped so the in-match menu
 * does not also toggle), focus moves into the dialog and returns on close.
 */
export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-2xl',
  footer,
  escDisabled = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
  footer?: ReactNode
  /** e.g. while a key-capture field owns Esc */
  escDisabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const escOff = useRef(escDisabled)
  escOff.current = escDisabled
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !escOff.current) {
        e.stopPropagation()
        e.preventDefault()
        sfx('back')
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      prev?.focus?.()
    }
  }, [])
  return (
    <div className="scrim fade-in fixed inset-0 z-50 grid place-items-center p-4" onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`panel panel-solid pop-in flex max-h-[92vh] w-full flex-col outline-none ${width}`}>
        <div className="flex items-center justify-between px-7 pt-6 pb-3">
          <h2 className="display text-4xl text-[#ffd890]">{title}</h2>
          <Button variant="ghost" size="sm" sound="back" onClick={onClose} aria-label="Close">
            Close <Kbd>Esc</Kbd>
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6">{children}</div>
        {footer && <div className="border-t border-[rgba(255,170,100,0.12)] px-7 py-4">{footer}</div>}
      </div>
    </div>
  )
}

/** Ping quality: 4 bars under 60 ms down to 1 bar at 200+. */
export function pingTone(ms: number): { bars: number; color: string } {
  if (ms < 60) return { bars: 4, color: '#7fe39a' }
  if (ms < 110) return { bars: 3, color: '#c8e36f' }
  if (ms < 180) return { bars: 2, color: '#ffc548' }
  return { bars: 1, color: '#ff6a55' }
}

/**
 * Signal bars plus milliseconds. `ms` undefined = unknown (shows a dash).
 * With `net` (the link's stats), bars and color follow its grade and the
 * tooltip lists jitter and loss; `warn` marks a link the host flagged.
 */
export function PingBars({ ms, host, net, warn }: { ms: number | undefined; host?: boolean; net?: PeerNet | null; warn?: boolean }) {
  if (host) return <span className="text-sm font-semibold text-ash">Host</span>
  if (net) ms = net.rttMs ?? undefined
  if (ms == null) return <span className="text-sm text-ash">–</span>
  const t = net ? { bars: GRADE_BARS[net.grade], color: GRADE_COLOR[net.grade] } : pingTone(ms)
  return (
    <span className="inline-flex items-end gap-1.5" title={net ? peerTitle(net) : `${Math.round(ms)} ms round trip to the host`}>
      {warn && <span className="self-center text-[0.8rem] font-semibold text-[#ffb08a]">Unstable</span>}
      <span className="inline-flex items-end gap-[2px]" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className="block w-[3px] rounded-[1px]" style={{ height: 5 + i * 3, background: i < t.bars ? t.color : 'rgba(255,255,255,.14)' }} />
        ))}
      </span>
      <span className="tabular text-sm font-semibold" style={{ color: t.color }}>
        {Math.round(ms)} ms
      </span>
    </span>
  )
}

/** Small crown for the host. */
export function Crown({ title = 'Host' }: { title?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" role="img" aria-label={title}>
      <title>{title}</title>
      <path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5Z" fill="#ffc548" stroke="#7a3d00" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

/** "F4 / P" as two key caps with a quiet slash. */
export function KeyCaps({ label }: { label: string }) {
  const keys = label.split(' / ').filter(Boolean)
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <span key={k} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-[0.75rem] text-ash">/</span>}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </span>
  )
}
