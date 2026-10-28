# 00 · The raw moonshot

Phase 0 of the moonshot series in this folder. Written 2026-10-28 from the prompt: *"What would
be an absolute moonshot to improve Brawlock? Assume unlimited dev resources and 12 months. Be
ambitious. Let it rip."* No feasibility filter here: that is [01-ground-truth.md](01-ground-truth.md).
No mercy for ideas here either: that is [02-red-team.md](02-red-team.md).

The series:

| File | Phase |
|---|---|
| `00-moonshot.md` | The raw moonshot (this file) |
| `01-ground-truth.md` | Every pillar mapped against the real codebase |
| `02-red-team.md` | Pre-mortem with an independent critic |
| `03-moonshot-v2.md` | Re-ambition after the critique |
| `04-keystones.md` | Deep designs for three keystone bets |
| `05-roadmap.md` | Twelve months, kill criteria, the first 30 days |
| `research/` | Inputs: codebase map, backlog and pain synthesis, external frontier, two harness experiments |

---

## The north star

**Brawlock becomes the definitive Warlock and the best party brawler on the web.** The arena is
alive. Every spell talks to every other spell. Nobody ever waits. Every match tells a story worth
sending to a friend. And a match is ten seconds away from wherever your friends already are.

Today Brawlock is a faithful, polished remake with real servers, ranked, cosmetics and strong
bots. That was the hard part, and it took thirteen days. The moonshot is everything that turns a
faithful remake into the game people remember the original as.

## A Friday evening in month 12

Ana is in a Discord voice call with four friends. Someone types `/brawlock` and the game opens
inside the call. Nobody installs anything or makes an account; their Discord names are their
warlock names. They land in the **Sanctum**, a torch-lit hall over the lava where their warlocks
stand around in their capes, someone is juggling Fireballs at a training dummy, and two people
from the queue before them are settling a grudge in the dueling pit.

They queue together. Tonight's featured arena is **The Maw**: the lava breathes. Every twenty
seconds it surges up over the outer ring and drains back down, and between surges the outer
tiles are slick with cooling obsidian. Ana is knocked out first, by Rook, again. The game has
noticed: a small banner says *Nemesis: Rook (7–2)*.

She does not wait. She drops into **the Pit**, a little ring of rock beside the arena where the
fallen duel each other while the round plays out. She wins, and the Pit's prize is a curse: next
round, Rook's first Fireball fizzles. The crowd in the stands, made of the fallen players and the
two dozen people watching on Brawlock TV, cheers when she wins.

Round four is a showdown: Ana and Rook, last two alive, tiles sinking. The arena knows. The lights
dim to the lava's glow and the two warlocks' runes. The music drops to a heartbeat and a low
choir. Rook throws a Snowball across the lava, and where it rolls the lava freezes into a bridge
for three seconds. He crosses. Ana sees the bridge, Lightnings the Snowball as it reaches her, and
the shattered ice blows Rook back onto his own melting bridge. It cracks. He falls.

The game freezes for a third of a second, the camera pulls into Rook's face as he goes into the
lava, and the arena erupts. **GAME.**

During the shop the corner of the screen plays the **Play of the Round** from the killer's view.
Ana clicks *Share*, and the clip is in the Discord chat before the next round starts, playing
inline. Two people who have never heard of Warlock click it and are in the Sanctum before the
round ends.

After the match the **Coach** shows her three things. The first: "Rook baited your Teleport seven
times by walking toward the edge. Here's the moment." She clicks it, the replay opens at that
second, she presses **Play from here**, takes over her warlock, and does it right against Rook's
ghost.

That evening is the moonshot. Everything below is how.

---

## The six bets

### Bet 1 · A living arena and spells that talk to each other

The original's arena did one thing: it shrank in rings. Brawlock's arenas become characters, and
its 24 spells become a chemistry set.

**Spell chemistry.** Every spell carries a material (fire, frost, storm, void, stone, life) and
every surface has one (stone, lava, obsidian, ash). Reactions are rules, not scripts, so they
compose:

- Frost over lava freezes it into **obsidian**: walkable for a few seconds, then it cracks.
  Snowball becomes a bridge builder; a Snowball rolled at your feet is a rescue.
- Fire on obsidian melts it back. A Fireball under a frozen bridge drops whoever stands on it.
- Storm through frost **shatters** it: Lightning into a Snowball scatters ice shards.
- Fire through void **compresses**: a Fireball pulled into a Gravity orb detonates as a nova.
- Stone into lava throws a **lava wave**: a Meteor landing in lava pushes everything near the
  edge outward.
