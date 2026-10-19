# Current sprint: accounts, progression and visual finish

Status, 2026-10-19: this is the upcoming combined release. The work below is local unless explicitly identified as previously shipped. **The account/domain release has not been deployed.**

## Accounts and the fresh ranked season

Implemented locally: provider/passkey account UI, globally unique names and editable names/colors, server-verified ranked admission, account-keyed Elo identity, global ranked occupancy with explicit reconnect/generation cleanup, and shared account progression. Guests can still play casually. See [ACCOUNTS.md](ACCOUNTS.md) and [ACCOUNT-IDENTITY-PLAN.md](ACCOUNT-IDENTITY-PLAN.md) for the actual boundaries.

The user approved the first-party game/auth origin `https://brawlock.osc.link`, keeping heavy media on GitHub Pages and redirecting its old entry page. The supplied Google credentials and separate auth-service configuration are provisioned privately on US. A real Google login through the public HTTPS origin remains unverified; provider setup is not a deployment receipt.

The user's later **wipe old ratings and match history** instruction supersedes the earlier plan to preserve a legacy ladder. Start the new account season without device-rating adoption or an import. Keep the new accounts, reserved names, provider credentials and session secrets. A private operational backup is fine. No live reset/cutover has occurred.

Still required: combined real-TCP ranked admission/reconnect/result proof, matching first-party/fleet packages and proxy configuration, authorized reset at cutover, and public Google/passkey/two-region verification. [STATIC-HOSTING.md](STATIC-HOSTING.md) separates prepared packaging from live publication.

## Embers and the daily cosmetic selection

Implemented locally: the account authority's versioned reward ledger, idempotent match receipts, permanent ownership, atomic purchases/equipment and a small Collection dialog. Regions persist completed official-match receipts in a durable outbox. Clients never submit balances, reward amounts or trusted account IDs. Official casual bot games can earn rewards independently of Elo; custom games and replay viewing cannot.

Policy 1 pays **20 completion + up to 5 for round wins + 5 for a match win**. Meaningful participation requires a completed human-controlled seat, at least two rounds, 30 seconds alive, five casts and either 100 damage or 500 walked game units in a match lasting at least 120 seconds. The completion base exceeds all bonuses combined. There is no daily cap or streak penalty.

The explicit four-item catalog contains two additional victory poses and two restrained cloth tints. Three appear each shared UTC day; ownership persists after refresh. Original robes and the original three-celebration mix remain free. Purchases check offer/version, server price, balance and ownership atomically; retry keys prevent duplicate charges and SQLite serializes concurrent purchases. Verified admission supplies presentation equipment for the next game.

The menu shows a discreet signed-in balance/Collection entry. Results fetch confirmed rewards by match ID, display the base/bonus breakdown and count into the balance. Pending durable delivery and a failure to save are distinct; retry is explicit, with no indefinite polling or optimistic credit. See [PROGRESSION.md](PROGRESSION.md).

Focused SQLite/pose tests and DOM menu/results/collection proofs pass locally, including a failed purchase retry retaining its request ID. Final release gates still include authenticated cross-region result delivery, recovery and cosmetic appearance in the combined game. Paid currency, payments, hats, new character models and a broad customization editor remain later work.

## Ranked format already shipped

The shorter eight-player ranked format shipped in `a03358d76509`; see [RANKED-FORMAT.md](RANKED-FORMAT.md). It uses the fixed five-round format and final brawl rather than an unbounded first-to-five loop. Casual Quick Play and custom games retain their separate flexible formats. Do not reimplement the ranked format in the account sprint.

## Tone mapping and color grading

Implemented and proven locally: a scene-linear grade fused into the existing output shader, opening stone/cloth midtones while retaining ACES exposure 1.05, colored emissive highlights and the warm lava/cool floor separation. No additional render pass, texture, geometry or draw submission is introduced; DOM HUD/text remains outside the grade. This is SDR finishing, not actual HDR-display output.

Fixed arena, combat, oblique menu-like and winner compositions were compared on low/medium/high at the same resolution. Captures, luminance/white-pixel/HUD checks and bounded throughput measurements are documented in [COLOR-GRADING.md](COLOR-GRADING.md). The measurements are from a contested development machine and do not claim a precise standalone GPU cost. Final combined-build visual review, including the new cosmetics, remains a release gate.

## Bot determinism in Node and Chrome

Implemented locally: bot transcendental math now goes through `sim/math.ts`, including deterministic `asin` and `hypot`; a guard rejects engine-dependent bot `Math.*` calls. This addresses seeded matches that previously drifted between Node and Chrome after roughly 60–150 seconds. Live authority-driven bot input distribution is unchanged.

The local parity receipt at `/private/tmp/brawlock-bot-parity-20261019/receipt.json` compares **10,800 state hashes and input frames per run**, covering 180 seconds of eight Uber bots (seed 11) and eight Brutal bots (seed 7) in Node 24 and Chrome 155. Both runs match. A paired 500-game calibration changed estimated difficulty ratings by less than four Elo points, so `BOT_ELO` remains unchanged. Preserve this evidence with the release artifacts; it is local verification, not proof of the deployed build.

## Graceful regional maintenance and coordinated releases

Implemented locally: persistent authenticated per-region drain; creation/reservation/start/rematch guards; verified existing-seat reconnects; waiting/HUD/result notices; and readiness counts covering match settlement, rating/Embers outboxes and account releases. See [MAINTENANCE.md](MAINTENANCE.md) for operator configuration and acceptance evidence. Fleet deployment scripts/provisioning are coordinated in the release workstream.

Still to complete: authenticated per-region drain controls, discovery/queue/in-game status and an exercised coordinated release path. Draining must stop new games, reservations and automatic rematches while retaining existing players' reconnects and allowing active games/results to finish. Ranked final brawls and both rating/progression outboxes must settle. Define the casual drain behavior explicitly; do not introduce a blind kill timer or silently move an active match to another region.

Operators need live room/player counts, pending result counts and a clear ready-to-update condition. Ordinary hosts and browsers must not gain maintenance authority. Persist mode/outboxes through restart as designed. Waiting lobbies need clear next steps and an optional compatible region; changing region requires the player's action.

The combined release gate must exercise unauthorized control rejection, no new admissions/rematches, reconnect during drain, completion and exactly-once settlement, an interrupted delivery, reopen and rollback. Drain and settle regions before an incompatible authority update; back up, update and verify dependencies in order. Publish the client/version notice only when its media and advertised regions support it. Root release documentation/pipeline work is still in progress; no deployment completion is claimed here.
