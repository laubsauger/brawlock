# 01 · Ground truth

Phase 1 of the moonshot series. Every bet in [00-moonshot.md](00-moonshot.md) held against the code
and the evidence as they stand on 2026-10-28 (`main` at `e075b1d` plus the uncommitted King of the
Hill seal work). Sources: [research/codebase-map.md](research/codebase-map.md) (file and line
references live there), [research/backlog-and-pain.md](research/backlog-and-pain.md), and a
rollout benchmark run for this phase.

Cost labels follow the codebase map: for one developer who knows the code, **S** up to 3 days,
**M** 1 to 2 weeks, **L** 3 to 6 weeks, **XL** more. They include tests, not playtest iteration.
Verdicts: **green** can start now, **yellow** needs a named prerequisite first, **red** is blocked
by something code cannot fix (data, population, a decision, an outside party).

---

## 1. Six facts that reshape the moonshot

**1. The players are not there yet.** The only population snapshot (2026-10-19/20) shows a peak of
7 people online, menus included. Casual rooms ran about nine bots per human; ranked had two unique
players, so its Elo was a private duel. The moonshot was written as if the audience were the
constraint to grow. It is the constraint to *find*. Anything that only pays off with a crowd
(Brawlock TV, Cups, Covens, learned bots, a Workshop) comes after anything that brings or keeps
the first hundreds.

**2. The game is slow to start and slow inside.** From a click on Quick play to the first fight
takes 35 to 85 seconds: a lobby countdown (30 s alone, 60 s once a second human joins, 10 s if
everyone is Ready; `src/net/server.ts` queue presets) and then a 25 s shop. A first visit adds
the How to play intercept. Inside the match, completed casual first-to-3 games averaged about
28 minutes over 8.5 rounds. Hard bots make their first kill after about 107 s, and 83% of deaths
come after the arena has sunk about 11 layers. Rounds are long, and their first half is quiet.
"Ten seconds from a link" and Blitz are bigger fixes than they looked in phase 0.

**3. The arena is one integer.** `ArenaState.layer` derives every tile. Frozen lava, a floor that
cracks, the Maw's tides, the Isles, ice, the Pit, every non-ring arena and per-tile friction all
need a tile model first: an L refactor across 40 to 50 call sites in sim, bots, render, audio and
game code. Render is already per tile internally (its grid stops at radius 2000). This one
refactor gates half of Bet 1 and part of Bet 2.

**4. Replays are locked to the exact build.** `scripts/net-id.mjs` hashes every file in
`src/sim` and `src/net`; any edit, even a comment, orphans every stored replay. Dedicated servers
do not record replays at all. Durable clip links, an archive, ghosts fit from history and
server-verified leaderboards across releases all need either loadable old sims or build-free
clip data.

**5. An online match cannot slow down.** The sim keeps stepping on the server. Hit-stop exists
but is capped at 4 frames; slow motion exists only in the dev showcase director. A Final Blow is
therefore an instant replay played from a ring buffer of recent states during the round-end
slack (3 s), not a live freeze. The match-winning blow has no slack at all: results open 600 ms
after `gameOver`. And since about 85% of deaths are lava burns after the push, the moment to
replay is the hit seconds earlier, which takes a forecast (`bots/predict.ts` has one).

**6. Spectators get full snapshots.** A watcher costs about as much downlink as a player in
snapshot mode (150 to 300 KB/s at 60 Hz). A few per room are fine. A crowd, Brawlock TV or a
Discord stage audience needs the input stream for spectators or a relay that fans one stream out.

---

## 2. Bet by bet

### Bet 1 · A living arena and spells that talk to each other

