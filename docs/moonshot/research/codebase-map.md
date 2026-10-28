# Codebase map: capabilities, seams and costs

Research input for the 12-month moonshot. It says what the code can already do, where big features would plug in, and what each would cost. Line numbers refer to the working tree on 2026-10-28 (base `e075b1d` plus the uncommitted King of the Hill seal work in `src/sim/hill.ts`, `src/sim/index.ts`, `src/bots/controller.ts` and others), so a few may shift by a line or two after that work lands.

Cost labels are rough, for one developer who knows the code: **S** up to 3 days, **M** 1 to 2 weeks, **L** 3 to 6 weeks, **XL** more. They include tests but not playtest iteration.

## 0. The short version

- The simulation is a clean, deterministic, plain-data core (`src/sim`). Everything else (net, replays, bots, render, audio, announcer) consumes `SimState` plus per-tick `SimEvent`s. Most big features are "add state to `SimState`, add events, teach consumers". Plain data means snapshots, hashes, keyframes and replays carry new state for free.
- **Spells** are data plus hook objects in a registry. A new spell is cheap in the sim (S) and expensive in presentation (VFX bar, audio, UI copy, bot knowledge, clips: M per spell). Cross-spell interactions have no general home; they are bespoke checks inside the acting spell.
- **The arena is one integer.** `ArenaState.layer` (`src/sim/types.ts:269-276`) derives every tile (`src/sim/arena.ts:22-28`). Per-tile state, non-ring shapes, ice or hazards need a real tile model, and 40 to 50 call sites across sim, bots, render, audio and game code (section 3) assume "a layer number is the arena". That refactor (L) is the single biggest unlock for new game design.
- **Modes are `if` branches**, not plug-ins (`src/sim/mode.ts:72-98`, `363-401`). King of the Hill shows the price: two commits touched 15 and 16 files, including five hardcoded mode lists in net/server validators.
- **Presentation has the pieces of a cinematic system but only in dev tooling.** Hit-stop exists (capped at 4 frames), a hero victory camera exists, and the trailer `Director` already does true slow motion with a scripted camera (`src/render/showcase/director.ts`). None of it can slow a live online match: the sim keeps running, so live slow motion means buffering states and catching up.
- **Replays are input streams tied to an exact build** (`scripts/net-id.mjs` hashes all of `src/sim` and `src/net`). Any sim edit makes every stored replay unplayable. That blocks long-lived clips, highlight sharing and a replay archive unless clips store render state or old sims stay loadable.
- **Bots** are strong but issue a new order on every think (10 per second for Hard and up) with no hysteresis between dodging and wandering; section 8 lists the likely sources of the "dance".
- **Platform** is real: two dedicated regions, accounts, Elo, cosmetics, analytics, an itch.io iframe build. A Discord Activity would reuse the itch build's iframe work but needs cookieless auth and a proxy-friendly network map.

## 1. Data flow in one screen

- Inputs: `InputCommand` (`src/sim/types.ts:141-150`) from humans (`src/game/input.ts`) and bots (`src/bots/index.ts`), validated by `validCommand` (`src/sim/index.ts:160-183`) and applied by `applyCommand` (`src/sim/pawn.ts:83-115`).
- Step order (`src/sim/index.ts:272-300`): commands, connection patches, pawn pre-tick (cast, walk with global friction, modifier hooks), projectile `onTick`, physics, projectile lifetimes and `onDestroy`, pillar timers, modifier timers, hill field (uncommitted), lava, phase and shrink, regen, cooldowns.
- Output: the mutated `SimState` (`src/sim/types.ts:477-499`) and `state.events` (`SimEvent` union, `src/sim/types.ts:374-475`), cleared at the start of each step.
- Consumers: `src/game/frame.ts` buffer (prev/curr plus a tick-stamped event log) read by render every frame, by audio and the announcer per tick, and by the HUD through rAF. Render reads through a `RenderSource` (`src/render/source.ts:8-40`), so a world can be fed from a private buffer (the menu backdrop does this).
- Tick rate: 30 Hz default, 60 Hz possible (`src/sim/types.ts:18-50`). Durations go through `ticks()` / `secondsOf()` (`src/sim/config.ts:211-219`).

## 2. Spells

### How a spell is defined

- **Numbers**: one `SpellDef` per spell (`src/sim/spells/data.ts:55` onward): column, cost, upgrade costs, target type, cast point, per-level cooldowns, per-level `levels` table and class constants. `attr(def, name, level)` (`data.ts:389`) reads them with the original's lookup rules.
- **Release gate**: `RELEASED_SPELLS` (`data.ts:15-51`) makes a spell buyable only once sim, tests and VFX exist.
- **Behavior**: hook objects in `src/sim/spells/types.ts`.
  - `SpellBehavior.onCast(ctx)` (`types.ts:22-25`) with `CastContext` (`types.ts:9-20`: caster, level, target point, per-cast `overrides` that Pact uses for x1.5 damage).
  - `ProjectileBehavior` (`types.ts:27-49`): `collider` (static or per instance), `onTick`, `onCollide`, `onDestroy`, `onReflect`, plus capability flags `ignoresDamage`, `notProjectile`, `noGravity`, `noSteer`.
  - `ModifierBehavior` for buffs, debuffs and spell states (`src/sim/modifiers.ts:31-49`): `onApply`, `onRemove`, `onPreTick`, `onSpellCast`, `modifyDamagePostKB`, a temporary `collider`, `onColliderHit`, `bodyMask`.
- **Registry**: `SPELL_BEHAVIORS`, `PROJECTILE_BEHAVIORS` (keyed by `ProjectileState.kind ?? spell`) and `registerModifiers` in `src/sim/spells/index.ts:40-115`.
- **Collision**: three channels (player, projectile, obstacle), an accept matrix per alliance (self, ally, enemy), an initiative order and per-profile flags (`src/sim/collision.ts:8-65`). Physics resolves swept circles in time-of-impact order and notifies each side (`src/sim/physics.ts:274-340`).
- **State payloads** are `Record<string, number>` on projectiles and modifiers (`src/sim/types.ts:188`, `245`). Numbers only: no strings, arrays or nested objects in spell state.

