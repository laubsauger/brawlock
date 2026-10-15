# Warlock Brawl (Dota 2 custom game) - Systems Reference

Scope: economy, shop, items, masteries, pawn stats, game setup/lobby, round flow and scoring, AI, UI, heroes.
Individual spell behaviour is catalogued separately (another agent); this file only touches spells where the
shop/economy/mastery/AI systems depend on them.

Source snapshot: `warlockbrawl/warlock` git HEAD `1cc00c9` ("dont track compiled files", 2022-01-15).
Path abbreviations used below:

- `vs/` = `game/dota_addons/warlock/scripts/vscripts/`
- `npc/` = `game/dota_addons/warlock/scripts/npc/`
- `pano/` = `content/dota_addons/warlock/panorama/`
- `loc/` = `game/dota_addons/warlock/panorama/localization/addon_english.txt` (Panorama strings)
- `res/` = `game/dota_addons/warlock/resource/addon_english.txt` (Dota tooltip strings, UTF-16)

Units: Dota/Source world units; time in seconds. Server tick is `Config.GAME_TICK_RATE = 0.035` s (~28.6 Hz,
`vs/base/config.lua:15`). All gameplay (physics, damage, scoring) is Lua-side; the Dota engine is only used for
unit rendering, move orders/pathing, cast animations/cast points/cooldowns, inventory and the HUD.

---------------------------------------------------------------------------------------------------------------

## 1. Economy

### 1.1 Currency
- One currency, "gold"/"cash", stored server-side in `Player.cash` (`vs/base/player.lua:23`). Integer in practice.
- Dota's native gold is disabled: `GameRules:SetGoldPerTick(0)`, `SetStartingGold(0)`, hero bounties 0,
  first blood disabled (`vs/base/game.lua:152-159`, `vs/base/pawn.lua:34-35`).
- The script value is mirrored into Dota's reliable gold (`PlayerResource:SetGold(id, cash, true)` and unreliable
  set to 0) on every change and re-synced every 5 s (`vs/base/player.lua:249-252`, `:420-430`). The custom shop
  UI reads it with `Players.GetGold` every 0.1 s.

### 1.2 Income sources (all host-configurable; defaults from `vs/base/gamesetup.lua:104-122` and UI defaults)

| Source | Option id / UI label | Default | When paid | Who gets it | Code |
|---|---|---|---|---|---|
| Start gold | 8 `Start Gold:` | **30** | `Mode:onStart()` (when the game starts, before the first shop phase) | every player in `GAME.players` | `vs/base/mode.lua:55-60` |
| Round gold | 7 `Round Gold:` | **10** | `Mode:onRoundEnd()` (2 s after the round was decided; DM: every 60 s round end) | every player in `GAME.players` (incl. dead, disconnected, bots) | `vs/base/mode.lua:237-249`, `:510-516` |
| Kill gold | 9 `Kill Gold:` | **0** | 1.0 s after the kill (`GAME:addTask{time=1}`) | killer's owner, only if `killer ~= victim` | `vs/base/mode.lua:252-271` |
| Win gold | 10 `Win Gold:` | **0** | immediately in `onRoundWon` | every player in the winning team (`winner_team.players`, alive or dead) | `vs/base/mode.lua:227-230` |

Notes:
- With defaults there is **no performance-based income at all**: every player has exactly `30 + 10 * roundsEnded`
  gold earned. Kill/win gold exist only as lobby options.
- No damage-based, placement-based or interest income. No gold for assists (assists are not tracked).
- "Killer" = `dmg_info.source` of the lethal hit, or `pawn.last_hitter` if the lethal damage had no source (lava),
  or the victim itself if neither (`vs/base/pawn.lua:155-187`). `last_hitter` is the last actor that dealt
  sourced damage this life (reset on respawn). So lava kills are credited to whoever hit you last.
- Round gold in Deathmatch is paid every 60-second round end.

### 1.3 Catch-up mechanic (late joiners only)
- `Mode:addGoldForAll(amount)` adds to every player **and** accumulates the amount into `mode.new_player_cash`
  (`vs/base/mode.lua:40-53`). Start gold and round gold go through it; kill/win gold do not.
- When a hero spawns after the mode exists, `Player:HeroSpawned` calls `GAME.mode:addNewPlayerGold(self)`, giving
  the newcomer all start+round gold handed out so far (`vs/base/player.lua:114-118`). Bots added mid-game get the
  same. This is the only catch-up mechanic; there is no comeback gold for losing players.

### 1.4 Spending rules, refunds, selling
- Purchases deduct cash immediately; a purchase is rejected (silently, no UI feedback) if `player.cash < cost`.
- **No selling, no refunds, no respec.** All item KV entries have `"ItemSellable" "0"`, `"ItemDroppable" "0"`;
  `Item:onSell()` exists (`vs/base/item.lua:33-35`, `:96-101`) but nothing calls it. Once a spell is bought into a
  column it can never be replaced. Masteries cannot be un-learned.
- Gold carries over between rounds indefinitely (no cap).

---------------------------------------------------------------------------------------------------------------

## 2. Shop

### 2.1 What can be bought
Three categories (`vs/base/shop.lua`):
1. **Spells** - 24 spells in 6 columns ("slots"); max one spell per column; buy at level 1, upgrade to level 7.
2. **Masteries** - 3 passive masteries, 6 levels each, plus an "upgrade all" bundle.
3. **Items** - 10 entries; occupy Dota inventory slots (6 total); buying an owned item upgrades it.

### 2.2 When the shop is open
- **The server never checks the game phase.** `Game:setShop()` is an empty function (`vs/base/game.lua:261-262`) and
  none of `Shop:buySpell/upgradeSpell/buyItem/upgradeMastery/upgradeAllMasteries` check `GAME.combat`, alive state or
  anything else besides cash/slot/level limits. The shop UI panel can be toggled at any time.
- In practice the designed flow is a **30 s "SHOPTIME" phase before each round** (`Mode.SHOP_TIME = 30`,
  `vs/base/mode.lua:5`) during which damage is disabled, plus a chat hint "Buy new spells in the shop" at t=1 s.
  But players can (and in Deathmatch must) buy during combat too, including while dead.
- Bots only buy while `not GAME.combat or not alive` (AI-side restriction only).

### 2.3 Spell columns
Column semantics from the empty-slot tooltips (`res/`, `warlockgen/template_addon_english.txt:49-60`) and comment
letters in `shop.lua` (WC3-era hotkey labels; the in-game shop shows column numbers 1-6):

| Column | Comment letter | Empty-slot tooltip type | Spells |
|---|---|---|---|
| 1 | D | knockout-type | Boomerang, Lightning, Homing, Twin |
| 2 | R | transportation-type | Teleport, Thrust, Swap |
| 3 | T | damage-type | Cluster, Drain, Bouncer, Recharge |
| 4 | E | devastator-type | Windwalk, Meteor, Splitter, Snowball |
| 5 | C | defense-type | Shield, Rush, Alteration |
| 6 | Y | knockbackless-type | Gravity, Grip, Warpzone, Magnetize, Rockpillar, Link |

Empty slot = ability `warlock_emptyslotN` (icon `rubick_empty1`, max level 0). Buying removes the empty-slot ability
and adds the spell ability at index `column-1`, level 1 (`vs/base/shop.lua:212-225`).

### 2.4 Spell costs (`Shop.SPELL_DEFS`, `vs/base/shop.lua:23-59`; mirrored in `pano/scripts/custom_game/shop/warlock_shop_data.js:8-44`)
`Shop.SPELL_MAX_LEVEL = 7`. Upgrade from level L to L+1 costs `upgrade_cost[L]` (6 entries).
Index = position in `SPELL_DEFS` (used by AI).

| # | Spell | Col | Buy | Upgrade costs L1->2 ... L6->7 | Sum upgrades | Total to L7 |
|---|---|---|---|---|---|---|
| 1 | Boomerang | 1 | 11 | 7 / 8 / 9 / 10 / 11 / 12 | 57 | 68 |
| 2 | Lightning | 1 | 11 | 8 / 9 / 10 / 11 / 12 / 13 | 63 | 74 |
| 3 | Homing | 1 | 11 | 8 / 9 / 10 / 11 / 12 / 13 | 63 | 74 |
| 4 | Twin | 1 | 12 | 7 / 8 / 9 / 10 / 11 / 12 | 57 | 69 |
| 5 | Teleport | 2 | 12 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 63 |
| 6 | Thrust | 2 | 11 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 62 |
| 7 | Swap | 2 | 11 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 62 |
| 8 | Cluster | 3 | 14 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 65 |
| 9 | Drain | 3 | 14 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 65 |
| 10 | Bouncer | 3 | 14 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 65 |
| 11 | Recharge | 3 | 13 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 64 |
| 12 | Windwalk | 4 | 14 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 65 |
| 13 | Meteor | 4 | 14 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 65 |
| 14 | Splitter | 4 | 15 | 7 / 8 / 9 / 10 / 11 / 12 | 57 | 72 |
| 15 | Snowball | 4 | 14 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 65 |
| 16 | Shield | 5 | 12 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 63 |
| 17 | Rush | 5 | 12 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 63 |
| 18 | Alteration | 5 | 11 | 5 / 6 / 7 / 8 / 9 / 10 | 45 | 56 |
| 19 | Gravity | 6 | 12 | 7 / 8 / 9 / 10 / 11 / 12 | 57 | 69 |
| 20 | Grip | 6 | 12 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 63 |
| 21 | Warpzone | 6 | 12 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 63 |
| 22 | Magnetize | 6 | 14 | 5 / 6 / 7 / 8 / 9 / 10 | 45 | 59 |
| 23 | Rockpillar | 6 | 13 | 5 / 6 / 7 / 8 / 9 / 10 | 45 | 58 |
| 24 | Link | 6 | 12 | 6 / 7 / 8 / 9 / 10 / 11 | 51 | 63 |

