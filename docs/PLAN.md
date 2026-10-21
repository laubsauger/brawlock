# Brawlock: Plan

A new iteration of **Warlock** (Warcraft III custom map, later the official Dota 2 mod *Warlock Brawl*) as a standalone browser game. WebGPU, real online multiplayer, first-class bots, and a presentation bar of "AAA is the baseline".

Version 1 is faithful to the original core. Innovation comes after v1 ships and the core feels right.

**Planning audit, 2026-10-20:** this document retains the original design and milestone history.
[Next sprint](NEXT-SPRINT.md) is the active backlog; §12 below distinguishes implemented work,
remaining engineering and human verification. Release receipts establish deployment status.

Research that backs this plan lives in `docs/research/`:

| File | Contents |
|---|---|
| `spells.md` | Every spell, projectile and modifier with exact constants |
| `systems.md` | Economy, shop, items, masteries, pawn stats, lobby options, modes, round flow, original AI, UI inventory, quirks list |
| `assets.md` | License status, what can and cannot be reused, arena geometry algorithm, replacement asset sources |
| `tech.md` | Engine, browser support, netcode and hosting research |

---

## 1. Pillars

1. **Precision under pressure.** Fast, readable, skill-expressive. Every hit, knockback and lava tick must be legible within a frame. Latency is a design constraint, not an afterthought.
2. **Faithful core, standalone polish.** The original mechanics and numbers, presented like a real game: splash, menus, lobby, settings, quality tiers, audio mixing, results. Room chat connects players; gameplay controls use the UI rather than chat or console commands.
3. **Always a match.** Bots fill any slot at any difficulty. Solo vs bots, mixed lobbies, bot-only spectating, bot takeover for leavers.
4. **Web-native.** Opens from a link. No install. Runs on GitHub Pages. Multiplayer by sharing a URL.

## 2. What "faithful v1" means

The core loop, unchanged:

- Top-down arena of square tiles over lava. 2–10 players, FFA or teams.
- Right-click to move, hotkeys to cast at the cursor. Spells push people. Damage taken raises **knockback points**, which make every later hit push harder (Smash-style percent).
- Lava burns 100 HP/s. The arena shrinks one ring every 10 s. Last team standing wins the round.
- Shop phase between rounds (original 30 s, our default 25 s): buy spells (one per column), upgrade them to level 7, buy items and masteries. Original income is the same for everyone (30 start + 10 per round); our defaults add 1 gold per kill and 2 per round win (see table below).
- First to N round wins (original 11, our default 5).

Kept verbatim (see `systems.md` §13 and `spells.md`): base stats (1000 HP, 5 HP/s regen, 210 move speed, mass 100, radius 30), knockback formula, friction, arena layer formula, lava DPS, shrink timing, spell numbers, costs, item and mastery values, lobby options and defaults.

Deliberate deviations, all fixes of mod-era bugs or Dota dependencies (full list in `systems.md` §12):

| Original | v1 decision |
|---|---|
| Movement, turning and cast points came from the Dota unit controller | Re-implemented explicitly in the sim: turn rate 1.2 (Dota units, rad per 0.03 s), cast point per spell from KV data, move-while-turning rules |
| Shop is never closed server-side (buy mid-fight, while dead) | Decided 2026-10-15: buy during the shop phase or while dead; read-only mid-fight. One constant restores buy-anytime |
| Deathmatch: lava suicide scores for own team | Fixed |
| Score win condition iteration bug | Fixed: winners are players with max score ≥ limit |
| `math.random` float coercion makes bot wander jitter | Fixed (intended float ranges) |
| Arena size counts players who left | Fixed: counts active players at round start |
| Shop-phase respawns use the fight spawn ring, (13 + players) · 100 − 600, on the smaller layer-14 shop platform (radius 1300): from 6 players up warlocks start the shop in lava | Fixed: the spawn ring is capped 300 inside the edge of the platform that exists at spawn time (floor 300). Fight spawns already sit 300–500 inside their platform and are unchanged |
| Lobby defaults: first to 11 (rounds or score), kill gold 0, win gold 0 (income ignores performance), 30 s shop | Decided 2026-10-16: default first to 5 (11 dragged on, an 8-player FFA can run 40+ rounds), kill gold 1, win gold 2 so kills and round wins are rewarded a little, 25 s shop. All stay lobby options with the original range |
| Hero choice effectively random, 7 Dota heroes | Lobby cosmetic picker: warlock archetypes with team-color trim |
| Bot difficulty = think interval only, console command only | Full difficulty system, lobby UI (§7) |
| Chat-line announcements | Proper UI announcements, killfeed, round banners |

Original assets cannot ship: the source repo has no license and almost every asset is Valve-owned (see `assets.md`). We re-implement mechanics and constants only and make all art, audio and text new.

## 3. Game rundown

### 3.1 Spells: 24 in 6 shop columns, one per column

| Col | Role | Spells |
|---|---|---|
| 1 | Knockout | Boomerang, Lightning, Homing, Twin |
| 2 | Transport | Teleport, Thrust, Swap |
| 3 | Damage | Cluster, Drain, Bouncer, Recharge |
| 4 | Devastator | Windwalk, Meteor, Splitter, Snowball |
| 5 | Defense | Shield, Rush, Alteration |
| 6 | Knockbackless | Gravity, Grip, Warpzone, Magnetize, Rockpillar, Link |

Buy cost 11–15, six upgrades to level 7 (5–13 each). No refunds, no swapping once bought. No mana: the mana bar was the knockback-points meter.

Starting kit (free, item slots):