Worked example: Snowball (`src/sim/spells/snowball.ts`, 84 lines) spawns a projectile with its numbers in `data`, drags enemies in `onCollide`, applies a chill modifier, explodes in `onDestroy` with `damageArea`, and declares `ignoresDamage`. Gravity (`src/sim/spells/gravity.ts`, 86 lines) pulls enemy pawns and every projectile in range in its `onTick`.

### Cost of a new spell

A new spell touches, besides its sim file and tests:

| Layer | Files |
|---|---|
| Sim | `spells/<id>.ts`, `spells/data.ts` (def + `RELEASED_SPELLS`), `spells/index.ts`, maybe `collision.ts` for a new profile |
| Bots | `src/bots/spells.ts` (`BOT_SPELLS` role, speed, range), `src/bots/plan.ts` (build pools); special handling in `controller.ts` if it is not a plain bolt |
| Render | `src/render/vfx/spells/<id>.ts` registered in `vfx/spells/index.ts`, `vfx/palette.ts`, `render/character/castStyles.ts`, death mapping in `render/character/warlock.ts:83`, `scene/CastMarks.ts` |
| Audio | `src/audio/events.ts` cue tables, synth recipes or samples in `audio/assets.ts` |
| UI | `src/ui/data/catalog.ts` copy, `ui/data/abilityStats.ts`, `ui/icons.tsx`, `src/game/stats.ts` |
| Media | the spell's hover clip in `public/media/abilities/index.json` (showcase pipeline) |

Estimate: sim and tests S; VFX at the project's bar (layers, windup, impact, death look, power tiers) M; audio, bot knowledge, copy and clip S each. Roughly M per spell in total, dominated by presentation. Every sim change also changes the netcode id, which retires old replays (section 7).

### Interactions: where they live today

- Projectile against projectile is the collision matrix: a standard bolt accepts enemy projectiles and both usually die (`fireball.ts` `simpleProjectile`).
- Field effects iterate the world in `onTick`: Gravity bends every projectile within 600, its caster's own included, unless the target's behavior says `noGravity` (`gravity.ts` `onTick`). Warpzone scales other projectiles' time (`ProjectileState.data.timeScale`, read by `projectiles.ts:75-89` and physics).
- Combos are named checks inside the acting spell: Lightning detonates Fireballs with `kindOf(proj) === 'fireball'` (`src/sim/spells/lightning.ts:39-78`).
- Pawn states change collision through modifier colliders and body masks (Shield, Alteration, Thrust, Windwalk).

There is **no tag or element system and no interaction table**. "Fireball through Gravity" already happens mechanically (it bends), but a transformation (Fireball grows, ignites) would be another named check in `gravity.ts`. A designer-driven interaction set would want: numeric tags on `ProjectileBehavior` (fire, ice, arcane), an interaction registry consulted where two bodies meet (`physics.ts` `notify`) and where fields act (`onTick`), and a rule that each pairing lives in one place. Cost: framework M, then S per interaction plus its VFX.

**Spell to environment** has two precedents only: Rockpillar pushes a temporary obstacle into `state.obstacles` (`src/sim/spells/rockpillar.ts:14-28`), and the hill seal is a bespoke post-physics correction pass (`src/sim/hill.ts:134-199`, called from `src/sim/index.ts:276` and `294`) because the collision system only knows circles. Lava is a point test, not a body. "Snowball freezes lava into temporary ground" therefore needs the tile model of section 3 (a per-tile override with a timer), not just a spell file.

**Scale note**: the pair loop in `physics.ts:278-296` is O(n^2) with an x-interval reject. Fine for about 60 bodies (10 pawns, their bolts, pillars). A bullet-hell spell family (dozens of child projectiles each) would need a real broadphase first (S to M).

## 3. Arena

### Model

- `src/sim/arena.ts`: layer L has radius (L - 1) x 100; tile (gx, gy), |g| <= 20, exists iff its centre (192 gx, 192 gy) is inside that radius (`arena.ts:18-28`). A point is safe iff its nearest cell exists (`arena.ts:31-42`). Corner rounding is visual (`arena.ts:64-76`).
- `ArenaState` is `{ layer, nextShrinkTick, theme }` (`src/sim/types.ts:269-276`). Shrinking is `layer -= 1` (`src/sim/mode.ts:363-374`). Fight size is `13 + players` (`mode.ts:219-220`), the shop platform is layer 14 (`src/sim/config.ts:68`).
- Lava: every 0.25 s each pawn whose nearest cell is missing burns `lavaDps x 0.25` (`src/sim/lava.ts:13-28`).
- Friction is one match setting applied to every pawn (`src/sim/index.ts:287`, `src/sim/pawn.ts:151-181`).
- Outer wall: a hard circle at 5910 (`src/sim/physics.ts:250-262`).
- Pillars are circles in `state.obstacles`, re-rolled every shop (`mode.ts:140-158`).

### Who assumes "arena = layer"

| Area | Call sites |
|---|---|
| Sim | `lava.ts:21`, `spawn.ts:85` (spawn ring from `layerRadius`), `mode.ts:116, 172, 200, 219`, `hill.ts:76, 112`, `spells/link.ts:134` |
| Bots | `src/bots/arena.ts` (helpers and a tile cache keyed by layer, `arena.ts:64-81`), `src/bots/predict.ts:46` (`lavaOutcome` takes a layer and global friction), `controller.ts` about 13 sites (424, 677, 964, 1174, 1203, 1224, 1254, 1273-1280 `safetyLayer`, 1338, 1350, 1367, 1457, 1469) |
| Render | `src/render/arenaGeom.ts:36-55` (adapters), `scene/Arena.ts:259-321` (`setLayer`), `scene/Pawns.ts:483, 748`, `scene/MatchWorld.ts` about 14 sites (481-482, 603, 610, 1235, 1322, 1583, 1704-1705, 1775, 1800, 2185, 2196, 2395, 2407), `scene/props/obstacles.ts:193`, `scene/HillField.ts:22-28`, SDF `arenaGeom.ts:118-160` |
| Audio | `src/audio/engine.ts:530` (lava edge ambience) |
| Game | `src/game/teleportSave.ts:53-74` ("Denied!" call), `src/game/announcer.ts:483` ("Hurry Up!" by `tileCount(layer)`), `src/game/practiceScenario.ts:63` |

