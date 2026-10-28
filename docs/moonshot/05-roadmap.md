# 05 · Roadmap

Phase 5 of the moonshot series: twelve months, the triggers that fund the big bets, the kill
criteria that stop them, and the first thirty days. It turns [03-moonshot-v2.md](03-moonshot-v2.md)
and [04-keystones.md](04-keystones.md) into an order of work. [NEXT-SPRINT.md](../NEXT-SPRINT.md)
stays the active backlog; when a roadmap item starts, it moves there.

## 1. How the year is run

- **Plan in playtests and decisions, not developer-weeks.** Implementation is fast here (King of
  the Hill reached a queue 32 minutes after its first commit). Design iteration and taste calls are
  slow (the same mode took 19 tuning commits in 35 hours and has not settled). Every item below
  starts with the cheapest test that a harness run or one playtest evening can settle.
- **Measure before building.** Nothing in this plan can be judged without the funnel numbers, so
  they come first.
- **Big bets are funded by triggers.** Each large item names the number that unlocks it. If the
  number never arrives, the item never starts, and nothing was wasted finding that out.
- **Population-elastic or not at all.** Every feature passes the five tests in v2 §1: works with
  one human, better with each human, near-zero idle cost, measures itself, never pretends.
- **Releases stay batched.** Nothing ships without the developer's yes; a release is a batch of
  finished, tested work ([deploy/RELEASE.md](../../deploy/RELEASE.md)).
- **One queue family.** New rules rotate inside casual as playlists or arrive in custom lobbies.
  No new queue until a queue fills.

## 2. The first thirty days (2026-10-29 to 2026-11-27)

### Week 1 · See the game

- **The funnel.** Events for visit, warm-up started, first fight, first finished match, second
  match, return on day 1 and day 7, per guest and per account, with developer and agent browsers
  filtered (headless flag and a local developer marker). Read the Operations dashboard's current
  numbers to replace the nine-day-old snapshot.
- **The dead-time numbers.** Per round: first knockout, round length, seconds dead per human,
  departures while dead. Per match: length and abandonment. From the match tracker, server side.
- **The human motion baseline.** Run [research/motion-experiment.ts](research/motion-experiment.ts)'s
  measures over every recorded human replay available (the developer's own and playtest
  recordings).
- **Split the netcode id** into a live id and a sim id (keystone 2), so replays survive queue and
  catalog edits from here on.
- **Fix the drift** 01 §6 lists (PLAN broadphase and compute-particle claims, the missing
  action-rate cap, the Shuffle default, `KEYFRAME_EVERY` as a tick literal, the stale 30 Hz line).

### Week 2 · Build the three cheapest keystone parts

- **Motor model** (keystone 3, part A) with the ladder rerun.
- **Ready ends the shop** (one command, one rule).
- **Pace harness sweep**: scheduled rounds, Ready shops and bolder casual bots added to
  [research/pace-experiment.ts](research/pace-experiment.ts).
- **The unfurl test page**: a static `og:video` page posted into Discord, X and Slack.
- **The warm-up arena**, offline prototype on the practice loop.

### Week 3 · Playtest

- **Playtest evening 1**: a custom room with Brisk settings, motor-model bots and the shop Ready;
  the Final Blow running in offline practice. Questions: did matches finish, did rounds feel
  better, did anyone notice the bots moving differently, did players watch the replay or skip it?
- **Moments engine v1** with tests from crafted sequences and seeded matches.
- **Fit rating and interpolated difficulty**: the calibration runs.

### Week 4 · Decide, ship, reach out

- **Decisions** for the developer: the Brisk deviation, the Final Blow default, where the strongest
  bot settings live.
- **Release batch 1** (on the developer's yes): Brisk casual, motor-model bots, shop Ready, warm-up
  arena, the id split.
- **Outreach.** The original authors and community are already reached and happy (the developer,
  by 2026-10-28), and the itch.io page is live. Next: `?room=` links into five Discord friend
  groups the developer is not in, and Reddit (§2.1).

### 2.1 Where to post next

The developer's report (2026-10-28): the original community is reached, the itch.io page is up,
and finding further places to post has been hard. Candidates by audience, none tried yet; check
each community's self-promotion rules first, and lead with a 15-second clip rather than a bare link:

- **Genre players**: Reddit's Battlerite and Dota 2 communities (Warlock Brawl was a Dota 2
  custom game), Warcraft III communities.
- **Browser-game players**: Reddit's web-game and play-my-game communities, indie-game showcase
  threads.
- **Makers**: three.js and WebGPU communities (Reddit and their Discord showcase channels). A
  WebGPU game with a deterministic sim and bots is a technical story those audiences share.
- **Portals with their own audience**: CrazyGames (about 35 million monthly users) and Poki
  (about 100 million); multiplayer needs invite links and rooms that persist across rounds, and
  CrazyGames' full launch requires its own login ([research/frontier.md](research/frontier.md) §3).
- **Streamers** of party and arena games; the clean observer view (Q2) is what helps them.

### The day-30 gate

| Check | Pass |
|---|---|
| Funnel and D1/D7 recorded, developer traffic filtered | yes |
| Casual match length, live | p50 under 12 minutes |
| First knockout in a casual round, live | p50 under 50 s |
| Bot movement | every tier inside the provisional band, ladder within 50 Elo or relabelled |
| Discord link test | at least 2 of 5 groups finish a match and start another |
| Unfurl test | answered: video, poster or nothing |

## 3. Twelve months

### Q1 · Months 1 to 3: the keystones

- Brisk casual live and tuned; Classic pace as a custom option.
- Bots: motor model, the plausibility gate in CI, skill fit in quick play, twelve personas with
  rivals.
