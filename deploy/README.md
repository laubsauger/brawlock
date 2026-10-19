# brawlock dedicated server: deploy kit

This is the dedicated game server (M4.1, `docs/M4.md` §11). One Node process hosts many rooms, and one host serves one **region**.
The prepared runtime uses the unprivileged **brawlock** account under **pm2**, behind **nginx**, which terminates TLS (certbot).

For repeatable releases, verification, backups and rollback, follow [the fleet release checklist](RELEASE.md).
The [operations tool index](TOOLS.md) covers checked-in region configuration, account deployment, website staging and maintenance controls.

This release introduces the dedicated runtime on both hosts and shared global ratings. The first deployment must migrate only the existing US Brawlock app out of root PM2, preserve its database, then start the EU game with a durable outbox. EU authenticated TURN is managed separately. Provisioning alone is not a completed game deployment; verify both running versions after release.

| | |
|---|---|
| Region | `us-west` ("US West") |
| Host | `root@147.182.251.185` (DigitalOcean SFO3, Ubuntu 22.04, Node 22, pm2, nginx, certbot already installed) |
| Domain | `us.brawlock.osc.link` →147.182.251.185; old `brawlock.osc.link` alias retained |
| Europe | `eu.brawlock.osc.link` →167.99.216.102, Amsterdam3 Ubuntu24.04; TLS and runtime prepared |
| App | `/opt/apps/brawlock-server` (`server.mjs`, `version.json`), root:brawlock directory0750 / files0640; PM2 name `brawlock-server` |
| Runtime | system account `brawlock`, home `/var/lib/brawlock`, `PM2_HOME=/var/lib/brawlock/.pm2`, active `pm2-brawlock.service` |
| Protected config | `/etc/brawlock/ecosystem.config.cjs`, root:brawlock0640 under directory0750; regional environment and secret-file paths stay on the host |
| Data | `/opt/apps/brawlock-server/data/leaderboard.sqlite` (+ `-wal`, `-shm`): US canonical leaderboard; EU holds its own durable rating outbox. Directory owned by brawlock0700 / files0600. `deploy.sh` never touches data |
| Port | `127.0.0.1:3077`, reachable only through nginx (UFW stays as it is) |
| URLs | `wss://us.brawlock.osc.link/ws?room=CODE`, `https://us.brawlock.osc.link/health`, `POST /rooms`, `GET /rooms/CODE`, `GET /rooms?public=1`, `POST /quickplay`, `GET /ice`, `GET /leaderboard`, `GET /players/DEVICE`, `POST /listings`, `PUT` / `DELETE /listings/ID` |

The host already runs other production apps. This kit adds **one** nginx site file and **one** pm2 app. It never touches other sites, other pm2 apps, UFW or docker, and it never restarts nginx: it reloads it, and only after `nginx -t` passes.

## How the client uses it

- **Hosting is always an explicit choice.** "Host online" is peer-to-peer. The game server is a second option that shows each region's health and ping. A failure never switches mode by itself: the menu offers the other mode in one click.
- **Joining is automatic.** A room code is looked up on every region that is up (`GET /rooms/CODE`, in parallel), and joined there if one has it. Otherwise it is joined peer-to-peer. Codes carry no region prefix.
- **Public rooms, quick play, player-hosted listings and the leaderboard** (M4.3, `docs/M4.md` §12) are plain HTTP paths under `/`. The nginx site proxies all of `/` already (PUT and DELETE included), so they need no nginx change. Player-hosted (P2P) games are only listed here, the server never connects to them, and they never count for the leaderboard.
- **Regions** come from the client build: `VITE_GAME_SERVERS`, a JSON list of `{"id","label","url"}`. Auto picks the lowest ping among regions that answer `/health` with the same protocol and netcode; Settings > Gameplay can pin a region.

## Files and deployment boundary

