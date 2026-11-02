# Next sprint

Audited against the source on **2026-10-21**. This is the active backlog; the original
milestones in [PLAN.md](PLAN.md) and older design documents are not a list of missing features.
Deployment is established by release receipts, not by implementation status here.

## Next engineering work

1. **Battle and shop soundtrack.** Choose proper recorded combat and shop music. Synth music is
   disabled in both deliberately; the menu recording and combat SFX remain. Selection still needs a listening
   decision; it is not a reason to restore the synth or generate arbitrary tracks.
2. **Several room processes per game host (shards).** The local branch `feat/shards` runs rooms in up to
   two processes behind one front process, one per vCPU. Together with the 30 Hz build it held 64 clean
   bot rooms on the 2-vCPU EU host instead of 32. To ship it: merge it into main, and move the services
   that own shared state and databases into the front so room processes never write them directly.
   Until then a production build refuses more than one process.
3. **Known gaps accepted for alpha.11 (fix later):**
   - Peer-to-peer own-input prediction can wait 78–163 ms on a lossy raw channel at 150 ms RTT
     (`src/net/session.predict.test.ts`, loss seeds 1 and 9). Sending the link report once a second
     instead of four times made seed 9 hit it too.
   - Full player rooms stall near 24 rooms per 2-vCPU EU host (input acknowledgement p95 over 300 ms)
     while the host is still about half idle, and plain health checks slow down with them. Generate the
     load from a machine other than the developer's home connection to tell the server's network path
     from the generator's uplink.
   - The 30 Hz simulation shipped as the default in alpha.11 (`DEFAULT_TICK_HZ`); 60 Hz stays a
     per-server option.
4. **Playtest 2026-10-25 evening, shipped in alpha.14.** Touched suites and typecheck passed; the
   full suite was skipped for this release by the user's call.
   - King of the Hill: a fresh capture pays its first ticket after `HILL_CAPTURE_SECONDS` (3 s in alpha.14, 1.75 s in alpha.15),
     then one a second; the HUD says "taking the hill" meanwhile.
   - King of the Hill: the hill stays two rings inside the arena (`hillLayerOn`): 13 arena tiles
     left, the hill is the plus of 5; from 9 tiles down only the centre tile.
   - King of the Hill: round-win tickets stop at the target and end the match at once.
   - King of the Hill: hill gold tuned down: 1 at 5 s and 10 s, 2 at 15 s and 20 s, then 3 every 5 s.
   - Bots: an enemy on the hill pulls their targeting (the holder most); an enemy running away
     with the match (score lead or kills) and long grudges (damage taken, decaying over 20 s,
     across rounds) count in every mode. Weights, not rules.
   - Bots: a Scourge channel is dropped only for a bolt on course that lands before the blast, never
     for a blast that kills. The dodge threshold alone used to cancel blasts that would have hit.
   - Bots (Hard and up): an enemy Scourge with us inside is answered with a Lightning or Fireball that
     lands first and pushes the caster clear, else they walk out as before.
   - Bots: every build buys masteries by plan (range for distance builds, duration for roots and
     pulls, lifesteal for close trades). King of the Hill redraws the build with `HILL_WEIGHTS`
     (artillery and brawler more often).
   - Leaving a casual or King of the Hill game keeps it rejoinable from the menu for 2 minutes, in
     that tab only (`RejoinController.left`); leaving ranked stays final.
