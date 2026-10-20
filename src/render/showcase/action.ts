/**
 * Dry run of a shot (sim only, deterministic) that records where everything
 * goes: pawn positions, projectile paths, deaths. Stage cameras fit their
 * framing to it, so the whole action (caster, full path, impact zone) is in
 * view from the first frame and the camera never has to chase.
 */
import { TICK_HZ } from '../../sim/types'
import { FLOOR } from './cam'
import { ShotSim } from './simShot'
import { speedAt, type ShotSpec } from './types'

export interface ActionSample {
  /** sim seconds */
  st: number
  x: number
  y: number
  h: number
  what: 'pawn' | 'proj'
  /** pawn owner or projectile owner */
  owner: number
  spell?: string
}

export interface ActionInfo {
  samples: ActionSample[]
  deaths: { owner: number; x: number; y: number; st: number; cause: string }[]
  /** sim seconds the shot covers */
  endSt: number
}

/** pawn body height used for framing (head + a bit of headroom) */
const BODY = 150

export function collectAction(spec: ShotSpec): ActionInfo {
  const sim = new ShotSim(spec)
  let st = 0
  const steps = spec.renderSubsteps ?? 1
  for (let vt = 0; vt < spec.dur - 1e-6; vt += 1 / 60)
    for (let j = 0; j < steps; j++) st += (1 / (60 * steps)) * speedAt(spec, vt + j / (60 * steps), st)
  const ticks = Math.ceil(st * TICK_HZ)
  const out: ActionInfo = { samples: [], deaths: [], endSt: st }
  const sample = () => {
    const s = sim.state
    const t = sim.st
    for (const p of s.pawns) {
      if (sim.hidden.has(p.owner) || !p.alive) continue
      out.samples.push({ st: t, x: p.x, y: p.y, h: FLOOR, what: 'pawn', owner: p.owner })
      out.samples.push({ st: t, x: p.x, y: p.y, h: FLOOR + BODY, what: 'pawn', owner: p.owner })
    }
    for (const p of s.projectiles) {
      const r = p.radius > 60 ? p.radius : 0
      const h = 70 + (typeof p.data.z === 'number' ? p.data.z : 0)
      out.samples.push({ st: t, x: p.x, y: p.y, h, what: 'proj', owner: p.owner, spell: p.spell })
      if (r > 0)
        for (const [dx, dy] of [
          [r, 0],
          [-r, 0],
          [0, r],
          [0, -r],
        ])
          out.samples.push({ st: t, x: p.x + dx, y: p.y + dy, h: FLOOR, what: 'proj', owner: p.owner, spell: p.spell })
    }
  }
  sample()
  for (let i = 0; i < ticks; i++) {
    const ev = sim.stepOnce()
    for (const e of ev) if (e.type === 'death') out.deaths.push({ owner: e.owner, x: e.x ?? 0, y: e.y ?? 0, st: sim.st, cause: e.cause ?? '' })
    if (i % 2 === 0) sample()
  }
  // the dead stay in frame (their death plays where they fell)
  for (const d of out.deaths) {
    out.samples.push({ st: d.st, x: d.x, y: d.y, h: FLOOR, what: 'pawn', owner: d.owner })
    out.samples.push({ st: d.st, x: d.x, y: d.y, h: FLOOR + BODY + 60, what: 'pawn', owner: d.owner })
  }
  return out
}
