# Graceful regional updates

Each dedicated region has an independent persistent drain switch. Draining stops new rooms, Quick Play/Ranked reservations and new player-hosted listings. Existing listing heartbeats and game discovery remain available. Existing connected players finish the **whole current match**, including a ranked final brawl. Casual and custom games also finish their current match; there is no forced shutdown timer. Automatic and owner-requested rematches/new match starts are blocked.

A returning player can reconnect to their existing seat using the normal identity checks. New players cannot take spare bot seats during drain. Neither the server nor the client moves an active game to another region. Waiting lobbies and results offer **Choose another region**, which explicitly leaves the old room and returns to the menu. The HUD keeps a small update notice while a match finishes. Region discovery remains healthy/reachable for reconnects and advertises `maintenance.draining`; new-game auto selection skips draining regions.

The menu and game browser refresh regional health about every five seconds. Drained regions show an amber **Maintenance** label and an explicit notice that new server games are paused. Casual and Ranked are disabled for a selected drained region. On Auto, the menu does not silently move a player off their home region (where their last server game was, else the lowest ping): it keeps that region selected as paused and offers **Play on <other region>** for this visit, or waiting until it reopens. Browse stays accessible for discovery, with drained-region join buttons disabled and a maintenance-specific empty state. Server-hosted custom creation is blocked as well; solo/player-hosted options remain separate. Existing-game recovery stays available through Rejoin. Browser evidence covering health propagation, labels, disabled actions and absence of matchmaking requests is retained under ignored `artifacts/live-release/combined-maintenance/`.

## Operator boundary and persistence

Set `MAINTENANCE_SECRET_FILE` in each regional service configuration to a separate random secret of at least 32 characters, stored privately outside Git. Production startup requires this file. Do not reuse browser credentials or expose its contents in shell arguments/logs. The endpoint accepts a bearer token, rejects every request carrying an Origin header, emits no CORS permission and bounds strict JSON writes to 2 KiB.

- `GET /internal/maintenance`: authenticated status.
- `POST /internal/maintenance` with `{"draining":true,"message":null}`: persist drain and broadcast the standard notice.
- `POST /internal/maintenance` with `{"draining":false,"message":null}`: persist reopening and resume eligible waiting lobby countdowns.

An optional custom drain message is plain text, at most 160 characters without control characters. The operator endpoint is for trusted server-side access, normally SSH followed by a loopback request. Public room hosts have no maintenance control.

`DATA_DIR/maintenance.sqlite` uses SQLite WAL with FULL synchronization. A restarted process stays drained until explicitly reopened. Missing/invalid data in an existing maintenance table stops startup; it does not silently reopen a region. Include this database and its WAL in consistent fleet backups. Starting with no data directory permits read-only development status; operator writes require persistent storage.

## Readiness and rollout

Status includes room/human/connection counts, active matches, waiting rooms, creations in progress, pending match settlement, durable rating deliveries, durable Embers deliveries and unacknowledged account claim releases. **`ready:true` requires drain mode, no active match or room creation, and zero pending settlement/deliveries/releases.** Waiting/result screens may remain connected; they have already received the update notice. The count of human players excludes bots, disconnected retained seats and sockets that have not completed their hello, and includes people waiting to replace a bot next round.

Drain every region whose result writer depends on an authority before updating that authority incompatibly. Keep the authority up until regional rating and progression outboxes and account releases are acknowledged. Back up and update the region, verify the exact server version and its required authority paths, then explicitly reopen it. Publish the matching client only when the advertised regions support it. Root release documentation owns the exact fleet commands and build/deployment order.

Do not shut down solely because a timer elapsed. A failed delivery keeps readiness false. Reopening is explicit, and a failed write to the persistent switch fails the operator request. The initial installation on an older server needs its existing empty-game deployment procedure, because that older build has no maintenance endpoint yet.

## Validation

`src/net/maintenance.test.ts` exercises blocked creation/queues/listings, cancelled countdowns, manual host control guards, guest disconnect/reconnect, persistent room notices, five actual ranked rounds plus the tied final, one match settlement, no rematch, and pending reward/release readiness. A slow Elo verdict cannot erase the already captured completion/reward receipt when a player disconnects. Custom bot presets and per-room rule overrides receive no official queue reward. Regional counts include connected waiting players and omit bots, pending hellos and disconnected seats.

`src/net/maintenanceTcp.test.ts` checks the actual loopback HTTP boundary: absent/wrong token, browser Origin, unsupported method/content type, oversized/unknown-field JSON, public drain discovery, persisted mode across a process restart and explicit reopening. It requires local socket permission. The store test also proves malformed persisted state refuses startup. Regional population helpers test exact/partial/unknown totals, and existing Online/region-selection tests remain passing. No live fleet switch was changed during these tests.
