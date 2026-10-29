# Bot motion: stop dancing on the spot

Status: built 2026-10-29, shipped in alpha.17 (see "Built" at the end). Spec of 2026-10-28, from [04-keystones.md](../04-keystones.md) Keystone 3
Parts A and B and [research/codebase-map.md](../research/codebase-map.md) §8. Every number below
was measured with the prototype in
[research/bot-motion-prototype/](../research/bot-motion-prototype/) (a copy of `controller.ts` with
every rule switchable, plus its harness: `npx vite-node run.ts -- --scenario ffa6|duel|menu
--matches N --variant name` from that folder); it changes no source file.

The developer (2026-10-28): "nine move orders per second, that's indeed a lot ... clicking while
going nowhere, that's the problem. We need to fix that without messing them up". Also: "some sort
of dancing is actually normal", and the bots' "exactly 0.1 second apart" timing is "very
predictable, very static and inorganic, and leads to weird races between them".

The goal is human-shaped movement with the same decisions. The defect is **turning around
without a reason and going nowhere**, measured against recorded humans. A high order rate alone
is not the defect: strong humans click about five times a second.

## Why

### Humans against bots

Five exported matches in `media/replays/` (git-ignored) were re-simulated on the release builds
that recorded them (alpha.10, .13, .14 and .16; no desyncs) by
[research/replay-motion.ts](../research/replay-motion.ts). The line-ups: BeFlat, Laub, Thorn, Vex
(10-24); Ash, Laub, Thorn, Vex (10-25, two files); BeFlat, Laub, Ash, Cinder (10-25); Ash, POPE,
Laub, BeFlat (10-27). Three are rounds matches (two at 60 Hz, one at 30 Hz) and two are King of the Hill at 30 Hz.
That is three humans in five matches: a starting band, not a distribution. BeFlat, the top-rated
player, is the reference for strong human movement. Values are per alive fight-second, as ranges
across matches:

| Who | Orders/s | Reversals/s | Dither | Click-flip | Move-order gaps p10 / p50 / p90 (s) |
|---|---|---|---|---|---|
| BeFlat (top-rated) | 4.1–5.5 | 0.18–0.32 | 0.05–0.08 | 0.03–0.06 | 0.07–0.08 / 0.10–0.15 / 0.30–0.58 |
| Laub | 4.9–5.8 | 0.16–0.33 | 0.06–0.08 | 0.03–0.06 | 0.08–0.10 / 0.17 / 0.23–0.30 |
| POPE (few clicks) | 0.9–1.2 | 0.05–0.08 | 0.01 | 0.02–0.07 | |
| Hard bots, same matches | 8.3–8.6 | 0.76–0.91 | 0.11–0.13 | 0.10–0.12 | 0.07 / 0.10 / 0.13 (30 Hz); 0.10 throughout (60 Hz) |
| Brutal bots, same matches | 8.3–8.8 | 0.74–1.34 | 0.11–0.17 | 0.10–0.16 | as Hard |
| Medium bots, same matches | 2.3 | 0.49–0.55 | 0.06–0.07 | 0.25–0.27 | 0.33 / 0.37 / 0.73 |

Casts per second are alike (humans 0.28–0.72, bots 0.36–0.54). Compared with strong humans, bots
turn around three to five times as often and click in opposite directions two to three times as
often. Their order gaps sit on the think interval, a fingerprint for automation detection. In
bot-only six-warlock FFA ([research/motion-experiment.ts](../research/motion-experiment.ts)),
Hard, Brutal and Uber reverse 1.16–1.29 times a second and dither in 13–15% of seconds.

### Where the dance comes from

The prototype tagged every order with the decision that issued it and attributed each reversal to
the order that started it.

- **"Stay here" is a walk back (FFA).** `pickFfaWander` scores the bot's own position as a
  candidate (`controller.ts:1432`), and that candidate won 72% of wander picks in six-bot FFA.
  The order is a move to where the bot stood when it decided. It lands one reaction delay later
  (0.12–0.18 s), when a walking bot is 25–38 units past that point, so the bot turns around.
  Being within 100 units of its goal, it re-picks on the next think, often "stay" again. **60–67%
  of Hard–Uber reversals in FFA follow such an order**; stay-to-stay ping-pong alone is 36–44%.