- **Fireball**: straight bolt, speed 1000, radius 25, range 1000, 70 damage +7 per level (max 7), cooldown 4.8 s, cast point 0.2 s.
- **Scourge**: 0.9 s cancellable windup, then 100/110/120 damage to enemies within 250; costs you 100 HP (cannot kill you). Levels 2–3 refund 20/30 knockback points per enemy hit. Cooldown 3 s.

Bought items with actives:

- **Redirector**: re-aims your projectile nearest the cursor and adds 0.5 s of life; you take +30% knockback for 8 s.
- **Pact**: your next damaging spell within 5 s deals ×1.5, then you are slowed by 66 for 6 s.

Shop spells:

| Spell | Col | Mechanic |
|---|---|---|
| Boomerang | 1 | Curved shuriken that flies out and homes back to you; passes through projectiles |
| Lightning | 1 | Instant 600-range line, hits the first thing in its path; detonates your own and allied Fireballs (full damage within r100, fading to zero at r225; peak = ⅔ × (Lightning damage + the Fireball's launch damage), knockback factor 1.35). Enemy Fireballs are destroyed without exploding and stop the beam. |
| Homing | 1 | Bolt that steers toward the nearest enemy for 4.5 s; touching yourself detonates it (r292) and speeds you up |
| Twin | 1 | Two bolts on mirrored elliptical arcs that converge on the target point |
| Teleport | 2 | Instant blink up to 770–1190; keeps 80% of current velocity; no lava check |
| Thrust | 2 | Dash with a contact hit; damage scales with speed; brakes to 20% speed on a miss |
| Swap | 2 | Fast bolt; swaps places with the first warlock or pillar it touches, else blinks you to where it stopped |
| Cluster | 3 | Four small fireballs in a fan (±0.06 and ±0.18 rad), knockback ×0.65 |
| Drain | 3 | Flies, re-aims once at the nearest warlock; enemy: damage and slow plus a heal orb back to you; ally: heal and speed |
| Bouncer | 3 | Bounces between nearest warlocks (allies too); damage ×0.7 per enemy hit, dies under 10 |
| Recharge | 3 | Bolt whose damage grows +10 per consecutive hit; a returning orb resets its cooldown |
| Windwalk | 4 | Invisible, +200 move speed for 2.6 s, walk through warlocks; first enemy touched takes a charge hit; ends on any cast |
| Meteor | 4 | Hovers 0.55 s, falls 0.60 s, AoE r225–304 with falloff to 40 at the edge; cannot be blocked or redirected |
| Splitter | 4 | Main bolt becomes a spawner that releases 4 waves of 2 child bolts in a fan |
| Snowball | 4 | Slow ball that drags touched enemies (≥425 u/s), damages while touching, explodes (r200) at the end |
| Shield | 5 | 1.2 s bubble (r200–260) that reflects enemy projectiles and takes ownership of them |
| Rush | 5 | Absorbs 50% of incoming damage up to a cap (after knockback is computed); +1.5 move speed per HP absorbed |
| Alteration | 5 | For 2 s, swaps your position with the first enemy projectile that comes within 120 |
| Gravity | 6 | Slow orb that pulls enemies within 550 and all projectiles within 600 (yours too); DPS within 250 |
| Grip | 6 | Root for 4.5–6 s; target takes only 33% knockback and gains 5 knockback points per spell they cast |
| Warpzone | 6 | Zone that slows enemy projectiles to 0.40–0.16 time scale |
| Magnetize | 6 | On an enemy, your projectiles bend toward them; on an ally or yourself, enemy projectiles bend away |
| Rockpillar | 6 | Places a 4 s pillar (r90, 400 HP) that explodes when destroyed |
| Link | 6 | Tether that pulls the hit warlock toward you (or you toward a pillar) at 1550 u/s², with DPS on enemies; breaks under 100 range or on Shield/Rush |

Interaction rules worth keeping: shielded warlocks cannot be swapped; Lightning is blocked by an enemy Shield or Alteration bubble; Gravity pulls your own projectiles; Thrust into Windwalk is a double hit; projectiles that take damage are destroyed (except Snowball).

Known original bugs to fix, not copy: Homing fails to load in the last commit (we implement the intended behavior); real cooldowns differ from tooltips for six spells (we use the real ones and show them); Drain's collision radius reads a missing key (use the defined 24.5); Range mastery applied twice to Splitter and Redirector. Full list: `spells.md` §12.

Per-spell numbers per level, collision profiles, modifiers and interactions: `spells.md`.

### 3.2 Items (4 free slots after Fireball and Scourge)

Ring of Health, Cursed Ring, Cape, Armor, Boots, Pocket Watch, Redirector, Pact, plus Fireball and Scourge upgrades. Values in `systems.md` §3.

### 3.3 Masteries

Duration, Range, Lifesteal. 6 levels each, 5 gold per level, or 13 to raise all three at once. Values in `systems.md` §4.

### 3.4 Modes and lobby options

Team mode Shuffle (default) / FFA / Teams. Game mode Rounds (default) / Deathmatch. Win after N rounds or first to score N. Tunables: start, round, kill and win gold; lava DPS; knockback and damage multipliers; friction; bots for leavers. Ranked uses its separate fixed format ([RANKED-FORMAT.md](RANKED-FORMAT.md)).

Spectator betting and bounties (Rounds only) are our additions, not in the original. A knocked-out human may stake 1 gold, once per round, on a living player or team until fewer than three warlocks are alive (or 10 s into a round that starts with two). Payouts are a pool: all stakes form the pot and each correct bet gets an equal floored share, so long shots pay more. Coins that don't split evenly, or the whole pot when nobody is right, fund the winners' bounty for the next round when bounties are on; with bounties off they go one each to the earliest correct bets, or back to every bettor when nobody is right. A draw refunds every stake. Rules: `src/sim/bets.ts`.

## 4. Architecture

### 4.1 Stack

Same proven stack as Wave Rider:

- TypeScript, Vite, React 19, Tailwind 4, Vitest.
- **three.js r186 `WebGPURenderer` + TSL** via **@react-three/fiber**. WebGPU first. The same renderer falls back to its WebGL2 backend where WebGPU is missing; that path is forced to the Low tier and skips compute-shader VFX.
- **zustand** with narrow selectors for UI state. Per-frame data never goes through React (see §4.5).
- **PeerJS** for WebRTC signaling and connection setup. Gameplay traffic runs on our own unreliable data channel (§4.4).
- GitHub Pages deploy via Actions, same workflow as Wave Rider.
- three.js **Inspector** addon (`three/addons/inspector/Inspector.js`) in dev builds and behind a settings toggle: GPU timings, render targets, live parameter tweaking. Plus our own perf HUD (fps, frame ms, GPU ms via timestamp queries, sim ms, ping, packet loss).

### 4.2 Source layout

```
src/
  sim/      pure deterministic game simulation. No three, React, DOM or net.
  net/      transport (PeerJS + raw data channels), protocol, host and client sessions
  bots/     AI controllers. Produce InputCommands like a human; no sim internals.
  render/   r3f scene: arena, lava, characters, projectiles, VFX, camera, post
  ui/       React screens and HUD
  audio/    WebAudio graph: buses, mute, volumes, positional SFX, music
  game/     glue: zustand store, frame buffer, session loop, input mapping
  lib/      small shared utilities (prng, math, fullscreen, webgpu detect)
```

### 4.3 Simulation

- **60 Hz fixed step**, independent of render rate. The original ticked at 0.035 s on a 30 Hz Dota server. Per-tick constants convert exactly (`friction ** (DT / 0.035)`).
- **Deterministic**: seeded mulberry32 in state, no `Math.random`, no wall clock, no engine trig in state paths (own sin/cos/atan2 in `sim/math.ts`). `+ - * / Math.sqrt` are IEEE-exact across engines.
- **Plain-data state** (`SimState`): structured-cloneable, diffable, serializable. One `step(state, inputs)` function.
- Physics re-implements the original: swept circles, sort-and-sweep broadphase on X, collisions resolved in time-of-impact order, elastic response with per-body elasticity, collision matrix by alliance and channel (player, projectile, obstacle).
- **Data-driven spells**: each spell is a definition (numbers per level) plus a behavior module with hooks (`onCast`, `onTick`, `onCollide`, `onExpire`). Modifiers use the same hook model (`onPreTick`, `onDamageTaken`, `onCollision`, ...) as the original.
- Events (`SimEvent`) per tick drive VFX, SFX, UI and the killfeed. Gameplay never depends on render.

### 4.4 Networking

Target: Dota-class responsiveness or better on a normal connection.

- **Authority**: the host runs the authoritative sim. In P2P that is a player's browser; later the same code runs headless in Node as a dedicated server.
- **Transport**: PeerJS brokers the WebRTC connection. Lobby, shop and chat use a reliable ordered channel. Gameplay uses a second, pre-negotiated channel `{ ordered: false, maxRetransmits: 0 }`, which gives UDP semantics. (PeerJS `reliable: false` only disables ordering and still retransmits, so we do not use it for gameplay.)
- **Inputs**: sent immediately on every click or keypress, stamped with the client's estimated sim tick. Each packet repeats the last few unacknowledged inputs, so a lost packet never drops a command.
- **M0 (tonight): state sync.** Host sends full snapshots every tick; clients interpolate with a small jitter buffer. Tolerant of early determinism bugs.
- **M1: host-arbitrated input sync with rollback** (the Photon Quantum model; also what the Acolyte Fight author moved to in his next engine, Easel).
  - The host decides which tick every input belongs to and broadcasts the confirmed input stream. Inputs that miss their deadline are applied on the next tick, never dropped.
  - Every client runs the same sim. It predicts unconfirmed ticks (remote players repeat their last intent) and rolls back and re-simulates when confirmed inputs differ. About 60 entities make re-simulating 10+ ticks per frame cheap.
  - Warlock inputs are intents ("move to X", "cast at Y"), so "repeat last intent" predicts remote players well. All knockback chains share one timeline.
  - The host also runs the sim, so it stays authoritative. It sends a state hash every second and a full snapshot on join, on reconnect and on hash mismatch, which heals any desync. Clients never author state (Acolyte Fight let them; that was a cheat vector).
  - Bandwidth is inputs only, so 10-player rooms fit a home uplink.
  - Corrections from rollback are smoothed visually, never snapped.
  - Optional host-advantage compensation: confirmed input delay for the host equals the median client delay.
- **Fallback**: if cross-engine determinism ever fails in practice, the same `step(state, inputs)` sim supports classic state sync with own-pawn prediction and delta snapshots.
- **Clock sync**: RTT probes on the unreliable channel; client keeps a smoothed tick offset.
- **Prediction is the default** (shipped 2026-10-16, verified in two-browser WebRTC runs at RTT 0/80/200 with loss): the client re-simulates the whole world forward to its predicted present (re-sim capped at 30 ticks, skipped when new data only confirms the prediction). Own inputs are stamped with the predicted tick and the host runs them at that tick, so acked states are bit-identical (hash-checked). Corrections slide out over ~100 ms and snap above 250 units.
- **Input stream (M4.2, 2026-10-17; the M1 model above, now the default `predict` mode):** the host sends the confirmed inputs of every step the tick it runs it, not snapshots (`src/net/stream.ts`). Every peer builds the start state itself (createMatch is deterministic) and steps its confirmed state from the stream; prediction rebases on it. Steps with inputs ride 3 packets, empty stretches go out every 3rd tick as a heartbeat, a gap is resent from a 3 s history (`need`), a state hash every second triggers a keyframe snapshot on mismatch, and joins / rejoins start from a keyframe. The host also relays each player's stamped inputs on arrival as prediction hints (others see remote orders 30-90 ms sooner). Move and cast targets are rounded to 1/100 unit at the source. Downlink per player at 10 % loss: 2 players 150 → 2 KB/s, 10 players 282 → 9 KB/s (payload; ~4-12 KB/s on the wire). Modes: `predict` (stream), `snapshot` (snapshot prediction, fallback), `classic` (interpolated snapshots); URL `?net=predict|snapshot|classic`; spectators use snapshots. `PROTOCOL_VERSION` 4.
- **Fairness**: host advantage is compensated (host input delay equalization and/or caster projectile fast-forward, both capped).
- **Connection monitoring**: per-peer RTT, jitter, loss, snapshot age, channel mode, correction size, desync count and a quality grade; always-visible HUD indicator, a toggleable net graph, rate-limited warnings for your own link, and host-side per-player warnings in scoreboard and lobby.
- **Room codes**: 5 letters without I/O (pattern from Pit of Carnage). The host registers PeerJS id `brawlock-<CODE>`; friends type the code or open `?room=CODE`.
- **Topology limits**: P2P star (the host browser is the server). Roughly 10–20% of NATs need TURN (PeerJS provides free TURN; own TURN later). Host leaving ends the match in v1; host migration is post-v1.
- **Reconnect**: rejoin by the same link within the abandon window; a bot holds the pawn meanwhile (original `bot_on_dc`).
- **Dedicated servers (implemented):** Node processes run the same `sim/` as input arbiter and authority across the existing US/EU regions, using WebSockets and the shared transport interface. Account/rating authority and maintenance/drain are implemented. The earlier Bun/per-match-hosting proposal is superseded; no hosting-provider migration is scheduled. WebTransport remains deferred.

### 4.5 Render and UI data flow

- Session writes authoritative or predicted states into `game/frame.ts` (mutable singleton).
- r3f `useFrame` reads it, interpolates, and updates refs and instanced meshes imperatively.
- HUD reads the same buffer from its own rAF and writes DOM directly (HP, cooldowns, timers).
- React re-renders only on screen changes, overlays opening, and lobby edits. zustand selectors are narrow.

## 5. Presentation (the AAA bar)

### 5.1 Art direction

Target look: "Unreal Engine quality without the performance penalty". Dark fantasy arena at night. Volcanic caldera framed by rocky cliffs, boulders, moss and glowing green vegetation or crystal accents on the rim, glowing lava with heat shimmer, tiles of obsidian and runed stone that crack, glow and sink as the arena shrinks. Warlocks read instantly by silhouette and team color. Spells carry a clear color language per column so players learn threats by hue and shape.

### 5.2 Readability rules

- Team color on character trim, ground ring, and every projectile the player casts. Colorblind-safe palette option.
- Windups remain bound to hands/body, with distinct spell silhouettes and a local targeting decal where appropriate. No apparent outgoing projectile before release; cancellation fizzles in place. Scourge visibly charges. See [the readability audit](ABILITY-READABILITY-AUDIT.md).
- Knockback shows strength: trail length and hit-spark size scale with impulse; knockback points visible as a growing aura and a number.
- Lava danger: tiles about to drop pulse red one second before the shrink.
- Floating combat numbers, crisp and color coded, with stacking.
- One identity color pair per spell (src/render/vfx/palette.ts), distinct in hue and value from each other and from lava; the team color marks the caster.
- Every AoE visual ends exactly at the gameplay radius; players read ranges from visuals.
- On-screen text over the scene gets a glyph-following dark halo, never a boxy panel.
- Name tag with a compact HP bar over every pawn; broadcast-style kill feed (killer, cause icon, victim; lava kills credit the last hitter).
- VFX never hide a projectile hitbox. Effects have a hitbox-core layer drawn on top.

### 5.3 Characters and world

- Warlock characters: rigged glTF, idle, run, cast (3 variants), knocked-back tumble, burn, death, victory. Robe and cape get faked cloth motion in a TSL vertex shader (sway and trail from velocity and acceleration, stronger toward the hem), driven by a small damped spring per pawn that also takes hit impulses, and constrained outside body and leg capsules so it never clips. M0's procedural placeholder already uses the same technique. Decision (2026-10-15): CC0 rigged base (KayKit / Quaternius), heavily customized: TSL materials, hood, robe and cape geometry with the cloth shader, team-color runes and hand casting. Staffs are a cosmetic slot (§11 risk 10). Cosmetic variants chosen in the lobby.
- Tiles: generated in code (rounded-corner logic from the original), PBR materials from CC0 libraries (Poly Haven, ambientCG), three themes matching the original's three obstacle sets: ruined temple stone, volcanic rock, mossy overgrown.
- Lighting: warm lava bounce from below, cool moonlit key light, soft shadows on High and up, height fog and haze over the lava.
- Obstacles: destructible pillars (sim done: 400 HP, explosion r300, 2–8 random per round, re-rolled each shop phase) with per-theme art, crack stages and an explosion. Spawning switches on once the art exists.
- Lava: TSL shader with flow noise, emissive bloom, heat distortion, ember particles.

### 5.4 VFX, camera, post

**VFX definition of done.** No spell, projectile, ability or hit ships as a plain shape. Each one has:

- Layers: hot emissive core into bloom, soft glow, trail with heat falloff, secondary particles (embers, sparks, smoke), light cast on nearby ground, heat distortion where it fits, an impact decal that fades.
- A signature windup: the shared casting base (arm rings, palm orb, ground ring) plus a spell-specific charge-up so opponents can recognize the spell before release.
- A full arc: anticipation (windup telegraph), action (cast flash), impact (directional burst, shockwave, debris), dissipation (smoke, settling embers).
- Its own sound set (cast, travel loop where fitting, impact).
- A readable collision core that stays visible above the effect.

**Deaths by cause.** The death event carries the lethal cause; each spell (and lava, pillars) has its own death: lava sinks and burns, Fireball blows apart into embers, Lightning flashes the skeleton then leaves ash, Snowball freezes and shatters, Gravity sucks the body into the singularity, generic fallback crumbles to ash.

A spell counts as implemented only when its sim behavior, tests and this VFX standard are all done; VFX is not deferred to a later polish pass.


- GPU particles with TSL compute (WebGPU tier), instanced CPU particles as fallback.
- Heavy impacts: directional spark cone along the knockback normal, ground shockwave, victim flash, camera kick toward the hit, all scaled by impulse.
- Hit stop of 2–4 frames on big hits, scaled screen shake (setting), chromatic flash on own damage.
- Camera: top-down tilted follow with smoothed zoom (original: 500–1500, default 1100), optional free pan, spectator cam on death.
- Post: bloom, ACES or AgX tone mapping, vignette, subtle film grain, per-object motion blur (velocity-stretched projectiles and knocked-back pawns), optional camera motion blur on Ultra, SSAO/GTAO and SMAA by tier.

### 5.5 Quality tiers

| Tier | Resolution | Shadows | Post | Particles |
|---|---|---|---|---|
| Low | 0.75 × dpr, max 1 | blob | tone map only | 25% |
| Medium | 1 × dpr, max 1.5 | 1 cascade, 1024 | bloom | 50% |
| High | 1 × dpr, max 2 | 2048 soft | bloom, AO, heat haze | 100% |
| Ultra | native | 4096 soft | all | 150% |

Auto-detect on first launch from a 3-second GPU timestamp benchmark during the splash; dynamic resolution keeps the frame budget. Budgets: 60 fps at High on a mid laptop iGPU at 1080p, 120+ fps on desktop dGPUs.

### 5.6 Audio

- WebAudio graph: master, SFX, music, UI buses; mute and per-bus volume persisted.
- Positional SFX (pan by screen position, falloff by camera distance), voice limiting per sound, random pitch and variant per play.
- Music: streamed menu themes. Synthesized shop and combat music is disabled until recorded tracks are selected; fight SFX and lava ambience remain active.
- Sources: CC0 (freesound filtered, Kenney), Sonniss GDC bundles (royalty-free), commissioned later.

### 5.7 Screens and flow

```
Splash (static HTML that paints before JS; real loading progress, GPU benchmark; "Enter" is the audio-unlock gesture)
  └ Main menu (animated arena backdrop)
      ├ Play vs Bots  → Lobby (offline)
      ├ Host Game     → Lobby (share link, slots)
      ├ Join Game     → Lobby (5-letter room code, or a ?room=CODE link)
      ├ Settings      (video, audio, controls, gameplay, accessibility)
      ├ Spell library (every spell and item: preview clip, description, numbers per level; also linked from How to play)
      └ Credits
Lobby: player list with color and cosmetic, bot slots with difficulty, match options (all original lobby options), ready, start
Match:
  Shop phase (shop overlay, practice movement, countdown)
  → Fight (HUD) → Round end banner (winner, top damage) → next shop phase
  → Game over → Results (scores, damage, kills, MVP, rematch)
Pause menu (offline only pauses; online it is an overlay)
```

HUD: HP bar with regen tick, knockback points readout, spell bar (6 columns) with cooldown sweeps and level pips, item bar, gold, round and phase timer, shrink warning, minimap, killfeed, scoreboard on Tab, own ping and loss.

**Character sheet** (hotkey C): live stats and their sources: HP and max HP, regen, move speed, knockback points and what they multiply, knockback taken factor (Armor, Cursed Ring), damage factor, debuff duration factor, mastery bonuses (duration, range, lifesteal), owned spells with levels and next-level deltas.

**Shop** is a highlight of the round, not a menu: side panel that keeps your warlock practicing in view, opens automatically with the countdown, big spell cards by role color, affordability states, previews with exact before and after numbers per level, hover tooltips with mechanics, purchase feedback (sound, flash, level pip animation), shows whether buying is allowed right now.

Settings: quality tier and individual toggles, resolution scale, fps cap, fx intensity, screen shake, colorblind palette, master, SFX, music and UI volume, mute, keybinds (rebindable), camera zoom speed and edge pan, show perf HUD, Inspector toggle.

### 5.7.1 Visual progression

Upgrades show on the warlock and in the spells, not only in the shop (approved 2026-10-15; not in the original, where levels only changed numbers):

- **Spell power tiers**: three visual tiers per spell (levels 1–2, 3–5, 6–7) add layers (hotter core, extra trail and arc layers, bigger impact debris) while hitboxes stay identical; the sim reports the level on projectiles and cast events.
- **Warlock build reading**: each owned spell column adds an accent rune band in that column's hue at a fixed garment location; total spell levels raise rune density, brightness and eye glow; team color stays the primary identity.
- **Upgrade moment**: a level-up burst on the warlock on every purchase (sim 'purchase' event).

### 5.8 Online experience (esports bar)

Online systems now run through dedicated regions as well as explicit P2P custom hosting. Local persistence remains available; authoritative accounts, ranks and progression have their own server contracts.

- **Zero-friction joining**: 5-letter room code or link, name remembered, join in two clicks, reconnect with the same pawn.
- **Lobby**: player cards with name, color, ping bars, host crown, ready state and your head-to-head record against each opponent; bot slots with difficulty.
- **Post-game consent:** results stay visible until players choose Ready; casual/ranked automatic rematches wait for every human. Back-to-lobby keeps the roster; Leave and New game are explicit.
- **Pings**: per-player latency in lobby and scoreboard is implemented. Teammate map pings remain deferred.
- **Statistics**: post-match board (score, kills, deaths, damage, rounds won, MVP); career totals; match history; **encounters** (per-opponent wins, losses, last played); local leaderboard of players you have met with a local rating. Profiles use a stable per-browser id.
- **Global leaderboards, ranked and matchmaking** use the implemented authoritative regions. P2P results do not grant global ranking.
- **Join-in-progress:** casual/custom joiners can reserve bot seats and spectate until their next playable round. Ranked admission closes once the match starts.

## 6. Controls

Controls must feel exactly like Dota to veteran players.

- Right-click move (every click sends a move; spam is fine), `S` stop, `H` hold (same as stop), mouse wheel zoom, `Space` center camera, `Tab` scoreboard, `B` shop, `Esc` menu.
- **Animation canceling, Dota semantics**: a stop, a new move or another cast during the turn or cast point cancels the cast with no cooldown spent (fake casts and baits work, and the opponent sees and hears the fizzle). After release there is no backswing lock: the next right-click moves immediately, and the backswing animation is cut visually.
- **Cast modes** like Dota: Quick Cast (default, fires at the cursor on key press), Quick Cast on Key Release (shows range ring and aim line while held), Normal Cast (targeting reticle, left-click confirms). Global setting plus per-slot override.
- Right-click move markers, range indicators from the sim's spell data.

Keybind presets, fully rebindable with conflict detection:

| Preset | Spell columns 1–6 | Items 1–6 | Character sheet |
|---|---|---|---|
| Dota (default) | `Q W E D F R` | `Z X C V B N` | `C` |
| Modern | `Q W E R D F` | `1–6` | `C` |
| Classic (the original's column labels, WC3 era) | `D R T E C Y` | `1–6` | `K` |

Gamepad, shift-queued orders and alternative WASD movement are post-v1 experiments.

## 7. Bots

- Bots run on the host, read the same `SimState` a human client sees (the game has no fog of war), and emit `InputCommand`s through the same pipeline as humans. No direct sim access.
- **Difficulty is a parameter vector**, not one knob: reaction latency, aim error, lead-prediction quality, dodge lookahead (forward-simulates incoming projectiles with the shared sim), action rate cap, lava and edge awareness, target selection, build quality (shop plans per archetype), team coordination.
- Presets: **Dummy** (stands, for practice), **Easy**, **Medium**, **Hard**, **Brutal**, **Uber**. Every preset is human-plausible; Brutal is strong, not omniscient; Uber wins on decisions, not reflexes (knob table: `src/bots/presets.ts`).
- Every active tier draws its shop build from the same seeded six-build pool (`src/bots/plan.ts`), then buys and upgrades that plan as gold allows. Easy, Medium and Hard keep their own reaction, aim and combat settings; Dummy never shops. Build variety and reproducibility, first-shop purchases for every tier/build, and the difficulty ladder are covered by the bot tests.
- Lobby: add bot to any slot, pick difficulty per slot, "fill empty slots" toggle, bots-for-leavers toggle. The difficulty selector's tooltip shows the tier's Elo and who it is for.
- Calibration: `npm run bots:elo` (scripts/bots/elo.ts) plays a seeded 1v1 round-robin of full first-to-5 matches on the real sim (about 40 s for 200 matches per pair, plus optional 4-player FFA pods). The unit is the **round**, the unit a player feels; a match turns a 75% round edge into about 90% of matches. Elo is the Bradley–Terry maximum-likelihood fit over all rounds (Medium = 1000); 95% intervals come from a bootstrap over whole matches, because rounds of one match share gold and items.
- FFA (2+ enemies): bots pick the best opportunity, not the weakest player on the map (distance, kill chance discounted by travel, an easy hit, who threatens them, a grudge, third-party pushes, minus targets others are already on and their crossfire), hold a target for a while, stand where it is least crowded and back off at low HP; a seeded personality varies this per bot (`targetSense` and the notes in `src/bots/presets.ts`). `npx vite-node scripts/bots/ffa.ts` measures 8-bot FFA spread; 8 Brutal bots went from 2.6 bots per target and a 4+ mob in 52% of samples to 1.5 and 3%.
- Ladder targets: Easy keeps its beginner reaction and aim settings; Medium sits between Easy and Hard (wide gaps there are intended); Hard, Brutal and Uber target about 75% round win rate per step (150–250 Elo), with Uber as the top reference; current measured gaps are shown below. Hard is Brutal's decision set with slower hands and the original 1/5 cast rate; Brutal adds **punish** (takes clear openings at once: a ready bolt the target can hardly step aside from, a sure or killing Scourge) at the same aim error and reaction delay; Uber punishes at the same rate on top of its own settings. `src/bots/ladder.test.ts` replays 16 seeds per top step and fails outside 60–88% of rounds. `BOT_ELO` (`src/bots/presets.ts`) exports the last full calibration rounded to 25 (Easy 325, Medium 1000, Hard 1650, Brutal 1850, Uber 2000) for the lobby’s approximate strength labels. Human ratings keep their existing Medium = 1000 anchor.

  | Tier | Round Elo | 95% CI | Step: rounds won | Step: matches won | Lobby estimate |
  |---|---|---|---|---|---|
  | Easy | 331 | 270–379 | — | — | 325 |
  | Medium | 1000 | anchor | 98% over Easy | 100% | 1000 |
  | Hard | 1642 | 1609–1687 | 98% over Medium | 100% | 1650 |
  | Brutal | 1860 | 1820–1907 | 77% over Hard (75–79%) | 93% | 1850 |
  | Uber | 2011 | 1972–2056 | 69% over Brutal (67–71%) | 86% | 2000 |

  Measured 2026-10-20 on `d39c8df` plus Uber's punish: 400 completed first-to-5 matches per
  pair, seeds 1–400, sides alternated; 4,000 duels and 21,545 completed rounds, no capped duels.
  Ratings are Bradley–Terry fits with Medium fixed at 1000; intervals resample whole matches
  500 times (step intervals: 2,000 match resamples). Only Uber changed in this step: Uber over
  Brutal went from 64% of rounds (62–66%) to 69% (67–71%), Uber over Hard from 88% to 91%;
  Uber's rating rose 1961 → 2011. Paired-seed probes against Brutal: punish 0.05 gave 67%,
  0.1 69%, 0.15 71%, 0.3 76% (about +4 Elo per 0.01); 0.1, Brutal's own rate, was the slight
  widening asked for. Hard and Brutal ratings moved by a few points with the fit (the tiers
  above Medium connect to it only through 98–100% pairs, about ±40); Hard's label crosses a
  rounding boundary (1635 → 1642, label 1625 → 1650).
  [Measurement](research/bot-calibration-2026-10-20-brutal.json) (`uberStep`) keeps counts,
  intervals and the probes. The Brutal step before it, in the same file: the
  same harness on the old presets (Brutal 62% over Hard, Uber 73% over Brutal at 400 matches)
  and the paired-seed ablations. Findings: 85% of deaths are lava in the late shrink; the old
  Brutal's whole edge in duels was its 30 ms faster reaction (edge pressure and the smaller aim
  error were worth nothing), and Hard and Brutal shared every other decision. Punish keeps the
  fire rate but picks the moments. A punish strong enough for 75% over the old Hard left Uber
  only about 60% over Brutal (punish 0.2: 78% over Hard, Uber 57% over it), so Hard returned
  to the original cast rate (about −35 Elo; Medium–Hard unchanged at 98%). 60 FFA pods are
  exploratory (seven hit the 1,500-second cap before Uber's change, none after), so their
  placement evidence is not presented as completed-match win rates or used for the estimates. The earlier measurement on `2c51430`
  (200 matches per pair) is [kept for reference](research/bot-calibration-2026-10-20.json).
- Shield timing (2026-10-21, every tier): a bot holds a shot until the target's bubble will be
  gone 0.1 s before the bolt's front could reach it, counting both pawns closing in; it holds a
  Drain at a ready Shield as it does a Homing missile (stolen, both seek out their caster).
  Against the shield turtle of `src/bots/shield.test.ts` (600 runs, all tiers) own shots back
  fell from 111 to 4, none of them released into a raised bubble (was 83). Remeasured with the
  same 400 matches per pair: every pair stayed inside its interval above (Brutal 77% over Hard,
  Uber 69% over Brutal, Medium–Hard identical), ratings within 2 points, labels unchanged
  (`shieldFix` in the same measurement file).
- Historical M0 used the original danger-field/lead-aim AI. The current M3 difficulty system, shared seeded builds and calibration harness are implemented.

## 8. Assets and licensing

- Nothing from the original repo ships except ideas and numbers. Nunito font (OFL) is fine.
- CC0 first: KayKit and Quaternius (characters, props), Kenney (UI, props, SFX), Poly Haven and ambientCG (textures, HDRIs), freesound filtered to CC0. Spell icons: custom, or game-icons.net (CC BY 3.0, credited).
- **Logo, favicon, splash and key art: generate with the Codex image generation skill.** Not urgent; after the housekeeping and core build.
- Credits screen lists every third-party asset and its license. `docs/ASSETS.md` tracks source, license and author per file.

## 9. Milestones

### M0: Tonight, 1v1 with a friend

Goal: two browsers on two machines play a real Warlock round over the internet from a GitHub Pages link.

- Scaffold, deploy workflow, splash, menu, lobby (host link, join), settings with mute and quality.
- Sim: physics, walking with turn rate, knockback points, Fireball, Scourge, Teleport, lava damage, arena shrink, rounds mode with shop phase timer (no shop UI yet), score to N.
- Net: PeerJS link, reliable control channel, unreliable gameplay channel, host-authoritative snapshots, client interpolation, RTT readout.
- Toolchain pinned to the majors Wave Rider proved on this machine (Vite 7, Vitest 3, TypeScript 5.9). Vite 8, Vitest 5 and TypeScript 7 exist; upgrade in a quiet week.
- Render: procedural tile arena with sinking tiles, lava shader, placeholder warlocks with team colors, glowing projectiles with trails, hit and explosion VFX, follow camera with zoom, bloom.
- HUD: HP, knockback points, spell bar with cooldowns, round and phase timer, score, round banners.
- Bots: original AI port so solo testing works.
- Audio: procedural WebAudio SFX for cast, hit, explode, lava, round start; mute.

Done when: two machines on different networks finish a first-to-3 match from the deployed link; sim unit tests pass; perf HUD shows 60 fps on both.

### M1: Faithful core

All 24 spells, Fireball and Scourge levels, 10 items, 3 masteries, shop UI with previews, character sheet, all lobby options, modes (Rounds, Deathmatch; Shuffle, FFA, Teams), obstacles with themes, up to 10 players, input-sync rollback netcode with snapshot healing, reconnect with bot takeover, results screen. Golden tests that pin the original numbers; cross-browser determinism test (Chrome, Firefox, Safari produce identical state hashes).

### M2: Presentation

Final characters and animations, tile and lava art, VFX refinement pass across all spells, sound design and music, UI art pass, logo, favicon and splash via Codex image gen, quality tiers with auto-detect, accessibility (colorblind, reduced motion), credits.

### M3: Bots v2

Difficulty vector, forward-sim dodging, shop build plans, team play, calibration harness and Elo bands.

### M4: Platform

Historical milestone scope: dedicated servers, regions, public lobby browser, matchmaking, ranked, replays and spectators. Those systems are implemented. Ranked now uses the eight-player scheduled-round format in [RANKED-FORMAT.md](RANKED-FORMAT.md), superseding the early 1v1 proposal. P2P host migration remains deferred; it is not required for dedicated games.

### After v1: innovation backlog

New spells and items, map variants and hazards, alternative movement schemes, draft mode, seasonal cosmetics, mobile touch controls. Only after v1 feels right.

## 10. Verification

- Vitest for `sim/`: formulas pinned to original numbers (knockback, lava, layers, costs), determinism (same seed and inputs give identical state hashes across 10k ticks), and a spell interaction matrix.
- Headless match runner: bots play full matches in Node; catches crashes, stalls and runaway states.
- Two-browser end-to-end test (Puppeteer, as in Wave Rider): host, join, play scripted inputs, assert both sides agree on round results.
- Network chaos: simulated latency, jitter and loss on the gameplay channel in dev builds.
- Perf: perf HUD and Inspector; budget checks per tier.

## 11. Risks and open decisions

1. **Shop timing**: decided, shop phase or while dead (see §2).
2. **Original effective tick rate** is uncertain (Dota think scheduling), so friction feel is tuned by playtest against the converted constant.
3. **NAT traversal** without TURN fails for some players; PeerJS TURN is shared and rate-limited.
4. **Host advantage** in P2P; compensated in M1, removed with dedicated servers in M4.
5. **WebGPU coverage** is about 88% (Chrome/Edge desktop, Safari 26, Firefox 141+ on Windows and Apple Silicon; not Firefox Linux/Android). The WebGL2 fallback path must stay tested.
6. **three.js WebGPU is still labeled experimental** upstream; pin the version and upgrade deliberately.
7. **Determinism across browsers**: engine trig differs even between V8 versions. All sim trig goes through `sim/math.ts` (fdlibm-style); CI compares state hashes across engines.
8. **Small genre audience** (Spellsworn and Battlerite sit at tens of concurrent players; Spellbreak and Magicka: Wizard Wars shut down). Bots, instant solo play and near-zero hosting cost matter more than server scale.
10. **Staff casting** (2026-10-15 shelved, 2026-10-20 reworked): the staff now sits in the closed left fist, is carried upright beside the robe, is raised / thrust by procedural offsets over the hand-cast clips and falls with the body; with a staff every spell casts from its head crystal. Shipped as the wardrobe's staff slot (cosmetic only: the sim still spawns spells from the pawn); with a staff the victory pose plants it beside the body. Staff-specific clips would be the next step.
9. **Character art** is the biggest presentation lever. Decided: CC0 base, customized. Risk: stylized low-poly bases cap fidelity; revisit (AI 3D gen or commission) if the customized base cannot reach the bar.

## 12. Current planning status (audited 2026-10-20)

Use [NEXT-SPRINT.md](NEXT-SPRINT.md) for priorities. The old 2026-10-16 candidate list is
retired: it incorrectly described several completed systems as not started.

Implemented in the current source:

- Dedicated US/EU rooms, public Browse games and casual/ranked queues; the current ranked
  format supersedes the early 1v1 proposal. Explicit same-room recovery and universal
  session ownership are documented in [SESSION-RECOVERY.md](SESSION-RECOVERY.md).
- Accounts, reserved editable names, account-owned Elo/Embers/collection, and the first-party
  game / Pages media split. Completed cutover evidence is in the release receipts.
- Local replay recording/library/playback, ability hover videos, the Move cancels cast
  setting, system reduced-motion support and effect/shake controls. A separate in-game
  reduced-motion override is not implemented; the existing support follows the OS preference.
- Private analytics with trends and region/build breakdowns; completed-match player details.
  These do not preserve combat counters from aborted games.
- Shared seeded builds for all active bot tiers, cast-cancel readability, recorded death/kill
  sounds, the completed Maverick library, and streamed menu music. Combat synth music is
  intentionally disabled while a proper battle soundtrack remains unselected.
- Public custom games by default with an explicit private opt-out, and the join/ownership
  race fix that keeps the chosen visibility in the opened lobby.
- Required reload before stale clients can enter/start games; game UI/chat layout fixes.
- Fresh bot calibration, then the Hard–Brutal step widened (Brutal punishes openings, Hard on
  the original cast rate) and the Brutal–Uber step slightly (Uber punishes too), remeasured;
  see §7.

Still relevant engineering:

- Separate human-only activity checkpoints remain future work; do not fold partial counters
  into completed-match detail. Qualifying departures now settle as losses after 60 seconds of
  combat, with ranked Elo and durable queue-filtered history/builds. Operational aborts remain
  distinct. See [NEXT-SPRINT.md](NEXT-SPRINT.md) for the current scope.
- Select/integrate a real combat soundtrack; the present intentional silence is not a bug.
- P2P host migration, delayed competitive spectating, map pings and WebTransport remain later
  platform work, not prerequisites to the already working dedicated game.

Verification and maintenance, not unbuilt features:

- Real production passkey enrollment/reuse and signed-in cross-device/region reward play
  still require human verification. The user already confirmed public Google sign-in.
- Recheck `src/render/threePatches.ts` whenever upgrading three; the current version is pinned.
- Earlier prewarm, shader and cross-browser measurements are historical evidence, not proof
  of a current regression. Reproduce a problem before scheduling another performance rewrite.
- Showcase/trailer tooling is implemented and excluded from the app build.
