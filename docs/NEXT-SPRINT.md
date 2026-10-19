# Release status and next sprint

Release **`38a2f766fb5b`** is deployed, 2026-10-19. The commit is pushed, [Pages publication succeeded](https://github.com/laubsauger/brawlock/actions/runs/39255949401), and both regional game bundles match network ID `6680ad54ec7e`, protocol 8. US West and Europe are open; the shared account authority runs schema 6. See [the combined rollout receipt](../deploy/releases/2026-10-19-38a2f766fb5b.md).

[The main game](https://brawlock.osc.link/) now serves the root-path client and matching version. Its public provider configuration advertises Google; anonymous `/api/account` correctly returns 401. Heavy media remains on GitHub Pages. The explicitly authorized old-rating/history and regional-outbox season reset is complete, preserving the new account records and credentials. There is no separate legacy ladder or device-rating import.

The user confirmed a real public Google login worked. Follow-up account onboarding, Ranked readiness, menu-inclusive population, private analytics, universal game ownership, guided practice and match-progress browsing are live. **Still human-unverified:** production passkey enrollment/reuse and signed-in gameplay across both regions.

## Shipped accounts and ranked identity

The release includes provider/passkey UI, globally unique editable player names/colors, server-verified ranked admission, account-keyed global Elo, and global ranked occupancy with reconnect and regional-generation cleanup. Immutable account IDs own ratings, names and progression across machines; browser device IDs do not prove ownership. Successful renames release the previous name atomically without moving the account or its currency. Casual guests remain supported.

The existing ranked format remains eight players, five scoring rounds and a final brawl when needed. Casual Quick Play and custom matches retain their separate formats. Details: [ACCOUNTS.md](ACCOUNTS.md), [ACCOUNT-IDENTITY-PLAN.md](ACCOUNT-IDENTITY-PLAN.md), [RANKED-FORMAT.md](RANKED-FORMAT.md) and [STATIC-HOSTING.md](STATIC-HOSTING.md).

## Shipped Embers and collection

Embers are account-owned cosmetic currency, independent of Elo and match shop gold. Only fixed-rule official Quick Play/Ranked matches qualify; official casual bot games can qualify without an Elo opponent. Custom games and replay viewing cannot manufacture rewards.

Policy 1 pays **20 completion + up to 5 for round wins + 5 for a match win**. Eligibility requires a completed human-controlled seat, at least two rounds, 30 seconds alive, five casts and either 100 damage or 500 walked game units in a match lasting at least 120 seconds. The completion base exceeds all bonuses combined. There is no daily cap or streak penalty. Regional durable outboxes and authority receipts prevent duplicate credits; clients never submit balances or reward amounts.

The four-item catalog has two additional victory poses and two cloth palettes. Three appear each shared UTC day. Ownership is permanent; purchases check the current offer, server price, balance and ownership atomically, with retry keys preventing duplicate charges. Original robes and the original celebration mix stay free. Verified admission supplies equipped presentation for the next game.

The menu has a signed-in Collection/balance shortcut; results show confirmed reward breakdowns and a count-up. Durably pending delivery and an inability to save are distinct, with explicit retry and no optimistic credit. See [PROGRESSION.md](PROGRESSION.md). Payments, premium currency, hats, new character meshes and a larger customization editor remain later work.

## Shipped visual and deterministic finish

The scene-linear grade opens stone/cloth midtones in the existing output shader while retaining ACES exposure 1.05, colored highlights and the warm lava/cool floor separation. It adds no render pass, texture or geometry; DOM HUD/text stays outside the grade. Fixed low/medium/high captures and bounded measurements are in [COLOR-GRADING.md](COLOR-GRADING.md). Actual HDR-display output remains separate future work.

Bot transcendental math now uses deterministic `sim/math.ts`, guarded against engine-dependent calls. Node/Chrome comparisons matched **21,600 state hashes and input frames** across two seeded 180-second eight-bot runs. A paired 500-game calibration moved difficulty estimates by less than four Elo points. `BOT_ELO` was re-measured on 2026-10-19, after Brutal and Uber moved to per-bot shop builds (Easy 400, Medium 1000, Hard 1600, Brutal 1825, Uber 2000; table in [PLAN.md](PLAN.md) §7).

## Shipped maintenance and release evidence

Persistent authenticated regional drain blocks new rooms, reservations, listings and rematches while existing players finish their whole current match and reconnect to their own seats. This includes casual/custom matches and ranked final brawls; there is no forced shutdown timer or silent region migration. Readiness accounts for match settlement, rating/Embers outboxes and pending account releases. See [MAINTENANCE.md](MAINTENANCE.md).

The current frozen release passed **1,480 tests across 145 files**, 20 release/analytics checks, all builds and live guest admission/cleanup in both regions. The final guided-practice and maintenance desktop checks passed. Earlier Node/Chrome parity, grade/cosmetic rendering and production bot-fight proofs remain recorded with their original release; the human account flows listed above remain unverified.

The [one-command release automation](../deploy/TOOLS.md#one-command-routine-release) completed this live fleet rollout: frozen source, coordinated drains, stopped backups, additive migration, exact-revision publication and guest proof. Its canonical-path resume recovered a macOS verifier-path issue without replacing backups or relabeling source. The operator follow-up makes paths canonical by default; ten release regressions and eleven analytics checks pass. This tool is the routine release entry point.

## Next sprint: partial combat activity

Consider recording combat activity from aborted games and players who leave, independently of completed-match results. Use separate idempotent activity checkpoints covering only human-controlled intervals, so reconnects/retries cannot duplicate counters and bot-controlled time cannot be attributed to the player.

Unfinished matches must grant **no Elo, match wins or Embers**. Preserve that boundary rather than presenting partial activity as a completed match. Checkpoint cadence, eligible counters, retention and UI labeling still need a scoped design; implementation is deferred to the next sprint.
