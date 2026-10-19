# Brawlock operations

Keep reusable deployment work here. `/private/tmp` contains disposable builds, captures and test fixtures; no release depends on retrieving a temporary script from an earlier session. Protected credentials stay on the hosts, outside this repository.

| Tool | Purpose | Changes |
| --- | --- | --- |
| `deploy.sh` | Build/upload a matching regional game | Only Brawlock code and its non-root PM2 process; `--dry-run` available |
| `configure-region.cjs` | Prepare an existing region for accounts/maintenance | Reviewed env additions, origin allowlist, separate maintenance secret; dry-run by default |
| `accounts.sh` | Deploy the single shared account service on US | Auth bundle, explicit additive migration, only `brawlock-accounts` |
| `web.sh` | Stage/activate a packaged first-party website | Versioned release directory and atomic `current` symlink |
| `maintenance.sh` | Drain, inspect or reopen a region | Persistent regional switch; secret is read remotely |
| `web.nginx.conf` | First-party static/auth site template | Install manually after review and `nginx -t` |
| `accounts.config.cjs`, `ecosystem.config.cjs` | Protected PM2 provisioning templates | Fill explicit regional/provider values; deploy tools never overwrite live copies |
| `../scripts/package-client.mjs` | Split a verified root-path build | New `web/` and `pages/` package directories; no uploads |

Use [RELEASE.md](RELEASE.md) for order, gates, backups, rollback and the one-time account-season reset. Use [README.md](README.md) for the base runtime/new-region prerequisites and [MAINTENANCE.md](../docs/MAINTENANCE.md) for drain semantics. No helper reboots hosts, restarts unrelated applications or supplies substitute public infrastructure.

## Region configuration

The base runtime, `/etc/brawlock/ecosystem.config.cjs` and shared rating/region credential must already exist. The tool checks the requested region against the protected config and preserves all existing secrets. It refuses a different existing account authority, missing origin allowlist or unexpected config layout. Applying makes a private config backup, creates a separate maintenance secret only if absent, and atomically replaces the config; it does not restart the service or reset history.

Dry-run both existing regions:

```sh
ssh root@147.182.251.185 'node --input-type=commonjs - us-west http://127.0.0.1:5352' < deploy/configure-region.cjs
ssh root@167.99.216.102 'node --input-type=commonjs - eu https://us.brawlock.osc.link' < deploy/configure-region.cjs
```

Append `--apply` inside the quoted remote command after reviewing the plan. For another region, pass its actual configured region ID and the shared account origin; the tool does not assume every remote host is Europe. Only the US host uses loopback because it also runs the account service. Simulation stays regional.

All SSH commands require already verified host keys. Follow the release checklist's known-host procedure; never disable host checking or accept a key from an unverified scan.

## Routine controls

```sh
deploy/maintenance.sh drain 'An update is coming. Finish this match, then choose another region.'
deploy/maintenance.sh status
DEPLOY_HOST=root@167.99.216.102 deploy/maintenance.sh status
deploy/maintenance.sh reopen
```

Wait for `ready:true` before stopping a drained server. The helper needs no credential pasted into the command, local env or chat.

After building a verified account bundle, `deploy/accounts.sh` deploys the US authority. It keeps provider/session secrets, runs migrations before activation and saves the correct PM2 inventory. Take the consistent backup required by the release checklist first. Changing schema incompatibly or changing the authority hostname needs a separate migration plan.

For a root-path client package produced by `scripts/package-client.mjs`:

```sh
deploy/web.sh PACKAGE_DIR BUILD_ID --stage-only
deploy/web.sh PACKAGE_DIR BUILD_ID --activate-staged
```

Activation verifies the uploaded build and switches the static symlink. The helper does not install nginx, publish Pages or deploy regional servers. The release checklist coordinates those dependencies. Retain the old release directory and its corresponding media for rollback.

## Fleet verification

Read-only health checks require Node 22+ and explicit compatibility ID, protocol and region origins. Use the deployed net ID, not the source commit:

```sh
node scripts/release/verify-fleet.mjs NET_ID PROTOCOL us-west=https://us.brawlock.osc.link eu=https://eu.brawlock.osc.link
```

Add `--admission` only when each region is empty and accepting games. It requires Node 24.11+ and account-aware protocol 8+, creates a casual quick-play lobby, checks the canonical guest identity, leaves before combat, and confirms room/discovery cleanup. It refuses any existing rooms, players or connections, never enters ranked, and prints only a small JSON result. The default request Origin is `https://brawlock.osc.link`; use `--origin HTTPS_ORIGIN` for another allowed first-party site. `--allow-local-http` permits HTTP only on loopback for local fixtures; public endpoints always require HTTPS. No credentials are needed or accepted. Run regions during a controlled empty window: the initial empty check cannot prevent a real player from joining concurrently.
