# Faster casual: five rounds on a compact arena

Status: implementation spec, 2026-10-28. From [03-moonshot-v2.md](../03-moonshot-v2.md) Bet 1 and
[04-keystones.md](../04-keystones.md) Keystone 1 ("Brisk casual"). Ships in one release batch with
[shop-ready.md](shop-ready.md), on the developer's yes.

The developer (2026-10-28): "casual indeed does take a little bit too long ... because of the
amount of wins, and if it gets evenly distributed it drags." "I do like the idea of tweaking the
rounds so that they definitely take less long."

Scope: the casual quick-play preset. Custom lobbies gain the same options with classic defaults;
ranked and the classic rules stay as they are.

## Why

Casual today (`src/net/server.ts:102-105`): ten seats, five Medium and five Hard bots, free for
all, first to 3 round wins, 50/15/2/3 gold, a fight arena of `13 + players` layers (21 for ten),
a ring every 10 s, a 25 s shop. The only human snapshot: 28 minutes over 8.5 rounds, and 6 of 10
casual matches abandoned. Two causes, as the developer says: rounds are long (the lava ends them,
not the warlocks), and ten warlocks share the round wins, so reaching 3 takes about nine rounds.

### Measurements (2026-10-28)

Method: [research/casual-pace.ts](../research/casual-pace.ts), an extension of
[research/pace-experiment.ts](../research/pace-experiment.ts). The real sim and bots, driven from outside; 32 matches per scenario (seeds 100-131;
scenarios A and F repeated on seeds 200-231); ten bots as the casual table (Medium in seats 0-4,
Hard in 5-9), free for all, the queue economy. The scheduled format is the sim's own
`rankedRounds: 5`, including its final (15 s shop, layer `min(15, 9 + finalists)`, a ring every
6 s). A smaller arena is set at fight start and every pawn re-placed by the sim's spawn rule
(`spawnPosition`, `src/sim/spawn.ts:75-87`), as if `startRound` had used it. The shrink period is
applied by re-timing `nextShrinkTick`. Ready is emulated by cutting every shop. Times are fight
seconds; match minutes include shops and round ends, not the lobby.

| | Format | Arena | Ring every | Shop | First KO p50/p90 | Round p50/p90 | Match p50/p90 | Rounds p50 (max) | Final | Match ≤ 10 min |
|---|---|---|---|---|---|---|---|---|---|---|
| A, today | first to 3 | 21 | 10 s | 25 s | 63 / 99 s | 177 / 186 s | 27.7 / 37.6 min | 8 (15) | | 0 / 32 |
| A, seeds 200+ | first to 3 | 21 | 10 s | 25 s | 60 / 97 | 175 / 185 | 27.6 / 40.8 | 8 (16) | | 0 / 32 |
| I | first to 3 | 15 | 6 s | 25 s | 36 / 49 | 78 / 82 | 15.6 / 20.7 | 9 (12) | | 3 / 32 |
| N | 5 rounds | 21 | 10 s | 25 s | 60 / 91 | 176 / 185 | 17.3 / 18.6 | 5 (6) | 10 / 32 | 0 / 32 |
| B, `rankedRounds` as is | 5 rounds | 21 | 8 s | 25 s | 56 / 82 | 146 / 153 | 14.7 / 16.0 | 5 (6) | 13 / 32 | 0 / 32 |
| C | 5 rounds | 17 | 8 s | 25 s | 49 / 71 | 114 / 120 | 12.6 / 13.5 | 6 (6) | 16 / 32 | 0 / 32 |
| D | 5 rounds | 15 | 8 s | 25 s | 40 / 56 | 97 / 105 | 10.7 / 12.0 | 5 (6) | 14 / 32 | 0 / 32 |
| O | 5 rounds | 15 | 7 s | 25 s | 39 / 55 | 88 / 93 | 9.9 / 11.3 | 5 (6) | 14 / 32 | 18 / 32 |
| E | 5 rounds | 17 | 6 s | 25 s | 42 / 56 | 89 / 94 | 9.9 / 11.3 | 5 (6) | 12 / 32 | 18 / 32 |
| **F, recommended** | 5 rounds | 15 | 6 s | 25 s | **36 / 50** | **78 / 81** | **9.0 / 10.2** | 5 (6) | 14 / 32 | 23 / 32 |
| F, seeds 200+ | 5 rounds | 15 | 6 s | 25 s | 36 / 50 | 76 / 81 | 9.0 / 10.2 | 5 (6) | 15 / 32 | 22 / 32 |
| G, F with Ready | 5 rounds | 15 | 6 s | 12 s | 37 / 53 | 77 / 82 | 7.9 / 9.2 | 5 (6) | 15 / 32 | 32 / 32 |
| K, F with Ready | 5 rounds | 15 | 6 s | 6 s | 38 / 50 | 77 / 82 | 7.2 / 8.5 | 5 (6) | 10 / 32 | 32 / 32 |