The ability KV (`npc/npc_abilities_custom.txt`) also carries an `upgrade_cost` special value (tooltip only); it matches
the Lua tables except Warpzone lists 7 values `6 7 8 9 10 11 12` (only 6 are used by Lua).

Rules (`Shop:buySpell`, `vs/base/shop.lua:187-234`; `Shop:upgradeSpell`, `:236-293`):
- Buy fails if column already has a spell, or `cash < buy_cost`.
- Upgrade addresses a **column** (not a spell name); fails if column empty, level >= 7, `cash < upgrade_cost[level]`.
- Spell level is set with `ability:SetLevel(level)`; level-dependent values come from KV `AbilitySpecial` arrays.
- Hero is force-levelled to 100 with 0 ability points (`vs/base/pawn.lua:37-42`), so Dota's own skill-up UI can never
  be used; levels only come from the shop.

### 2.5 Mastery costs
See section 4. `Shop.MASTERY_COST = 5` per level, `Shop.MASTERY_ALL_COST = 13` to raise all three by one.

### 2.6 Item costs and slots
`Shop.MAX_ITEMS = 6` (`vs/base/shop.lua:63`). Fireball (level 1) and Scourge (level 1) are given free at hero spawn
(`GAME.shop:giveItem(self, 2)` then `giveItem(self, 1)`, `vs/base/player.lua:94-95`), so **4 slots remain** for the
8 other items. Each level of an item costs the same `buy_cost` (flat per level). See section 3 for effects.

| Item | Cost per level | Max level | Cost of all levels | Slot |
|---|---|---|---|---|
| Scourge | 7 | 3 | lvl1 free; 14 for lvl2+3 | starts in slot 2 |
| Fireball | 7 | 7 | lvl1 free; 42 for lvl2..7 | starts in slot 1 |
| Ring of Health | 4 | 5 | 20 | uses a slot |
| Cursed Ring | 4 | 2 | 8 | uses a slot |
| Cape | 3 | 3 | 9 | uses a slot |
| Armor | 6 | 3 | 18 | uses a slot |
| Boots | 5 | 3 | 15 | uses a slot |
| Pocket Watch | 2 | 2 | 4 | uses a slot |
| Redirector | 8 | 1 | 8 | uses a slot |
| Pact | 10 | 1 | 10 | uses a slot |

`Shop:buyItem` (`vs/base/shop.lua:344-453`):
1. Reject if `cash < buy_cost`.
2. Scan the 6 shop slots: if the item is already owned -> upgrade path; remember first free slot otherwise.
3. Upgrade: reject at max level; find the Dota item `<item_name><level>` in hero slots 0-5, `RemoveSelf()` it,
   create `<item_name><level+1>` and `AddItem` it (lands in the first free native slot, i.e. usually the same one),
   call `ModifierItem:onUpgrade(level)`. Side effect: the new item entity has **no cooldown** (upgrading a used
   Fireball/Scourge mid-combat resets its cooldown).
4. New item: reject if no free slot; create `<item_name>1`, `AddItem`, create a `ModifierItem`.
5. Deduct cash; `pawn:applyStats()`.

### 2.7 Buy UI flow and client/server protocol
All messages are Panorama custom game events (no declarations in `custom_events.txt`, which is empty).

Client -> server (`GameEvents.SendCustomGameEventToServer`):

| Event | Payload | Server handler | Reply |
|---|---|---|---|
| `shop_buy_spell` | `{ name: "<SpellName>" }` (case-insensitive match on `SPELL_DEFS[i].name`) | `ShopUI:onBuySpell` | `shop_spell_column_info` for that column if bought |
| `shop_upgrade_spell` | `{ column: 1..6 }` | `ShopUI:onUpgradeSpell` | `shop_spell_column_info` if upgraded |
| `shop_spell_info_request` | `{}` (sent at UI init) | `ShopUI:onSpellInfoRequest` | 6x `shop_spell_column_info` |
| `shop_upgrade_mastery` | `{ name: "Duration"|"Range"|"Lifesteal" }` | `ShopUI:onUpgradeMastery` | `shop_mastery_info` if upgraded |
| `shop_upgrade_all_masteries` | `{}` | `ShopUI:onUpgradeAllMasteries` | `shop_mastery_info` if upgraded |
| `shop_mastery_info_request` | `{}` (sent at UI init) | `ShopUI:onMasteryInfoRequest` | `shop_mastery_info` |
| `shop_buy_item` | `{ name: "<ItemName>" }` e.g. `"Ring of Health"` | `ShopUI:onBuyItem` | none (item appears in the native inventory) |

Server -> client (`Send_ServerToPlayer`):
- `shop_spell_column_info` `{ column, spell_name?, level? }` (spell fields absent if column empty).
- `shop_mastery_info` `{ levels: {1: n, 2: n, 3: n} }`.

Failures send nothing back (no error toast). The PlayerID is taken from the event (`args.PlayerID`).

UI flow (see section 9.3 for layout): click a spell icon -> `shop_buy_spell`; on reply the column is replaced by the
bought spell's icon + 7 level bars + "+" upgrade button showing the next upgrade cost. Click "+" on a mastery ->
`shop_upgrade_mastery`. Click item -> `shop_buy_item` (buy or upgrade). Hover shows name+description in the tooltip box.

---------------------------------------------------------------------------------------------------------------

## 3. Items

Two implementation kinds:
- **Passive stat items** (Ring of Health, Cursed Ring, Cape, Armor, Boots, Pocket Watch): a server `ModifierItem`
  (`vs/base/item.lua:41-101`) holds one `Modifier` per level built from `Shop.ITEM_DEFS[i].mod_defs`. On upgrade
  the old level's modifier is removed and the new one added - **values are absolute per level, not additive**.
  Modifiers are permanent (`temporary=false`): they survive death and round resets. The Dota item entities
  (`item_warlock_<name><level>`, `DOTA_ABILITY_BEHAVIOR_PASSIVE`, generated by `warlockgen/warlockgen.py`) are
  cosmetic only (icon with the level number drawn on it, tooltip).
- **Active items** (Fireball, Scourge, Redirector, Pact): `item_datadriven` with `OnSpellStart -> RunScript
  triggers.lua cast` which dispatches to a Lua `Spell` registered under the item name. Their `ModifierItem` has
  empty mod_defs (no stats).

Stat fields a Modifier can carry and how they apply (`vs/base/modifier.lua:70-77`, `:131-140`, sign +1 on add,
-1 on remove):

```
p.move_speed    += speed_bonus_abs
p.max_hp        += hp_bonus
p.hp_regen      += hp_regen
p.mass          += mass
p.dmg_factor    -= dmg_reduction_rel
p.kb_factor     -= kb_reduction
p.dmg_reduction += dmg_reduction_abs
p.debuff_factor += debuff_factor
```
All stacking across items/buffs is **additive** on these pawn fields.

### 3.1 Item catalogue