- `deploy.sh` builds and transfers **only** `server.mjs` and `version.json`. It reloads or first-starts `brawlock-server` from the protected config as `brawlock`, saves that user's inventory, and checks health. `--setup` also installs this nginx site and obtains the certificate.
- `--dry-run` prints all commands without building, connecting, importing the protected config, or reading secrets.
- `ecosystem.config.cjs` is a **manual provisioning template**, not a deploy artifact. Install the regional copy once at `/etc/brawlock/ecosystem.config.cjs`. Deployment never renders, copies, replaces, or merges it.
- `nginx/site.conf` proxies HTTP APIs on `/` and WebSocket upgrades on `/ws`, with a 1 h read timeout and `X-Forwarded-For` from `$remote_addr`.

Script variables are `DEPLOY_HOST`, `DOMAIN`, `REGION`, `PORT`, and `APP_DIR`, with the US West defaults shown above. `APP_DIR`, `PORT`, and `REGION` must match the protected config or preflight fails. Change `ALLOWED_ORIGINS`, authority credentials, TURN settings, and room limits in that protected config, never through the deploy shell environment.

## Prepare a host once

Provisioning and the one-time root-app migration are manual infrastructure work. The deploy script requires them to be complete and never falls back to root PM2.

1. Install Node 22+, PM2, rsync, and the existing nginx/certbot setup. Create the system account `brawlock` with private home `/var/lib/brawlock` and no login shell.
2. Prepare `/opt/apps/brawlock-server` as root:brawlock0750; code files root:brawlock0640. Only its `data` directory is runtime-writable: brawlock0700, database/outbox files0600. Do not recursively transfer ownership of the app code to the runtime account.
3. Prepare `/etc/brawlock` as root:brawlock0750 and install the ecosystem template as root:brawlock0640. Set its absolute `cwd`, port, origin allowlist, and region. Supply `rating-authority-token` and `turn-secret` there as root:brawlock0640; the live config loads the token from the file and provides `TURN_SECRET_FILE` / JSON `TURN_URLS` to the server. Replace every template placeholder manually.
4. Keep the **existing US SQLite database as the single rating authority**. US sets `RATING_AUTHORITY_URL` to an empty string. EU and subsequent regions set it to the US HTTPS URL and use the same protected server-only token (at least 32 characters). They retain local durable outboxes. Never clone the US database into a second independent ladder, or start EU before its authority token/URL are ready.
5. Enable and start `pm2-brawlock.service` with `WorkingDirectory=/var/lib/brawlock`, `PM2_HOME=/var/lib/brawlock/.pm2`, `UMask=0077`, and `NoNewPrivileges=true`. Its initial inventory may be empty. Leave unrelated PM2 applications/services untouched.
6. If root PM2 already owns `brawlock-server`, coordinate the interruption and back up its bundle/version/config and US data. Stop/delete **only that app** from root PM2 and save root's remaining inventory before deploying as `brawlock`. The script refuses either a running root entry or a saved root entry; it will not perform this migration automatically.
7. Point the region's DNS record at the host, then review and deploy:
   ```sh
   deploy/deploy.sh --dry-run --setup
   deploy/deploy.sh --setup
   ```
   The code transfer uses no archive ownership or permission inheritance, a private transfer umask, then explicit root:brawlock0640 for the two code artifacts. Protected config, data, and other apps are preserved. Nginx is reloaded only after `nginx -t` succeeds.

The deploy SSH identity remains root for protected file ownership and nginx operations. The game process and every app PM2 action run under `brawlock`, from its accessible home with a clean environment. A missing runtime/config/service or conflicting port fails before code transfer.

## Adding a region

Prepare the account, service, protected config/secrets, and authority URL as above, then use the same script with the matching regional values:

```sh
DEPLOY_HOST=root@<ip> DOMAIN=eu.brawlock.osc.link REGION=eu deploy/deploy.sh --dry-run --setup
DEPLOY_HOST=root@<ip> DOMAIN=eu.brawlock.osc.link REGION=eu deploy/deploy.sh --setup
```

