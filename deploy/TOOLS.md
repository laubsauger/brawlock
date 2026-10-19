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

Add `--admission` only when each region is empty and accepting games. It requires Node 24.11+ and account-aware protocol 8+, acquires a short-lived guest game permission through the first-party `/api/play` endpoint, creates a casual quick-play lobby, checks the canonical guest identity, leaves before combat, and confirms room/discovery cleanup. It returns the signed browser cookie on release and never logs the permission token. It refuses any existing rooms, players or connections, never enters ranked, and prints only a small JSON result. The default request Origin is `https://brawlock.osc.link`; use `--origin HTTPS_ORIGIN` for another allowed first-party site. `--allow-local-http` permits HTTP only on loopback for local fixtures; public endpoints always require HTTPS. No operator credentials are needed or accepted. Run regions during a controlled empty window: the initial empty check cannot prevent a real player from joining concurrently.

## One-command routine release

### Version and release date

The first labeled release is `v0.1.0-alpha.1`. `package.json` supplies its SemVer `version` and explicit UTC `releaseDate` (`YYYY-MM-DD`); keep the lockfile version in sync. The menu footer and in-match pause menu show that version and date. Local development adds a `dev` suffix. The client/server `version.json`, hosting manifest and fleet receipt carry the same metadata alongside the existing source SHA and network compatibility ID.

Before preparing each subsequent deployment, advance the prerelease and set its date:

```sh
npm version prerelease --preid=alpha --no-git-tag-version
npm pkg set releaseDate="$(date -u +%F)"
```

These commands edit package metadata without committing or creating a tag. Review and publish the approved source through the normal release process. Use `alpha.2`, `alpha.3`, etc. for subsequent pre-alpha releases; move to a new minor/patch version deliberately when that change is useful. Rebuilding or resuming the same release retains its version/date.

Apply checks the remote `vVERSION` tag before any maintenance. It refuses a tag pointing to different code. After reopening and successful final fleet proof, it creates that immutable Git tag on the verified source revision through authenticated `gh`; it never moves/deletes an existing tag or creates a GitHub Release. The receipt records tag publication and its source link. `gh` therefore needs permission to create repository refs. If publication fails, the deployed games remain open and the receipt survives: resume the same journal to retry only tag publication. A new version is required for different code, even on the same date.

### Execute and resume

```sh
node deploy/release.mjs --revision FULL_APPROVED_SHA
node deploy/release.mjs --revision FULL_APPROVED_SHA --apply
```

The first command prints the plan and blockers without building or networking. `--skip-tests` (with `--apply`) skips only the full vitest suite (about 10-15 minutes) when it already passed on the approved revision; the release-tool tests, typecheck and builds still run, a resume must repeat the flag, and the receipt records `testsSkipped`. A new apply requires a clean tracked tree, committed deployment tools, that exact HEAD already at the live `origin/main` tip, Node 22+, npm, Git, tar, SSH/rsync and authenticated `gh`. Existing SSH host keys must be verified; unknown keys fail closed. The tool never commits, pushes branches, checks out, resets, provisions hosts or resets history; its only source-publication action is the verified deployment tag. The non-secret fleet configuration is [release.config.json](release.config.json); its region/media/account build settings must match the approved Pages workflow.

On 2026-10-19, both existing regional keys were verified in the operator's normal `~/.ssh/known_hosts`; EU's already-verified session entry was moved into that durable store. Strict noninteractive SSH succeeds for both hosts without a temporary wrapper or trust-file path. A different operator/new host must establish its own verified trust first.

Apply archives the revision, installs dependencies independently in that snapshot, runs serial tests and all builds, and monitors the existing exact-SHA Pages workflow. It uses that workflow's first-party artifact, stages it, drains both regions, waits for complete matches/deliveries, stops only Brawlock processes, and takes private consistent game/account backups. It updates the account bundle only when changed, deploys the global game authority before other regions, checks hashes/versions/shared ratings, activates the website and reopens regions. The final check is read-only unless `--admission` is explicitly added (Node 24.11+, empty regions only).

Each phase is journaled in the printed private directory; retain it through the release. Resume an interrupted release with the same arguments and `--resume /ABSOLUTE/JOURNAL_DIRECTORY`. Its frozen Git metadata preserves the approved revision even if the working checkout advances; tool/config hashes must still match. Existing owned staging uploads and verified backups are reused without overwriting another release. A kernel-owned loopback lock prevents simultaneous releases and disappears on process exit, including a crash. Deployment-stage failures keep reachable regions drained and never automatically roll back or reopen them; post-proof tag-publication failures leave them open. Check the reported error/private logs, resolve its cause, then resume. Successful runs write `receipt.json` with version/date, source tag, artifact hashes, workflow, backups and final proof.

`release-remote.cjs` contains the shared targeted SSH operations; no temporary remote script from a past session is needed. Run the orchestration regression tests with `node --test --test-concurrency=1 deploy/release.test.mjs` (uses local subprocesses and loopback only).

The first combined live run completed at `38a2f766fb5b`, including explicit schema 6 migration and real guest admission/cleanup in both regions. Its final verifier initially returned no output because macOS exposes temporary files through `/var` and `/private/var` aliases. The runner correctly re-drained both regions. Resuming the same journal through its canonical `/private/var` path reused the verified deploy/backups and completed the proof. New journals and resumes now canonicalize their directory; the verifier also resolves its CLI path before checking its entry point. A symlinked-CLI regression guards against silent success. Retain a private receipt copy under ignored `artifacts/live-release/BUILD/` as well as the temporary journal. See [the rollout record](releases/2026-10-19-38a2f766fb5b.md).
