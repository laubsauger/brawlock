# 04 · Keystones

Phase 4 of the moonshot series. Deep designs for the three bets of
[03-moonshot-v2.md](03-moonshot-v2.md) that everything else leans on:

1. **Pace**: rounds under 90 s, a casual match under 10 minutes, a fight within seconds of a click.
2. **Keep and share**: moments, the Final Blow, the finish zoom, the reel and clips that outlive
   a build.
3. **Opponents that feel like people and fit you**: a motor model, a plausibility metric, skill
   fit and personas.

Why these three: each improves every session at a population of one, each starts with a test a
single playtest or harness run can settle, and each unlocks a row of later bets (pace unlocks
join-in-progress, Discord groups and King of the Hill's length; moments unlock Play of the Round,
the coach and Brawlock TV; the bot work unlocks personas, ghosts and cheat detection).

Two experiments were run for this phase and are kept beside the research:
[research/pace-experiment.ts](research/pace-experiment.ts) and
[research/motion-experiment.ts](research/motion-experiment.ts). Both drive the real sim and bots
from outside and change no source file.

---

## Keystone 1 · Pace

Specs: [specs/faster-casual.md](specs/faster-casual.md) (measured over 32 matches per setup:
about 9 minutes a match, 7.9 with shop Ready) and [specs/shop-ready.md](specs/shop-ready.md).

### What the experiment says

Ten bots in the casual table (five Medium, five Hard), first to 3 in FFA, 8 matches per scenario.
The starting arena and the shrink period were overridden from outside the sim:

| Scenario | First death p50 / p90 | Round p50 / p90 | Match p50 | Rounds |
|---|---|---|---|---|
| A · today: layer 21, a ring every 10 s | 66 / 113 s | 177 / 187 s | 30 min | 9 |
| B · layer 17, 10 s | 61 / 88 s | 137 / 148 s | 28 min | 10 |
| C · layer 21, 6 s | 55 / 79 s | 111 / 116 s | 19 min | 8 |
| D · layer 17, 6 s | 41 / 59 s | 90 / 94 s | 20 min | 10 |
| E · layer 17, 8 s × alive / 10 | 46 / 68 s | 100 / 105 s | 17 min | 8 |
| F · layer 15, 6 s | 38 / 50 s | 76 / 81 s | 16 min | 9 |
| G · layer 15, 6 s × alive / 10 (min 2.5 s) | 37 / 51 s | 70 / 73 s | 19 min | 12 |

Three findings:

1. **The baseline reproduces the human measurement.** Bot-only casual runs 30 minutes over nine
   rounds; the only human snapshot said 28 minutes over 8.5. The harness is a fair proxy for
   length, if not for feel.
2. **The shrink ends the rounds, not the warlocks.** Every round's p90 sits just under the time
   the arena takes to collapse completely. The lava does the killing (83% of deaths in the late
   shrink, backlog §0). A smaller start and a faster shrink cut the round from 177 s to 76 s and
   the first death from 66 s to 38 s. An accelerating shrink adds little over a fast constant one.
3. **Round length alone cannot make a 10-minute match.** In a ten-warlock FFA, first to 3 takes
   about nine rounds whatever the round length, because ten people share the round wins. With
   76 s rounds, a 25 s shop and 3 s of round end, nine rounds are 16 minutes. **The round count is
   the second lever**, and ranked already has the answer: five scheduled scoring rounds and at
   most one leaders' final (`rankedRounds: 5`, [RANKED-FORMAT.md](../RANKED-FORMAT.md)).

### The design: Brisk casual

A hypothesis to test, not a decision. Classic pace stays the default for custom games, and ranked
keeps its own format.

| Lever | Today (casual) | Brisk |
|---|---|---|
| Starting arena | layer `13 + players`, 21 for ten | layer 15 |
| Shrink | a ring every 10 s | a ring every 6 s |
| Match format | first to 3 round wins (about 9 rounds) | five scheduled rounds plus at most one leaders' final, the ranked format without rating |
| Shop | 25 s, fixed | 25 s at most; ends 3 s after every human is Ready (bots are always ready) |
| Bots | Hard keeps about 610 units from the edge | casual bots press closer to the edge (see keystone 3) |
| Waiting | lobby 30 s alone, 60 s with two humans | unchanged, played in a warm-up arena |

**Projected length**: five rounds of about 76 s, shops of about 12 s once Ready works, 3 s of
round end: about 7.5 minutes, plus a final about one round in three. Under 10 minutes.