| Item | Dota item names | Lv values (server `Shop.ITEM_DEFS`) | Effect on pawn | Cost/lvl |
|---|---|---|---|---|
| **Ring of Health** | `item_warlock_ring_of_health1..5` | hp_bonus 100 / 190 / 270 / 340 / 400 | max HP 1100 / 1190 / 1270 / 1340 / 1400 | 4 |
| **Cursed Ring** | `item_warlock_cursed_ring1..2` | hp_bonus 100 / 200; kb_reduction 0.15 / 0.15; debuff_factor +0.25 / +0.30 | max HP +100/+200, kb_factor -0.15, debuffs on you last x1.25 / x1.30 | 4 |
| **Cape** | `item_warlock_cape1..3` | hp_regen 1.5 / 2.5 / 3.5 | regen 6.5 / 7.5 / 8.5 HP/s | 3 |
| **Armor** | `item_warlock_armor1..3` | kb_reduction 0.12 / 0.18 / 0.22 | kb_factor 0.88 / 0.82 / 0.78 | 6 |
| **Boots** | `item_warlock_boots1..3` | speed_bonus_abs 18 / 29 / 40 | move speed 228 / 239 / 250 | 5 |
| **Pocket Watch** | `item_warlock_pocket_watch1..2` | debuff_factor -0.35 / -0.45 | debuffs on you last x0.65 / x0.55 | 2 |
| **Fireball** | `item_warlock_fireball1..7` | KV damage 70/77/84/91/98/105/112 | active spell | 7 (lvl1 free) |
| **Scourge** | `item_warlock_scourge1..3` | KV damage 100/110/120, dp_reduce 0/20/30 | active spell | 7 (lvl1 free) |
| **Redirector** | `item_warlock_redirector1` | kb_penalty -0.3, kb_penalty_duration 8 | active | 8 |
| **Pact** | `item_warlock_pact1` | duration 5, damage_multiplier 1.5, speed_reduction 66, slow_duration 6 | active | 10 |

Combination examples (additive): Armor3 + Cursed Ring -> kb_factor 1 - 0.22 - 0.15 = 0.63. Pocket Watch2 + Cursed
Ring2 -> debuff_factor 1 - 0.45 + 0.30 = 0.85. Ring of Health 5 + Cursed Ring 2 -> 1600 max HP.

Buying an HP item raises max HP but **not current HP** (`applyStats` writes `self.health` back); HP is refilled at the
next respawn (round start).

Discrepancy: the client copy `warlock_shop_data.js:51` lists Cape `hp_regen 2 / 3.5 / 4.5`; the server (authoritative)
and the KV/generator use **1.5 / 2.5 / 3.5**. The client values are never applied.

### 3.2 Active items in detail

**Fireball** (`npc/npc_items_custom.txt` `item_warlock_fireball1..7`; `vs/warlock/spells/fireball.lua`)
- `DOTA_ABILITY_BEHAVIOR_POINT`, cast range GLOBAL, cast point **0.2**, cooldown **4.8**, anim `ACT_DOTA_ATTACK`
  (per-hero override via `GetCastAnimation` -> `CAST_ANIMS[2]`).
- Damage 70 + 7 per level (70..112); `range 1000`; projectile speed 1000 (lifetime = range/speed = 1.0 s, scaled by
  Range mastery), collision radius 25, `FireballProjectile = SimpleProjectile`: on hit deals damage with hit normal
  (knockback) and is destroyed. knockback_factor attribute missing -> 0 -> treated as 1.
- Visual `particles/units/heroes/hero_phoenix/phoenix_base_attack.vpcf`, sound `Fireball.Explode`.
- Shop tooltip: "Upgrades Fireball to deal 7 more damage".

**Scourge** (`item_warlock_scourge1..3`; `vs/warlock/spells/scourge.lua`)
- `NO_TARGET`, cast point **0.9** (cancellable windup: "Cancel spell casting by pressing the stop hotkey"), cooldown
  **3.0**, radius **250**.
- Deals `damage` (100/110/120) to every enemy pawn within 250 of the caster (flat damage); knockback factor lerps
  from 0.75 at the edge to 1.00 at the centre (`kb_factor_min = 0.75, kb_factor_max = 1.00`).
- Self cost: level 1 `setHealth(max(1, health - damage))` (i.e. 100, or 150 under Pact); levels 2-3 always 100 HP.
  Self cost cannot kill (floor 1 HP), bypasses damage pipeline (no knockback, no DP).
- Levels 2-3 ("Scourge Incarnation"): reduce own DP (mana) by `dp_reduce * enemiesHit` (20 / 30 per enemy).
- Visual `generic_aoe_explosion_sphere_1` tinted white / 255,100,100 / 255,0,0 by level. Sound `Scourge.Cast`.
- Shop entry name "Scourge" displays as "Scourge Incarnation": "Upgrades scourge to deal 10/20 more damage and
  recover 20/30 DP for each opponent struck".

**Redirector** (`item_warlock_redirector1`; `vs/warlock/spells/redirect.lua`)
- `POINT`, GLOBAL range, cast point 0.2, cooldown **24**.
- Finds the caster's own Projectile actor (any projectile whose instigator is the caster; Meteor excluded) closest to
  the target point; sets its velocity direction toward the target point (speed kept); adds 0.5 s lifetime
  (`setLifetime(remaining + 0.5)` - note `Projectile:setLifetime` multiplies by the Range mastery factor again, so
  the remaining lifetime is re-scaled by range mastery each redirect).
- Always (even if no projectile found) applies a self-debuff `Modifier{ kb_reduction = -0.3 }` (= +30% knockback taken)
  for `8 * own debuff_factor` s with effect `cour_rex_flying`. Sound `Redirector.Cast`.

**Pact** (`item_warlock_pact1`; `vs/warlock/spells/pact.lua`, `vs/warlock/modifiers/pactmodifier.lua`)
- `NO_TARGET`, cast point 0.2, cooldown **30**, sound `Pact.Cast`.
- Grants `PactModifier` for `5 * own Duration mastery factor` s (effect `rune_doubledamage`).
- On the owner's next spell cast where any of the cast attributes `damage`, `damage_min`, `damage_max` is non-zero,
  those attributes are multiplied by **1.5** for that cast, the buff is consumed, and a self-slow
  `Modifier{ speed_bonus_abs = -66 }` is applied for `6 * own debuff_factor` s. Includes Fireball and Scourge.
  Per the ability KV, spells **with** damage attributes (consume Pact): Boomerang, Lightning, Homing, Twin, Cluster,
  Bouncer, Drain, Recharge, Windwalk, Meteor (damage_min/max), Splitter, Snowball (damage + damage_max), Gravity,
  Link, Thrust, Fireball, Scourge. Spells **without** (do not consume): Grip, Warpzone, Magnetize, Rockpillar,
  Teleport, Swap, Shield, Rush, Alteration, Redirector. (Exact per-spell effect of the x1.5 depends on how each spell
  reads those attributes - see the spell catalogue.)
- Temporary modifier: removed on death and at round reset.

---------------------------------------------------------------------------------------------------------------

## 4. Masteries

Defined in `vs/base/shop.lua:5-17` and `vs/base/player.lua:10-13,32-36`.

- `Shop.MASTERY_MAX_LEVEL = 6`, `Shop.MASTERY_COST = 5` per level, `Shop.MASTERY_ALL_COST = 13` (raises all three by
  one level; only allowed if **all three** are below 6 - once any one is maxed the bundle is unavailable).
- Each player starts with factors Duration 1.0, Range 1.0, Lifesteal 0.0. Each level adds the gain below.

| Level | Duration gain (cum.) | Range gain (cum.) | Lifesteal gain (cum.) |
|---|---|---|---|
| 1 | +0.10 (1.10) | +0.12 (1.12) | +0.09 (0.09) |
| 2 | +0.08 (1.18) | +0.10 (1.22) | +0.08 (0.17) |
| 3 | +0.07 (1.25) | +0.09 (1.31) | +0.07 (0.24) |
| 4 | +0.06 (1.31) | +0.08 (1.39) | +0.06 (0.30) |
| 5 | +0.05 (1.36) | +0.07 (1.46) | +0.05 (0.35) |
| 6 | +0.04 (1.40) | +0.06 (1.52) | +0.04 (0.39) |

Cost to max everything: 6 x 13 = 78 via the bundle (vs 90 individually). Tooltips (`loc/`): Duration "Passively
grants 10/18/25/31/36/40 percent additional duration to all duration spells"; Range "12/22/31/39/46/52 percent
additional range to all missile spells"; Life steal "9/17/24/30/35/39 percent life steal (half the life stolen goes to
DP reduction)"; bundle "Jack of all trades: Increases the level of all masteries at 2 gold discount".

### 4.1 How each mastery is applied
- **Duration** (`mastery_factor[1]`):
  - Buffs: `Pawn:getBuffDuration(dur, buff_pawn) = dur * self.duration * (buff_pawn.duration if buff_pawn ~= self)`
    (`vs/base/pawn.lua:93-103`). Used by Shield, Rush, Windwalk, Alteration, Pact, Homing's buff, Drain heal buff,
    Magnetize (ally variant).
  - Debuffs: `Pawn:getDebuffDuration(dur, debuff_pawn) = dur * self.debuff_factor * (debuff_pawn.duration if
    debuff_pawn ~= self)` (`:106-116`) - the **caster's** Duration mastery lengthens debuffs inflicted on others; the
    **target's** debuff_factor (Pocket Watch / Cursed Ring) scales it. Self-debuffs (Redirector penalty, Pact slow)
    use only the own debuff_factor. Used by Grip, Magnetize, Drain slow.
  - Directly: Rockpillar duration and Warpzone lifetime multiply by caster duration factor; projectiles with
    `duration_mastery = true` multiply lifetime by it (`vs/base/projectile.lua:62-74`).