- **The standoff re-draw (duels).** Brutal and Uber re-draw their point beside the target at a
  fresh random angle every 0.3–0.6 s and on every arrival (`controller.ts:1319-1327`). That is
  84–88% of their reversals in duels.
- **Dodge in, dodge out**: about half the reversals in the eight-bot menu backdrop.
- **Hard's random roam** (the original AI's wander point): 91% of Hard's reversals in duels.
- **Not seen in bot-only matches**: pillar routing, the hill go/wait coin flip and vanishing
  windups (bots rarely fake casts; the hill was checked separately, codebase map §8, item 5).

### Why slower thinking is not the fix

The think interval alone, on paired seeds 1–40 (40 matches per line, about ±4 points of rounds):

| Hard, Brutal and Uber think every | Orders/s (FFA) | Reversals/s (FFA) | Uber over preset Brutal (rounds) |
|---|---|---|---|
| 0.1 s (today) | 8.7 | 1.16–1.29 | 72% |
| 0.2 s | 4.4 | 1.05–1.31 | 66% |
| 0.35 s | 2.4 | 0.44–0.51 | 40% (Brutal over preset Hard: 42%, today 77%) |
| 0.5 s | 1.8 | 0.37 | 21% |

At 0.2 s the bots click half as often and reverse just as much. Reversals only fall at 0.35 s, by
which point each tier has lost a whole step. The dance comes from *what* the bot orders, not how
often it thinks. The motor model below fixes the orders and leaves the thinking alone.

## What players see

- **In matches.** Today a Hard-or-better bot with nothing to do steps back and forth on the spot
  a few times a second. In duels, Brutal and Uber orbit their target with sudden side switches,
  and snap back toward a bolt's line after a dodge. With the motor model, a bot walks to a spot and
  stands there, strafes in arcs and keeps going after a sidestep. It reacts at a varying human
  pace instead of on a shared 0.1 s clock, and it still shoots, dodges, Teleports and pushes as
  often.
- **In the menu backdrop** (`src/render/menuStage.ts`: eight bots, Brutal and Uber alternating,
  FFA), the first thing every visitor sees. Today each warlock reverses about once a second
  (0.27–0.31 times with no bolt near it) and dithers in 13% of seconds. With the prototype it
  reverses 0.48 times a second, nearly all of it answering a real bolt (free reversals 0.08/s),
  and dithers in 8% of seconds. Eight strong bots dodge a lot: that is the fight, not the dance.

## Rules

Each rule is a behaviour a test can observe. **Free** means no enemy bolt with danger ≥ 1.6 at
the pawn (the original danger field, `src/bots/danger.ts`) within the last 0.4 s. Durations are
seconds of sim time from the decision tick. The rules govern move and stop orders, never casts.

1. **Stay means stop.** When the best wander candidate is the bot's own position (FFA and hill
   pickers), the bot sends one `stop` if it is walking, then holds. It never orders a move to its
   decision-time position. The hold counts as the goal for rule 2.
2. **Goal commitment.** A wander goal (a point or a hold) is kept for at least `commitSeconds`:
   neither arriving within 100 units nor the wander timer re-picks it before then. It breaks at
   once when the goal turns unsafe (lava, or the next layer within `shrinkLookahead`), enters a
   pillar or an area threat, or the target changes. Dodges, flight, saves and casts come earlier
   in `decide` and are never delayed by it.
3. **Dodge exit and side hold.** A dodge starts at `dodgeThreshold` as today. After a dodge order,
   while danger stays at or above `dodgeExit` and less than `dodgeHoldSeconds` has passed, the bot
   sends no wander order: it keeps its dodge walk and may still cast. The dodge side is kept for
   `dodgeHoldSeconds` (today two thinks) while it still lowers danger.
