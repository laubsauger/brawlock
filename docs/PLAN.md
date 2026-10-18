# Brawlock: Plan

A new iteration of **Warlock** (Warcraft III custom map, later the official Dota 2 mod *Warlock Brawl*) as a standalone browser game. WebGPU, real online multiplayer, first-class bots, and a presentation bar of "AAA is the baseline".

Version 1 is faithful to the original core. Innovation comes after v1 ships and the core feels right.

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
2. **Faithful core, standalone polish.** The original mechanics and numbers, presented like a real game: splash, menus, lobby, settings, quality tiers, audio mixing, results. No mod-era hacks. No chat or console commands; every control has a UI.
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
| Lightning | 1 | Instant 600-range line, hits the first thing in its path; detonates your own and allied Fireballs (r225) |
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

Team mode Shuffle (default) / FFA / Teams. Game mode Rounds (default) / Deathmatch. Win after N rounds or first to score N. Tunables: start, round, kill and win gold; lava DPS; knockback and damage multipliers; friction; bots for leavers. Ranked: later (§9 M4).

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
- **Dedicated servers (M4)**: Bun process running the same `sim/` as input arbiter and authority, many rooms per process, 2–3 regional VMs. WebSocket first behind a transport interface, WebTransport datagrams later (server-side WebTransport libraries for Node/Bun are still immature; see `tech.md`). Per-match hosting (Edgegap) for ranked. Hathora, Rivet game hosting and Unity Multiplay are gone, so we avoid platform lock-in.

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
- Telegraph every windup (cast point) with a ground decal and animation; Scourge windup visibly charges.
- Knockback shows strength: trail length and hit-spark size scale with impulse; knockback points visible as a growing aura and a number.
- Lava danger: tiles about to drop pulse red one second before the shrink.
- Floating combat numbers, crisp and color coded, with stacking.
- One identity color pair per spell (src/render/vfx/palette.ts), distinct in hue and value from each other and from lava; the team color marks the caster.
- Every AoE visual ends exactly at the gameplay radius; players read ranges from visuals.
- On-screen text over the scene gets a glyph-following dark halo, never a boxy panel.
- Name tag with a compact HP bar over every pawn; broadcast-style kill feed (killer, cause icon, victim; lava kills credit the last hitter).
- VFX never hide a projectile hitbox. Effects have a hitbox-core layer drawn on top.

### 5.3 Characters and world

- Warlock characters: rigged glTF, idle, run, cast (3 variants), knocked-back tumble, burn, death, victory. Robe and cape get faked cloth motion in a TSL vertex shader (sway and trail from velocity and acceleration, stronger toward the hem), driven by a small damped spring per pawn that also takes hit impulses, and constrained outside body and leg capsules so it never clips. M0's procedural placeholder already uses the same technique. Decision (2026-10-15): CC0 rigged base (KayKit / Quaternius), heavily customized: TSL materials, hood, robe and cape geometry with the cloth shader, team-color runes, glowing staff. Cosmetic variants chosen in the lobby.
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
- Music: menu theme, shop-phase loop, combat layers that intensify as the arena shrinks.
- Sources: CC0 (freesound filtered, Kenney), Sonniss GDC bundles (royalty-free), commissioned later.

### 5.7 Screens and flow

