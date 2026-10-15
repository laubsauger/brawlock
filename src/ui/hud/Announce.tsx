import { useEffect, useRef, useState } from 'react'
import { Sigil } from '../icons'
import { displayName } from '../data/catalog'

/**
 * Center banners and the killfeed. Both are driven imperatively by the HUD
 * director (no React state per event): it calls announce.banner / announce.kill.
 */
export type BannerTone = 'normal' | 'count' | 'fight' | 'danger' | 'win'

export interface KillEntry {
  killer: { name: string; color: string } | null
  victim: { name: string; color: string }
  /** spell / item id of the last hit, if known */
  cause: string | null
  /** died in the lava (the killer, if any, pushed them there) */
  lava: boolean
  local: boolean
}

export const announce = {
  banner(_title: string, _sub = '', _tone: BannerTone = 'normal', _ms = 1800): void {},
  /** keep a banner up until cleared (game over) */
  hold(_title: string, _sub = '', _tone: BannerTone = 'normal'): void {},
  clear(): void {},
  kill(_e: KillEntry): void {},
}

export function Banner() {
  const root = useRef<HTMLDivElement>(null)
  const title = useRef<HTMLDivElement>(null)
  const sub = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer = 0
    const set = (t: string, s: string, tone: BannerTone) => {
      const el = root.current
      if (!el || !title.current || !sub.current) return null
      window.clearTimeout(timer)
      title.current.textContent = t
      sub.current.textContent = s
      sub.current.style.display = s ? '' : 'none'
      el.dataset.tone = tone
      el.dataset.show = 'false'
      el.dataset.hold = 'false'
      void el.offsetWidth // restart the CSS animation
      return el
    }
    announce.banner = (t, s = '', tone = 'normal', ms = 1800) => {
      const el = set(t, s, tone)
      if (!el) return
      el.style.setProperty('--dur', `${ms}ms`)
      el.dataset.show = 'true'
      timer = window.setTimeout(() => (el.dataset.show = 'false'), ms)
    }
    announce.hold = (t, s = '', tone = 'normal') => {
      const el = set(t, s, tone)
      if (el) el.dataset.hold = 'true'
    }
    announce.clear = () => {
      window.clearTimeout(timer)
      if (root.current) {
        root.current.dataset.show = 'false'
        root.current.dataset.hold = 'false'
      }
    }
    return () => {
      window.clearTimeout(timer)
      announce.banner = () => {}
      announce.hold = () => {}
      announce.clear = () => {}
    }
  }, [])

  return (
    <div ref={root} className="banner" data-show="false" aria-live="assertive" role="status">
      <div ref={title} className="banner-title" />
      <div ref={sub} className="banner-sub" />
    </div>
  )
}

const FEED_MAX = 5
const FEED_MS = 7000

interface FeedRow extends KillEntry {
  key: number
  out: boolean
}

function LavaIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden className="shrink-0">
      <path d="M12 2.5c1 4 5 5.5 5 10.5a5 5 0 0 1-10 0c0-2.5 1.2-4 2.5-5 .2 1.8 1 2.8 2 3.2-.5-3.2-1-6 .5-8.7Z" fill="#ff7a2a" />
      <path d="M3 20.5c2-1.4 4-1.4 6 0s4 1.4 6 0 4-1.4 6 0" fill="none" stroke="#ffb347" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function Name({ who }: { who: { name: string; color: string } }) {
  return (
    <b className="max-w-[10rem] truncate font-bold" style={{ color: who.color }}>
      {who.name}
    </b>
  )
}

/**
 * Broadcast-style kill feed, newest on top: killer, cause, victim. Lava
 * deaths credit whoever pushed last ("pushed into the lava by"). Rows fade
 * out after a few seconds. Kills are rare, so this is plain React state.
 */
export function Killfeed() {
  const [rows, setRows] = useState<FeedRow[]>([])
  useEffect(() => {
    let n = 0
    const timers = new Set<number>()
    announce.kill = (e) => {
      const key = ++n
      setRows((r) => [{ ...e, key, out: false }, ...r].slice(0, FEED_MAX))
      const t1 = window.setTimeout(() => {
        setRows((r) => r.map((x) => (x.key === key ? { ...x, out: true } : x)))
        const t2 = window.setTimeout(() => setRows((r) => r.filter((x) => x.key !== key)), 420)
        timers.add(t2)
      }, FEED_MS)
      timers.add(t1)
    }
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      announce.kill = () => {}
    }
  }, [])
  return (
    <div className="flex flex-col items-end gap-1" aria-live="polite" aria-label="Kill feed">
      {rows.map((r) => (
        <div key={r.key} className="feed-row hud-text-shadow" data-local={r.local} data-out={r.out} aria-label={feedText(r)}>
          {r.killer && <Name who={r.killer} />}
          {r.cause && r.cause !== 'lava' && <Sigil id={r.cause} size={22} />}
          {r.lava && <LavaIcon />}
          <Name who={r.victim} />
          {!r.killer && r.lava && <span className="font-medium text-ash">burned</span>}
        </div>
      ))}
    </div>
  )
}

function feedText(r: KillEntry): string {
  if (r.killer && r.lava) return `${r.killer.name} pushed ${r.victim.name} into the lava${r.cause && r.cause !== 'lava' ? ` with ${displayName(r.cause)}` : ''}`
  if (r.killer) return `${r.killer.name} killed ${r.victim.name}${r.cause ? ` with ${displayName(r.cause)}` : ''}`
  return `${r.victim.name} burned in the lava`
}