5. **Shipped in alpha.15.**
   - King of the Hill capture time 1.75 s (`HILL_CAPTURE_SECONDS`); a contest pauses the holder's capture instead of restarting it.
   - Scoreboard: a Worth column (gold on hand plus gold spent in the shop).
   - King of the Hill pillars: four ring the starting hill, on its corners in even rounds and on
     its tips in odd ones (respawn style: corners), plus 1 to 3 random ones off the hill. A pawn
     knocked into a rim pillar stops with its centre still on the hill. They stay put while the hill
     shrinks; in a long respawn fight they end up a ring or two outside it.
   - Fresh start for every seat outside ranked: sell the whole build for 75% of the gold paid on it,
     before the next fight or while waiting to respawn in respawn modes; a confirm dialog shows the
     refund. A seat just taken over from a bot still gets all of it back.
   - Top-bar names: click one while watching to follow that player.
   - Results: each row opens to the player's final build and net worth.
   - Fix: the centre tile no longer glows outside King of the Hill.
   - Bots read windups (Hard 30%, Brutal and Uber 70% of casts): an enemy turning or winding up a
     straight bolt is dodged as if the bolt were flying. Half the hits Brutal took on small arenas
     were close Fireballs no bot could dodge after spawn (the "reacts slowly" report). Ladder
     remeasured: Brutal 76% of rounds over Hard, Uber 75% over Brutal; lobby labels Hard 1825,
     Brutal 2025, Uber 2225 (PLAN §7).
   - itch.io build ([ITCH.md](ITCH.md)): same servers and player pool, guests only; published
     with butler to https://prompin.itch.io/brawlock.
6. **Shipped in alpha.16.**
   - King of the Hill capture time 1 s (`HILL_CAPTURE_SECONDS`).
   - Casual quick play: five Medium bots seat first, the rest Hard (was Hard with one Brutal and
     one Medium). King of the Hill and ranked keep their tables.
   - Guests are sent to sign in: on itch.io the player card, Ranked, Wardrobe and official results
     open brawlock.osc.link and say what a guest misses; the Wardrobe entry needs an account.
7. **Bot follow-ups still open.**
   - Value presets still drop a Scourge when predicted victims "walk out" (`gone`); its model assumes
     every enemy flees at once. Check it against real play once the cancels above are fixed.
   - Hill queue length (measured 2026-10-26, bot-only, the queue's setup: 10 seats, FFA, rounds
     style, first to 100). The hill is contested about 62% of fight time, held 27%, and changes
     hands about 24 times a minute, so a hold lasts about 0.7 s, under the capture time. Matches
     barely score between round wins: with a 1.75 s capture they ran past 90 minutes (28 rounds,
     leaders at 59–74 tickets). A contest used to restart the holder's capture; it now pauses it
     (leaders 87–89 at 90 minutes). With that: capture 1 s gives about 61 minutes, 0.5 s about 46,
     no capture about 28. A real match took far too long too. Capture set to 1 s after alpha.15
     (user call, 2026-10-26); about 61 minutes bot-only is still long, so the ticket target (or a
     ticket rate per player count) is still open. After alpha.16 (user call, 2026-10-26):
     capture 0.5 s (about 46 minutes bot-only by the numbers above) and the queue's target 75
     tickets; not remeasured together. Also after alpha.16 (user call, 2026-10-27): every fight
     opens with a force field over the hill for 5 s (`HILL_SEAL_SECONDS`), so an opening Teleport
     no longer takes it; bots wait at the field.
   - Hard bots kill rarely (measured 2026-10-26, 4-bot FFA rounds): first death after about 107 s
     (Medium 72 s, Brutal 115 s), 83% of deaths are pushes into lava once the arena has sunk about
     11 layers. Hard keeps about 610 units from the edge on the big arena (a hit pushes a few
     hundred) and dodges most bolts, so early hits never reach lava. More kills means riskier
     positioning (closer, nearer the edge), which also makes Hard easier for players: a design call.