- Storm through a Shield **forks**: a reflected Lightning splits into two beams.
- Void through a tether **slingshots**: Link plus Gravity flings the linked warlock past you.

Thirty reactions from two tables, discovered by players, named by the community, clipped and
shared. A "chemistry" panel in the spell library fills in as you discover reactions.

**Arenas with personality.** Each arena changes one rule of the world, so each is a different
puzzle:

- **The Caldera.** The classic: concentric rings, the original's numbers. Always available,
  always ranked.
- **The Maw.** The lava breathes: surges over the outer ring on a visible rhythm and drains
  back, leaving cooling obsidian.
- **The Shattered Isles.** Five islands that drift apart and together. Teleport and Swap are
  bridges; a Thrust across a gap is a gamble.
- **Glacier Forge.** An ice floor with almost no friction, steam vents that launch you, and lava
  under the ice where it has melted through.
- **The Crucible.** The rings rotate in opposite directions like a combination lock; standing
  still carries you.
- **Ember Clock.** The arena does not shrink in rings: it burns away behind a sweeping clock
  hand. Fights rotate around the dial.
- **Sky Temple.** No lava at all: the floor ends at an abyss and the wind gusts in telegraphed
  directions.
- **The Hollow.** An ash storm: you see only what your own runes and the lava light. Fog of war
  arrives in Warlock.

**A floor that remembers.** Heavy impacts crack tiles. A cracked tile hit again crumbles. Players
carve the map through the round, and the shrink eats what is left. Scorch marks, craters and
frozen trails stay where they happened until the tile sinks.

**Arena events.** Telegraphed eruptions throw rocks that become temporary pillars. Lava geysers
throw a warlock into a high arc that lands somewhere else. A blood moon doubles knockback points
for one round. Events are scheduled by the Director (Bet 3) to break stalemates, never to decide
them.

### Bet 2 · Nobody waits

The worst moment in every elimination game is the first death. In a ten-player FFA the first
knockout watches for two minutes. In Brawlock the fallen keep playing.

- **The Pit.** The fallen drop into a small ring of rock beside the arena and duel each other
  while the round plays out. The last one standing in the Pit wins a prize for next round: a
  curse on their killer, a bounty, a free spell level, a gold purse. Downtime becomes the most
  intense minute of the round.
- **The Haunting.** In arenas without a Pit the fallen become lava spirits: they vote on which
  tiles crumble next, throw small embers that nudge (never kill), or lift a pillar out of the
  lava for a second. Influence, not control.
- **The crowd.** Spectators, the fallen and Brawlock TV viewers appear as hooded figures in the
  stands around the caldera. They cheer knockouts, gasp at close calls, chant a name on a
  streak, wave banners for their bets. The arena becomes a stage, and an empty seat is filled
  by people who are actually watching.
- **The Sanctum.** A social hub instead of a menu: a hall over the lava where queued players
  stand around in their cosmetics, juggle spells at dummies and duel in a pit while the queue
  fills. A quiet night feels inhabited, because whoever is online is visibly there.
- **Ten seconds from a link.** The first fight starts ten seconds after a click on a link: no
  account, no setup, no tutorial wall. The tutorial is the first fight, against bots that
  teach.
- **Short formats.** Blitz: first to three with a 10 s shop and a fast shrink, a whole match in
  four minutes. Quick fights for a lunch break.

### Bet 3 · Every match tells a story

Smash Bros freezes the frame on the final hit and yells "GAME!". Overwatch shows the Play of the
Game. Left 4 Dead has a Director that reads the players' stress and paces the horde. Brawlock
gets all three, plus a crowd.

- **The Director.** A system that reads the match: who is alive, who is close to winning, how
  much the next hit could change (the win-probability oracle of Bet 5), how long since the last
  knockout. It drives presentation from that tension: the music's stems, the lighting, the
  camera's distance and angle, the announcer's intensity, the crowd's noise, when an arena
  event fires. Calm early rounds breathe; match point feels like match point.
- **The Showdown.** When two warlocks are left, the arena dims to the lava and their runes, the
  music drops to a heartbeat, the camera lowers and tightens, the crowd goes quiet.
- **The Final Blow.** The hit that decides the match freezes for a third of a second, the camera
  punches in on the victim, the flight into the lava plays in slow motion, the lava erupts,
  "GAME". Rounds get a smaller version.