**The warm-up arena.** When the lobby countdown starts, the player drops into a local, stakes-free
brawl on a small arena against three Easy and Medium bots, with instant respawns. It is the
practice loop (`src/game/practice.ts`) on a private arena: it costs no server time and needs no
new netcode. The lobby collapses into a strip across the top: countdown, roster, Ready, "Wait for
players". When the match starts, the warm-up ends with a banner and the match takes the screen.
Nothing about consent changes: the countdown, Ready and "Wait for players" work as today, and a
setting turns the warm-up off. Clicking Quick play to fighting: a few seconds.

**Ready ends the shop.** A new command (`{ kind: 'shopReady' }`) through the existing input path.
When every connected human seat has sent it, the shop phase drops to 3 s. It is deterministic,
it rides the input stream, and it is one sim rule plus a button. It helps every mode, ranked
included.

**What changes in the sim.** New scalar settings: `scheduledRounds`, `arenaCap` and
`shrinkSeconds` (plus `arenaBase`, which the daily shares). Reusing `rankedRounds` as it is was
measured and rejected: its 8 s shrink leaves matches at about 15 minutes, and it brings
ranked-only rules into casual (no Fresh start, no new seats mid-match). Details in
[specs/faster-casual.md](specs/faster-casual.md).

### Faithfulness

This is the largest deviation from the original yet, so it follows the rule for deviations
(PLAN §2): a row with the reason and the measurement. The reason is the original community's one
recorded complaint ("the arena shrinks too slowly with many players") and the numbers above. The
classic formula stays the default in custom games, and a custom lobby can recreate Brisk or
Classic with the same options.

### Tests that settle it

1. **Instrument first** (blocks everything): per round, the first knockout time, round length,
   seconds dead per human, departures while dead; per match, length and abandonment.
2. **Harness sweep**: extend the pace experiment with the scheduled format, the Ready shop and
   bolder bots; the acceptance band is first death p50 under 45 s, round p50 under 90 s, match p50
   under 10 minutes, with the round winner still spread across the table (no tier wins most
   rounds).
3. **One playtest evening** in a custom room with Brisk settings against the casual queue's
   history: do players finish more matches and say the rounds felt better?
4. **Ship** Brisk as the casual queue, with Classic pace as a custom option, and watch the
   abandonment rate (6 of 10 casual matches in the only snapshot).

### Risks

- **Less shop time means smaller builds.** Five rounds give 50 + 4 × 15 gold before kills and
  wins; that is ranked's economy, already tuned for five rounds.
- **New players die to the lava faster.** The tile warning pulse and the death recap already
  explain lava deaths; the recap's chain of hits (keystone 2) makes them clearer.
- **King of the Hill** does not get faster from this alone: its length comes from tickets and
  holds, not the shrink. It keeps its own work stream.

---

## Keystone 2 · Keep and share

Specs: [specs/moments.md](specs/moments.md), [specs/final-blow.md](specs/final-blow.md),
[specs/results-reel.md](specs/results-reel.md). They supersede the detection rule and the
timings sketched below where the two differ: the knockout's hit is the last enemy hit whose
flight carried the victim into the lava (a fixed 4 s window missed 29% of lava deaths), and the
round Final Blow plays the hit at half speed from 0.3 s before to 0.5 s after, at most 2.2 s.

### The parts

```
sim events + states ──► moments engine ──► Final Blow (round end) ──► reel (results)
        │                     │                                          │
        ▼                     ▼                                          ▼
 state ring (client)   finish zoom (live)                        clip track + video
                                                                         │
                                                                         ▼
                                                    /c/<id> page (unfurl, opens the game)
```

### The moments engine

A pure module (`src/game/moments.ts`) fed the same way the announcer is: each tick's events and
the state they arrived with. It runs anywhere the sim runs: in the live client, in the replay
player and on dedicated servers, which step every official match and could keep the moments of
every match without keeping a replay.

A moment is `{ kind, tick, from, to, actors, score, camera }`. Detection rules:

| Kind | Rule |
|---|---|
| Sealing hit | For a death, the last damage event with knockback from another player within 4 s before it. Most deaths are lava burns seconds after the push; this is the moment that mattered |
| Round decider | The sealing hit of the round's last death |
| Match decider | The round decider of the match's last round |
| Multi-knockout | Two or more credited knockouts by one player inside the announcer's multi-kill window |
| Denied | A Teleport out of a lethal slide (`src/game/teleportSave.ts`) |
| Reflected kill | A sealing hit from a projectile whose original owner is someone else (Shield steal, `origOwner`) |
| Detonation | A Lightning-detonated Fireball that seals a knockout |
| Pillar blast | A death with cause `obstacle` |
| Clutch | A round won by a warlock who was at some point the last of their side against two or more |
| Close call | The announcer's rule: alive a moment after a hit left them at 8% or less |
| Long flight | A sealing hit whose flight carried the victim more than eight tiles |

