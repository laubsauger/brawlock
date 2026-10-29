# Daily: a named day, five waves, one board

Status: design draft, 2026-10-28; the format and the rewards answered 2026-10-29 (the Gauntlet,
Embers with a seven-day streak). The other choices (end of file) keep their recommendations until
answered. From [03-moonshot-v2.md](../03-moonshot-v2.md) Bets 3, 4 and 6 and
[04-keystones.md](../04-keystones.md) Keystone 3.

The developer, 2026-10-28: "Solo is a brilliant idea too. I do love that. Especially if it can add
some daily special taste to it in some way, that would be fun."

## Why

- **There is often nobody to play with.** A daily gives a solo player something shared anyway:
  everyone plays the same day at their own time and meets on one board. It passes the five
  population-elastic tests (03 §1): it works alone, each extra player improves the board, it costs
  milliseconds of server CPU per run, it measures itself, and every opponent is a labelled bot.
- **A reason to return that is not the next season** (frontier §1): a day with a name, a champion
  and a streak to keep, on the days nobody is online.
- **The pieces exist.** The guided lesson runs a private match from an edited state
  (`src/game/practiceScenario.ts:18`), bots are deterministic from a seed, and a scratch harness
  confirmed that a server can re-create a run from the human seat's commands alone.

## The daily taste

### Six formats

| Format | The challenge | Score | Reuses | Cost and risk |
|---|---|---|---|---|
| **The Gauntlet** | Five seeded waves of bots on a small arena, the day's champion last; two lives, a shop between waves | Waves cleared, then time | Practice director, teams, bots with fixed builds, the shop, the ranked final's arena | A director and a HUD. Bots in a team gang up on you (measured: fine) |
| **Champion's Duel** | First to 3 against the day's champion | Rounds won, then time | A plain 1v1 offline match | Cheapest, but a beginner (about 350 Elo) wins no round against Hard (1825), and four possible scores tie the board |
| **Trial of the Day** | A hand-made puzzle: knock out three dummies with one Lightning-detonated Fireball; Swap a dummy into a pillar blast; Teleport out of a lethal slide | Time, then casts | The guided lesson's checker | A seed cannot make a good puzzle; each one is hand-authored. Better as Bet 6 Trials, with a daily pick once there are 20 or more |
| **Last Ring** | Survive while bots respawn around you | Seconds alive plus knockouts | Deathmatch respawns | Deathmatch arenas never shrink (`src/sim/mode.ts:198`), so it needs a new rule; survival scoring rewards hiding |
| **Hill Sprint** | King of the Hill against five bots, 25 tickets | Time | Hill mode as is | The hill's structure is its own work stream (03 §5.6); bots contesting make scores swing |
| **The Daily Brawl** | One ten-warlock FFA in the ranked format against nine named bots | Placement points | No new rules at all | Over 10 minutes, and a stray Meteor in a crowd decides more than skill does |

### What gives a day its taste

- **The champion.** One named bot per UTC weekday waits at wave 5 with a signature build from
  `src/bots/plan.ts` and wardrobe pieces: Keystone 3's persona in its smallest form (no memory or
  rivalry yet), and the start of its persona table.

  | UTC day | Champion | Tier | Build | Outfit | Line |
  |---|---|---|---|---|---|
  | Monday | Cinder the Patient | Hard | duelist | head-ram, emblem-flame | Walls with Shield and waits for you to get greedy. |
  | Tuesday | Rook, the Blink Thief | Hard | blink | head-crow, back-wings, staff-bone | Teleports in for the Scourge and out again. |
  | Wednesday | Mother Ash | Hard | artillery | head-candles, robe-emberveil, staff-gnarled | Meteors from afar; at her best in the last two rings. |
  | Thursday | Brother Thrum | Hard | brawler | head-demon, back-spikes, staff-iron | Thrust first. Questions never. |
  | Friday | Vesper | Hard | leech | head-crescent, back-crescent, emblem-moon | Swaps you into the lava and drinks the rest. |
  | Saturday | Old Hob | Hard | hunter | head-antlers, emblem-eye, staff-gnarled | Roots you with Grip, then sends the Homing bolt. |
  | Sunday | The Pyre Abbess | Brutal | drawn from the day | head-candles, back-wings, robe-emberveil, emblem-crown | Nobody has seen her build twice. |

