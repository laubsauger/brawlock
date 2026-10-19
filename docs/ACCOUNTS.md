# Accounts, ranked admission and shared progression

Status, 2026-10-19: account release `f97de56b685b` is deployed on the first-party website and both regions, with schema 3. The user confirmed real public Google login works. See [the deployment receipt](../deploy/releases/2026-10-19-accounts.md). Follow-up onboarding, private owner-email display and menu-inclusive population changes described below are verified locally and await the next release.

The approved fresh account season is active at `https://brawlock.osc.link`. Old device-based ratings/history and the old regional submission outbox were retired into private stopped backups; newly created accounts, wallets, credentials and session secrets were preserved. No legacy ladder or device-rating import is published. This one-time reset must never be part of a routine release.

## Authority and identity

Run one account authority on US, shared by US West and Europe. `accounts.sqlite` stores Better Auth users/sessions, reserved profiles, global ranked occupancy and [Embers/cosmetics](PROGRESSION.md). The global rating authority remains separate; its player keys are derived server-side as `a_<account ID>`. Display names, device IDs, email strings and browser storage never prove account ownership.

The regional game bundle calls the account authority over an authenticated server-only link. OAuth code and provider secrets stay in the separate auth bundle. Production game startup requires `ACCOUNTS_AUTHORITY_URL`; authenticated regions also require `DATA_DIR` for durable progression delivery. See [STATIC-HOSTING.md](STATIC-HOSTING.md) for the first-party page and Pages media split.

Better Auth and `@better-auth/passkey` are pinned to 1.7.11. The library owns cookies, OAuth state/PKCE, one-time admission tokens and WebAuthn verification. Cookie caching is disabled: profile and admission requests check the session database. Logout revokes that session. Provider email stays private. Password registration is disabled; start with a configured social provider, then add a passkey. Passkey-only enrollment and recovery are not included. Explicit linking requires an authenticated account and matching provider email; implicit email-based linking is disabled. Passkey enrollment and sign-in require verified PIN/biometric flags, not possession alone.

## Public API and player profiles

All browser endpoints are same-origin and `no-store`; writes require the exact configured Origin and JSON. Browser API paths are `/api/auth/*`, `/api/account`, `/api/account/config`, `/api/account/admission`, `/api/progression*` and `/api/presence`. The direct library one-time-token routes are blocked from browsers.

Authenticated `GET /api/account` returns `{id, email, profile, game}`: a stable account ID, the owner's sign-in email, the reserved name/preferred color or `null`, and an occupied ranked region/room or `null`. Profile writes return the same private shape. Email is shown only to its signed-in owner; it is absent from regional admission, snapshots, leaderboards, public profiles and population counts. Provider credentials and session tokens are never returned here.

`POST /api/account` claims a name/color. `PATCH /api/account` changes the name and color; color-only requests retain the current name. Names use 3–16 ASCII letters, numbers or underscores, start with a letter, normalize NFKC and are unique case-insensitively. Controls, other scripts and reserved system names are rejected. SQLite uniqueness handles competing claims and renames. A successful rename atomically releases the previous name; a conflicting name returns 409 without changing either field. No rename cooldown or old-name hold is imposed; the existing six-per-minute profile-write limiter applies. The provider display name cannot overwrite the game profile. Renames retain the immutable account ID, rating key, ownership and currency.

The Account dialog edits the claimed name and color, displays validation/conflict errors and publishes the server's canonical profile to shared client state. An earlier in-flight identity read cannot replace a newly saved profile. Unsigned players keep their separate guest identity and preferences. In account-enabled dedicated rooms, the server supplies signed-in names and marks unauthenticated names as guests; guest claims using the account identity namespace are rejected.

## Online population

Prepared after `f97de56b685b`: `/api/presence` is a public aggregate separate from regional `/health.players`, which continues to count connected humans in lobbies/matches. A browser sends one small same-origin JSON heartbeat every 30 seconds throughout the app, including menus, offline play and replays. It submits only its existing anonymous browser ID and selected/current region. Account identity comes exclusively from a verified session cookie, never the body. Multiple tabs on one browser count once; multiple signed-in devices count once, assigned to the most recently active region. Region changes update a single authority entry, avoiding cross-region double counting.

Leases expire after 90 seconds without a heartbeat, need no unload request and are held only in memory. A service restart briefly clears presence until visitors refresh their leases; it does not touch accounts or game state. Public responses contain only regional counts and a total. Request shape/size, trusted proxy address, per-IP rate/device limits and total capacity bound anonymous writes. New official regions must be added to `src/shared/presence.ts` as well as the game/workflow fleet configuration. Population is approximate and has no authority over matchmaking, account ownership, Elo or rewards. Failed reads display unknown rather than substituting game counts or assuming zero.

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

The supplied Google JSON was validated with the exact callback, PKCE and only `openid email profile`. Secrets and the original JSON remain outside Git/client assets. The public website cutover is complete and the user confirmed the real provider flow.

## Evidence and remaining release gates

Local tests cover explicit/idempotent migration, profile races/renames, valid/forged/expired/revoked sessions, strict account boundaries, one-use/expired admission proofs, global occupancy across authority reopen and regional generations, authenticated regional RPC, and durable reward retries. Existing guest profile behavior and stale client-read protection are covered separately. Collection/pose tests exercise receipt/purchase invariants and presentation.

Local browser WebAuthn proof enrolled a virtual-authenticator credential, signed out/in and recovered the same account in a second independent browser context. DOM-only React proofs cover the account/profile flow and Collection/result states. They do not establish a real Google callback or public regional deployment. Ignored captures are under `artifacts/account-identity/`.

The combined release passed real-TCP account admission, local result/receipt tests, cosmetic/visual checks and live guest admission in both regions. First-party routing, Pages media/redirects and the fresh-season cutover are complete. Public passkey enrollment/reuse, signed-in cross-device regional play and a complete live reward match still need human verification. The local browser fixtures do not establish those production flows.

Primary implementation references: [SQLite adapter](https://better-auth.com/docs/adapters/sqlite), [passkeys](https://better-auth.com/docs/plugins/passkey), and the installed 1.7.11 definitions. Dependency advisories and the final exact build belong to the release gate; do not force an unrelated test-runner upgrade as part of authentication.
