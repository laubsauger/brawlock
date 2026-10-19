# Accounts, ranked admission and shared progression

Status, 2026-10-19: the standalone US account service is running under non-root PM2 with schema 3. Public provider metadata and EU's authenticated private HTTPS lookup passed. The live Pages client and regional game services still run the previous release; the first-party game page and account-required ranked cutover remain pending. A real Google login through the public site remains unverified.

The user approved `https://brawlock.osc.link` as the main game/auth origin and, superseding the earlier preservation plan, a **wipe of old device-based ratings and match history at cutover**. Start a fresh account season; do not publish a legacy ladder or import device ratings. Keep newly created accounts, provider credentials and session secrets intact. A private operational backup is compatible with this reset. No live reset has been performed.

## Authority and identity

Run one account authority on US, shared by US West and Europe. `accounts.sqlite` stores Better Auth users/sessions, reserved profiles, global ranked occupancy and [Embers/cosmetics](PROGRESSION.md). The global rating authority remains separate; its player keys are derived server-side as `a_<account ID>`. Display names, device IDs, email strings and browser storage never prove account ownership.

The regional game bundle calls the account authority over an authenticated server-only link. OAuth code and provider secrets stay in the separate auth bundle. Production game startup requires `ACCOUNTS_AUTHORITY_URL`; authenticated regions also require `DATA_DIR` for durable progression delivery. See [STATIC-HOSTING.md](STATIC-HOSTING.md) for the first-party page and Pages media split.

Better Auth and `@better-auth/passkey` are pinned to 1.7.11. The library owns cookies, OAuth state/PKCE, one-time admission tokens and WebAuthn verification. Cookie caching is disabled: profile and admission requests check the session database. Logout revokes that session. Provider email stays private. Password registration is disabled; start with a configured social provider, then add a passkey. Passkey-only enrollment and recovery are not included. Explicit linking requires an authenticated account and matching provider email; implicit email-based linking is disabled. Passkey enrollment and sign-in require verified PIN/biometric flags, not possession alone.

## Public API and player profiles

All browser endpoints are same-origin and `no-store`; writes require the exact configured Origin and JSON. Public API paths are `/api/auth/*`, `/api/account`, `/api/account/config`, `/api/account/admission` and `/api/progression*`. The direct library one-time-token routes are blocked from browsers.

`GET /api/account` returns only `{id, profile, game}`: a stable account ID, the reserved name/preferred color or `null`, and an occupied ranked region/room or `null`. It never returns email, provider credentials or session tokens.

`POST /api/account` claims a name/color. `PATCH /api/account` changes the name and color; color-only requests retain the current name. Names use 3–16 ASCII letters, numbers or underscores, start with a letter, normalize NFKC and are unique case-insensitively. Controls, other scripts and reserved system names are rejected. SQLite uniqueness handles competing claims and renames. A successful rename atomically releases the previous name; a conflicting name returns 409 without changing either field. No rename cooldown or old-name hold is imposed; the existing six-per-minute profile-write limiter applies. The provider display name cannot overwrite the game profile. Renames retain the immutable account ID, rating key, ownership and currency.

The Account dialog edits the claimed name and color, displays validation/conflict errors and publishes the server's canonical profile to shared client state. An earlier in-flight identity read cannot replace a newly saved profile. Unsigned players keep their separate guest identity and preferences. In account-enabled dedicated rooms, the server supplies signed-in names and marks unauthenticated names as guests; guest claims using the account identity namespace are rejected.

Leaderboard and public-profile reads resolve the current reserved name from the account authority. Completed matches store their server-verified historical label under the immutable account key; rating commits do not depend on the account service being reachable. An older result therefore cannot revert the visible current name, and a temporary auth outage cannot discard a completed US rating. Account-name lookup failures are explicit rather than displaying a potentially reassigned historical name.

## Regional admission and reconnects

`POST /api/account/admission` requires a valid session and a claimed profile. It issues a fresh library token for each regional action. Tokens expire after one minute, are stored hashed, consumed once and never persisted in browser storage. Regions exchange them over `/internal/accounts`; the verified response supplies the immutable ID, canonical name/color, rating key and owned cosmetic equipment. The browser cannot submit trusted account metadata in `hello`.

HTTP ranked matchmaking verifies account proof before reserving a seat. Regional WebSocket admission verifies a separate proof before attaching the player; casual guest admission is explicit. No account-service outage silently turns a signed-in ranked player into a guest.

The account authority stores **one global ranked occupancy per account**, with no time-based expiry that could permit two active ranked matches. A claim for its existing region/process-generation/room is idempotent; another room or region is rejected with the existing game route. Disconnecting from an active game retains its occupancy for reconnect. Room/session cleanup releases it. A newly registered regional process generation removes that region's obsolete occupancy; the region binds its game port before registering, so a duplicate process cannot fence a live one. Occupancy survives authority restart. This is ranked exclusivity, not a blanket ban on casual play.