- **The omen.** One rule for the whole run from a nine-omen deck, each an existing match option or
  an arena key below. Names match the Wild deck ([wild.md](wild.md)), so they mean the same thing.

  | Omen | Rule | Day name | Flavour |
  |---|---|---|---|
  | Clear Skies | none | Rook under Clear Skies | No omen today. Just you, the lava and five waves. |
  | Blood Moon | `kbMultiplier` 1.5 | Blood Moon over Rook | The moon is red and every push lands harder, yours and theirs. |
  | Slick Stone | `friction` 0.975 | Rook on Slick Stone | The tiles sweat. Every slide runs long. |
  | Hungry Lava | `lavaDps` 150 | Rook and the Hungry Lava | The lava bites half again as hard. Don't linger. |
  | Cold Lava | `lavaDps` 60 | Rook by Cold Lava | The lava has cooled. A second chance at the edge, for them too. |
  | Glass Bones | `dmgMultiplier` 1.5 | Rook and the Glass Bones | Every hit cuts deeper, and deeper cuts fly further. |
  | Lean Year | `startGold` 15, `roundGold` 6 | A Lean Year for Rook | Fifteen gold to start, six a round. Spend like it matters. |
  | Feast | `startGold` 80 | Rook's Feast | Eighty gold before the first wave. Build something ridiculous. |
  | Sudden Collapse | a ring every 4 s | Sudden Collapse with Rook | The floor gives way every four seconds. |

  Seven weekdays against nine omens: each weekday and omen pairing comes back once every 63 days.
- **The bounty.** One spell a day from Lightning, Homing, Boomerang, Twin, Bouncer, Cluster,
  Splitter, Snowball, Meteor and Thrust (never the same two days running). Each knockout it seals
  takes 3 s off your time, at most five times. It changes what you buy each day.
- **The name**: "Daily #12 · Blood Moon over Rook", with the omen's line and the champion's line.
- **The streak**: consecutive UTC days with at least one verified attempt. It shows as a flame and
  a count, beside a strip of the last seven days, each square filled by waves cleared.

### Recommendation: the Gauntlet

1. **It fits every skill level.** Bots of each tier stood in for the human: 16 seeds per tier,
   Clear Skies, two lives, Hard champion, 30 Hz, the arena below, 4 s shops (Ready pressed):

   | Stand-in | Runs clearing 0/1/2/3/4/5 waves | Median waves | Median run |
   |---|---|---|---|
   | Easy (about 350 Elo, where guided practice ends) | 3/13/0/0/0/0 | 1 | 2:37 |
   | Medium | 0/13/3/0/0/0 | 1 | 3:10 |
   | Hard | 0/1/3/5/2/5 | 3 | 4:59 |
   | Brutal | 0/0/2/5/3/6 | 4 | 4:59 |
   | Uber | 0/0/0/3/4/9 | 5 | 5:47 |

   Every omen keeps the spread (12 seeds each); Uber's median run spans 3:51 (Glass Bones) to 6:12
   (Cold Lava). Sunday's Brutal champion cuts full clears to 1 in 16 for Hard, 7 in 16 for Uber. The
   classic arena (layer `13 + warlocks`, 10 s rings, three lives) gave 7 to 12 minute runs. Bots are
   not people: this shows spread and length, not how hard a human will find it.
2. **It reuses the most**: a director like `PracticeScenario`, teams, `setPlayerConnected` to seat
   waves, the shop, bots with fixed builds, the ranked final's arena, the replay wire encoding.
3. **It is the solo core of Last Stand** (Bet 4): the same wave director takes co-op seats later.
4. **It verifies.** A Hard stand-in's recorded commands, re-simulated with fresh bots, gave an
   identical state hash in 6 of 6 runs; under another attempt salt the same tape cleared 0 waves.

## What the player sees

- **Main menu.** A Daily entry under the queues (the first entry in builds without servers):
  "Daily #12", gold subline "Blood Moon over Rook", note "5 waves · 2 lives · new day in 7 h 12 min",
  and a badge: "Day 5 of 7 · 75 Embers on day 7", "Play today to keep your 4-day streak", or
  "Best: Wave 4 · 3:12".
