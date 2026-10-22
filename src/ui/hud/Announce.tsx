import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Sigil } from '../icons'
import { displayName } from '../data/catalog'
import { useGame } from '../../game/store'
import { announcements, type Announcement, type AnnouncerLine } from '../../game/announcer'
import { frame } from '../../game/frame'
import { hudZones } from '../../game/hudZones'
import { slotColor, slotGlyph, slotName } from '../lib/view'
import type { KillTag } from './killTags'

/**
 * Center banners and the killfeed. Both are driven imperatively by the HUD
 * director (no React state per event): it calls announce.banner / announce.kill.
 */
export type BannerTone = 'normal' | 'count' | 'fight' | 'danger' | 'win'

export interface KillEntry {
  /** glyph: shape next to the name, only with the colourblind palette */
  killer: { name: string; color: string; glyph?: string } | null
  victim: { name: string; color: string; glyph?: string }
  /** spell / item id of the last hit, if known */
  cause: string | null
  /** died in the lava (the killer, if any, pushed them there) */
  lava: boolean
  local: boolean
  /** the local player made this kill (stands out in the feed) */
  myKill?: boolean
  /** multi kill, streak, Shutdown, First Blood (killTags.ts), loudest first */
  tags?: KillTag[]
}

export interface MyKill {
  name: string
  color: string
  glyph?: string
}

export const announce = {
  banner(_title: string, _sub = '', _tone: BannerTone = 'normal', _ms = 1800): void {},
  /** keep a banner up until cleared (game over) */
  hold(_title: string, _sub = '', _tone: BannerTone = 'normal'): void {},
  clear(): void {},
  kill(_e: KillEntry): void {},
  /** empty the kill feed (new match, replay rewind) */
  clearFeed(): void {},
  /** you knocked someone out: the callout under the score strip */
  myKill(_v: MyKill): void {},
}

const SKULL_PATH = 'M8 1.4c-3.6 0-6.1 2.4-6.1 5.7 0 2 1 3.4 2.5 4.2V13a1 1 0 0 0 1 1h5.2a1 1 0 0 0 1-1v-1.7c1.5-.8 2.5-2.2 2.5-4.2 0-3.3-2.5-5.7-6.1-5.7Z'

export function Skull({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden className="shrink-0">
      <path d={SKULL_PATH} fill={color} />
      <circle cx="5.6" cy="7.6" r="1.55" fill="#140909" />
      <circle cx="10.4" cy="7.6" r="1.55" fill="#140909" />
      <path d="M7.2 10.5h1.6L8 9.1Z" fill="#140909" />
    </svg>
  )
}

/** how long the callout and an announcer line stay */
const MYKILL_MS = 1500
/** how long a big kill line (streak, multi kill, first blood, shutdown) stays */
const BIG_MS = 2200

/**
 * Kill lines shown big for whoever hears them (the announcer decides the audience: streaks from
 * Rampage, First Blood and Shutdown for everyone, your own multi kills and sprees for you),
 * by tier: 1 smallest .. 4 loudest.
 */
const BIG_TIER: Partial<Record<AnnouncerLine, 1 | 2 | 3 | 4>> = {
  double_kill: 1,
  killing_spree: 1,
  triple_kill: 2,
  first_blood: 2,
  rampage: 2,
  multi_kill: 3,
  unstoppable: 3,
  shutdown: 3,
  mega_kill: 4,
  ultra_kill: 4,
  monster_kill: 4,
  godlike: 4,
}

export const bigTier = (line: AnnouncerLine): 1 | 2 | 3 | 4 | 0 => BIG_TIER[line] ?? 0

/** An announcer line as the banner shows it: the spoken words, and whose it is. */
export interface AnnouncerBanner {
  text: string
  player: number
}

/**
 * What the row under the clock shows: your knockout ("Knocked out Thorn")
 * with your own announcer line on top of it, word for word what the voice
 * says ("Double Kill!", from game/announcer), and lines earned by others
 * ("First Blood!", "Rampage!") as a separate chip naming them.
 */
export function calloutLines(kill: MyKill | null, line: AnnouncerBanner | null, local: number): { top: string | null; main: MyKill | null; other: AnnouncerBanner | null } {
  const mine = !!line && line.player === local
  return { top: mine ? line.text : null, main: kill, other: line && !mine ? line : null }
}

/**
 * Under the clock: "Knocked out Thorn" when you get a kill, wherever it
 * happened (a push that lands in the lava off-screen too), and the announcer's
 * lines as the voice speaks them (also with sound off or still locked).
 */