Score: a base per kind × stakes (1 for an ordinary moment, 1.5 for a round decider, 2.5 for the
match decider) × spectacle (knockback, flight length, victims) × novelty (the same kind by the
same player repeated in one match scores less). The announcer (`src/game/announcer.ts`) already
implements the multi-kill, streak and close-call windows; the engine shares those rules instead
of re-deriving them.

### The Final Blow

- **State ring.** The client keeps the last 6 s of render-ready states (what the frame buffer
  already receives every tick, about 180 entries at 30 Hz). Spectators on snapshots keep the
  snapshots.
- **Playback.** On `roundWin`, the moments engine names the round decider. The world swaps to a
  private `RenderSource` that plays the window from 0.4 s before the hit to 0.8 s after it at
  0.6 speed (2 s), with a camera from the showcase director (`src/render/showcase/director.ts`,
  `camRig.ts`) promoted into shipping code. A plate names the killer, the spell and the victim.
- **Time budget.** Rounds have 3 s of round end (`ROUND_END_SECONDS`); the replay fits. The
  match decider gets a longer version, and the client holds the results until it ends (today
  `GAME_OVER_LINGER_MS` is 600 ms in `src/net/session.ts`). Nothing changes in the sim's timing.
- **Control.** Any key or click skips. A setting chooses off, match only or every round.
  Reduced motion plays it at normal speed without camera moves.

### The finish zoom (live)

When a hit lands on the last opponent of the local player's side and the slide forecast
(`lavaOutcome` in `src/bots/predict.ts`) says it ends in a lethal lava stay, the camera punches
in toward the victim for about 0.4 s, the SFX bus ducks and a stinger plays. No slow motion in
live play: if the forecast is wrong and the victim Teleports out, the player who still controls a
warlock must see the present. A wrong forecast is still drama, as in Smash.

The close-up depends on the character. A camera push onto the current warlock is a test the
developer can run in an afternoon; if the model does not hold up at that distance, the zoom stays
at gameplay pitch until the character upgrade (v2 Bet 8).

### The reel

The results screen plays the match's three best moments. The local recorder already holds the
match's replay for every player who steps the input stream, and the replay player seeks
quickly, so the reel is three seeks and three short plays through the same director camera.

### Clips that outlive a build

Today's replay plays only on the build that recorded it, and the netcode id moves on about 37% of
commits (02 §0). Two changes:

1. **Split the id.** `scripts/net-id.mjs` produces a *live* id (everything a server and client
   must share: `src/sim`, `src/net`, the cosmetics catalog; as today) and a *sim* id (only
   `src/sim` and the command encoding in `src/net/stream.ts`). Replays check the sim id. A queue
   preset, a chat change or a new hat no longer orphans replays.
2. **A build-free clip track.** A clip stores what the renderer needs, not what the sim needs:
   per tick, each warlock's position, facing, health, alive flag, current cast and the modifiers
   that change its look; each projectile's id, kind, position, radius and level; the arena layer;
   the tick's events. Slots carry name, color, team and cosmetics. Delta-coded and gzipped, a
   10 s clip of ten warlocks should be a few tens of kilobytes (to be measured). A track source
   turns it back into state-shaped frames for the renderer. A golden test keeps old fixture
   tracks rendering, so the render schema changes deliberately or not at all.

Durable full replays (loading an old sim bundle by its sim id) remain possible later; clips do
not wait for them.

### Sharing

- **Make.** A Clip button on the Final Blow, the reel and the replay viewer renders the track
  offscreen at 1280×720, encodes H.264 with WebCodecs and muxes MP4 (Mediabunny). No screen
  capture, no extension.
- **Upload.** The track, the video and a poster frame go to the account authority (size caps,
  rate limits, accounts first; guests later behind a check), which returns a short id.
- **Land.** `brawlock.osc.link/c/<id>` serves `og:video`, `og:image` and oEmbed, plays the video
  and offers "Play this in Brawlock". Opening it in the game plays the track in the replay
  viewer. Links carry an attribution parameter, so the funnel counts first fights from clips.
- **Test before building:** a static page with `og:video` posted into Discord, X and Slack
  (frontier §3: inline playback of self-hosted MP4 is unproven and Discord is picky about
  codecs). A day of work decides whether the unfurl is a video or a poster.
