# Next sprint

Audited against the source on **2026-10-20**. This is the active backlog; the original
milestones in [PLAN.md](PLAN.md) and older design documents are not a list of missing features.
Deployment is established by release receipts, not by implementation status here.

## Next engineering work

1. **Partial combat activity from unfinished games.** Completed-match profiles currently omit
   aborted games, late joins and seats with bot-controlled intervals. Add separate idempotent
   activity checkpoints, scoped to human-controlled intervals. Cover disconnect/reconnect,
   late admission, bot takeover, room closure and retry without double counting. Keep the
   existing completed-match detail unchanged. **Qualifying departures are now settled as
   losses** after 60 seconds of combat, including ranked Elo; that is separate from these
   proposed activity checkpoints. Operational aborts/crashes still grant no fabricated result
   or Embers. Decide checkpoint cadence, counters, retention and UI labels before adding
   partial combat aggregates; that additional aggregation remains unimplemented.
2. **Battle and shop soundtrack.** Choose proper recorded combat and shop music. Synth music is
   disabled in both deliberately; the menu recording and combat SFX remain. Selection still needs a listening
   decision; it is not a reason to restore the synth or generate arbitrary tracks.

## Completed in this planning pass

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

The latest rollout is **v0.1.0-alpha.7**, source `2ab87bea7700`, on 2026-10-20: a hotfix for
match clicks (a layout wrapper covered the canvas). **v0.1.0-alpha.6**, source `37bba9b15def`,
shipped earlier the same day with account schema 7 (one retired-cosmetic refund). Both tags
are published on GitHub; their receipts stay in the release tool's journal, not in
`deploy/releases/`. The earlier [account-season release](../deploy/releases/2026-10-19-accounts.md)
completed the one-time fresh-season reset; **never repeat it in a routine release**.
The [combined release receipt](../deploy/releases/2026-10-19-38a2f766fb5b.md) records accounts,
ownership, analytics, maintenance and routing proof. Use [the release tooling](../deploy/TOOLS.md)
for a separately authorized rollout and retain its exact-version receipt.
