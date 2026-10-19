/**
 * Trailer edit decision list, counted in beats (4 to the bar) so the cut follows the music.
 * Cut to "No Safe Ground" (143.75 BPM, beat 0 at 0.07 s; scripts/showcase/beats.mjs):
 *   beats   0-8    hook: hits on beats 0 and 4 (splash, wordmark)
 *   beats   8-32   battle rhythm, mid energy; bar 28-32 dips before the lift
 *   beats  32-68   lift: brighter and louder, accent bar 48-52, part-one peak 64-68
 *   beats  68-76   breakdown (low end drops ~8 dB), rebuilding through 72-76
 *   beat   76      loudest re-entry; dense hits to 92
 *   beats  92-108  loud but sparse: heavy half-time phrases
 *   beats 108-132  densest, loudest climax (peak bar 120-124)
 *   beat  132      closing ensemble hit, dark decay to silence by ~beat 137
 *
 * v2: selective and cinematic rather than a spell catalogue. One Uber-bot match (ffa8 seed 8)
 * is the spine, from the opening reveal to the last two; bullet-time freezes carry the big
 * moments; the titles tell the core loop (knock them into the lava, knockback grows, the
 * arena shrinks, last one standing).
 *
 * clips: played back to back.
 *   shot   recorded take (src/render/showcase/shots/trailer.ts); null = black (the title
 *          layer covers it: the splash intro)
 *   beats  length on the timeline ('end' = to the end of the music)
 *   hitAt  beats into the clip where the take's key moment (cue sheet `sync`) lands
 *   from   instead of hitAt: start this many seconds into the take
 *   tag    spell name tag over the clip (bottom left)
 *   flash  flash on the clip's key moment ('ember' | 'white')
 *
 * titles: [beat, kind, fields]. Slams last `beats`; the end card runs to the end.
 */
export const BPM = 143.75

export const CLIPS = [
  // hook: splash art, the wordmark lands on the second hit (title layer)
  { shot: null, beats: 8 },
  // the bell: eight warlocks, the match the finale ends
  { shot: 't_reveal', beats: 6, from: 0.5 },
  // a long Fireball frozen mid-air on its way in; time returns, the knockout lands on beat 22
  { shot: 't_fireball_fz', beats: 11, hitAt: 8 },
  { shot: 't_scourge6', beats: 3, hitAt: 1.5 },
  // the dip before the lift: low slow motion
  { shot: 't_cluster', beats: 4, hitAt: 2 },
  // the lift: a burst of spells under "24 spells"
  { shot: 't_gravity', beats: 1, hitAt: 0.5 },
  { shot: 't_link', beats: 1, hitAt: 0.5 },
  { shot: 't_snowball', beats: 1, hitAt: 0.5 },
  { shot: 't_warpzone', beats: 1, hitAt: 0.5 },
  // riding a Homing missile into its target, frozen on the impact
  { shot: 't_bullet_homing', beats: 9, hitAt: 3.4 },
  { shot: 't_scourge7', beats: 3, hitAt: 2 },
  // accent bar: a heavy hit in slow motion
  { shot: 't_duel', beats: 4, hitAt: 1 },
  // knockback grows with damage: a hit, then a long flight into the lava
  { shot: 't_fire5', beats: 3, hitAt: 1.5 },
  { shot: 't_flight', beats: 9, hitAt: 5.8 },
  { shot: 't_chaos2', beats: 4, hitAt: 2 },
  // breakdown: a Lightning kill frozen in place, then a Scourge charges through the rebuild...
  { shot: 't_lightning_fz', beats: 6, hitAt: 1.5 },
  // ...and blows on the re-entry
  { shot: 't_scourge5', beats: 3, hitAt: 2, flash: 'white' },
  // re-entry: the fastest stretch
  { shot: 't_ffa_wide', beats: 4, hitAt: 2 },
  { shot: 't_fire3', beats: 1, hitAt: 0.25 },
  { shot: 't_thrust2', beats: 1, hitAt: 0.25 },
  { shot: 't_lightning2', beats: 2, hitAt: 0.5 },
  { shot: 't_cluster3', beats: 1, hitAt: 0.25 },
  { shot: 't_thrust3', beats: 1, hitAt: 0.25 },
  { shot: 't_drain2', beats: 1, hitAt: 0.25 },
  { shot: 't_multi2', beats: 2, hitAt: 1 },
  { shot: 't_esc3', beats: 2, hitAt: 1.25 },
  // half-time: heavy hits on the downbeats, slow orbits
  { shot: 't_fire6', beats: 4, hitAt: 0.5 },
  { shot: 't_twin2', beats: 4, hitAt: 2 },
  { shot: 't_top2', beats: 4, hitAt: 2 },
  { shot: 't_meteor2', beats: 4, hitAt: 2, flash: 'ember' },
  // climax: the last two (ffa8 seed 8): a Scourge into the lava, a Teleport back...
  { shot: 't_final_pre', beats: 4, hitAt: 2 },
  { shot: 't_final_a', beats: 4, hitAt: 1 },
  { shot: 't_final_tp', beats: 2, hitAt: 0.75 },
  // ...and the final Scourge on the loudest bar's downbeat (beat 120), frozen, then the fall
  { shot: 't_final_fz', beats: 14, hitAt: 2, flash: 'white' },
  // the closing hit: the end card over the winner
  { shot: 't_end', beats: 'end', from: 0.1 },
]

/** beat -> title. Beat 0 is the first beat of the music. */
export const TITLES = [
  [0, 'brand', { mark: 4, out: 8 }],
  [16.5, 'slam', { beats: 3.5, text: 'Knock them' }],
  [22, 'slam', { beats: 3, text: 'Into the lava' }],
  [32, 'slam', { beats: 4, text: '24 spells', hue: 'gold' }],
  [52.5, 'slam', { beats: 2.5, text: 'The more you bleed', size: 150 }],
  [60, 'slam', { beats: 4, text: 'the farther you fly', size: 150 }],
  [64.5, 'slam', { beats: 3.5, text: 'The arena shrinks', size: 160 }],
  [77.5, 'slam', { beats: 3.75, text: 'Up to 10 warlocks', size: 160, sub: 'Ranked · Multi-region' }],
  [127, 'slam', { beats: 4.75, text: 'Last one standing', size: 160, hue: 'gold' }],
  // teaser for the first share: no URL yet, the where-to-play reveal comes later
  [132, 'end', { line1: 'Coming to your browser soon' }],
]
