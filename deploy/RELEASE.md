# Fleet release checklist

Use this for routine releases; [README.md](README.md) covers provisioning and limits.
For ping investigations, use [performance diagnostics](../docs/PERFORMANCE-DIAGNOSTICS.md).
For the public-profile upgrade, follow the [authority/outbox compatibility notes](../docs/PLAYER-PROFILES.md#storage-and-rollout) before deploying or rolling back.
For the account/domain release, use the [first-party app / Pages media plan](../docs/STATIC-HOSTING.md), [account-service provisioning](../docs/ACCOUNTS.md) and the coordinated steps below. The prepared workflow publishes Pages media/redirects and retains the matching first-party client artifact.
Latest deployed rollout: **v0.1.0-alpha.8**, commit `7efb8d65a323`, netcode `ba224ec8921d`, protocol `8`. See the [alpha.8 release record](releases/2026-10-21-alpha8.md); verify live state before another release. Earlier cutovers remain documented below.

## Account/domain cutover

Deployed on 2026-10-19: the first-party website, shared US account service (schema 3), and matching US/EU game servers are active at revision `f97de56b685b`. Pages run `39193099814` published matching media and legacy redirects; both regions passed guest admission and cleanup without entering combat. Google provider configuration is reachable, and private account RPC refuses unauthenticated callers. Real public Google sign-in and passkey enrollment/sign-in remain unverified by a real user. The numbered cutover below documents the initial migration; routine releases must not repeat its season reset.

1. Finish all source changes and run the full regression suite, typecheck, client/server/auth builds and focused desktop checks. Freeze the approved revision and retain hashes. The new protocol is 8; an older client cannot play on the new servers.
2. Verify protected regional settings: US `ACCOUNTS_AUTHORITY_URL=http://127.0.0.1:5352`, EU `https://us.brawlock.osc.link`, both using the existing protected server credential. Both need a separate root:brawlock0640 `MAINTENANCE_SECRET_FILE`; include the first-party game origin in `ALLOWED_ORIGINS`. Do not print or overwrite secrets. The checked-in ecosystem file is a provisioning template, never a deploy input.
3. Back up stopped game data consistently on both regions. For this one explicitly authorized fresh season, retire **only** US `leaderboard.sqlite` and EU `rating-outbox.sqlite`, including matching WAL/SHM files, into private backups. Old pending submissions must not repopulate the new season. Preserve `accounts.sqlite`, its WAL/session secret, newly created accounts, cosmetic wallets and credentials. This reset is a one-time cutover operation, never a routine deploy step.
4. Build auth with `npm run accounts:build`; `deploy/accounts.sh` installs its reviewed bundle, runs the explicit additive migration and starts/restarts only `brawlock-accounts`, then saves the non-root PM2 inventory. Back up auth consistently before future schema updates. Its Google/session/region secret files remain on US.
5. Deploy and verify matching US/EU game bundles from the frozen revision. On this first release, maintenance controls are unavailable in the old runtime: require zero active humans/matches before stopping it. Subsequent releases use drain mode below. Verify shared account admission and fresh account-only ratings before publishing the client.
6. Build the root client with `GITHUB_SHA` set to the exact source SHA, both `VITE_GAME_SERVERS`, `VITE_ACCOUNTS_ENABLED=true`, and `VITE_ASSET_BASE_URL=https://laubsauger.github.io/brawlock/`; pass `--base=/`. Run `node scripts/package-client.mjs dist NEW_PACKAGE_DIR`. The package contains `web/`, `pages/` and `hosting.json` with one build ID. Stage with `deploy/web.sh PACKAGE_DIR BUILD_ID --stage-only`.
7. Publish the matching Pages media/redirect package and verify CORS/range/media paths. Install the reviewed [first-party nginx site](web.nginx.conf) at the existing Brawlock site only, run `nginx -t`, then reload nginx. Activate the staged app with `deploy/web.sh PACKAGE_DIR BUILD_ID --activate-staged`. Keep prior releases/assets for rollback. Do not add a blanket Pages redirect or move heavy assets onto the droplet.
8. Verify the published app/version, region compatibility, real Google sign-in/callback, unique name claim/rename, passkey enrollment/sign-in, casual guests, account-only ranked, cross-device rejoin, shared ratings, earned rewards and cosmetic ownership. Browser access is needed for the real provider login; dummy OAuth fixtures do not establish that proof.

The website helper changes only the `/var/www/brawlock/current` symlink after checking the uploaded version. It never changes nginx, credentials or game processes. A failed/staged upload does not activate automatically. SSH/rsync must use the pinned known-host trust described below.

## Graceful updates after this release

Use the operator helper over SSH; it reads the separate maintenance credential **on the remote host**, without putting it into local command arguments:

```sh
deploy/maintenance.sh drain
deploy/maintenance.sh status
DEPLOY_HOST=root@167.99.216.102 deploy/maintenance.sh drain
DEPLOY_HOST=root@167.99.216.102 deploy/maintenance.sh status
```

Drain stops new games/reservations and all next-match starts. Existing whole matches finish, including ranked final brawls; returning players can reconnect. The ready condition requires no active/creating matches, no result settlement and no pending rating/reward/release deliveries. Wait for `ready: true` before stopping a region. Do not turn an interrupted authority delivery into a second independent ladder or discard its outbox. Maintenance state persists across restart, so verification happens while new games remain paused.

Update and verify each region in dependency order, then publish the matching client/version only when both advertised regions support it. Reopen explicitly after verification:

```sh
deploy/maintenance.sh reopen
DEPLOY_HOST=root@167.99.216.102 deploy/maintenance.sh reopen
```

For rollback, retain current account/game databases and outboxes, restore the verified compatible code/config/client pair, and check schema/protocol support before reopening. Never restore a stale account backup over newer users or purchases. Keep both the first-party app and corresponding Pages media available until rollback is no longer needed.

## Fleet and protected state

| Region | SSH host | Public domain | Ratings |
|---|---|---|---|
| `us-west` | `root@147.182.251.185` | `us.brawlock.osc.link` | Single canonical authority |
| `eu` | `root@167.99.216.102` | `eu.brawlock.osc.link` | US-backed reads; durable local delivery outbox |

- Both run only `brawlock-server` as `brawlock`, under enabled/active `pm2-brawlock.service`; Node listens on `127.0.0.1:3077` behind nginx TLS.
- Run PM2 commands from `/var/lib/brawlock` with that `HOME`; PM2 uses `/var/lib/brawlock/.pm2`. The Node app's `cwd` is `/opt/apps/brawlock-server`. The unit has `UMask=0077` and `NoNewPrivileges=true`.
- Code directory `/opt/apps/brawlock-server`: root:brawlock0750; bundle/version root:brawlock0640. Runtime-writable `data`: brawlock0700, files0600.
- `/etc/brawlock` is root:brawlock0750; ecosystem config, `rating-authority-token` and `turn-secret` are root:brawlock0640. Deploy never replaces them.
- US has empty `RATING_AUTHORITY_URL`; EU points to `https://us.brawlock.osc.link`. Both use the same protected authority token and TURN secret. EU never becomes an independent leaderboard when US is unavailable.
- Migration postcondition: neither live nor saved root PM2 inventory contains Brawlock. If preflight rejects this, stop and arrange targeted migration; never bypass it or fall back to root.
- EU `coturn.service` is separate: authenticated UDP/TCP3478, TLS/TCP5349, relay UDP49160–49279. Keep its certificate renewal, quotas and private-destination denials intact.
- SSH trust: script SSH and rsync use standard OpenSSH config/known-hosts; there is no deploy SSH-options flag. Before a new operator deploys, compare `ssh-keygen -lf <verified-host-key-file>` fingerprints with an independent trusted provider console, then add only those verified public entries for both IPs to durable `~/.ssh/known_hosts` (preserve unrelated entries).
- The current rollout's pinned file under `/private/tmp/brawlock-eu-infra-audit/known_hosts` is temporary, not a durable trust store. Check existing entries with `ssh-keygen -F <ip>`; verify any changed key independently before replacing its matching entry. Never trust blind `ssh-keyscan` output or disable host-key checking.

## Freeze and verify the approved revision

1. Confirm release authorization and the exact approved commit. Preserve unrelated dirty work; do not deploy whatever happens to be in a changing shared workspace.
2. In the approved release source directory, review `git status --short` and `git rev-parse HEAD`. Resolve changes deliberately before freezing; never discard someone else's work to make a gate green.
3. Run the gates below against that same tree. Review failures rather than skipping prediction/network tests. Browser checks cover desktop play and responsive menu access; touch-only devices cannot play.

```sh
npm ci
npm test
npm run build
npm run server:build
cat dist-server/version.json
shasum -a 256 dist-server/server.mjs dist-server/version.json
```

4. Retain the approved revision, gate results and artifact hashes in the release record. Freeze source through both regional deployments and the Pages build.
5. `deploy.sh` rebuilds on every invocation; it has no artifact-only/skip-build flag. Run it only from the unchanged approved tree. Compare rebuilt bundle hashes and version `commit`/`net`; `built` timestamps can differ. Never relabel a dirty build as approved.
6. Read both public `/health` responses and coordinate any interruption: PM2 reload ends active matches. Back up persistent state before changing the runtime or schema.

## Back up consistently; operate under the right identity

After SSH as root, define this helper; use it for every Brawlock PM2 action:

```sh
bpm2() {
  (cd /var/lib/brawlock && runuser -u brawlock -- env -i \
    HOME=/var/lib/brawlock USER=brawlock LOGNAME=brawlock \
    PATH=/usr/local/bin:/usr/bin:/bin PM2_HOME=/var/lib/brawlock/.pm2 pm2 "$@")
}
```

For a consistent stopped backup on **each** host, confirm the app stopped before copying:

```sh
backup_dir=/root/brawlock-backups/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$backup_dir"
bpm2 stop brawlock-server
cp -a /opt/apps/brawlock-server/data "$backup_dir/data"
cp -a /opt/apps/brawlock-server/server.mjs /opt/apps/brawlock-server/version.json /etc/brawlock/ecosystem.config.cjs "$backup_dir/"
bpm2 restart /etc/brawlock/ecosystem.config.cjs --only brawlock-server --update-env
bpm2 save
```

US `leaderboard.sqlite` and EU `rating-outbox.sqlite`, including any WAL/SHM files, must stay consistent together. Never copy only a live SQLite main file. Keep backups private and preserve secret files through the existing protected backup process; never print their contents.

## Deploy US, then EU, then confirm Pages

From the frozen approved source, review dry runs first; no remote/build work happens with `--dry-run`:

```sh
deploy/deploy.sh --dry-run
DEPLOY_HOST=root@167.99.216.102 DOMAIN=eu.brawlock.osc.link REGION=eu deploy/deploy.sh --dry-run
```

```sh
deploy/deploy.sh
```

Verify US authority health and the approved commit/net before proceeding to EU:

```sh
DEPLOY_HOST=root@167.99.216.102 DOMAIN=eu.brawlock.osc.link REGION=eu deploy/deploy.sh
```

Routine updates do not use `--setup`; that option is for initial nginx/certificate setup. Supported script environment overrides are `DEPLOY_HOST`, `DOMAIN`, `REGION`, `PORT`, `APP_DIR`; protected regional settings stay in the host config.

GitHub Pages uses [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): `main` pushes or manual dispatch build the root-path client with Node 24, accounts, the Pages media base and both `us-west`/`eu` entries. It publishes `client-package/pages` and uploads the matching `first-party-client` artifact. Verify its source SHA matches the approved release; activate only that app package. Do not publish a later moving branch accidentally; confirm the actual deployment succeeded, not merely that a push completed.

## Post-release proof and recovery

- Check local and public `/health` on both regions: `ok`, expected region/protocol, and `build` equal the approved netcode. Compare remote `version.json` commit/net and bundle hash to the release artifacts; health alone does not prove the commit.
- Check `bpm2 status`, process owner, saved Brawlock inventory and `systemctl is-enabled pm2-brawlock` / `systemctl is-active pm2-brawlock`. Check `coturn` similarly on EU. PM2 autorestart, memory limits and saved inventory provide process/reboot recovery; do not reboot production to test this.
- Read `/leaderboard?period=all` and a known authenticated player's profile through both regions; compare global entries after caches settle. Routine updates preserve history; only the explicitly approved initial account-season cutover resets old device history. Confirm EU outbox retries recover after authority availability. Never create a second ladder or inject fake production rating results for a smoke test.
- In the published desktop browser, verify both region pings/version compatibility, casual public creation/join, ranked queue and room-code routing. Touch-only users can browse menus but cannot reserve a seat.
- Validate `GET /ice` from both regions without logging credentials. Force browser relay-only data channels over UDP, TCP and TLS; require relay candidates **and bidirectional payload delivery**, preferably across separate networks. Anonymous TURN allocation must fail. Do not substitute an unreviewed public relay.
- Inspect targeted app/nginx/TURN errors and certificate renewal state. Never dump PM2 environments, live ecosystem contents, bearer tokens, TURN credentials or private backups into logs, screenshots or Git.
- If rollback is needed, stop only Brawlock, retain current data/outboxes and restore the previously verified code/config pair with the same private ownership. Confirm the old runtime supports the current schema and unprivileged account before restarting; otherwise stop for a reviewed recovery plan. Never blindly restore stale authority data over newer ratings.
- Recheck both regions, Pages compatibility, global ratings and ICE after rollback. Keep failures and exact recovered versions in the release record. Never restart unrelated US apps, root PM2, nginx globally, Docker, or the host; nginx changes require `nginx -t` before a targeted reload.

## Routine release entry point

Use `node deploy/release.mjs --revision APPROVED_SHA` to review the concrete plan, then add `--apply` for the coordinated routine release. This replaces the manual orchestration above for the already-provisioned fleet; the checklist still explains the gates and recovery constraints. See [TOOLS.md](TOOLS.md#one-command-routine-release) for prerequisites, the non-secret region configuration, optional empty-fleet admission proof and `--resume`.

The tool monitors an existing successful Pages run with exactly that source SHA; it never dispatches a moving branch or pushes source. New releases require the approved commit at HEAD and the live `origin/main` tip. Interrupted releases resume their immutable snapshot with the same tool/config hashes, recheck live readiness before stopping anything, reuse owned staging/backups, and leave regions drained on failure. The routine path preserves all account/ratings/progression data, takes stopped backups, and writes a private JSON receipt. It never performs the one-time fresh-season reset, provisions infrastructure, installs nginx or automatically restores old data.

The [operations dashboard](../docs/OPERATIONS-DASHBOARD.md) runs within the existing account service. Preserve its monitoring database, pending feedback email envelope and delivery table with the whole data directory. No additional PM2 process is needed.