```
Splash (static HTML that paints before JS; real loading progress, GPU benchmark; "Enter" is the audio-unlock gesture)
  └ Main menu (animated arena backdrop)
      ├ Play vs Bots  → Lobby (offline)
      ├ Host Game     → Lobby (share link, slots)
      ├ Join Game     → Lobby (5-letter room code, or a ?room=CODE link)
      ├ Settings      (video, audio, controls, gameplay, accessibility)
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

The game only matters if online play feels great. Before servers exist (M4), everything below runs P2P with local persistence.

- **Zero-friction joining**: 5-letter room code or link, name remembered, join in two clicks, reconnect with the same pawn.
- **Lobby**: player cards with name, color, ping bars, host crown, ready state and your head-to-head record against each opponent; bot slots with difficulty.
- **One-click rematch** from the results screen; clients follow automatically. Back-to-lobby keeps everyone.
- **Pings**: per-player latency in lobby and scoreboard. Map pings (alt-click to mark a spot for teammates) in M1.
- **Statistics**: post-match board (score, kills, deaths, damage, rounds won, MVP); career totals; match history; **encounters** (per-opponent wins, losses, last played); local leaderboard of players you have met with a local rating. Profiles use a stable per-browser id.
- **Global leaderboards, ranked and matchmaking** need authoritative servers (M4); results from P2P matches cannot be trusted for ranking.
- **Spectating**: mid-match joiners spectate and play the next match.

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
- Lobby: add bot to any slot, pick difficulty per slot, "fill empty slots" toggle, bots-for-leavers toggle. The difficulty selector's tooltip shows the tier's Elo and who it is for.
- Calibration: `npm run bots:elo` (scripts/bots/elo.ts) plays a seeded 1v1 round-robin of full first-to-5 matches on the real sim (about 40 s for 200 matches per pair, plus optional 4-player FFA pods). The unit is the **round**, the unit a player feels; a match turns a 75% round edge into about 90% of matches. Elo is the Bradley–Terry maximum-likelihood fit over all rounds (Medium = 1000); 95% intervals come from a bootstrap over whole matches, because rounds of one match share gold and items.
- FFA (2+ enemies): bots pick the best opportunity, not the weakest player on the map (distance, kill chance discounted by travel, an easy hit, who threatens them, a grudge, third-party pushes, minus targets others are already on and their crossfire), hold a target for a while, stand where it is least crowded and back off at low HP; a seeded personality varies this per bot (`targetSense` and the notes in `src/bots/presets.ts`). `npx vite-node scripts/bots/ffa.ts` measures 8-bot FFA spread; 8 Brutal bots went from 2.6 bots per target and a 4+ mob in 52% of samples to 1.5 and 3%.
- Ladder targets: Easy is the original AI for new players and never gets harder; Medium sits between Easy and Hard (wide gaps there are intended); Hard, Brutal and Uber are about 75% round win rate apart (150-250 Elo per step), with Uber the unchanged top. `src/bots/ladder.test.ts` replays 16 seeds per top step and fails outside 60-88% round win rate. `BOT_ELO` (`src/bots/presets.ts`) exports them rounded to 25 (Easy 350, Medium 1000, Hard 1750, Brutal 1925, Uber 2100) for a future human rating.

  | Tier | Round Elo | 95% CI | Step: rounds won | Step: matches won | Before: round Elo |
  |---|---|---|---|---|---|
  | Easy | 356 | 278-409 | - | - | 529 |
  | Medium | 1000 | anchor | 98% over Easy | 100% | 1000 |
  | Hard | 1739 | 1682-1819 | 99% over Medium | 100% | 1536 |
  | Brutal | 1935 | 1874-2016 | 75% over Hard | 91% | 1955 |
  | Uber | 2112 | 2052-2194 | 73% over Brutal | 95% | 2264 |

  Measured 2026-10-17, 200 matches per pair (seeds 1-200). "Before" is the previous ladder on its own scale (its Medium was weaker): every adjacent step was a match sweep (100-0, Uber over Brutal 98-2) with 85-96% of rounds. In 4-player FFA pods the steps shrink (Uber over Brutal 71%, Brutal over Hard 55% of pairwise placements): Brutal's edge is its build plan and edge pressure, which pay off most in a duel.
- M0 ships a port of the original AI (danger field dodge, lead aim, random casts) as Easy/Medium. M3 builds the full system.

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

Dedicated server build, region selection, public lobby browser, matchmaking, ranked 1v1, replays (inputs plus seed), spectator mode, host migration.

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
10. **Staff casting shelved** (2026-10-15): the staff attachment does not grip or follow the hands and would need staff-specific animations. Hand casting is the default; revisit the staff when animation work is budgeted.
9. **Character art** is the biggest presentation lever. Decided: CC0 base, customized. Risk: stylized low-poly bases cap fidelity; revisit (AI 3D gen or commission) if the customized base cannot reach the bar.

## 12. Status and open items (2026-10-16)

Done this session, beyond the milestones above:
- Netcode: client prediction default, host fairness delay (median client one-way latency, capped at 6 ticks), connection monitoring API (`session.netStats()`, `onNetGrade`) with HUD indicator, net graph (F3) and rate-limited warnings.
- Performance with 8 players: render CPU per frame from 6–7 ms to about 3.3 ms (static attribute uploads with update ranges, visible-only matrix updates, shadow refresh every 2nd frame on High/Ultra, warlock animation 3× cheaper and 2 draws per warlock, VFX buffers upload only the used range). Round transitions are flat at one vsync (cached tile material, budgeted texture uploads, pooled pillars built in a worker). Match start prewarms the arena in the lobby.
- Readability: team colours in team modes (`PLAYER_COLORS[team]`, matching banner names), colourblind palette option with player glyphs, unique bot names, readable warlock robes (old near-black look kept as `look: 'void'`), Scourge L1/L2/L3 visual and audio tiers (L1 tame, L3 the full blast), Scourge caster band, Lightning crack-and-echo sound and full bolt on misses, spell icons recoloured to the spell palette.
- Fixes: shop-phase spawns no longer land in lava with 5+ players (§2 deviation), tile whiteout on shrink, render crash guards and first-stack error capture.
- Settings: screen shake, frame rate limit, resolution scale, key-hint toggle.

Open:
- The hidden lobby prewarm occasionally (2 of 12 runs) has one 130–150 ms GPU-side compile frame; nothing over 100 ms after Start.
- `src/render/threePatches.ts` patches three r186 `Material.alphaTest` for shadow-pass materials (35–38% less allocation, ~40% fewer minor GCs); re-check on every three upgrade (dev warning fires if the internals change).
- Firefox and WebKit Playwright builds are too old for the installed driver; the cross-browser determinism check used Firefox.app and the system JavaScriptCore shell instead (0 mismatches over 1,080 checkpoints).
- Showcase supercut tooling lives in `scripts/showcase/` and `src/render/showcase/` (not imported by the app).

Done since the first §12 list (2026-10-16, second pass): lobby prewarm split (createImageBitmap, 4 ms upload budget, no lobby long task), nameplate style writes cut ~85%, shadow cache-key churn removed, warlock `setDetail` wired, rAF game clock while visible, shrink-warning pulse compositor-only, tile-seam flicker and shrink-ring whiteout fixed, thinner antialiased lava cracks, softer Scourge charge sound, cross-browser determinism verified. The two red/blue rings in the shop were Warp Zone casts by a bot (casting in the shop is allowed, as in the original).
Third pass: facing chevron drawn over the body (one shared draw; `FacingChevrons.ts`), screen shake independent of effects intensity, console clean in production, nameplate de-collision (max lift 2 plate heights), calm scripted menu backdrop (`menuStage.ts`), Rush absorb VFX, Snowball ice blue, README with screenshots.
Fourth pass (2026-10-16/17): exploding-robe fix at low fps (substepped front-envelope spring), shop no longer shifts plus ability hover cards with live sim stats (media slot reserved), kill feedback (stamp over the killer, KO callout, kill pips), announcer pack (ElevenLabs, Maverick default / Arena alternative: First Blood, multi-kills, streaks) on its own bus, flat top HUD, ambience bus and slider, calmer Splitter sounds, bots that time Teleport and Scourge plus the Uber difficulty (beats Brutal 38-2), default rules first to 5 / 25 s shop / kill gold 1 / win gold 2.

Not started (candidates): reduced-motion option (§M2 accessibility), preview clips in the hover cards (from `media/showcase/`), optional "click-to-move does not cancel a cast" setting, bot calibration and Elo bands (§M3), everything in §M4.