### What per-tile state would take

Feasible, and the render side is already per tile internally. A design that keeps the original arena as the default:

- **Sim**: add a tile grid to `ArenaState` (41 x 41 cells; a flat number array of tile kinds and timers, or a list of overrides on top of the layer rule). Route every safety test through one function that reads it. Shrink becomes "remove this ring's cells" (or any removal order, which also gives non-ring shapes and scripted arenas). Lava damage, friction (`walkPreTick`), and new hazards (vents, cracked tiles that fall after N steps, ice) read the cell under the pawn. Spawns need a "pick safe cells" rule instead of a radius. M for the core, plus S per tile kind.
- **Bots**: replace layer-keyed helpers with tile-set-keyed ones (`bots/arena.ts`), give `safetyLayer` a "tile set after the next removal" equivalent, and make `predict.ts` slides read per-tile friction, or bots will misjudge ice. M. Ladder recalibration afterwards.
- **Render**: `Arena.setLayer` already diffs a set of cells into sink and rise animations; it would take a cell set instead. The per-instance `aTile` attribute is full (seed, removedAt, addedAt, ring at `Arena.ts:376-383`), so tile kinds need one more instanced attribute and shader branches (frozen, cracked, hazard looks). The lava SDF is a CPU distance transform of 160 x 160 texels (`arenaGeom.ts:118-160`); fine on a removal event, too slow to redo every tick, so dirty-flag it. Render covers only |g| <= 10 (`arenaGeom.ts:12`, radius 2000) and an SDF extent of 2400 (`arenaGeom.ts:63`); larger or off-centre arenas need both raised. M to L including art for each tile kind.
- **Net and replays**: free in principle. State is plain data, so snapshots, hashes, keyframes and replays carry the grid. Snapshot size grows by about 3.4 KB of JSON uncompressed for a full 41 x 41 grid of one-digit kinds (spectators and keyframes only; the input stream does not carry state).
- **Audio and announcer**: lava edge ambience and "Hurry Up!" count tiles by layer; small changes.

Overall: **L** for the refactor plus first new tile kinds. It is the prerequisite for frozen lava, destructible or cracking floors, non-ring shapes, hazards and per-tile friction.

## 4. Modes, options and the dead

### Mode structure

`GameMode` is a string union (`src/sim/types.ts:68`). Rules branch on it in `mode.ts` helpers (`isDeathmatch`, `isHill`, `hillFight`, `shrinkPeriod`, `arenaFloor` at `mode.ts:72-98`) inside `startRound` (`186-237`), `onKill` (`247-262`), `roundWon` (`269-297`), `endRound` (`334-348`) and `phaseTick` (`363-401`). King of the Hill keeps its own rules in `src/sim/hill.ts` and hooks into those branches, plus optional state `SimState.hill` (`types.ts:278-297`).

Adding a mode, judged by the hill commits (`7667752`: 15 files; `06598ea`: 16 files):

- Sim: rules module, branches in `mode.ts`, settings and constants in `config.ts`, state and events in `types.ts`, shop rule tweaks (`src/sim/shop.ts:37-51`).
- Hardcoded mode lists that reject unknown modes: `src/net/listings.ts:65`, `src/net/feedback.ts:65, 167`, `src/net/matchHistory.ts:29`, `src/net/ratingAuthority.ts:88`, `src/net/leaderboard.ts:494`.
- Server queues: presets in `src/net/server.ts:102-116`, routed by `?mode=` at `server.ts:565`.
- UI: `src/ui/screens/MatchOptions.tsx:18-55` (mode list, hints, rules text), HUD panels (`src/ui/hud/HillStatus.tsx`), `TopBar.tsx`, `Results.tsx`, `src/ui/flow.ts`, quick play entry.
- Presentation: announcer lines (`src/game/announcer.ts`), audio events, render (`HillBeacon.ts`, `HillField.ts`, arena shader uniforms `Arena.ts:150-160`).
- Bots: objective logic (`controller.ts` `hillPull` 999-1005, `pickHillWander` 1362-1397), presets knob, build weights.

A new mode costs **M to L**. Extracting a `ModeRules` interface (round start, kill, round won, phase tick, win check) would make later modes cheaper; worthwhile if the moonshot plans three or more.

### Options and mutators

- Existing global knobs that already act as mutators: `kbMultiplier`, `dmgMultiplier`, `friction`, `lavaDps`, gold values, `shopSeconds` (`src/sim/types.ts:70-95`, defaults `src/sim/config.ts:188-208`).
- Flow: `MatchOptions.tsx:68-71` calls `session.updateSettings(patch)` and `rememberRoomOptions` (`src/game/roomOptions.ts`); `src/net/session.ts:2669-2676` forwards an owner's change (`ctl` op `settings`) or applies it and publishes the lobby; incoming patches pass `sanitizeSettingsPatch` (`src/net/protocol.ts:393-404`); the match starts with `createMatch`, which runs `sanitizeSettings` (`src/sim/index.ts:90-105`).
- Constraints: a settings key must exist in `DEFAULT_SETTINGS` and hold a number, boolean or string of at most 16 characters (`protocol.ts:397-401`). Arrays or objects are dropped silently. Negative or non-finite numbers revert to defaults (`sim/index.ts:98-103`). Lobby votes cover the four gold settings only (`src/net/lobbyVotes.ts:6-11`).
- A mutator system therefore fits as booleans or one short string key per mutator in `MatchSettings`, with effects in `step` or as always-on modifiers. Rule mutators that change physics or the arena depend on section 3. Cost: framework S, each mutator S (sim) plus its UI and any VFX.

### What dead or eliminated players can do