4. **Standoff drift (Brutal, Uber).** The angle beside the target moves by at most `standoffStep`
   (clamped to ±0.5 rad) instead of being drawn fresh. The radius moves by at most 40 units within
   its band (450–650, or 700–850 while the target's Shield may rise), so a band switch slides to
   the nearest edge. Re-draws come every 1–2 s instead of 0.3–0.6 s. A fresh draw happens only
   when the drifted point is unusable.
5. **FFA goal keeping.** `pickFfaWander` scores the current goal (or the hold) with a bonus of
   `ffaKeep`, so a new candidate must beat it by that margin.
6. **Dead band and re-click.** A move is redundant when, seen from the pawn, it points within
   `deadBandRad` of the order in effect after the queue lands (the last queued move, else
   `pawn.moveTarget`), and the two goals are within 100 units of each other or both lie beyond
   400. A stop is redundant when nothing moves; it is dropped. A redundant move goes out only as a
   human re-click, after a lognormal gap (mean `reclickSeconds`, σ 0.5) since the last one.
   Nothing changes on screen.
7. **Order budget (backstop).** A token bucket of `orderBudget` move and stop orders a second
   (burst 3), with at least 0.07 s between released orders. **Urgent orders bypass both**: a dodge
   from a bolt that would hit within 0.5 s or whose hit would be lethal or high-risk
   (`unavoidableHit`'s test), leaving lava, `fleeThreats`, and cancelling Scourge to dodge. Casts
   are never budgeted, so Teleport saves, blinks, escapes and Shields always go. With rules 1–6
   the budget dropped 1–5% of orders: it is a guarantee, not the mechanism.
8. **Post-threat inertia.** When a read windup (`windups`, `controller.ts:908-930`) vanishes and no
   bolt from that caster appeared, the bot keeps it as a bolt for `threatInertia` seconds. It
   finishes the flinch instead of snapping back, so a faked cast costs it a short step, as it
   costs a person.
9. **Pillar side lock.** `routeAround` picks the side once per approach to a goal, until the goal
   changes or the pillar is passed.
10. **Hill go/wait hysteresis.** The go-or-hang-back roll (`hillDrive` and the crowded-hill gate)
    is redone every `hillDecideSeconds`, not on every pick. Switching from wait to go needs one
    warlock fewer on the hill. While the hill is sealed (`hillSealed`), "go" means waiting at the
    field's edge.
11. **Timing noise**, against the lockstep and the "races". Each think interval is drawn per
    decision from a lognormal with the tier's mean (`thinkInterval`) and spread `thinkSigma`; a
    fractional clock accumulates the draws, so rounding to whole ticks keeps the mean. Each bot
    starts at a random phase within one mean interval, and the pillar reflex (`unstick`) gets its
    own phase instead of `tick % UNSTICK_TICKS`: same-tier bots then decide on the same tick only
    as often as chance (today, always). Each reaction delay is drawn from a lognormal with the
    preset's mean and spread `delaySigma`, floored at 0.1 s (a human's simple-reaction floor),
    replacing the two-value dither. Orders leave in decision order: a release tick is never
    earlier than the previous one's.

### Starting values

These were measured in the prototype on all five active tiers. One set fits every tier, except
where a rule needs a tier's feature. Every knob is 0 (off) in `ORIGINAL` and for Dummy.

Easy keeps every knob at 0 (open question 2).

| Knob | Medium | Hard | Brutal, Uber |
|---|---|---|---|
| `commitSeconds` | 0.8 | 0.8 | 0.8 |
| `dodgeExit` / `dodgeHoldSeconds` | 1.6 / 0.5 | 1.6 / 0.5 | 1.6 / 0.5 |
| `standoffStep` (rad, standoff tiers only) | 0 | 0 | 0.15 |
| `ffaKeep` | 0.1 | 0.1 | 0.1 |
| `deadBandRad` / `reclickSeconds` | 0.35 / 0.12 | 0.35 / 0.12 | 0.35 / 0.12 |
| `orderBudget` (orders/s) | 6 | 6 | 6 |
| `threatInertia` (s, windup readers only) | 0 | 0.2 | 0.2 |
| `hillDecideSeconds` | 2 | 2 | 2 |
| `thinkSigma` / `delaySigma` | 0.4 / 0.25 | 0.4 / 0.25 | 0.4 / 0.25 |

Rules 8–10 never triggered in bot-only matches. Their values are starting guesses, checked by unit
tests and the playtest.

## Design

Every change is in `src/bots/`: `controller.ts`, `presets.ts`, `pillars.ts`, `prng.ts` and a new
metric module. Nothing in `src/sim` or `src/net` changes, so the netcode id and stored replays
stay valid. Line numbers are from `ab2273f`.

| Where | Change |
|---|---|
| `presets.ts`: `BotParams` (127-220), `ORIGINAL` (222-263), `BOT_PRESETS` (265-409), header table (16-53) | Add the knobs, each documented. They are 0 in `ORIGINAL`, so `npm run bots:elo --params` can express ablations and today's behaviour. Add per-tier values, table rows and a paragraph on the motor model |
| `think` (283-324), decision branch (309-318) | A fractional `thinkClock`. The first call sets the random phase and makes no decision. `unstick` (314) uses a per-bot `unstickPhase` |
| Constructor (275) | A new `timingRng` stream, seeded beside `delayRng`. It draws the phase, think gaps, delays and re-click gaps, so the decision stream's contract is unchanged |
| `enqueue` (326-329) | Release at `max(at, last queued at)`. Non-urgent moves and stops also wait at least 0.07 s after the previous release |
| `reactionDelayTicks` (336-340) | A lognormal draw with the floor, then the existing whole-tick dither of the fraction |
| `reset` (342-362) | Clears the new state: commitment, hold, standoff angle and radius, re-click, tokens, last release, think clock, pillar side, hill decision, vanished windups |
| `decide` step 4 (506-514) | Adds the commitment (rule 2) |
| `decide` steps 7 and 10 (552-553, 641-658) | Orders pass through a new `order(me, cmd, urgent)`: the dead band and re-click (rule 6) against a new `effectiveTarget(me)`, then the budget (rule 7). The hold (rule 1) and the settle (rule 3) come just before the wander move. `mustDodge` (529) is unchanged |
| `pickWander` (1296-1354) | Starts the commitment and sets the hold when the point is the bot's own position. The drift and the 1–2 s timer replace the standoff draw (1319-1327) |
| `pickFfaWander` (1402-1441) | Adds the keep bonus |
| `pickHillWander` (1362-1398) | Adds decision memory, crowd hysteresis, seal awareness and rule 1 |
| `dodgeMove` (1504-1532) | The side memory (1507) uses `dodgeHoldSeconds` |
| `windups` (908-930) | Keeps a vanished entry for `threatInertia` |
| `pillars.ts` `routeAround` (47-73) | Takes an optional side and returns the side it used |
| `prng.ts` | New `lognormal(rng, mean, sigma)`: the normal is four uniforms, centred and scaled by √3, so only arithmetic and `exp` from `sim/math` are needed |

**Interplay with reactionDelay and thinkInterval.** Both means keep their meaning; rule 11 only
adds spread. Commitment, dodge hold, inertia, hill decisions and re-click gaps run on sim time
from decision ticks, so a long think gap does not stretch them. The dead band compares with the
order in effect *after* the queue lands, so it never drops an order because an earlier one is
still waiting out its delay. The budget refills per tick, and the minimum gap applies to release
ticks, where the input stream sees it.

**Determinism and the lint.** Every draw comes from the bot's seeded streams (no `Math.random`,
`Date` or `performance`). Trigonometry and `exp` come from `sim/math`; `mathGuard.lint.test.ts`
allows `Math.sqrt`, `min`, `max` and `abs`. `ticks()` converts at run time, and rate-derived
module values go in `onTickRate`. The same seed gives the same commands, at 30 and 60 Hz.