- **Play of the Round.** The shop phase is 25 seconds of downtime. Its corner plays the round's
  best moment, chosen by the moments engine, from the best camera. One click shares it.
- **Deaths that land.** Each death by cause already has its own effect. Add the camera, the
  crowd and the sound around it, scaled by how much it mattered.
- **A score that breathes.** Adaptive music, recorded as stems (percussion, bass, choir, lead)
  and layered by the Director. It also closes the open combat-soundtrack item with a system
  instead of a single track.
- **Characters with voices.** Warlock barks (taunts, pain, triumph), an emote wheel, victory
  poses (already in the wardrobe), defeat poses. Your warlock has a personality.
- **Spell skins.** Cosmetic variants of a spell's VFX that keep its silhouette and its identity
  color readable: the cosmetic people want most in this genre, and still not pay-to-win.
- **A world.** The arenas are places in one world with a history: the Circle of Ash, the orders
  of warlocks, the reason there is lava. Seasons tell a chapter of it, and each brings an arena,
  a chemistry reaction and a cosmetic set.

### Bet 4 · Wherever your friends are

- **Discord Activity.** Brawlock inside a voice channel; everyone in the call in one room; names
  and avatars from Discord. Warlock was always a game you played with the same five friends.
- **Clip links that play inline.** A clip is a state plus a few seconds of inputs, kilobytes;
  the link unfurls into a playing video in Discord and on X, and opens straight into the
  cinematic player.
- **Brawlock TV.** An always-on channel of the best live matches, in the client and on Twitch,
  picked by the Director's tension, with spectator bets.
- **Steam and web portals** with the same servers and the same pool.
- **Rooms near everyone.** The authoritative room runs at the edge closest to its players, over
  UDP-like transport. Two regions become twenty; 40 ms everywhere.
- **Covens.** Clans with a hall in the Sanctum, coven colors on the crowd's banners, coven wars
  on weekends.

### Bet 5 · Opponents with souls

The bots are already strong. The moonshot makes them feel like people, and makes people
persistent.

- **A motor model.** Today the bots sometimes dance on the spot in a way no hand on a mouse
  could. Humans click a few times a second, commit to a direction, overshoot and correct. Bots
  get the same limits: a click cadence, a commitment time for a direction, smooth curvature, a
  little overshoot. Strength comes from decisions, not from twitching.
- **Ghosts.** Your play style, fit from your replays into a bot: reaction time, aim, cast rate,
  edge margin, dodge habits, favourite builds and openers. Play your friend's ghost when they
  are offline. Beat your own ghost from last month. Killer Instinct called these Shadows.
- **Learned style.** Bots trained on human matches, then on self-play against the scripted
  ladder, distilled to a model that decides in microseconds. The scripted tiers stay as the
  calibrated ladder; learned bots add personalities.
- **The Nemesis.** The game remembers who knocks you out and who you knock out. Your nemesis is
  announced when you share a lobby, the crowd knows, revenge pays a little extra, and beating a
  nemesis streak is an event.
- **The oracle.** Every tick, every warlock's chance to take the round, fit from thousands of
  simulated fights. It feeds the Director, the bets, Brawlock TV and the coach.
- **The flow sparring partner.** A bot that adjusts between rounds to keep you winning about
  half of them.

### Bet 6 · Players build the next mode

Warlock was born in the Warcraft III World Editor. Give the editor back.

- **Forge.** An in-browser editor for arenas (shapes, surfaces, hazards, events, shrink
  patterns), mutators (rule changes as data) and, later, spells as data: a closed set of
  primitives and the sim's own hooks, so content from strangers stays deterministic and safe.
- **The Workshop.** Share by link, rate, fork. A featured mode each week. The best graduate into
  the official rotation with their maker's name on the arena.

---

## The idea bank

Everything else, unfiltered, by angle. The red team gets to shoot at all of it.

### Gameplay and design

- **Evolutions.** At level 7 a spell evolves into one of two forms, chosen like a Hades boon:
  Fireball becomes Comet (faster, narrower, pierces one) or Inferno (leaves burning ground).
  A separate mode, so classic levels stay classic.
- **Draft.** Pick and ban spells from the shop columns before the match. A competitive format
  that leaves classic untouched.
- **Duos.** 2v2 as a first-class format, with team combos made visible: two teammates' spells
  meeting in the air fuse.
