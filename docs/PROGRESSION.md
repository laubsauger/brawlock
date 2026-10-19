# Embers and the small collection

Embers are persistent account currency for cosmetics. They never change match gold, stats, hitboxes or Elo. The account authority owns every reward, purchase, balance and equipped item; regions submit completed simulation receipts over their authenticated authority link. A browser cannot submit a reward or choose an account ID.

## Reward policy 1

Only official fixed-rule Quick Play and Ranked games qualify. Custom games and replays cannot earn rewards. Official casual games against bots can qualify without satisfying Elo's human-opponent requirement.

A qualifying participant must have controlled their seat throughout the match, completed it, played at least two rounds, survived for at least 30 seconds in total, cast at least five spells, and either dealt at least 100 damage or walked at least 500 game units. The completed match must last at least 120 simulation seconds. These checks distinguish an active loss from an untouched, disconnected or bot-controlled seat. They are a first participation policy, not an assertion that all farming is impossible.

The reward is **20 completion + up to 5 for round wins + 5 for a match win**. Each round won adds two performance Embers, capped at five. Even all bonuses combined are smaller than the completion base. A qualifying loss always earns at least 20. There is no daily cap or streak penalty.

`createProgression(db).recordMatch()` accepts a strict trusted receipt with `rulesVersion: 1`; it calculates rewards itself. The regional adapter must derive the queue/rules version and account IDs from server-owned state, never a client claim. The receipt ID is created once per finished match and retained in the durable regional outbox. A canonical SHA-256 fingerprint includes all participants and inputs; a repeated ID with different contents is an error. Seat order does not affect the fingerprint.

One `BEGIN IMMEDIATE` transaction records the entire receipt and all eligible account credits. Unknown accounts reject the entire receipt. A receipt that awards nothing is still remembered, so a later retry cannot turn a previously ineligible result into a reward. Retries return the original result without another credit.

## Selection and purchases

The four-entry explicit catalog is in `src/game/progressionCatalog.ts`: two additional victory poses and two restrained cloth tints. The original robe and original three-celebration mix stay free.

Three of the four entries appear each UTC day, rotating the omitted entry. The account authority supplies the day/version, server time and next UTC midnight; the browser uses elapsed monotonic time only to display the countdown. A local clock change cannot change an offer or price. Prices are 80 Embers per victory pose and 100 per robe.

Purchase requests contain only `itemId`, `offerId`, and a unique `requestId`. The authority atomically checks the current offer, catalog price, balance and ownership, then deducts currency, grants permanent ownership and saves the purchase receipt. Simultaneous authority connections share SQLite's write lock and cannot overspend. An exact retry works after the daily refresh; reusing its request ID for another item or offer fails. Extra client price/balance fields are rejected.

Equipping checks ownership and the item's slot. `null` restores the original free style. Equipment is read into verified admission data when joining the next game; changing equipment does not mutate a running match. The region assigns `PlayerSlot.cosmetics`; client-controlled lobby updates cannot overwrite it. Replays retain the recorded presentation.

## Storage and interface

`server/progression.mjs` exports an additive `PROGRESSION_SCHEMA` for the existing account authority's explicit schema migration. It does not change `user_version` itself. Its prepared statements refuse startup against an incomplete schema. Tables are account-keyed wallets, match receipts, per-account rewards, permanent ownership, equipment and purchase receipts. SQLite foreign keys tie player-owned records to Better Auth's immutable `user.id`; display names never identify a balance.

The existing authenticated authority handler owns these same-origin, no-store routes:

- `GET /api/progression`: balance, catalog/daily offers, permanent ownership, equipment and five recent confirmed reward breakdowns.
- `POST /api/progression/purchase`: purchase body above; returns the new snapshot.
- `POST /api/progression/equip`: `{slot: 'victory' | 'robe', itemId: cosmeticId | null}`; returns the new snapshot.

`Collection` is a discreet menu/profile dialog, with stable geometry, loading/error/empty states and explicit equip actions. `EmberReward` presents an already confirmed server reward and counts it into the current balance when that balance still matches the receipt. No optimistic credit appears while result delivery is pending.

No payment processor, premium currency, hats, additional character meshes or broad marketplace framework is included.

## Focused proof

`src/game/progression.test.ts` covers positive losses, bonus bounds, custom/idle/disconnected rejection, strict server inputs, duplicate and conflicting receipts, atomic all-seat application, two-connection overspend prevention, purchase retry keys, stale daily offers, permanent ownership and equipment across reopen/refresh, and forged client fields. `src/render/character/victoryPose.test.ts` covers the new pose selection, continuity and reduced-motion still poses.

Local DOM-only captures and the purchase retry/equip exercise are kept under the ignored `artifacts/account-identity/` directory. They do not run the 3D match scene. Fleet delivery, authenticated endpoint and verified admission tests belong to the combined account release gate.

A separate frozen WebGPU character proof compares the original cloth, both robe palettes, both unlocked poses and the Revel bow/shoulder view using the actual CC0 warlock. Each view retains two shared character geometries/materials; the fixture reports four draws, 12,148 triangles including its floor, and one render pass. No animation/render loop or throughput stress test runs. Cloth palettes preserve the original base luminance and leave player-color, trim/rune and woven-chevron expressions intact. Switching back to the original robe reproduces its same-page screenshot byte for byte. Separate shader compilations showed 15 tiny detail-pixel differences in the original look, so this is not a claim of cross-build pixel equality. Captures and raw metrics are `artifacts/account-identity/cosmetic-*`.