## The plausibility metric, permanently

One implementation measures humans and bots: `src/bots/motion.ts`, a pure meter fed per tick with
the state before the step, each player's commands and the state after.

| Measure | Definition |
|---|---|
| orders/s | Move and stop commands per alive fight-second |
| reversals/s | Walking resumes or continues within 0.6 s of the last walking tick, heading more than 120° away. Split into threatened and **free** (as in the rules); free reversals are the dance |
| dither | Share of alive fight-seconds with 3+ orders in which walking moved the pawn under 60 units net. It counts orders, so slow thinking or a dead band lowers it by construction. It is kept for comparison with the baseline; reversals are primary |
| idle | Share of seconds without walking |
| click-flip | Share of consecutive move orders within 0.5 s aimed more than 120° apart. Also reported as flips/s, because the share falls whenever same-direction clicks are many |
| short-click | Share of move orders aimed under 120 units away |
| move-order gaps | p10, p50 and p90 |
| think gaps (bots only) | p10, p50, p90 and the mean |
| same-tick ratio (bots only) | The chance that bot B decides on a tick when bot A of the same tier does, divided by B's chance on any tick. 1 is chance; 3.0 is today's lockstep at 30 Hz |

Where it lives:

- **`src/bots/motion.test.ts`, ungated.** Crafted tracks pin each definition to its intent: a
  straight walk has no reversals and a stop-turn-go has one, a ping-pong second is dither, a
  reversal under a bolt is threatened rather than free, and two seeds give two phases rather than
  lockstep. Each test runs well under a second.
