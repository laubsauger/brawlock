# Brawlock: tech research for a browser Warlock remake

Research date: 2026-10-15. Scope: prior art, WebGPU rendering, networking/netcode, deterministic simulation in JS, audio, tooling, then recommendations.

Version numbers marked "(npm, 2026-10-15)" or "(GitHub, 2026-10-15)" were read from the npm registry or GitHub API on that date. Anything marked **[inference]** is my reasoning, not something a source says. Vendor blogs are flagged as such.

---

## TL;DR

- **Netcode:** a deterministic TypeScript sim with client-side predict/rollback for all entities. The server arbitrates inputs (it replaces late input after a deadline, the way Photon Quantum does) and also runs the same sim, so it holds the authoritative state for desync healing, reconnects, spectators and ranked results. Keep the sim a pure `step(state, inputs)` function over flat state. Then the fallback (server-authoritative state sync with own-entity prediction, i.e. the Battlerite / Colyseus 0.18 model) can reuse the same code.
- **Rendering:** three.js `WebGPURenderer` with TSL (r186). It falls back to WebGL2 automatically. Pin the version, because the three.js manual still calls it "experimental". Babylon.js 9 is the conservative alternative.
- **Transport:** WebSocket first, using Bun.serve (built on uWebSockets) or uWebSockets.js on Node. Hide it behind a transport interface. WebTransport is now Baseline in browsers (Safari 26.4, March 2026), but server-side support in the JS world is still "duct tape" (its own maintainer's word), so add datagrams later.
- **Hosting:** start with a few regional VMs, each running many rooms. Look at Edgegap per-match edge deployments once ranked needs it. Hathora shut down (May 2026). Rivet pivoted to "actors" for AI agents.
- **Shared-sim language:** TypeScript, not Rust/WASM, at this world size (about 10 warlocks plus about 50 projectiles). Ban the implementation-approximated `Math.*` functions in the sim.

---

## 1. Prior art

### 1.1 Original Warlock (WC3) and Warlock Brawl (Dota 2)

- **WC3 map:** "Warlock" by **Zymoran and Demestotenes** ("from Northrend") on Hive Workshop. The thread was posted 2008-07-24, and version 082 dates from 2008-08-22. Design facts from the thread:
  - Rounds are host-set (usually 10-20).
  - Everyone gets +10 gold per round, plus a winner bonus and 1g for the last hit and 1g for top damage.
  - The shop sells spells for about 10-22g, and each player has a personal item vendor during shopping time.
  - Host constants cover teams, gold, arena style (circle or square), rounds, shopping time, lava damage, knockback and arena shrink speed.
  - Players complained that "the arena shrinks too slowly with many players".
  - Source: https://www.hiveworkshop.com/threads/warlock-warlockbrawl.92290/ ; version 1.10F (July 2008) is credited to Zymoran and Adynathos: https://www.hiveworkshop.com/threads/warlock-1-10f.92687/
- **warlockbrawl.com:** the WC3 map was "actively developed for over six years". The original team ported it to **Dota 2 in 2014**, and that port was the focus for about two years. An "official standalone project" led by original co-creator **Adynathos** is listed as in development. Copyright line reads 2008–2020, so the site looks dormant. https://warlockbrawl.com/
- **Dota 2 Workshop "Warlock Brawl":** credits Zymoran, Tora (lead dev of the Dota mod) and Adynathos. Created 2015-03-09, last updated 2022-01-15, about 644k subscribers. At fetch time the page also said the item is "incompatible with Dota 2" and showed a removal notice. https://steamcommunity.com/sharedfiles/filedetails/?id=296662770
- **Netcode lineage [inference, low-confidence sources]:** WC3 runs a lockstep, host-centred model (https://www.hiveworkshop.com/threads/wc3-networking-crucial-component-of-codeless-save-load.304287), so the original Warlock always had noticeable command delay. Dota 2 is server-authoritative at about 30 Hz (third-party table: https://diamondlobby.com/server-tick-rates/). The genre has worked under both models.
- **Steam group:** "Warlock: Warcraft 3 Warlock, Dota 2 Warlock and standalone discussion", founded 2012-12-21. https://steamcommunity.com/groups/warlockbrawl
- **Ruin:** a Kickstarter "top-down arcade style arena brawler" based on Warlock Brawl (Kotaku, 2017-02-05). https://kotaku.com/another-game-based-on-an-old-warcraft-iii-mod-1792022301

### 1.2 Acolyte Fight (acolytefight.io), the main browser prior art

**Status (checked 2026-10-15):**
- The original repo `github.com/raysplaceinspace/acolytefight` now returns **404**. It has been deleted or made private.
- A mirror of the source survives at https://github.com/justchen1369/acolyte-fight (pushed 2020-11; README credits "rayhidayat" / @raysplaceinspace). New forks keep appearing, e.g. `tombury59/AcolyteFightRemaster` created 2026-09-25.
- **acolytefight.io now 301-redirects to `acolyte.easel.games`** ("Acolyte Fight! • Made with Easel"). The game lives on as a game on **Easel**, the author's own browser game engine/language.
- I found **no public shutdown post-mortem**. The closest statement is the author's 2018 Show HN comment: hosting "costs around $150 US a month, which means at some point I will probably stop running the game because that's a lot". https://news.ycombinator.com/item?id=17983325 . My reading [inference] is that the bespoke Node 8 / GCP stack was retired and the game was rebuilt on Easel. "Shut down" is not the right description.

**Original architecture (2018–2020, read from the mirror's source):**

| Area | What it did | Evidence |
|---|---|---|
| Language/stack | TypeScript, React/Redux UI, webpack. Node **8** only, because of the native `uws` lib | README, package.json |
| Rendering | Started as 5 stacked 2D canvases. Later a custom WebGL renderer (GLSL shaders in `src/client/graphics/*`) | HN thread, source tree |
| Physics | **planck.js** (JS port of Box2D) | package.json `planck-js ^0.3.9`, HN |
| Transport | socket.io 2 + msgpack parser over `uws` (WebSocket) | package.json |
| Netcode | **Server-relayed deterministic lockstep, with no client prediction and no rollback.** README: "The game is a deterministic simulation. The server arbitrates the input sequence and all clients replay the sequence in the same order… The lowest-latency client decides the authoritative world state in case of desyncs, and also runs all the bots. The server is very lightweight, does no simulation" | README "Technical notes" |
| Tick | `TicksPerSecond = 60`, `TicksPerTurn = 1`. The server timer (nanotimer) emits one tick message per tick. HN (2018) said the server broadcast every 32 ms then | `src/game/constants.tsx`, `src/server/core/ticker.tsx` |
| Client timing | The client keeps an `incomingQueue`. If it falls behind it catches up 2 ticks/frame, and if more than 1 s behind it skips ahead. Own actions only take effect after a full server round trip | `src/client/core/ticker.tsx` |
| Desync healing | Every 10 ticks (`SnapshotTicks`) each client sends hero `{id, health, x, y}`. The server rebroadcasts the newest one it receives, which in practice comes from the fastest client | `sendSnapshot()`, `games.queueSyncMessage()` |
| Determinism hygiene | Input positions quantised to `1/1024`. "ui*" properties excluded from sync. **But the sim uses native `Math.atan2/cos/sin/pow`** (`vector.tsx`, `engine.tsx`) | source |
| Late join | Full input history kept (max 15 min of ticks). Games close to joiners after a short period | `Matchmaking.MaxHistoryLength` |
| Ranking | glicko2 dependency plus a custom "Aco" rating (decay/deflation modules), Firestore storage | `src/server/ratings/*` |
| Hosting | 3 GCP regions (AU, EU, US) behind a load balancer. WebSockets needed cookie-based session affinity and long HTTP timeouts. Peak 40 users used about 1–2 ms/frame of server CPU | HN thread |
| Distribution | Providers for Poki, Kongregate and Facebook Instant Games. Discord login | `src/client/options/*`, `src/server/auth/*` |
| Modding | In-game mod editor (spells, maps, sounds, icons). User-written bots run in a Web Worker | source tree, HN |

**Lessons from Acolyte Fight:**
1. **A relay-only server is extremely cheap** (1–2 ms/frame at peak, and the author estimated "around a thousand clients" per server). The cost is that every action of your own waits a full RTT, so it only feels good on low-latency regional servers. The author (in NZ) called US latency "unbearable for the reaction time required for this game", which is why there were three regions. (HN)
2. **"Mostly deterministic plus periodic state patches" works in practice** even with native trig [inference from source]. It does make a client the authority over positions and health, which is a cheat vector: the server accepts any active player's sync message for a newer tick (`receiveSync` → `queueSyncMessage`). For ranked play the server must own the state.
3. **The author's next step was rollback.** Easel, the platform the game now runs on, uses predictive rollback (details in 1.3). The person who built the closest prior art moved from plain lockstep to rollback.
4. **Gameplay/UX notes (HN):**
   - Separating movement from spell casting fixed a stutter.
   - Click-to-move was chosen after user testing, because players disliked cursor-follow movement.
   - Expensive canvas effects (blur) wrecked Firefox performance, so there need to be graphics quality tiers.
   - One-minute rounds and auto-matchmaking into rooms kept the queue moving.
5. **Native deps age badly.** `uws` pinned the server to Node 8, and that pin made the repo "very hard to run" (README).

### 1.3 Easel: the Acolyte Fight author's current netcode (relevant design reference)

From https://easel.games/docs/learn/multiplayer/rollback-netcode and https://easel.games/blog/2026-rollback-physics (2026-05-01):
- **Rollback netcode at 60 ticks/s.** Every client simulates the whole game, predicts missing inputs, and on a misprediction rolls back and resimulates. Visual corrections are smoothed with automatic "rubberbanding".
- **Topology:** peers send input once to the nearest **Cloudflare** edge, which forwards it to the other peers. "The Easel server keeps final authority over the input sequence." Time sync is piggybacked on input messages. Each player experiences the latency they contribute, so a distant player's lag does not affect the others. Matchmaking uses geolocation rather than fixed regions.
- **Input sparsity:** "players typically send input only a few times per second", so most frames predict correctly.
- **Determinism:** Easel wrote its own language because "Lua, JavaScript, or other existing languages" lacked the needed determinism (floats, RNG, trig, execution order) and coroutine snapshotting.
- **Physics:** the 2026 post describes a custom engine with **incremental snapshotting**, because an off-the-shelf engine "would have to snapshot and roll back the entire world" every frame. Collision detection is built on **Parry** (the library under Rapier). About 30 objects change per frame out of thousands, so snapshots are 30–50x smaller.

### 1.4 Other Warlock-likes and what happened to them

| Game | Model | Outcome / note | Source |
|---|---|---|---|
| **Spellsworn** (Frogsong, Steam, F2P since Mar 2018) | Explicitly "inspired by… the Warcraft 3 mod Warlocks". Lava closes in each round; knockback spells | Very Positive (~1.5k reviews), but **single-digit to ~40 CCU** in 2024–2026 | https://store.steampowered.com/app/360620/Spellsworn/ , https://steambase.io/apps/360620 |
| **Battlerite** (Stunlock) | Top-down projectile arena brawler. Server-authoritative over movement, casts and **projectile collisions**. Client predicts own movement; target ≤150 ms; devs admit "invalid hitboxes" from latency are more visible because projectiles are slow and the camera is top-down | Still on Steam, ~30–80 CCU in 2026 | https://blog.stunlock.com/dev-blog-008/ , https://steambase.io/apps/504370 |
| **Spellbreak** (Proletariat) | 3D magic battle royale | Servers shut down **2023-01-10** after Blizzard acquired the studio; falling player counts | https://www.shacknews.com/article/131137/spellbreak-server-shutdown-2023 |
| **Magicka: Wizard Wars** (Paradox) | Wizard PvP arena | Closed **2016-07-21**; servers "losing money" | https://pcgamer.com/magicka-wizard-wars-is-closing-in-july |
| **Mages** (redka, PlayCanvas, 2019) | Browser 3D Warlock-like, shop between rounds, FFA/teams, host player | Small population. Author said mobile controls were "too hard to make competitive" | https://forum.playcanvas.com/t/mages-multiplayer-arena-game-loosely-based-on-warlock-from-warcraft-3/9397 |
| **Warlocks JS** (2025) | Browser Warlock-like, up to 8 players, shrinking safe zone, "server-authoritative" | Directory listing only, no developer info | https://lutris.net/games/warlocks-js/ |

**What worked across these [inference]:**
- The core loop (knockback + shrinking lava + between-round shop) keeps getting re-made and keeps getting good reviews.
- Every standalone version struggled to hold enough concurrent players to fill 10-player lobbies. Plan for this from day one: bots (Acolyte Fight ran bots on the lowest-latency client), small minimum lobby sizes, fast matchmaking into running rooms, short rounds, and free web distribution (Acolyte Fight used Poki and Kongregate).
- Servers that cost money with no revenue get shut down (Magicka WW, and the Acolyte Fight author's own HN remark). Keep the per-match server cost near zero.

---

## 2. Rendering (WebGPU in 2026)

### 2.1 WebGPU support matrix (as of 2026-10-15)

Primary sources: the gpuweb Implementation Status wiki (edited 2026-10-02) https://github.com/gpuweb/gpuweb/wiki/Implementation-Status and MDN browser-compat-data `api/GPU.json` (main branch, fetched 2026-10-15).

| Browser / platform | WebGPU on by default? | Since |
|---|---|---|
| Chrome / Edge, Windows x64, macOS, ChromeOS | Yes | 113 |
| Chrome, Windows **ARM64** | Behind flag | – |
| Chrome, Linux | Partial: Intel Gen12+ (144), NVIDIA driver ≥535.183.01 on **Wayland** (147); others behind flag | 144/147 |
| Chrome Android | Yes on Android 12+ with ARM/Qualcomm/Intel GPUs (121) and Imagination on Android 16+ (139). **Samsung Xclipse and "others": TBD** | 121 |
| Firefox Windows | Yes | 141 (July 2025) |
| Firefox macOS | Apple Silicon only: macOS 26 since 145, all macOS versions since 147. **Intel Macs: no** | 145/147 |
| Firefox Linux | **No** (Nightly only; Mozilla "expects to ship on Linux in 2026") | – |
| Firefox Android | **No** (flag / blocklist override only) | – |
| Safari macOS / iOS / iPadOS / visionOS | Yes, on OS 26 (macOS Tahoe, iOS 26) | Safari 26 |

- caniuse puts global WebGPU coverage at about **87.8%** (85.8% full + 2.0% partial) and marks Safari macOS as "partial" for 26.0–26.6 without saying why. https://caniuse.com/webgpu
- web.dev, "WebGPU is now supported in major browsers" (2025-11-25), confirms the same gaps: Linux, broader Android, Firefox on Intel Macs, Firefox Android. https://web.dev/blog/webgpu-supported-major-browsers
- **Takeaway:** a WebGL2 fallback is still mandatory for Linux, Firefox on Linux/Intel Mac/Android, a long tail of Android GPUs, and older iOS (pre-26). Anything that fails `navigator.gpu.requestAdapter()` also needs it.

### 2.2 Engine options

| Engine | Version (2026-10-15) | WebGPU status | WebGL2 fallback | Notes |
|---|---|---|---|---|
| **three.js** `WebGPURenderer` + TSL | r186 (2026-09-24), npm `three@0.186.1` | Official manual (dev branch, fetched today): "The renderer itself is **still in an experimental state** although its maturity level has been greatly improved". Some may find "missing features or a better performance with `WebGLRenderer`" | **Automatic**: same renderer, WebGL2 backend. `forceWebGL: true` to force it | TSL compiles to WGSL or GLSL, so one shader source serves both backends. **Not supported:** `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile`, `EffectComposer` (use node post-processing). Needs async init (`setAnimationLoop` or `await renderer.init()`). Breaking renames happen between releases (third-party: r183 renamed `PostProcessing`→`RenderPipeline`). `KTX2Loader.detectSupport()` handles `WebGPURenderer`. Release cadence about every 2–3 months. https://github.com/mrdoob/three.js/blob/dev/manual/pages/webgpurenderer.html |
| **Babylon.js** | 9.30/9.31 (weekly minors). 9.0 launched March 2026 | Mature `WebGPUEngine`. Since **8.0 (2025-03-27)** all core shaders ship in both GLSL and WGSL, so there is no 3 MB GLSL→WGSL converter (about 2x smaller WebGPU builds, per Microsoft) | Yes: `Engine` (WebGL2) or `WebGPUEngine`, chosen at init | 9.0 added clustered lighting (WebGPU + WebGL2), node particle editor, Frame Graph. Strong API-stability culture; Microsoft-backed. https://blogs.windows.com/windowsdeveloper/2025/03/27/announcing-babylon-js-8-0/ |
| **PlayCanvas** engine | v2.23.3 (2026-10-15) | WebGPU supported through `createGraphicsDevice({ deviceTypes: [...] })`. A 2026 PR makes the fallback chain explicit (`[WEBGPU, WEBGL2, NULL]`) and makes the call reject instead of hang. The editor labelled WebGPU "beta" in older posts. Device-specific breakages exist (issue #8874: Pixel 10 / PowerVR falls back to WebGL2) | Yes, via device-type list | Strongest when used with its cloud editor. https://github.com/playcanvas/engine/pull/9603 , https://github.com/playcanvas/engine/issues/8874 |
| **Raw WebGPU** (WGSL) | – | Full control, smallest runtime | You must build your own WebGL2 path, i.e. two renderers | Only worth it for a tiny 2.5D renderer. For a 2–4 person team, maintaining two backends erases the benefit [inference] |

**Engine fit for this game [inference]:** the scene is a top-down arena, ≤10 characters, many short-lived VFX (fireballs, lava, shockwaves) and a shrinking-lava shader.
- three.js plus TSL gives one VFX/shader codebase for both backends and the biggest ecosystem (glTF, KTX2, meshopt, particles).
- Its "experimental" label is mostly about API churn, not WebGPU-specific bugs. Pin the exact version and upgrade on purpose.
- Babylon is the pick if you value API stability over ecosystem size.
- Either way, keep rendering out of the sim. The renderer only reads interpolated sim state.

### 2.3 WebGL2 fallback recommendations
- Use the engine's built-in fallback (three.js `WebGPURenderer`, Babylon `Engine`/`WebGPUEngine`) rather than two hand-written paths.
- Write all custom shading in **TSL** (three.js) or Babylon node materials so both backends work. Avoid WebGPU-only features in the core look (storage buffers, compute particles). Use compute only as an optional enhancement tier.
- Graphics quality tiers (Acolyte Fight had six levels) and a "force WebGL" setting for broken drivers.

---

## 3. Networking

### 3.1 Transports

**WebTransport browser support** (MDN BCD `api/WebTransport.json`, fetched 2026-10-15; caniuse https://caniuse.com/webtransport):

| Browser | Since | Notes |
|---|---|---|
| Chrome / Edge | 97 / 98 | `serverCertificateHashes` since Chrome 100. `congestionControl`, `requireUnreliable`, `allowPooling` **not** supported in Chrome |
| Firefox | 114 | `serverCertificateHashes` since 125 |
| Safari macOS + iOS | **26.4** (WebKit post 2026-03-24) | Datagrams, bidirectional streams, and "When the underlying network environment doesn't support QUIC, WebTransport can run over HTTP/2 and TCP as a fallback". https://webkit.org/blog/17862/webkit-features-for-safari-26-4/ |
| Samsung Internet | 18 | |

- WebTransport became **Baseline "newly available" in March 2026**. caniuse global coverage is about **91.6%**.
- caveat (third-party, unverified): Chrome and Safari still send the legacy `:protocol = webtransport` token rather than draft-15's `webtransport-h3`, so servers should accept both. https://www.utsubo.com/blog/frontier-web-apis-2026-production-ready
- The IETF draft (draft-ietf-webtrans-http3-15, 2026-03-02) is still in WG last call.
- **Self-signed per-match servers:** `serverCertificateHashes` needs an ECDSA P-256 cert valid for **< 2 weeks**, and `allowPooling: false`. https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport
- Safari can fall back to HTTP/2/TCP, so "datagrams" may silently become TCP-like unless `requireUnreliable: true` is set. Chrome doesn't support that flag.

**Server-side WebTransport is the weak link in a TS stack:**

| Server option | Status |
|---|---|
| Node: `@fails-components/webtransport` 1.6.10 (pushed 2026-10-14) | libquiche binding. The author calls it "a duct tape-style solution until a bulletproof native support of HTTP/3 and WebTransport is provided by node itself". Also ships a WebSocket-based polyfill. https://github.com/fails-components/webtransport |
| Node core `node:quic` | Behind `--experimental-quic`; WebTransport/HTTP semantics not yet available (per the Node QUIC blog post, ~mid-2026) |
| Bun 1.4.3 | No HTTP/3 or WebTransport found |
| Colyseus `@colyseus/h3-transport` | **Experimental**, "hasn't been battle tested". Wraps fails-components. It is the only Colyseus transport with real unreliable datagrams (`.unreliable()` fields, `room.input({mode:"unreliable"})`). https://docs.colyseus.io/server/transport/webtransport |
| Rust `wtransport` 0.7.2 (2026-08) / Go `quic-go/webtransport-go` v0.13.0 (2026-08) | Maintained native options, if you accept a non-TS edge process |

**WebSocket** is still the pragmatic default for browser games. TCP head-of-line blocking causes bursts under packet loss.
- uWebSockets.js v20.71.0 (2026-09-16).
- **Bun's WebSocket "is built on uWebSockets"** (https://bun.com/docs/runtime/http/websockets).
- Colyseus 0.18 supports `ws`, uWebSockets.js and Bun WebSockets (https://docs.colyseus.io/server/transport).

**WebRTC data channels** give unreliable/unordered UDP today in every browser.
- **geckos.io v3.1.0 (2026-03-27)**, built on `node-datachannel` 0.33.4 (2026-09). https://github.com/geckosio/geckos.io
- Costs: ICE/STUN signalling, UDP port ranges on the server, heavier connection setup.
- Cloudflare Realtime SFU also routes DataChannels: $0.05/GB egress, first 1,000 GB/month free. https://developers.cloudflare.com/realtime/sfu/pricing

**[inference] Which transport matters less with rollback.** Inputs are tiny and can be sent redundantly (each packet carries the last N inputs). A TCP stall shows up as a late input, and rollback is built to absorb late inputs. State-sync netcode is hurt more by HOL blocking, because snapshots back up behind a lost packet.

### 3.2 Netcode models for a 10-player knockback brawler

Background:
- Gaffer on Games, *Networked Physics*: https://gafferongames.com/post/deterministic_lockstep/ , https://gafferongames.com/post/snapshot_interpolation/ , https://gafferongames.com/post/state_synchronization/
- Gambetta, *Fast-Paced Multiplayer*: https://www.gabrielgambetta.com/client-server-game-architecture.html
- Valve, *Source Multiplayer Networking*: https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- Infil on rollback: https://words.infil.net/w02-netcode.html

Key facts:
- Gaffer: lockstep "becomes problematic" as player count grows (he suggests 2–4 players for classic P2P lockstep). A 10 Hz snapshot rate implies at least 100 ms of interpolation delay, about 150 ms in practice.
- **GGPO** hard-codes `GGPO_MAX_PLAYERS 4` and `GGPO_MAX_PREDICTION_FRAMES 8` (P2P), so classic GGPO doesn't fit 10 players (`src/include/ggponet.h`, https://github.com/pond3r/ggpo).
- 10-player rollback in practice means **server-arbitrated rollback**, like **Photon Quantum**:
  - The server confirms each player's input per frame. If an input "did not reach the server in time" it is replaced (repeat or null) and the confirmed frame is broadcast.
  - Quantum recommends "soft lockstep" (min input offset ≥10 ticks) only for games that truly need lockstep.
  - https://doc.photonengine.com/quantum/v3/manual/frames , https://doc-api.photonengine.com/en/quantum/current/class_photon_1_1_deterministic_1_1_deterministic_session_config.html
- Easel does the same in the browser (section 1.3).
- **Battlerite**, the closest commercial analog, used server-authoritative state with own-movement prediction and lived with "invalid hitbox" complaints (section 1.4).
- Rocket League predicts every object, remote cars included, and resimulates the world on correction (community description of the GDC 2018 talk, https://gamedev.net/forums/topic/713082-rollbacks-and-simulation-replay-performance).
- **Colyseus 0.18** has built-in fixed-timestep server sim plus client prediction:
  - `predict.reconciler` rollback/replay of your own entity.
  - Remote entities shown by interpolation or dead reckoning.
  - Server rewind for lag compensation (`allowRewindState`).
  - Predicted projectile spawns (`predict.spawns`).
  - You supply a deterministic step function.
  - https://docs.colyseus.io/netcode

| Criterion | A. Server-auth state sync + own prediction + interpolation (Battlerite / Colyseus 0.18) | B. Server-relayed lockstep, no prediction (Acolyte Fight) | C. Server-arbitrated predict/rollback, server also simulates (Quantum / Easel style) |
|---|---|---|---|
| Own input latency | ~0 (predicted) | Full RTT + buffer | ~0 (predicted), optional 1–3 tick input delay to cut rollbacks |
| Getting knocked back | Server applies it at server time; your predicted self is ~RTT ahead, so reconciliation **snaps** you. You saw the fireball still ~RTT/2+interp away when it hit ("invalid hitbox") | Consistent, but late by RTT | Consistent single timeline. Remote casts arrive late and are fast-forwarded (projectile "pops" a few ticks along its path). Hits match what you see after correction |
| Warlock-vs-warlock body pushes, chains, homing | Inconsistent: two timelines (you in the future, others in the past) | Exact | Exact (after resim) |
| Determinism needed | No (state is sent) | Strict, or patch state (AF did) | Strict. The server sim detects and heals desyncs |
| Bandwidth | ∝ entities × clients × snapshot rate | Inputs only | Inputs + checksums + occasional snapshot |
| One laggy player | Affects only them | Everyone waits or that player falls behind | Only them (server deadline replaces missing input) |
| Cheat surface | Low | AF trusted client hero snapshots | Low: clients send only inputs; server sim is authoritative (no fog of war in Warlock, so full-state clients leak nothing) |
| Reconnect / hot join / spectate | Easy | Needs full input history | Snapshot from server sim + inputs since |
| Replays / ranked audit | Record state | Free (inputs) | Free (inputs), plus server checksum per tick |
| Client CPU | 1 sim of own entity | 1 sim | Up to (RTT in ticks) resims per frame. At 60 Hz and 150 ms RTT that is ~9 ticks. A 10-warlock/50-projectile 2D world is microseconds per tick [inference] |
| Engineering | Medium (largely built into Colyseus 0.18) | Low | High, but the sim is small and self-contained |

**Verdict:**
- **Option C** fits Warlock best:
  - The gameplay is physics interactions between players: knockback chains, pushing into lava, body blocking, deflects. Only a single shared timeline makes those consistent.
  - WC3-style input is **sparse and sticky** (a move order stays in force until replaced; casts are discrete). "Repeat last input" prediction is therefore usually right, and Easel reports the same pattern.
  - Running the sim on the server too gives ranked-grade authority without client state upload.
- **Option A** is the fallback if strict cross-engine determinism turns out too costly. Its weaknesses (snapping on knockback, two timelines) are partly patchable: extrapolate enemy projectiles to your predicted time, since projectile paths are deterministic once spawned, and smooth corrections. Battlerite's experience shows players will notice the artifacts in this genre [inference].
- **Option B** is only acceptable for a LAN-like prototype.

### 3.3 Frameworks and hosting (state as of 2026-10)

| Option | State | Fit |
|---|---|---|
| **Colyseus 0.18** (MIT; server pushed 2026-10-15; `@colyseus/sdk` 0.18.5) | Active. Rooms, matchmaking, reconnection, schema state sync, **new 0.18 netcode APIs** (prediction/reconciliation/rewind). Transports: ws, uWS, Bun, experimental WebTransport. **Colyseus Cloud from $15/mo**, "no CCU/DAU/MAU limits"; self-host free. https://colyseus.io/pricing/ | Best off-the-shelf for Option A. Usable as room/matchmaking plumbing for Option C (raw messages, fixed-timestep loop) |
| **Nakama** v3.41.0 (Apache-2.0, 2026-09-18) | Accounts, social, leaderboards, matchmaking, authoritative matches. **TypeScript runtime runs on goja and is limited to ES5**: no Node/web APIs, no global state between calls, single-threaded. https://heroiclabs.com/docs/nakama/server-framework/typescript-runtime/ | Poor host for a shared TS sim. Possible later as an account/leaderboard backend, with the Go runtime for anything heavy |
| **Hathora** | **Dead for games.** Announced 2026-03-04 that game hosting closes. Shutdown 2026-05-05 (one report said end of April). Team joined Fireworks AI. Official migration path: **GameFabric by Nitrado**. Stormgate's online play went offline. https://insider-gaming.com/stormgate-going-offline-provider-hit-ai-pivot/ , https://gameye.com/blog/game-server-shake-up-2026 (vendor blog) | Avoid |
| **Unity Multiplay** | Direct support ended 2026-03-31; licensed to Rocket Science Group (vendor blog above) | n/a |
| **Rivet** (Apache-2.0) | Pivoted: "Rivet Actors… Built for AI agents, collaborative apps, and durable execution". Cloud: Free / $20 / $200 per month plus usage. Multiplayer is listed only as "Multiplayer state over WebSockets". https://rivet.dev/cloud/ | Not a game-server orchestrator any more |
| **Edgegap** | Container orchestration at the edge. **$0.00115 per vCPU-minute** (≈ $0.069/vCPU-hour), egress $0.10/GB; private fleet $280–350/host/month; free trial 1.5 vCPU, 60-min deployments. Marketed migration target for Hathora users. https://edgegap.com/pricing | Good later for per-match placement near the players' latency centroid (ranked). Overkill at launch |
| **PlayroomKit** | Serverless / host-player model (`isHost`, `transferHost`); "without running your own backend". https://docs.joinplayroom.com/ | Not authoritative, so not suitable for ranked |
| **Cloudflare Durable Objects** | Single-threaded stateful object per room, WebSocket only (no UDP/WebTransport). Paid: $12.50 per M GB-s (billed at 128 MB per object), $0.15 per M requests, incoming WS messages billed 20:1. A room ticking at 60 Hz can't hibernate. https://developers.cloudflare.com/durable-objects/platform/pricing/ | **[inference]** About **$0.006/hour** duration plus about **$0.003/hour** messages for a 10-player room (10 msgs/s/player). Very cheap and global for an input-relay server (Easel relays via Cloudflare). Weaker for running a full authoritative sim per room |
| **Bun / Node + uWS on VMs** | Bun 1.4.3; uWebSockets.js 20.71.0. **Fly.io** supports UDP but needs a dedicated IPv4, binding to `fly-global-services`, and about 1300-byte MTU. https://docs.fly.io/networking/udp-and-tcp | Recommended starting point: a few regional machines, many rooms per process |

---

## 4. Deterministic simulation in JS/TS

### 4.1 What the standards guarantee
- **Basic arithmetic is exactly specified.** ECMA-262: `Number::multiply` (and add/subtract/divide) "performs … according to the rules of IEEE 754-2019 binary double-precision arithmetic". So `+ - * /` on Numbers give bit-identical results in V8, SpiderMonkey and JSC.
- **`Math.sqrt` is exact.** The spec says "Return 𝔽(the square root of ℝ(n))", i.e. correctly rounded.
- **Approximated functions.** The spec lists `acos, acosh, asin, asinh, atan, atanh, atan2, cbrt, cos, cosh, exp, expm1, hypot, log, log1p, log2, log10, pow, random, sin, sinh, tan, tanh` as "not precisely specified", and `Math.sin` returns "an implementation-approximated Number value". **`Math.hypot` and `Math.pow` are in that list too**, which is an easy trap. https://tc39.es/ecma262/#sec-function-properties-of-the-math-object
- **Real divergence happens even inside one engine family:**
  - The `bounce` JS physics engine (issue #8, 2026-08-03) found **Node 20 (V8 11.3) and Chrome 149 (V8 14.9) produce different `Math.sin/cos`** and therefore different sim hashes, while `Math.sqrt` matched.
  - The fix was fdlibm-style sin/cos/atan using only exactly specified ops (about 1.1x native cost, max error ~1.1e-16).
  - https://codeberg.org/perplexdotgg/bounce/issues/8
- **WebAssembly floats** are IEEE deterministic except for **NaN bit patterns** and the **relaxed-SIMD** proposal, which is deliberately non-deterministic. https://www.webassembly.org/docs/nondeterminism/ , https://docs.wasmtime.dev/examples-deterministic-wasm-execution.html

### 4.2 Practical rules for a deterministic TS sim [mostly inference, grounded in the above]
1. **Ban list in the sim package** (lint rule): all of the approximated `Math.*` functions above, plus `Math.random`, `Date.now`, `performance.now`, and iteration over anything with engine-defined order.
2. **Provide your own** `sin/cos/atan2`: fdlibm port, or avoid angles entirely and work with unit vectors (normalise via `Math.sqrt`, which is exact). Use a seeded integer PRNG (e.g. xorshift/PCG on uint32 with `Math.imul`).
3. **Quantise inputs** at the network boundary (AF used 1/1024) so every client feeds bit-identical inputs.
4. Fixed-point is **not required** in JS, because double arithmetic is already exactly specified. Use it only if you want a Rust/C# port to match bit-for-bit without care. JS fixed-point libraries are thin: `@hastom/fixed-point` is BigInt-based and slow for a sim loop. Int32 fixed-point with `Math.imul` is DIY.
5. **Flat state** (typed arrays / SoA, or plain objects with stable ordering) makes snapshot and restore for rollback a `TypedArray.set()` copy.
6. **Cross-engine determinism CI is the most important test:** run the same input log in Node (V8), Bun (JSC), and Chromium/Firefox/WebKit (Vitest browser mode or Playwright) and compare per-tick hashes. Running the server on Bun (JSC) while most clients are Chrome (V8) also exercises cross-engine determinism in production [inference].

### 4.3 Physics engine options
- **Rapier (Dimforge):**
  - The JS repo `dimforge/rapier.js` was **archived** and merged into the main repo under `bindings/typescript`.
  - npm `@dimforge/rapier2d-deterministic` 0.21.0 (2026-09-25) is the build with the `enhanced-determinism` feature. A separate `-simd` build exists; don't use SIMD builds for lockstep.
  - Docs: "The WASM/Typescript/JavaScript version of Rapier is fully cross-platform deterministic", given the same version, the same insertion order, and inputs from deterministic ops. Snapshot MD5s match across machines. https://rapier.rs/docs/user_guides/javascript/determinism
  - Rollback means `world.takeSnapshot()`/restore of the whole world. Easel's 2026 post explains why that gets expensive for large worlds; it is fine for a small arena.
- **Box2D v3:** cross-platform determinism via custom trig, no FMA (`-ffp-contract=off`), and CI on x64/ARM. But "**Box2D does not provide roll-back determinism**" (internal state and ordering issues). https://box2d.org/posts/2024/08/determinism/ ; npm `box2d3-wasm` 5.2.0 (2026-02).
- **planck.js** 1.5.1 (what Acolyte Fight used) is pure JS, but its rotations use native trig, so it is not cross-engine deterministic.
- **[inference] Recommendation: custom 2D sim.** Warlock physics is circles with velocity, friction and damage-scaled knockback impulses, plus a few static obstacles and projectile sweeps. That is a few hundred lines of TS. It gives exact control of "feel", trivial snapshots and guaranteed determinism. Reach for Rapier only if obstacle geometry gets complex.

### 4.4 Rust→WASM shared sim: pros and cons
**Pros:**
- One `.wasm` binary runs identically in every browser and in Node/Bun on the server, as long as you avoid relaxed SIMD and NaN-bit dependence.
- Rollback snapshot can be a memcpy of linear memory.
- No GC pauses.
- Strong performance headroom.

**Cons:**
- Two languages and a heavier build.
- JS↔WASM boundary costs: primitive calls are cheap, but copying large arrays is ~ms. Design coarse-grained APIs and share memory views.
- Gameplay iteration (spell scripting, balance tweaks) is slower.
- If the server runs **native** Rust instead of the same wasm, you inherit FMA/libm divergence (Box2D needed custom trig and `-ffp-contract=off`).

**Verdict [inference]:** not worth it at ~60 entities. Revisit only if profiling shows rollback resims eating the frame budget.

---

## 5. Audio
- **Web Audio API:**
  - `PannerNode` (HRTF or equal-power) and `StereoPannerNode` cover spatial needs.
  - For a top-down camera, stereo pan by screen-x plus distance gain usually beats HRTF [inference].
  - three.js `PositionalAudio` wraps `PannerNode`.
  - The `AudioContext` must be resumed after a user gesture (iOS especially).
  - https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Web_audio_spatialization_basics
- **Howler.js:**
  - Latest release **v2.2.4 (2023-09-19)**. The last commit (2025-11-23) was a README update. 420 open issues.
  - Still ~1.07M weekly npm downloads.
  - Effectively in maintenance mode. Usable for sprites and format fallback, but don't rely on it for new Web Audio features.
  - https://github.com/goldfire/howler.js
- **Alternative:** a thin custom Web Audio layer (buffers, pooled voices, buses, duck/limit) of ~200 LOC. Tone.js 15.1.22 (2026-10) is active but music-oriented.
- **Acolyte Fight** ran audio synthesis in a worker (`src/client/audio/worker.tsx`), with no asset files for many SFX.

---

## 6. Tooling (versions from npm, 2026-10-15)
| Tool | Version | Note |
|---|---|---|
| Vite | 8.3.4 | Bundles with **Rolldown ~1.2** and **LightningCSS** (from Vite 8 dependencies) |
| Vitest | 5.0.5 | Browser mode via `@vitest/browser-playwright`; peer `vite ^6‖^7‖^8` |
| Playwright | 1.64.1 | WebGPU in headless CI needs `--enable-unsafe-webgpu` plus a Vulkan/SwiftShader adapter (`--use-webgpu-adapter=swiftshader`), or headed under `xvfb-run`. Avoid `--disable-gpu`; check `chrome://gpu` in CI. Practical sources: https://developer.chrome.com/blog/supercharge-web-ai-testing , https://agent-browser.dev/webgpu . Easiest: render tests with `forceWebGL`, sim tests headless |
| TypeScript | **7.0.2** (latest, 2026-07-08; native compiler line); 6.0.3 also available | Check plugin/ESLint compatibility before adopting 7 [not verified] |
| Bun | 1.4.3 | Server runtime; WebSockets on uWS |
| pnpm | 12.11.2 | Workspaces |
| Turborepo | 2.11.8 | Optional task cache; Nx 23.3 is the heavier alternative |
| glTF-Transform | 4.5.1 (`@gltf-transform/cli`) | Optimise, dedupe, meshopt, KTX2 |
| meshoptimizer / gltfpack | 1.3.0 (2026-09-25) | `EXT_meshopt_compression`. Fast decode; actively maintained |
| Draco (`draco3d`) | 1.5.7 (2024-01) | Older, slower decode; prefer meshopt [inference] |
| KTX2 / Basis Universal | basis_universal v2_50 (2026-08); KTX-Software v5.0.0-rc2 (2026-08) | three.js `KTX2Loader.detectSupport()` works with `WebGPURenderer` (source) |
| Blender | Khronos glTF exporter is bundled (glTF-Blender-IO) | Blender 5.0 reportedly dropped Collada (secondhand); glTF is the path anyway |
| Ratings | `openskill` 5.0.1 (Weng-Lin, multiplayer FFA) and `glicko2` 1.2.2 | FFA with 2–10 players fits OpenSkill/TrueSkill-style better than 1v1 Glicko [inference] |

Suggested monorepo layout [inference]:
- `packages/sim`: pure TS. No DOM and no Node imports. Lint-banned Math functions.
- `packages/protocol`: message schemas and binary codec.
- `apps/client`: Vite + three.js.
- `apps/server`: Bun.
- `tools/assets`: glTF-Transform scripts.

---

## 7. Recommendations

**1. Netcode model: server-arbitrated deterministic predict/rollback, with the server also running the sim.**
- Clients send quantised inputs, tagged with their intended tick, redundantly. The server assigns inputs to ticks, enforces a deadline (repeat-last if late, as Quantum does), and broadcasts confirmed input frames at 60 Hz (batched 2 per packet is fine).
- The server steps the same sim, emits a state hash every N ticks, and serves snapshots for reconnect, spectators and desync recovery.
- Clients predict all entities by repeating last inputs, roll back on confirmed frames, and smooth visual corrections, especially for remote warlocks and late-spawned projectiles.
- Optionally use 1–3 ticks of input delay to cut rollback distance.
- *Why:* knockback chains between players need one shared timeline. WC3-style inputs are sparse and sticky, so predictions are usually right. Input-only clients plus a server sim give ranked-grade authority. Acolyte Fight proves the relay model is cheap, and its author's next system (Easel) is exactly this design.
- *Escape hatch:* the same pure `step()` function supports Option A (Colyseus 0.18-style own-entity prediction plus state sync) if determinism costs too much.

**2. Shared sim language: TypeScript.**
- Custom 2D circle physics in a standalone package.
- Doubles are fine. Ban approximated `Math.*` (including `pow` and `hypot`). Use fdlibm-style trig or vector math, and a seeded integer PRNG.
- Run cross-engine golden-hash tests (V8, JSC, SpiderMonkey) in CI from day one.
- Reconsider Rust→WASM only on profiling evidence.

**3. Rendering engine: three.js `WebGPURenderer` + TSL (r186, pinned).**
- WebGL2 fallback is automatic and required: Firefox Linux/Intel-Mac/Android, Linux Chrome on non-Intel-Gen12 hardware, older iOS and the Android long tail. That is roughly 12% of users with no WebGPU per caniuse.
- Write all shaders in TSL. Keep compute-based effects optional.
- Babylon.js 9 is the alternative if API stability matters more than ecosystem.

**4. Transport: WebSocket now, WebTransport later.**
- Bun.serve WebSockets (uWS) with a binary protocol, behind a `Transport` interface.
- Add WebTransport datagrams when a server stack is trustworthy (a Rust `wtransport` or Go `webtransport-go` edge in front of the TS sim, or a stabilised `node:quic`).
- Rollback tolerates TCP stalls better than state-sync does.
- Skip WebRTC/geckos unless measurements show WebSocket HOL bursts hurting.

**5. Server hosting:**
- **Phase 1:** 2–3 regional VMs (EU/US-East/US-West or APAC; Fly.io needs a dedicated IPv4 only if you go UDP). Many rooms per Bun process. Latency-based region selection at matchmaking.
- **Phase 2 (ranked):** keep the same container and add Edgegap per-match deployment ($0.00115/vCPU-min) to place matches at the players' latency centroid. Alternatively, Cloudflare Durable Objects as a global input relay, with the authoritative sim on regional VMs.
- **Avoid:** Hathora (shut down), Rivet (pivoted), Nakama TS runtime as sim host (ES5 goja), PlayroomKit for ranked (host-player).

**6. Audio:** thin custom Web Audio layer (stereo pan + distance gain, pooled voices). Howler is optional and in maintenance mode.

**7. Tooling:** pnpm workspaces (+ Turborepo if CI time matters), Vite 8, Vitest 5 (unit + browser mode for determinism hashes), Playwright 1.64 (e2e, WebGL-forced render smoke tests), Bun 1.4 server, glTF-Transform + meshopt + KTX2 asset pipeline from Blender's built-in glTF exporter.

**8. Product lessons to carry over:**
- Bots and fast matchmaking into live rooms, because 10-player lobbies are hard to fill (Spellsworn and Battlerite CCU are in the tens).
- Short rounds.
- Graphics tiers.
- Near-zero per-match server cost.
- Keep the server free of native deps that pin runtime versions (`uws` pinned Acolyte Fight to Node 8).

---

## 8. Open questions / lower-confidence items
- I found no Acolyte Fight shutdown post-mortem. "Moved to Easel" is inferred from the live redirect, not from an announcement.
- Hathora's shutdown date is May 5 per a vendor blog and "end of April" per Insider Gaming.
- WebTransport `:protocol` token interop (legacy vs draft-15) comes from a single third-party blog.
- Bun has no WebTransport/HTTP3 support that I could find. Re-check before deciding on a transport.
- caniuse marks Safari macOS WebGPU as "partial" for 26.x without explanation.
- Dota 2's 30 Hz tick and WC3's lockstep characterisation come from third-party or forum sources.
- TypeScript 7 ecosystem compatibility not verified.

## Sources (main)
- Acolyte Fight source mirror: https://github.com/justchen1369/acolyte-fight
- Acolyte Fight Show HN (2018): https://news.ycombinator.com/item?id=17983325
- Acolyte Fight itch.io: https://raysplaceinspace.itch.io/acolytefight
- Easel rollback docs: https://easel.games/docs/learn/multiplayer/rollback-netcode
- Easel physics post (2026-05-01): https://easel.games/blog/2026-rollback-physics
- Warlock WC3 thread: https://www.hiveworkshop.com/threads/warlock-warlockbrawl.92290/
- Warlock Brawl site: https://warlockbrawl.com/
- Warlock Brawl Dota 2 Workshop: https://steamcommunity.com/sharedfiles/filedetails/?id=296662770
- Kotaku on Ruin: https://kotaku.com/another-game-based-on-an-old-warcraft-iii-mod-1792022301
- Spellsworn: https://store.steampowered.com/app/360620/Spellsworn/
- Battlerite dev blog 008: https://blog.stunlock.com/dev-blog-008/
- Spellbreak shutdown: https://www.shacknews.com/article/131137/spellbreak-server-shutdown-2023
- Magicka: Wizard Wars closure: https://pcgamer.com/magicka-wizard-wars-is-closing-in-july
- Mages (PlayCanvas): https://forum.playcanvas.com/t/mages-multiplayer-arena-game-loosely-based-on-warlock-from-warcraft-3/9397
- gpuweb implementation status: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- MDN browser-compat-data: https://github.com/mdn/browser-compat-data (api/GPU.json, api/WebTransport.json)
- caniuse WebGPU: https://caniuse.com/webgpu
- caniuse WebTransport: https://caniuse.com/webtransport
- web.dev WebGPU support post: https://web.dev/blog/webgpu-supported-major-browsers
- WebKit Safari 26.4 features: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- MDN WebTransport constructor: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport
- three.js WebGPURenderer manual: https://github.com/mrdoob/three.js/blob/dev/manual/pages/webgpurenderer.html
- three.js r186 release: https://github.com/mrdoob/three.js/releases/tag/r186
- Babylon.js 8.0 announcement: https://blogs.windows.com/windowsdeveloper/2025/03/27/announcing-babylon-js-8-0/
- PlayCanvas engine: https://github.com/playcanvas/engine
- fails-components WebTransport: https://github.com/fails-components/webtransport
- Colyseus WebTransport transport: https://docs.colyseus.io/server/transport/webtransport
- Colyseus netcode: https://docs.colyseus.io/netcode
- Colyseus pricing: https://colyseus.io/pricing/
- Nakama TypeScript runtime: https://heroiclabs.com/docs/nakama/server-framework/typescript-runtime/
- Edgegap pricing: https://edgegap.com/pricing
- Rivet Cloud: https://rivet.dev/cloud/
- Cloudflare Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare Realtime SFU pricing: https://developers.cloudflare.com/realtime/sfu/pricing
- Fly.io UDP/TCP: https://docs.fly.io/networking/udp-and-tcp
- Bun WebSockets: https://bun.com/docs/runtime/http/websockets
- geckos.io: https://github.com/geckosio/geckos.io
- Hathora / Stormgate (Insider Gaming): https://insider-gaming.com/stormgate-going-offline-provider-hit-ai-pivot/
- Gameye vendor blog: https://gameye.com/blog/game-server-shake-up-2026
- Gaffer on Games: https://gafferongames.com/post/deterministic_lockstep/ , https://gafferongames.com/post/snapshot_interpolation/ , https://gafferongames.com/post/state_synchronization/
- Gambetta: https://www.gabrielgambetta.com/client-server-game-architecture.html
- GGPO: https://github.com/pond3r/ggpo
- Photon Quantum frames manual: https://doc.photonengine.com/quantum/v3/manual/frames
- ECMA-262 Math functions: https://tc39.es/ecma262/#sec-function-properties-of-the-math-object
- bounce issue #8: https://codeberg.org/perplexdotgg/bounce/issues/8
- WebAssembly nondeterminism: https://www.webassembly.org/docs/nondeterminism/
- Wasmtime deterministic execution: https://docs.wasmtime.dev/examples-deterministic-wasm-execution.html
- Rapier JS determinism: https://rapier.rs/docs/user_guides/javascript/determinism
- Box2D determinism post: https://box2d.org/posts/2024/08/determinism/
- MDN Web Audio spatialization: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Web_audio_spatialization_basics
- Howler.js: https://github.com/goldfire/howler.js
- Chrome headless GPU testing: https://developer.chrome.com/blog/supercharge-web-ai-testing