- **The Daily screen**, opened from the entry. The day's name and flavour; the omen's sigil and rule;
  the champion turning on the wardrobe stage (`src/render/WardrobeStage.tsx`) with build icons from
  the Spell library; the five waves ("Wave 3 · Soot (Medium) and Wick (Easy)"); the bounty spell;
  your week strip; Play. The board has Best, First try and Yesterday views; **Watch** on its top ten
  rows replays a run from the same build by re-simulating its tape with the client's own daily code.
  The first visit adds three lines of rules.
- **In the run.** A daily HUD: five wave pips (the fifth a crown), two lives as flames, a clock that
  runs only in fights, the bounty icon and count. A banner opens each fight ("Wave 3 · Soot and
  Wick"); the champion gets a name plate and an announcer line. The shop has a large Ready button and
  the next wave's preview. Escape opens the menu over a running fight, as online: Resume, Abandon.
- **The result.** "Wave 4 · 3:12.6" large; a pending state turns into "Verified · 4th of 11 today" or
  "New best"; the day's confirmed Embers ("+15 Embers · Day 5"); per-wave splits, bounty knockouts,
  the streak flame and week strip; Play again, Watch
  your run, Board, Share, Menu. Guests see "Sign in to post this run", the itch.io build "Scores post
  on brawlock.osc.link". After a full clear: "Tomorrow: Mother Ash" (the omen stays hidden).
- **Share** copies three lines for Discord or chat: `Brawlock Daily #12 · Blood Moon over Rook`,
  `■■■■□ Wave 4 · 3:12.6 · 4th of 11`, `brawlock.osc.link`.

## Rules

### The day

- `day = floor(utcMilliseconds / 86 400 000)`; `#n = day − LAUNCH_DAY + 1`;
  `seed = hashString('brawlock-daily:v1:' + day)` (`src/sim/snapshot.ts:53`).
- Champion by UTC weekday, `(day + 4) mod 7` with Sunday 0 (1970-01-01 was a Thursday). Omens: the
  deck is shuffled per nine-day cycle from `hashString('omen-cycle:' + cycle)`, so each omen
  appears once per cycle. A cycle that would open with the omen that closed the last one swaps its
  first two entries. Bounty: drawn from the seed, and redrawn while it equals yesterday's.
- Waves: 1 Easy; 2 Easy; Medium and Easy; 2 Medium; the champion. Each wave bot's build is
  `BUILD_IDS[hash(seed, seat) mod 6]` (`src/bots/plan.ts:234`), with its choices drawn from the
  day's stream. Names come from a pool (Ashling, Cinderkin, Soot, Wick, Clinker, Slag, Brand, Tallow).
- **The same for everyone that day**: the omen, champion, bounty and waves, every bot's build, the
  match seed (pillars, spawns) and the rules below. **Different per attempt**: the bots' dice (aim
  error, reaction jitter, persona), from an attempt salt the server issues (open question 5).

### The run

- Match: `teamMode 'teams'` (you on team 0, every bot on team 1), `winScore 5`, `shopSeconds 15`,
  `botsReplaceLeavers false`, `spectatorBets false`, `bounties false`. Otherwise the default economy
  (30 gold to start, 10 a round, 1 per kill, 2 per round won), unless the omen changes it. Always
  30 Hz (`DAILY_HZ`), whatever rate the process last ran.
- Seating: only the current wave's bots are connected; with `botsReplaceLeavers` off the others are
  inactive (`src/sim/teams.ts:51`). Benched bots still collect round gold (`endRound` pays every
  seat), so later waves arrive richer; the champion gets 80 more. Every bot thinks every tick, seated
  or not, so its random stream never depends on seating.
- Arena: the fight platform is layer `min(15, 9 + warlocks)`, with a ring every 6 s (4 s under
  Sudden Collapse). These are the ranked final's numbers (`src/sim/mode.ts:96`,
  `src/sim/config.ts:71`); a round is over within about 70 s.
- Shop: 15 s, or 1 s after you press Ready (bots are always ready). Ready travels in the tape as a
  director entry; if Keystone 1's `shopReady` command ships first, the daily uses it instead.
- Lives: two. A lost or drawn round costs one and the same wave fights again (same bots, builds,
  gold). The run ends at wave 5 cleared, the last life lost, or Abandon.
