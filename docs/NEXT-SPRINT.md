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
   - The 30 Hz simulation (branch `exp/30hz-v2`) waits for a playtest decision.
4. **Bot sharpness (playtest feedback 2026-10-25).**
   - Bots cancel many Scourge casts against players the blast would have hit. Step 6 of the bot
     decision in `src/bots/controller.ts` drops the channel whenever the dodge threshold trips
     (`mustDodge`), even when the blast lands before the threat arrives; value presets also drop it
     when predicted victims "walk out" (`gone`, velocity extrapolated over the remaining wind-up).
     Keep the channel when the remaining wind-up is shorter than the threat's arrival or the blast kills.
   - Brutal bots in ranked react slowly at times, worst on a small late arena. This was seen at 60 Hz,
     before the 30 Hz default, so the tick rate is not the cause. Profile their decision cadence,
     reaction delay and threat lookahead on a small arena.
   - Hard bots kill rarely in every mode (about 3 deaths in 3 minutes of a bot-only rounds game).
5. **King of the Hill bot builds.** Bots should lean toward area control and multi-target spells on the
   hill (for example Scourge, Meteor, Rockpillar), as a weighted preference, not a fixed build.
   In a bot-only free-for-all the hill is contested about 78% of the time, so tickets come slowly.

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

The latest rollout is **v0.1.0-alpha.13**, source `c2caf7e6f445`, on 2026-10-25:
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