- **The same file, behind `LADDER=1`.** It replays seeded matches, so it is gated like the
  ladder: four 4-player FFA matches (Medium, Hard, Brutal and Uber, seats rotated, ten minutes
  each) and one menu-backdrop match, about 4 s. It checks each tier against the thresholds, collecting
  per-tick conditions and asserting once.
- **`scripts/bots/motion.ts`** runs those scenarios with `--params`, as `elo.ts` does.
- **`scripts/bots/replay-motion.ts`** promotes the research tool onto the shared meter. It reads
  every `.brawlock` file in a folder, groups by player and calls out the top-rated human
  (`--reference <name>`). It writes `docs/research/human-motion-<date>.json`, which the test reads
  as `ladder.test.ts` reads its calibration. **Build lock:** a replay re-simulates only on the
  build matching its netcode id. The script finds that commit by running `scripts/net-id.mjs` over
  `git archive` of release tags first, then other commits, and extracts its `src` into a
  temporary folder (or a detached `git worktree` it removes afterwards). Without that build it
  reports orders/s and order gaps straight from the recorded input steps, which need no
  positions, and marks the rest missing.

Thresholds, provisional while the sample is three humans. The human tops are from
`docs/research/human-motion-2026-10-29.json` (the shared meter over the five replays; the test
checks that each upper gate sits at or above them):

