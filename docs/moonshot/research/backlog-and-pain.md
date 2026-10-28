# Backlog, pain points and design tensions

Research input for the 12-month moonshot vision. Written 2026-10-28, day 13 of the project, against
main at `e075b1d` plus the uncommitted working tree (hill force field, global chat).

**Sources.** `docs/NEXT-SPRINT.md` (including its git history), `docs/PLAN.md`, every other
`docs/*.md`, `docs/research/systems.md`, `spells.md` and `tech.md`, `release-notes.json`,
`deploy/releases/*.md`, all 243 commit messages with bodies, the bot code where a claim needed it
(`src/bots/controller.ts`, `presets.ts`), queue presets in `src/net/server.ts`, and one local
analytics snapshot already on disk (`artifacts/analytics/report.json`, generated 2026-10-20; no
collector was run). Commits are cited as `hash (date)`.

**Evidence quality.** Almost all "player" feedback is the developer's own playtests with a few
friends, plus bot-only measurements. The docs contain no external reviews, no retention metrics
and only one population snapshot. Treat what follows as what the team noticed, not as market data.

---

## 0. Top ten, ranked

1. **King of the Hill does not produce holds, and timer tuning cannot fix it.** Capture time
   changed five times in about 48 hours (none, 3 s, 1.75 s, 1 s, 0.5 s). Bot-only matches run
   46–90 minutes, and the hill is contested 62% of fight time.
2. **Matches are long and fights end late.** Casual first-to-3 averaged about 28 minutes, and
   "a real match took far too long" in KotH. Hard bots first kill after about 107 s, and 83% of
   deaths happen after about 11 layers of shrink.
3. **The population is tiny and bots carry every queue.** Peak online was 7 on 2026-10-19,
   casual rooms ran about 9 bots per human, and ranked had 2 unique players. Ranked needs two
   humans.
4. **Bot difficulty swings and no single table fits.** The casual table was Brutal, then Medium,
   then a Hard mix, then Medium/Hard, all in 8 days. Ladder labels moved by up to 275 Elo, and
   bots are not matched to player skill.
5. **Bots are tuned for win rate, not for reading as human.** They "dance on the spot" (user).
   Plausibility is defined only by reaction delay and aim error. No metric covers movement.
6. **There is no combat or shop music.** Synth music has been off since 2026-10-20, so a fight
   plays only SFX and lava ambience. The soundtrack is item 1 of the engineering backlog.
7. **Faithful v1 vs fixing the original keeps reopening.** The deviation list keeps growing
   (Fresh start, shorter matches, kill gold, Lightning scaling), while the stated tie-breaker
   is "closest to the original". There is no written test for when v1 "feels right".
8. **Server capacity sits below the hardware limit.** Player rooms stall near 24 per 2-vCPU
   host while it is half idle. The shards branch is unmerged, and sparse bot rooms are the
   costliest case per human, which is exactly the low-population case.
9. **Identity and community surfaces are split or missing.** itch.io players are guests only,
   and the wardrobe needs an account. There is no confirmed social or community channel, and
   global chat is unfinished and for signed-in players only.
10. **Release pace vs the "calm, batched" rule.** There were 16 alphas in 8 days and four
    releases on 2026-10-25. The full suite was skipped twice by user call, and docs drift from
    shipped behaviour.

---

## 1. What players and playtests reacted to

### 1.1 First live deploys (2026-10-15 to 10-19)

- Whiteout: "Shield's dome clips to a blinding white ball without bloom, which is the whiteout
  players saw when bots cast it". Shield was pulled from the shop until fixed (`79f51d0`, 10-15).
- First playtest fixes: the Lightning bolt was missing on misses, the shop spawned players in lava
  with 5+ players, and tiles went white on shrink (`0480443`, 10-16).
- Scourge level 1 effect and sound were "too much" (user, memory `showcase-and-look-prefs`). This
  led to the rule that L1 stays tame and the full intensity waits for higher levels.
- Original match length: "11 dragged on, an 8-player FFA can run 40+ rounds"; the 30 s shop "felt
  long between rounds" (PLAN §2, `src/sim/config.ts`, `57adf19` 10-16).