- Spectate: follow any living warlock (`spectateTarget`, `src/render/cameraRig.ts:77-86`), click names in the top bar.
- Bet: one 1-gold stake per round on a living player while three or more are alive, Rounds mode only (`src/sim/bets.ts:54-74`; pool payouts and bounties in the same file). The UI disables betting outside Rounds (`MatchOptions.tsx:114-117`).
- Shop: buy while dead (`src/sim/shop.ts:44-51`), Fresh start in respawn modes.
- Chat.

They cannot affect the fight. The seam for "ghost" mechanics (curses, lava geysers triggered by the dead, audience votes) is the same path `spectateBet` uses: a new `InputCommand` kind (`types.ts:141-150`), validation (`sim/index.ts:160-183`), handling in `applyCommand` (`pawn.ts:83-115`). It rides the existing input stream at no extra net cost.

## 5. Render and presentation

### Structure

- `MatchView.tsx` owns one `MatchWorld` (`src/render/scene/MatchWorld.ts`, 2594 lines) and calls `update(dt x devTime.scale)` per frame (`MatchView.tsx:231`). `MatchWorld.update` (`630` onward) interpolates prev to curr by wall time (`683`), consumes events, runs VFX modules, pawns, projectiles, arena, overlay and camera.
- **VFX kit**: plugin contract in `src/render/vfx/registry.ts` (doc at lines 1-28, `VfxCtx` services 61-189, `SpellVfx` 192-235, `registerSpellVfx` 236). Services include stateless GPU particles, smoke, debris, billboards, ground rings, scorches, contact shadows, glow lights, `aoeRing` at the exact gameplay radius, `afterHit`, `pawnDeathFx`, `pawnVisibility`, `shake`, `kick`, `hitStop`, combat text and the spell power tier. Modules claim events and projectiles by spell id. 31 modules (spells plus shared frame, death and after-hit modules) are imported in `src/render/vfx/spells/index.ts`; identity colours in `vfx/palette.ts`.
- **Particles** are written once into ring buffers and evaluated analytically in the vertex shader from spawn time (`src/render/scene/Particles.ts:8-14`). Every effect follows the world clock, so scaling the clock slows all of them consistently.
- **Deaths by cause**: `src/render/vfx/deathKit.ts` (helpers listed at lines 27-45, claiming at 171-178), composed in `vfx/spells/deaths.ts`, `deathsA.ts`, `deathsB.ts`; body looks `DeathKind` in `src/render/character/types.ts:24` (ash, lava, fireball, meteor, lightning, freeze, gravity, drain, shadow, fade).
- **Camera**: one rig (`src/render/cameraRig.ts`): fixed 60 degree pitch and Dota FOV (`59-63`), the original zoom model plus an overview zoom (`17-49`), smoothed follow, trauma shake and a directional kick spring (`132-180`), spectate target, free focus for replays (`88-91`).
- **Victory camera**: on a round win with one survivor the world slerps toward a low hero shot (`victoryCamera.ts`, used at `MatchWorld.ts:1283-1290` and `2501-2525`).
- **Post** (`src/render/RenderLoop.tsx:74-200`): scene pass (MSAA on High+), heat haze from an MRT channel, GTAO, bloom, a hurt flash with chromatic split, vignette, colour grade, ACES, FXAA, grain. No depth of field, motion blur, radial blur or desaturation pass. The hurt amount comes from `postState` (`MatchWorld.ts:56`).
- **Quality tiers**: one table (`src/render/quality.ts:39-44`); dynamic resolution (`GpuCanvas.tsx:47`); the WebGL2 fallback is forced to Low (`GpuCanvas.tsx:123-127`).
- **Overlays**: DOM plates, combat numbers, callouts ("Smash!" at `MatchWorld.ts:1184-1187`), kill stamps (`src/render/overlay/WorldOverlay.ts:13-29`, `killStamps.ts`).
- **Menu backdrop**: a real seeded match between Brutal and Uber bots on a private render source with a drifting camera (`src/render/MenuBackdrop.tsx`, `src/render/menuStage.ts:36-46`).
- **Showcase tooling** (excluded from the app build): `src/render/showcase/director.ts` steps the sim on a virtual clock with a time scale, writes the frame buffer at exact sub-tick times and drives a cinematic camera override (`showcase/camRig.ts:14-55`), plus overlay titles.

### Hit-stop and slow motion today

- Hit-stop: 2 to 4 frames when the local pawn takes a big hit (`MatchWorld.ts:1182`), requestable by VFX modules but capped at 4/60 s (`494-495`). While frozen the world clock stops, the last snapshot is held and events wait (`MatchWorld.ts:630-690`).
- Slow motion: only `devTime.scale` (`src/render/stats.ts:46-47`) in dev labs and the showcase director. In a live match it would slow effects but not positions, because interpolation follows wall time and the sim keeps stepping.

### What a "cinematic final blow" needs

1. **Trigger.** The death event and the round result come in the same tick (`src/sim/combat.ts:136-137` pushes `death`, then `onKill` calls `roundWon`). But 85% of deaths are lava burns after the push (`docs/PLAN.md` §7), so the dramatic moment is the hit that seals it, often seconds earlier. Detecting "this hit will kill" needs a forecast: `lavaOutcome` in `src/bots/predict.ts:40-70` and `src/game/teleportSave.ts` already simulate a slide into lava. Alternative: trigger on the death and replay the last seconds (instant replay).
2. **Time control.** Keep a ring buffer of recent states on the client (clones every few ticks; cheap), then play them through a private or swapped `RenderSource` on a virtual clock, as `director.ts` does, while the world clock runs at the same scale. The live sim keeps going; catch up afterwards. Rounds give 3 s of slack (`ROUND_END_SECONDS`, `src/sim/config.ts:106`). The match-winning blow does not: results open 600 ms after `gameOver` (`GAME_OVER_LINGER_MS`, `src/net/session.ts:317`), so that hold must grow or the cinematic must play over the results.
3. **Online timing.** Clients show only authoritative `death`, `roundWin` and `gameOver` (`src/net/predict.ts:64`), which arrive after the predicted visuals. A replay-style cinematic suits this; a live freeze at the moment of the hit does not.
4. **Camera.** Promote the showcase's pose override into shipping code: a short push toward the victim with a hold, blended the way the victory camera is.
5. **Post and audio.** Add uniforms for desaturation, radial blur or a vignette push in `RenderLoop.tsx`, and a low-pass or duck on the SFX bus (the duck node exists, section 6).
6. **Guard rails.** Respect reduced motion (`MatchWorld` already checks it), never hide the next round's start, and make it skippable.