| Idea | What exists | Missing | Cost | Verdict |
|---|---|---|---|---|
| Tile model | Layer rule in `sim/arena.ts`; render diffs cell sets into sink/rise animations | A tile grid in `ArenaState`, one safety function, shrink as cell removal, bots keyed by tile set, render grid past radius 2000 | L | green: the keystone refactor |
| Spell chemistry framework | Projectile behaviors with capability flags; combos as named checks (Lightning detonating Fireball); Gravity already bends every projectile | Material tags, an interaction registry consulted at contact (`physics.ts` notify) and in field `onTick`, one place per pairing | M, then S per reaction plus VFX | green for spell-spell; yellow (tile model) for spell-floor |
| Frost freezes lava | Rockpillar adds temporary obstacles; the hill seal is a post-physics pass | Per-tile overrides with timers | S after the tile model | yellow |
| Floor that cracks | Damage and kb events carry position and impulse | Tile health, crack visuals (one more instanced attribute and shader branch) | M after the tile model | yellow |
| The Maw, Isles, Glacier, Crucible, Ember Clock, Sky Temple | Arena themes 0..2 (visual); global friction setting | Per-arena rule modules, art per arena; Crucible needs moving cells; Sky Temple a different death rule | M to L each | yellow |
| The Hollow (fog of war) | The game has no fog; bots read the full state | Visibility rules in render and in bot perception (bots must stop seeing through the storm) | L | yellow, design-heavy |
| Arena events | Pillars, explosions, the shrink scheduler | An event scheduler (fits a mode/mutator module) | S to M each | green for pillar-type events |

Guard rails from the ground: the arena lighting is approved as it is (no relighting as a side
effect); level-1 visuals stay tame, so chemistry effects scale with spell level too; every
reaction must be readable at the gameplay camera.

### Bet 2 · Nobody waits

| Idea | What exists | Missing | Cost | Verdict |
|---|---|---|---|---|
| Ten seconds from a link | `?room=` links, join-in-progress into bot seats, guided practice, guest play | Start bot-filled quick play at once and let humans take bot seats as they arrive; a short first shop; How to play as the first fight rather than a wall | S to M (mostly flow and policy) | green, highest ratio of value to cost in this file |
| Blitz format | `winScore`, `shopSeconds`; shrink period is a constant (10 s, ranked 8 s) | A shrink-period setting or mutator, a queue preset | S | green |
| The Haunting | Dead players already send `spectateBet` commands through the input stream | New `InputCommand` kinds and their rules | S to M | green |
| The Pit | Nothing: one arena, one fight | A second fight area inside the outer wall (tile model), zone-separated collision, a second camera target, Pit rules and prizes | L after the tile model | yellow |
| The crowd | Spectator presence is known to the room; victory camera and dressing exist | Crowd figures (art, instancing, reaction animation), a watcher count in the protocol, bet banners | M | green |
| The Sanctum hub | Menu backdrop runs a live bot match; practice loop | A social room type with 20 to 50 walking players, presence, a duel pit; server capacity for it | XL | red until there is a crowd to fill it |

The ground truth flips the order inside this bet. The Sanctum was the showpiece of phase 0; at a
peak of seven people it would be an empty hall. "Ten seconds from a link" and Blitz fix the
measured problem for everyone today.

### Bet 3 · Every match tells a story

| Idea | What exists | Missing | Cost | Verdict |
|---|---|---|---|---|
| Final Blow (instant replay) | Showcase director (virtual clock, sub-tick frame writes, cinematic camera); particles follow the world clock so a clock scale slows every effect; death-by-cause kit | A client ring buffer of states, a swapped `RenderSource` for the replay, the director's camera in shipping code, a longer game-over hold, a lethal-hit forecast | M | green |
| Showdown (last two) | Phase, alive count, hurt flash, vignette uniforms | Director-driven post uniforms (desaturate, vignette push), camera tighten, audio duck | S to M | green, but check against the approved lighting |
| Play of the Round | Replays re-simulate a 10-minute match in well under a second; the shop is 25 s of downtime | A moments engine to pick the play; playback in a shop-corner viewport from the client's own recording | M | green (local recording only) |
| The Director | `playEvents` sees every tick's events and state; a music intensity input already exists | A tension signal (the oracle of Bet 5), a policy that maps tension to music, light, camera, announcer | M after the oracle | yellow |
| Adaptive score | Music bus with its own reverb, a decoded sample path | The music. Decoded stems cost about 69 MB per 3-minute stereo stem, so 30 to 60 s loops. Selection is the user's call (NEXT-SPRINT item 1) | M engine | red until music exists |
| Barks and emote wheel | Announcer pipeline, victory poses in the wardrobe | Voice content; an emote channel outside the sim (a sim command would change the netcode id for a cosmetic) | S to M plus content | green |
| Spell skins | VFX plugin per spell, identity palette, power tiers | Variant registry; each skin must keep the silhouette and the hitbox core | M per skin | yellow: economy decision |
| A world and seasons | Arena themes, Circle of Ash (menu music title) | Writing, art, a season system | L to XL, mostly content | yellow |

