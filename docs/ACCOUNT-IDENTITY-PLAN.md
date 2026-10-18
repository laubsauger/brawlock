# Account identity for the next release

Planned after the current regional/chat release. No account gate is included in this deployment.

Ranked requires a verified account; casual Quick Play and custom games retain guest entry. One stable server-owned account ID owns the global Elo, reserved player name, preferred color and match history across computers and regions. Email is private and is never the displayed identifier or rating key. Device IDs remain guest/reconnection hints; they are not authentication proofs.

## Recommended approach

Evaluate self-hosted Better Auth on the existing backend: Google, Discord and Microsoft sign-in, with a passkey option for people who do not want a social account. Its OAuth/account-linking and passkey-first registration are supported library features. This avoids a per-user authentication subscription; running, patching and backing up the service still has a cost. Confirm deployed library versions and advisories before implementation.

Keep a managed alternative available for the decision: Clerk Hobby currently includes three social connections and 50,000 monthly retained users, but production passkeys are paid. Supabase Free currently includes 50,000 monthly active users; public email authentication needs a custom SMTP service. Do not choose a provider on a stale free-tier assumption.

Email/password can be supported, but recovery and verification require dependable email delivery. A passkey plus linked social login (or a carefully designed recovery method) avoids operating that email flow initially. Do not ship password accounts that cannot recover access. Offer a second login method and explicit account linking so Google/Discord/passkeys join the same account rather than creating parallel ratings. Never link accounts merely because a client supplies the same email string.

## Player names

An authenticated account claims an available unique name through an atomic server transaction. Enforce uniqueness on a canonical normalized, case-insensitive key, with bounded input, prohibited control characters, reserved system names and a documented confusable-character policy. Resolve uniqueness races in the database, not just the form. Existing guest display names do not automatically reserve account names.

Guests have an unmistakable Guest marker and cannot use an exact reserved name in online rooms. The server supplies the signed-in account’s canonical player name instead of accepting an arbitrary client label. Name changes never move or recreate the account or its Elo. Set a rename cooldown and old-name hold before opening registration; the UI must show availability and explain when an old name becomes available again. Email changes must not affect the reserved name.

## Integration and acceptance

- One auth authority, shared by both game regions; verify sessions server-side before ranked admission and rating submission. Never trust client account IDs, claimed rank or match results.
- Explicitly link existing guest history to an authenticated account. Current device IDs are user-controlled, so they do not prove ownership of a public leaderboard identity. Decide legacy Elo adoption versus a fresh public ranked season before migration; never merge by name/email alone.
- Prefer a stable first-party game/auth domain (for example game at `brawlock.osc.link`, auth at `auth.brawlock.osc.link`) before issuing passkeys; WebAuthn credentials are scoped to a relying-party domain. Review cross-origin cookies and browser storage behavior with the existing GitHub Pages client.
- Cover login on a second machine, account linking, logout/revocation, reserved-name races/case variations, renames, expired sessions, duplicate ranked sessions, return from OAuth and account recovery. Preserve guest casual play throughout.
- Keep OAuth secrets and session keys server-only; rate-limit auth and name claims, validate callback/state/PKCE, retain a minimal permissions scope, and back up the account database. Use library facilities rather than a custom authentication protocol.

## Sources checked 2026-10-18

- Better Auth free MIT license: https://github.com/better-auth/better-auth/blob/main/LICENSE.md
- Better Auth OAuth/account linking: https://better-auth.com/docs/concepts/oauth and https://better-auth.com/docs/concepts/users-accounts
- Better Auth passkeys and passkey-first registration: https://better-auth.com/docs/plugins/passkey
- Clerk limits and passkey availability: https://clerk.com/pricing
- Supabase limits: https://supabase.com/pricing
- Supabase public email delivery requirements: https://supabase.com/docs/guides/auth/auth-smtp