Estimate: **M** for an offline and online "replay the final blow during round end" version, mostly by reusing director concepts; **L** for a live freeze with predicted lethal hits and a polished camera language.

## 6. Audio

- **Engine** (`src/audio/engine.ts`, 904 lines): one `AudioContext` created on unlock; buses master, SFX (through a duck node), UI, music, ambience and announcer, a shared reverb send, glue compressor, limiter and soft clip (graph at `engine.ts:1-12` and `248-306`). Voice limits and loudness trims per sound, random variants, positional pan and falloff from the camera listener.
- **Event mapping**: `playEvents` (`engine.ts:455`) receives every tick's sim events and state; cue tables live in `src/audio/events.ts`. Recorded samples load lazily into a `SampleBank` of decoded buffers (`src/audio/samples.ts`); until then the procedural synth (`audio/synth.ts`) plays.
- **Music**: menu songs stream through one `HTMLAudioElement` routed into the music bus (`src/audio/menuMusic.ts:1-50`). Shop and fight music are switched off on purpose: `SYNTH_MUSIC` is empty (`engine.ts:15-16`, `applyMusic` at `740-765`). The synthesized `MusicLayer` (`src/audio/music.ts`) still exists and has an `intensity` input that `playEvents` already drives from arena shrinks (`engine.ts:465-473`).
- **Announcer**: `src/game/announcer.ts` is pure and deterministic, fed by the same events; it picks one line at a time by priority (first blood, multi-kills, streaks, round flow, hill calls, "Denied!", "Close Call!") and sends it to both the voice and the HUD banner.

**Adaptive or stem music is feasible.** The hook exists (per-tick events and state, plus an intensity signal), the bus graph has a music bus with its own reverb send, and the sample path decodes buffers. Stems must be decoded `AudioBuffer`s started at one context time to stay sample-locked; separate `HTMLAudioElement` streams drift. Memory is the constraint: a decoded 3-minute stereo stem at 48 kHz is about 69 MB, so prefer 30 to 60 s loops per section (about 11 to 23 MB per stem) or lazy section loading. State inputs worth using: phase (shop, fight, round end), arena layer, alive count, local HP and knockback points, hill state, kill events. Estimate: engine M; the music itself (composition, stems, mixing) is the real cost and is a user decision (`docs/NEXT-SPRINT.md` item 1).

## 7. Replays, spectating and netcode

### Netcode

- Modes: `predict` (default input stream), `snapshot`, `classic` (`docs/PLAN.md` §4.4).
- Input stream (`src/net/stream.ts:1-60`): the authority sends the confirmed inputs of each step the tick it runs it, steps with inputs ride three packets, empty stretches go out as heartbeats, a gap is resent from 3 s of history, a state hash goes out every second, and a mismatch or a gap beyond history triggers a keyframe snapshot.
- Prediction (`src/net/predict.ts:1-64`): the client re-simulates from the newest confirmed state to its predicted present (cap `ticks(0.5)`, `predict.ts:43-52`), smooths corrections (snap above 250 units), plays each event once across timelines and takes match-flow events only from the authority.
- Session (`src/net/session.ts`, 2975 lines): host and client roles, P2P and dedicated. Clients build the start state themselves from settings, slots and seed and ask for the stream from tick 0 (`session.ts:2001-2022`); the host answers with a keyframe when its history cannot cover the request (`onNeed`, `session.ts:1323-1330`).

### Replays

- Format (`src/game/replay/format.ts:1-60`): start state, the confirmed input steps, connection patches, roster changes, keyframe resyncs, a hash every 5 s, round and kill markers. Gzipped, about 100 to 300 KB for a 10-minute match (`docs/M4.md` line 204).
- Recording: `src/game/replay/recorder.ts`, fed by the session's `MatchRecorder.step` hook (`src/net/session.ts:123-135`). Only peers that step the stream record; snapshot spectators record nothing (`recorder.ts:1-9`). Dedicated servers do not record replays: their recorder (`src/net/dedicated.ts:262-270`) wires stats only, not `step`.
- Playback: `src/game/replay/player.ts` re-simulates with keyframes for seeking; `viewer.ts` plays at 0.25x to 4x with follow or free camera (`viewer.ts:23-27`). Storage is IndexedDB, newest 20 plus pinned (`src/game/replay/store.ts:1-8`).
- **Build lock**: a replay plays only with the netcode id that recorded it (`format.ts:11-13`), and `scripts/net-id.mjs:9-26` hashes every non-test `.ts` file in `src/sim` and `src/net` plus the cosmetics catalog. Any sim or net edit, even a comment, orphans every replay. For clips, highlights, a public replay archive or "watch the pros", choose one: keep old sim bundles loadable by netcode id (versioned sim chunks), or record render-level state for clips (positions and events per tick; larger but build-independent).
- Small inconsistency: `KEYFRAME_EVERY = 600` (`player.ts:18`) is a tick literal documented as 10 s; at the default 30 Hz it is 20 s. Seeks are slower than intended; the project rule says to use `ticks()`.

### Spectating

Spectators receive full JSON state snapshots, not the input stream (`sendSnapshots`, `src/net/session.ts:1642-1660`; "spectators use snapshots" in PLAN §4.4). At 10 players that is a player's whole snapshot downlink (`docs/M4.md` line 220 puts snapshot mode at 150 to 300 KB/s at 60 Hz). Fine for a few watchers per room; a broadcast or Discord stage audience needs the stream plus keyframes for spectators, or a relay that fans one stream out (M). Delayed competitive spectating is deferred (`docs/PLAN.md` §12).

### Starting from an arbitrary SimState

