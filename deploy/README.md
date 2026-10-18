# brawlock dedicated server: deploy kit

This is the dedicated game server (M4.1, `docs/M4.md` §11). One Node process hosts many rooms, and one host serves one **region**.
It runs under **pm2** behind the host's existing **nginx**, which terminates TLS (certbot).

| | |
|---|---|
| Region | `us-west` ("US West") |
| Host | `root@147.182.251.185` (DigitalOcean SFO3, Ubuntu 22.04, Node 22, pm2, nginx, certbot already installed) |
| Domain | `brawlock.osc.link` (A record → 147.182.251.185, live) |
| App | `/opt/apps/brawlock-server` (`server.mjs`, `ecosystem.config.cjs`, `version.json`), pm2 name `brawlock-server` |
| Data | `/opt/apps/brawlock-server/data/leaderboard.sqlite` (+ `-wal`, `-shm`): the casual leaderboard. `deploy.sh` never touches it |
| Port | `127.0.0.1:3077`, reachable only through nginx (UFW stays as it is) |
| URLs | `wss://brawlock.osc.link/ws?room=CODE`, `https://brawlock.osc.link/health`, `POST /rooms`, `GET /rooms/CODE`, `GET /rooms?public=1`, `POST /quickplay`, `GET /leaderboard`, `GET /players/DEVICE`, `POST /listings`, `PUT` / `DELETE /listings/ID` |

The host already runs other production apps. This kit adds **one** nginx site file and **one** pm2 app. It never touches other sites, other pm2 apps, UFW or docker, and it never restarts nginx: it reloads it, and only after `nginx -t` passes.

## How the client uses it

- **Hosting is always an explicit choice.** "Host online" is peer-to-peer. The game server is a second option that shows each region's health and ping. A failure never switches mode by itself: the menu offers the other mode in one click.
- **Joining is automatic.** A room code is looked up on every region that is up (`GET /rooms/CODE`, in parallel), and joined there if one has it. Otherwise it is joined peer-to-peer. Codes carry no region prefix.
- **Public rooms, quick play, player-hosted listings and the leaderboard** (M4.3, `docs/M4.md` §12) are plain HTTP paths under `/`. The nginx site proxies all of `/` already (PUT and DELETE included), so they need no nginx change. Player-hosted (P2P) games are only listed here, the server never connects to them, and they never count for the leaderboard.
- **Regions** come from the client build: `VITE_GAME_SERVERS`, a JSON list of `{"id","label","url"}`. Auto picks the lowest ping among regions that answer `/health` with the same protocol and netcode; Settings > Online can pin a region.

## Files

- `deploy.sh` builds the bundle, rsyncs it, then runs pm2 `reload` (or `start` the first time), `save`, and a health check. `--setup` also installs the nginx site and gets the certificate. `--dry-run` prints every step and changes nothing on the host (it still builds locally).
- `ecosystem.config.cjs` is the pm2 app. `deploy.sh` fills in the `__PORT__`, `__ORIGINS__` and `__REGION__` placeholders.
- `nginx/site.conf` is the site for the subdomain: HTTP API on `/`, WebSocket upgrade on `/ws` with a 1 h read timeout, and `X-Forwarded-For` from `$remote_addr` (used by the per-IP rate limits).

All host-specific values are variables with the US West defaults: `DEPLOY_HOST`, `DOMAIN`, `REGION`, `PORT`, `APP_DIR`, `ALLOWED_ORIGINS`.

## First time

1. **Check the port is free** (`deploy.sh` checks it again):
   `ssh root@147.182.251.185 "ss -ltn 'sport = :3077'"` should print only the header line.
2. **Commit and push** the netcode first. The server refuses clients of another netcode, so it has to be built from what GitHub Pages serves.
3. **Deploy and set up:**
   ```sh
   deploy/deploy.sh --dry-run --setup   # read what it will do
   deploy/deploy.sh --setup
   ```
   This creates `/opt/apps/brawlock-server`, copies the bundle, runs `pm2 start` and `pm2 save` (pm2's startup hook already exists on the host), writes `/etc/nginx/sites-available/brawlock.osc.link` and links it, runs `nginx -t`, then `systemctl reload nginx` and `certbot --nginx -d brawlock.osc.link --redirect`.
4. **The client build** already lists the region in `.github/workflows/deploy.yml`:
   ```yaml
         - run: npm run build
           env:
             VITE_GAME_SERVERS: '[{"id":"us-west","label":"US West","url":"wss://brawlock.osc.link"}]'
   ```
   Until step 3 has run, the game shows US West as offline and greys out hosting on it. Peer-to-peer play is unaffected. To hide the server option entirely, remove the `env` lines.

## Adding a region

A second region is config only:

1. A host with Node 22+, pm2 (`npm i -g pm2 && pm2 startup`), nginx (Debian `sites-enabled` layout), certbot with the nginx plugin, and rsync. `deploy.sh` checks for these first.
2. A DNS A record, e.g. `eu.brawlock.osc.link → <ip>`.
3. The same script with that host's values:
   ```sh
   DEPLOY_HOST=root@<ip> DOMAIN=eu.brawlock.osc.link REGION=eu deploy/deploy.sh --dry-run --setup
   DEPLOY_HOST=root@<ip> DOMAIN=eu.brawlock.osc.link REGION=eu deploy/deploy.sh --setup
   ```
4. Append the region to `VITE_GAME_SERVERS` and push:
   `[{"id":"us-west","label":"US West","url":"wss://brawlock.osc.link"},{"id":"eu","label":"Europe","url":"wss://eu.brawlock.osc.link"}]`

`REGION` must equal the `id` in the list; `/health` reports it. After a netcode change, deploy every region from the same commit.

## Updates

```sh
git push                   # GitHub Pages builds the client
deploy/deploy.sh           # same commit: bundle, rsync, pm2 reload, health
```

`pm2 reload` restarts the process. Matches running on the server end with "The host closed the game", and players can open a new room at once. Deploy between matches if anyone is playing (`curl -s https://brawlock.osc.link/health` shows `players`).

The netcode id is a hash of `src/sim` and `src/net`, so a UI-only Pages deploy keeps the server compatible. After a netcode change, clients of the new build see the region as "other version" until `deploy.sh` runs, and they host peer-to-peer meanwhile.

## Operating

| What | Command |
|---|---|
| Logs (JSON lines: `room.created`, `ws.join`, `room.closed`, `*.limited`; IPs as salted hashes) | `ssh root@147.182.251.185 pm2 logs brawlock-server --lines 100` |
| Status | `pm2 describe brawlock-server`, `curl -s http://127.0.0.1:3077/health` |
| Stop | `pm2 stop brawlock-server && pm2 save` |
| Remove | `pm2 delete brawlock-server && pm2 save`, `rm /etc/nginx/sites-enabled/brawlock.osc.link`, `nginx -t && systemctl reload nginx` |
| Leaderboard backup | `cp /opt/apps/brawlock-server/data/leaderboard.sqlite* /root/` while the app is stopped; or copy it as is (WAL keeps the last committed match) |
| Leaderboard top | `curl -s 'http://127.0.0.1:3077/leaderboard?period=all' \| head -c 600` |

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
| Quick play | `QUICKPLAY_SEATS` (10): humans per room at most. `QUICKPLAY_BOT_FILL` (10): bots fill the table until replaced between rounds. `QUICKPLAY_BOTS` (`brutal`): default difficulty. Gold defaults: 40 starting, 12 per round, 2 per kill, 3 per win. Seat/fill/difficulty overrides belong in `ecosystem.config.cjs` `env` |

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