- **Care.** Clips show other players' names, which are public in the game but now leave it: an
  option blurs other names in exported video; owners can delete; reports reach the existing
  feedback inbox; unpinned clips expire after 90 days.

### Tests that settle it

- Moments: unit tests from crafted event sequences (a lava death three seconds after a push names
  the push), plus seeded bot matches with known knockouts.
- The Final Blow in offline practice first, for ten playtest rounds: do players watch or skip,
  and can they say who hit whom?
- The id split: a test that edits the cosmetics catalog and checks that a recorded replay still
  plays.
- The unfurl page, before any clip infrastructure.
- Numbers: Final Blow skip rate, reel views, clips per match, clip link clicks, first fights from
  clip links.

---

## Keystone 3 · Opponents that feel like people and fit you

Spec for Parts A and B: [specs/bot-motion.md](specs/bot-motion.md), with a working prototype in
[research/bot-motion-prototype/](research/bot-motion-prototype/) and timing noise added at the
developer's request (bots no longer decide on a shared fixed 0.1 s clock).

### What the experiment says

Bot-only six-warlock FFA fights, per alive fight-second (definitions in
[research/motion-experiment.ts](research/motion-experiment.ts)):

| Tier | Orders per s | Reversals per s | Dithering (share of seconds) | Idle (share of seconds) |
|---|---|---|---|---|
| Easy | 0.9 | 0.19 | 0.00 | 0.24 |
| Medium | 2.4 | 0.65 | 0.07 | 0.12 |
| Hard | 8.7 | 1.29 | 0.15 | 0.06 |
| Brutal | 8.8 | 1.24 | 0.14 | 0.04 |
| Uber | 8.7 | 1.16 | 0.13 | 0.05 |

A reversal is walking resumed within 0.6 s more than 120° away from the last heading (stop, turn,
go counts). Dithering is a second with three or more orders in which walking moved the bot under
60 units net. Hard and up turn fully around more than once a second and spend about one second in
seven giving orders while going nowhere. That is the dance. It is identical across Hard, Brutal
and Uber because they share the decision code and the 0.1 s think; only Easy and Medium, which
think less often, look calmer.

**The human baseline** (added 2026-10-28, [research/replay-motion.ts](research/replay-motion.ts)):
five exported matches, each re-simulated on the release that recorded it, measured the same way.
Click-flip is the share of consecutive move orders within 0.5 s aimed more than 120° apart.

| Player | Orders per s | Reversals per s | Dithering | Click-flip |
|---|---|---|---|---|
| BeFlat (top-rated) | 4.1 to 5.5 | 0.18 to 0.32 | 0.05 to 0.08 | 0.03 to 0.06 |
| Laub | 4.9 to 5.8 | 0.16 to 0.33 | 0.06 to 0.08 | 0.03 to 0.06 |
| Hard bots, same matches | 8.3 to 8.6 | 0.76 to 0.91 | 0.11 to 0.13 | 0.10 to 0.12 |
| Brutal bots, same matches | 8.3 to 8.8 | 0.74 to 1.34 | 0.11 to 0.17 | 0.10 to 0.16 |

Some dancing is human: strong players click about five times a second and dither in 5 to 8% of
seconds. The bots' tell is turning around three to five times as often, and clicking in opposite
directions two to three times as often. Three humans in five matches is a small sample; the tool
reruns as more replays come in.

### Part A · The motor model

Each likely source in [research/codebase-map.md](research/codebase-map.md) §8 gets a knob or a
rule, all in `src/bots/presets.ts` and `controller.ts`:

| Source | Change |
|---|---|
| A new order every think (up to 10 a second) | `orderRate`: a token bucket per tier, at or under the strong humans' 5 to 6 orders a second. Lethal dodges and Teleport saves bypass it |
| Wander re-picked every think once within 100 units, with "stay here" as a candidate | `commitSeconds`: a goal is kept for 0.6 to 1.5 s unless it turns unsafe, enters a pillar or a threat appears; choosing to stay means staying for that long |
| No exit margin between dodging and wandering | Dodge hysteresis: enter at the current threshold (2.5), leave only below about 1.6; the dodge side holds for 0.4 to 0.6 s instead of two thinks |
| Duel points re-drawn at random angles every 0.3 to 0.6 s (Brutal, Uber) | The standoff angle takes a small random step (about ±0.15 rad) every 1 to 2 s instead of a fresh draw |
| Near-identical re-targets | A dead band: no new order when the new goal lies within about 20° and 100 units of the current one |
| A faked windup vanishes and the bot snaps back | Inertia: after a vanished threat the dodge continues for about 0.2 s, the way people flinch |
| Pillar routing flips sides | The side is chosen once per approach |
| Hill go or wait flips at random | Decided with hysteresis about every 2 s; aware of the hill's opening seal |
| FFA position re-rolled from 12 fresh candidates | The current goal stays unless a candidate beats it by a margin |

