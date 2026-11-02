/**
 * Wild's Vengeful Spirits (sim/wild.ts): a warlock knocked out in the fight rises a moment later
 * as a spirit over the lava. It drifts where its player clicks, kept to a band of lava just off
 * the floor (the band follows the shrink), and any spell key hurls a weak bolt at the living. A
 * spirit cannot be hurt; its knockouts are its player's. Spirits are gone at the next shop.
 */
import { layerRadius } from './arena'
import { STD_PROJECTILE } from './collision'
import { ticks } from './config'
import { destroyProjectile, receiveDamage } from './combat'
import { atan2 } from './math'
import { damageHitBody, spawnProjectile } from './projectiles'
import { isRoundParticipant } from './teams'
import { DT, type InputCommand, type PawnState, type SimState } from './types'
import type { ProjectileBehavior } from './spells/types'
import { cooldownRateOf } from './wild'

/** a knocked-out warlock rises this long after the knockout (s) */
export const SPIRIT_RISE = 1.5
export const SPIRIT_SPEED = 280
export const SPIRIT_COOLDOWN = 3
/** the band of lava spirits keep to: from this far off the floor's edge, this deep */
export const SPIRIT_MARGIN = 70
export const SPIRIT_BAND = 650
export const SPIRIT_BOLT_SPEED = 900
const BOLT_RANGE = 1400
export const SPIRIT_BOLT_RADIUS = 22
const BOLT_DAMAGE = 24
const BOLT_KB = 1

/** Spirits' band this tick: [inner, outer] distance from the centre. */
export function spiritBand(state: Pick<SimState, 'arena'>): [number, number] {
  const inner = layerRadius(state.arena.layer) + SPIRIT_MARGIN
  return [inner, inner + SPIRIT_BAND]
}

/** The point in the band closest to (x, y). */
export function intoBand(state: Pick<SimState, 'arena'>, x: number, y: number): { x: number; y: number } {
  const [inner, outer] = spiritBand(state)
  const r = Math.sqrt(x * x + y * y)
  if (r >= inner && r <= outer) return { x, y }
  const to = r < inner ? inner : outer
  if (r === 0) return { x: to, y: 0 }
  return { x: (x / r) * to, y: (y / r) * to }
}

/** A dead warlock's move or cast while it is a risen spirit. */
export function spiritCommand(state: SimState, pawn: PawnState, cmd: InputCommand): void {
  const sp = pawn.spirit
  if (!sp || sp.rise > 0 || state.phase !== 'fight') return
  if (cmd.kind === 'move') {
    sp.target = intoBand(state, cmd.x, cmd.y)
    return
  }
  if (cmd.kind === 'stop') {
    sp.target = null
    return
  }
  if (cmd.kind !== 'cast' || sp.cd > 0) return
  const dx = cmd.x - sp.x
  const dy = cmd.y - sp.y
  const d = Math.sqrt(dx * dx + dy * dy)
  if (!(d > 0)) return
  sp.cd = ticks(SPIRIT_COOLDOWN)
  sp.facing = atan2(dy, dx)
  spawnProjectile(state, pawn.owner, 'fireball', sp.x, sp.y, (dx / d) * SPIRIT_BOLT_SPEED, (dy / d) * SPIRIT_BOLT_SPEED, SPIRIT_BOLT_RADIUS, {
    kind: 'spiritBolt',
    lifetime: BOLT_RANGE / SPIRIT_BOLT_SPEED,
    rangeMastery: false,
    data: { damage: BOLT_DAMAGE, kb: BOLT_KB },
  })
  state.events.push({ type: 'cast', pawn: pawn.id, spell: 'fireball', x: cmd.x, y: cmd.y })
}

/** One fight tick: knocked-out warlocks rise, spirits drift and their bolt recharges. */
export function spiritTick(state: SimState): void {
  for (const e of state.events) {
    if (e.type !== 'death' || e.cause === 'disconnect') continue
    const p = state.pawns.find((q) => q.id === e.pawn)
    if (!p || p.spirit || !isRoundParticipant(state, p.owner)) continue
    const at = intoBand(state, e.x ?? p.x, e.y ?? p.y)
    p.spirit = { x: at.x, y: at.y, target: null, cd: 0, rise: ticks(SPIRIT_RISE), facing: p.facing }
  }
  const rate = cooldownRateOf(state)
  for (const p of state.pawns) {
    const sp = p.spirit
    if (!sp || p.alive) continue
    if (sp.rise > 0) {
      sp.rise -= 1
      if (sp.rise === 0) state.events.push({ type: 'spirit', pawn: p.id, owner: p.owner, x: sp.x, y: sp.y })
      continue
    }
    if (sp.cd > 0) sp.cd = Math.max(0, sp.cd - rate)
    const t = sp.target
    if (t) {
      const dx = t.x - sp.x
      const dy = t.y - sp.y
      const d = Math.sqrt(dx * dx + dy * dy)
      const s = SPIRIT_SPEED * DT
      if (d <= s) {
        sp.x = t.x
        sp.y = t.y
        sp.target = null
      } else {
        sp.x += (dx / d) * s
        sp.y += (dy / d) * s
        sp.facing = atan2(dy, dx)
      }
    }
    // the floor sinks: the band comes in, and nobody stands on the floor as a spirit
    const at = intoBand(state, sp.x, sp.y)
    sp.x = at.x
    sp.y = at.y
  }
}

/** A spirit's bolt: a weak Fireball whose knockouts read as the spirit's. */
export const spiritBoltProjectile: ProjectileBehavior = {
  collider: STD_PROJECTILE,
  onCollide(state, proj, hit) {
    if (hit.other.kind === 'pawn') {
      receiveDamage(state, hit.other.pawn, { amount: proj.data.damage, source: proj.owner, normal: { x: hit.nx, y: hit.ny }, knockbackFactor: proj.data.kb, cause: 'spirit' })
    } else {
      damageHitBody(state, proj, hit, { amount: proj.data.damage, source: proj.owner, normal: { x: hit.nx, y: hit.ny }, knockbackFactor: proj.data.kb })
    }
    destroyProjectile(state, proj, hit.otherId, hit.x, hit.y)
  },
}
