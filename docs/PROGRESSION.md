# Embers and the wardrobe

Embers are persistent account currency for cosmetics. They never change match gold, stats, hitboxes or Elo. The account authority owns every reward, purchase, balance and equipped item; regions submit completed simulation receipts over their authenticated authority link. A browser cannot submit a reward or choose an account ID.

## Reward policy 1

Only official fixed-rule Quick Play and Ranked games qualify. Custom games and replays cannot earn rewards. Official casual games against bots can qualify without satisfying Elo's human-opponent requirement.

A qualifying participant must have controlled their seat throughout the match, completed it, played at least two rounds, survived for at least 30 seconds in total, cast at least five spells, and either dealt at least 100 damage or walked at least 500 game units. The completed match must last at least 120 simulation seconds. These checks distinguish an active loss from an untouched, disconnected or bot-controlled seat. They are a first participation policy, not an assertion that all farming is impossible.

The reward is **20 completion + up to 5 for round wins + 5 for a match win**. Each round won adds two performance Embers, capped at five. Even all bonuses combined are smaller than the completion base. A qualifying loss always earns at least 20. There is no daily cap or streak penalty.

`createProgression(db).recordMatch()` accepts a strict trusted receipt with `rulesVersion: 1`; it calculates rewards itself. The regional adapter must derive the queue/rules version and account IDs from server-owned state, never a client claim. The receipt ID is created once per finished match and retained in the durable regional outbox. A canonical SHA-256 fingerprint includes all participants and inputs; a repeated ID with different contents is an error. Seat order does not affect the fingerprint.

One `BEGIN IMMEDIATE` transaction records the entire receipt and all eligible account credits. Unknown accounts reject the entire receipt. A receipt that awards nothing is still remembered, so a later retry cannot turn a previously ineligible result into a reward. Retries return the original result without another credit.

## Selection and purchases

The explicit catalog is in `src/game/progressionCatalog.ts`, in six slots: **head** (horns, antlers, hats, a crescent, a candle crown, a party hat, a crow, an angler lure), **back** (antlers, twin crescents, a spine fan, bat wings), **robe** (torn and Emberveil cuts), **emblem** (single-colour prints on the cape's back), **staff** (gnarled, iron ring, bone; held in the left hand, spells visually leave from its crystal, no gameplay change) and **victory** (poses). The bare hood, nothing on the back, the original robe, a plain cape back, bare hands and the original celebration mix stay free.

Cosmetics change shape, never colour. Player colour is identity, so every piece is a neutral material (bronze, iron, bone, horn, wood, felt) and anything that glows glows in the wearer's player colour; emblems print in it. Pieces are procedural geometry on the rig (`src/render/character/wardrobe.ts`, merged per outfit into one skinned draw), robe cuts and emblems are cloth-shader work (`materials.ts`, `emblems.ts`: one coverage atlas drawn from Canvas2D strokes, so a new emblem is a draw function and a catalog entry). Every piece is sized for the top-down gameplay camera (`READ_SCALE`), checked with `media/perf-harness/wardrobe.cjs`.

The whole catalog is on sale every day (2026-10-20; it used to rotate three of four). The day-stamped offer id (`embers-v2:<day>`) only keeps purchase retries idempotent; a local clock change cannot change an offer or price. Prices run 50 to 220 Embers.

**Retired colour robes.** The original Cinder and Moon Weave robes only tinted near-black cloth and were invisible in play. Account schema 7 (`PROGRESSION_V7_MIGRATION`) refunds each owner what they paid (100 where a grant has no purchase row), unequips and removes them, records a `progression_refund` row per item and keeps the purchase receipts, so a replayed request still cannot buy twice. It is idempotent. The authority also drops any equipped id its catalog no longer knows before a region validates admission, so catalog changes can never block joining.

Purchase requests contain only `itemId`, `offerId`, and a unique `requestId`. The authority atomically checks the current offer, catalog price, balance and ownership, then deducts currency, grants permanent ownership and saves the purchase receipt. Simultaneous authority connections share SQLite's write lock and cannot overspend. An exact retry works after the daily refresh; reusing its request ID for another item or offer fails. Extra client price/balance fields are rejected.

Equipping checks ownership and the item's slot. `null` restores the original free style. Equipment is read into verified admission data when joining the next game; changing equipment does not mutate a running match. The region assigns `PlayerSlot.cosmetics`; client-controlled lobby updates cannot overwrite it. Replays retain the recorded presentation.

Games without the authority in the loop (offline, practice, a peer-to-peer host's own seat) show the equipment from the last progression snapshot this browser saw (`src/game/wardrobe.ts`). Peer-to-peer joiners show none: nothing there is verified.

## Storage and interface

`server/progression.mjs` exports an additive `PROGRESSION_SCHEMA` for the existing account authority's explicit schema migration. It does not change `user_version` itself. Its prepared statements refuse startup against an incomplete schema. Tables are account-keyed wallets, match receipts, per-account rewards, permanent ownership, equipment and purchase receipts. SQLite foreign keys tie player-owned records to Better Auth's immutable `user.id`; display names never identify a balance.

The existing authenticated authority handler owns these same-origin, no-store routes:

- `GET /api/progression`: balance, catalog/daily offers, permanent ownership, equipment and five recent confirmed reward breakdowns.
- `POST /api/progression/purchase`: purchase body above; returns the new snapshot.
- `POST /api/progression/equip`: `{slot: 'head' | 'back' | 'robe' | 'emblem' | 'staff' | 'victory', itemId: cosmeticId | null}`; returns the new snapshot.

The **Wardrobe** (`src/ui/screens/Collection.tsx`, a main-menu entry, also reachable from the player card, results and profile) shows your warlock live in 3D (`src/render/WardrobeStage.tsx`), drag to turn, with close-up, full and in-game camera views. Clicking any piece tries it on; owned pieces equip, others show their price. Every piece has a picture rendered once, offscreen, by the same stage. Guests can browse and try everything on; Embers and ownership need an account. `EmberReward` presents an already confirmed server reward and counts it into the current balance when that balance still matches the receipt. No optimistic credit appears while result delivery is pending.

No payment processor, premium currency or broad marketplace framework is included.

## Focused proof

`src/game/progression.test.ts` covers positive losses, bonus bounds, custom/idle/disconnected rejection, strict server inputs, duplicate and conflicting receipts, atomic all-seat application, two-connection overspend prevention, purchase retry keys, stale daily offers, permanent ownership and equipment across reopen/refresh, and forged client fields. `src/render/character/victoryPose.test.ts` covers the new pose selection, continuity and reduced-motion still poses.

Local DOM-only captures and the purchase retry/equip exercise are kept under the ignored `artifacts/account-identity/` directory. They do not run the 3D match scene. Fleet delivery, authenticated endpoint and verified admission tests belong to the combined account release gate.

Account schema 7's refund is covered in `src/net/accounts.test.ts` (paid and granted robes, idempotent re-run, purchase ledger kept). Wardrobe pieces are checked visually at close and gameplay zoom with `media/perf-harness/wardrobe.cjs` (dev preview, a lineup of dummies) and in the Wardrobe itself; screenshots are not committed.