`GET /api/account` exposes the occupied route for the main-menu rejoin action. Ordinary reconnect identity guards remain in place. Rating and reward results come from the regional simulation, never browser scores. Progression uses its own durable regional outbox, so official casual matches can earn Embers independently of Elo. See [PROGRESSION.md](PROGRESSION.md) for eligibility, purchase/equip contracts and honest pending/unavailable result states.

## Schema and local operation

Node's built-in SQLite runs with WAL, full synchronization and foreign keys. `accounts:migrate` explicitly applies reviewed library changes and additive application versions: **1 profiles, 2 regions/occupancy, 3 progression**. Re-running migration preserves users, sessions and application data. Normal startup refuses missing/incomplete schema; unsupported versions and unsafe library migrations stop startup. Do not reset `accounts.sqlite` to reset the old ladder.

Keep secrets outside the repository and out of every `VITE_` variable. Local configuration:

```
AUTH_ORIGIN=http://localhost:5189
AUTH_PORT=5352
AUTH_DATA_DIR=/private/tmp/brawlock-local-accounts
AUTH_SECRET_FILE=/path/to/private/random-session-secret
AUTH_REGIONS_TOKEN_FILE=/path/to/private/shared-regional-token
AUTH_GOOGLE_CLIENT_ID=<provider client ID>
AUTH_GOOGLE_SECRET_FILE=/path/to/private/google-client-secret
```

At least one provider must be fully configured. Discord/Microsoft use `AUTH_DISCORD_*` / `AUTH_MICROSOFT_*`; a partial provider is a startup error. Register the callback `${AUTH_ORIGIN}/api/auth/callback/google` (or `/discord`, `/microsoft`). The [Google walkthrough](GOOGLE-SIGN-IN-SETUP.md) documents console setup and the production callback.

```
npm run accounts:migrate
npm run accounts
VITE_ACCOUNTS_ENABLED=true npm run dev -- --host localhost --port 5189 --strictPort
```

The explicit Vite opt-in proxies auth, account and progression API paths to loopback port 5352. Use `localhost`, matching the configured Origin. Production requires HTTPS. Auth-library limits are persistent; profile writes, admission and collection changes have separate account buckets. The loopback service bounds streamed bodies to 32 KiB, profile/collection bodies to 1 KiB and private regional requests to 16 KiB. Private requests require a timing-safe bearer check and reject browser Origin headers.

`npm run accounts:build` creates `dist-accounts/accounts.mjs`. The separate [PM2 template](../deploy/accounts.config.cjs) names only `brawlock-accounts`; it does not replace the game ecosystem or operate on other apps. Prepared US paths are `/opt/apps/brawlock-accounts` (root-owned code), its service-writable `data/`, and protected configuration/secrets under `/etc/brawlock/`. Routine updates retain the session secret and consistently back up SQLite/WAL data. `TRUST_PROXY=1` is appropriate only behind the trusted loopback proxy setting `X-Real-IP`.

The supplied Google JSON was validated and used in a local authorization-URL probe with the exact callback, PKCE and only `openid email profile`. Secrets and the original JSON remain outside Git/client assets. Provisioning is preparation, not evidence of provider login or a completed website cutover.

## Evidence and remaining release gates

Local tests cover explicit/idempotent migration, profile races/renames, valid/forged/expired/revoked sessions, strict account boundaries, one-use/expired admission proofs, global occupancy across authority reopen and regional generations, authenticated regional RPC, and durable reward retries. Existing guest profile behavior and stale client-read protection are covered separately. Collection/pose tests exercise receipt/purchase invariants and presentation.

Local browser WebAuthn proof enrolled a virtual-authenticator credential, signed out/in and recovered the same account in a second independent browser context. DOM-only React proofs cover the account/profile flow and Collection/result states. They do not establish a real Google callback or public regional deployment. Ignored captures are under `artifacts/account-identity/`.

Before release: finish the combined real-TCP regional admission/reconnect/result gates; verify cosmetic presentation and the final visual build; complete and exercise maintenance/drain and coordinated rollout; prepare the matching first-party proxy/Pages redirect; perform the authorized old-history reset after a private backup; then verify real Google login, logout, passkey enrollment/reuse and both advertised regions on public HTTPS. Publish/announce only after those live checks. The current code/test state is not a deployment receipt.

Primary implementation references: [SQLite adapter](https://better-auth.com/docs/adapters/sqlite), [passkeys](https://better-auth.com/docs/plugins/passkey), and the installed 1.7.11 definitions. Dependency advisories and the final exact build belong to the release gate; do not force an unrelated test-runner upgrade as part of authentication.