- **Range** (`mastery_factor[2]`): every `Projectile` multiplies its lifetime by the owner's range factor unless it
  opts out with `no_range_mastery` (`vs/base/projectile.lua:10-12,69-71`). Additionally spell code scales range for
  Boomerang, Twin, Link, Lightning (beam length), Drain (turn range and extra time), Swap, Splitter.
- **Lifesteal** (`mastery_factor[3]`): in `Pawn:receiveDamage`, after all reductions, the damage source heals
  `amount * lifesteal` (`vs/base/pawn.lua:298-305`). The heal goes through `Pawn:heal`, which also reduces the
  healer's DP by `0.5 * healed` (default `dp_factor 0.5`, `:225`). No lifesteal from sourceless (lava) damage.

Upgrades take effect immediately (factors are read at cast time).

---------------------------------------------------------------------------------------------------------------

## 5. Pawn (player character) stats

### 5.1 Base stats (`vs/base/config.lua:20-22`, `vs/base/pawn.lua:13,19-28,44-52`)

| Stat | Field | Base | Modified by |
|---|---|---|---|
| Max HP | `max_hp` | **1000** (`PAWN_MAX_LIFE`) | Ring of Health, Cursed Ring |
| HP regen | `hp_regen` | **5.0 HP/s** (`PAWN_HEALTH_REG`), applied per tick in `onPostTick` while alive | Cape |
| Move speed | `move_speed` | **210** (`PAWN_MOVE_SPEED`), pushed to Dota with `SetBaseMoveSpeed(max(0, ms))` | Boots, Pact slow, spells (Rush, Windwalk, Drain slow, ...) |
| Knockback factor | `kb_factor` | **1** (multiplies knockback taken; clamped at >= 0 in formula) | Armor, Cursed Ring, Redirector penalty, spells |
| Damage factor | `dmg_factor` | **1** (multiplies damage taken) | spells (`dmg_reduction_rel`) |
| Flat damage reduction | `dmg_reduction` | **0** | spells (`dmg_reduction_abs`) |
| Debuff factor | `debuff_factor` | **1** | Pocket Watch, Cursed Ring |
| Mass | `mass` | **100** | spells (`mass` modifier); obstacles 10000 |
| Collision radius | - | **30**, elastic, elasticity 0.5 | - |
| Walk velocity cap | `Pawn.WALK_SPEED` | **1000** (cap on per-tick walk velocity derived from engine movement) | - |
| DP / knockback points | Dota **mana** | 0 at respawn; max ~5000 (hero `StatusMana 4987` + 1 INT); `StatusManaRegen -0.04` | damage taken increases, heals decrease |

Dota hero KV (`npc/npc_heroes_custom.txt`) mirrors these (StatusHealth 981 + 1 STR ~ 1000, regen 4.97 ~ 5, speed 210,
no attack, `DOTA_UNIT_CAP_MOVE_FLY`, armor/magic resist -1, vision 1800, turn rate 1.2) but Lua overwrites HP/regen/
speed via `applyStats()`. Lifesteal is a player (mastery) stat, not a pawn stat.

### 5.2 Damage, DP and knockback pipeline (`Pawn:receiveDamage`, `vs/base/pawn.lua:241-330`)
```
if not GAME.combat or not enabled or invulnerable: ignore
amount *= Config.dmg_multiplier            (lobby option, default 1)
amount *= dmg_factor
amount -= dmg_reduction                    ; if amount <= 0: ignore
amount += sum(modifier.modifyDamageTaken)  ; if amount <= 0: ignore
DP(mana) += amount * (knockback_vulnerability_factor or 1)     (lava uses 0.5)
if hit_normal:
    kbp = DP (after this hit's increase)
    d   = amount if amount <= 100 else sqrt(100 * amount)
    kb  = max(0, kb_factor) * d * KB_DMG_TO_VELOCITY(10.0) * (1 + kbp/1000) * (knockback_factor or 1)
    kb *= Config.kb_multiplier             (lobby option, default 1)
    velocity += kb * hit_normal            (applyMomentum(kb*normal*mass)/mass)
amount += sum(modifier.modifyDamagePostKB)
if source has owner: owner.stats.damage += amount; lifesteal heal to source (section 4.1)
if source: last_hitter = source; floating red number
health -= amount; if health <= 1 -> die (health 0)
```
- Friction: each tick `velocity *= Config.FRICTION` (default **0.96 per tick**, i.e. ~0.31 per second at 0.035 s
  ticks; frame-rate dependent - preserve the 0.035 s tick or convert). Lobby option "Physics Friction".
- Heal: `health = min(max_hp, health + amount)`, `DP -= dp_factor(0.5) * amount`, floating green number, healer's
  `stats.healing += amount` (`:219-239`).
- Lava: `Arena.DAMAGE_PER_SECOND = 100` (lobby "Lava DPS") applied as `100 * 0.25` every `DAMAGE_PERIOD = 0.25` s to
  every enabled pawn not standing on a tile, `knockback_vulnerability_factor 0.5`, no source, no hit_normal
  (`vs/base/arena.lua:9-12,123-149`).
- Arena hard bound: actors are clamped to radius `GAME_ARENA_RADIUS = 5910`.
- Death: `Pawn:die` sets HP 0, `unit:Kill(nil, killerUnit)` (native kill credit), disables the pawn, fires
  `Mode:onKill`, then `modOnDeath` (temporary modifiers removed).
- Respawn (`Pawn:respawn`, `:130-153`): velocity 0, location = mode respawn point, last_hitter nil, enable, revive
  hero, **DP (mana) = 0, all spell and item cooldowns reset, health = max_hp**, Recharge combo counter reset.

---------------------------------------------------------------------------------------------------------------

## 6. Game setup, lobby options, modes, commands, bots, disconnects

### 6.1 Lobby options (`vs/base/gamesetup.lua`; UI `pano/layout/custom_game/warlock_start_selection.xml`)
Stored in net table `wl_game_options`, key = option index as string, value `{ value = v }`. Only the host
(`GameRules:PlayerHasCustomGameHostPrivileges`) can set them (event `set_game_option {index, value}`).

| Id | Name | UI control | Default | Ranked override | Effect |
|---|---|---|---|---|---|
| 1 | `GAME_OPT_TEAM` | Team Mode dropdown: Shuffle / FFA / Teams | 1 Shuffle | 2 FFA | team mode class |
| 2 | `GAME_OPT_GAME` | Mode dropdown: Rounds / Deathmatch | 1 Rounds | 1 | `ModeLTS` / `ModeDeathmatch` |
| 3 | `GAME_OPT_WINC` | Win condition: Rounds / Score | 1 Rounds | 1 | `RoundWinCondition` / `ScoreWinCondition` |
| 4 | `GAME_OPT_WINC_MAX` | "Max Rounds/Score" text | 11 | 11 | round_count and max_score |
| 5 | `GAME_OPT_NODRAWS` | none | 0 | 0 | **unused** (no_draws is derived from team mode) |
| 6 | `GAME_OPT_TEAMSCORE` | none | 0 | 0 | use_team_score (always false in practice) |
| 7 | `GAME_OPT_CASH_ROUND` | Round Gold | 10 | 10 | |
| 8 | `GAME_OPT_CASH_START` | Start Gold | 30 | 30 | |
| 9 | `GAME_OPT_CASH_KILL` | Kill Gold | 0 | 0 | |
| 10 | `GAME_OPT_CASH_WIN` | Win Gold | 0 | 0 | |
| 11 | `GAME_OPT_BOT_COUNT` | Bot Count | 0 | 0 | bots added at game start (difficulty "hard", think 0.2 s) |
| 12 | `GAME_OPT_BOT_ON_DC` | "Bots for leavers" toggle | 1 (on) | 0 | AI takes over disconnected players |
| 13 | `GAME_OPT_LAVA_DPS` | Lava DPS (Constants tab) | 100 | 100 | `Arena.DAMAGE_PER_SECOND` |
| 14 | `GAME_OPT_KB_MULT` | Knockback Multiplier | 1 | 1 | `Config.kb_multiplier` |
| 15 | `GAME_OPT_DMG_MULT` | Damage Multiplier | 1 | 1 | `Config.dmg_multiplier` |
| 16 | `GAME_OPT_PHYS_FRICT` | Physics Friction | 0.96 | 0.96 | `Config.FRICTION` |
| 17 | `GAME_OPT_RANKED` | "Ranked" button | false | true | `Config.ranked` |

UI validation: integer fields must be non-negative integers (`String(~~text) === text`), otherwise not sent; float
fields are sent as `parseFloat(text)` without validation (NaN possible). The host client resends all text fields
every 1 s during setup and dropdowns/toggle on change; non-hosts mirror the net table read-only.

