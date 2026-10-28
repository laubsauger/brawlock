# 03 · Moonshot v2

Phase 3 of the moonshot series. The re-ambition after [02-red-team.md](02-red-team.md). The
critique was right about the order, the audience and the costs. It was not an argument for a
smaller dream. It points at a sharper one.

## 1. The sharper moonshot

Phase 0 imagined infrastructure for a crowd. The evidence says there is no crowd yet: at most
seven people in the only snapshot, nine bots for every human in casual, and a genre whose
commercial games died of retention and server cost, not of being bad.

So the moonshot is this:

> **Brawlock is the first arena game that is great at a population of one and gets better with
> every person who arrives.**

Every multiplayer game in this genre was built for a crowd and died when the crowd thinned:
queues split, matches stopped popping, servers cost more than they earned. Brawlock can be built
the other way round, because of the two facts phase 0 found:

- the simulation is pure, deterministic and cheap (a whole fight with bots plays out in
  20 to 200 ms), so a match can run anywhere, be replayed exactly and be continued from any
  moment;
- bots and humans speak the same `InputCommand` language, so a human can replace a bot, and a bot
  a human, at any seat, at any time.

**Population-elastic design** is the rule that follows. Every feature in v2 must pass five tests:

1. **It works with one human.** Bots fill every seat a person does not.
2. **It gets better with each human and never worse.** Humans replace bots; modes rotate inside
   one queue instead of splitting it; nothing waits for a quorum.
3. **It costs almost nothing when nobody is there.** A quiet year must never force a shutdown.
4. **It measures itself.** Each feature ships with the number that says whether it worked.
5. **It never pretends.** Bots and ghosts are always labelled; a crowd that is generated never
   poses as people.

Phase 0's showpieces fail these tests: the Sanctum is an empty hall at a population of seven,
Brawlock TV needs live matches worth watching, the Workshop needs makers. They are not dead. They
are what population-elastic design grows into once people arrive, and each has a trigger in
[05-roadmap.md](05-roadmap.md).

## 2. What changed from phase 0

| Phase 0 | v2 | Why |
|---|---|---|
| Six bets for a crowd | Eight bets that each work at a population of one | 02 story A: a cathedral with no congregation |
| No acquisition plan | Finding the first hundred players is a bet with an owner and a number | 02 blind spot 2 |
| No measurement | Measurement comes first, before any bet | 02 blind spot 1 |
| Living arena as the first bet | The Wild ruleset as a lab with a door: cheap tests first, the tile model only if players choose Wild | 02 Bet 1 |
| The Pit and the Sanctum to fix waiting | Pace: rounds under 90 s and a fight within seconds of a click | 02 double-down 1: round length is the root variable |
| Ghosts and learned bots | Bots that move like people and fit you, with labelled personas; ghosts opt-in and later | 02 Bet 5 |
| A live Final Blow freeze | An instant replay and a finish zoom; the sim never pauses | 01 fact 5, 02 contradiction 4 |
| Ascension in the idea bank | Co-op and solo against the lava as a main bet | Frontier §1-2: the strongest market evidence in the bank |
| Edge rooms, the Hollow, Lava Royale, GPU fluid, learned bots, spells as data | Cut from year one | 02 §5 |

## 3. The eight bets

Bets 1 to 3 are the keystones, designed in depth in [04-keystones.md](04-keystones.md).

### Bet 1 · Pace: Warlock at the speed of now (keystone)