- **Offline: yes, today.** The sim is plain data with `cloneState` (`src/sim/snapshot.ts:19`). Practice builds a match, then edits the state directly (`src/game/practiceScenario.ts:22-46`) and runs its own loop into the shared frame buffer, reusing renderer, input and audio (`src/game/practice.ts:15-30`). The menu stage and the showcase do the same. "Play from here" in the replay viewer is this pattern with a replay state: S to M (UI, choosing seats, fresh bots).
- **Kill cams and clips**: re-simulate from a cloned state with the recorded inputs. Bots do not need to run (their commands are in the input stream). Cheap: a 10-minute match re-simulates in well under a second (`docs/M4.md` line 210: 36k ticks in about 0.3 s).
- **Online "start from state"**: the client path already accepts a keyframe in place of its own `createMatch` result. A host that starts from an injected state needs a start flag that tells clients to wait for the keyframe instead of building tick 0 (S to M). Bots are stateful (reaction queue, grudges, memory), reset when the tick goes backwards (`src/bots/index.ts:6-9`); from an injected state they start fresh, which is fine but not a faithful continuation.

## 8. Bots

### Structure

- Contract: `Bot.think(state) -> InputCommand[]` plus optional `scheduled()` plans the host relays as prediction hints (`src/bots/index.ts:15-26`).
- `BotController` (`src/bots/controller.ts`, 1597 lines): `think` (`283-324`) runs `decide` every `thinkInterval` and queues its orders `reactionDelay` later (dithered between whole ticks, `336-340`); between decisions a pillar `unstick` reflex runs every 0.1 s.
- `decide` (`390-659`) is a priority list: buy, Teleport save, Shield reflect, Teleport dodge, lava escape, area threats, retarget, wander point, cast lock, Scourge channel, dodge, Scourge, Lightning combo, Thrust, offensive Teleport, punish, shoot, walk off lava, and finally walk to the wander point.
- Helpers: danger field and analytic dodge gradient (`src/bots/danger.ts`), area threats (`threats.ts`), slide and lava forecasts (`predict.ts`), pillar routing (`pillars.ts`), lead aim (`aim.ts`), seeded builds (`plan.ts`), knobs (`presets.ts`; Hard, Brutal and Uber think every 0.1 s with 0.18, 0.15 and 0.12 s reaction, `presets.ts:18-19`).
- Calibration and checks: `scripts/bots/elo.ts`, `scripts/bots/ffa.ts`, `LADDER=1 npx vitest run src/bots/ladder.test.ts`. `lastAction` exposes each decision for debug overlays.

### Likely sources of the "dance on the spot"

Ranked by how likely each is to produce visible, inhuman back-and-forth. Nothing here was changed.

1. **A new move order every think, with no commitment.** Every `decide` that neither casts nor idles ends in a move or stop order: `wander`, `dodge`, `offLava`, `hold` (`controller.ts:640-658`). For Hard and up that is up to 10 orders a second (thinkInterval 0.1 s). The sim walks only once the pawn faces within 0.2 rad of its goal and has no acceleration (`src/sim/pawn.ts:151-181`, `FACING_TOLERANCE` `src/sim/config.ts:31`), so each reversal is an instant stop, a turn of a few ticks and an instant start. PLAN §7 lists an "action rate cap" as a difficulty knob; `presets.ts` has none.
2. **Wander re-pick on arrival, every think.** The wander point is re-picked whenever the bot is within 100 units of it (`controller.ts:507-514`, `WANDER_ARRIVE_DIST` at `62`). Both scored pickers include "stay where I am" as a candidate (`consider({x: me.x, y: me.y})` at `1390` and `1432`). When standing still wins, the next think is inside 100 units again, so it re-picks from fresh random candidates every 0.1 s, and any candidate that scores slightly higher sends the bot off in a new direction. Stop, step, stop, step.
3. **No hysteresis between dodging and wandering.** `mustDodge = danger >= dodgeThreshold` (`controller.ts:529`, threshold 2.5 for Hard and up) has no exit margin. A threshold of 2.5 is crossed by any single enemy bolt within 2000 units whose flight line passes within about 400 units of the predicted position, and several bolts add up (`danger.ts:15-31`). The dodge orders a move 5000 units down the gradient (`DODGE_REACH`, `76`; `dodgeMove` `1504-1532`); as soon as the bot is just outside the band, the next think walks it back toward its wander point, which re-enters the band. Slow orbs keep this up for seconds (Snowball 400 u/s, Gravity 450, Drain 700 within 2000 units). The dodge side is remembered only for two thinks (`1507`), so a single wander think in between can flip the side.
4. **Duel strafing around a moving target (Brutal, Uber).** With `edgePressure`, the wander point is re-drawn every 0.3 to 0.6 s at a random angle of plus or minus 0.5 rad and a random radius around the target (`1315-1327`). Consecutive points can sit about 600 units apart sideways, so the bot reverses regularly. `far` flips between 450-650 and 700-850 whenever the target's Shield readiness changes (`1315`, `1321`), adding a forward-back pulse.
5. **King of the Hill indecision.** Each pick rolls `hillDrive` (`1364`) and, on a crowded hill, a second random gate (`1372-1373`), so successive picks alternate between "go onto the hill" and "hang back and shoot". On the hill, candidates are tile centres re-jittered by plus or minus 50 units on every pick (`1394`); combined with source 2 this produces short random steps around the centre. In the uncommitted seal work, `pickHillWander` does not check `hillSealed`, so during the 5 s seal bots keep walking at the force field, which stops them and slides them along its edge (`src/sim/hill.ts:134-199`); jittered goals flip the slide direction. *Checked afterwards (2026-10-28, bot-only hill matches of 2, 4 and 8 bots): the effect is small. Bots touch the field 1 to 27% of the sealed time, reverse heading 0.3 to 0.4 times a second while it is up (under their usual fight rate), and step on about 0.2 s after it opens. The seal shipped without a change here (`4f8af62`).*
6. **FFA position scoring re-rolled from scratch.** `pickFfaWander` (`1402-1445`) draws 12 random candidates every 0.4 to 0.8 s and moves to the best; scores include live projectile danger, so the best point jumps between nearly equal options on opposite sides.
7. **Read windups that vanish.** `readWindups` treats an enemy's wind-up as a bolt already in flight (`windups`, `908-932`). When the enemy cancels or fakes the cast, the virtual bolt disappears and the bot returns to its wander point at once: dodge, undodge.
8. **Pillar routing side flips.** `routeAround` picks the side by the sign of a cross product (`src/bots/pillars.ts:47-73`); with the goal nearly behind a pillar the sign flips as the bot moves, and `pushingIntoPillar` (`controller.ts:684-693`) also re-picks the wander point.
9. **Edge and shrink lookahead.** `walkOffLava` triggers when the bot stands outside the next layer (`640-647`), heading for the nearest interior tile (`nearestTileCentre`, `src/bots/arena.ts:42-55`); near the edge before a shrink the nearest interior tile can change between thinks.
10. **Reaction queue overlap.** Decisions land 4 to 5 ticks after they are made while the next one is made 3 ticks later (at 30 Hz), so every decision is made before the previous one has taken effect. `predictSelf` (`704-736`) corrects the position but not the mode (dodge versus wander), which feeds sources 1 to 3.