- Lava audio: "Standing in lava fired the loudest one-shot in the game every 0.22 s" (`160568b`).
- Ranked Elo: "a match winner who was knocked out by bots before the other human ... lost rating
  to a player with no round win (2026-10-19 report)" (`4098210`).
- Onboarding: the user "supplied follow-up feedback on onboarding clarity" after the account
  release (`deploy/releases/2026-10-19-accounts.md`), which led to guided practice.

### 1.2 Bot difficulty in casual

- "Fill new quick games with Brutal bots" (`a0ae2e0`, 10-18).
- "Brutal bots made casual tables too punishing", so the table went to Medium (`8ca9d70`, 10-19).
- The same day it went to Hard with one Brutal and one Medium, released as "Sharper opponents"
  (`58858ed`).
- "All-Hard felt too tough for casual", so five Medium seats fill first and the rest are Hard
  (`c3d6465`, 10-26).

### 1.3 Presentation and flow

- Announcer: "The Arena Shrinks!" "repeated each round and wore thin" (`d6ae55a`). "Round Won!"
  was heard as "Round One!" (`c60b1cc`). "Denied!" "still fired on most lava blinks" and needed
  four fixes (`dd2332e`, `d579a3c`, `e004123`, 10-22..24). The first round-win set "read as
  earnest" (`608b943`), and "Last Warlock Standing!" played over two corpses (`521c320`).
- Synth shop music "reads as placeholder music" (`c5c9b98`, 10-20), so all in-match music is
  now off.
- SFX review: 20 of 24 recorded candidates were rejected. "Synthetic and arcade-like spell
  sounds, painful hiss, and overly bright or crispy explosions were rejected"
  (`docs/SOUND-EFFECTS-DIRECTION.md`).
- alpha.6 shipped with clicks that never reached the arena (`2ab87be`). A reporter on alpha.7
  saw the browser menu over the arena (`48d25e5`).
- "Players kept missing Browse games", fixed twice (`f7b3f7c`, `a421e65`, 10-21).
- Guests renamed "Guest <name>": the prefix "ate a third of the name and read badly" (`2dd7e0f`).
- Mid-round joiners "watched 'their' bot keep playing ... which looked like their warlock going
  haywire" (`263e16e`). They were also stuck with the bot's build, which led to Fresh start
  (`67715af`).
- Betting: "A bet placed when two warlocks remained was nearly always safe, so waiting until then
  was compulsory" (`10b6fa5`). Betting then moved to pool payouts (`972c0fb`).
- Layout: menus and results scrolled at common desktop heights and needed five fixes
  (`f34f741`, `e0aa5d4`, `b4211e1`, `3706654`, `4f62a06`).

### 1.4 Playtest 2026-10-25 (King of the Hill launch day)

- "The contested hill strobed white across every tile (3.2 Hz) ... and with 21 tiles somebody
  always stood on it so nobody earned tickets" (`8afa204`).
- "A ticket a second after stepping on felt instant", so capture went to 3 s (comment on
  `HILL_CAPTURE_SECONDS`).
- The casual lobby's "30 s felt rushed" (comment in `src/net/server.ts`).
- "Bots cancel many Scourge casts against players the blast would have hit." "Brutal bots in
  ranked react slowly at times, worst on a small late arena." "Hard bots kill rarely in every
  mode (about 3 deaths in 3 minutes of a bot-only rounds game)" (`8e2fc2a`).
- The fixes were "Written during the playtest without running anything" (sprint text in
  `3a71d9e`). alpha.14 went out with the full suite skipped (`deploy/releases/2026-10-25-alpha14.md`).
- After that: "A real match took far too long too" (NEXT-SPRINT §7), and "an instant Teleport onto
  it decided the start", which led to a 5 s force field over the hill (uncommitted, user call
  10-27).

### 1.5 The user's own current observation

Bots are strong and feel decent but sometimes "dance on the spot" in a way no human could
replicate. See §8 for the likely mechanism.

### 1.6 The original's own community

The WC3 thread recorded that "the arena shrinks too slowly with many players"
(`docs/research/tech.md` §1.1). Brawlock's ranked mode shrinks every 8 s instead of 10.

---

## 2. Repeated tuning, reversals and arguments