8. **Global chat in the main menu: shipped in alpha.17 (built 2026-10-28).** One channel for everyone
   online, bottom right of the main menu and passive like the in-game chat (the last three lines;
   Enter or a click opens it), filterable by region. Accounts with a claimed name post; guests and
   the itch.io embed read. Per-browser mute, report (the first report reaches the feedback inbox),
   hidden for everyone at three reports, and Operations › Global chat hides or shows lines and
   mutes accounts for 24 hours or for good. See [ACCOUNTS.md](ACCOUNTS.md#global-chat). Ships with
   the account service and the client in the same release.
   - Follow-up: guests can still show any name, including an account's claimed name. Dedicated
     rooms only mark them as guests (`sanitizeName` in `src/net/protocol.ts`).
9. **Shop Ready and shopping while out: shipped in alpha.17 (built 2026-10-29).** Ready in the shop header
   ends the shop 3 s after every human is ready (never before 6 s); a knocked-out warlock gets the
   round's gold at the knockout, can shop from the knockout card and ready while out. Sim and
   protocol change: new netcode id and `PROTOCOL_VERSION` 10, so server and client deploy together.
   Shipped ahead of Brisk casual ([moonshot/specs/faster-casual.md](moonshot/specs/faster-casual.md)).
   Spec: [moonshot/specs/shop-ready.md](moonshot/specs/shop-ready.md).
10. **Bot motion: shipped in alpha.17 (built 2026-10-29).** Medium and up order their walking the way
   players click: reversals from about 1.2 to 0.3 a second in 4-player FFA, orders from 8.7 to 5,
   no shared think clock (same-tick ratio 3.0 to 1.0), inside the strong-human band measured on
   recorded matches. Bot code only (no netcode change), but bots run both in the browser (solo,
   P2P hosts, the menu backdrop) and on dedicated servers, so client and server both carry it.
   Still to do: the playtest evening against Hard and Brutal (do they feel as dangerous, do they
   look like players). Spec and measurements: [moonshot/specs/bot-motion.md](moonshot/specs/bot-motion.md).
11. **Reset build, easier to find: built, not released (2026-10-29).** After alpha.17 a player took
   over a bot's seat and never saw the free reset (Fresh start, live since alpha.10/15). A local
   dedicated-server repro showed the rule works: the joiner's first round end and shop refund all
   of the bot's spending. The shop button now reads "Reset build · free" (takeover) or
   "Reset build · +N gold", and a takeover shows an offer above the spells until the next fight.
12. **Free camera option: built, not released (2026-11-01).** Playtest note: the follow camera
   feels pushy, and the original did not chase the warlock (stock Dota camera). Settings >
   Gameplay > Camera adds Free next to Follow, which stays the default. A free camera stays where
   edge pan leaves it, holds that ground spot while the warlock moves and has no aim look-ahead.
   Space centers it, holding Space keeps it on the warlock, and every round start centers it.
   The off-screen arrow for your own warlock (`PawnLocator`) covers a free camera too.
   Open: whether Free should become the default, a hotkey to switch modes, and a middle-mouse
   drag pan.
13. **Brisk casual pace options: built, not released (2026-11-01).** The match settings of
   [faster-casual.md](moonshot/specs/faster-casual.md): `scheduledRounds` (Fixed rounds in free for
   all, ranked's format without its ranked-only rules; the original's default "up to N rounds"
   win condition, PLAN §2), `arenaCap` and `shrinkSeconds`, with lobby rows (Match length, Arena
   size, Shrink every), classic defaults, listings and records that show the rounds, and the
   announcer and top bar following the schedule. Sim change: a new netcode id, so server and
   client deploy together. `arenaBase` waits for the daily. The casual queue preset is its own
   change (item 14).
14. **Brisk casual queue: built, on main, not released (2026-11-01).**
   Casual quick play switches to five rounds, arena cap 15, a ring every 7 s and 30 gold a round
   (the spec's Rule 8; the menu reads "5 rounds"). The developer brought it in without the
   custom-room playtest the spec asked for (2026-11-01). Recommended answers taken for the open questions: ranked's final
   in casual, 20 Embers per casual match for now, King of the Hill unchanged; no one-click
   Classic / Brisk button yet.
15. **Moments engine: built, not released (2026-11-01).** `src/game/moments.ts` names knockouts by
   their sealing hit, round and match deciders, multi-knockouts, denies, clutches and close calls
   from the confirmed stream; replays keep the ten best ([moments.md](moonshot/specs/moments.md)).
   Nothing shows until the Final Blow and the results reel, which ship with it. No sim or net
   change.
16. **Final Blow and finish zoom: built, on main, not released (2026-11-01).** The
   round's deciding hit replays slowed down at round end (the match version holds the results),
   and a finishing hit punches the camera in ([final-blow.md](moonshot/specs/final-blow.md)).
   Checked in a headless browser against bots. Next: the offline playtest (do players watch or
   skip, can they say who hit whom), the WebGL2 fallback, and the results reel.
17. **Results highlights: built, on main, not released (2026-11-01).** Up to three of the match's
   best moments play on the results screen before the board, and again from Watch highlights or
   the replay viewer ([results-reel.md](moonshot/specs/results-reel.md)). Client only. Clips and
   sharing are the spec's later phase.
18. **Daily Gauntlet: built, on main, not released (2026-11-01).** A named day, five waves of bots
   with the day's champion last, two lives, one board; the account service verifies each run's
   tape and pays 15 Embers a day, 75 on every seventh day of a streak
   ([daily.md](moonshot/specs/daily.md)). Ships with the account service, both regions and the
   client together (the `arenaBase` setting moves the netcode id); nginx needs the
   `/api/daily/submit` location (`deploy/web.nginx.conf`) and the account service 256 MB
   (`deploy/accounts.config.cjs`). Watch, the champion stage and the Operations › Daily tab
   followed on 2026-11-02.
19. **Wild: first deck built, on main, not released (2026-11-01).** A custom-lobby switch: an omen
   over every round from the second (Blood Moon, Slick Stone, Overcharge, Sudden Collapse, Meteor
   Shower, Pillar Storm, each toggleable), the card in the countdown, a badge under the clock,
   and the reactions Shatter, Nova and Fork ([wild.md](moonshot/specs/wild.md)). Ships with the
   servers and client together (new sim rules). Voice calls and stings, the library's Reactions,
   bot combos and the Browse tag are in; bot-only runs show every omen bringing knockouts earlier
   (Pillar Storm least) and Fork and Shatter rare between bots. Next: the playtest evening; Wild
   Hours after it.

## Completed in this planning pass

- **Custom seats and match consent:** ten open/occupied seats by default, host close/open
  controls, and empty-seat admission between rounds without a bot to replace. Custom starts
  count down for three seconds; rematches in all room types require every human's Ready
  and a cancellable ten-second grace period. Network, replay and desktop proof are recorded
  in [SESSION-RECOVERY.md](SESSION-RECOVERY.md#open-seats-and-starting-another-match).
- **Spectator/UI follow-up:** locked bets retain live estimated chances, health and pool
  shares; gold votes offer Low/Current/High relative to the entered setting. Solo/Online
  creates a custom lobby directly, and identity/setup dialogs omit duplicate feedback links.
  First Blood names the victim as well as the killer; Denied requires a threatening escape,
  while the broader Teleport saves statistic keeps its existing definition.

- **Partial combat from unfinished games** counts toward the same profile totals, scoped to
  human-controlled intervals: aborted and unrated ranked games, bot takeovers, reconnects and
  departures on the server profile (`player_activity`, folded in the receipt transaction),
  and games left without a result in device-local career stats. Wins, losses, Elo, match
  counts, history and Embers ignore it, so unfinished games never enter a win-rate
  denominator. See
  [PLAYER-PROFILES.md](PLAYER-PROFILES.md#unfinished-and-partly-played-ranked-games).
  Release needs the US authority first (new optional submission fields). Still open:
  crash-time activity (no periodic checkpoints).
- **Departures follow ranked eligibility:** if the match counts (two humans who shared it, two
  minutes of play), leaving it is a loss however early; the 60-second participation threshold
  is gone. A match everyone left before two minutes gives nobody a result, and an empty room's
  bots add no time. See [PLAYER-PROFILES.md](PLAYER-PROFILES.md#departures-and-queue-history).
- **Casual quick play feeds the server profile:** complete and partial casual games fold into
  `player_casual` (new additive table, receipt transaction, no double counting); wins, losses,
  Elo and Embers stay ranked-only, custom games stay out. The profile counts casual games apart
  and its K/D comes from all recorded combat. See
  [PLAYER-PROFILES.md](PLAYER-PROFILES.md#casual-quick-play-combat). Release: US authority
  before EU (EU's `aborted` casual submissions are rejected by an older authority).
- Spectator bets pay from a pool instead of a fixed 2-gold return: correct bets split every
  stake of the round equally, so long shots pay more. Each pick shows what a correct bet would
  pay at the current pot next to its rough win chance. Rules in [PLAN.md §3.4](PLAN.md#34-modes-and-lobby-options).

- Reconciled stale account/cutover/platform plans with their implementation and release evidence.
- Retired the old “not started” list for replays, hover previews, Move cancels cast, bot builds
  and the dedicated platform. Reduced-motion support follows the OS preference; a separate
  settings override is not implemented.
- Remeasured all five active bot tiers after the shared seeded-build changes (2,000 duels,
  [measurement](research/bot-calibration-2026-10-20.json)): Brutal won only 61% of rounds over
  Hard, below the intended roughly 75% step.
- Widened Hard–Brutal with paired-seed investigation first: the old Brutal's whole duel edge
  was its 30 ms faster reaction; edge pressure and its smaller aim error were worth nothing.
  Brutal now **punishes openings** (a ready bolt the target can hardly step aside from, a sure
  or killing Scourge, taken at once; same aim and reaction), and Hard is back on the original
  1/5 cast rate. Remeasured with **4,000 duels, 21,705 rounds**: Brutal **77%** of rounds over
  Hard (75–78%, was 62% on the same seeds), Uber **64%** over Brutal (62–66%, was 73%),
  Medium–Hard unchanged at 98%. Lobby estimates: Easy **325**, Medium **1000**, Hard **1625**,
  Brutal **1850**, Uber **1950**; Easy, Medium and Uber behavior unchanged.
- Widened Brutal–Uber slightly: Uber also punishes openings, at Brutal's rate (paired-seed
  probes: 0.05 gave 67%, 0.1 69%, 0.15 71% of rounds over Brutal). Remeasured all tiers at 400
  matches per pair: Uber **69%** over Brutal (67–71%, was 64%), **91%** over Hard (was 88%);
  other pairs unchanged. Lobby estimates now Easy **325**, Medium **1000**, Hard **1650** (fit
  drift across a rounding boundary, behavior unchanged), Brutal **1850**, Uber **2000**. See
  [the measurement](research/bot-calibration-2026-10-20-brutal.json) and [PLAN.md §7](PLAN.md#7-bots).
- Bots no longer shoot into a Shield bubble just before it drops: the release waits until the
  bubble will be gone 0.1 s before the shot arrives (closing speed and the bolt's front
  counted), and a Drain is held at a ready Shield like Homing. Own shots back against the shield
  test's turtle: 111 → 4 over 600 runs, none into a raised bubble; `shield.test.ts` is strict
  again (0 into a bubble, at most 1 in all). Tier pairs unchanged within their intervals,
  labels unchanged.

## Shipped in v0.1.0-alpha.6

- Dedicated-match departures retain a result: after 60 seconds of human combat participation,
  an absent player receives a loss when the match ends. Rejoining before completion clears
  the departure; replacement bots cannot earn their owner detailed stats or equipment upgrades.
  Ranked forfeits override earlier round wins. Empty rooms settle before cleanup; a completed
  victory survives a disconnect during result delivery. Crashes/admin aborts remain aborts.
- Casual/ranked/custom authoritative history now uses the same durable receipt transaction,
  including player builds, equipment levels, masteries and forfeits. Stats offers Online / This
  device and All / Casual / Ranked filters; legacy records stay explicitly unclassified.
- The menu backdrop runs ongoing seeded Brutal/Uber battles with moving bots and fresh matches.
- Spectator betting opens its choices visibly, uses precise window states and reasons, and
  sits near the bottom center. Browser proof covers actual wager acceptance and settlement.
- Lobby Menu keeps the connection, a compact status/Return bar remains while browsing Stats,
  and ranked player-found plays a single sound. Match start brings the game to the foreground;
  Browse menu is also available during online matches, which continue running.
- In-game release notes with expandable older versions. First visits have no changelog
  popup; returning players see changed-version notes once in the menu. Builds and release
  preflight require current-version notes in release-notes.json.

## Human verification still open

- Production passkey enrollment and reuse in a real player browser.
- Signed-in cross-device play across both regions, including a complete live reward match.

The user already confirmed real public Google sign-in. Local virtual-authenticator tests
and guest admission checks do not substitute for the remaining signed-in production flows.

## Implemented, not future plans

Accounts/names, account-owned Elo and Embers, collection/equipment, universal session
ownership, explicit rejoin, guided practice, private analytics with region/build charts,
public player details, maintenance/drain, and the first-party game / Pages media split are
implemented. Their contracts live in the corresponding docs. More recent source changes
also include public custom rooms by default, reliable visibility selection, forced stale-client
reload, seeded builds for every active bot tier, the Maverick announcer library, cast-cancel
readability and the 30-second teaser tooling. Do not restart these as missing features.

## Parked

- **Email/password or magic-link login:** optional idea, not selected for implementation.
  Keep Google/passkeys as implemented. Any future email method needs explicit linking and
  recovery rules; matching email strings alone must not silently merge accounts.
- P2P host migration, delayed competitive spectating, map pings, WebTransport, new game modes,
  mobile controls, premium currency and an expanded cosmetic catalog remain later work.
- Recheck the pinned three material patch when upgrading three. Historic prewarm/browser
  measurements are maintenance evidence, not an outstanding performance rewrite.

## Recorded releases

The latest rollout is **v0.1.0-alpha.17**, source `463588c3a819`, on 2026-10-29:
[Shop Ready, global chat and calmer bots](../deploy/releases/2026-10-29-alpha17.md).
**v0.1.0-alpha.16**, source `c04177efe27f`, on 2026-10-26:
[easier casual bots, a 1 s hill capture and guest sign-in prompts](../deploy/releases/2026-10-26-alpha16.md).
**v0.1.0-alpha.15**, source `9fbd5447eee0`, shipped earlier that day:
[the itch.io build, hill pillars and Fresh start](../deploy/releases/2026-10-26-alpha15.md).
**v0.1.0-alpha.14**, source `c68ce367fcb8`, on 2026-10-25:
[hill tuning and sharper bots after the evening playtest](../deploy/releases/2026-10-25-alpha14.md).
**v0.1.0-alpha.13**, source `c2caf7e6f445`, shipped
[gold for standing on the hill](../deploy/releases/2026-10-25-alpha13.md).
**v0.1.0-alpha.12**, source `b8d9bd4554fb`, shipped
[a calmer, smaller hill after the first playtest](../deploy/releases/2026-10-25-alpha12.md).
**v0.1.0-alpha.11**, source `3f74bc89f56a`, shipped earlier that day:
[King of the Hill and a simulation rate per game server](../deploy/releases/2026-10-25-alpha11.md).
**v0.1.0-alpha.10**, source `a92f7931d9f5`, shipped on 2026-10-24
([record](../deploy/releases/2026-10-24-alpha10.md)); **v0.1.0-alpha.8** on 2026-10-21
([record](../deploy/releases/2026-10-21-alpha8.md)).
The newer source work above is not proof of another deployment.
**v0.1.0-alpha.7**, source `2ab87bea7700`, on 2026-10-20 was a hotfix for
match clicks (a layout wrapper covered the canvas). **v0.1.0-alpha.6**, source `37bba9b15def`,
shipped earlier the same day with account schema 7 (one retired-cosmetic refund). Both tags
are published on GitHub; their receipts stay in the release tool's journal, not in
`deploy/releases/`. The earlier [account-season release](../deploy/releases/2026-10-19-accounts.md)
completed the one-time fresh-season reset; **never repeat it in a routine release**.
The [combined release receipt](../deploy/releases/2026-10-19-38a2f766fb5b.md) records accounts,
ownership, analytics, maintenance and routing proof. Use [the release tooling](../deploy/TOOLS.md)
for a separately authorized rollout and retain its exact-version receipt.