- **Titan.** One warlock is giant and slow with a boss kit; everyone else is a normal warlock.
  The Titan's knockback points are shared damage from the whole lobby.
- **Infection.** The knocked-out return as lava imps on the hunters' side until one warlock
  remains.
- **Lava Royale.** Forty warlocks on an archipelago that sinks by zones.
- **Raids.** Three to five warlocks against a titan that casts the same spells at giant scale.
- **Ascension.** A solo roguelite: waves of bots, relics and spell evolutions between waves, a
  boss every fifth wave, a run in twenty minutes.
- **The Circle of Ash.** A campaign of handcrafted encounters: each boss a legendary warlock
  with a signature spell and an arena gimmick, each one teaching a mechanic.
- **Blitz.** First to three, 10 s shop, double-speed shrink.
- **Daily Gauntlet.** The same seeded challenge for everyone, scored by the sim and re-simulated
  by the server before it enters the leaderboard.
- **Trials.** Fighting-game style challenges: detonate a Fireball with Lightning on a moving
  target, Swap an enemy into a pillar's blast, Teleport out of a lethal slide.
- **Bounties on streaks.** A warlock on a streak glows, and the gold on their head grows.
- **Momentum moves.** A knocked-back warlock who casts during the flight gets a tiny "air
  control" nudge (a mutator; the classic has none).

### Presentation and feel

- **Hit-stop scaled by impulse**, frame-perfect, a few frames on the heaviest hits.
- **Impact frames.** One or two stylized frames on a killing blow (silhouettes on a flat color),
  the way fighting games and anime sell a hit.
- **The lava as a fluid.** It flows around pillars, splashes on deaths, swallows sinking tiles
  with a heave.
- **Fracture.** Tiles break into pieces on compute when they sink; craters where Meteors land.
- **Cloth that reacts.** Robes and capes simulated on the GPU, snapping in the wind of a
  knockback.
- **Weather and time.** Each round a slightly different sky: ash fall, a red moon, aurora over
  the Glacier Forge.
- **Cinematic victory.** The winner's pose with the crowd's roar and the arena rising behind
  them.
- **Photo mode.** Pause any replay, fly the camera, frame, export.
- **Readable at a glance.** Every new mechanic keeps the readability rules: identity colors,
  hitbox cores above effects, AoE visuals that end at the gameplay radius.

### Social and community

- **Parties and friends** with presence: see who is in the Sanctum and join their queue.
- **Global chat** in the Sanctum, filterable by region (already a backlog idea).
- **Covens** with halls, colors and weekend wars.
- **Rivalries** surfaced everywhere: lobby, scoreboard, kill feed, the crowd.
- **Creator tools.** Video export at 1080p60, a replay director cam, overlays for streamers.
- **Brawlock Cups.** Weekly automated tournaments with in-client brackets.
- **Observer mode** for casters: free camera, player cards, the oracle graph, heatmaps, delay.

### Learning

- **Play from here** from any replay tick against bots or ghosts.
- **Training lab** with rewind, slow time, hitbox and trajectory overlays, recordable dummies.
- **The coach** after every match: three findings, each a link into the replay.
- **Death recap with the chain**: which hits built the knockback, which one started the flight,
  what would have saved you.

### Platform and tech

- **Edge rooms** placed per match near the players.
- **UDP semantics** to servers (WebRTC data channels now, WebTransport later).
- **Adaptive input delay** blended with rollback per link.
- **Instant load**: the first fight before the heavy assets finish streaming.
- **Server-verified replays** for leaderboards and the Gauntlet.

### Bots and AI

- **Motor model** (no more dancing), ghosts, learned styles, flow sparring, the oracle, an AI
  caster track (code picks the moment, a language model only drafts the line bank offline),
  bots that teach in the first fight.

---

## Month-12 picture

- A new player is fighting ten seconds after a click, from Discord, a clip, a portal or Steam.
- Eight arenas, each with a rule of its own; chemistry with thirty reactions; the classic
  Caldera untouched and ranked.
- Nobody waits: the Pit, the Haunting, the crowd, the Sanctum.
- Every match has a Director, a Showdown, a Final Blow and a Play of the Round, and one in five
  produces a shared link.
- Bots that move like people; ghosts of friends; a nemesis.
- A Forge with a weekly featured community mode.
- Rooms within 40 ms of everyone in five continents.

[01-ground-truth.md](01-ground-truth.md) asks what each of these costs in the real code.
