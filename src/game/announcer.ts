/**
 * The announcer: which line to call out, for whom, and when. Pure and shared, so the voice
 * (src/audio) and the HUD banner (src/ui) say the same words: the audio engine feeds it each
 * tick's sim events, and every chosen line goes out through `announcements` to both.
 *
 * Credit follows the sim and the kill stamps: `death.killer` is the last hitter (lava deaths
 * included); no killer, or the victim's own player, credits nothing.
 * - First Blood: the match's first credited kill, for everyone.
 * - Multi-kill: kills chained within MULTI_WINDOW of each other (the kill stamps' window),
 *   2 Double, 3 Triple, 4 Multi, 5 Mega, 6 Ultra, 7+ Monster; only for your own kills.
 * - Streaks: kills without dying, across rounds, reset by any death. 3 Killing Spree,
 *   5 Rampage, 7 Unstoppable, 10 Godlike; yours for you, Rampage and up for everyone.
 * - One line at a time: queued by priority (multi-kill > streak > first blood), lines older
 *   than STALE_AFTER are dropped, and a line starts only after the previous one ended.
 */
import { MULTI_WINDOW } from '../render/overlay/killStamps'
import type { PlayerId, SimEvent } from '../sim/types'

export type AnnouncerLine =
  | 'first_blood'
  | 'double_kill'
  | 'triple_kill'
  | 'multi_kill'
  | 'mega_kill'
  | 'ultra_kill'
  | 'monster_kill'
  | 'killing_spree'
  | 'rampage'
  | 'unstoppable'
  | 'godlike'

/** What the voice says, word for word (the banner shows the same). */
export const ANNOUNCER_TEXT: Record<AnnouncerLine, string> = {
  first_blood: 'First Blood!',
  double_kill: 'Double Kill!',
  triple_kill: 'Triple Kill!',
  multi_kill: 'Multi Kill!',
  mega_kill: 'Mega Kill!',
  ultra_kill: 'Ultra Kill!',
  monster_kill: 'Monster Kill!',
  killing_spree: 'Killing Spree!',
  rampage: 'Rampage!',
  unstoppable: 'Unstoppable!',
  godlike: 'Godlike!',
}

const MULTI_LADDER: readonly AnnouncerLine[] = ['double_kill', 'triple_kill', 'multi_kill', 'mega_kill', 'ultra_kill', 'monster_kill']
const STREAKS: readonly (readonly [number, AnnouncerLine])[] = [
  [3, 'killing_spree'],
  [5, 'rampage'],
  [7, 'unstoppable'],
  [10, 'godlike'],
]
/** streak length from which everyone hears it */
const PUBLIC_STREAK = 5
/** a queued line older than this (s) is dropped rather than played late */
export const STALE_AFTER = 1.5
/** silence between two lines (s) */
const LINE_GAP = 0.15
const PRIORITY = { multi: 3, streak: 2, first: 1 } as const

export interface Announcement {
  line: AnnouncerLine
  text: string
  kind: keyof typeof PRIORITY
  /** who earned it */
  player: PlayerId
  /** kills in the chain (multi) or the streak (streak) */
  count: number
  /** sim time (s) it was earned */
  at: number
}

/** Multi-kill line for a chain of `count` kills (2 = Double ... 7+ = Monster). */
export function multiLine(count: number): AnnouncerLine | null {
  if (count < 2) return null
  return MULTI_LADDER[Math.min(count, 7) - 2]
}

export class Announcer {
  private firstBlood = false
  private readonly chains = new Map<PlayerId, { count: number; at: number }>()
  private readonly streaks = new Map<PlayerId, number>()
  private queue: Announcement[] = []
  private busyUntil = -Infinity
  private lastNow = -Infinity
  /** seconds a line plays (the voice file's length); the banner uses it too */
  lineLength: (line: AnnouncerLine) => number = () => 1.1

  /** New match: everything starts over. */
  reset(): void {
    this.firstBlood = false
    this.chains.clear()
    this.streaks.clear()
    this.queue = []
    this.busyUntil = -Infinity
    this.lastNow = -Infinity
  }

  /** Kills in a row without dying (for tests and the HUD). */
  streakOf(player: PlayerId): number {
    return this.streaks.get(player) ?? 0
  }

  /**
   * One tick's events at sim time `now` (s), as heard by `localPlayer`. Returns the line to
   * start now, or null (nothing earned, or a line is still playing).
   */
  update(events: readonly SimEvent[], now: number, localPlayer: PlayerId | null): Announcement | null {
    // a new match restarts the sim clock
    if (now < this.lastNow - 1) this.reset()
    this.lastNow = now
    for (const e of events) {
      if (e.type !== 'death') continue
      // any death ends the victim's streak, credited or not
      this.streaks.set(e.owner, 0)
      const k = e.killer
      if (k === null || k === undefined || k === e.owner) continue
      if (!this.firstBlood) {
        this.firstBlood = true
        this.push({ line: 'first_blood', kind: 'first', player: k, count: 1, at: now })
      }
      const prev = this.chains.get(k)
      const count = prev && now - prev.at <= MULTI_WINDOW ? prev.count + 1 : 1
      this.chains.set(k, { count, at: now })
      const multi = multiLine(count)
      if (multi && k === localPlayer) this.push({ line: multi, kind: 'multi', player: k, count, at: now })
      const streak = (this.streaks.get(k) ?? 0) + 1
      this.streaks.set(k, streak)
      const hit = STREAKS.find(([n]) => n === streak)
      if (hit && (k === localPlayer || streak >= PUBLIC_STREAK)) this.push({ line: hit[1], kind: 'streak', player: k, count: streak, at: now })
    }
    return this.next(now)
  }

  /** Start the next queued line if none is playing: highest priority, then oldest. */
  next(now: number): Announcement | null {
    this.queue = this.queue.filter((a) => now - a.at <= STALE_AFTER)
    if (now < this.busyUntil || this.queue.length === 0) return null
    this.queue.sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || a.at - b.at)
    const a = this.queue.shift()!
    this.busyUntil = now + this.lineLength(a.line) + LINE_GAP
    return a
  }

  private push(a: Omit<Announcement, 'text'>): void {
    this.queue.push({ ...a, text: ANNOUNCER_TEXT[a.line] })
  }
}

type Listener = (a: Announcement) => void
const listeners = new Set<Listener>()

/**
 * Every line the announcer starts, for the voice and the HUD banner alike.
 * `subscribe` returns its own unsubscribe.
 */
export const announcements = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  emit(a: Announcement): void {
    for (const fn of listeners) fn(a)
  },
}

/** The match's announcer (fed by the audio engine from playEvents). */
export const matchAnnouncer = new Announcer()