The original community's one recorded complaint was that the arena shrinks too slowly with many
players. Today a casual first-to-3 takes about 28 minutes over 8.5 rounds, the first death comes
after about 107 s, and most deaths come only after the arena has sunk eleven layers. Every other
problem on the list (waiting while dead, abandonment, long lobbies, the join-in-progress wait,
King of the Hill's endless matches) grows out of slow rounds.

The ambition: **a fight within seconds of any click, a first knockout inside 45 s, rounds under
90 s, a casual match under 10 minutes**, with the original's feel intact.

- **The warm-up arena.** Clicking Quick play drops you into a live, stakes-free brawl against
  bots while the lobby counts down exactly as it does today (Ready and "Wait for players"
  unchanged). The match starts on schedule; your warm-up never counts. Clicking Play is the
  consent to play; nobody is moved anywhere they did not ask to go.
- **Arenas sized to the fight.** Casual starts smaller than `13 + players` and shrinks faster as
  fewer warlocks remain: the shrink accelerates with every knockout. The classic formula stays the
  default for custom games and stays the Caldera.
- **Bots with edge courage.** Hard keeps about 610 units from the edge; casual bots press closer,
  so pushes happen early. This also makes them more beatable, which is the point in casual.
- **A shop that ends when you are done.** All humans Ready ends the shop early; bots are always
  ready. The 25 s stays the maximum, not the minimum.
- **Join a fight, not a wait.** An arriving human already takes a bot's seat when the current
  fight ends (`src/net/session.ts:249`). With 90 s rounds that wait is short, and the warm-up
  arena fills it.

### Bet 2 · Every match leaves something to keep and share (keystone)

The cheapest new player is a friend who clicked a clip. Phase 0 had the right instinct and the
wrong mechanics: a live freeze the netcode cannot do, and clip links that break with every build.

- **Moments.** A pure pass over the event stream that finds and scores what mattered: the hit that
  sealed a knockout (most deaths are lava burns seconds after the push), multi-knockouts, denies,
  reflected kills, clutches, comebacks.
- **The Final Blow.** At round end, the deciding hit replays for two seconds from the killer's
  side, slowed, skippable, from a ring of recent states. The match-winning blow gets the full
  version, with the results waiting for it. The sim never pauses.
- **Finish zoom.** Smash's rule, ported: when the sim forecasts that a hit will knock out the last
  opponent (knockback toward lava, enough points), the camera punches in and the sound drops for a
  beat. A wrong forecast is still drama. Live play only zooms; slow motion belongs to the replay,
  because a player who survives the forecast must still see the present.
- **A reel on the results screen**: the match's three best moments.
- **Clips that last.** A clip is a build-free track (per-tick positions, facings and events for a
  few seconds), so it plays on any future build. Sharing encodes a short video in the browser
  (WebCodecs) and uploads it with the track, so a link unfurls as video where the platform allows
  and opens in the game everywhere.
- **Two ids instead of one.** Live compatibility (protocol, server) and replay compatibility
  (simulation only) get separate hashes, so a new hat or a queue tweak no longer orphans every
  replay.

### Bet 3 · Opponents that feel like people and fit you (keystone)

Bots are the opponents in nine seats out of ten and the first thing every visitor sees: the menu
backdrop is a live Brutal and Uber match. They are strong. They need to read as people and meet
each player where they are.

- **A motor model.** Goal commitment, dodge hysteresis, an action-rate cap per tier (PLAN §7
  promised one), no re-targeting toward near-identical goals. No more dancing on the spot.
- **A plausibility metric** next to the Elo ladder: orders, reversals and idle dithering per
  second, compared with humans. It is also the first detector for input automation, the one cheat
  this netcode leaves open.
- **Skill fit.** A hidden rating for every player, and quick play seats bots around it. The cliff
  from guided practice (Easy, about 350) to casual (Medium 1000, Hard 1825) disappears.
- **Personas.** Named, labelled bots with a style, a build habit and a memory of you: Cinder the
  Patient, who walls with Shield and punishes greed; Rook, who Teleports in for the Scourge.
  Rivalries with people need people; rivalries with personas work today.
- **Later: ghosts**, opt-in by their owner, built the way Killer Instinct built Shadows (recorded
  situations and actions, nearest-neighbour recall, patterns dropped when punished), once there
  are a few hundred players' worth of data.

### Bet 4 · Together against the lava

The wizard games that sold in 2025 were co-op or comedic; on Discord, collaborative play beat PvP
by half on new-player retention (frontier §1-2). Brawlock has every piece of a co-op mode already:
teams, bots, the shop, the shrinking arena.

- **Last Stand.** One to four warlocks against waves of bots on a shrinking arena, a shop between
  waves, a persona boss every fifth wave who casts their signature spell at full level. Bot allies
  fill empty seats, so it works alone and gets better with friends.
- **Ascension**, later: the same waves as a run, with relics and spell evolutions drafted between
  waves (the Hades structure), a run in about twenty minutes.

Scoped as a mode built from existing spells and bots, not a second game: the Overwatch 2 PvE
lesson.

### Bet 5 · The Wild ruleset: an innovation lab with a door

The living arena and spell chemistry stay the most creative ideas in the series. v2 gives them a
door and a test instead of a year.

- **Wild** is one ruleset, a lobby toggle and a rotating casual playlist, never in ranked and never
  the Caldera (competitive Smash turns hazards off; so will ranked Warlock players).
- **First contents**, all possible on the current integer arena:
  - *The Maw's tide*: the arena sinks a ring and rises back on a visible rhythm (the render
    already animates cells sinking and rising).
  - *Three reactions*: Lightning shatters a Snowball into shards; a Fireball pulled into a
    Gravity orb detonates as a nova; a Meteor that lands in the lava throws a wave that pushes
    warlocks near the edge outward.
  - *A mutator of the week* chosen by server configuration, not a client release.