Typical remedies (for later): commit to a wander goal for a minimum time, exit hysteresis on the dodge threshold, an action-rate cap per preset, skip a new move when the new goal is within a small angle of the current one, and a fixed jitter seed per pick. Measure with the FFA and ladder harnesses; the menu backdrop runs Brutal and Uber, so the dance is on screen for every visitor.

## 9. Platform

- **Rooms**: `src/net/dedicated.ts` (room lifecycle, quick play, ranked queues, bot fill, idle removal, `1-30`), `src/net/server.ts` (HTTP API, admission, rate limits, listings, queues, `1-25`), bound to Node by `server/listen.mjs`; WebSocket transport `src/net/ws.ts`. P2P uses PeerJS with the public broker `0.peerjs.com` (`src/net/peer.ts:1-5`) and TURN credentials from `server/turn-credentials.mjs`. Max 10 seats (`src/net/session.ts:305`). Branch `feat/shards` runs rooms in several processes per host (not merged; `docs/NEXT-SPRINT.md` item 2).
- **Hosting**: first-party page and same-origin account service at `brawlock.osc.link`, heavy media on GitHub Pages (`docs/STATIC-HOSTING.md`), US West and Europe regions (`deploy/README.md`).
- **Accounts and progression**: Better Auth authority on US (`server/accounts.mjs`; providers Google, Discord, Microsoft in code at `accounts.mjs:23`, only Google provisioned per `docs/ACCOUNT-IDENTITY-PLAN.md:9`), passkeys, reserved names, global Elo authority, Embers earned only in official games and spent on cosmetics (`docs/PROGRESSION.md`; catalog `src/game/progressionCatalog.ts`). Cosmetics change shape, never colour, and never gameplay.
- **Analytics**: private SQLite per authority with a report tool (`docs/ACCOUNTS.md`, "Persistent operational analytics"); optional GA4 (`docs/GOOGLE-ANALYTICS.md`).
- **Chat**: in-match chat; a global menu chat is being built (`server/chat.mjs`, `src/net/globalChat.ts`, untracked).
- **itch.io build** (`docs/ITCH.md`): relative base, media bundled into the upload, `VITE_SITE_URL` sends guest play permission, bug reports and invites to the first-party site (`src/lib/site.ts:1-18`), no sign-in (OAuth refuses iframes, cookies are blocked), CORS for the embed origin on two guest endpoints only (`server/embed-origins.mjs`), game servers allow the origin in `ALLOWED_ORIGINS`.

### What a Discord Activity would stress

The itch build already solved "client in a cross-site iframe, guest mode, relative paths, bundled media". On top of that:

- **Auth**: Activities authenticate through the Embedded App SDK's authorize call and a server-side code exchange, without redirects. The account service uses cookie sessions (`src/game/account.ts:21-32`, `credentials: 'same-origin'`), which an iframe cannot keep. Needed: a token exchange endpoint and a bearer-token session path for the account authority and regional admission. The Discord provider config in Better Auth does not cover the SDK flow. M to L, security-sensitive.
- **Network**: Activities reach external hosts only through the URL mappings of Discord's proxy (per Discord's documentation; not verified here). Every origin needs a mapping: game regions (WSS), the account authority, presence, feedback, media (bundle it, as itch does), Google Fonts. Origin checks would see the Activity origin and need it in `ALLOWED_ORIGINS` and the embed origin list. P2P is the weak spot: the public PeerJS broker and TURN would need mappings, and WebRTC behind the proxy is unproven, so dedicated rooms should be the only path there.
- **Storage**: iframe storage is partitioned; `safeLocalStorage` already tolerates blocked storage (`src/game/profile.ts`), but guest identity, settings and replays (IndexedDB) would be separate from the site, as on itch.
- **Social glue**: Discord-native lobbies (an Activity instance maps to a room code), invites, and presence. Room codes and `?room=` links already exist, so mapping an instance to a dedicated room is S to M.
- **Performance**: the Discord client is a Chromium shell; WebGPU availability there needs checking, and the WebGL2 fallback is forced to Low (fine on modest machines, see section 10).

## 10. Performance headroom on record

Client render (`media/perf-harness/README.md`, git-ignored, M3 Max, headless Chrome on Metal, uncapped):

- After the 2026-10-19 arena work: ultrawide High 274 to 385 fps, Medium 313 to 484; retina High 195 to 227, Ultra 191 to 226. Ultrawide is CPU-bound (about 3.3 to 3.6 ms main thread per frame), retina dpr 2 is GPU-bound (about 5 ms).
- GPU split on High: arena tiles 2.0 to 2.5 ms (half the frame), GTAO about 1.7 ms at retina, bloom about 0.4 ms GPU plus 0.3 ms CPU, MSAA 0.25 ms, pawns 0.25 ms. About 93 draws, 25 shadow casters, 14 passes. Uploads 454 to 175 KB per frame; bone matrices about 122 KB of that.
- Throttled CPU, 1080p fight: Low 586 fps (no throttle), 133 at 4x throttle, 86 at 6x; Medium 99 at 4x; WebGL2 Low 107 at 4x. Fight p99 21 ms with Uber bots at 60 Hz; match-start hitches fixed from 108 ms to about 31 ms.

