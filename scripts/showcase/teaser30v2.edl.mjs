/** Debut teaser: splash, ten-spell salvo, eight-way blast, Matrix orbit, then escalating combat. */
export const BPM = 143.75
export const CLIPS = [
  { shot: null, beats: 2 },
  { shot: 's32_lineup', beats: 6, from: 0 },
  { shot: 's32_arena', beats: 6, from: 0 },
  { shot: 's32_ring', beats: 6, from: .183333333333 },
  { shot: 's32_matrix', beats: 8, from: 0 },
  { shot: 's32_unload', beats: 6, from: 0 },
  { shot: 's32_meteors', beats: 6, from: .1 },
  { shot: 's32_battle', beats: 8, from: .35 },
  { shot: 's32_final', beats: 6, from: 0 },
  { shot: 's32_winner', beats: 6, from: 0 },
  { shot: null, beats: 'end' },
]
export const TITLES = [
  [0, 'brand', { mark: 0, out: 2 }],
  // Keep the approved emblem end card and its hold exactly intact.
  [60, 'end', { emblem: true, line1: 'Play free in your browser', line2: 'brawlock.osc.link' }],
]

/** Voice and matching type share one timeline, in edit seconds. */
export const NARRATION = [
  { file: 'ten_arena.wav', at: 1.05, text: 'Ten warlocks.', title: { text: 'TEN WARLOCKS', until: 2.3, size: 166, y: -320, hue: 'ember' } },
  { file: 'one_arena.wav', at: 3.6, text: 'One arena.', title: { text: 'ONE ARENA', until: 4.8, size: 180, y: -320, hue: 'gold' } },
  { file: 'mercy_arena.wav', at: 5.92, text: 'No mercy.', title: { text: 'NO MERCY', until: 6.72, size: 200, y: -320, hue: 'ember' } },
  { file: 'standing_arena.wav', at: 20.7, text: 'Last one standing.', title: { text: 'LAST ONE STANDING', until: 22.35, size: 138, y: -330, hue: 'gold' } },
  // The approved emblem end card carries the final spoken brand.
  { file: 'brawlock_arena.wav', at: 25.6, text: 'Brawlock.' },
]