Who wins, and what they spend:

| | Medium share of round wins, rounds 1-5 | Rounds 6+ | Hard share of match wins | Most match wins by one seat | Distinct round winners per match | Gold spent per warlock per match |
|---|---|---|---|---|---|---|
| A, today | 7% | 25% | 31 / 32 | 11 / 32 | 5.0 | 171 |
| A, seeds 200+ | 9% | 21% | 32 / 32 | 9 / 32 | 5.1 | 176 |
| B | 10% | | 32 / 32 | 11 / 32 | 4.0 | 120 |
| F | 9% | | 32 / 32 | 9 / 32 | 3.9 | 120 |
| F, seeds 200+ | 8% | | 32 / 32 | 9 / 32 | 4.3 | 121 |
| G | 8% | | 32 / 32 | 10 / 32 | 3.9 | 119 |

Findings:

1. **The harness is stable.** A and F reproduce on a second seed set within 3 s and 0.1 minutes
   at p50, and A matches the human snapshot (28 minutes, 8.5 rounds).
2. **Round count is the biggest single lever.** Five scheduled rounds alone (N) take the match from
   27.7 to 17.3 minutes at classic pace, and the tail collapses: p90 37.6 to 18.6 minutes, the
   longest match 15 rounds to 6.
3. **`rankedRounds` as it is** (B) gives 14.7 minutes: its 8 s shrink does not reach the target. It
   also carries ranked-only rules that casual must not inherit: no Fresh start
   (`src/sim/shop.ts:72`), no new seats during a match (`src/sim/roster.ts:13`), no full refund for
   a human taking over a bot (`src/net/session.ts:1218`). Its economy is the queue's own
   (50/15/2/3, the same as casual): fewer rounds simply mean fewer paydays.
4. **Round pace is the second lever.** Layer 15 with a ring every 6 s collapses the arena in
   14 × 6 = 84 s; the round p90 (81 s) sits just under it, the first knockout comes at 36 s and in
   83% of rounds within 45 s (today 26%).
5. **F meets every target at p50 without Ready**: first knockout 36 s, round 78 s, match
   9.0 minutes; 23 of 32 matches under 10 minutes. Shops shortened by Ready (G) bring all 32
   under 10 minutes. 7 s (O) also meets the p50 targets, narrowly.
6. **The spread is the table's, not the format's.** Hard bots win 86 to 96% of rounds and all
   but 2 of 576 matches across the 18 scenarios run, today included; Medium bots are rated about 1000 and Hard about 1825.
   In rounds 1 to 5 the Medium share is the same in every format (4 to 10%); first to 3 only adds
   rounds 6 and later, where Medium won 21 to 25%. No seat dominates: among the five Hard seats the
   most match wins is 9 to 11 of 32 in every scenario, where five equal seats give 6.4 ± 2.3 each
   and the largest of five about 10. Evening out tiers is skill fit (Keystone 3), not this spec.
7. **Finals are common with bots**: 14 of 32 matches in F, with 2 finalists (6) or 5 (8, five Hard
   bots each taking one round). Human tables will tie differently; to be measured.
8. **Shops**: bots finish buying within about 2 s, and about 4 gold is left at fight start in
   every scenario, 6 s shops included.

## What the player sees

- **Main menu**: the Casual entry reads "10 players · 5 rounds · Medium and Hard bots" instead of
  "first to 3" (`src/ui/screens/MainMenu.tsx:144`).
- **Lobby**: the read-only rules show the match length ("5 rounds · final if tied"), the arena
  ("Compact") and the shrink ("a ring every 6 s"). Timers, Ready and "Wait for players" unchanged.
- **In the match**: ranked's presentation, now driven by the format instead of ranked: "Round 3/5"
  and "5 scheduled rounds" at the clock (`src/ui/hud/TopBar.tsx:28-38`), the scoreboard header,
  "Final brawl" with the finalists strip (`FinalBrawlStatus`, `TopBar.tsx:49-57`); benched players
  watch, inspect and bet. The fight arena for ten is 15 layers (radius 1400, spawn ring 1100)
  instead of 21 (radius 2000, ring 1700); a ring sinks every 6 s.
