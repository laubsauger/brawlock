# Ability windup readability audit

Implementation and focused browser audit, 2026-10-18. This records the authored charge identities and cancellation contract. The lead’s final gallery and motion checks provide the complete final-revision visual gate; the browser findings below identify which captures this audit directly inspected.

The distinction to preserve is charge on the character → cancellation extinguishes it, or commit creates the released effect. A cancellable charge must not have a flight core, travel trail, muzzle burst, or emitted object that implies the shot already left. Spell identity needs a shape as well as its palette. Most windups last only 0.2 seconds, so a recognizable initial silhouette matters more than an elaborate late animation.

## Cancellable abilities

All times below come from `src/sim/spells/data.ts`. Module-owned signatures suppress the shared oversized arm-ring and spiral stack so their own shapes remain visible. The character's sleeve runes, pose, palm tint, and caster progress ring still support the charge. The six projectile hand marks and the strengthened Gravity spiral are camera-facing strokes rendered after the current pose and final camera update.

| Ability | Cast point | Implemented attached identity |
| --- | ---: | --- |
| Fireball | 0.2 s | Uneven flame outline, with three peaks, on the casting hand. |
| Boomerang | 0.2 s | Open copper crescent on the palm; no spinning preformed projectile. |
| Twin | 0.2 s | Two mirrored diamond marks, with no orbiting balls. |
| Cluster | 0.2 s | Four separated corner marks on the hand; no moving embers. |
| Bouncer | 0.2 s | Connected angular rebound/zigzag stroke. |
| Snowball | 0.2 s | Branching snowflake/frost strokes, with no charge sphere or free `castStart` particles. |
| Lightning | 0.2 s | Two short jagged arcs close across the fingers; narrow inward wrist arc, blue palm tint kept subordinate to the arcs; two-hand beam pose. No radial finger shots or free fork branches. |
| Homing | 0.2 s | Compact nested targeting-eye reticles directly on the hand, radius 24–30; no floating hot center. |
| Drain | 0.2 s | Three fixed inward curling tendrils at the palm, radius at most 27, height excursion 6. |
| Recharge | 0.2 s | Purple gauge/refresh seal on the hand, radius at most 33; progress changes its fill/brightness. |
| Redirector | 0.2 s | Bronze compass seal, radius 28, with a short settling needle confined to it. |
| Pact | 0.2 s | Crimson blood seal on the hand, radius 31. Free blood motes occur only in the committed buff. |
| Meteor | 0.2 s | Six-point violet sky seal on the real casting hand, radius 30, supported by the sky pose. Exact-target floor preview remains stationary. No floating overhead rune, giant palm orb, or free `castStart` motes. |
| Gravity | 0.2 s | Static attached inward spiral, added after the focused final-five capture found the original palm refraction too faint. The updated normal-camera Low/reduced-motion capture clearly shows the spiral. Free `castStart` motes removed; no black event horizon or projectile core. |
| Grip | 0.2 s | Three small static spectral hooks on the fingers, rather than orbiting glows; free `castStart` motes removed. |
| Link | 0.2 s | Short static green chain/loop mark runs inward from the real palm toward the wrist, rather than paying out or orbiting. |
| Magnetize | 0.2 s | Two clear opposed U/pole hand marks at the palm; no rotating/outward charge flow. The initial small brackets failed the Low/reduced-motion review, so the lead replaced them with the eighth explicit hand silhouette and refreshed the normal/Low captures. |
| Rockpillar | 0.2 s | Small earth-crack hand mark, radius 29, plus a stationary exact-target ground footprint. Flying grit begins with the committed summon. |
| Warpzone | 0.2 s | Compact teal hand clock, radius 30, plus the stationary exact-target aiming clock. Active dome/zone remains a committed state. |
| Scourge | 0.9 s | Local caster: crimson crown strokes on the real joined/raised hands, with brightness/detail by L1/L2/L3, plus the exact local radius preview. Others: only an immediate crimson body heartbeat; no full pose/radius/hand crown, free embers, or lingering ground ripples. |

Charge marks are immediate-mode and gated by a live started cast. Cancellation extinguishes them; shared cancellation strokes are a brief dim contraction at the current hand and honor Scourge visibility. A new charge or release clears the previous cancellation state. Scourge’s local target outline disassembles in place over 0.18 seconds without emitted shards or smoke; a POV change cannot retain a previous caster’s full-radius preview. Committed projectiles, beams, summons, buffs, impacts, and release effects retain their existing gameplay timing.

## Zero-cast-point abilities

These have no meaningful cancellable visual charge window. Adding one would misrepresent their current simulation. Their distinguishing effect belongs to commitment and the active state.

| Ability | Cast point | Current behavior/readability contract |
| --- | ---: | --- |
| Teleport | 0 s, immediate | Position change plus departure/arrival burst and linking streaks. Keep commit-only. |
| Thrust | 0 s, immediate | Lunge with committed movement/trail. Keep commit-only. |
| Swap | 0 s, immediate | Committed blue/cyan swap bolt and paired positional effects. Keep commit-only. |
| Windwalk | 0 s, immediate | Smoke transition and active spectral movement state. Keep commit-only. |
| Shield | 0 s, immediate | Gold defensive bubble and reversal ripple. Keep activation effects at commit. |
| Rush | 0 s, immediate | Gold/flame activation, active speed/absorption aura. Keep commit-only. |
| Alteration | 0 s, immediate | Gold-white activation and active surrounding wall. Keep commit-only. |
| Splitter | 0 s, ignore turn | Cast starts and fires in the same sim update; main bolt then spawner and child darts are committed states. Do not add a fake charge phase. |