Acceptance: every tier inside the human band (from the baseline above: reversals under about
0.35 a second, click-flip under about 0.07, dithering under about 0.08, orders at or under about
6 a second), and `LADDER=1 npx vitest run src/bots/ladder.test.ts` with each tier within about 50
Elo of its label, or a deliberate remeasure and relabel with `npm run bots:elo`. The menu
backdrop gets a visual check in a muted headless browser.

### Part B · The plausibility metric, twice

The same four measures become a CI gate next to the ladder (bots must look human) and, run on
the server over human seats in official matches, the first detector for input automation (a
human seat must not look like the shipped bot). The detector looks for what the motor model does
not hide: orders landing exactly on think boundaries (every third tick at 30 Hz), reaction times
from projectile spawn to dodge that never vary. Detection only: flags go to a review list, nothing
is banned automatically.

There is a real tension here, and it is the developer's call: the more human the bots move, the
better the shipped Uber bot works as a cheat. Options: keep the strongest decision settings on
the server for official rooms and ship weaker ones in the client bundle (offline Brutal and Uber
would get weaker too), or accept the risk while ranked is small and rely on detection.

### Part C · Skill fit

- **A fit rating** for every player, separate from ranked Elo: updated after each round against
  the bots at the table, whose ratings are known (`BOT_ELO`), in the ladder's own unit (who
  outlived whom). New players start between Easy (about 350) and Medium (1000) and move fast for
  their first twenty games.
- **Continuous difficulty.** Bot settings interpolate between neighbouring presets (numbers
  linearly, switches at the midpoint), calibrated with the existing Elo harness at a handful of
  points in between, so any rating maps to a bot setting.
- **Seating.** Quick play seats bots around the player's fit rating so a new player outlives about
  half the table. With several humans, bots spread around the median human. Ranked is untouched.
- **Openly.** Adjustments happen between matches, never mid-match, and the game says so: "bots
  in quick play are matched to your level". The frontier (§5) shows hidden adjustment erodes trust.
- **The cliff closes.** Guided practice ends against Easy bots at about 350; casual seats Medium
  at 1000 and Hard at 1825. Fit seating removes the jump.

### Part D · Personas

A persona is a named, labelled bot: a name and title, a skill offset, a style (aggression, edge
courage, love of Scourge, use of Teleport and Shield), a bias on the seeded build pool
(`src/bots/plan.ts`) and a wardrobe outfit from the cosmetics catalog. Twelve to start, spread over
styles, the top ones as a named circle of champions. Examples:

- *Cinder the Patient*: walls with Shield, punishes greed, never chases.
- *Rook*: Teleports in for the Scourge and out again.
- *Mother Ash*: Gravity and Meteor, at her best in the last two rings.

Each player keeps a record against each persona (local for guests, on the server for accounts).
The persona with the most knockouts on you lately is your **rival**: named in the lobby, tagged in
the kill feed, and beating them three times running earns a small title. Rivalry with people
needs people; rivalry with personas works today, and personas wearing wardrobe pieces show off
the catalog to people who have never opened it.

### Part E · Ghosts, when there is data

Opt-in by the owner, built as Killer Instinct built Shadows (frontier §5): recorded situations and
actions, a nearest-neighbour recall over a few dozen game-state measures, patterns dropped when
they keep getting punished, the scripted bot as the fallback. Trigger: server-side style features
for a few hundred players.

### Risks

- **Calmer movement may cost dodging and Elo.** Compensate with decisions, not twitch; the ladder
  decides.
- **Persona styles disturb the ladder.** Their skill offsets are calibrated like tiers.
- **Fit ratings invite sandbagging.** Casual rewards come mostly from completing a match, not from
  winning it ([PROGRESSION.md](../PROGRESSION.md)), so the incentive is small.

---

## What the keystones ask of the developer

1. Pace: the Brisk deviation for casual (PLAN §2 row), after the harness and one playtest.
2. Keep and share: whether a close-up of the current warlock holds up; whether clips are
   account-only at first.
3. Bots: where the strongest bot settings live (client bundle or server only).

[05-roadmap.md](05-roadmap.md) puts these into twelve months, with kill criteria and the first
thirty days.
