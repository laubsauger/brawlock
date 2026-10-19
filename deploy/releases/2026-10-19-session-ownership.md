# Combined follow-up release

Prepared 2026-10-19 for the shared US account authority, US West and Europe game servers, first-party website and matching Pages media. The exact source revision, workflow run, artifact hashes, stopped backups and final health/admission proof are recorded by `deploy/release.mjs` in its private release journal/receipt. This document describes the source changes; preparation alone does not establish a completed live deployment.

## Changes

- Account/device ownership covers every game mode, including guests, local bots/practice, P2P and dedicated games. Explicit **Use here** stops the old owner before admitting the new one. Regional connection binding and conservative expiry prevent a copied permission or unreachable owner from creating two active sessions. Account-enabled local games need the shared service too.
- Explicit handoffs retain a sole player's queue room and active match through the existing bounded connection reservation; regular last-human departures still close automatic rooms promptly.
- Ranked waiting reservations are distinct from started matches, so an unstarted queue is not offered as a game to rejoin. Device reservations, controller-fenced disconnects and generation cleanup remain authoritative across regions.
- First-game onboarding offers a skippable guided lesson using actual movement, Fireball, a Teleport shop purchase/cast and a lava knockout. The lesson creates no match record, Elo or cosmetic reward.
- Browse includes round, phase and elapsed match time for dedicated and publicly listed P2P games. Player-hosted progress refreshes about every ten seconds.
- Menu/account follow-ups clarify ranked readiness, private owner-email display, profile placement and visitor versus in-game population. Maintenance has explicit menu/browser banners and disabled new-game actions.
- Self-running rooms remove humans only after an entirely idle completed match; one input or chat line retains the seat. Brutal/Uber bots draw individual shop plans, and shield-aware firing/positioning is improved.
- Private persistent analytics collects app activity, linked guest/account visits, release/region context, and match start/completion/abandonment. The standalone report supports date/region/version/mode filters. Unfinished activity does not grant Elo, wins or Embers.
- Routine release automation freezes the approved source, checks builds/tests, uses the exact-SHA Pages artifact, drains and backs up the fleet, applies migrations, verifies matching versions and reopens explicitly. Guest admission smoke tests acquire/release the same game permission as the client.
- Death/voice audition generation is checked in; review audio and browser captures remain local ignored evidence rather than runtime assets.

## Migration and recovery

Upgrade the shared account database explicitly from schema 3 to **6**: ranked device/controller bindings, all-mode ownership tables and a started-participation flag. These migrations are additive; preserve users, credentials, profiles, wallets, ratings and regional outboxes. Analytics uses separate regional/account SQLite files. No season reset is part of this release.

Use the coordinated release entry point in [TOOLS.md](../TOOLS.md#one-command-routine-release). Drain both regions before updating their shared authority, retain consistent private stopped backups and publish only the matching client. Old game handshakes fail closed and require a reload. Never relabel an old schema or overwrite newer account data to make older code start.

## Verification

Source validation covers the complete simulation/network/UI suite, real-TCP match/rematch and cross-region identity flows, release interruption/locking regressions, analytics report tests and all three production builds. Desktop browser checks completed the guided lesson with actual mouse/keyboard input and confirmed maintenance health changes disable queues without sending matchmaking requests. Screenshots/proof are local ignored artifacts. The immutable release runner repeats the full suite and builds before touching production, then records live health/version and optional guest-admission results.

Real public Google login was previously confirmed by the user. Production passkey enrollment/reuse and signed-in cross-device gameplay still require human verification; guest smoke checks do not establish those account flows.