Passive stat items have no cast or windup and are outside this pass.

## Focused browser evidence and findings

Two sequential Chrome/WebGPU runs used the real simulation lab at zoom 1100 and a 1440×900 viewport. Charge captured around 0.1 seconds into the cast; stop/cancel issued at 0.15 seconds; cancellation checked after 0.35 seconds. All recorded charge and cancelled states had zero projectiles; cancelled cast state was null.

1. Initial 14-spell pass: Lightning, Homing, Drain, Recharge, Redirector, Gravity, Grip, Link, Magnetize, Meteor, Rockpillar, Warpzone, Pact, Scourge. This exposed missed `castStart` particle implosions in Gravity, Grip, and Meteor; the same source existed in Snowball. The first pass also showed shared arm-ring stacks overwhelming Grip/Link and a white Lightning palm blob. These initial appearances are superseded by the fixes and final captures.
2. Corrected five-spell pass: Lightning, Gravity, Grip, Meteor, Link. Their `*-charge.png` and `*-cancel.png` files under `artifacts/ability-readability/` were recaptured after removing start bursts, suppressing generic module arm rings/spiral, and reducing Lightning’s base glow. Detailed results: `browser-results-five-final.json` (also originally written as `browser-results-lightning.json`; later lead runs may replace that filename). The initial 14-result JSON was overwritten by the five-spell script invocation; it is not retained as a separate 14-result report.

Direct visual inspection found:

- Homing’s eye and Drain’s inward curls read clearly as attached charge marks in the initial captures.
- Corrected Grip shows three finger hooks; corrected Link has a compact wrist loop/chain instead of the same luminous green tangle.
- Corrected Lightning keeps a small blue finger/wrist cue instead of the white blob.
- Corrected Meteor and Gravity have no detached precharge motes. Meteor’s stationary target seal disappears cleanly after cancel.
- Scourge’s local exact-radius preview remains readable, without the old floating orb. The early hand crown is subtle; opponent visibility is separately covered by regression tests.
- Gravity’s corrected charge was too faint in the focused final-five screenshot. The lead added a static inward spiral hand mark; direct inspection of the refreshed `gravity-low-charge.png` confirms this finding is resolved.
- The corrected five-spell browser run recorded one console resource 404 and no page exceptions. The lead’s URL-aware final runner identified the missing resource exclusively as `favicon.ico`; no required game asset was missing.

The lead refreshed all 20 cancellable abilities at normal camera distance and all 20 with Low FX/reduced motion. This reviewer directly inspected the final Low/reduced-motion charge captures for the 14 module-owned spells listed above. No false-flight form was visible. Gravity’s spiral resolved its earlier faintness. The reviewer reported one remaining issue: Magnetize’s small pole brackets collapsed to a blue hand tint. The lead replaced them with clear opposing U/pole hand marks and verified the refreshed normal/Low captures; they now read as a stable geometric hand mark rather than Lightning’s jagged wrist arcs. Other inspected identities retain recognizable shape or exact-target placement cues. Lead owns the motion/grayscale gate. Superseded initial captures are not proof of final appearance.

## Regression coverage

- `src/render/scene/CastMarks.test.ts`: distinct hand shapes without color or motion, bounded attachment over translation/camera/progress, cancellation contraction and dimming.
- `src/render/vfx/spells/scourge.windup.test.ts`: actual hand attachment, no free charge/cancel emissions, remote/spectator visibility, stale cast cleanup, POV changes while cancelling.
- `src/render/vfx/spells/castStart.test.ts`: Gravity, Grip, Meteor, and Snowball start events emit no free particles/smoke/ground FX.
- Existing character cast-style, sim cancellation, and windup tests preserve poses/visibility and cast timing.

## Code locations inspected

- `src/sim/spells/data.ts`: all 28 active definitions and cast points.
- `src/sim/pawn.ts`: immediate cast route; turn/windup/commit order.
- `src/render/character/castStyles.ts`: casting poses, hands, and Scourge visibility.
- `src/render/scene/MatchWorld.ts`, `CastMarks.ts`, and `Pawns.ts`: shared charge and cancellation rendering.
- `src/render/vfx/spells/kitA.ts`: immediate-mode palm charge base.
- `src/render/vfx/spells/*.ts`: all 26 spell-specific modules (Fireball and Teleport use scene-level rendering).

Final lead checks: the comparison page loads all twenty cards and six-card filter, charge/cancel images, grayscale and low-effects controls. Motion capture shows hand charge extinguishing without an outbound object on cancel; committed release introduces the bright muzzle flash and real traveling projectile. Browser POV probes confirm Scourge local radius count1, opponent/spectator radius count0, and all three views clear after cancellation.
