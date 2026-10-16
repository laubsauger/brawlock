/**
 * Who knocked out whom, for the overhead kill stamp and the per-round kill
 * pips on the KILLER's nameplate. Pure (no DOM, no three), keyed by the
 * killer's pawn id (plates are keyed by pawn id), so it is unit tested.
 *
 * Credit follows the sim: `death.killer` is the last hitter, lava deaths
 * included. No killer, or the victim's own player (self-damage), gives no
 * stamp and no pip.
 */

/** a stamp shows this long after the last kill it counts */
export const STAMP_LIFE = 1.6
/** kills by one warlock this close together stack into "×2", "×3" */
export const MULTI_WINDOW = 3

export interface KillVictim {
  player: number
  name: string
  /** identity colour (team colour in team modes, viewer palette), 0xRRGGBB */
  color: number
}

export interface Stamp {
  /** latest victim (shown by name) */
  victim: KillVictim
  /** kills in this streak (1 = single, 2 = "×2", ...) */
  count: number
  /** time of the latest kill in the streak (seconds, overlay clock) */
  at: number
  /** bumps on every kill, so the view restarts its pop-in */
  seq: number
}

export class KillStamps {
  private stamps = new Map<number, Stamp>()
  private pips = new Map<number, number>()
  private seq = 0

  /**
   * A death. `killerPawn`: the killer's current pawn id, or null if the
   * killer has no pawn (left, or not in the arena). Returns the stamp it made
   * or extended, or null when the death earns no credit.
   */
  death(victim: KillVictim, killer: number | null, killerPawn: number | null, now: number): Stamp | null {
    if (killer == null || killer === victim.player || killerPawn == null) return null
    this.pips.set(killerPawn, (this.pips.get(killerPawn) ?? 0) + 1)
    const prev = this.stamps.get(killerPawn)
    const streak = prev && now - prev.at <= MULTI_WINDOW
    const s: Stamp = { victim, count: streak ? prev.count + 1 : 1, at: now, seq: ++this.seq }
    this.stamps.set(killerPawn, s)
    return s
  }

  /** The stamp to show over a pawn's plate now, or null. */
  stampOf(pawn: number, now: number): Stamp | null {
    const s = this.stamps.get(pawn)
    if (!s) return null
    if (now - s.at > STAMP_LIFE) {
      this.stamps.delete(pawn)
      return null
    }
    return s
  }

  /** Kills this round by a pawn (the subtle pips on its plate). */
  pipsOf(pawn: number): number {
    return this.pips.get(pawn) ?? 0
  }

  /** New round: pips start over (stamps fade on their own). */
  resetRound(): void {
    this.pips.clear()
  }

  /** New match or remount: forget everything. */
  clear(): void {
    this.pips.clear()
    this.stamps.clear()
  }
}

/** "", "Double", "Triple", ... for a streak count (shared with the HUD callout wording). */
export function streakWord(count: number): string {
  return count >= 5 ? 'Rampage' : (['', '', 'Double', 'Triple', 'Quadruple'][count] ?? '')
}