| Topic | Path | Commits / source |
|---|---|---|
| Hill capture time | none (alpha.11) → 3 s (alpha.14) → 1.75 s (alpha.15) → 1 s (alpha.16) → 0.5 s (main, unreleased) | `54586f9`, `484bbe5`, `c3d6465`, `d8a81f0` |
| Hill contest | restarted capture → pauses it | `abe33a2` |
| Hill size | 21 tiles → 13 | `8afa204` |
| Hill gold | coin per ticket → ramp up to 5 per grant → capped at 3 | `a4c7416`, `54586f9` |
| Hill target | 100 tickets → 75 | `d8a81f0` |
| Hill opening | free → 5 s seal over the hill (uncommitted) | NEXT-SPRINT diff |
| Hill contested visual | red → white strobe → calm outline | `7c84f2d`, `8afa204` |
| Casual bot table | Brutal → Medium → Hard + Brutal + Medium → 5 Medium + Hard | §1.2 |
| Ladder labels (Hard / Brutal / Uber) | 1750/1925/2100 → 1600/1825/2000 → 1625/1850/1950 → 1650/1850/2000 → 1825/2025/2225 | `6779747`, `d39c8df`, `cbeeedb`, `932565f` |
| Match length | 11 → 5 rounds (custom) → 3 (casual); shop 30 → 25 s | `57adf19`, `8078a65` |
| Queue economy | 40/12/2/3 → 50/15/2/3; hill 60/20/3/4 | `docs/RANKED-FORMAT.md`, `4b96afd` |
| Scourge windup | hidden from opponents (as in the original) → subtle cue, the same day | `46eea90`, `4b84173` |
| Selling | none (original) → Fresh start for bot takeovers → any non-ranked seat at 75% | `67715af`, `9ff3ea4` |
| Leaving | loss after 60 s of combat → any leave of a counted match is a loss | `bb7e33c`, `4e65758` |
| Post-game flow | auto-pull after 15 s / 60 s grace → never move anyone without Ready | `36cafd8`, `8078a65`, `9b95488` |
| Lobby countdown | 5 s → 30 s + Wait for players → 60 s once a second human joins | `9b95488`, `a3fe5ce`, `3a71d9e` |
| Tick rate | 60 Hz → 30 Hz default per server (capacity) | `3bcbeea`, `397c93f` |
| Announcer | 13 commits rewriting lines, rotation and timing | §1.3 |

What this says:

- **KotH has a structural problem, not a timer problem.** NEXT-SPRINT §7 measured a 10-seat bot
  FFA: the hill is contested about 62% of fight time and held 27%. It "changes hands about 24 times
  a minute, so a hold lasts about 0.7 s". Each shorter capture moves the mode back toward
  "no capture" (about 28 min), while round-win tickets do most of the scoring. Ten free-for-all
  players on a 13-tile hill, in a game whose verbs are knockback, rarely leave one team alone on
  it. The queue also uses the slow **rounds** style; the **respawn** style has a 12-minute limit
  but no queue uses it. Team KotH "stays out of the menu for now" (`4b96afd`). The open
  alternative is still "the ticket target (or a ticket rate per player count)" (NEXT-SPRINT §7).
- **Difficulty is one dial for a mixed audience.** The casual table swings because it must suit a
  first-timer and a veteran at once. Rating-based bot difficulty was planned (M4 §3) and is
  "Not done" (M4 §12). Guided practice ends in a match against two Easy bots (Elo 350), while
  casual seats Medium (1000) and Hard (1825). That is a cliff.
- **Bot calibration is a moving target.** The ladder was remeasured about nine times in 12 days
  (10-15, 10-16, 10-17, 10-19, 10-20 twice, 10-21, 10-25, 10-26). Each fix to one step (punish,
  windup reading) disturbed the next step. "Hard and Brutal shared every other decision" except
  a 30 ms faster reaction (PLAN §7). Tiers come from reflex knobs plus bolt-on behaviours, not
  from distinct play styles.
- **Bot strength and fun pull apart.** "Hard keeps about 610 units from the edge ... More kills
  means riskier positioning ... which also makes Hard easier for players: a design call"
  (NEXT-SPRINT §7). Safe bots make long, low-action rounds.
- **Faithfulness gives way under play pressure, one case at a time.** Scourge visibility,
  selling, match length and economy all moved away from the original once a playtest hurt.
  Each deviation is documented (PLAN §2), but there is no rule for when to deviate.