### Bet 4 · Wherever your friends are

| Idea | What exists | Missing | Cost | Verdict |
|---|---|---|---|---|
| Discord Activity | The itch build runs framed as a guest with bundled media; Discord is a provider in the auth config (not provisioned) | Token sessions instead of cookies (security-sensitive), Discord proxy mappings for every origin, dedicated rooms only (P2P is unproven behind the proxy), Activity instance to room mapping | L | yellow: needs a Discord app registration and a security review |
| Clip links | Replays are seed plus inputs | Durable clips (build lock), server storage, unfurl video (server render or a client WebCodecs upload) | L | yellow: needs a sim-version answer |
| Brawlock TV | Spectating, betting, the menu backdrop's live bot match | Spectator stream or relay, a picker (oracle plus moments) | M to L | red until there are live matches worth watching |
| Steam, portals | itch packaging script | A desktop wrapper and Steamworks; portal SDKs | M to L each | yellow: business decisions |
| Edge rooms | Pure-TS sim and session; a `Transport` interface | A runtime port (Workers lack Node sockets), placement, a link to the central account authority through the existing receipts and outbox | XL | red until two regions are full |
| UDP to servers | WebRTC already used for P2P | node-datachannel or WebTransport on the server | M to L | yellow |
| Covens | Accounts, profiles | Everything social | L | red until there is a crowd |

### Bet 5 · Opponents with souls

| Idea | What exists | Missing | Cost | Verdict |
|---|---|---|---|---|
| Motor model (stop the dance) | Ten likely sources pinned to lines in `bots/controller.ts`: a new order every 0.1 s with no action-rate cap, wander re-picked every think once within 100 units (with "stay here" as a candidate), no exit margin between dodging and wandering, Brutal/Uber duel points re-drawn at random angles every 0.3 to 0.6 s, hill picks flipping between go and wait | Goal commitment time, dodge hysteresis, an action-rate knob per preset (PLAN §7 promises one), skip near-identical re-targets, a movement-plausibility metric next to the Elo ladder | S to M plus a ladder rerun | green, and visible to every visitor: the menu backdrop runs Brutal and Uber bots |
| Oracle | 20 ms to play out the rest of a duel fight with Hard bots, 200 ms with eight (benchmark for this phase); the betting panel has a rough Elo-times-health estimate | A fast model fit on seeded bot fights, graded by Brier score against the betting estimate; runtime features | M | green |
| Nemesis | Local encounters (per-opponent kills) in `game/stats.ts`; server profiles with partial combat | Server-side head-to-head, surfacing in lobby, kill feed and crowd | S to M | green |
| Ghosts | `BotParams` is a numeric vector; bots and humans share `InputCommand`; replays are recorded locally | Server-side data (dedicated rooms do not record); a fit pipeline; validation that a ghost fit to a known tier lands near its Elo. Storing style *features* per match (computed live, not from replays) avoids the build lock | M to L | yellow: features first |
| Learned bots | Deterministic sim fast enough for self-play | Human data. At a peak of seven people online there is not enough to clone for months | XL | red (data) |
| Flow sparring | Presets as anchors, Elo per tier | Interpolated knobs, a per-round adjustment policy, a fairness rule for mixed lobbies | M | green for solo; yellow for queues |

### Bet 6 · Players build the next mode