export function KillCallout() {
  const shopOpen = useGame((s) => s.shopOpen)
  const [kill, setKill] = useState<(MyKill & { key: number }) | null>(null)
  const [line, setLine] = useState<(AnnouncerBanner & { key: number }) | null>(null)
  useEffect(() => {
    let killTimer = 0
    let lineTimer = 0
    let n = 0
    announce.myKill = (v) => {
      setKill({ ...v, key: ++n })
      window.clearTimeout(killTimer)
      killTimer = window.setTimeout(() => setKill(null), MYKILL_MS)
    }
    const off = announcements.subscribe((a: Announcement) => {
      // round flow (Round N, Fight!, round-win calls, Victory!) lives in the center banners,
      // kill lines in the big streak callout
      if (a.kind === 'flow' || bigTier(a.line)) return
      setLine({ text: a.text, player: a.player, key: ++n })
      window.clearTimeout(lineTimer)
      lineTimer = window.setTimeout(() => setLine(null), MYKILL_MS)
    })
    return () => {
      window.clearTimeout(killTimer)
      window.clearTimeout(lineTimer)
      off()
      announce.myKill = () => {}
    }
  }, [])
  const { top, main, other } = calloutLines(kill, line, frame.localPlayer)
  const state = frame.curr
  return (
    <>
      {(top || main) && (
        <div key={`${kill?.key ?? 0}:${top ? line?.key : 0}`} className="kill-callout pop-in" role="status" aria-live="polite">
          <Skull size={20} color="#f3e4cf" />
          {/* with the shop docks open there is room for one line only (the docks start right below) */}
          <span className={`flex leading-tight ${shopOpen ? 'flex-row items-baseline gap-1.5' : 'flex-col items-start'}`}>
            {top && <span className="kill-callout-streak">{top}</span>}
            {main && (
              <span>
                {top && shopOpen ? '' : 'Knocked out '}
                <b style={{ color: main.color }}>
                  {main.glyph && <span className="mr-0.5">{main.glyph}</span>}
                  {main.name}
                </b>
              </span>
            )}
          </span>
        </div>
      )}
      {other && (
        <div key={`o${line?.key}`} className="kill-callout pop-in" role="status" aria-live="polite">
          <span className="kill-callout-streak">{other.text}</span>
          {/* lines about nobody in particular ("The Arena Shrinks!") carry player -1 */}
          {other.player >= 0 && (
            <b style={{ color: slotColor(state, other.player) }}>
              {slotGlyph(state, other.player) && <span className="mr-0.5">{slotGlyph(state, other.player)}</span>}
              {slotName(state, other.player)}
            </b>
          )}
        </div>
      )}
    </>
  )
}

/**
 * Big kill lines ("Unstoppable!", "Double Kill!") above the action, sized and lit by tier, with
 * whose it is underneath ("You" for your own).
 */