Mode selection happens at `DOTA_GAMERULES_STATE_PRE_GAME` (`Game:EventStateChanged` -> `Game:selectModes`,
`vs/base/game.lua:81-90`, `vs/base/gamesetup.lua:153-209`); it prints the chosen Mode/Team Mode/Win Condition/Ranked
to chat and calls `Game:start()` 3 s later.

Derived win-condition params: `detect_early_end = false`, `no_draws = (team option ~= Teams)`,
`use_team_score = option6 ~= 0` (always false - no UI), `max_score = round_count = option 4`.

### 6.2 Team modes (`vs/base/teammode.lua`), applied in `onNewRound()` at every round start
- **Teams** (`TeamMode`, "Teams (selected in lobby)"): keep the lobby assignment.
- **FFA** (`TeamModeFFA`, "Free for all"): each active player gets its own team from `Team.TEAM_IDS = {2,3,6,7,8,9,
  10,11,12,13}` in iteration order.
- **Shuffle** (`TeamModeShuffle`, "Shuffle (random teams every round)", **default**): every round, compute all
  divisors `d` of the active player count with `2 <= d <= n` (n=1: `{1}`); if more than one, pick uniformly among all
  except the largest (the largest = FFA), i.e. `team_counts[random(1, #team_counts - 1)]`; if only one divisor, use it.
  Shuffle players (n random pair swaps), deal them round-robin into `team_count` teams; announce "Team size: X / Team
  count: Y"; **reset all team scores to 0**. Examples: n=2 -> 1v1; 3,5,7 -> FFA; 4 -> 2v2; 6 -> 3v3 or 2v2v2;
  8 -> 4v4 or 2x4 teams of 2; 9 -> 3x3; 10 -> 5v5 or 5 teams of 2.

Teams (`vs/base/team.lua`): Dota team ids 2,3,6..13 with WC3 colours:

| Dota id | Name (team.lua) | Colour | Localization name (res/) |
|---|---|---|---|
| 2 | Red | #FF0303 | Red Team |
| 3 | Blue | #0042FF | Blue Team |
| 6 | Teal | #00FFFF | Teal Team |
| 7 | Purple | #540081 | Purple Team |
| 8 | Yellow | #FFFC01 | Yellow Team |
| 9 | Orange | #FF8803 | Orange Team |
| 10 | Green | #20C000 | Green Team |
| 11 | Pink | #E55BB0 | Gray Team (mismatch) |
| 12 | Gray | #959697 | Light Blue Team (mismatch) |
| 13 | Light Blue | #7EBFF1 | Dark Green Team (mismatch) |

Joining a team sets the player colour and health bar colour. "Active teams" (teams with >= 1 player) are compacted into
`active_team_id` 0..k-1, used for spawn angles.

### 6.3 Game modes
- **Rounds** (`ModeLTS`, "Rounds (1 score for winning team per round)"): last team standing wins the round.
- **Deathmatch** (`ModeDeathmatch`, "Deathmatch (60 second rounds, respawn after 10 seconds, 1 score per kill)").
  Details in section 7.

### 6.4 Win conditions (`vs/base/wincondition.lua`) - checked only in `onRoundEnd`
- **Rounds** (`RoundWinCondition`, "Up to N rounds"): game over when `mode.round >= round_count` (default 11).
- **Score** (`ScoreWinCondition`, "Up to N score"): game over when at least one player has `score >= max_score`.
- No-draw rule: if game over but the top score is shared by >1 player (or team when use_team_score) and `no_draws`
  (Shuffle and FFA), print "Game is tied! Continuing until a winner is found." and continue playing rounds.
  In Teams mode, draws are allowed, so all members of the top team (equal scores) are winners.
- Winners = all players with the highest score (Rounds) / highest score >= max (Score).
- `detect_early_end` is "not yet implemented" (warning) - no mercy rule.
- End: `Game:winGame(winners)` prints "A, B won the game!" or "The game ended in a draw!" plus "If you have found any
  bugs or have feedback please visit us at warlockbrawl.com", then `GameRules:SetGameWinner(DOTA_TEAM_GOODGUYS)`
  (post-game 10 s; the native end screen is not team-meaningful).

### 6.5 Ranked
- Host clicks "Ranked" (enabled in UI only when exactly 2 players) -> sets option 17 true and starts.
- Server: if `player_count ~= 2` prints "Can not start ranked game with more or less than two players." and falls back
  to unranked; otherwise forces the ranked option set (table above).
- Ranked effects in code: bot commands disabled; bot_on_dc off; on abandon (see 6.8) the last non-abandoned team
  wins immediately. No stats/MMR submission exists in this repo (`Config.DEDICATED_SERVER_VERSION = "WARLOCKBRAWL"`
  unused; `steam_id` stored but unused).

### 6.6 Console commands (`vs/base/commands.lua`, registered as `wl_<name>` server convars)
Always available (bot ones disabled in ranked):

| Command | Effect |
|---|---|
| `wl_addbotinsane` | add bot, think interval 0.01 s |
| `wl_addbothard` | add bot, think interval 0.2 s |
| `wl_addbotmedium` | add bot, think interval 0.5 s |
| `wl_addboteasy` | add bot, think interval 1.0 s |
| `wl_addbotdummy` | add bot, think interval 10,000,000 s (never acts) |
| `wl_fillbots` | 10x `addBot(math.random(0.2, 1.0))` (see quirks: Lua 5.1 coerces to ints) |
| `wl_actorlist`, `wl_tasklist`, `wl_teamlist` | debug dumps |
| `wl_fixinvis` | Dota invisibility workaround |

Tools-mode only (`Config.DEVELOPMENT = IsInToolsMode()`): `wl_f` (fake clients), `wl_s` (start now; references a
non-existent `GAME.task_start`), `wl_players`, `wl_projcount`, `wl_resetcd`, `wl_d` (disconnect), `wl_gold` (+1000 to
all; references non-existent `playersByUserid`, so broken), `wl_shield`, `wl_magnetize`, `wl_magnetize2`, `wl_rush`
(apply modifiers to all pawns), `wl_kill`, `wl_respawn`, `wl_stats` (prints pawn stats).
There are **no chat commands**.

### 6.7 Bots
- Added via `Game:addBot(think_interval)` -> `Tutorial:AddBot("npc_dota_hero_warlock", ...)`, only while
  `GAME.player_count < 10` and engine player count < 10. Bots are always the Warlock hero. When their hero spawns,
  an `AIController` is attached with `ai_def = { think_interval }`; they get late-join gold (section 1.3).
- Lobby "Bot Count" bots are added right after `mode:onStart()` with think interval 0.2 ("hard").
- Bot difficulty is **only** the think interval (reaction rate); the decision logic is identical (section 8).

### 6.8 Disconnects, reconnects, abandon (`vs/base/player.lua:128-182,293-374`)
- Detection: on the native `player_team` event with `disconnect == 1`, every known player whose connection state is
  not CONNECTED and not yet flagged gets `EventDisconnect`. Reconnects are polled every 1 s
  (`GetConnectionState == CONNECTED` and flagged).
- **bot_on_dc on (default, unranked)**: "Adding AI for disconnected player"; an AIController takes over the pawn with
  `buy_delay = Config.BOT_BUY_DELAY = 120` s (it will not buy for its first 120 s). The player stays active, keeps
  scoring and receiving gold. On reconnect the AI is removed.
- **bot_on_dc off (ranked)**: the pawn is killed with no kill credit (`last_hitter = nil`), disabled, hero
  force-killed, player marked inactive (excluded from team re-assignment and respawns). On reconnect: active again,
  respawned immediately if not in combat; in Deathmatch respawned after 10 s (+2 s invulnerability) if in combat.
- **Abandon timer**: `Config.ABANDON_TIME = 120` s per player, decremented by 1 per second while disconnected, set to
  0 if the engine reports ABANDONED. At exactly 60 s remaining prints "<name> has 1minute(s) to reconnect before
  abandoning." At 0: "<name> has abandoned the game."; in ranked, if only one team still has a non-abandoned player,
  that team wins. The timer is **never refilled** on reconnect (cumulative across disconnects).
- Players joining mid-round (hero spawns while `GAME.combat`) are killed immediately and play from the next round.

---------------------------------------------------------------------------------------------------------------

## 7. Round flow and scoring

### 7.1 Match start timeline
1. Loading screen.
2. **Game setup screen** (custom `GameSetup` UI): `Game.SetRemainingSetupTime(60)`, auto-launch disabled, team
   selection locked; host configures and presses Start (`SetRemainingSetupTime(0)`).
3. Hero selection: `SetHeroSelectionTime(1.0)`, same hero allowed, custom hero list of 7 (section 10) - effectively
   no time to pick (see ambiguities).
