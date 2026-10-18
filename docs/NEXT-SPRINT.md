# Next sprint: accounts and persistent progression

These features are planned for the release after the current regional/chat update.

## Ranked accounts and reserved names

Implement the account identity described in [ACCOUNT-IDENTITY-PLAN.md](ACCOUNT-IDENTITY-PLAN.md): sign in once, use the same account and global Elo across machines, claim a unique player name, and keep email private. Casual guests remain supported. Confirm provider choice and legacy-rating migration before implementation.

## Earned progression currency

Working name: Embers. This is a persistent reward balance alongside Elo, never a combat power modifier or match shop gold. Final name is still open. It establishes the reward loop for a small cosmetic unlock shop, as requested in the follow-up. Paid currency and a larger customization system remain later decisions.

A player who completes an eligible match receives a small base reward even after a loss. Add modest bonuses derived from existing placement/win/participation data so doing better feels rewarding without turning the balance into another Elo score. Present the result as a clear base + performance + win breakdown and a satisfying count-up into the persistent total. Avoid punishments, streak dependence and spending promises before rewards exist.

Use a server-owned account ledger at the shared authority, with a unique account/match receipt so retries, regional outages, reconnects and replay viewing cannot grant rewards twice. Clients never submit balances or earned amounts. An account's balance survives renames and is the same across regions/devices. Keep ledger entries distinguishable from Elo records, with a policy version for later balancing.

Scope eligibility to official server-run queues with fixed rules initially; custom hosts must not manufacture rewards by changing gold, bot difficulty, damage or match length. Establish a minimal meaningful-participation check before granting a completion reward; distinguish a played loss from idle/disconnected seats. Casual official bot games may earn progression independently of whether the match qualifies for Elo. Do not add a blanket real-world daily cap or change combat rules to implement this reward loop.

Starting tuning proposal, to validate before release: base reward dominates; performance/win bonuses together stay below the base amount. The values are provisional, and rewards have no cash value. Until the small shop actually ships, the UI should describe cosmetics as planned rather than imply rewards are already spendable.

Acceptance: eligible loss earns a positive base; win/performance add explained bonuses; duplicate submissions and replay viewing grant nothing extra; invalid/custom/idle matches grant nothing; shared account balance persists through two-device login, region change, server restart and rename. Server policy, not the browser, decides eligibility and reward amount.

## Small daily cosmetic selection

Close the progression loop with a discreet Collection/Shop entry from the profile and a balance shortcut after matches. A small selection refreshes daily, initially using a handful of victory poses or low-cost robe variations. Hats, new character models and a broad customization editor can follow after this slice works. Keep the existing starter look and feedback satisfying.

Use a shared server-defined daily selection and UTC refresh boundary; show the next refresh clearly without popups interrupting play. Purchases spend the earned account currency, permanently unlock the chosen cosmetic and sync across devices. Owned items remain available after the daily selection changes. The daily selection should not depend on a player's local clock. Start with a tiny explicit catalog, not a new marketplace framework.

An atomic account transaction must check the offer/version, price, balance and ownership before recording the purchase and deducting currency. Retry keys prevent duplicate charges; concurrent purchases cannot overspend. A cosmetics screen equips owned items, and match presentation reads validated equipment. Keep new cosmetics visually readable in combat, with the same mechanics and hitboxes.

Show the earned amount and new balance after each match. Later premium outfits/poses or a separate paid currency can help fund hosting, while payment integration and licensing decisions remain a later step.

## Ranked format moved into the current release

The user selected the upcoming combined release for the shorter eight-player ranked format. It is implemented locally and documented in [RANKED-FORMAT.md](RANKED-FORMAT.md). This is no longer deferred to the accounts/currency sprint. Casual Quick Play and custom games retain their separate flexible formats.