| Idea | What exists | Missing | Cost | Verdict |
|---|---|---|---|---|
| Mutators | Global knobs act as mutators already (kb and damage multipliers, friction, lava DPS, gold, shop time); settings accept scalar keys only | A mutator list in settings (booleans or short strings), effects in `step` | S framework, S each | green |
| Mode framework | Modes are `if` branches in `mode.ts`; King of the Hill touched 15 and 16 files including five hardcoded mode lists | A `ModeRules` interface (round start, kill, round won, phase tick, win check) and one list of modes | M | green, pays back from the third new mode |
| Arena editor | Nothing | The tile model, an editor UI, a package format | L after the tile model | yellow |
| Spells as data | Spell hooks and data tables | A closed primitive set compiled into hooks, metering, a VFX story for spells nobody hand-made | XL | red for year one |
| Workshop | Accounts and an authority with storage | Package hosting, hashes in room settings, moderation | L | red until there are makers |

### Bet-independent: learning surfaces

| Idea | What exists | Missing | Cost | Verdict |
|---|---|---|---|---|
| Play from here | Practice builds a match and runs its own loop from an edited state; replays restore any tick | Viewer UI to pick a seat, fresh bots for the rest (bots are stateful, so a continuation is fresh, not faithful) | S to M | green |
| Coach | Detailed per-player stats, awards, death recap text, teleport-save detection | Findings with evidence and a link into the replay | M | green |
| Training lab, trials | Practice scenario checker | Rewind (a state ring), overlays, trial scripts | S to M each | green |
| Daily Gauntlet | Seeded deterministic matches | Server re-simulation of submitted inputs (same build on the day), a leaderboard | M | green |

---

## 3. What depends on what

```
tile model (L) ──► frozen lava, cracking floor, arenas, the Pit, arena editor
mode framework (M) ──► Blitz queue, Titan, Infection, Draft, the Pit's rules, Ascension
state ring buffer + director in shipping code (M) ──► Final Blow, Play of the Round, kill cam, rewind
moments engine (M) ──► Play of the Round, coach, highlight reels, Brawlock TV picks
oracle (M) ──► Director, Showdown timing, betting odds, swing, TV picks
sim versioning (M to L) ──► durable clip links, replay archive, ghosts from history
server-side recording (M) ──► ghosts, archive, learned bots
spectator stream or relay (M) ──► the crowd at scale, Brawlock TV, Discord stage audiences
token sessions + proxy map (L) ──► Discord Activity
```

Four prerequisites carry most of the moonshot: the **tile model**, the **mode framework**, the
**state ring and director** and **sim versioning**. Each is invisible to players on its own,
which is exactly why they get skipped. Each is also small next to what it unlocks.

## 4. Cheap wins hiding in the moonshot

Things the ground truth says cost S to M and fix something measured today:

1. **Fight in ten seconds.** Start bot-filled quick play at once; humans take bot seats as they
   arrive; first shop short.
2. **Bots that do not dance.** Commitment, hysteresis, an action-rate cap; the menu backdrop shows
   the result to every visitor.
3. **Blitz.** A shrink-period mutator and a queue preset.
4. **The Haunting.** Give the dead something to do through the command path betting already uses.
5. **Play from here.** The practice loop plus a replay state.
6. **Final Blow as an instant replay.** The showcase director's pieces, promoted.

## 5. What the ground truth removes or demotes

- **Learned bots** move to year two: there is no human data to learn from.
- **The Sanctum** waits for a crowd; an empty hall is worse than a menu.
- **Edge rooms** wait until two regions are full.
- **Spells as data** leave year one; mutators and arenas carry the Forge.
- **GPU fracture, fluid lava and compute cloth** rest on compute passes the renderer does not
  have (particles are vertex-shader evaluated, and the WebGL2 fallback has no compute); they are
  a presentation research track, not a Q1 feature.

## 6. Documentation drift found on the way

Not part of the moonshot, recorded so it gets fixed: PLAN §4.3 promises a sort-and-sweep
broadphase (the code checks every pair with an x-interval reject); PLAN §5.4 promises compute
particles (there is no compute pass); PLAN §7 lists an action-rate cap (`presets.ts` has none);
PLAN §3.4 says Shuffle is the default team mode (the default is FFA);
`KEYFRAME_EVERY = 600` in `game/replay/player.ts` is a tick literal commented as 10 s (20 s at
30 Hz); NEXT-SPRINT item 3 still says 30 Hz waits for a playtest decision, but it is the default.

[02-red-team.md](02-red-team.md) gives all of this to someone whose job is to say why it fails.