- **Consent and agency came out of churn.** Every flow reversal moved toward "never move a
  player without their Ready", "never auto-switch region" (`e7e3c4c`) and "nothing switches
  [hosting] mode by itself" (M4 §11). This is now a stable principle.

---

## 3. Open engineering gaps and parked items

| Item | Status | Source |
|---|---|---|
| Battle and shop soundtrack | Item 1 of next engineering work; synth disabled on purpose; Suno prompt guide exists (`docs/SOUNDTRACK.md`: shop, 3 combat cues, final ring, results) | NEXT-SPRINT §1 |
| Room processes per host (shards) | `feat/shards` unmerged; held 64 bot rooms on the 2-vCPU EU host vs 32; production refuses more than one process | NEXT-SPRINT §2 |
| Player rooms stall | about 24 rooms per 2-vCPU EU host (input ack p95 over 300 ms) while the host is about half idle; network path not isolated | NEXT-SPRINT §3 |
| Capacity budget | provisional 6 full human rooms (60 people) or 12 humans in 12 bot-filled rooms per EU host; full matrix and soak not run | `docs/research/capacity-2026-10-24.md` |
| P2P own-input prediction | can wait 78–163 ms on a lossy raw channel at 150 ms RTT | NEXT-SPRINT §3 |
| Global menu chat | user idea 10-25; in progress, uncommitted (`server/chat.mjs`, `GlobalChat.tsx`); signed-in players only | NEXT-SPRINT §8 |
| Hill force field | uncommitted (`HILL_SEAL_SECONDS` = 5, `HillField.ts`) | NEXT-SPRINT diff |
| Hill match length | 0.5 s capture plus 75 tickets "not remeasured together" | NEXT-SPRINT §7 |
| Bot Scourge `gone` model | "assumes every enemy flees at once" | NEXT-SPRINT §7 |
| Crash-time activity | no periodic checkpoints; a crashed server loses running matches' activity | NEXT-SPRINT, PLAN §12 |
| Human verification | production passkeys and signed-in cross-device/region reward play, open since 10-19 | NEXT-SPRINT |
| Parked | P2P host migration, delayed competitive spectating, map pings, WebTransport, new game modes, mobile controls, premium currency, larger cosmetic catalog, email/magic-link login | NEXT-SPRINT "Parked" |

Planned in PLAN/M4 and not built (not listed as parked):

- Minimap (PLAN §5.7 HUD list); no minimap exists in `src/`.
- Bot **team coordination** (PLAN §7 lists it as a difficulty axis); `controller.ts` has no ally
  logic. Team play exists only in custom Teams/Shuffle.
- Ranked as designed in M4 §4: 1v1, Glicko-2, placement against `BOT_ELO` bots, "play a bot while
  you wait". Shipped instead: an 8-seat FFA with Brutal fill and Elo K 40 per match.
- Rating-based bot difficulty in quick play (M4 §3, §12 "Not done").
- Gamepad, shift-queued orders, WASD movement (PLAN §6, post-v1). An in-game reduced-motion
  override and HDR output (PLAN §12, `COLOR-GRADING.md`).
- Separate avatar slot (memory: needs account schema 8). Staff-specific clips (PLAN risk 10).
  Discord and Microsoft sign-in (only Google provisioned, `ACCOUNT-IDENTITY-PLAN.md`).
- Character art: PLAN risk 9 calls it "the biggest presentation lever". The CC0 Quaternius base
  is still the default; the Tripo candidate is opt-in in dev tools only (`docs/ASSETS.md`).

Doc drift found while reading:

- NEXT-SPRINT §3 says "The 30 Hz simulation ... waits for a playtest decision", yet 30 Hz shipped
  in alpha.11.
- PLAN §3.4 says "Team mode Shuffle (default)", but `DEFAULT_SETTINGS.teamMode` is `'ffa'`.
- The NEXT-SPRINT header still says "Audited ... 2026-10-21".
- The alpha.16 notes say a 1 s capture; main is 0.5 s, unreleased.

---

## 4. Population and retention signals

**Snapshot.** The only one on disk is `artifacts/analytics/report.json`, covering
2026-10-19..20, right after the first public playtest:

- Peak online (account-service presence, menus included) was 7 on 10-19 and 5 on 10-20.
  81 browsers were seen for the first time.
- EU casual: 8 matches started, 4 completed, 4 abandoned, 71 bot seats (about 9 of 10 seats
  were bots). The 4 completed first-to-3 matches averaged about 1,671 s (28 min) and 8.5 rounds.
- EU ranked: 4 completed, about 15 min each, with 24 bot seats over 4 eight-seat matches.
  Only 2 unique players, so the same two accounts played each other.
- US: 2 casual starts, 0 completed. 2 custom games.

This is stale. The operations dashboard's Players tab holds current numbers
(`docs/OPERATIONS-DASHBOARD.md`).

**Design assumptions.** Matchmaking was designed for 10–100 CCU: "No skill-based matchmaking
until the queue has people in it" (M4 §3). PLAN risk 8: Spellsworn and Battlerite sit at tens of
concurrent players; Spellbreak and Magicka: Wizard Wars shut down. Prior art Acolyte Fight peaked
at 40 users and had Poki, Kongregate and Facebook distribution plus Discord login (`tech.md` §1.2).

**Bot dependence.** Every queue fills with bots: casual 10 seats, hill 10, ranked 8
(`src/net/server.ts`). Embers are earned against bots too: "Official casual games against bots
can qualify" (`PROGRESSION.md`). The menu backdrop runs Brutal/Uber bot battles (`bb7e33c`).
Capacity makes this costly: one human in a bot room is the most expensive human per CPU
("Packing humans into existing rooms matters substantially", capacity report).

**Ranked gate.** A match counts only with at least two distinct humans and two minutes of play
(`RANKED-FORMAT.md`). With 2 unique ranked players, Elo is a private duel.

**Match length.** Casual about 28 min measured. Ranked targets 15–20 min with an 8 s shrink. Hill
bot-only 90+ → about 61 → about 46 min (projected); "a real match took far too long".

**Discovery and waiting.** Browse games needed a live count and a menu panel because players
missed it (`f7b3f7c`, `a421e65`). Lobbies wait 30 s alone and 60 s once two humans are in; any
player can hold with "Wait for players". Results wait for Ready; idle tabs are dropped and results
close after 30 min. Leave keeps casual and KotH rejoinable for 2 minutes (`3a71d9e`).

**Onboarding.** The first play opens How to play before matchmaking. A 5-step guided lesson uses
the real sim (`GUIDED-PRACTICE.md`), and GA4 funnel events exist. The GA4 doc says post-deploy
Realtime verification was still required. No completion or retention numbers are recorded
anywhere.

**Retention hooks that exist.** Embers (20–30 per qualifying match, items 50–220), the wardrobe
(account-only since `6f4cf94`), profiles, Hall of Fame, replays, leaderboard, awards, kill-feed
accolades. There is no daily or weekly loop, quests, seasons or friends list. The only social
layer is room chat, plus global chat in progress.

**Two pools of identity.** itch.io keeps separate storage, "so a browser is a different guest on
itch than on brawlock.osc.link", and itch players cannot sign in (`docs/ITCH.md`).

---

## 5. Design tensions

**Faithful v1 vs innovation.** PLAN: "Innovation comes after v1 ships and the core feels right."
The tie-breaker (memory, 2026-10-18) is "we wanna be close to original in any of these
questions". In practice v1 already carries King of the Hill, betting and bounties, Fresh start,
Lightning scaling (`de52370`), shorter matches, kill/win gold, a 30 Hz tick, Brawlock keybinds
and an announcer. "Feels right" has no criterion, so the innovation backlog (PLAN §9: new spells,
map variants and hazards, draft mode, seasonal cosmetics) has no trigger.

**Precision and latency vs capacity.** Pillar 1 says "Latency is a design constraint". Servers
moved to 30 Hz so "each server can host several times more games" (alpha.11 notes). The
per-server rate option (60 Hz for ranked) exists but is unused.

**Desktop only vs "web-native, opens from a link".** The user (memory, 2026-10-21): "we don't
support touch screens whatsoever". Touch devices are menu-only (`artifacts/game-progress.md`),
and the itch embed sets "mobile friendly off". PLAN's innovation list still names "mobile touch
controls" and the parked list "mobile controls". WebGPU covers about 88% of browsers (PLAN
risk 5), with a WebGL2 fallback at Low.