- No pause: a ranked attempt runs in real time like online play, stepping on in a hidden tab
  (`src/net/clock.ts`), unlike the lesson (`src/game/practice.ts:39`).

### Score and ranking

- `waves`: waves cleared, 0 to 5. `time`: fight seconds from the first fight's start to the round
  win that cleared the last cleared wave, lost fights included; shops and round ends are excluded.
  Subtract 3 s per bounty knockout up to that point (at most five), never going below 0. Shown as
  `m:ss.t`.
- A bounty knockout: a team-1 warlock dies, and the last damage event with knockback that you put
  on it in the 4 s before its death has `cause` equal to the bounty spell (Keystone 2's "sealing
  hit"). A lava death after your Lightning push counts; a later Fireball push replaces it.
- Rank: waves descending, then time ascending, then earlier verification. Abandoning is legal and
  scores what was achieved; it gains nothing over dying, because time stops at the last cleared wave.

### Attempts and the board

- Unlimited play. Up to 20 attempts per player per UTC day are ranked (per account, or per device
  for guests); later ones are unranked practice, and the Daily entry says so.
- **Best**: each player's best verified attempt. **First try**: each player's first attempt token of
  the day; one never submitted counts as wave 0, so throwing away bad starts does not help.
  **Yesterday**: the previous day's final board.
- The board lists only accounts with a claimed player name: the top 50 and your own row, each with
  an attempt count. Rows from an earlier build of the same day carry a small build mark. A day's
  board closes at 00:30 UTC the next day. Later submissions get 410 and stay local as practice.

### Edge cases

- **UTC rollover.** An attempt belongs to its token's day; tokens are issued until 23:59:59.999.
  The countdown uses the server's clock (`serverNow`), with the reset also in local time. An open
  Daily screen switches days with a banner; a run in progress keeps its day ("Yesterday's daily").
- **Retries** ask for a new token, each valid for 60 minutes and one day's board. A **closed tab or
  crash** leaves its attempt unsubmitted: it expires as wave 0 and counts toward the cap.
- **Disconnects.** The run is local and continues. If the play permission lapses (local sims stop at
  its deadline, [ACCOUNTS.md](../../ACCOUNTS.md) "One active game"), the attempt ends there as
  abandoned. Its tape waits in IndexedDB, retried with backoff until the token expires or the board
  closes.
- **Guests** are verified and told their rank ("would place 4th of 11") but never listed; their
  streak lives in the browser. **Sign in to post this run** claims today's best guest attempt: same
  device, once per attempt, before the board closes. An account without a player name is a guest.
- **itch.io embed**: guest only, CORS without cookies like `/api/play` ([ITCH.md](../../ITCH.md)).
  It plays, verifies and reads the board but cannot claim; its storage is a separate guest.
- **Offline**: builds without accounts or a site (local development) take the day from the local
  clock and a local salt, labelled "Offline · not on the board". If the daily service is unreachable
  or does not know this build (409 `update`), Play becomes "Play unranked": same day, local salt.
- **One game at a time**: the daily takes the browser's game slot (Web Lock and `/api/play`), as
  guided practice does. **Outage days**: a UTC day on which the service issued no token to anyone
  does not break streaks.

### Rewards and the streak

The developer, 2026-10-29: "daily reward sounds good, with a little carrot to come back and get
7 day streaks or something."

- **The day's reward.** The first verified attempt of the UTC day pays **15 Embers**, once per
  account, if it has 30 s of fighting and five casts (an idle run earns nothing). Score and rank do
  not change it: the reward is for showing up, the board is for skill.
- **The seventh day.** Every seventh day of a streak (day 7, 14, 21 and so on) pays **75 Embers**
  instead of 15. A full week is 6 × 15 + 75 = 165 Embers, about one mid-priced piece (the catalog
  runs 50 to 220), beside about 25 per casual match.
- **The streak** is as defined above: consecutive UTC days with a verified attempt. **One grace
  day a week**: a single missed day keeps the streak when the last grace was at least 7 days
  earlier. The missed day does not count, and the flame shows smouldering ("Your streak survived a
  missed day"). A second miss inside those 7 days resets it. Outage days never break a streak.
  Reason: losing a six-day streak to one missed evening is when people quit, not come back.
- **Accounts only for Embers.** A guest's streak lives in the browser and shows the same strip, but
  pays nothing. Signing in claims today's attempt, so today counts for the account; earlier guest
  days do not.
- **Where it shows.** The menu badge ("Day 5 of 7 · 75 Embers on day 7"); the week strip, whose
  seventh square carries an ember mark and "75"; the result, where `EmberReward` presents the
  confirmed reward ("+15 Embers · Day 5"). Never an optimistic credit before the server confirms.
- **Server.** Policy 2 adds the queue `daily`. Verification, in the same process as
  `createProgression().recordMatch` (`server/progression.mjs:165`), writes the receipt
  `daily:<day>:<accountId>` with a base of 15 or 75. The streak and its grace come from the daily
  rows (kept 400 days). The reward is decided once, at the day's first verified attempt; a
  resubmit returns the stored one. [PROGRESSION.md](../../PROGRESSION.md) documents the queue in
  the same change.
- **Later, its own small step: a streak badge.** A first seven-day streak unlocks an emblem that is
  not for sale. It needs a catalog entry with an unlock rule instead of a price
  (`src/game/progressionCatalog.ts`, where every item has a price today) and its art, so the
  Embers ship without it.

### What verification proves, and its limits

- **Proved**: waves and time come from the sim, the day's setup and the issued salt for exactly
  these commands. A score the client claims never counts; it only exposes mismatches.
- **Rejected**: a tape that is malformed, over 600 s of sim, over 16 commands in a tick or 20,000 in
  total, or over 96 KiB compressed or 1 MiB inflated. A token that is unknown, expired, not the
  caller's, or for a closed day. A daily id with no verifier. A run faster than real time: wall time
  from token to submission under sim time minus 2 s.
- **Flagged, never auto-rejected**: a claimed result that differs; over 8 orders a second across the
  run (strong humans issue 4 to 6, Keystone 3); a submission over 15 minutes later than real time.
  Flags show in a Daily tab of the operations dashboard, where the operator can hide a row.
- **Not stopped**: a bot or script playing through a real client in real time, the netcode's open
  cheat everywhere. Detection is Keystone 3 Part B's job; its detector reads tapes like matches.

## Design

### Files and seams

- `src/game/daily/calendar.ts`: `dayOf`, `dailyNumber`, `defineDay(day)`. Tables are append-only,
  and any change carries a `from` day.
- `src/game/daily/run.ts`: `DailyRun`, the director, modeled on `PracticeScenario`
  (`src/game/practiceScenario.ts:18-111`): `createMatch` (`src/sim/index.ts:108`), waves seated with
  `setPlayerConnected` (`:150`), `new BotController(id, tier, seed ^ salt, params)`
  (`src/bots/controller.ts:269`) with its public `build` (`:260`) replaced by `drawBuild` from the
  day's stream (`src/bots/plan.ts:240`). `tick(cmds, ready)` drops `spectateBet`, steps, scores.
- `src/game/daily/tape.ts`: seat-0 commands as `[tickDelta, ...wire]` through `encodeCmd` and
  `decodeCmd` (`src/net/stream.ts:68`, `:81`) plus Ready entries, gzipped like replay files.
- `src/game/daily/verify.ts`: `verify({day, salt, tape})`, the verifier bundle's entry, and
  `simulate`, which turns a tape into `ReplayData` for Watch.
- `src/game/daily/play.ts`: `startPractice`'s loop (`src/game/practice.ts:20`) without the pause
  branch; `setTickRate(30)` first (a client keeps its last room's rate, `src/net/session.ts:1862`);
  records the tape and a library replay (`src/game/replay/recorder.ts`). Plus `client.ts`
  (endpoints, IndexedDB queue) and `store.ts` (zustand, narrow selectors).
- UI: a `MenuEntry` (`src/ui/screens/MainMenu.tsx:41`) after `QueueEntries` (`:473`);
  `src/ui/screens/Daily.tsx`, `DailyResult.tsx`, `src/ui/hud/DailyHud.tsx` (clock via refs in rAF).
- Sim, the only change: optional `MatchSettings` keys `arenaBase` (default 13), `arenaCap` (21) and
  `shrinkSeconds` (10), read in `shrinkPeriod` and the fight layer (`src/sim/mode.ts:85`, `:219`);
  absent, nothing changes. Brisk casual ([faster-casual.md](faster-casual.md)) defines the same keys
  plus `scheduledRounds`; whichever ships first adds them.

### The daily id and mid-day releases

- `__NET_ID__` hashes `src/sim`, `src/net` and the cosmetics catalog (`scripts/net-id.mjs:21`), not
  bots: hosts stream bot inputs and replays record them. The verifier re-creates bot inputs, so a new
  `dailyId(root)` hashes `src/sim`, `src/bots`, the pure `src/game/daily` modules and
  `src/net/stream.ts` (a new hat leaves it alone). `vite.config.ts:78` defines `__DAILY_ID__`.
- `scripts/build-daily.mjs` bundles `verify.ts` with esbuild into `dist-daily/<dailyId>.mjs`. The
  account service keeps the newest five in `/opt/apps/brawlock-accounts/daily/` and loads each lazily
  in a `worker_threads` worker; uploading one needs no restart.
- **A release mid-day loses nothing**: each run verifies with its own build's bundle, and both builds
  share the day's board. The calendar's golden test keeps the day itself fixed; rows note the build.
  Verifying only with the live code would drop runs in flight during a release (question 7).

### Endpoints (account service)

The US account service, not a region, already has the session cookie, guest device binding, embed
CORS, the dashboard and the Embers database. `server/daily.mjs` mounts beside chat
(`server/accounts-main.mjs:70-74`): same-origin, `no-store`, exact Origin and JSON for writes, embed
CORS without cookies as `/api/play` (`server/accounts.mjs:155`); the body limit (`:83`) rises to
160 KiB for submissions only.

| Route | Does |
|---|---|
| `GET /api/daily?day=` | Day summary, `serverNow`, `closesAt`, accepted daily ids, board (`view=best\|first`, top 50, player count), and `you` (best, first, attempts, streak, last 7 days) from the session or guest device |
| `POST /api/daily/attempt` | `{day, dailyId, device}` → `{attempt, salt, issuedAt, expiresAt}`; 409 `update` or `day`; 429 `cap` or `rate` (one token per 20 s per player, 60 an hour per address) |
| `POST /api/daily/submit` | `{attempt, tape, claimed}` → `{status: 'verified', waves, time, rank, players, best, streak}`, 422 with a reason, or 503 `busy` with retry-after. Resubmitting the same tape returns the stored result; a different tape gets 409 |
| `POST /api/daily/claim` | `{attempt}` with a session: attaches a verified guest attempt from this device |
| `GET /api/daily/run/:attempt` | `{day, dailyId, salt, tape}` for top-10 rows of today and yesterday (Watch) |
| `/api/admin/daily/*` | Flags and hide, through the existing admin handler |

One worker job at a time, a queue of 32, 2 s per job; a full harness run took under 0.1 s on a laptop.

### Storage

`AUTH_DATA_DIR/daily.sqlite`, a separate WAL file like `chat.sqlite` (no account schema version):

```
daily_attempt(id TEXT PRIMARY KEY, day INTEGER, daily_id TEXT, salt INTEGER, account_id TEXT,
  device TEXT NOT NULL, ordinal INTEGER, issued_at INTEGER, submitted_at INTEGER,
  status TEXT CHECK(status IN ('open','verified','rejected','expired')), reason TEXT,
  waves INTEGER, time_ticks INTEGER, bounty INTEGER, end_tick INTEGER, tape BLOB,
  flags TEXT, hidden INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER)
-- indexes: (day, status, waves DESC, time_ticks), (day, account_id), (day, device)
```

`account_id` is checked on write (no foreign key across files). Tapes stay 14 days for top-10 rows
and each player's best, otherwise go at board close; rows stay 400 days for streaks.

### Tests

- `calendar.test.ts`: the 23:59:59.999 and 00:00 UTC boundaries, the weekday mapping, each omen once
  per cycle with no repeat across cycles, and no bounty two days running. A golden table of 21 days
  fails when a started day's definition changes.
- `run.test.ts`: only the wave's bots alive in a fight; a loss repeats the wave; a draw costs a life;
  Ready ends the shop within 1 s; the end conditions. Crafted events: a lava death 3 s after a bounty
  push counts, a later push with another spell cancels it, shops add no time.
- `verify.test.ts`: an Easy stand-in plays one short wave, and its tape re-verifies identically;
  one changed command or another salt changes the result; oversized, overlong and malformed tapes
  are rejected. Each test stops early to stay under 2 s. `daily.lint.test.ts` (the
  `mathGuard.lint.test.ts` pattern): the pure daily modules import only `src/sim`, `src/bots` and
  `src/net/stream.ts`, and never `Date`, `Math.random` or `performance`.
- `src/net/daily.test.ts` (server): caps, rate limits, expiry, the faster-than-real-time rejection,
  idempotent and conflicting resubmits, closing at 00:30 UTC, unlisted guests, a claim working once,
  409 for a missing verifier, hidden rows, and streaks across gaps and outage days. Rewards: 15
  once per account per day, 75 on days 7 and 14 of a streak, one grace day per 7 days and a reset
  on a second miss, nothing for guests or idle runs, a resubmit paying nothing twice.
- UI markup tests read `data-testid` and `data-state` only: `daily-play` (`fresh`, `played`,
  `unranked`, `offline`), `daily-result` (`pending`, `verified`, `rejected`, `unranked`),
  `daily-ready`. Arena keys: sim suites at 30 and 60 Hz and `npm run lint:invariants`; defaults are
  unchanged, so no ladder run.

## Out of scope

The other five formats; Trials; co-op or Last Stand waves; the streak badge (a later step, see
Rewards); boards older than yesterday; friends or regional boards; racing the leader's
ghost inside your run; persona memory and rivalry; Wild's rule omens (Meteor Shower, The Maw) before
Wild exists; notifications or a Discord bot that posts the day.

## Acceptance

1. Two browsers with different local clocks show the same day, and both switch at 00:00 UTC.
2. A human run from the menu entry to the result shows a verified rank within 2 s of the end.
3. A recorded tape re-verifies to the same score, and gives a different one under another salt.
4. A run recorded on build A verifies after the service gains build B, on the same day's board.
5. A guest plays, sees a rank, signs in and claims, and the row appears once.
6. The itch.io build plays and reads the board; a local build without accounts plays offline.
7. The board closes at 00:30 UTC, and yesterday's final board stays readable.
8. The harness ([research/gauntlet-experiment.ts](../research/gauntlet-experiment.ts); the
   verification check is [research/verify-experiment.ts](../research/verify-experiment.ts)) shows every omen keeping the spread and runs
   of 2 to 7 minutes.
9. The dashboard shows daily players, attempts per player, finish share, streaks and 1- and 7-day
   return. **Keep** it if after four weeks 30% of finishers come back for another day within 7 days.

## Open questions for the developer

1. **Format**: answered 2026-10-29, the Gauntlet.
2. **Attempts**: unlimited, with Best and First try views (recommended), or one ranked attempt a day?
3. **Embers**: answered 2026-10-29, yes with a streak (Rewards). Open: the amounts (15 a day, 75 on
   the seventh) and the grace day.
4. **Guests on the board**: accounts only (recommended: no throwaway names), or guests with a mark?
5. **Dice**: a salt per attempt (recommended: precomputed tapes do not transfer), or identical dice
   for everyone (the purest daily, but routable and precomputable offline)?
6. **Champions**: the seven names and outfits, and a Brutal Sunday?
7. **Mid-day releases**: verifier bundles per daily id (recommended), or the live code only, dropping
   runs in flight during a release?
8. **The small arena**: add the three arena keys now, shared with Brisk?

## Rollout (one release batch, only on the developer's yes)

1. Build the sim keys, daily modules, routes and UI with focused tests; move the harness into the
   research folder; in the same change update [ITCH.md](../../ITCH.md), [ACCOUNTS.md](../../ACCOUNTS.md)
   and [PLAN §2](../../PLAN.md) (the daily's arena as a mode rule).
2. Locally with the accounts dev setup: account and guest runs, a claim, the service killed mid-run,
   two verifier files on one day.
3. One release: the sim keys move the netcode id, so the account service (routes, `daily.sqlite`,
   verifier folder), both regions and the client ship together; then itch.io with the `v*` tag.
4. On production: an account run, a guest run and claim, an itch run, all in the Daily tab.
5. Watch the numbers for four weeks, then keep, retune (waves, omens) or cut.