- **Results**: champion first, "Wins" counts scoring rounds, as ranked's results already do.
- **Unchanged in casual**: Fresh start, taking a bot's seat between rounds with the full refund,
  the bot table, gold, the 25 s shop (Ready can end it early), no Elo.
- **Custom lobbies**: three new options (Rules 1-3), defaults classic.

## Rules

Three new match settings (four with the daily's `arenaBase`), each a number so the lobby, stored room options and the settings patch
accept them (`src/net/protocol.ts:393-404`):

1. **`scheduledRounds`**, integer, default 0. 0: first to `winScore`, as today. 1 to 15: that many
   scheduled scoring rounds, then at most one tied-leaders' final: exactly ranked's rules
   ([RANKED-FORMAT.md](../../RANKED-FORMAT.md), Match structure) without rating. Applies only in
   Rounds mode with free for all; ignored (treated as 0) in other modes. With `rankedRounds: 5` it
   is ignored and ranked's five rounds apply.
2. **`arenaCap`**, integer 9 to 21, default 21. A Rounds-mode fight starts at
   `min(arenaBase + active players, arenaCap)` layers. 21 reproduces the original formula (it is
   already clamped to 21). Not applied in Deathmatch, King of the Hill, ranked or a final. The shop
   platform stays layer 14. Ten players at 15: as F; two players: 15 either way. Shared with the
   daily ([daily.md](daily.md)), which also needs **`arenaBase`** (integer, default 13, the
   original `ARENA_BASE_LAYER`; the daily sets 9, the ranked final's size); Brisk leaves it at 13.
3. **`shrinkSeconds`**, number 3 to 30, default 10 (`SHRINK_PERIOD`). The ring period of
   Rounds-mode fights. Ranked keeps 8 s, finals 6 s, King of the Hill its own (10 s rounds style,
   15 s respawn style), Deathmatch never shrinks.
4. **Invalid values** fall back to the default (out of range, non-integer for the two integers,
   negative, non-finite), as `sanitizeSettings` already does for numbers. No throw: a custom lobby
   that switches modes must still start.
5. **The casual final** is ranked's: contenders are the top scorers after the last scheduled round;
   a 15 s preparation shop (Ready can shorten it); layer `min(15, 9 + contenders)`; a ring every
   6 s; no scoring point, win gold paid; at most one; a final nobody survives is shared. The state
   field stays `rankedFinal` (`src/sim/types.ts:489-490`, comment updated to "the scheduled-rounds
   final, ranked or casual"); renaming it would touch about ten files for no behavior.
6. **Ranked-only rules stay on `rankedRounds`**: no Fresh start, no new seats mid-match, no
   takeover refund, the 8 s shrink, Elo and the ranked listing text (`src/ui/lib/elo.ts:18`).
   Casual scheduled matches keep all casual rules.
7. **Announcer**: in a scheduled match the last scheduled round and the final call "Final Round!";
   "Match Point!" never comes from `winScore` there (today `roundCall` compares to `winScore - 1`,
   `src/game/announcer.ts:299-300`, which in ranked means 4 of the unused default 5, and would mean
   2 of the preset's 3 in casual). The fix applies to ranked too.
8. **The casual quick-play preset ("Brisk")**: `scheduledRounds: 5`, `arenaCap: 15`,
   `shrinkSeconds: 6`; economy 50/15/2/3, table, seats, lobby timers, shop 25 s and
   `botsReplaceLeavers` unchanged. `winScore` leaves the preset (unused with scheduled rounds).

## Design

| Layer | File and seam | Change |
|---|---|---|
| Sim | `src/sim/types.ts:70-95` `MatchSettings` | the three keys, documented |
| | `src/sim/config.ts:69, 188-208` | `DEFAULT_SETTINGS`: `scheduledRounds: 0`, `arenaBase: ARENA_BASE_LAYER`, `arenaCap: ARENA_MAX_LAYER`, `shrinkSeconds: SHRINK_PERIOD`; bounds next to `SHRINK_PERIOD` |
| | `src/sim/index.ts:90-105` `sanitizeSettings` | ranges (Rule 4); export the helper below (`index.ts:84`) |
| | `src/sim/mode.ts` | helper `scheduledRoundsOf(settings)`: `rankedRounds` if set, else `scheduledRounds` in Rounds/FFA, else 0. Use it at lines 233 (resolution at fight start), 303-306 (`gameWinners`) and 341 (`endRound`); header comment lines 13-14 |
| | `src/sim/mode.ts:85-89` `shrinkPeriod` | last branch returns `settings.shrinkSeconds` in Rounds mode, `SHRINK_PERIOD` otherwise |
| | `src/sim/mode.ts:219-220` `startRound` | the fight layer takes `min(arenaBase + players, arenaCap)` in Rounds mode outside ranked and finals |
| | `src/sim/shop.ts:72`, `src/sim/roster.ts:13` | unchanged: they stay ranked-only on purpose |
| Server | `src/net/server.ts:96-105` | quickplay `settings`: Rule 8; the comment states the format and links this spec |
| | `src/net/dedicated.ts:112-117, 493` | the room summary carries `scheduledRounds` next to `rankedRounds`; `PublicRoom` in `src/net/online.ts` gains the field |
| | `src/net/leaderboard.ts:392` | finalist-only round order uses the helper, so casual match records order a final like ranked |
| | `src/net/session.ts:1218` | unchanged (casual keeps the takeover refund) |
| UI | `src/ui/hud/TopBar.tsx:28-38` `roundLabel`, `roundGoal` | the helper instead of `rankedRounds` |
| | `src/ui/hud/Overlays.tsx:289` | scoreboard header uses `roundGoal` |
| | `src/ui/screens/Results.tsx:180` | the helper |
| | `src/ui/screens/BrowseGames.tsx:26-30`, `src/ui/lib/roomActivity.ts:10` | read `scheduledRounds` ("5 rounds · final if tied", "Round 3/5") |
| | `src/ui/screens/MainMenu.tsx:144` | the Casual note |
| | `src/ui/screens/MatchOptions.tsx:103-109` | Match length: first to N, or N scheduled rounds with a final (Rounds and free for all only). New Arena rows: size Classic (21) or Compact (15), and "Shrink every" in seconds (Rounds only). Read-only in queue lobbies |
| | `src/game/announcer.ts:287-304` | Rule 7 |
| | `src/ui/lib/feedbackContext.ts:17`, `src/net/feedback.ts:67, 168` | the three keys in bug-report rules, so a report says which pace it came from |

No render, audio or bot change is needed: the arena renders any layer, and bots read the layer and
`nextShrinkTick` from the state (`safetyLayer`, `src/bots/controller.ts:1273-1280`); the harness
above ran the unchanged bots. The ladder and the Elo scripts use classic settings and do not move.

**Netcode id.** `src/sim` and `src/net` change, so the id changes (shipping with Shop Ready, one
new id and one `PROTOCOL_VERSION` bump for both). Old clients cannot join new rooms; replays from
before the release stop playing, as with every sim change. Stored room options and match records
without the new keys read as the defaults.

**PLAN §2 row** (the deviation this needs):

| Original | v1 decision |
|---|---|
| Arena `13 + players` layers, a ring every 10 s, first to N round wins | Casual quick play only (decided 2026-MM-DD after the pace harness and a playtest): at most 15 layers, a ring every 6 s, five scheduled rounds plus at most one tied-leaders' final (ranked's format, without rating). Reason: the original community's one recorded complaint ("the arena shrinks too slowly with many players"); casual ran about 28 minutes over 8 rounds and measures 9 minutes over 5 (`docs/moonshot/specs/faster-casual.md`). Custom games keep the classic rules by default and offer all three as options |

## Out of scope

- The warm-up arena, bots with edge courage, skill fit (the tier spread above), an accelerating
  shrink (the keystone harness found it adds little over a fast constant one).
- King of the Hill's length (its own work stream), ranked, lobby timers.
- The pace instrumentation (Keystone 1, test 1). It should land first or with this release, to
  compare matches finished and abandoned before and after.
- A one-click "Classic / Brisk pace" preset in custom lobbies (open question 4).

## Acceptance

Sim tests run at both rates (`npx vitest run <files>`, `TICK_HZ=60 npx vitest run <files>`), each
saying why the behavior matters:

1. *Faithful by default.* `DEFAULT_SETTINGS` with ten players: the fight starts at layer 21 and
   rings sink 10 s apart; `scheduledRounds: 0` plays first to `winScore` (`src/sim/match.test.ts`).
2. *The compact arena is fair to every seat.* `arenaCap: 15`: ten players start at 15, three
   at 15 (classic 16), two at 15; every fight spawn is at least 300 inside the platform
   (`src/sim/spawn.test.ts`).
3. *The pace setting is seconds, not ticks.* `shrinkSeconds: 6`: consecutive `arenaShrink` events
   are `ticks(6)` apart at 30 and 60 Hz (`src/sim/tickRate.test.ts`).
4. *Casual gets ranked's format exactly.* The scenarios of `src/sim/ranked.test.ts` (five distinct
   winners and a five-leader final, an early clinch at round three, a 2-2 tie final, a shared
   final, regular draws consuming rounds) run once with `rankedRounds: 5` and once with
   `scheduledRounds: 5`, with the same outcomes.
5. *Casual keeps casual rules.* In a scheduled casual match `freshStartRefund` is positive in a
   shop, and `applyRosterChanges` adds a seat between rounds without throwing.
6. *Ranked does not move.* `rankedRounds: 5` with `shrinkSeconds: 6` and `arenaCap: 15` in its
   settings still starts at `13 + players` and shrinks every 8 s.
7. *Other modes ignore the format.* Deathmatch, King of the Hill and Teams with
   `scheduledRounds: 5` play first to `winScore`; `arenaCap` does not touch their arenas.
8. *Bad options never stop a match.* 0, negative, NaN and out-of-range values become defaults.

Elsewhere:

- `src/game/announcer.test.ts`: in a scheduled match round 5 and the final call `final_round`; a
  warlock on 2 wins in round 3 gets a round line, not `match_point`.
- `src/net/dedicated.test.ts:432-446`: the default quick game's lobby settings include the preset's
  three keys; hill, ranked and custom rooms keep their own.
- UI markup: `match-length` (`data-state` `first-to` or `scheduled`, `data-rounds`), `arena-size`
  (`data-state` `classic` or `compact`), `shrink-seconds` (`data-value`), disabled outside their
  modes; `roomMode` and `roomActivity` data for a casual scheduled room.
- Harness: change `docs/moonshot/research/pace-experiment.ts` to set the three keys instead of
  editing state, and rerun A and F with 32 matches. Pass: F within 5% of the table above (first
  knockout p50 at most 45 s, round p50 at most 90 s, match p50 at most 10 minutes, full 25 s
  shops); A reproduces today's numbers.

Playtest questions (one evening in a custom room with the Brisk options, against the casual queue's
history):

- Did more matches finish? Did anyone leave mid-match, and when?
- Did rounds feel better, or rushed? Was the first knockout too early for anyone?
- Did new players understand dying to lava at a ring every 6 s?
- Did the final feel earned, or like a coin flip? Was watching it as a benched player fine?
- Were builds satisfying with five shops (about 120 gold spent per warlock instead of about 175)?

## Risks

- **Smaller builds.** Five rounds pay `50 + 4 × 15` before kills and wins; warlocks spend about 120
  gold per match instead of about 175, and the late, big builds of rounds 6 to 9 disappear. The
  per-round economy is unchanged and is the one ranked already plays.
- **Faster lava for new players.** First knockout at 36 s and a full collapse at 84 s. The tile
  telegraph (last second before each ring) and the death recap already explain lava deaths. The
  top bar's shrink warning pulses for the last 3 s of each period
  (`ShrinkWarning`, `src/ui/hud/TopBar.tsx:113-142`): at 6 s that is half the time. If the playtest
  finds it noisy, pulse for the last third of the period. Fallback preset: 7 s (O).
- **Bots.** Medium bots will win almost no casual match (0 of 64 in F, 1 of 64 today); the long
  tail of rounds where they won a quarter is gone. The fix is skill fit, not a longer format.
- **Joining late.** A human taking a bot's seat in round 4 inherits its score and has one or two
  rounds left; the next match starts 10 s after results.
- **Embers.** Casual completion pays 20 Embers per match ([PROGRESSION.md](../../PROGRESSION.md));
  three times as many matches an hour is three times the Embers an hour.
- **Finals.** Almost half of bot matches end in a final, often five-way. It is ranked's tested
  path, but casual players will meet it often.

## Open questions for the developer

1. **The numbers.** Layer 15 and a ring every 6 s (recommended; every target met at p50), or 7 s
   (gentler; round 88 s, match 9.9 minutes p50, 11.3 p90)?
2. **The final.** Keep ranked's tied-leaders' final in casual, or let tied leaders share the win?
3. **Embers.** Keep 20 per completed casual match, or scale it to match length?
4. **Custom lobbies.** Three separate options, or also a one-click "Classic / Brisk pace" button?
5. **King of the Hill quick play** keeps its rules in this release. Confirm.

## Rollout

One release batch with [shop-ready.md](shop-ready.md), only on the developer's yes and after the
playtest: server and client deploy together (new netcode id); the queue preset applies to newly
created rooms. Docs follow in the same change: the `docs/PLAN.md` §2 row above, §3.4 (the new
options), and `docs/RANKED-FORMAT.md`, whose Duration section says custom and casual keep
10 seconds per layer (now: custom 10 s, casual 6 s on at most 15 layers) and whose opening
sentence on Casual Quick Play gains "five scheduled rounds".