| Measure (per tier, 4-player FFA) | Gate | From |
|---|---|---|
| reversals/s | ≤ 0.35 | top of BeFlat and Laub (0.32, 0.33) |
| free reversals/s | ≤ 0.12 until humans are split | the dance itself (single human matches reach 0.15–0.20) |
| dither | ≤ 0.09 | top of BeFlat and Laub (0.088, 0.075; the research tool rounded BeFlat's to 0.08) |
| orders/s | ≤ 6 | top of the strong humans (5.8) |
| flips/s | ≤ 0.35 | top of BeFlat and Laub (0.25, 0.31); replaces the click-flip share (open question 3) |
| move-order gaps (tiers thinking every 0.15 s or faster) | p10 ≥ 0.06 s, p50 0.08–0.20 s, p90 0.25–0.60 s | strong-human ranges, widened a little; Medium clicks like a slow player (p50 0.37 s, as POPE's 0.27–0.75) |
| same-tick ratio (menu backdrop: four bots per tier) | ≤ 1.2 | chance is 1 |
| menu backdrop | free reversals ≤ 0.12, dither ≤ 0.10 | the first screen; eight strong bots fire more than any human match |

From ten humans on, each upper gate becomes the p90 of the humans rated above the Medium label
(per-match values pooled). The order gates then use the humans' p10–p90 band, and the JSON records
which rule produced each number.

## Calibration

The prototype's probes, small on purpose: seeds 1–40 and 41–80, 40 matches per line, about ±4
points of rounds per line.

| Configuration | Uber over preset Brutal (rounds) | Notes |
|---|---|---|
| Today | 72% / 73% | |
| Rules 1–6 | 72% / 72% | Uber vs preset Uber 43% (about −45 Elo) |
| Rules 1–7 | 72% / 70% | Uber vs preset Uber 46%; Hard vs preset Hard 49% |
| All rules (final) | 61% / 68% | Uber vs preset Uber 43%, Hard vs preset Hard 48% (near-final set: re-click 0.18 s, no release gap) |
| Random phase alone | 68% / 68% | |
| Think spread alone, σ 0.4 / σ 0.6 | 70%, 74% / 67%, 66% | |
| Delay spread alone, σ 0.25, same mean | 77% / 79% | the bot gets *stronger* |

With every tier on the final rules, the steps hold among themselves: Uber over Brutal 67% of
rounds (today 72%), Brutal over Hard 78% (today 77%). On an earlier set (σ 0.6, re-click 0.18 s),
Medium on the rules beat preset Easy 97% and took 41% against preset Medium, and Hard on the rules
beat preset Medium 97%. Easy on the rules was not probed.

The motor rules cost little or nothing. The timing noise costs 0 to 60 Elo, and it is not neutral
in either direction. Think spread hurts: a bot that is usually just in time for a close Fireball
is sometimes one think late. A skewed delay with the same mean helps. "Same mean, same strength"
does not hold here, so each part is verified on its own.

1. **Probes while tuning.** `npm run bots:elo -- --params motion.json --tiers ... --games 40`,
   paired against today's preset (knobs at 0) and against the neighbouring new tier.
2. **The ladder.** `LADDER=1 npx vitest run src/bots/ladder.test.ts` at 30 Hz and with
   `TICK_HZ=60`, since timing changed. Top steps stay at 60–88% of rounds, beginner steps at 90% or
   more.
3. **Old against new.** A 200-match gauntlet per tier against its old self (`--params` with the
   knobs at 0, `--vs`). It shows the shift on the scale humans are rated on, which bot-only Elo
   anchored at Medium cannot show.
4. **Acceptable movement.** Up to 50 Elo per tier against its old self needs no compensation; the
   developer accepted a shift ("maybe we have to be open to allow that"). Beyond that, compensate
   in the timing first (a shorter mean think for the tier, or a smaller `thinkSigma`), never by
   dropping motor rules, and probe again.
5. **Labels only if they moved.** The developer, 2026-10-29: "why do we need to relabel
   anything?" Mostly we do not. `BOT_ELO` (presets.ts 421-427) feeds two things: the lobby hint
   "about 1825 Elo" (`Lobby.tsx`) and the spectator-bet odds for bots (`SpectatorBets.tsx`). Human
   ratings never use it: bots never count on the leaderboard (`src/net/leaderboard.ts`, header),
   whose starting 1000 is only named after Medium. The scale is anchored at Medium and every tier
   from Medium up gets the motor model, so a shared shift leaves the numbers where they are. Run
   `npm run bots:elo -- --games 400 --out docs/research/bot-calibration-<date>-motion.json` once
   as the check. Update `BOT_ELO`, the JSON import and comments in `ladder.test.ts` and the PLAN
   §7 table only if a tier moved by more than the ±50 its label already carries.

## Out of scope

- **Decisions**: aim, targeting, casting, shopping, Teleport and Shield use. Any compensation
  through decisions is a separate, measured change.
- **The sim's walking model** (turn rate, facing tolerance) and human input.
- **The automation detector** (Part B's second use). This spec only ships the meter it will use.
- **Other bot work**: skill fit, personas, team coordination, server-only presets, and the menu
  stage's composition.

## Acceptance

1. **The gated motion test passes on every active tier.** The prototype for Hard, Brutal and Uber
   in 4-player FFA (today in brackets):

   | Measure | Prototype (today) | Gate |
   |---|---|---|
   | orders/s | 4.0–4.3 (8.7) | ≤ 6 |
   | reversals/s | 0.26–0.32 (1.19–1.31) | ≤ 0.35 |
   | free reversals/s | 0.07–0.08 (0.67–0.74) | ≤ 0.12 |
   | dither | 0.06–0.07 (0.14–0.16) | ≤ 0.08 |
   | click-flip | 0.08 (0.17–0.18) | ≤ 0.07: **not met yet** (open question 3) |
   | move-order gaps p10 / p50 / p90 (s) | 0.03–0.07 / 0.17 / 0.40–0.43 | p10 ≥ 0.06: **not met for Hard** |
   | same-tick ratio | 1.00 (3.00) | ≤ 1.2 |

   Hard misses the p10 gate because urgent orders still land a tick apart; counting a dodge as
   urgent only when the hit is within 0.5 s addresses that. Medium on the rules: reversals 0.16
   (0.65), click-flip 0.11 (0.37).
2. **Unit tests show rules 8–10.** A faked windup is followed by at least 0.2 s of the dodge. A
   pillar approach keeps one side. A crowded hill does not flip between go and wait within 2 s.
   No bot walks into the sealed field.
3. **The ladder passes** at 30 and 60 Hz; the calibration is rerun and the labels updated.
4. **The existing bot suites pass**, with two changes. `scheduled.test.ts:10-25` changes from
   "the two whole ticks around the mean" to "within the delay distribution's floor and cap, never
   before an earlier decision", and `bots.test.ts:81-93` keeps the preset means and adds the 0.1 s
   floor. Decision tests (dodges, saves, Scourge, cover) pass unchanged.
5. **`npm run lint:invariants` and `npm run typecheck` pass.**
6. **Look and feel.** A visual check of the menu backdrop in a muted headless browser, then one
   playtest evening against Hard and Brutal: do the bots still feel as dangerous, and do they look
   like players?

## Open questions for the developer

1. **Strength.** Answered 2026-10-29: up to about 50 Elo per tier against its old self is
   accepted; no relabel unless the check moves a label beyond its ±50 (Calibration, step 5).
2. **Easy.** Built as recommended (README Q12): Easy keeps the original's movement; it is
   already calm (reversals 0.19 a second).
3. **Click-flip.** Built as recommended (README Q13): the gate is flips per second, now that the
   replay script reports it.
4. **Anchor.** Medium = 1000 stays. Human ratings do not depend on bots, so the anchor only names
   the lobby hints and bet odds.
5. **More replays.** The gates stay provisional until ten or more humans across skill levels
   (including duels and the hill) are in. Can regular players be asked for exports?
6. **Cheat risk.** Keystone 3's tension stands: the more human the bots move, the better the
   shipped Uber works as a cheat. This spec does not change where the strongest settings live.

## Rollout

1. **The meter first.** `src/bots/motion.ts`, the ungated tests, `scripts/bots/motion.ts` and the
   promoted replay script. Record today's bot numbers and the human JSON; behaviour is unchanged.
2. **Motor rules 1–10** behind their knobs, enabled per tier. Run the bot suites, the ladder at
   both rates, and probes.
3. **Timing noise (rule 11)** as its own step, because its Elo effect differs from the rules'.
   Probe each part.
4. **The calibration check** (labels only if they moved), updating in the same change PLAN §7 (the "Not built: an
   action-rate cap" line), the presets header table, Keystone 3 Part A (to point here) and the
   calibration JSON.
5. **Visual check and playtest, then a release.** Dedicated servers run the bots in casual and
   ranked rooms, and the browser runs them in solo, P2P-hosted games and the menu backdrop, so
   both carry the change. There is no netcode change: old and new clients still play together and
   replays still play.

## Built (2026-10-29)

Rules 1–11 are in `src/bots/controller.ts` behind the knobs in `src/bots/presets.ts` (the
`MOTOR` set for Medium and up; Brutal and Uber add `standoffStep`, Hard and up `threatInertia`;
every knob 0 in `ORIGINAL`, so Easy and `--params` ablations keep the old behaviour). The meter is
`src/bots/motion.ts`; `npm run bots:motion` runs its scenarios; `scripts/bots/replay-motion.ts`
measures replays on the build that recorded them (found by netcode id over release tags, then
commits, with `git archive`) and wrote `docs/research/human-motion-2026-10-29.json`.
`src/bots/motion.test.ts` holds the crafted meter tests and, behind `LADDER=1`, the gated
scenarios (four 4-player FFA matches capped at ten minutes, one menu-backdrop match, about 4 s);
`src/bots/motor.test.ts` shows rules 8–11 with and without each.

Measured on the built version, 4-player FFA (`npm run bots:motion -- --matches 8`; today in
brackets):

| Tier | Orders/s | Reversals/s | Free | Dither | Flips/s | Idle | Gaps p10/p50/p90 (s) |
|---|---|---|---|---|---|---|---|
| Medium | 2.2 (2.4) | 0.19 (0.66) | 0.08 (0.38) | 0.03 (0.09) | 0.13 (0.66) | 0.20 (0.11) | 0.17/0.37/0.80 |
| Hard | 4.9 (8.7) | 0.29 (1.32) | 0.08 (0.75) | 0.08 (0.16) | 0.26 (1.25) | 0.15 (0.06) | 0.10/0.13/0.33 (0.07/0.10/0.13) |
| Brutal | 5.0 (8.7) | 0.33 (1.18) | 0.09 (0.67) | 0.08 (0.15) | 0.30 (1.18) | 0.11 (0.05) | 0.10/0.13/0.33 |
| Uber | 5.0 (8.7) | 0.34 (1.15) | 0.08 (0.65) | 0.08 (0.15) | 0.30 (1.17) | 0.10 (0.05) | 0.10/0.13/0.33 |

The menu backdrop (two matches): reversals 0.50 a second (today 1.02), free 0.08 (0.28), dither
0.09 (0.13), same-tick ratio 1.00 (3.00). What remains under fire is a sidestep and the walk back
once the bolt has passed (dodge to wander, 31–37% of reversals; wander to dodge, 22%), which
humans do too. Re-picking the goal after a dodge, preferring the walking side on a dodge, a longer
settle, a longer dodge hold and slower re-clicks were each probed and moved nothing.

Where the build differs from the rules above, and why:

- **Holding still ends after 2 s in FFA** (`HOLD_MAX_SECONDS`). FFA targeting counts standing still
  toward a "sitting duck" (full at 3 s), so with rule 1 alone the bots stood, became the easiest
  kill on the table and were mobbed: four or more bots on one in 13% of samples in 8-bot FFA,
  against 4% before. With the cap, 5–6% (the FFA test's limit is 15%).
- **The first decision comes at once**; the random phase starts with the second. Bots on lava or
  under fire at a fight's first tick react as before, and the phase still breaks the lockstep.
- **Rule 7's minimum gap delays an order** to 0.07 s after the previous release instead of dropping
  it, so a wander order is late by a tick or two, never lost.
- **Two bugs the rules exposed, fixed for every tier.** A bot that had fled a charging Scourge
  walked back through the blast to a goal on its far side: only the goal was checked, now the walk
  is (`crossesAny`). And with hill decisions, a goal picked in the shop or across the sealed hill
  walked into the field: the whole walk is checked, and in the shop the next fight's hill counts as
  sealed.

**Calibration.** Each tier against its old self (the knobs at 0), 200 matches, rounds won by the
old self: Medium 50% (±0 Elo), Hard 57% (−48), Uber 56% (−41), Brutal 61% (−76). Brutal was over
the accepted 50, so its think interval went from 0.1 to 0.08 s (timing first, as above): 55%
(−35). Faster thinking did not help Uber (0.08 s: 56%), which is inside the 50 anyway. The full
`npm run bots:elo -- --games 400` afterwards (`docs/research/bot-calibration-2026-10-29-motion.json`):
Easy 383, Medium 1000, Hard 1834, Brutal 2055, Uber 2179. Every label holds within its ±50
(350, 1000, 1825, 2025, 2225), so `BOT_ELO` and the ladder's calibration import stay. Steps: Brutal
over Hard 78% of rounds (was 76%), Uber over Brutal 67% (was 75%); the ladder test passes at 30 and
60 Hz.

**Tests changed, as acceptance item 4 expected.** The delay and Teleport-timing tests check the
delay distribution's bounds (`reactionDelayBounds`) instead of one tick. The Shield test "dodges
its own Fireball coming back" now counts over 20 runs: Hard is hit in at most 15% (3 of 40 in a
wider probe, 0 without the timing spread, when a slow reaction draw comes too late, as a person's
does); Brutal and Uber never.

**Visual check.** The menu backdrop in a muted headless browser: the eight bots spread out and
fight, no console errors. Stills cannot show the dance; the meter does. The playtest evening is
still to come.

**Idle, a new finding.** Humans stand still in 1–3% of their fight-seconds (BeFlat 0.7–3.3%);
the built bots in 10–20% (today 5–6%, because "stay" was a walk back). Idle is not gated. If the
playtest finds the standing bots stiff, the next step is to turn holding into small strafes.

