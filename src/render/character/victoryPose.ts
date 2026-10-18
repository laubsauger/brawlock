export type VictoryStyle = 'dance' | 'summon' | 'flourish'

const STYLES: readonly VictoryStyle[] = ['summon', 'dance', 'flourish']

/** Cosmetic only: stable across peers, each winner cycles through all three poses. */
export function victoryStyle(round: number, player: number): VictoryStyle {
  return STYLES[(round + player) % STYLES.length]
}

export interface VictoryPose {
  overhead: number
  cross: number
  flare: number
  beam: number
  twist: number
  sway: number
  knee: number
  armWave: number
  elbowL: number
  elbowR: number
  bounce: number
}

export function newVictoryPose(): VictoryPose {
  return { overhead: 0, cross: 0, flare: 0, beam: 0, twist: 0, sway: 0, knee: 0, armWave: 0, elbowL: 0, elbowR: 0, bounce: 0 }
}

const ease = (t: number) => { const v = Math.max(0, Math.min(1, t)); return v * v * (3 - 2 * v) }

/** Sample into a reused object: no allocations, timers, simulation edits or new animation clips. */
export function sampleVictoryPose(style: VictoryStyle, age: number, motion: number, out: VictoryPose): void {
  const m = Math.max(0, Math.min(1, motion))
  // Reduced motion keeps each pose recognizable, settled and still.
  const t = m > 0 ? Math.max(0, age) : 1.6
  out.overhead = out.cross = out.flare = out.beam = out.twist = out.sway = out.knee = out.armWave = out.elbowL = out.elbowR = out.bounce = 0
  if (style === 'dance') {
    const beat = Math.sin(t * Math.PI * 3.4) * m
    const enter = ease(t / 0.3)
    out.flare = 0.58 * enter
    out.overhead = 0.04 * enter
    out.twist = 0.17 * beat
    out.sway = 0.12 * beat
    out.knee = 0.22 * beat
    out.armWave = 0.3 * beat
    out.elbowL = (0.32 + 0.14 * beat) * enter
    out.elbowR = (0.12 - 0.1 * beat) * enter
    out.bounce = 0.035 * (1 - Math.cos(t * Math.PI * 6.8)) * m * enter
  } else if (style === 'summon') {
    const rise = ease((t - 0.15) / 0.65)
    out.overhead = (0.2 + 0.67 * rise) * ease(t / 0.25)
    out.cross = 0.65 * (1 - rise) * ease(t / 0.15)
    out.elbowL = out.elbowR = 0.12 * rise
    out.twist = 0.025 * Math.sin(t * 3) * m * rise
  } else {
    const release = ease((t - 0.3) / 0.4)
    const open = ease((t - 0.9) / 0.55)
    out.cross = 0.85 * (1 - release) * ease(t / 0.25)
    out.beam = 0.9 * release * (1 - open) + 0.15 * open
    out.flare = 0.72 * open
    out.overhead = 0.12 * open
    out.twist = (-0.2 * (1 - release) + 0.25 * release * (1 - open)) * m * ease(t / 0.25)
    out.elbowL = 0.22 * open
    out.elbowR = 0.08 * open
  }
}
