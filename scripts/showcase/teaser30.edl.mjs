/** Eight deliberate shots; cuts on bars, with setup and payoff within the same take. */
export const BPM = 143.75
export const CLIPS = [
  { shot: 's30_arena', beats: 8, from: 0 },
  { shot: 's30_fireball', beats: 8, from: 0 },
  { shot: 's30_combo', beats: 12, from: 0 },
  { shot: 's30_grip', beats: 8, from: 0 },
  { shot: 's30_snowball', beats: 8, from: 0 },
  { shot: 's30_scourge', beats: 8, from: 0 },
  { shot: 's30_battle', beats: 8, from: 0 },
  { shot: null, beats: 'end' },
]
export const TITLES = [
  [0, 'caption', { beats: 8, text: 'Warlocks. One shrinking arena.', size: 66 }],
  [8, 'caption', { beats: 8, text: 'Knock them into the lava', size: 64 }],
  [16, 'caption', { beats: 12, text: 'Lightning × Fireball', sub: 'Detonate your own shot.' }],
  [28, 'caption', { beats: 8, text: 'Grip', sub: 'Root them. Line up the shot.' }],
  [36, 'caption', { beats: 8, text: 'Snowball', sub: 'Catch them. Carry them. Burst.' }],
  [44, 'caption', { beats: 8, text: 'Scourge' }],
  [52, 'caption', { beats: 8, text: 'Last one standing' }],
  [60, 'end', { emblem: true, line1: 'Play free in your browser', line2: 'brawlock.osc.link' }],
]