4. Pre-game: `SetPreGameTime(Config.GAME_START_TIME = 10)`. On entering PRE_GAME: `selectModes()`; +3 s `Game:start()`.
5. `Game:start()` polls every 1 s until >= 1 player exists, then: `in_progress = true`; chat "Welcome to Warlock",
   "Created by Toraxxx, Adynathos, Zymoran"; every player `initTeam()` (lobby team); `mode:onStart()` (start gold +
   `prepareForRound()`); add `bot_count` bots.
Physics/game logic only ticks while `in_progress`; timed tasks always run (paused when Dota is paused, detected by
dt == 0).

### 7.2 Rounds mode (`ModeLTS`) cycle
**Shop phase** - `Mode:prepareForRound()` (`vs/base/mode.lua:79-153`), duration `SHOP_TIME = 30` s:
- `combat = false` (all pawn and obstacle damage ignored, so lava/spells do nothing; physics still runs, projectiles
  still collide and vanish), remove all projectiles and temp actors, stop arena shrink.
- Obstacles: clear; pick a random obstacle variation 1..3 (stone ruins / rocks / barrels-poles-chest) and use the
  matching tile model set for the platform; rebuild the platform at layer `ARENA_BASE_LAYER + ARENA_LAYER_PER_PLAYER
  = 13 + 1 = 14`; spawn `random(2, 8)` obstacles at uniform random positions in `[-1000, 1000]^2`.
  Obstacles: HP 400, explode at 0 HP for 5-10 damage in radius 300.
- `respawnPlayers(true)`: every active player with a pawn respawns (full HP, DP 0, cooldowns reset), stats kept.
- Messages: center "SHOPTIME" for 25 s; chat "Round N in 30s/25s/20s/15s/10s/5s" at t = 0,5,...,25; chat "Buy new
  spells in the shop" at t = 1; center "3","2","1" (0.7 s each) at t = 27, 28, 29; center "FIGHT!" (1.0 s) at t = 30.
- Players can move and cast freely (practice) during the shop phase.

**Round start** - `Mode:onRoundStart()` (`:156-192`) at t = 30:
- `round += 1`, chat "Round N"; remove projectiles/temp actors; `combat = true`.
- `team_mode:onNewRound()` (re-team per section 6.2).
- `respawnPlayers(false)`: respawn all active players **and reset per-round stats** (damage, healing).
- All pawns: `Stop()` order, **2 s spawn invulnerability** (`pawn.invulnerable = true`; intended visual
  `modifier_omninight_guardian_angel` - misspelled name).
- Arena set to layer `13 + player_count` (clamped 1..21) and auto-shrink enabled: every `SHRINK_PERIOD = 10` s one
  layer is removed (tiles sink 0.5 units per 0.05 s, turning red, then disappear).
- `modOnReset()` removes all temporary modifiers.

Arena geometry (from `vs/base/arena.lua`, `warlockgen/arenagen.py`): tile size 192; layer L contains the tiles whose
centre is within radius `(L - 1) * 100` of the origin (layer 1 = no tiles, max layer 21 = radius 2000). Default
`player_count` p gives starting radius `(12 + p) * 100` (p=2: 1400). A location is safe iff its nearest tile exists.

Spawn positions (`Mode:getRespawnLocation`, `:274-285`):
```
angle  = (2*pi / active_team_count) * team.active_team_id + 0.2 * (team_player_index - (team.size - 1)/2)
radius = (13 + player_count) * 100 - 600
pos    = (radius*cos(angle), radius*sin(angle), GAME_Z=120)
```
Note `player_count` counts every player ever created (incl. bots and disconnected players), never decremented.

**Round end detection** - `ModeLTS:onKill` (`:294-306`): on every pawn death while `combat`, update team alive counts;
if `#aliveTeams <= 1`: `onRoundWon(aliveTeams[1])` (nil = draw). There is **no round time limit**; the shrinking
arena guarantees an end.

**Round won** - `Mode:onRoundWon(team)` (`:195-234`): `combat = false` immediately (survivors become immune);
chat "<Team> has won the round"; chat "<name> has dealt the highest damage (N)" for the top damage dealer this round
(if > 0); `team:addScore(1)` -> **+1 score to every member of the winning team, alive or dead**; win gold to each
member. Draw: chat "Draw", nobody scores.

**Round end** - 2 s later, `Mode:onRoundEnd()` (`:237-249`): chat "Round N has ended"; round gold to all; check win
condition -> next `prepareForRound()` (shop phase) or `winGame`.

Default LTS match: 11 rounds; each round = 30 s shop + fight + 2 s.

### 7.3 Deathmatch (`ModeDeathmatch`, `vs/base/mode.lua:313-559`)
- `RESPAWN_TIME = 10`, `ROUND_TIME = 60`.
- One 30 s shop phase before round 1 only (same prepareForRound sequence, plus `modOnReset`).
- `onRoundStart` (every 60 s): round += 1; re-team (Shuffle reshuffles every 60 s and resets team scores); rebuild
  obstacles (new variation, 2-8 obstacles) and platform at `13 + player_count`; round 1 only: combat on, respawn all,
  2 s invulnerability. **Auto-shrink is never enabled in DM.** Players are not respawned or stat-reset in later rounds
  (damage column becomes cumulative). Center countdown "3","2","1" at 57, 58, 59 s; at 60 s `onRoundEnd`.
- `onRoundEnd`: chat "Round N has ended", round gold to all, check win condition -> next DM round immediately (no
  shop phase) or end.
- `onKill`: kill gold (if configured), then `killer.owner.team:addScore(1)` (+1 to every member of the killer's
  team), then after 10 s respawn the victim (if still active) with 2 s invulnerability. **No `killer ~= victim`
  check**: a lava death with no previous attacker credits the victim's own team with +1 (bug).
- Win condition Rounds = number of 60 s rounds (default 11 = 11 minutes); Score = first to N.

### 7.4 Scoring, kills, damage
- `player.score` (displayed "Score") is the only scoring stat used for winning. `team.score` is also tracked but
  only used if use_team_score (never).
- Kills / Deaths in the scoreboard are Dota's native counters from `unit:Kill(nil, killerUnit)`; the killer is the
  lethal damage source or the last hitter (lava). A sourceless death with no last hitter is a native suicide.
- Assists: not tracked.
- Damage stat: sum of final damage (after all reductions) dealt to pawns, per player; reset each LTS round start;
  published every 1 s to net table `wl_scoreboard` key `"Damage"` (rounded) and `"Score"`.
- Healing stat: tracked (`STATS_HEALING`) but never displayed.

---------------------------------------------------------------------------------------------------------------

## 8. AI controller (`vs/base/aicontroller.lua`)

Constants: `think_interval = 0.2` (default), `danger_scale = 1000`, `danger_min_dst = 2000`,
`danger_min_cos_dst = -0.1`, `danger_dodge_thresh = 3`, `danger_dodge_delta = 10`.

### 8.1 Setup
- Finds the Fireball item (only if named exactly `item_warlock_fireball1`) and Scourge item (levels 1-3) in slots 0-5.
- Spell pools (indices into `Shop.SPELL_DEFS`):
  - target ("projectile") columns: `{1,2,3,4}` (Boomerang, Lightning, Homing, Twin), `{8,9,10,11}` (Cluster, Drain,
    Bouncer, Recharge), `{13,14,15}` (Meteor, Splitter, Snowball), `{19..24}` (Gravity, Grip, Warpzone, Magnetize,
    Rockpillar, Link).
  - escape spells: `{5,6,7}` (Teleport, Thrust, Swap).
  - Never bought or used: column 5 (Shield, Rush, Alteration) and Windwalk.
- `projectile_spells` starts as `{ Fireball }`. Existing abilities (for disconnect takeover) are scanned: known target
  spells are added to `projectile_spells` and their column removed from the buy pool; a known escape spell becomes
  `escape_spell`. (Windwalk special case is buggy - it looks for "Splitter" as the first entry of a column, which is
  never true.)
- `next_buy_time = buy_delay or 0` (0 for bots, 120 for disconnect takeover). Runs as a periodic task every
  `think_interval` seconds; `self.time` advances by `think_interval` per think.

### 8.2 Think step (in priority order)
1. **Buy**: if `time > next_buy_time` and (not in combat or own pawn dead) and `cash >= 15`:
   `next_buy_time += 40`, `buyRandomSpell()`, end think. `buyRandomSpell`: if no escape spell yet, 50% chance to buy a
   random escape spell (Teleport/Thrust/Swap); otherwise pick a random remaining target column (removed from the pool
   even if the purchase fails), a random spell in it, buy it and add it to `projectile_spells`.
   So bots buy at most one spell per 40 s, never upgrade spells, never buy items or masteries (gold accumulates).