export function StreakCallout() {
  const [shown, setShown] = useState<(Announcement & { key: number }) | null>(null)
  const title = useRef<HTMLDivElement>(null)
  const who = useRef<HTMLDivElement>(null)
  // tell the world overlay where the line is, so kill stamps and callouts step back from it;
  // re-measured every frame while up (the line moves down when the knocked-out card appears)
  useLayoutEffect(() => {
    const t = title.current
    if (!shown || !t) return
    // layout boxes around their on-screen centres: the pop-in scale is not part of the zone
    const box = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      const cx = (r.left + r.right) / 2
      const cy = (r.top + r.bottom) / 2
      return { left: cx - el.offsetWidth / 2, top: cy - el.offsetHeight / 2, right: cx + el.offsetWidth / 2, bottom: cy + el.offsetHeight / 2 }
    }
    let raf = 0
    const measure = () => {
      const a = box(t)
      const b = who.current ? box(who.current) : a
      const z = { left: Math.round(Math.min(a.left, b.left)), top: Math.round(a.top), right: Math.round(Math.max(a.right, b.right)), bottom: Math.round(Math.max(a.bottom, b.bottom)) }
      const old = hudZones.streak
      if (!old || old.left !== z.left || old.top !== z.top || old.right !== z.right || old.bottom !== z.bottom) hudZones.streak = z
      raf = requestAnimationFrame(measure)
    }
    measure()
    return () => {
      cancelAnimationFrame(raf)
      hudZones.streak = null
    }
  }, [shown])
  useEffect(() => {
    let timer = 0
    let n = 0
    const off = announcements.subscribe((a: Announcement) => {
      if (a.kind === 'flow' || !bigTier(a.line)) return
      setShown({ ...a, key: ++n })
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setShown(null), BIG_MS)
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [])
  if (!shown) return null
  const state = frame.curr
  const mine = shown.player === frame.localPlayer
  return (
    <div key={shown.key} className="streak-callout" data-tier={bigTier(shown.line)} role="status" aria-live="polite" style={{ ['--dur' as string]: `${BIG_MS}ms` }}>
      <div ref={title} className="streak-callout-title">{shown.text}</div>
      {shown.player >= 0 && (
        <div ref={who} className="streak-callout-who">
          {mine ? (
            'You'
          ) : (
            <b style={{ color: slotColor(state, shown.player) }}>
              {slotGlyph(state, shown.player) && <span className="mr-0.5">{slotGlyph(state, shown.player)}</span>}
              {slotName(state, shown.player)}
            </b>
          )}
          {shown.line === 'first_blood' && shown.victim !== undefined && <>
            <span className="mx-2 text-ash">eliminated</span>
            <b style={{ color: slotColor(state, shown.victim) }}>{shown.victim === frame.localPlayer ? 'You' : slotName(state, shown.victim)}</b>
          </>}
        </div>
      )}
    </div>
  )
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

/** rows kept; the feed stays up for the whole match, older rows dim (index.css) */
const FEED_MAX = 6

interface FeedRow extends KillEntry {
  key: number
}

function LavaIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden className="shrink-0">
      <path d="M12 2.5c1 4 5 5.5 5 10.5a5 5 0 0 1-10 0c0-2.5 1.2-4 2.5-5 .2 1.8 1 2.8 2 3.2-.5-3.2-1-6 .5-8.7Z" fill="#ff7a2a" />
      <path d="M3 20.5c2-1.4 4-1.4 6 0s4 1.4 6 0 4-1.4 6 0" fill="none" stroke="#ffb347" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function Name({ who }: { who: { name: string; color: string; glyph?: string } }) {
  return (
    <b className="max-w-[10rem] truncate font-bold" style={{ color: who.color }}>
      {who.glyph && (
        <span className="mr-1" aria-hidden>
          {who.glyph}
        </span>
      )}
      {who.name}
    </b>
  )
}

/**
 * Broadcast-style kill feed, newest on top: killer, cause, victim, then the kill's accolades
 * (Double Kill, Shutdown, ...). Lava deaths credit whoever pushed last ("pushed into the lava
 * by"). Rows stay for the match so the last few kills can be read back at any time; the
 * oldest drop off at FEED_MAX. Kills are rare, so this is plain React state.
 */
export function Killfeed() {
  const [rows, setRows] = useState<FeedRow[]>([])
  useEffect(() => {
    let n = 0
    announce.kill = (e) => {
      const key = ++n
      setRows((r) => [{ ...e, key }, ...r].slice(0, FEED_MAX))
    }
    announce.clearFeed = () => setRows([])
    return () => {
      announce.kill = () => {}
      announce.clearFeed = () => {}
    }
  }, [])
  return (
    <div className="flex flex-col items-end gap-1" aria-live="polite" aria-label="Kill feed">
      {rows.map((r) => (
        <div key={r.key} className="feed-row hud-text-shadow" data-local={r.local} data-mine={r.myKill ? 'kill' : undefined} aria-label={feedText(r)}>
          {r.myKill && <Skull size={15} color="#ffd27a" />}
          {r.killer && <Name who={r.killer} />}
          {r.cause && r.cause !== 'lava' && <Sigil id={r.cause} size={22} />}
          {r.lava && <LavaIcon />}
          <Name who={r.victim} />
          {!r.killer && r.lava && <span className="font-medium text-ash">burned</span>}
          {r.tags?.map((t) => (
            <span key={t.line} className="feed-tag" data-tier={bigTier(t.line) || undefined}>
              {t.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

export function feedText(r: KillEntry): string {
  const tags = r.tags?.length ? `: ${r.tags.map((t) => t.text).join(', ')}` : ''
  return feedSentence(r) + tags
}

function feedSentence(r: KillEntry): string {
  if (r.killer && r.lava) return `${r.killer.name} pushed ${r.victim.name} into the lava${r.cause && r.cause !== 'lava' ? ` with ${displayName(r.cause)}` : ''}`
  if (r.killer) return `${r.killer.name} killed ${r.victim.name}${r.cause ? ` with ${displayName(r.cause)}` : ''}`
  if (r.lava) return `${r.victim.name} burned in the lava`
  return `${r.victim.name} was knocked out${r.cause ? ` by ${displayName(r.cause)}` : ''}`
}
