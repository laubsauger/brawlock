# Fleet release checklist

Use this for routine releases; [README.md](README.md) covers provisioning and limits.
For ping investigations, use [performance diagnostics](../docs/PERFORMANCE-DIAGNOSTICS.md).
For the public-profile upgrade, follow the [authority/outbox compatibility notes](../docs/PLAYER-PROFILES.md#storage-and-rollout) before deploying or rolling back.
Reference rollout: commit `a03358d76509`, netcode `5a9d75172999`. Verify live state; this reference is not a deployment receipt.

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

GitHub Pages uses [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): `main` pushes or manual dispatch build `dist` with Node22 and both `us-west`/`eu` entries in `VITE_GAME_SERVERS`. Verify the workflow's source SHA matches the approved release. Do not publish a later moving branch accidentally; confirm the actual deployment succeeded, not merely that a push completed.

## Post-release proof and recovery

- Check local and public `/health` on both regions: `ok`, expected region/protocol, and `build` equal the approved netcode. Compare remote `version.json` commit/net and bundle hash to the release artifacts; health alone does not prove the commit.
- Check `bpm2 status`, process owner, saved Brawlock inventory and `systemctl is-enabled pm2-brawlock` / `systemctl is-active pm2-brawlock`. Check `coturn` similarly on EU. PM2 autorestart, memory limits and saved inventory provide process/reboot recovery; do not reboot production to test this.
- Read `/leaderboard?period=all` and a known `/players/DEVICE` through both regions; compare global entries after caches settle. Confirm existing US history remains and EU outbox retries recover after authority availability. Never create a second ladder or inject fake production rating results for a smoke test.
- In the published desktop browser, verify both region pings/version compatibility, casual public creation/join, ranked queue and room-code routing. Touch-only users can browse menus but cannot reserve a seat.
- Validate `GET /ice` from both regions without logging credentials. Force browser relay-only data channels over UDP, TCP and TLS; require relay candidates **and bidirectional payload delivery**, preferably across separate networks. Anonymous TURN allocation must fail. Do not substitute an unreviewed public relay.
- Inspect targeted app/nginx/TURN errors and certificate renewal state. Never dump PM2 environments, live ecosystem contents, bearer tokens, TURN credentials or private backups into logs, screenshots or Git.
- If rollback is needed, stop only Brawlock, retain current data/outboxes and restore the previously verified code/config pair with the same private ownership. Confirm the old runtime supports the current schema and unprivileged account before restarting; otherwise stop for a reviewed recovery plan. Never blindly restore stale authority data over newer ratings.
- Recheck both regions, Pages compatibility, global ratings and ICE after rollback. Keep failures and exact recovered versions in the release record. Never restart unrelated US apps, root PM2, nginx globally, Docker, or the host; nginx changes require `nginx -t` before a targeted reload.