2. If the pawn is alive:
   - `closest` = nearest enemy pawn (enemy by alliance).
   - **Lava escape**: if it owns an escape spell and stands on lava, with 1/3 chance cast it at its current wander
     target point and pick a new wander point.
   - **Retarget**: if no target, target dead, target not an enemy, or 1/5 chance -> `target_pawn = closest`.
   - **Wander point**: if within 100 of the wander point or `time > next_target_time`, choose a new one: with 1/11
     chance (and a live target) a random point within 200 of the target pawn, else a random point within
     `0.3 * current_layer * 192` of the arena centre (angle = random integer radians). `next_target_time` is advanced
     by a "random" delay (intended 0.4-0.8 s / 0.2-0.4 s; see quirks).
   - **Cast lock**: if `time < spell_end_time` (0.3 s after any projectile cast) do nothing.
   - `danger = getDanger(self.location)`.
   - **Scourge channel**: if `time < scourge_end_time` (1.0 s after starting Scourge): cancel (`Stop`) if
     `danger >= 3` or (closest enemy farther than 250 and 1/3 chance); otherwise keep channelling (end think).
   - **Dodge**: if `danger >= 3`, move to `location + 5000 * dodgeDirection` (end).
   - **Scourge**: if Scourge is castable and closest enemy within 300, with 1/6 chance cast it (end;
     `scourge_end_time = time + 1.0`).
   - **Shoot**: with 1/5 chance pick a uniformly random spell from `projectile_spells`; if castable, aim at the
     target pawn: with 1/3 chance (if the spell class has `projectile_speed`) at
     `location + 500 * predictedDir(target, speed)`, else directly at the target's location. On success
     `spell_end_time = time + 0.3` (end). If not castable, fall through.
   - **Move** to the wander point.

### 8.3 Danger field and dodge
```
getDanger(loc) = sum over enemy projectiles p with
                    dot(normalize(p.velocity), normalize(loc - p.location)) >= -0.1  and |loc - p.location| <= 2000
                 of  1000 / (1 + perpendicular distance from loc to the line through p along p.velocity)
dodgeDirection = normalize( D(loc) - D(loc + (10,0)),  D(loc) - D(loc + (0,10)) )     (negative finite-difference gradient)
```
One incoming projectile triggers dodging when its path passes within ~332 units (1000/(1+d) >= 3).

### 8.4 Aim prediction (`getPredictedDir`)
Solves `|delta + v_t * t| = speed * t` (delta = shooter - target, v_t = target velocity) for the smallest
non-negative t; returns `(v_t * t - delta) / (speed * t)`; falls back to the direct direction when no solution.

---------------------------------------------------------------------------------------------------------------

## 9. UI inventory

Custom UI manifest (`pano/layout/custom_game/custom_ui_manifest.xml`): LoadingScreen, GameSetup (start selection),
HUD: shop, camera, scoreboard. Hidden Dota defaults: hero-selection teams, inventory protect/courier/quickbuy/gold/
shop button, minimap. Everything else is the stock Dota HUD.

### 9.1 Loading screen
Full-screen `LoadingScreen.jpg` with a clickable "discord.gg/pSEUr3T" label + Discord logo (64 px) bottom-right.