- **The door**: if players choose Wild when it is offered and reactions happen at least once a
  round, the tile model gets built, and with it frozen lava bridges, a floor that cracks, the
  Isles, the Glacier Forge, Ember Clock and, eventually, the Pit.

### Bet 6 · Always something to do alone

- **Daily Gauntlet**: the same seeded scenario for everyone, scored by the sim, verified by the
  server re-simulating the submitted inputs (same sim id on the day).
- **Trials**: Lightning-detonate a moving Fireball, Swap an enemy into a pillar blast, Teleport out
  of a lethal slide. The guided lesson's checker is the pattern.
- **Play from here**: any replay tick, any seat, bots for the rest.
- **The coach**: three findings after a match, each a link into the replay at the moment.

### Bet 7 · Find the first hundred, then the first thousand

- **Measure first.** Visit, first fight, first finished match, second match, D1, D7, with
  developer and agent traffic filtered out.
- **The orphaned Warlock community.** The Steam group running since 2012, the Dota workshop item's
  subscribers, the lobbies still hosted in Warcraft III. They know the rules and lost the game.
  Done (developer, by 2026-10-28): the original authors and community were contacted and received
  it well; the game is also on itch.io. The open problem is the next places to post: more Discord
  groups and Reddit.
- **Links before SDKs.** `?room=` links into Discord friend groups first; count groups that finish a
  match and start another. Only if they do: the Discord Activity (dedicated rooms only, token
  sessions, a desktop gate with a spectator view for phones).
- **Streamers.** A clean observer view and clip export: the channel that moved 2025's small hits.
- **Portals and Steam** once the developer decides what success means (02 triage).

### Bet 8 · Presentation that earns the bar

- The finish zoom, the Final Blow and the reel (Bet 2).
- **Death chains** in the recap: which hits built the knockback, which one started the flight.
- **An ambient crowd** around the caldera that cheers knockouts and gasps at close calls:
  generated, like Smash's, so it works at a population of one. Real watchers, when there are any,
  are marked as real.
- **The Director**, Left 4 Dead's model ported per warlock (intensity from damage, lava contact and
  nearby knockouts; Build Up, Sustain, Fade, Relax), first driving camera and sound only. It drives
  music once the soundtrack exists (confirmed needed by the developer, 2026-10-28).
- **The character.** PLAN risk 9 still holds: the warlock is the biggest presentation lever, and a
  finish zoom will show it up close. A character upgrade is scheduled before the zoom ships wide.

## 4. Month 12, revised

| Number | Baseline | Month 12 |
|---|---|---|
| Click to first fight (warm-up) | 35 to 85 s to the first real fight | under 10 s |
| First knockout in a casual round | about 107 s (Hard bots) | under 45 s |
| Casual match | about 28 minutes | under 10 minutes |
| Bot movement | no metric | reversals and orders per second inside the human range for every tier |
| Share of opponents a new player outlives, first 20 games (the ladder's pairwise unit; a round win rate means little in a ten-warlock FFA) | not measured | 40 to 60% |
| D7 retention | not measured | measured by month 1, tripled by month 12 |
| Weekly players | at most 7 in the only snapshot | 1,000 |
| Matches with a kept or shared moment | none | 1 in 10 |
| Play hours in Last Stand and solo modes | none | a third |
| Wild chosen when offered | not offered | a quarter or more, or the tile model is not built |

## 5. Assumptions on the developer's open decisions

v2 assumes, and changes nothing without a yes (02 triage):

1. Success is undecided; nothing in the first quarter depends on it.
2. Ranked keeps its format for now; integrity work (plausibility metric) starts anyway.
3. Faster casual rounds are a deliberate deviation, written into PLAN §2 with the measurements.
4. The Showdown and the Director use camera and sound, not light.
5. Discord, if it comes, is desktop with a spectator view for phones.
6. King of the Hill's structure is decided in its own work stream.
7. Contact with the original authors and community: done by the developer; finding further places to post (Discord groups, Reddit) is the open part.