Simulation and network:

- Sim step: 0.04 to 0.11 ms per tick for 2 to 10 players (`docs/M4.md` lines 8, 83-86). Prediction re-simulates at most 0.5 s of ticks per frame.
- Input stream downlink: 2 to 9 KB/s per player for 2 to 10 players, payload (`docs/PLAN.md` §4.4); snapshots would be 150 to 300 KB/s.
- Europe capacity at 60 Hz, 2 vCPU (`docs/research/capacity-2026-10-24.md`): all-human rooms healthy to 8 rooms / 80 clients (CPU p95 94%), broken at 10 rooms; provisional budget 6 full rooms / 60 people. Bot-filled rooms (1 human + 9 bots) healthy to 12 to 16 rooms; about 0.3 points of one core per added bot seat, of which bot decisions are only 0.02 to 0.03. CPU profile: 31% native, 14% GC, 13% transport, 7% clone and hash, 5% bot decisions, 4% sim.
- Since then: 30 Hz is the default, and with the unmerged shards branch the EU host held 64 clean bot rooms instead of 32 (`docs/NEXT-SPRINT.md` item 2). Full human rooms stalled near 24 rooms per host in a later run, network path unresolved (same file, item 3).

## 11. Feature cost overview

| Moonshot idea | Seam | Main blocker | Cost |
|---|---|---|---|
| New spells | spell registry, VFX plugin | presentation bar per spell | M each |
| Spell combos (elements, reactions) | `ProjectileBehavior` flags, physics `notify`, field `onTick` | no tag system or interaction table | M framework, S each |
| Frozen lava, cracking or destructible floor, hazards, ice | `ArenaState`, lava, walk, bots, `Arena.ts` | arena is one integer | L refactor, then S to M per tile kind |
| Non-ring or scripted arenas | same plus spawn rules, render grid limits | same | L |
| New mode | `mode.ts` branches, server presets | hardcoded mode lists, no rules interface | M to L |
| Mutators | `MatchSettings` scalar keys | settings patch is scalar only | S framework, S each |
| Ghost or audience powers for the dead | new `InputCommand`, `applyCommand` | design only | S to M |
| Cinematic final blow / instant replay | `RenderSource`, director concepts, ring of clones | live sim cannot slow; 600 ms game-over linger | M (replay style) to L (live) |
| Adaptive music | `playEvents`, music bus, `SampleBank` | music selection; decoded stem memory | M engine |
| Play from here, kill cams, clips | `cloneState`, practice loop pattern | replays locked to the exact build | S to M local; L for durable clips |
| Server-side replays, archive | `MatchRecorder.step` on dedicated rooms | build lock, storage | M |
| Broadcast spectating | stream for spectators or a relay | spectators get full snapshots | M |
| Human-plausible bot movement | `controller.ts` wander and dodge | none technical; recalibrate ladder | S to M |
| Discord Activity | itch iframe build, `site.ts` | cookie auth, proxy mappings, P2P | L |

## 12. Guard rails any moonshot feature inherits

- **Determinism**: sim code uses the seeded RNG in state (`src/sim/rng.ts`), no `Math.random`, `Date` or `performance`, and engine trig only through `src/sim/math.ts`. Cross-engine hashes (V8, SpiderMonkey, JavaScriptCore) were verified over 36k ticks (`docs/M4.md` line 8). New spells, tile kinds and mutators must follow the same rules or the input stream desyncs and heals by keyframe every second.
- **Tick rate**: every duration goes through `ticks()`; module constants derived from the rate go in `onTickRate` (`src/sim/types.ts:37-50`). `src/sim/tickRate.lint.test.ts` and `src/bots/mathGuard.lint.test.ts` enforce this (`npm run lint:invariants`).
- **Plain data**: no classes, maps or sets in `SimState` (`src/sim/types.ts:9-10`). Projectile and modifier payloads hold numbers only.
- **Netcode id**: any sim or net change is a new netcode id (`scripts/net-id.mjs`). Clients with another id cannot join a server room, and old replays stop playing. Ship sim changes in batches with server deploys.
- **Faithful v1**: original numbers and rules stay the default; deviations are listed in `docs/PLAN.md` §2. New mechanics fit best as modes, mutators or new content, not as silent changes to the classic rules.
- **Render**: WebGPU first, WebGL2 fallback forced to Low and without compute; VFX modules must free their objects in `dispose` (`src/ui/effectCleanup.lint.test.ts` guards React effects); hitboxes stay readable above effects (`docs/PLAN.md` §5.2).
- **Bots**: any change that can move bot strength reruns `LADDER=1 npx vitest run src/bots/ladder.test.ts` and, for labels, `npm run bots:elo`.

## 13. Doc and code inconsistencies noticed

Recorded for whoever plans next; nothing was changed.

- `docs/PLAN.md` §4.3 describes a "sort-and-sweep broadphase on X". The code checks every pair with an x-interval reject (`src/sim/physics.ts:278-286`, `sweptX` at `163-166`); there is no sort.
- `docs/PLAN.md` §5.4 lists "GPU particles with TSL compute (WebGPU tier)". Particles are stateless instanced sprites evaluated in the vertex shader (`src/render/scene/Particles.ts:8-14`); no compute pass exists in `src/render`.
- `docs/PLAN.md` §7 lists an "action rate cap" in the difficulty vector; `src/bots/presets.ts` has no such knob.
- `src/game/replay/player.ts:18` `KEYFRAME_EVERY = 600` is a tick literal commented as 10 s; it is 20 s at the default 30 Hz.
- `docs/NEXT-SPRINT.md` item 3 still says the 30 Hz simulation "waits for a playtest decision", while `DEFAULT_TICK_HZ` is 30 (`src/sim/types.ts:26`) and the same file's item 2 builds on the 30 Hz build.