### 9.2 Game setup (start selection) screen
Two dark panels (#333333F5), centred:
- Left: title "PLAYERS"; header "Player Name" / "Team"; one row per player: Steam avatar (40 px), Steam name, team
  dropdown "Team 1".."Team 10" (= Dota teams 2,3,6..13; enabled only for the host, who sends `set_team
  {player_id, new_team_id}`). Under it a red host label: "Waiting for the host to start the game for up to one minute."
  or "You are the host!\n\nChoose the settings and start the game within one minute."
- Right: tab buttons "General" / "Constants".
  - General: "MODES": Team Mode (Shuffle/FFA/Teams), Mode (Rounds/Deathmatch), Win condition (Rounds/Score),
    Max Rounds/Score (11). "CONSTANTS": Round Gold 10, Start Gold 30, Kill Gold 0, Win Gold 0, Bot Count 0,
    Bots for leavers [toggle, on].
  - Constants: Lava DPS 100, Knockback Multiplier 1, Damage Multiplier 1, Physics Friction 0.96.
  - Buttons "Start" and "Ranked" (Ranked enabled only with exactly 2 players). All controls disabled for non-hosts.

### 9.3 Shop (always present HUD layer, top-centre, 50 px from top)
- Gold display: number (30 px, yellow) + gold coin icon, centred.
- Toggle button "Close Shop"/"Open Shop" (shop starts **open**).
- Three rounded areas side by side (bg #333333F0, headers in #96FF00):
  1. **Masteries**: 3 cards (Duration = pugna_nether_blast icon, Range = pugna_nether_ward, Lifesteal =
     pugna_life_drain): round 40 px icon, 6 stacked level bars (white, active = #BBFF00), "+" button with cost "5".
     Below: a wide "+" button (200x40) for "Jack of all trades" (upgrade all, cost 13 - cost not shown).
  2. **Spells**: 6 columns headed "1".."6"; each lists its spells as 40x40 icon buttons with the buy cost in the top-
     left corner. After purchase the column shows the owned spell's round icon, 7 level bars and a "+" button with the
     next upgrade cost (blank at max).
  3. **Items**: vertical list of 10 buttons (80x50 icon, cost top-left): Scourge (abaddon_borrowed_time_alliance icon),
     Fireball (ogre_magi_ignite), Ring of Health, Cursed Ring (ring_of_regen), Cape (cloak), Armor (assault),
     Boots, Pocket Watch (talisman_of_evasion), Redirector (disruptor_kinetic_field), Pact (abaddon death coil).
     Item levels are not shown in the shop; the native inventory icons have the level number drawn on them
     (yellow, red at max level; `warlockgen/makeicon.py`).
- Tooltip box (360x160) under the shop: title + description of the last hovered element.
- No disabled/affordability state, no error feedback, no indication of shop phase.

### 9.4 Scoreboard (top-right)
- "Scoreboard" toggle button; the panel is hidden by default.
- Columns: Avatar | Name | Kills | Deaths | Score | Damage. Rows for all player IDs (polled every 1 s), unsorted,
  no team/colour column. Kills/Deaths from native Dota counters; Score/Damage from net table `wl_scoreboard`
  (server pushes every 1 s).

### 9.5 Camera (`pano/scripts/custom_game/warlock_camera.js`)
- Stock Dota camera (free pan, follow etc.), with custom mouse-wheel zoom: distance clamped to **500..1500**, start
  **1100**, **200 per wheel notch** (computed from the current, not target, distance), smoothed each 1/60 s with
  `dist = 0.8 * dist + 0.2 * target`.

### 9.6 In-game HUD elements kept from Dota
- Ability bar with 6 spell slots (empty-slot icons until bought), inventory with 6 item slots (Fireball, Scourge, ...),
  HP bar (= HP), **mana bar = DP / knockback points**, hero portrait, top bar, chat (all game announcements are chat
  lines via `Say`, light green; errors red, warnings yellow), center messages (`show_center_message`: SHOPTIME,
  3-2-1, FIGHT!).
- Floating combat numbers: damage red (255,50,50) or spell-specific colour, heals green (50,255,50), 1 s, integers.
- Lava: burn particle (`modifier_phoenix_icarus_dive_burn`) while on lava. Sinking tiles tint red.
- Fog of war disabled; vision 1800.

---------------------------------------------------------------------------------------------------------------

## 10. Heroes / models

Custom hero list (`npc/herolist.txt`), all override heroes share identical stats (section 5.1) and 6 empty spell
slots. Per-hero settings in `Config.HERO_SETTINGS` (`vs/base/config.lua:24-88`): model scale and the animation used
for the 4 cast-animation classes (1 = none, 2 = generic cast, 3 = "Lightning" class, 4 = "Meteor" class).

| Dota hero | Scale | Generic cast (2) | Lightning (3) | Meteor (4) |
|---|---|---|---|---|
| npc_dota_hero_warlock | 0.65 | ACT_DOTA_CAST_ABILITY_4 | ACT_DOTA_CAST_ABILITY_2 | ACT_DOTA_FATAL_BONDS |
| npc_dota_hero_invoker | 0.55 | ACT_DOTA_ATTACK | ACT_DOTA_CAST_SUN_STRIKE | ACT_DOTA_CAST_SUN_STRIKE |
| npc_dota_hero_rubick | 0.50 | ACT_DOTA_CAST_ABILITY_5 | ACT_DOTA_CAST_ABILITY_5 | ACT_DOTA_CAST_ABILITY_5 |
| npc_dota_hero_lina | 0.65 | ACT_DOTA_ATTACK | ACT_DOTA_CAST_ABILITY_4 | ACT_DOTA_CAST_ABILITY_2 |
| npc_dota_hero_oracle | 0.65 | ACT_DOTA_ATTACK | ACT_DOTA_CAST_ABILITY_2 | ACT_DOTA_CAST_ABILITY_4 |
| npc_dota_hero_arc_warden | 0.65 | ACT_DOTA_ATTACK | ACT_DOTA_CAST_ABILITY_1 | ACT_DOTA_CAST_ABILITY_3 |
| npc_dota_hero_crystal_maiden | 0.68 | ACT_DOTA_ATTACK | ACT_DOTA_CAST_ABILITY_2 | ACT_DOTA_CAST_ABILITY_1 |

Animation class per spell (`warlockgen/warlockgen.py:36-59`): class 3 Lightning; class 4 Meteor; class 1 (none):
Teleport, Rush, Windwalk, Shield, Swap, Alteration; class 2 (generic): everything else incl. Fireball. Scourge uses
`ACT_DOTA_DISABLED` (no anim) with its 0.9 s cast point.
- Staff and lantern wearables are stripped from the hero model at spawn (`vs/base/player.lua:102-112`).
- Bots always use Warlock. Only Warlock is explicitly precached.
- Movement: Dota pathing with `MOVE_FLY` capability (ignores terrain), turn rate 1.2.

---------------------------------------------------------------------------------------------------------------

## 11. Net tables and events summary
- Net tables (`custom_net_tables.txt`): `wl_game_options` (keys "1".."17" -> `{value}`), `wl_scoreboard`
  (`"Score"` and `"Damage"` -> `{ [playerId]: number }`).
- Client -> server events: `set_team`, `set_game_option`, `shop_buy_spell`, `shop_upgrade_spell`,
  `shop_spell_info_request`, `shop_upgrade_mastery`, `shop_upgrade_all_masteries`, `shop_mastery_info_request`,
  `shop_buy_item`.
- Server -> client: `shop_spell_column_info`, `shop_mastery_info`, native `show_center_message`, chat `Say`.

---------------------------------------------------------------------------------------------------------------

## 12. Quirks, bugs and ambiguities (decide per item whether v1 replicates)

1. **Shop is never closed server-side** (section 2.2). Faithful = allow buying anytime (incl. mid-round, dead).
2. **Default economy is flat**: identical gold for everyone (30 + 10/round); kill/win gold default 0.
3. **Deathmatch self-score bug**: sourceless death without last hitter gives the victim's team +1 score.
4. **DM never enables arena shrink**; DM damage column is cumulative (stats never reset after round 1).
5. **ScoreWinCondition order bug** (non-team branch, `wincondition.lua:174-184`): the list is not cleared when a
   higher score is found, so a lower-but-qualifying player iterated earlier is included as a winner. Combined with
   `no_draws` it can cause an extra "tied" continuation. Intended: winners = players with max score >= limit.
6. **Lua 5.1 `math.random` with floats**: `math.random(0.4, 0.8)`, `math.random(0.2, 0.4)` (AI wander delays) and
   `math.random(0.2, 1.0)` (`wl_fillbots` difficulty) are coerced to integers by Lua 5.1 (likely 0/0/0..1), so the
   wander delay is ~0 (AI re-picks a wander point almost every think -> jittery walk) and fillbots may get a 0 s think
   interval. Intended semantics: uniform float ranges.
7. **AI Fireball lookup** only matches `item_warlock_fireball1`; an AI taking over a player with an upgraded Fireball
   cannot cast Fireball. AI Windwalk handling is dead code (checks "Splitter").
8. **Lobby default team assignment bug**: new player rows get `player_team = rowIndex + 1` (1, 2, 3, ...), but valid ids
   are 2, 3, 6..13, so several rows reference non-existent dropdown entries. Irrelevant for Shuffle/FFA.
9. **Ranked default value**: option 17 defaults to boolean `false` and is tested with `~= 0`; if the net table keeps
   a Lua boolean, `false ~= 0` is true and any exactly-2-player game would be forced ranked. Engine conversion
   unknown; intended behaviour is clearly "ranked only when the Ranked button is pressed".
10. **Hero choice**: hero selection time is 1 s with 7 allowed heroes; players presumably end up with a random hero
    (or whatever they click instantly). Recommend: random cosmetic model per player, or a picker in the lobby.
11. **Scourge self-damage** at level 1 equals its damage attribute (so Pact makes it 150), levels 2-3 fixed 100.
12. **Redirector** re-applies the Range mastery factor to the projectile's remaining lifetime each use.
13. **Item upgrade resets that item's cooldown** (new Dota item entity).
14. **Abandon timer is never refilled**; the "minute(s)" message has no space and fires only at 60 s.
15. Client shop data Cape regen (2/3.5/4.5) disagrees with server (1.5/2.5/3.5). Team colour names in `team.lua` vs
    localization disagree for teams 11-13 (Pink/Gray/Light Blue vs Gray/Light Blue/Dark Green).
16. Spawn invulnerability modifier name `modifier_omninight_guardian_angel` is misspelled (no visual); the
    invulnerability itself works via a flag (2 s).
17. Friction is per tick (0.96 per 0.035 s); keep the 0.035 s fixed step or convert to per-second (`0.96^(dt/0.035)`).
18. Round end: when the last enemy dies, `combat` turns false at once, so simultaneous deaths in the same tick
    after the first are cancelled (no draw); draws only occur when the check finds zero alive teams.
19. Lifesteal heal uses the source pawn's `heal`, which also reduces the source's DP by half the heal.
20. `GAME.player_count` (arena size and spawn radius) includes disconnected players and bots forever.
21. Kill-credit for lava deaths persists for the whole life (`last_hitter` is not time-limited).

---------------------------------------------------------------------------------------------------------------

## 13. Constants appendix

```
Config.GAME_START_TIME       = 10        -- pre-game time
Config.GAME_TICK_RATE        = 0.035
Config.GAME_Z                = 120
Config.GAME_ARENA_RADIUS     = 5910
Config.PAWN_MAX_LIFE         = 1000
Config.PAWN_MOVE_SPEED       = 210
Config.PAWN_HEALTH_REG       = 5.0
Config.KB_DMG_TO_VELOCITY    = 10.0
Config.MAX_LEVEL             = 100
Config.OBSTACLE_MAX_COORD    = 1000
Config.FRICTION              = 0.96      -- lobby option 16
Config.BOT_BUY_DELAY         = 120
Config.ARENA_RADIUS_PER_LAYER= 100
Config.ARENA_BASE_LAYER      = 13
Config.ARENA_LAYER_PER_PLAYER= 1
Config.ARENA_SPAWN_INSET     = 600
Config.ABANDON_TIME          = 120
Config.bot_on_dc = true; bot_count = 0; dmg_multiplier = 1; kb_multiplier = 1; ranked = false

Mode.SHOP_TIME = 30; Mode.OBSTACLE_COUNT_MIN = 2; Mode.OBSTACLE_COUNT_MAX = 8
ModeDeathmatch.RESPAWN_TIME = 10; ModeDeathmatch.ROUND_TIME = 60
round-won -> round-end delay 2 s; spawn invulnerability 2 s; kill-gold delay 1 s

Arena.ARENA_TILE_SIZE = 192; ARENA_TILE_HEIGHT = 32; ARENA_TILE_Z = 42.5; ARENA_MAX_COORD = 20
Arena.SHRINK_PERIOD = 10; DAMAGE_PERIOD = 0.25; DAMAGE_PER_SECOND = 100 (option 13); DAMAGE_KB_POINT_FACTOR = 0.5
Arena.MAX_LAYER = 21 (radius (L-1)*100)

Obstacle.mass = 10000; max_health = 400; explode_radius = 300; explode_dmg_min = 5; explode_dmg_gain = 5
Obstacle radii: ruins 60 (x5); rocks 70/45/60/40; barrels 50/50, poles 35/35, chest 50; elasticity 0.5

Pawn.WALK_SPEED = 1000; pawn mass 100; pawn coll radius 30, elasticity 0.5

Shop.MASTERY_MAX_LEVEL = 6; MASTERY_COST = 5; MASTERY_ALL_COST = 13
Shop.MASTERY_GAIN = { {0.10,0.08,0.07,0.06,0.05,0.04}, {0.12,0.10,0.09,0.08,0.07,0.06}, {0.09,0.08,0.07,0.06,0.05,0.04} }
Shop.SPELL_MAX_LEVEL = 7; Shop.MAX_ITEMS = 6

AIController: think 0.2; danger_scale 1000; danger_min_dst 2000; danger_min_cos_dst -0.1;
              danger_dodge_thresh 3; danger_dodge_delta 10; buy every 40 s if cash >= 15
Bot think intervals: insane 0.01, hard 0.2 (lobby bots), medium 0.5, easy 1.0, dummy 1e7

Camera: dist 500..1500, default 1100, 200 per notch, smoothing 0.8 @ 60 Hz
Lobby: setup time 60 s; hero selection 1 s; post-game 10 s
```