Append the region to the client build's `VITE_GAME_SERVERS` list, for example:
`[{"id":"us-west","label":"US West","url":"wss://us.brawlock.osc.link"},{"id":"eu","label":"Europe","url":"wss://eu.brawlock.osc.link"}]`.

`REGION` must equal the client list's `id`; `/health` reports it. Deploy every region from the same revision after netcode changes. TURN is self-managed; `GET /ice` returns time-limited credentials for the configured relay, while its shared secret stays on the servers. Do not replace failed TURN infrastructure with an unreviewed public service.

## Updates

```sh
git push                   # GitHub Pages builds the client
deploy/deploy.sh           # same revision: bundle, code-only rsync, brawlock PM2 reload, health
```

`pm2 reload` restarts the process. Matches running on the server end with "The host closed the game", and players can open a new room at once. Deploy between matches if anyone is playing (`curl -s https://us.brawlock.osc.link/health` shows `players`).

The netcode id is a hash of `src/sim` and `src/net`, so a UI-only Pages deploy keeps the server compatible. After a netcode change, clients of the new build see the region as "other version" until the matching server is deployed. No failure automatically switches a server game to peer-to-peer.

## Operating

After connecting to a host as root, use this helper for **all app PM2 commands**:

```sh
bpm2() {
  (cd /var/lib/brawlock && runuser -u brawlock -- env -i \
    HOME=/var/lib/brawlock USER=brawlock LOGNAME=brawlock \
    PATH=/usr/local/bin:/usr/bin:/bin PM2_HOME=/var/lib/brawlock/.pm2 pm2 "$@")
}
```