**Standalone UI, no commands.** Every original lobby option has real UI (PLAN §3.4,
`MatchOptions.tsx`); the original had only console bot commands (`systems.md` §6.6). This gives a
large settings surface (cast modes, three keybind presets, camera reach, effects, colorblind
palette), and every new rule needs UI, tests and copy: KotH added lobby options, HUD, announcer
lines and bot behaviour in one day.

**AAA bar vs a one-person pace.** The bar is "Unreal Engine quality without the performance
penalty", and a spell "counts as implemented only when its sim behavior, tests and this VFX
standard are all done" (PLAN §5). Gaps against it: silent combat (no music), a CC0 base
character, perf work accepted only when the image stays identical (memory `perf-harness`), and
SFX auditions that rejected most candidates. About 1,800 tests guard the work, but a release
drains both regions for 10–20 min (memory `release-only-on-ask`). That pushes toward batching,
while playtests push toward same-day fixes.

**Cosmetics-only Embers vs sustainability.** Embers "never change match gold, stats, hitboxes or
Elo"; "No payment processor, premium currency or broad marketplace" (`PROGRESSION.md`).
`7953878` dropped "non-commercial" from the terms: "donations are coming". The catalogue is small
(six slots of procedural pieces, all on sale every day) and premium currency is parked. Embers,
ranked and the wardrobe now require an account, which itch players cannot have in the embed.

**Bots first-class and "human-plausible" vs how they move.** "Every preset is human-plausible"
(PLAN §7) is enforced as reaction ≥ 0.12–0.15 s and aim error > 0 (`presets.ts` header). Nothing
constrains orders per second or movement shape. See §8.

**Competitive integrity vs population.** The original ranked mode was exactly 1v1
(`systems.md` §6.5). Brawlock ranked is 8 seats with Brutal fill, which needs two humans and
cannot rate one human against bots. A 1v1 queue would almost never match at the current
population.

**Original defaults vs queue defaults.** The original default team mode was **Shuffle**: random
teams every round, team scores reset. Every brawlock queue is FFA; Shuffle and Teams exist only
in custom lobbies.

---

## 6. What the original had that brawlock dropped, changed or has not done

| Original (`systems.md`, `tech.md`) | Brawlock today |
|---|---|
| Shuffle default: teams re-dealt every round from the player-count divisors | Option in custom lobbies; default FFA; no queue |
| Teams mode with host-assigned teams | Custom only; no team queue; bots do not coordinate |
| Deathmatch: 60 s rounds, 10 s respawn, no shrink, 1 score per kill | Custom only |
| Shop never closed server-side (buy mid-fight, while dead) | Shop phase or while dead; "One constant restores buy-anytime" (PLAN §2) |
| Flat economy (30 start + 10 per round; kill/win gold 0) | Kill 1 / win 2 default; queues 50/15/2/3 |
| First to 11 rounds, 30 s shop | 5 (custom), 3 (casual), 5 scheduled + final (ranked); 25 s shop |
| Ranked: exactly 2 players, host button, no MMR stored | 8-seat ranked queue, accounts, Elo, profiles |
| Bot difficulty = think interval only, console commands | Six tiers with UI, Elo labels, seeded builds |
| 7 Dota heroes, effectively random | One warlock plus a cosmetic wardrobe |
| Chat-line announcements | Voiced announcer, banners, kill feed |
| Discord link on the loading screen; warlockbrawl.com; Steam group | No social channel: "Social links are not guessed; add only confirmed channel URLs" (`FEEDBACK.md`) |
| WC3 era: arena style (circle or square), shrink speed as host constants, 1 g for last hit and top damage | No arena-shape or shrink-speed option (ranked hard-codes 8 s) |
| No selling, ever | Fresh start at 75% outside ranked |

Quirks and feel that brawlock kept on purpose:

- Dota cast cancelling for fake casts and baits ("Move cancels cast", default on).
- Lava kills credited to the last hitter.
- Lightning detonating Fireballs, kept and scaled.
- Scourge with no telegraph for opponents, softened to a subtle cue.
- No draw on simultaneous kills (`d9b09ae`).
- Turn rate 1.2.
- "Controls must feel exactly like Dota to veteran players" (PLAN §6).

