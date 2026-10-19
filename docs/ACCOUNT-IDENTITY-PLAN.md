# Account identity and the fresh ranked season

Decision record, 2026-10-19. The account flow, regional ranked verification and progression are implemented locally; **not deployed**. [ACCOUNTS.md](ACCOUNTS.md) is the current contract and release-gate reference.

## Chosen identity model

Ranked requires a verified account. Casual Quick Play and custom games retain guest entry. One immutable server-owned account ID owns the global Elo identity, reserved player name, preferred color, Embers and cosmetic ownership across computers and regions. Email is private. Device IDs remain guest/reconnect hints, never authentication proofs.

Use the single self-hosted Better Auth authority on US, with configured Google/Discord/Microsoft providers and passkeys added after an initial provider sign-in. Only Google credentials are currently provisioned. Provider scopes stay minimal; explicit authenticated linking is supported, implicit email-based linking is disabled. Password registration, passkey-only enrollment and an email recovery service are outside this release. No placeholder email identities or custom authentication protocol are introduced.

The browser obtains a fresh short-lived, single-use library proof for each regional admission action. Regions verify it through the private authority link, receive trusted canonical identity/equipment and enforce global ranked occupancy. Account IDs, display names and ranks supplied by a browser cannot substitute for proof. The account authority's occupancy has no expiry that could admit a second active ranked game during a network interruption; reconnect and regional generation cleanup are explicit.

## Names and renames

Claim and change names on the authenticated profile endpoint. Names normalize NFKC and use 3–16 ASCII letters/numbers/underscores, beginning with a letter. Their lower-case canonical key is globally unique in the authority's SQLite database; system names and control/confusable scripts outside this explicit alphabet are rejected.

Renaming works in this release. A successful atomic update releases the old name immediately. A competing claim returns 409 and leaves name/color unchanged. There is no invented cooldown or reservation hold; the existing profile-write rate limit applies. Immutable account identity, Elo key and progression remain the same. Account-enabled dedicated rooms use the server's canonical account name and mark unauthenticated guest names explicitly. Guest names do not reserve account names.

## Cutover decisions

The user approved `https://brawlock.osc.link` as the main game/auth origin, with the old GitHub Pages entry redirecting there. Keep the regional endpoints at `us.brawlock.osc.link` and `eu.brawlock.osc.link`. Issue production passkeys only on the final HTTPS game origin; their relying-party domain cannot be casually moved later. [STATIC-HOSTING.md](STATIC-HOSTING.md) describes the retained Pages media split and link-preserving entry redirects.

**The later explicit instruction to wipe history supersedes the earlier legacy-preservation plan.** Reset old device-based ratings and match history when cutting over to the fresh account season. Do not expose a legacy ladder, merge device Elo into accounts, or implement an import. A private operational backup is fine. Keep new account records, reserved names, provider credentials and session secrets intact. The reset has not been executed on the live fleet.

Old-origin local settings/replays do not automatically transfer between domains; no cross-origin history-import flow is part of this release. Preserve query/hash invite behavior in the entry redirect.

## Release acceptance

Locally covered: session revocation/expiry, profile uniqueness and rename identity, one-use admission proofs, regional RPC identity validation, global ranked occupancy/reconnect routes and account-owned progression invariants. Real browser virtual-passkey and DOM account/collection proofs are also available.

Still gate the combined release on real-TCP regional admission/reconnect and result settlement, completed maintenance/drain behavior, visual/cosmetic review, exact matching builds and the coordinated hostname/fleet cutover. Real Google login through the production HTTPS site remains unverified. Keep secrets server-only and preserve casual guest play throughout. A local implementation or provider URL probe is not evidence that the production rollout is complete.