| What | Command |
|---|---|
| Logs | `bpm2 logs brawlock-server --lines 100` |
| Status | `bpm2 describe brawlock-server`, `curl -s http://127.0.0.1:3077/health` |
| Private analytics snapshot | From the checkout: `npm run analytics -- --days 30` (requires analytics-enabled account/regional services; SSH credentials stay on the hosts). See [collection semantics and report operation](../docs/ACCOUNTS.md#persistent-operational-analytics). |
| Stop | `bpm2 stop brawlock-server && bpm2 save` |
| Reload protected regional config | `bpm2 reload /etc/brawlock/ecosystem.config.cjs --only brawlock-server --update-env && bpm2 save` |
| Remove this app | `bpm2 delete brawlock-server && bpm2 save`; remove only its nginx site link, then `nginx -t && systemctl reload nginx` |
| US authority backup | Stop Brawlock and copy its SQLite database, WAL, and SHM together into a root-only backup directory before restarting. Preserve regional outboxes separately. Never replace authority data with a stale copy during rollback. |
| Leaderboard top | `curl -s 'http://127.0.0.1:3077/leaderboard?period=all' \| head -c 600` |

Do not run bare `pm2` as root for this app. Avoid printing the live ecosystem or PM2 environment: they contain the server-only authority token. A rollback changes only Brawlock's process/config/code as coordinated; it does not require making secrets world-readable or returning data/code to shared writable ownership.

## Limits (src/net/server.ts, overridable by env)

| Limit | Value |
|---|---|
| Rooms per process | `MAX_ROOMS` (pm2 env: 100). `POST /rooms` answers 503 when full |
| Empty room | closes after 60 s with no connected link |
| Per IP | 6 room creations/min, 60 room lookups/min, 60 WebSocket connects/min, 16 concurrent connections |
| Per connection | 240 messages/s and 128 KB/s sustained (bursts 2×), 64 KB per message; above that the connection is closed |
| Per IP (M4.3) | 60 public-list reads/min, 20 quick plays/min, 60 leaderboard / profile reads/min |
| Player-hosted listings | per IP 6 created/min, 30 heartbeats/min, 3 live; 500 per server; 30 s without a heartbeat drops one; bodies up to 4 KB. In memory: a restart drops them and the hosts list again within ~10 s |
| Origins | `ALLOWED_ORIGINS` (`https://laubsauger.github.io`) for `POST /rooms`, `POST /quickplay`, the WebSocket and CORS reads (`/health` ping, lists, leaderboard). Empty = any |
| Quick play | `QUICKPLAY_SEATS` (10): humans per room at most. `QUICKPLAY_BOT_FILL` (10): bots fill the table until replaced between rounds. `QUICKPLAY_BOTS` (`brutal`): default difficulty. Gold defaults: 40 starting, 12 per round, 2 per kill, 3 per win. Seat/fill/difficulty overrides belong in the protected `/etc/brawlock/ecosystem.config.cjs` `env` |

## Bandwidth (DigitalOcean)

The default netcode is the input stream (PLAN §4.4). A server room costs about this much downlink per player, measured payload at 10 % loss; on the wire add ~70 B per packet:

| Room | Per player |
|---|---|
| 2 players | ~2 KB/s, ~4 KB/s on the wire |
| 4 players | ~4.3 KB/s, ~7.5 KB/s on the wire |
| 8 players | ~7.5 KB/s, ~11 KB/s on the wire |

That works out to roughly **15-40 MB per player-hour**:
- 100 players playing 2 h a day each ≈ 90-240 GB/month, inside a droplet's included transfer.
- Snapshot mode (`?net=snapshot`, the fallback) is 150-300 KB/s per player, ~0.5-1 GB per player-hour. Keep it a fallback.

The region ping is one small `/health` request per region every 5 s while the menu is open.

## Without a domain

`DOMAIN=147-182-251-185.sslip.io deploy/deploy.sh --setup` works the same way (sslip.io resolves to the IP). Let's Encrypt rate limits for the shared sslip.io domain may be hit, so the own subdomain is preferred.

## Local

```sh
npm run server -- --demo ABCDE --bots hard,medium   # a self-starting room with bots, prints the join link
npm run server:build && PORT=3077 REGION=us-west node dist-server/server.mjs   # the production bundle
```

A dev client uses a local server with `?server=ws://127.0.0.1:5350` (one region named "Test server").

## Authenticated TURN operations

EU coturn is managed by `coturn.service`, separately from the game PM2 process. It uses ephemeral HMAC credentials issued by either region at `GET /ice`; the shared static secret is stored only in protected host files. The game process reads `/etc/brawlock/turn-secret`, and coturn reads its own group-protected configuration. Never print these files or PM2 environments into diagnostics.

Public relay listeners: UDP/TCP3478 and TLS/TCP5349. The bounded relay allocation range is UDP49160–49279 (120 ports), with total allocation quota96 and per-credential quota32; this allows a ten-player P2P star to gather candidates on all three transports. Memory192MB, per-allocation64KiB/s and aggregate6MiB/s per direction remain bounded. Private, loopback, link-local and metadata peer destinations are denied. Anonymous Allocate is rejected.

TLS uses protected copies of the EU domain certificate and a domain-scoped certbot renewal hook. Verify service enablement, listeners, firewall and renewal after changing the host. Test real relay payloads, not just Allocate success; a deny rule can permit allocations yet block all peer traffic. In particular, coturn4.6.1 interprets a bare IPv6 `::` denied-peer entry as a wildcard that also blocks public IPv4 peers; use precise IPv6 ranges.

Forced browser relay tests passed on UDP, TCP and TLS from a phone hotspot, including an unreliable data channel and relay candidates at both ends. Repeat them after relay/secret/certificate changes. Keep test credentials short-lived, local and out of Git.

Capacity proof:54 simultaneous authenticated allocations (host27, nine guests×3;18each UDP/TCP/TLS) forwarded54 test payloads and were all explicitly released. Coturn reserves `max-bps` against `bps-capacity` when admitting allocations: a2MiB aggregate budget with256KiB per allocation admits only8 regardless of the allocation quota. Keep these values coherent when tuning capacity.
