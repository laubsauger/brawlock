# Brawlock debut teaser

1920 × 1080, 16:9, 29.5 seconds. Splash, ten-warlock spell salvo, slow arena fly-through,
then cinematic combat and a lone survivor. Keep the approved emblem outro.

| Time | Picture | Narration |
| --- | --- | --- |
| 0.00–0.90 | Splash and wordmark hit. | Music. |
| 0.90–3.41 | Ten warlocks charge different spells together, then launch a synchronized salvo toward the lens. | Ten warlocks. (1.05s) |
| 3.41–5.91 | Fly from inside a battle up over the arena at 32% time scale; finish with the complete platform in view. | One arena. (3.60s) |
| 5.92–8.42 | Scourge blasts a full circle of eight enemies; all eight die in lava. Impact lands on the 6.75s downbeat. | No mercy. (5.92s) |
| 8.42–11.75 | Dive toward the Fireball target, complete a 360° orbit, then release into a Lightning detonation. | Music and spells breathe. |
| 11.75–14.27 | Over the caster’s shoulder: Grip, Snowball, Fireball and Lightning unload into one opponent. | No labels or explanation. |
| 14.27–16.77 | Opponents counterattack as a Meteor drops. The camera tilts with the fall; the impact kills one. | Music and impacts. |
| 16.77–20.10 | Snowball carries opponents, Thrust strikes through, then Bouncer ricochets through two victims. One dies to Bouncer and two to lava. Brief 55% speed at the ricochet. | Music and real hits. |
| 20.10–22.62 | Fireball and Meteor launch the last opponent into lava. | Final impacts. |
| 22.62–25.12 | Scourge cracks the ground, then the survivor raises both hands in the Ascendant celebration. Camera pushes into a low close-up. | Last one standing. (20.70s) |
| 25.12–29.50 | Approved emblem, wordmark, browser CTA and URL. | Brawlock. (25.60s) |

Audio uses one uninterrupted passage of No Safe Ground from 30.05217 seconds through its
original ending. No internal music edits. Sparse Maverick narration has gentler upper mids
and restrained dark arena reflections, with a soft dip in the music under speech. Raw voice
and older auditions are retained.

Capture uses real simulation casts, damage, knockback and lava deaths in private staged
scenes. The arena reveal uses ten Uber bots; the close battle insert is scripted through real spell inputs. Slow arena and Matrix takes render four temporal steps
per output frame with continuous pawn/projectile interpolation. Gameplay camera recoil,
nameplates, numbers and locator arrows are removed from the capture.

Sources: src/render/showcase/shots/teaser30v2.ts, scripts/showcase/teaser30v2.edl.mjs,
and scripts/showcase/teaser30v2_audio.mjs. Outputs: media/trailer/teaser30/v2/.
Earlier cuts remain intact for comparison; no publishing or deployment is part of this task.

Latest camera revision: `media/trailer/teaser30/v2/brawlock_debut_teaser_titled.mp4`.
Unused close-up and lava tests are separated under `v2/unused-tests/`; the active review
page lists only takes used in the cut. Victory staging calls the real round-win handler
after a real Scourge release; its rings and pose use the existing game renderer.

Battle revision replaces the unrelated bot pan with a 3.33-second exchange, cut from
0.35–3.68 seconds of the take so all three kills complete on screen. The existing classic
stone material is selected only for this private take, removing the calm floor’s albedo lift.
The game’s default floor and lighting remain unchanged.

Speech-timed Metal Mania titles share `NARRATION` with the voice edit: Ten Warlocks
at 1.05s, One Arena at 3.60s, No Mercy at 5.92s, Last One Standing at 20.70s.
The last line ends, including its reflection tail, at 22.07s; Brawlock stays at 25.60s,
leaving about 3.53 seconds for the final kill and summoning pose to breathe.
Music passage, SFX gain and shot edit are unchanged by this title revision.
