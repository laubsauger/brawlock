import { ANNOUNCER_TEXT, KillTally, multiLine, SHUTDOWN_STREAK, STREAKS, type AnnouncerLine } from '../../game/announcer'
import type { PlayerId } from '../../sim/types'

/** tags per feed row, loudest first */
const MAX_TAGS = 2

/** An accolade on a kill feed row, in the announcer's words without the "!". */
export interface KillTag {
  line: AnnouncerLine
  text: string
}

const tag = (line: AnnouncerLine): KillTag => ({ line, text: ANNOUNCER_TEXT[line].replace(/!$/, '') })

/**
 * Kill feed accolades for every player: multi kills, Shutdown, streaks and First Blood, counted
 * with the announcer's KillTally so the feed and the voice agree on what a kill was. Unlike the
 * voice, which calls your own multi kills and only the long streaks of others, the feed tags
 * every kill, so a glance at it tells who has been on a run. Feed it every death in order.
 */
export class FeedTally {
  private readonly tally = new KillTally()

  reset(): void {
    this.tally.reset()
  }

  /** A death at sim time `now` (s); returns its tags, loudest first (at most MAX_TAGS). */
  death(owner: PlayerId, killer: PlayerId | null | undefined, now: number): KillTag[] {
    const victimStreak = this.tally.streakOf(owner)
    const kill = this.tally.death(owner, killer, now)
    if (!kill) return []
    const tags: KillTag[] = []
    const multi = multiLine(kill.chain)
    if (multi) tags.push(tag(multi))
    if (victimStreak >= SHUTDOWN_STREAK) tags.push(tag('shutdown'))
    const streak = STREAKS.find(([n]) => n === kill.streak)
    if (streak) tags.push(tag(streak[1]))
    if (kill.firstBlood) tags.push(tag('first_blood'))
    return tags.slice(0, MAX_TAGS)
  }
}
