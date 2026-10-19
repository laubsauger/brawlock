/**
 * Trailer matches: real Uber-bot fights (no scripting) the trailer shots fast-forward into.
 * Kits are spread so every bot-usable shop spell shows up somewhere; spell level 5, and
 * the arena shrinks faster than stock so the lava stays in play.
 */
import { COLORS, type PlayerDef, type ShotSim, type SimShotSpec } from '../simShot'

const NAMES: [string, number][] = [
  ['Ashcaller', COLORS.ember],
  ['Frostbinder', COLORS.azure],
  ['Mossgrave', COLORS.moss],
  ['Hexweaver', COLORS.violet],
  ['Emberwake', COLORS.gold],
  ['Tidewarden', COLORS.teal],
  ['Rosethorn', COLORS.rose],
  ['Starveil', COLORS.ice],
]

const COL1 = ['lightning', 'boomerang', 'homing', 'twin']
const COL2 = ['teleport', 'thrust', 'swap']
const COL3 = ['cluster', 'drain', 'bouncer', 'recharge']
const COL4 = ['meteor', 'splitter', 'snowball']
const COL6 = ['link', 'gravity', 'grip', 'warpzone', 'magnetize', 'rockpillar']

/** player i's kit, rotated by `shift` so each match deals a different spread */
function kit(i: number, shift: number): string[] {
  const k = i + shift
  return ['fireball', 'scourge', COL1[k % 4], COL2[k % 3], COL3[(k + 1) % 4], COL4[(k + 2) % 3], COL6[k % 6]]
}

function players(n: number): PlayerDef[] {
  return NAMES.slice(0, n).map(([name, color]) => ({ name, color, bot: 'uber' as const }))
}

function kits(n: number, shift: number): Record<number, string[]> {
  const out: Record<number, string[]> = {}
  for (let i = 0; i < n; i++) out[i] = kit(i, shift)
  return out
}

function shrinkEvery(sec: number): (s: ShotSim) => void {
  return (s) => {
    const a = s.state.arena
    if (a.nextShrinkTick >= 0 && a.nextShrinkTick - s.state.tick > sec * 60) a.nextShrinkTick = s.state.tick + sec * 60
  }
}

export interface TrailerMatch {
  id: string
  spec: SimShotSpec
}

function match(id: string, n: number, layer: number, theme: number, shift: number, every: number): TrailerMatch {
  return {
    id,
    spec: { players: players(n), layer, theme, level: 5, shrink: true, bystander: false, pillars: true, kits: kits(n, shift), tick: shrinkEvery(every) },
  }
}

export const TRAILER_MATCHES: TrailerMatch[] = [
  match('ffa8', 8, 15, 0, 0, 5),
  match('ffa8b', 8, 15, 1, 3, 5),
  match('ffa6', 6, 13, 2, 1, 6),
  match('ffa4', 4, 12, 1, 2, 6),
  match('duel', 2, 11, 0, 4, 7),
  match('duelb', 2, 11, 2, 5, 7),
]

export function trailerMatch(id: string): TrailerMatch {
  const m = TRAILER_MATCHES.find((x) => x.id === id)
  if (!m) throw new Error(`unknown trailer match ${id}`)
  return m
}