Fixed rather than copied: broken Homing, tooltip vs real cooldowns, the bots' float-random
jitter, the Deathmatch self-score bug and lava shop spawns.

The docs record **no evidence of which original quirks players loved**. The only community
datapoint is the shrink-speed complaint above. The Dota 2 workshop item had about 644k
subscribers and now shows a removal notice; the "official standalone project" by Adynathos looks
dormant (`tech.md` §1.1). The old gathering places (a Steam group since 2012, the Discord on the
loading screen) are not linked from brawlock. [Inference: the audience exists but is orphaned.]

---

## 7. The user's stated preferences

From PLAN, commit messages and project memory:

- **Quality first:** "triple-A is our baseline"; "Unreal Engine quality without the performance
  penalty"; L1 effects tame, escalation by level; lighting approved as is; "recover frames without
  reducing fidelity" (image-identical perf only).
- **Faithful core:** closest-to-original tie-breaker, Dota controls, original numbers pinned by
  tests (545 values, `d61054b`).
- **Standalone game:** every setting has UI, never chat or console commands.
- **Bots first-class:** "Good, not cheating"; Uber "wins on decisions, not reflexes".
- **Online quality:** "game only matters if online play is amazing"; low friction (room codes,
  one-click rematch); stats, encounters, leaderboards.
- **Player consent:** never move a player without Ready, never auto-switch region or hosting.
- **"Fun as soon as possible without bullshit":** fewer setup steps and chores (memory
  `release-only-on-ask`, 10-21).
- **Tone:** dark deadpan humour ("Extra Crispy!", "Thoughts and Prayers!", "We'll Mail the
  Ashes!", `ac6b113`, `c60b1cc`); a rare Wilhelm scream "homage" (`31a706a`).
- **Audio:** no placeholder synth music; the user supplies music (Suno "Circle of Ash",
  `MENU-MUSIC.md`); "no music anywhere" in the showcase; short, weighty, physical SFX.
- **Process:** no rapid deploys, ask before every release, batch substantial work; docs are "not
  eternal truth"; keep every art variant ("don't throw away shit"); desktop only, no phone
  testing; tests encode intent and run selectively, and the full suite can be skipped by user call.
- **Ideas the user raised:** global menu chat (10-25), an avatar badge from the cape emblem
  (10-20), donations (`7953878`), a social "Copy top 10" for posts (`8fa3958`).

---

## 8. Bots that "dance on the spot"

The user reports that bots are strong and feel decent but sometimes dance on the spot in a way
no human could replicate. The code suggests a likely mechanism. **It has not been verified in a
replay.**

- **Decision rate.** Hard, Brutal and Uber decide every 0.1 s (`thinkInterval`), and almost every
  decision issues a fresh move order.
- **Short-lived move targets:**
  - Brutal and Uber (`edgePressure`) re-pick a standoff point every 0.3–0.6 s, at a random angle of
    ±0.5 rad and a radius of 450–650 around the target (`pickWander`).
  - Near-target wander points within 200 units are re-picked every 0.2–0.4 s.
  - Hill points are re-picked every 0.3–0.7 s.
  - At 210 move speed, a bot covers only 40–130 units before its goal jumps again.
- **Dodges.** A dodge keeps its side for only two think intervals (`dodgeMove`), and the dodge
  threshold is 2.5 for Hard and up. A bolt passing a few hundred units away can therefore flip
  the bot left and right.
- **Instant turns.** The turn rate is 1.2 rad per 0.03 s (`systems.md` §10), so direction
  reversals look instant.
- **Inherited behaviour.** The original AI had the same visual signature from a Lua bug: it
  re-picked a wander point almost every think, "jittery walk" (`systems.md` §12.6). Brawlock fixed
  the bug's intent but still re-targets every 0.2–0.8 s, on top of a 0.1 s think.
- **No measurement.** Calibration measures only round win rate (`scripts/bots/elo.ts`). There is
  no metric for orders per second, reversals per second or idle dithering. The replay recorder
  already stores human inputs, so a human baseline could be measured and used as a plausibility
  gate next to the Elo ladder.