- Keep and share, local half: the Final Blow live, the finish zoom (at gameplay pitch until the
  character upgrade), the results reel.
- Solo: the Daily Gauntlet (server re-simulation on the day's sim id), three Trials, Play from
  here in the replay viewer.
- The Wild lab: one ruleset toggle and casual playlist slot with the Maw's tide and three
  spell-to-spell reactions, a mutator of the week from server configuration.
- Operations: shards merged, a "servers are full" screen, input-automation detection v0 (flags
  only).
- Music: the soundtrack (confirmed needed) enters the shop and fight once selected.

### Q2 · Months 4 to 6: together, and outward

- **Last Stand**: one to four warlocks against bot waves, persona bosses every fifth wave, bot
  allies filling seats.
- **Clips**: the build-free track, browser encoding, upload, `/c/<id>` pages; only the unfurl form
  the Week-2 test proved.
- **Discord Activity**, if the link test passed: dedicated rooms only, token sessions, proxy
  mappings, a desktop gate with a spectator view for phones, WebGPU checked inside the client.
- **Streamers**: a clean observer view and clip export; two or three streamers approached.
- **The coach v1** and death chains in the recap.
- **The ambient crowd**, generated and never posing as people.
- **The Director** for camera and sound (Left 4 Dead's states per warlock).
- **The character upgrade** decision (PLAN risk 9), before the finish zoom goes close.

### Q3 · Months 7 to 9: what the triggers funded

Each item starts only if its trigger fired (§4):

- The tile model, then frozen-lava bridges, a floor that cracks, The Maw proper, The Shattered
  Isles.
- Ascension, the Last Stand run with relics and evolutions.
- Adaptive music by Director state.
- Ghosts, opt-in.
- Steam or a portal, by the developer's answer on what success means.
- Nemesis between people.

### Q4 · Months 10 to 12: what the crowd funded

Again only on triggers:

- The Pit, if dead time is still a measured problem after Brisk.
- Brawlock Cups, observer mode for casters, Brawlock TV.
- The Forge's arena editor and a featured community arena.
- The Sanctum.
- An edge-room pilot, if two regions saturate.

## 4. Triggers

| Bet | Starts when | Measured by |
|---|---|---|
| Tile model and the living arena | Wild is chosen in a quarter or more of the lobbies where it is offered, and reactions happen at least once a round | lobby settings and match events |
| The Pit | after Brisk, humans still spend more than 40% of fight time dead, or leave while dead | dead-time numbers |
| Ascension | Last Stand holds a fifth of play hours for a month | session analytics |
| Adaptive music | a soundtrack is chosen | the developer |
| Ghosts | style features stored for 300 or more players, with opt-in | server profiles |
| Nemesis between people | most active players see a human knock them out at least weekly | match records |
| Discord Activity | 2 of 5 friend groups finish a match from a link and start another | the Week-4 test |
| Steam, portals | D7 retention known, and success defined | funnel, the developer |
| Cups, TV, observer for casters | 50 or more concurrent at the EU evening peak | presence |
| The Sanctum | 100 or more concurrent | presence |
| Forge arena editor | a fifth of custom lobbies change at least one rule knob | lobby settings |
| Edge rooms | a region's rooms stall at peak after shards | capacity metrics |

## 5. Kill criteria

| Bet | Kill when | Then |
|---|---|---|
| Brisk casual | abandonment does not fall in a month, or two playtests call the rounds rushed | back to Classic pace; keep the shop Ready |
| Warm-up arena | fewer than a third of lobby waits use it, or anyone misses a match start because of it | lobby as today |
| Final Blow | skipped more than 60% of the time after two weeks | match decider only |
| Clips | under 2% of matches produce one after six weeks | keep the local reel, stop the share pipeline |
| Motor model | the ladder cannot hold within 50 Elo without the dance | relabel the tiers rather than keep the dance |
| Skill fit | new players' share of opponents outlived stays outside 35 to 65%, or players say they feel handled | make difficulty a visible choice instead |
| Personas and rivals | rival features change neither D7 nor match counts in two months | keep the names, drop the rival layer |
| Wild | chosen in under 15% of offers, or under one reaction a round | no tile model; the tide stays a mutator |
| Last Stand | under a tenth of play hours after six weeks | keep it as solo practice; no Ascension |
| Daily Gauntlet | under 5% of daily players enter after a month | weekly instead of daily |
| Discord Activity | under 10% of new players after two months | maintain, build nothing Discord-specific on top |

## 6. The developer's decision queue

Collected from [02](02-red-team.md#triage), [03](03-moonshot-v2.md#5-assumptions-on-the-developers-open-decisions)
and [04](04-keystones.md#what-the-keystones-ask-of-the-developer), in the order they block work:

1. **Brisk casual** as a written deviation for the casual queue (week 4).
2. **Where the strongest bot settings live**: client bundle or server only (week 4).
3. **The Final Blow default**: off, match only or every round (week 4).
4. ~~Contacting the original authors and communities~~: done by the developer.
5. **The soundtrack**: confirmed needed (2026-10-28); the selection is open and gates fight music and adaptive music.
6. **What success means**: hobby, portfolio or business (before Q3 distribution choices).
7. **Ranked with bots**: keep the format, or a human-only ranked when the population allows.
8. **The Showdown**: camera and sound only (assumed), or a lighting change after a look.
9. **King of the Hill's structure**, in its own work stream.
10. **Clips for guests** or accounts only.

## 7. What Monday looks like

1. Pull today's numbers from the Operations dashboard and write them into §2's gate as baselines.
2. Add the funnel events and the dead-time numbers.
3. Start the motor model, with the ladder and the motion experiment side by side.

