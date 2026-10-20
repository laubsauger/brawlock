# Warlock Brawl: Spell Catalog (reference for the faithful v1 browser rebuild)

Source: the `warlock` repo snapshot (one commit, "dont track compiled files"). Unless stated otherwise, paths are relative to
`game/dota_addons/warlock/scripts/vscripts/`. KV = `scripts/npc/npc_abilities_custom.txt` / `npc_items_custom.txt`.
Tooltips come from `resource/addon_english.txt` (UTF-16) and `panorama/localization/addon_english.txt`. The shop UI data is in
`content/dota_addons/warlock/panorama/scripts/custom_game/shop/warlock_shop_data.js`.

Brawlock balance override: Lightning detonations use the Fireball projectile's stored launch damage in place of the original's fixed `70`, so Fireball upgrades contribute to the combo. Full damage applies within 100 units of the explosion, then falls linearly to zero at 225; the `⅔` multiplier and 1.35 knockback factor remain. The original formulas and reference tables below are retained as source documentation.

Conventions:
- Distances are Source/Hammer units (u), time is seconds, velocity is u/s, angles are radians unless noted.
- Gameplay is 2D on the XY plane. Every actor sits at z = `GAME_Z` = 120 except the Meteor. Most distance checks use XY only; the ones that use 3D are called out.
- "rm" = the caster's **range mastery factor** (1.0 base, up to 1.52). "dm" = **duration mastery factor** (1.0 base, up to 1.40).
- "Lv" = spell level 1..7. Per-level KV arrays are indexed `level-1`.
- **[FLAG]** marks an ambiguity, a contradiction between sources, or a bug in the original. v1 should copy the *behaviour* the flag
  describes unless the team decides otherwise. Every flag is collected again in section 12.

---

## 0. Roster at a glance

| Col | Shop key label | Slot category (tooltip) | Spells (buy cost) |
|---|---|---|---|
| item | - | inventory item, **given at spawn** | **Fireball** (upgrade 7 g/lv, max 7), **Scourge** (upgrade 7 g/lv, max 3) |
| item | - | inventory item, bought | **Redirector** (8 g), **Pact** (10 g) |
| 1 | D | "knockout-type" | Boomerang 11, Lightning 11, Homing 11, Twin 12 |
| 2 | R | "transportation-type" | Teleport 12, Thrust 11, Swap 11 |
| 3 | T | "damage-type" | Cluster 14, Drain 14, Bouncer 14, Recharge 13 |
| 4 | E | "devastator-type" | Windwalk 14, Meteor 14, Splitter 15, Snowball 14 |
| 5 | C | "defense-type" | Shield 12, Rush 12, Alteration 11 |
| 6 | Y | "knockbackless-type" | Gravity 12, Grip 12, Warpzone 12, Magnetize 14, Rockpillar 13, Link 12 |

That is 26 shop spells plus 4 item spells. There is no other spell code: `spells/*.lua` contains exactly these 28 files (`fireball, scourge, redirect, pact` + 24 others).

---

## 1. Global constants that spells depend on

From `base/config.lua` unless noted.

| Constant | Value | Notes |
|---|---|---|
| `GAME_TICK_RATE` | 0.035 s | Server think interval. Physics `dt` is the measured game-time delta between ticks (nominally 0.035). |
| `GAME_Z` | 120 | Gameplay plane height. |
| `GAME_ARENA_RADIUS` | 5910 | Hard world boundary. An actor that leaves it is snapped back onto the circle and loses its radial velocity component (`v -= (v·r̂) r̂`). This applies to every actor, projectiles included. |
| `PAWN_MAX_LIFE` | 1000 | |
| `PAWN_MOVE_SPEED` | 210 | Base walk speed. |
| `PAWN_HEALTH_REG` | 5.0 HP/s | |
| `KB_DMG_TO_VELOCITY` | 10.0 | See §4. |
| `FRICTION` | 0.96 **per tick** | Game option `GAME_OPT_PHYS_FRICT`, default 0.96. At 0.035 s/tick this is ×0.3115 per second. Because it is applied per tick and not scaled by dt, the result depends on frame rate. |
| `dmg_multiplier`, `kb_multiplier` | 1, 1 | Game options. |
| Pawn | mass 100, collision radius 30, elastic, elasticity 0.5 | `base/pawn.lua` |
| `Pawn.WALK_SPEED` | 1000 | Cap on the derived walk velocity. |
| Obstacle | mass 10000, static, 400 HP | `base/obstacles.lua`. Explosion when destroyed: radius 300, damage `5 + 5·(1 − d/300)` to **all** pawns. |
| Lava | 100 DPS, applied every 0.25 s, `knockback_vulnerability_factor` 0.5 | `base/arena.lua`. No source, no hit normal, so no knockback. |
| Round start | pawns are invulnerable for 2 s | `base/mode.lua` |
| Damage gate | `Pawn:receiveDamage` and `Obstacle:receiveDamage` do nothing while `GAME.combat` is false (shop phase) | |
| Cash (default options) | 30 at start, +10 per round, 0 per kill, 0 per win | `base/gamesetup.lua` |

---

## 2. Spell slots, shop and levels

### 2.1 Slot structure (which spells compete)
- Every hero has 6 ability slots (`AbilityLayout 6`, `npc_heroes_custom.txt`) that start filled with `warlock_emptyslot1..6`. These are placeholders with MaxLevel 0.
- Shop column *c* (1..6) maps to ability index *c−1*. **A player holds at most one spell per column.** `Shop:buySpell` rejects a purchase if that column is already taken. There is no sell or replace path for spells, so the first spell bought in a column is permanent for the match. **[FLAG]** confirm that this is intended.
- The column labels D, R, T, E, C, Y come from comments in `base/shop.lua` and `warlock_shop_data.js`. The mod does not bind any keys itself: the Dota client uses whatever ability hotkeys the player has set for slots 1–6, which by Dota default are probably Q W E D F R. **[FLAG]** For the rebuild, use D/R/T/E/C/Y as the canonical layout, or make the keys configurable.
- Items: there are 6 inventory slots (`Shop.MAX_ITEMS`). Fireball (slot 1) and Scourge (slot 2) are granted in `Player:HeroSpawned` (`giveItem(self, 2)`, `giveItem(self, 1)`). Redirector and Pact are bought. Item hotkeys are the Dota item keys.
- Starting state: no ability spells, Fireball Lv1, Scourge Lv1, 30 gold.

### 2.2 Costs (authoritative source: `base/shop.lua`)
`upgrade_cost[L]` is the price to go from level L to level L+1 (6 entries, so max level 7).

| Spell | Buy | Upgrades Lv1→2 … 6→7 | Total to max |
|---|---|---|---|
| Boomerang | 11 | 7 8 9 10 11 12 | 68 |
| Lightning | 11 | 8 9 10 11 12 13 | 74 |
| Homing | 11 | 8 9 10 11 12 13 | 74 |
| Twin | 12 | 7 8 9 10 11 12 | 69 |
| Teleport | 12 | 6 7 8 9 10 11 | 63 |
| Thrust | 11 | 6 7 8 9 10 11 | 62 |
| Swap | 11 | 6 7 8 9 10 11 | 62 |
| Cluster | 14 | 6 7 8 9 10 11 | 65 |
| Drain | 14 | 6 7 8 9 10 11 | 65 |
| Bouncer | 14 | 6 7 8 9 10 11 | 65 |
| Recharge | 13 | 6 7 8 9 10 11 | 64 |
| Windwalk | 14 | 6 7 8 9 10 11 | 65 |
| Meteor | 14 | 6 7 8 9 10 11 | 65 |
| Splitter | 15 | 7 8 9 10 11 12 | 72 |
| Snowball | 14 | 6 7 8 9 10 11 | 65 |
| Shield | 12 | 6 7 8 9 10 11 | 63 |
| Rush | 12 | 6 7 8 9 10 11 | 63 |
| Alteration | 11 | 5 6 7 8 9 10 | 56 |
| Gravity | 12 | 7 8 9 10 11 12 | 69 |
| Grip | 12 | 6 7 8 9 10 11 | 63 |
| Warpzone | 12 | 6 7 8 9 10 11 | 63 |
| Magnetize | 14 | 5 6 7 8 9 10 | 59 |
| Rockpillar | 13 | 5 6 7 8 9 10 | 58 |
| Link | 12 | 6 7 8 9 10 11 | 63 |

The KV `upgrade_cost` specials are tooltip copies of these arrays. One differs: Warpzone's KV lists 7 values, `6 7 8 9 10 11 12` **[FLAG]**. The shop arrays are authoritative.

Items (`Shop.ITEM_DEFS`): Scourge buy_cost 7, max 3. Fireball 7, max 7. Ring of Health 4, max 5. Cursed Ring 4, max 2. Cape 3, max 3. Armor 6, max 3. Boots 5, max 3. Pocket Watch 2, max 2. Redirector 8, max 1. Pact 10, max 1. Buying an item you already own upgrades it for the same `buy_cost`.

### 2.3 How levels work
- **Ability spells:** buying sets the ability to level 1, and each upgrade calls `ability:SetLevel(L+1)`. Every numeric KV special is a 7-value array read at index `level-1`.
- **Item spells:** each level is a *separate item* (`item_warlock_fireball1..7`, `item_warlock_scourge1..3`) with `MaxLevel 1`. Upgrading removes item N and creates item N+1. Because the new item is a fresh entity, any cooldown on the old one is effectively dropped. All seven Fireball item ids map to the same Lua spell (`alt_ids`). Scourge 1, 2 and 3 are three separate Lua spells.
- **Masteries** (`Shop.MASTERY_GAIN`): max level 6. Each costs 5 gold, or 13 gold to raise all three at once (allowed only when none is maxed).

| Mastery | Per-level gain | Cumulative factor at Lv1..6 | Where it applies |
|---|---|---|---|
| Duration (`mastery_factor[1]`, base 1.0) | .10 .08 .07 .06 .05 .04 | 1.10 1.18 1.25 1.31 1.36 1.40 | Buff/debuff durations (§6.3), Warpzone and Rockpillar lifetimes |
| Range (`[2]`, base 1.0) | .12 .10 .09 .08 .07 .06 | 1.12 1.22 1.31 1.39 1.46 1.52 | Projectile lifetimes (§5.1); explicit range for Lightning, Boomerang, Twin, Link, Drain, Swap, Splitter |
| Lifesteal (`[3]`, base 0.0) | .09 .08 .07 .06 .05 .04 | 0.09 0.17 0.24 0.30 0.35 0.39 | Heals the damage source by `dealt × factor` on every damage instance (§4) |

### 2.4 Attribute resolution: `CastInfo:attribute(name)` (`base/spell.lua`)
Lookup order:
1. Per-cast overrides in `cast_info.attributes`. Only Pact writes these (§8, Pact).
2. **A field on the Lua spell class**, e.g. `Link.range = 860` or `Drain.range = 850`. **A class field wins over a KV value with the same name.**
3. The KV `AbilitySpecial` value at the current level (`GetLevelSpecialValueFor(name, level-1)`). This returns **0, not nil**, when the key does not exist, and several spells depend on that (see Fireball `knockback_factor` and Drain `coll_radius`).

### 2.5 Cooldown, cast time, mana
- The real cooldown is KV `AbilityCooldown`, which the Dota engine applies. The KV special `cooldown2` is used **only for the tooltip**. They disagree for Homing, Twin, Warpzone, Magnetize, Rockpillar and Link (listed per spell and in §12).
- The cast time is KV `AbilityCastPoint`, a Dota wind-up. The spell's effect fires when the wind-up ends (`OnSpellStart`). For ordinary point and no-target abilities, Dota first turns the hero to face the target (hero `MovementTurnRate` 1.2) and then waits for the cast point. `DOTA_ABILITY_BEHAVIOR_IMMEDIATE` (Teleport, Swap, Thrust, Windwalk, Shield, Rush, Alteration) and `IGNORE_TURN` (Splitter) skip parts of that. A Dota stop order can cancel a cast during its cast point (the Scourge tooltip says so explicitly).
- **No spell costs mana (`AbilityManaCost 0`).** The mana bar is reused as the **DP / knockback-points** meter (§4).
- `AbilityCastRange GLOBAL` everywhere, so Dota never makes the hero walk into range. Range limits are applied in Lua.
- Cooldowns of all spells and of the items in slots 0..5 are reset on every respawn (`Pawn:respawn → resetCooldowns`).
- Cast animation index, from `luaabils/*.lua` → `Config.HERO_SETTINGS[hero].CAST_ANIMS[i]`: 1 = none (`ACT_DOTA_DISABLED`), 2 = generic cast, 3 = "lightning" cast, 4 = "meteor" cast. The generator `warlockgen/warlockgen.py` writes these from its `WarlockSpell(name, desc, cast_anim)` table.

### 2.6 Cast pipeline (`triggers.lua`, `base/spell.lua`)
1. Lua abilities call `CastLuaAbility(abil)` from `OnSpellStart`. The target is `GetCursorPosition()`, of which only XY is used. Items use the datadriven `RunScript → cast(event)` with `Target POINT`.
2. `CastInfo:fromEvent` drops the cast if the caster's actor is disabled (dead).
3. **`GAME:modOnSpellCast(cast_info)` runs first.** Every modifier on the caster gets `onSpellCast`: Pact multiplies damage, Windwalk removes itself, Grip adds DP, and Link may end.
4. Then `spell:onCast(cast_info)`.

Projectiles spawn at the caster's centre unless stated otherwise. Because standard projectile collision matrices do not include `SELF`, a projectile cannot hit its own caster on spawn.

### 2.7 How the generator relates to the files
`warlockgen/warlockgen.py` produces three things:
- The passive stat items in `npc_items_custom.txt`, by appending `template_item_level.txt` to `base_npc_items_custom.txt`, which is not in the repo.
- Both `addon_english.txt` files: each spell gets a name (the capitalised internal name), a description, and labels for its KV specials.
- Every `luaabils/warlock_<spell>.lua` from `template_lua_ability.lua`: `OnSpellStart → CastLuaAbility(self)` plus `GetCastAnimation`.

**Spell numbers are not generated.** They live by hand in `npc_abilities_custom.txt`. `luaabils/item_warlock_fireball1..7.lua` are not used, because the Fireball items are `item_datadriven`, not `item_lua` **[FLAG]**.

---

## 3. Physics and collision model (`base/physics.lua`, `base/actor.lua`)

### 3.1 Tick order (`Game:_Tick`)
1. `tickTaskManager()` runs every due `GAME:addTask` task. That covers modifier expiry, Gravity and Link damage ticks, Meteor hover and fall timers, Warpzone exit checks, and effect cleanup. **These tasks run on real game time and ignore actor `time_scale`.**
2. `tickPhysics(dt)`:
   1. `actor:onPreTick(dt × actor.time_scale)` for every actor. This is where pawns apply friction and walk velocity, modifiers run `onPreTick`, and projectiles steer.
   2. Broad phase: sort collision-component (CC) X extents, sweeping with `velocity × dt × time_scale`.
   3. Narrow phase: sphere–sphere time of impact within `dt`, computed from **raw velocities, ignoring time_scale** **[FLAG: minor inaccuracy inside Warpzones]**. A pair that already overlaps gets TOI = 0, so **overlapping pairs collide again every tick**.
   4. Resolve collisions in TOI order. A pair is skipped if either actor is `isDestroyedNextFrame()` (remaining lifetime ≤ 0, or already destroyed). Otherwise both are moved to the TOI, the participants are notified, the elastic response is applied, and both are moved back.
   5. For each non-static actor: `location += velocity × dt × time_scale`, then the arena-bounds clamp, then the visual sync. After that, `onPostTick(dt × time_scale)` advances **actor timers, which include projectile lifetimes**.
3. Mode `EventTick`.

### 3.2 Collision components
Fields: `channel` (0 DEFAULT, **1 PLAYER, 2 PROJECTILE, 3 OBSTACLE**), `coll_mat[alliance][channel] → bool`, `coll_initiative` (lower value dominates), `radius`, `ellastic`, `ellasticity`, and `accept_damage`, which only Lightning reads.

Alliance is computed from the actors' `owner` objects: `SELF` (same player), `ALLY` (same team) or `ENEMY`. Obstacles, Rockpillar included, have a fake neutral owner, so **they are ENEMY to every player and every player is ENEMY to them**.

**Notification rule.** Take a pair and order it so that `init(A) ≤ init(B)`. Let `fX = X.coll_mat[alliance(X→Y)][Y.channel]`. Let `oX` ("X lets the other side be notified") equal `fX` for ordinary CCs, and be always **false** for Shield, Alteration and WarpZone CCs.
- If `init(A) < init(B)`: A is notified iff `fA`. B is notified iff `fB ∧ oA`.
- If `init(A) == init(B)`: A is notified iff `fA ∧ oB`. B is notified iff `fB ∧ oA`.

So two CCs with equal initiative interact only when **both** matrices accept each other. A lower-initiative CC can detect a higher one on its own, and the higher one is told only if the lower one also agrees.

`coll_info` handed to a notified actor X: `actor` is the other actor, `other_cc` the other CC, `hit_normal` the **unit vector from X's centre to the other actor's centre** (`(1,0,0)` if the centres coincide), plus `hit_location` (the midpoint), `hit_distance`, and `overlapping` (TOI == 0).

Elastic response happens only if both CCs are elastic (pawn–pawn and pawn–obstacle):
- If either CC is PROJECTILE-channel: `mom = m1·(v1·n) − m2·(v2·n)`. If `mom > 0`, each actor gets `0.5·mom·(1 + 0.5·(e1+e2))` of momentum along ∓n.
- Otherwise (player–player or player–obstacle), check the separation one tick earlier. If the pair was already overlapping then (`r = dist² − (r1+r2)² < 0`): two warlocks are pushed apart by `dif/s` each, with `s = max(30, sqrt(−r))`. A warlock overlapping a pillar is placed exactly at `r1+r2` from it along the normal. If they were not overlapping, the momentum formula above is used.

A static actor's velocity is forced back to 0 after every collision.

### 3.3 Every CC in the game

| CC | Owner actor | ch | init | coll_mat (alliance → channels) | radius | Notes |
|---|---|---|---|---|---|---|
| pawn | Pawn | PLAYER | 0 | ENEMY, ALLY → {PLAYER, PROJECTILE, OBSTACLE} | 30 | elastic 0.5. Modifiers toggle entries: Shield turns off ENEMY/PROJECTILE, Thrust turns off ENEMY/PLAYER, Windwalk turns off ENEMY/PLAYER and ALLY/PLAYER. |
| obstacle | Obstacle | OBSTACLE | 0 | ENEMY, ALLY → {PLAYER, PROJECTILE} | 35–90 | elastic. Rockpillar radius 90. |
| projectile (standard) | Projectile | PROJECTILE | 0 | ENEMY → {PLAYER, PROJECTILE, OBSTACLE} | per spell | `base/projectile.lua` |
| shield | caster pawn | PLAYER | −3 | ENEMY → {PROJECTILE} | 200–260 | notifies itself only; `accept_damage=false` |
| alteration | caster pawn | PLAYER | −3 | ENEMY → {PROJECTILE} | 120 | notifies itself only; `accept_damage=false` |
| thrust | caster pawn | PLAYER | −4 | ENEMY → {PLAYER} | 60 | `accept_damage=false` |
| windwalk | caster pawn | PLAYER | 0 | ENEMY → {PLAYER} | 60 | |
| warpzone | WarpZoneActor | PROJECTILE | −5 | ENEMY → {PROJECTILE} | 200–260 | notifies itself only; `accept_damage=false` |
| gravity | GravityProjectile | PROJECTILE | 0 | SELF, ALLY, ENEMY → {OBSTACLE} | 25 | |
| per-projectile overrides | | | | see §7.1 | | |

### 3.4 Pawn movement (`Pawn:onPreTick`)
Each tick:
1. `velocity -= walk_velocity_prev`
2. `velocity *= FRICTION`
3. `walk_velocity = (dota_unit_pos − location)/dt`, Z zeroed and clamped to length 1000
4. `velocity += walk_velocity`
5. Modifier `onPreTick` hooks run.

Knockback velocity therefore decays ×0.96 per tick and walking adds on top of it. Walk speed comes from Dota pathing at `move_speed` (base 210, plus item and modifier bonuses, floored at 0).

---

## 4. Damage, DP (knockback points), knockback, heal, lifesteal (`base/pawn.lua`)

### 4.1 `Pawn:receiveDamage(dmg_info)`, exact pipeline
`dmg_info` fields: `amount`, `source` (an actor), `hit_normal` (optional), `knockback_factor` (default 1), `knockback_vulnerability_factor` (default 1), `text_color`.

1. Return if `!GAME.combat`, if the pawn is disabled (dead), or if `pawn.invulnerable` (first 2 s of a round).
2. `amount = dmg_multiplier × amount`
3. `amount = amount × dmg_factor − dmg_reduction`. No spell modifies these; the defaults are 1 and 0. Return if `amount ≤ 0`.
4. `amount += Σ modifier.modifyDamageTaken(dmg_info)`. No spell overrides this hook. Return if `≤ 0`.
5. **DP gain:** `DP += amount × knockback_vulnerability_factor`. DP is the unit's mana, floored at 0.
6. **If a hit_normal is present** (knockback):
   ```
   g      = amount                 if amount ≤ 100
          = sqrt(100 × amount)     if amount > 100        # softer slope above 100
   kb     = max(0, kb_factor) × g × KB_DMG_TO_VELOCITY(10) × (1 + DP/1000) × knockback_factor
   kb    *= kb_multiplier
   velocity += kb × hit_normal      # applyMomentum(kb·n·mass)/mass
   ```
   DP here already includes this hit's gain from step 5. `kb_factor = 1 − Σ kb_reduction`: Armor .12/.18/.22, Cursed Ring .15, Grip debuff .67, Redirector penalty −0.3.
7. `amount += Σ modifier.modifyDamagePostKB(dmg_info)`. Only Rush uses this. Knockback was already computed from the unreduced amount.
8. If the source has an owner: add `amount` to the damage stat. **Lifesteal:** `source:heal{amount × lifesteal_factor}`. This only has an effect when the source is a Pawn.
9. If a source exists: set `last_hitter` and show a floating number (red, or the given `text_color`).
10. `life = health − amount`. If `life > 1`, health = life. **Otherwise the pawn dies**, so a pawn dies at ≤ 1 HP.

Damage instances **without a hit_normal deal no knockback but still add DP**: Gravity DPS, Link DPS, Snowball contact damage, lava.

### 4.2 Heal (`Pawn:heal{amount, source, dp_factor=0.5}`)
`health = min(max_hp, health + amount)`, then `DP −= dp_factor × amount` (default 0.5), floored at 0. Shows a green number. Ignored while the pawn is disabled.

### 4.3 AoE helper `Pawn:damageArea(center, radius, dmg_info)`
- Hits only pawns that are **enabled and ENEMY to the caster**, with **XY distance `d < radius`** (strict).
- `hit_normal = normalize(pawn − center)`.
- When `amount_min`/`amount_max` are given: `amount = amount_min + (amount_max − amount_min)/radius × (radius − d)`, so it is linear from the minimum at the edge to the maximum at the centre.
- When `kb_factor_min`/`kb_factor_max` are given: `t = 1 − d/radius`, `knockback_factor = (1−t)·min + t·max`. Only Scourge uses this.
- Returns the number of pawns hit.

### 4.4 Reference knockback Δv at 0 prior DP (factor `(1 + dmg/1000)` included, no items)
These come from the formula above. Use them to validate an implementation.

| Source | Lv1 … Lv7 (damage → Δv u/s) |
|---|---|
| Fireball (kb 1.0), item Lv1..7 | 70→749, 77→829, 84→911, 91→993, 98→1076, 105→1132, 112→1177 |
| Cluster, per bolt (kb 0.65) | 33→222, 36→242, 39→263, 42→284, 45→306, 48→327, 51→348 |
| Boomerang (0.95) | 70→712, 76→777, 82→843, 88→910, 94→977, 100→1045, 106→1082 |
| Lightning (0.92) | 70→689, 78→774, 86→859, 94→946, 102→1024, 110→1071, 118→1117 |
| Homing direct (1.0) | 70→749, 80→864, 90→981, 100→1100, 110→1164, 120→1227, 130→1288 |
| Twin, per bolt (1.0) | 44→459, 48→503, 52→547, 56→591, 62→658, 66→704, 72→772 |
| Bouncer, 1st hit (1.2) | 54→683, 62→790, 70→899, 78→1009, 86→1121, 94→1234, 102→1336 |
| Drain (0.2) | 60→127, 70→150, 80→173, 90→196, 100→220, 110→233, 120→245 |
| Recharge, streak 0 (1.0) | 60→636, 67→715, 74→795, 81→876, 88→957, 95→1040, 102→1113 |
| Thrust, full speed (1.2) | 50→630, 55→696, 60→763, 65→831, 70→899, 75→968, 80→1037 |
| Windwalk (1.0) | 54→569, 60→636, 66→704, 72→772, 78→841, 84→911, 90→981 |
| Splitter child (1.0) | 30→309, 35→362, 40→416, 45→470, 50→525, 55→580, 60→636 |
| Meteor, centre (0.66) | 110→768, 120→810, 130→850, 140→890, 150→930, 160→968, 170→1007 |
| Snowball explosion, centre (0.8) | 45→376, 60→509, 75→645, 90→785, 105→906, 120→982, 135→1055 |
| Scourge Lv1..3, centre (1.0) / edge (0.75) | 100→1100/825, 110→1164/873, 120→1227/920 |
| Lightning detonating a Fireball, centre (1.35) | 93.3→1378, 98.7→1463, 104→1520, 109.3→1566, 114.7→1611, 120→1656, 125.3→1701 |
| Homing self-detonation, centre (0.9) | 70→674, 80→778, 90→883, 100→990, 110→1048, 120→1104, 130→1160 |

---

## 5. Projectile base (`base/projectile.lua`)

### 5.1 `Projectile` (extends Actor)
- `owner = instigator.owner`. The location defaults to the instigator's location.
- `range_mastery = not def.no_range_mastery` (default **true**). `duration_mastery = def.duration_mastery` (default false; no spell sets it).
- **Lifetime:** `Projectile:setLifetime(t)` actually stores `t × (dm if duration_mastery) × (rm if range_mastery)`. This scaling applies **every time setLifetime is called**, including Bouncer's TTL resets and Redirector's +0.5 s extension. `setLifetime(0)` stays 0. The lifetime is an **actor timer**, so a Warpzone's time scale stretches it.
- An actor without `def.lifetime` has no death timer: Boomerang, Link, Twin, Meteor, Drain's heal projectile and Recharge's refresh projectile end only through their own logic.
- **Default `receiveDamage`: any damage destroys a projectile** (`setLifetime(0)`). Snowball overrides this and ignores damage.
- Default CC: `'projectile'`, PROJECTILE channel, init 0, coll_mat ENEMY → {PLAYER, PROJECTILE, OBSTACLE}, radius `coll_radius` (default 1). Note that a radius of **0** is truthy in Lua and is kept.
- The visual is `Effect:create(projectile_effect, {duration=-1})`. It follows the projectile each tick, receiving CP1 = location and CP2 = (speed,0,0), and is destroyed with the projectile. If the effect defines `destruction_sound`, that sound plays on **any** destruction, expiry included.
- `onCollision` for the base Projectile only forwards to modifiers; it has no gameplay effect.

### 5.2 `SimpleProjectile` (Fireball, Cluster bolts, Splitter children)
On any notified collision it calls `other:receiveDamage{source=instigator, hit_normal, amount=damage, knockback_factor}` and then `setLifetime(0)`. Consequences:
- Hitting a pawn deals damage and knockback.
- Hitting another projectile destroys it, unless it is a Snowball.
- Hitting an obstacle damages it.

### 5.3 `Spell:spawnProjectile` (used by Fireball and Cluster)
- `dir = normalize((target − caster).xy)`
- `velocity = dir × projectile_speed`
- `lifetime = range / projectile_speed`, then scaled by rm
- `coll_radius = radius`
- `knockback_factor = attribute('knockback_factor')`, **with 0 replaced by 1**. KV never defines `knockback_factor`, so it is 1 unless the class sets it, as Cluster does with 0.65.

---

## 6. Modifier base (`base/modifier.lua`)

### 6.1 Fields and stat effects (applied on toggle on, reverted on toggle off)
| Field | Effect |
|---|---|
| `speed_bonus_abs` | `move_speed += x` (the Dota base move speed is set to `max(0, move_speed)`) |
| `hp_bonus` | `max_hp += x` |
| `hp_regen` | `hp_regen += x` |
| `mass` | `mass += x` |
| `dmg_reduction_rel` | `dmg_factor −= x` |
| `dmg_reduction_abs` | `dmg_reduction += x` |
| `kb_reduction` | `kb_factor −= x` (a negative value increases knockback) |
| `debuff_factor` | `debuff_factor += x` (scales incoming debuff durations, §6.3) |
| `native_mod` | Adds or removes a Dota modifier by name. In this mod these are visual or status only (invisibility, Grip's root visual, and so on). |
| `effect` | A particle attached to the pawn while active. |
| `loop_sound` / `loop_duration` | Emits the sound now and then every `loop_duration` seconds. Stopped when the modifier is removed. |

### 6.2 Lifecycle and hooks
- `def.time` → `temporary = true` plus a `GAME:addTask` that removes the modifier after `time` seconds of **real game time** (not time-scaled). Removing an already-removed modifier does nothing.
- A temporary modifier is removed on the owner's death (`onDeath`) and on round reset (`onReset`).
- Hooks, called on every modifier of the relevant pawn:
  - `modifyDamageTaken` (before knockback) and `modifyDamagePostKB` (after knockback); each returns a damage delta.
  - `onCollision(coll_info, cc)`, called for **every** CC collision of the pawn. Modifiers filter on `cc.id`.
  - `onSpellCast(cast_info)`, which runs before the spell executes.
  - `onPreTick(dt)`, from `Pawn:onPreTick` with time-scaled dt.
  - `onToggle(apply)`.
- **Stacking:** there is no deduplication. Each cast adds a new instance and their stat deltas add up. The only explicit "not if already present" check is Snowball's. Self-buffs with temporary CCs (Shield, Alteration, Thrust, Windwalk) cannot practically overlap because their cooldown is longer than their duration. **[FLAG]** If they did overlap, the second CC would overwrite the first one's table slot and leave an orphaned active CC behind.
- Pawn queries: `pawn:hasModifierOfType(Class)` and `pawn:getModifierOfType(Class)`.

### 6.3 Duration scaling (`base/pawn.lua`)
- **Buff:** `receiver:getBuffDuration(dur, giver) = dur × receiver.dm × (giver.dm if giver ≠ receiver)`
- **Debuff:** `receiver:getDebuffDuration(dur, giver) = dur × receiver.debuff_factor × (giver.dm if giver ≠ receiver)`. `debuff_factor` starts at 1. Cursed Ring adds +0.25 or +0.30. Pocket Watch adds −0.35 or −0.45.

---

## 7. Cross-spell interaction rules

### 7.1 Projectile classes: collision profile and reactions
"Self on enemy-projectile contact" describes what the projectile does to itself when it touches an enemy projectile that also collides with it. "Damages it?" says whether it calls `receiveDamage` on that other projectile. Any projectile without a `receiveDamage` override is destroyed when it receives damage.

| Class (spell) | init | coll_mat | radius | Hit pawn | Hit obstacle | Self on enemy-projectile contact | Damages other projectile? | Destroyed by damage? |
|---|---|---|---|---|---|---|---|---|
| FireballProjectile (Fireball) | 0 | std | 25 | damage | damages it, dies | dies | yes | yes |
| SimpleProjectile (Cluster) | 0 | std | 22 | damage | damages it, dies | dies | yes | yes |
| SplitterChildProjectile | 0 | std | 21 | damage | damages it, dies | dies | yes | yes |
| TwinProjectile | 0 | std | 35 | damage | damages it, dies | dies | yes | yes |
| BoomerangProjectile | **−2** | ENEMY{PLAYER, OBSTACLE} | 38 | damage + bounce | bounce | no contact | - | yes, but nothing ever damages it |
| BouncerProjectile | **−1** | SELF/ALLY{PLAYER}, ENEMY{PLAYER, PROJ, OBST} | 38 | damage (enemies) + retarget | reflect | **dies** | no | yes |
| DrainProjectile | 0 | std + ALLY{PLAYER} | **0** (bug) | damage/heal | reflect | **nothing** | no | yes |
| GravityProjectile | 0 | SELF/ALLY/ENEMY{OBSTACLE} only | 25 | none (field effect) | reflect | no contact | - | n/a |
| GripProjectile | 0 | std | 39 | root debuff | dies | dies | no | yes |
| HomingProjectile | **−1** | std + SELF{PLAYER} | 30 | damage (enemy) / self-detonate | damages it, dies | dies | no | yes |
| LinkProjectile | **−1** | ALLY{PLAYER}, ENEMY{PLAYER, OBSTACLE} | 35 | latch | latch | no contact | - | - |
| MagnetizeProjectile | **−1** | std + ALLY{PLAYER} + SELF{PLAYER} | 36 | magnetize | reflect (arms self-hit) | dies | no | yes |
| MeteorProjectile | no CC | - | - | - | - | - | - | - |
| RechargeProjectile | 0 | std | 35 | damage + refresh | reflect | dies | no | yes |
| SnowballProjectile | 0 | std | 75–87 | drag + slow/DoT | damages it (`damage_max`), explodes | **nothing** | no | **no (ignores damage)** |
| SplitterProjectile (main) | 0 | std | 50 | splits (no damage) | reverses, splits | splits | no | yes (splits) |
| SplitterSpawnerProjectile | −1 | **empty** | (1) | - | - | - | - | - |
| SwapProjectile | 0 | ALLY{PLAYER}, ENEMY{PLAYER, OBSTACLE in combat only} | 40 | swap | swap with obstacle | no contact | - | - |
| DrainHealProjectile / RechargeRefreshProjectile | no CC | - | - | - | - | - | - | - |

("std" = ENEMY → {PLAYER, PROJECTILE, OBSTACLE}.)

**Projectile-vs-projectile outcomes** follow from the rule in §3.2. Two enemy "std" projectiles collide mutually, and each runs its own reaction. Examples:
- Fireball vs Fireball: both die.
- Fireball vs Grip: both die.
- Grip vs Drain: Grip dies, **Drain survives**.
- Drain vs Drain: both pass through each other.
- Anything vs Snowball: the other one dies (if it is a dying type); the Snowball survives.
- Boomerang, Link, Swap, Gravity and the Splitter spawner never touch other projectiles.

### 7.2 Which effects apply to which actors

| Effect | Applies to | Exclusions / notes |
|---|---|---|
| **Shield** (reflects + steals ownership) | Every ENEMY PROJECTILE-channel CC entering the shield radius | Not reflected and not stolen: Swap, Gravity, WarpZone. Reflected but **not** stolen: Boomerang (also forced into return mode), Link. Unaffected because they have no CC: Meteor, DrainHeal, RechargeRefresh. |
| **Alteration** (position swap) | Every ENEMY PROJECTILE-channel CC entering 120 u that is moving toward the caster | Excludes Gravity and WarpZone. |
| **Warpzone** (time-scale) | Every ENEMY PROJECTILE-channel CC overlapping the zone | Excludes WarpZoneActor and Meteor. Pawns are never scaled. CC-less projectiles are never scaled. |
| **Gravity pull, projectiles** | Every `Projectile` instance within 600, **any owner, own projectiles included** | Excludes Meteor, Gravity, Link. |
| **Gravity pull, pawns** | ENEMY pawns within 550 | |
| **Magnetize steering** | Every `Projectile` instance within 300 that is ENEMY to the magnetized pawn | Excludes Meteor. |
| **Redirector** | The caster's own `Projectile` closest to the target point | Excludes Meteor. |
| **Lightning** | Any CC with `coll_mat[ENEMY][PROJECTILE]` true and channel PLAYER, PROJECTILE or OBSTACLE: enemy pawn bodies (unless shielded), std projectiles, Bouncer, Drain, Homing, Magnetize, Grip, Recharge, Snowball, Splitter main, Twin, obstacles, **enemy Shield and Alteration CCs (they block the bolt and take no damage)**. Plus the caster's own or an ally's **FireballProjectile**, which detonates. | Ignores Boomerang, Gravity, Link, Swap, Splitter spawner, Warpzone (explicit), Meteor, Windwalk and Thrust CCs. |

### 7.3 Emergent "hitbox" rules worth reproducing
- Thrust's CC (radius 60) reacts to **any enemy PLAYER-channel CC**. That includes the enemy's own Windwalk (60), Thrust (60), Alteration (120) and Shield (200+) CCs, so a thrust "connects" at 90 u against a body, 120 against a windwalker or thruster, 180 against someone with Alteration up, and bounces off at the Shield radius.
- Lower-initiative projectiles (Bouncer −1, Boomerang −2, Homing −1, Magnetize −1, Link −1) whose matrix includes ENEMY PLAYER also register a hit on an enemy's Windwalk CC (60), which effectively enlarges a windwalker's hitbox against them. Standard projectiles at init 0 do not, because the Windwalk CC does not accept projectiles.
- A shielded pawn's body CC refuses ENEMY PROJECTILE. Std projectiles at equal initiative therefore pass through it. Lower-initiative projectiles (Bouncer, Homing, Magnetize, Boomerang, Link) can still hit the body if they ever get inside the shield radius without being reflected, for example when they are moving away.

---

## 8. Spell catalog

Per-spell format: identity → cast → numbers per level → mechanics → collisions/interactions → modifiers → FX/sounds → flags.
"CP" = cast point, "CD" = cooldown (KV `AbilityCooldown`, i.e. the real one), "tooltip CD" = `cooldown2`.

---

### 8.1 Fireball (item, default spell)
- **Internal:** `item_warlock_fireball1` … `item_warlock_fireball7` (`spells/fireball.lua`, class `Fireball`, `alt_ids` for 2..7). Projectile class `FireballProjectile` = `SimpleProjectile` with no overrides.
- **Display:** "Fireball" — "Cast a fireball dealing N damage". Shop: "Upgrades Fireball to deal 7 more damage". Icon `item_warlock_fireball` (shop icon `ogre_magi_ignite`).
- **Slot:** inventory item, slot 1. **Given at spawn** (Lv1). Upgrade cost 7 per level (shop `buy_cost 7`), max level 7.
- **Cast:** point target, `item_datadriven`, CP **0.2**, anim `ACT_DOTA_ATTACK`, CD **4.8** at every level, mana 0.
- **Per level (one item per level):**

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| damage | 70 | 77 | 84 | 91 | 98 | 105 | 112 |
| range (KV) | 1000 | 1000 | 1000 | 1000 | 1000 | 1000 | 1000 |

- **Projectile:** speed **1000** (class), collision radius **25** (class), lifetime `1000/1000 = 1.0 s × rm` (so range 1000×rm), straight line from the caster's centre toward the cursor. `knockback_factor` = 1 (KV lookup returns 0, which is replaced by 1).
- **On collision:** std `SimpleProjectile`. Pawn: `receiveDamage{damage, hit_normal, kb 1.0}`. Enemy projectile: damages it (destroys it, except Snowball). Obstacle: deals `damage` to the obstacle. Always destroys itself.
- **Collides with:** enemy pawns, enemy projectiles (mutual std), obstacles. Not allies, not self.
- **Special interaction:** **Lightning cast by the owner or an ally detonates this Fireball** (only class `FireballProjectile`, not Cluster bolts): AoE at the Fireball, radius 225, damage `0 → 2/3·(lightning_damage + 70)` from edge to centre, kb 1.35. See Lightning.
- **FX:** effect `fireball_projectile` = `ProjectileParticleEffect` `particles/units/heroes/hero_phoenix/phoenix_base_attack.vpcf`, destruction sound **`Fireball.Explode`**, which plays on any destruction including expiry.
- **Level scaling:** +7 damage/level. Nothing else changes.
- **[FLAG]** `luaabils/item_warlock_fireball1..7.lua` exist but are not used, because the KV items are datadriven.

---

### 8.2 Scourge / Scourge Incarnation (item, default spell)
- **Internal:** `item_warlock_scourge1` (class `Scourge`), `item_warlock_scourge2` (`Scourge_incarnation1`), `item_warlock_scourge3` (`Scourge_incarnation2`). `spells/scourge.lua`.
- **Display:** Lv1 "Scourge" — "Deal 100 damage to nearby enemy warlocks at the cost of 100 HP of your own". Lv2/3 "Scourge Incarnation" — "Deal 110/120 damage … at the cost of 100 HP of your own. Each opponent struck recovers 20/30 DP". Note: "Cancel spell casting by pressing the stop hotkey". Shop: "Upgrades scourge to deal 10/20 more damage and recover 20/30 DP for each opponent struck". Icons `item_warlock_scourge`, `item_warlock_scourge_incarnation1/2` (shop `abaddon_borrowed_time_alliance`).
- **Slot:** inventory item, slot 2. **Given at spawn** (Lv1). Upgrade cost 7, max 3.
- **Cast:** no target (self-centred AoE), CP **0.9** (a long wind-up that can be cancelled with stop), CD **3.0**, anim disabled, mana 0.

| Lv | 1 | 2 | 3 |
|---|---|---|---|
| damage | 100 | 110 | 120 |
| radius | 250 | 250 | 250 |
| dp_reduce (per enemy hit) | 0 | 20 | 30 |
| self HP cost | `damage` (100) | 100 (fixed) | 100 (fixed) |

- **Mechanics:**
  1. `caster:damageArea(caster.location, radius, {amount = damage (flat), kb_factor_min 0.75, kb_factor_max 1.00})`. The knockback factor is linear from 0.75 at the edge to 1.0 at the centre. Only enemies within d < 250 are hit, pushed radially outward.
  2. Self cost: `setHealth(max(1, health − cost))`. This cannot kill, adds no DP, does no knockback, ignores reductions, and is **not gated by `GAME.combat`** (it costs HP during shop time too).
  3. Lv2/3 only: `DP_caster = max(0, DP − dp_reduce × enemies_hit)`.
- **FX (KV datadriven):** `FireSound Scourge.Cast` on the caster. `AttachEffect particles/econ/generic/generic_aoe_explosion_sphere_1/generic_aoe_explosion_sphere_1.vpcf` following the caster, radius = `%radius`, colours Lv1 (255,255,255), Lv2 (255,100,100), Lv3 (255,0,0).
- **[FLAG]** With Pact active, the Lv1 self-cost becomes 150, because it uses `damage`. Lv2/3 stay at a fixed 100.

---

### 8.3 Redirector (item)
- **Internal:** `item_warlock_redirector1` (`spells/redirect.lua`, class `Redirect`). Display "Redirector" — "Changes the direction of a projectile owned by you closest to your target towards it and increases its lifetime by 0.5 seconds but increases your knockback vulnerability by 30 percent for 8 seconds". Icon `item_warlock_redirector` (shop `disruptor_kinetic_field`).
- **Slot:** inventory item, buy 8, max 1.
- **Cast:** point, CP **0.2**, CD **24.0**, anim `ACT_DOTA_ATTACK`. KV: `kb_penalty −0.3`, `kb_penalty_duration 8`.
- **Mechanics:**
  1. Over every actor that is a `Projectile`, has `instigator.owner` == caster (SELF) and is not a Meteor, pick the one whose XY position is closest to the cursor.
  2. If one is found: `velocity = |velocity| × normalize(cursor − projectile)` (speed kept, re-aimed). Spawn effect `redirect_cast` (`particles/econ/items/ursa/ursa_swift_claw/ursa_swift_fury_sweep_dim_b_blue.vpcf`) at the projectile with yaw = the new direction. Play sound `Redirector.Cast` from the projectile's effect. If the projectile has a death timer, `setLifetime(remaining + 0.5)`, which Projectile scaling turns into **(remaining + 0.5) × rm** **[FLAG: range mastery is applied a second time]**.
  3. **Always** (even with no projectile found): add `Modifier{kb_reduction = −0.3, time = 8 × caster.debuff_factor, effect 'redirect'}` (`particles/econ/courier/courier_faceless_rex/cour_rex_flying.vpcf`). That is +30% knockback taken.
- **Notes:**
  - Projectiles without a timer (Boomerang, Link, Twin, DrainHeal, RechargeRefresh) get no extension.
  - Twin re-applies its ellipse velocity delta every tick, so a redirect adds a persistent drift rather than a clean re-aim.
  - Homing-type projectiles (Drain heal, Recharge refresh, retracting Link, Homing, Boomerang in return mode) steer back afterwards.
  - Projectiles stolen with Shield become yours and can be redirected.

---

### 8.4 Pact (item)
- **Internal:** `item_warlock_pact1` (`spells/pact.lua`, `modifiers/pactmodifier.lua`). Display "Pact" — "Grants you a buff that enhances the damage of your next spell by 50% for 5 seconds but slows you by 66 for 6 seconds if you make use of it". Icon `item_warlock_pact` (shop `abaddon_death_coil` mistral_fiend).
- **Slot:** inventory item, buy 10, max 1.
- **Cast:** no target, CP **0.2**, CD **30.0**, anim disabled. KV: `duration 5`, `damage_multiplier 1.5`, `speed_reduction 66`, `slow_duration 6`. KV `FireSound Pact.Cast`.
- **Mechanics:** adds `PactModifier` for `getBuffDuration(5, self)` = 5 × dm, with attached effect `pact_effect` (`particles/generic_gameplay/rune_doubledamage.vpcf`). On the caster's **next** cast (`onSpellCast` runs before the spell):
  1. For each of `damage`, `damage_min`, `damage_max`: if `attribute(name)` is not 0, set the per-cast override to `value × 1.5`.
  2. If at least one was changed:
     - play `Pact.Enhance` and effect `pact_enhance` (`particles/econ/items/abaddon/abaddon_alliance/abaddon_aphotic_shield_alliance_explosion.vpcf`) at the caster
     - apply slow `Modifier{speed_bonus_abs = −66, time = 6 × caster.debuff_factor, effect 'pact_slow_effect'}` (`particles/econ/courier/courier_oculopus/courier_oculopus_ambient.vpcf`)
     - remove Pact.
- **Consumed by** any spell with a non-zero damage attribute: Fireball, Scourge, Boomerang, Lightning (including the Fireball detonation), Homing, Twin, Thrust, Cluster, Drain (damage and heal), Bouncer, Recharge (the base part only: `1.5·damage + 10·streak`), Windwalk, Meteor (min 40→60 and max), Splitter (children), Snowball (`damage` and `damage_max`; `damage_min` 0 stays 0), Gravity (DPS), Link (DPS).
- **Not consumed by:** Teleport, Swap, Shield, Rush, Alteration, Grip, Warpzone, Magnetize, Rockpillar, Redirector, Pact (their `damage` lookups return 0).

---

### 8.5 Boomerang — column 1 (D)
- **Internal:** `warlock_boomerang` (`spells/boomerang.lua`, `projectiles/boomerangprojectile.lua`). Display "Boomerang" — "Cast a magically enhanced shuriken which will return to its caster". Icon `bounty_hunter_shuriken_toss`.
- **Shop:** buy 11, upgrades 7 8 9 10 11 12.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 16.0 | 13.9 | 12.5 | 11.7 | 11.0 | 10.3 | 9.6 |
| damage | 70 | 76 | 82 | 88 | 94 | 100 | 106 |
| range | 800 | 800 | 800 | 800 | 800 | 800 | 800 |

- **Projectile:** collision radius **38**. **No lifetime.** It exists until it returns to the caster.
- **Trajectory.** Let `dir` = cast direction, `perp = (−dir.y, dir.x)` (90° counter-clockwise), and `D = min(max(dist_to_cursor, 300), 800 × rm)`.
  - `v0 = 1500·dir + 300·perp`
  - `par_acc = −1500² / (2·D)`, `perp_acc = 2·par_acc·300/1500 = 0.4·par_acc` (negative, so it curves toward −perp)
  - Phase A, `0 ≤ t < T1` with `T1 = −1500/par_acc = 2D/1500`: `acc = par_acc·dir + perp_acc·perp`. The forward speed reaches 0 at distance D.
  - Phase B, the next `T1 − 0.15` s: `acc = par_acc·dir − perp_acc·perp`.
  - Phase C ("iter", return mode): `acc = 0`. Each tick, if the 3D distance to the caster is < 75 the boomerang is destroyed. Otherwise `desired = 1000·unit(caster − pos)` and `v += 1000·dt·unit(desired − v)`, i.e. it steers at 1000 u/s² toward a 1000 u/s homing velocity.
  - Velocity integration each pre-tick: `v += acc·dt` (dt is time-scaled).
  - Examples: D=300 → par_acc −3750, T1 0.40 s. D=800 → par_acc −1406.25, perp_acc −562.5, T1 1.0667 s, phase B 0.9167 s.
- **On collision** (init −2, ENEMY{PLAYER, OBSTACLE}):
  - Enemy pawn: `receiveDamage{damage, hit_normal, kb 0.95}`, effect `boomerang_hit` (`particles/units/heroes/hero_sniper/sniper_assassinate_impact_blood.vpcf`, CP0 = CP1 = target location), sound `Boomerang.Hit`.
  - Pawn or obstacle: if moving toward the normal, reflect the velocity and set speed to **500** (to **750** off obstacles). Push out so that centre distance = r1 + r2 + 10. Then **enter return mode immediately**. Obstacles take no damage.
  - There is no hit memory, so the boomerang can hit the same enemy again on the way back.
- **Never collides with projectiles.** It is ignored by Lightning and cannot be destroyed by projectiles.
- **Interactions:** Shield reflects it **without stealing ownership** and forces return mode, so it flies back to its original thrower. Gravity, Magnetize, Warpzone and Alteration all affect it. Redirector re-aims it without extending anything (no timer).
- **FX:** `boomerang_projectile` = `particles/units/heroes/hero_silencer/silencer_glaives_of_wisdom.vpcf` (no destruction sound).

---

### 8.6 Lightning — column 1 (D)
- **Internal:** `warlock_lightning` (`spells/lightning.lua`). Display "Lightning" — "Cast a lightning that instantly strikes the first obstacle on its path". Icon `lina_laguna_blade`.
- **Shop:** buy 11, upgrades 8 9 10 11 12 13.
- **Cast:** point, CP **0.2**, anim 3 ("lightning").

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 16.5 | 15.5 | 15 | 14.5 | 14 | 13.5 | 13 |
| damage | 70 | 78 | 86 | 94 | 102 | 110 | 118 |
| range | 600 | 600 | 600 | 600 | 600 | 600 | 600 |

- **Mechanics (instant hitscan):** `dir` = cast direction, `max = 600 × rm`, beam half-width `radius = 25`.
  1. Scan every active CC. A CC is a candidate if:
     `(Lightning.coll_mat[alliance][cc.channel] ∧ cc.coll_mat[alliance][PROJECTILE] ∧ actor is not WarpZoneActor) ∨ (alliance ≠ ENEMY ∧ actor is FireballProjectile)`.
     Here `Lightning.coll_mat` = ENEMY → {PLAYER, PROJECTILE, OBSTACLE} and alliance is the caster-relative alliance.
  2. A candidate is hit-testable if `|perp distance of its centre| ≤ 25 + cc.radius` and its **centre's** forward distance `s` satisfies `0 < s < best`. The smallest `s` wins. Note that only the centre has to be inside the range.
  3. Resolve the winner:
     - A **friendly Fireball** explodes: `damageArea(fb.location, 225, {amount_min 0, amount_max 2/3·(damage+70), knockback_factor 1.35})`, sound `Lightning.FBExplosion` from the Fireball, effect `lightning_fb_explosion` (`particles/units/heroes/hero_phoenix/phoenix_supernova_reborn_star_sphere.vpcf`). The Fireball is destroyed, which also plays `Fireball.Explode`.
     - Otherwise, if `cc.accept_damage`: `receiveDamage{damage, hit_normal = dir (the beam direction, not centre-to-centre), kb 0.92, source = caster}`.
     - Otherwise (an enemy Shield or Alteration CC) the beam **stops there with no effect**.
  4. Beam visual `lightning` = `LightningEffect` `particles/units/heroes/hero_lina/lina_spell_laguna_blade.vpcf` from the caster to `start + dir·best` (full range if nothing was hit), lasting 2 s, sound `Lightning.Cast`.
- **What it hits:** see §7.2. In short: enemy pawns (not shielded ones), std/Bouncer/Drain/Grip/Homing/Magnetize/Recharge/Snowball/Splitter/Twin projectiles (destroying them; Snowball ignores the damage), obstacles (damaging them), and enemy Shield/Alteration bubbles (blocked). It passes Boomerang, Gravity, Link, Swap, Splitter spawner, Warpzone and Meteor.
- **Pact** multiplies both the direct damage and the Fireball-detonation formula.

---

### 8.7 Homing — column 1 (D)
- **Internal:** `warlock_homing` (`spells/homing.lua`, `projectiles/homingprojectile.lua`). Display "Homing" — "Cast a bolt of energy which will homes in on its target". Icon `puck_illusory_orb`.
- **Shop:** buy 11, upgrades 8 9 10 11 12 13.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (KV, real) | 16.5 | 14.5 | 13 | 12 | 11 | 10 | 9 |
| tooltip CD | 15 | 13.5 | 12.5 | 12 | 11.5 | 11 | 10.5 |
| damage | 70 | 80 | 90 | 100 | 110 | 120 | 130 |
| range | 4500 | … | | | | | 4500 |

**[FLAG]** The real and tooltip cooldowns differ.

- **Projectile:**
  - Spawns at `caster + 64·dir`, outside the caster's body (pawn 30 + bolt 30 < 64).
  - Initial velocity `dir × (800 + caster_velocity·dir)`, so it inherits the caster's forward speed.
  - Collision radius **30**, steady speed 1000, lifetime `4500/1000 = 4.5 s × rm`.
- **Targeting:**
  - At cast: the target is the ENEMY pawn closest to the **cursor point**, or nil.
  - Every pre-tick: re-acquire (the ENEMY pawn closest to the projectile's position) if the target is nil, is no longer ENEMY to the (possibly new) owner, or is disabled (dead).
  - Steering, **per tick (not dt-scaled)**: `v = 0.97·v + 0.03·(1000·unit(target − pos))`. With no target it flies straight.
- **On collision** (init −1, std + SELF{PLAYER}):
  - **Enemy pawn:** `receiveDamage{damage, hit_normal, kb 1.0}`. Destroyed.
  - **Own caster** (SELF; allies are not in the matrix): self-detonation.
    - effect `homing_explode` (`particles/units/heroes/hero_wisp/wisp_guardian_explosion.vpcf`)
    - `damageArea(proj.location, 292 (= 200 × 1.46), {0 → damage, kb 0.9})` against the caster's enemies
    - the caster gets `Modifier{+50 move speed, time = 4 × dm, native 'modifier_chen_test_of_faith_teleport'}`
    - **"Burnout" combo:** if the caster currently has a Thrust modifier, the speed bonus is +120 instead and effect `homing_burnout` (`particles/units/heroes/hero_doom_bringer/doom_bringer_lvl_death.vpcf`) plays. The intended radius ×1.05 is computed but never used **[FLAG]**.
    - destroyed.
  - **Obstacle:** intended: `obstacle:receiveDamage(damage)`, then destroyed.
  - **Enemy projectile:** destroyed without damaging the other one. The other side's own reaction still applies (a Fireball destroys it anyway).
- **Shield:** reflected **and stolen**. It then re-acquires the nearest enemy of the new owner, typically the original caster.
- **FX:** `homing_projectile` (`particles/homing/homing_projectile.vpcf`, custom), destruction sound **`Homing.Destroy`**, destruction effect `homing_destroy` (`particles/units/heroes/hero_wisp/wisp_base_attack_explosion.vpcf`).
- **[FLAG, critical]** `homingprojectile.lua` **does not parse as committed**. In `onCollision`, `else if actor:instanceOf(Obstacle) then … end` leaves the function one `end` short (a block-balance count gives 15 openers and 14 `end`s). The module loader wraps `require` in `pcall`, so `HomingProjectile` stays nil and **casting Homing throws**: the spell is dead in this snapshot. There is also a typo `instanceOf`, where `instanceof` was meant, which would throw on obstacle hits even with the syntax fixed. The behaviour above is the clearly intended one (`if … elseif obstacle`). Rebuild it as described.

---

### 8.8 Twin — column 1 (D)
- **Internal:** `warlock_twin` (`spells/twin.lua`, `projectiles/twinprojectile.lua`). Display "Twin" — "Shoots two projectiles flying in an elliptic curve towards the target location and damaging enemies on impact". Icon `dark_willow_bedlam`.
- **Shop:** buy 12, upgrades 7 8 9 10 11 12.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (KV, real) | 16.0 | 13.9 | 12.5 | 11.7 | 11.0 | 10.3 | 9.6 |
| tooltip CD | 14.0 | 13.4 | 12.8 | 12.2 | 11.6 | 11.0 | 10.4 |
| damage (per bolt) | 44 | 48 | 52 | 56 | 62 | 66 | 72 |
| range | 800 | … | | | | | 800 |

**[FLAG]** The real and tooltip cooldowns differ.

- **Geometry** (`ellipse_area = 450² = 202500`, `R = 800 × rm`):
  - `dist` = cursor distance, clamped to `[min_dist, R]` with `min_dist = max(10, 2·area/(π·R))` (= 161.1 at rm = 1).
  - `target = caster + dist·dir`.
  - Two `TwinProjectile`s with `ellipse_sign = +1` and `−1`.
  - Semi-axes: `a = dist/2` along the cast line, `b = area/(π·a)` sideways, so `a·b` is constant: short casts bulge wide and long casts are flat.
  - In ellipse coordinates `E(t) = (a·cos t, sign·b·sin t)` for `t ∈ [0, π]`, rotated by `ellipse_dir = unit(start − target)`. t=0 is the start and t=π is the target. Maximum sideways offset is b, reached at t = π/2.
- **Motion (constant path speed 1000):** each pre-tick:
  1. `dt_e = dt·1000/|E'(t)|`, clamped to ≥ 0.001.
  2. `t = min(π, t + dt_e)`.
  3. Velocity delta = (new E − old E)/dt, rotated. It is applied **additively** (`v = v − old_applied + new_applied`), so external pushes (Gravity, Magnetize, Redirector) persist as drift.
  4. Destroyed when `t ≥ π`, which means it reaches the target point.
  - No lifetime timer.
  - Examples: dist 800 → a=400, b≈161.1, flight ≈0.92 s. dist 400 → b≈322.3, ≈0.83 s. dist 161.1 → b≈800, ≈1.63 s.
- **On collision** (init 0, std): calls `other:receiveDamage{damage, hit_normal, kb 1.0}` on **whatever it hits**: pawns, enemy projectiles (destroyed unless Snowball) and obstacles (damaged). If it hit a pawn: effect `twin_hit` (`particles/units/heroes/hero_dark_willow/dark_willow_wisp_aoe_cast_glow.vpcf`, scale 1.2, CP0–2 at the target) and sound `Twin.Hit`. Then it destroys itself.
- Both bolts can hit the same target, for 2 × damage and two knockbacks.
- **Reflection** (Shield) also mirrors `ellipse_dir`, so the arc continues mirrored.
- **FX:** `twin_projectile` (`particles/units/heroes/hero_dark_willow/dark_willow_base_attack.vpcf`, scale 1.2), cast sound `Twin.Cast`.

---

### 8.9 Teleport — column 2 (R)
- **Internal:** `warlock_teleport` (`spells/teleport.lua`). Display "Teleport" — "Instantly alter your location". Icon `rubick_telekinesis`.
- **Shop:** buy 12, upgrades 6 7 8 9 10 11.
- **Cast:** point, **IMMEDIATE**, CP **0.0**, anim 1 (none).

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 16.0 | 13.5 | 11.5 | 10.0 | 9.0 | 8.0 | 7.0 |
| range | 770 | 840 | 910 | 980 | 1050 | 1120 | 1190 |

- **Mechanics:**
  1. The destination is the cursor, clamped to `range`. **Range mastery does not apply.**
  2. `location = destination`.
  3. **`velocity ×= 0.8`**, so existing knockback is kept at 80%.
  4. `_updateLocation()` syncs the unit so the next tick's walk velocity is correct.
  5. `unit:Stop()`.
  - There are no collision, obstacle or lava checks: you can land inside pillars (the physics push-out then applies) or on lava.
- **FX:** `teleport_source` (`particles/units/heroes/hero_vengeful/vengeful_nether_swap.vpcf`) at the origin, `teleport_target` (`…/vengeful_nether_swap_blue.vpcf`) at the destination, sound `Teleport.Cast`.
- **Interactions:** a Link the caster owns on a pawn **breaks if the cursor is on lava** (§8.28). Casting ends Windwalk.

---

### 8.10 Thrust — column 2 (R)
- **Internal:** `warlock_thrust` (`spells/thrust.lua`, `modifiers/thrustmodifier.lua`). Display "Thrust" — "Charge toward target point and deal damage to enemies on impact". Icon `disruptor_glimpse`.
- **Shop:** buy 11, upgrades 6 7 8 9 10 11.
- **Cast:** point, **IMMEDIATE**, CP **0.0**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 16.5 | 14.5 | 13 | 12 | 11 | 10 | 9 |
| damage | 50 | 55 | 60 | 65 | 70 | 75 | 80 |

- **Class constants:**
  - `velocity 1300`
  - `acceleration = 1300·(1 − FRICTION)/0.03 = 1733.33 u/s²`. This is computed at load with FRICTION 0.96 and does not follow the game option.
  - `radius 60`
  - `range 900` (no KV value, no mastery)
  - `extra_time 0.09`
  - `native_mod 'modifier_dark_seer_ion_shell'` (visual)
- **On cast:**
  1. `unit:Stop()`, face `dir`.
  2. **`velocity = 0.77 × 1300 × dir = 1001·dir`**. This *replaces* the current velocity, cancelling knockback.
  3. Add `ThrustModifier` with `time = 0.09 + min(dist, 900)/1300` (**not** duration-mastery scaled).
- **While active:**
  - Each pre-tick: `velocity += dir × 1733.33 × dt`, which roughly cancels friction near 1300 u/s.
  - The pawn CC's ENEMY/PLAYER entry is disabled, so you pass through enemy bodies.
  - Temporary CC `thrust`: radius 60, PLAYER channel, init −4, ENEMY{PLAYER}, `accept_damage false`.
  - `knockback` field = 1.2.
- **On the thrust CC touching an enemy PLAYER-channel CC** (their body at 90 u, or their Windwalk/Thrust/Alteration/Shield CC; see §7.3):
  - **Target is shielded:** reflect your own velocity if moving toward them. No damage. The thrust continues.
  - **Otherwise:**
    1. Sound `Thrust.Hit` on the target.
    2. Remember your velocity, then **set your velocity to 0**.
    3. If the target is also thrusting: their thrust hits you at full factor (their knockback field), and your own hit becomes non-velocity-dependent (factor 1).
    4. If you have Windwalk: return here. The Windwalk handler performs the thrust hit (see Windwalk).
    5. Otherwise `hitPawn(target, normal, factor)`, where `factor = min(1, (|v|²/1300²)/0.8)` (full damage at ≥ 89.4% of 1300 u/s): `receiveDamage{damage × factor, kb 1.2}`, effect `thrust_hit` (`particles/units/heroes/hero_stormspirit/stormspirit_overload_discharge.vpcf`) at your position, then the modifier is removed.
- **On expiry without a hit:** `velocity ×= 0.2` (a hard brake), sound `Thrust.End`. The pawn CC's ENEMY/PLAYER entry is restored on removal.
- **FX:** cast sound `Thrust.Cast`.
- **Synergies:**
  - Thrust then Windwalk: the WW hit triggers the thrust hit at factor 1 with knockback 0.84 (= 0.7 × 1.2), **plus** the WW damage at kb 0.7.
  - Homing self-detonation while thrusting gives "burnout" (+120 ms).

---

### 8.11 Swap — column 2 (R)
- **Internal:** `warlock_swap` (`spells/swap.lua`, `projectiles/swapprojectile.lua`). Display "Swap" — "Cast missile that swaps location with its target". Icon `vengefulspirit_nether_swap`.
- **Shop:** buy 11, upgrades 6 7 8 9 10 11. **Levels only change the cooldown.**
- **Cast:** point, **IMMEDIATE**, CP **0.0**, anim 1.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 15.8 | 13.3 | 11.3 | 9.8 | 8.8 | 7.8 | 7.0 |

- **Projectile:**
  - speed **1983**, radius **40**
  - `lifetime = min(dist_to_cursor/1983, 0.4706 × rm)`, created with `no_range_mastery` because rm is already applied, giving a max range of ≈ **933 × rm**
  - effect `swap_projectile` (`particles/units/heroes/hero_chaos_knight/chaos_knight_chaos_bolt.vpcf`)
- **Collision** (init 0): ALLY{PLAYER}, ENEMY{PLAYER} and, **only if `GAME.combat` was true at cast time**, ENEMY{OBSTACLE}. It does not interact with projectiles. Because initiative is equal, the target must accept it as well: shielded enemies refuse it, and obstacles accept it.
- **On hit** (an ally, an enemy, or a pillar or obstacle):
  - Exchange the caster's and the target's positions (both synced to their units). Velocities are untouched.
  - Effect `swap_effect` (`particles/units/heroes/hero_nevermore/nevermore_shadowraze.vpcf`) at both spots.
  - Caster `Stop()`, projectile destroyed.
- **On destroy:** sound `Swap.Swap` on the caster. **If nothing was swapped, the caster is teleported to the projectile's final position** (`location + time_left·velocity`, effectively where it stopped), with `swap_effect` at the old and new spots, and `Stop()`. This also happens if a round reset removes the projectile.
  - **So Swap is a ~933 u blink to the cursor that swaps with the first warlock or obstacle met on the way.**
- **Interactions:**
  - Shield catches it but neither reflects nor steals it. The shielded body then refuses it, so **shielded warlocks cannot be swapped** and the projectile flies past them.
  - Warpzone slows it (real-time lifetime stretches; distance is preserved). Gravity and Magnetize bend it. Redirector re-aims it and adds (remaining + 0.5) × rm s. Alteration can trade places with it.
  - Lightning ignores it.
  - A Link the caster owns breaks if the swap is cast toward lava (checked against the cursor point).

---

### 8.12 Cluster — column 3 (T)
- **Internal:** `warlock_cluster` (`spells/cluster.lua`). Display "Cluster" — "Cast four lesser fireballs simultaneously". Icon `ember_spirit_searing_chains`.
- **Shop:** buy 14, upgrades 6 7 8 9 10 11.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 15.50 | 14.75 | 14.00 | 13.25 | 12.50 | 11.75 | 11.00 |
| damage (per bolt) | 33 | 36 | 39 | 42 | 45 | 48 | 51 |
| range | 672 | … | | | | | 672 |

- **Mechanics:** four `SimpleProjectile`s via `spawnProjectile`.
  - Their headings are `θ − 0.18, θ − 0.06, θ + 0.06, θ + 0.18` rad, where θ is the cast angle (spacing 0.12 rad ≈ 6.9°, total spread 0.36 rad ≈ 20.6°). Each aims at a point at the same cursor distance, but only the direction matters.
  - speed **844**, radius **22**, lifetime `672/844 = 0.796 s × rm`, **knockback_factor 0.65** (class).
- **On collision:** same as Fireball (§5.2): damages pawns, projectiles and obstacles, then dies. Each bolt is independent, so up to 4 × damage on one target.
- These are **not** `FireballProjectile`s, so Lightning does not detonate them.
- **FX:** `cluster_projectile` (`particles/units/heroes/hero_phoenix/phoenix_base_attack.vpcf`), destruction sound `Cluster.Explode`.

---

### 8.13 Drain — column 3 (T)
- **Internal:** `warlock_drain` (`spells/drain.lua`, `projectiles/drainprojectile.lua`, `projectiles/drainhealprojectile.lua`). Display "Drain" — "Cast a projectile that can change direction, grant a slow debuff and steal life of its target". Icon `necrolyte_death_pulse`.
- **Shop:** buy 14, upgrades 6 7 8 9 10 11.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 22 | 21 | 20 | 19 | 18 | 17 | 16 |
| damage (= heal) | 60 | 70 | 80 | 90 | 100 | 110 | 120 |
| buff_duration | 4 | 5 | 6 | 7 | 8 | 9 | 10 |

- **Class constants:** `projectile_speed 700`, `changed_speed 600`, `radius 24.5` (**unused**), `range 850` (class), `extra_time 1.2`, `ally_mod 'modifier_chen_test_of_faith_teleport'`, `enemy_mod 'modifier_bristleback_viscous_nasal_goo'`.
- **Projectile:**
  - `turn_dist = min(dist_to_cursor, 850 × rm)`, `change_time = turn_dist/700`, `extra = 1.2 × rm`, `lifetime = change_time + extra` (`no_range_mastery`, because rm is already applied).
  - **Collision radius = `attribute('coll_radius')` = 0**, because there is no such KV or class field. The 24.5 `radius` is never read. **[FLAG]** The real Drain is effectively a point (only the target's radius counts).
- **Flight:**
  1. Straight at 700 toward the cursor.
  2. At `change_time` (actor timer): **one-time re-aim** toward the closest pawn by 3D distance that is **not the caster** (allies count), at speed 600. If none exists, keep the direction at 600. It does not keep homing afterwards.
- **Collision** (init 0): std + ALLY{PLAYER}.
  - **Ally pawn:**
    - `heal{amount = damage, source = caster}`. The ally's DP drops by 0.5 × damage.
    - `Modifier{+50 move speed, time = buff_duration × ally.dm × caster.dm, native ally_mod}`
    - sound `Drain.HealHit`
    - destroyed
  - **Enemy pawn:**
    - `receiveDamage{damage, hit_normal, kb 0.2}`
    - `Modifier{−50 move speed, time = buff_duration × target.debuff_factor × caster.dm, native enemy_mod}`
    - spawn a **`DrainHealProjectile`** at the hit point. It has no CC and no lifetime. Each pre-tick it sets `v = 650·unit((caster − pos).xy)`. When its XY distance to the caster is < 64 (`dist² < 4096`), it heals the caster by `damage` (the caster's DP −0.5 × damage), plays `Drain.HealHit` and dies. It is unblockable, and Gravity and Warpzone have no practical effect on it.
    - sound `Drain.Hit`
    - destroyed
  - **Obstacle:** reflect.
  - **Enemy projectile:** **nothing happens to Drain**. It survives unless the other projectile damages it (Fireball, Cluster, Splitter child, Twin, Lightning).
- Slows stack additively between casters.
- **FX:** `drain_projectile` (`particles/units/heroes/hero_dazzle/dazzle_poison_touch.vpcf`, scale 1.5; no destruction sound), `drain_heal_projectile` (`particles/units/heroes/hero_venomancer/venomancer_base_attack.vpcf`).
- **Note:** the heal equals the nominal damage, not the damage actually dealt after reductions.

---

### 8.14 Bouncer — column 3 (T)
- **Internal:** `warlock_bouncer` (`spells/bouncer.lua`, `projectiles/bouncerprojectile.lua`). Display "Bouncer" — "Cast missile which will bounce between nearby Warlocks". Icon `viper_poison_attack`.
- **Shop:** buy 14, upgrades 6 7 8 9 10 11.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 19 | 18 | 17 | 16 | 15 | 14 | 13 |
| damage (1st hit) | 54 | 62 | 70 | 78 | 86 | 94 | 102 |
| max enemy hits | 5 | 6 | 6 | 6 | 7 | 7 | 7 |
| range (KV) | 900 | … | | | | | 900 |

**[FLAG]** The KV `range` is read but never used.

- **Projectile:** speed **900**, radius **38**, **TTL 1.0 s** (`setLifetime(ttl)` → ×rm). The TTL **restarts (×rm again) after every pawn bounce**.
- **Collision** (init −1): SELF{PLAYER}, ALLY{PLAYER}, ENEMY{PLAYER, PROJECTILE, OBSTACLE}. `prev_hit` starts as the caster, so it ignores the caster at launch.
- **On a pawn ≠ prev_hit:**
  1. Sound `Bouncer.Hit`, throttled to at most once per 0.1 s.
  2. If the pawn is an enemy: `receiveDamage{damage, hit_normal, kb 1.2}`, then **`damage ×= 0.7`**.
  3. If `damage ≥ 10`: retarget and reset the TTL. Otherwise destroy. Allies and self do not reduce damage, so it keeps bouncing.
  4. `prev_hit = pawn`.
- **Retarget:** the closest **enabled pawn of any alliance, the caster included**, excluding the one just hit (3D distance). The new velocity is an intercept solution:
  ```
  δ = pos − target.pos;  a = δ·v_t;  b = |v_t|² − 900²;  c = |δ|²;  d = a² − b·c
  if d < 0 → aim straight at the target
  t = (a ± √d)/b, the first non-negative root (prefer (a+√d)/b); if both are negative → aim straight
  dir = (v_t·t − δ)/(900·t)     (not re-normalised)
  velocity = 900·dir
  ```
- Damage sequence per level (enemy hits): Lv1 54, 37.8, 26.46, 18.52, 12.97, then destroyed. Lv7 102, 71.4, 49.98, 34.99, 24.49, 17.14, 12.0, then destroyed.
- **Obstacle:** reflect (no TTL reset). **Enemy projectile:** the Bouncer destroys itself and does not damage the other projectile. A damaging projectile also destroys it.
- **FX:** `bouncer_projectile` (`particles/units/heroes/hero_visage/visage_soul_assumption_bolt.vpcf`), destruction sound `Bouncer.Explode`.

---

### 8.15 Recharge — column 3 (T)
- **Internal:** `warlock_recharge` (`spells/recharge.lua`, `projectiles/rechargeprojectile.lua`, `projectiles/rechargerefreshprojectile.lua`). Display "Recharge" — "Casts a projectile that refreshes the spell's cooldown if it hits. Consecutive hits deal more damage". Icon `vengefulspirit_wave_of_terror`.
- **Shop:** buy 13, upgrades 6 7 8 9 10 11.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 23.5 | 22.0 | 21.0 | 20.5 | 20.0 | 19.5 | 19.0 |
| base damage | 60 | 67 | 74 | 81 | 88 | 95 | 102 |

- **Damage at cast** = `damage + 10 × streak(caster)` (`damage_per_consecutive = 10`, uncapped). The streak is per caster and is read at cast time.
- **Projectile:** speed **900**, radius **35**, lifetime **1.0 s × rm** (range 900). Std collision, init 0.
- **On collision:** sound `Recharge.Hit` on every collision.
  - **Enemy pawn:**
    - `receiveDamage{damage, hit_normal, kb 1.0}`
    - effect `recharge_hit` (`particles/econ/items/templar_assassin/templar_assassin_butterfly/templar_assassin_trap_explosion_shock_butterfly.vpcf`)
    - spawn **`RechargeRefreshProjectile`**: no CC, no lifetime, homes to the instigator at **400** u/s (XY). Within 64 u it calls `EndCooldown()` on the target's `warlock_recharge` (a full cooldown reset), plays `Recharge.Refresh` and dies.
    - destroyed
  - **Obstacle:** reflect.
  - **Projectile:** destroyed without damaging the other one.
- **Streak bookkeeping (on destroy):** if a pawn was hit **and** the instigator is unchanged (not stolen by Shield), the streak goes up by 1 and is shown as a purple number (150,30,240). Otherwise it resets to 0: on a miss, expiry, projectile collision, a hit after being stolen, or a round reset. `Pawn:respawn` also resets it.
- **FX:** `recharge_projectile` (`particles/econ/items/templar_assassin/templar_assassin_butterfly/templar_assassin_meld_attack_butterfly.vpcf`) with destruction sound `Recharge.Destroy`, `recharge_refresh_projectile` (`particles/units/heroes/hero_puck/puck_base_attack.vpcf`), cast sound `Recharge.Cast`.
- **Note:** if Shield steals the bolt, the refresh projectile goes to the **new** instigator (only useful if they also own Recharge).

---

### 8.16 Windwalk — column 4 (E)
- **Internal:** `warlock_windwalk` (`spells/windwalk.lua`, `modifiers/windwalkmodifier.lua`). Display "Windwalk" — "Fade and gain high movement speed, enabling a charge attack for a short duration". Icon `elder_titan_echo_stomp_spirit`.
- **Shop:** buy 14, upgrades 6 7 8 9 10 11.
- **Cast:** no target, **IMMEDIATE**, CP **0.0**, anim 1.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 29.0 | 26.0 | 23.5 | 21.0 | 19.5 | 18.5 | 17.5 |
| damage | 54 | 60 | 66 | 72 | 78 | 84 | 90 |
| duration | 2.6 | … | | | | | 2.6 |
| move_bonus | 200 | … | | | | | 200 |

- **Modifier `WindWalkModifier`:**
  - `time = 2.6 × dm`
  - `speed_bonus_abs = +200`
  - native **`modifier_invisible`**: Dota invisibility, so enemies cannot see you
  - sound `WindWalk.Cast` on cast
- **While active:**
  - The pawn CC's ENEMY/PLAYER and ALLY/PLAYER entries are disabled, so you walk through all warlocks.
  - Temporary CC `windwalk`: radius **60**, PLAYER channel, init 0, ENEMY{PLAYER}, not elastic.
  - Your body still collides with projectiles and obstacles.
- **On the windwalk CC colliding with an enemy** (mutual; the enemy's body accepts ENEMY PLAYER unless they are thrusting or windwalking too):
  1. `kb = 1.0`. If you also have a Thrust modifier: `kb = 0.7`, the thrust's knockback becomes `0.7 × 1.2 = 0.84`, and `thrust:hitPawn(enemy, normal, 1)` runs, dealing full thrust damage and removing the thrust.
  2. `enemy:receiveDamage{damage, hit_normal, kb}`, sound `WindWalk.Hit`.
  3. Windwalk is removed.
- **Ends early on any spell cast**, removed before that spell executes. So the only way to combine with Thrust is Thrust first, then Windwalk.
- On removal, the pawn CC's ENEMY/ALLY PLAYER entries are set back to true unconditionally **[FLAG: this re-enables enemy-body collision even if a Thrust is still active]**.

---

### 8.17 Meteor — column 4 (E)
- **Internal:** `warlock_meteor` (`spells/meteor.lua`, `projectiles/meteorprojectile.lua`). Display "Meteor" — "Summons a meteor to strike from the skies". Icon `invoker_chaos_meteor`.
- **Shop:** buy 14, upgrades 6 7 8 9 10 11.
- **Cast:** point + AoE indicator (`AOERadius %radius`), CP **0.2**, anim 4 ("meteor").

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 20.0 | 19.5 | 19.0 | 18.5 | 18.0 | 17.5 | 17.0 |
| damage_min (edge) | 40 | 40 | 40 | 40 | 40 | 40 | 40 |
| damage_max (centre) | 110 | 120 | 130 | 140 | 150 | 160 | 170 |
| radius | 225 | 240 | 255 | 269 | 282 | 294 | 304 |
| range | 1000 | … | | | | | 1000 |
| hover_time | 0.55 | … | | | | | 0.55 |
| fall_time | 0.60 | … | | | | | 0.60 |

- **Mechanics:**
  1. The target is the cursor, clamped to range 1000. **Range mastery does not apply.**
  2. A `MeteorProjectile` spawns at `target − 400·dir` at **z = 700**. It has **no collision component** and no lifetime.
  3. **Hover** for 0.55 s (GAME task, real time): `z = 700 + 50·sin(π/0.55·elapsed)`.
  4. **Fall:** `velocity = (target − pos)/0.60`, a straight diagonal dive.
  5. **Impact** at `fall_time` (GAME task):
     - `damageArea(target, radius, {amount_min 40, amount_max damage_max, knockback_factor 0.66})`. Damage is linear from the edge to the centre, enemies only, pushed away from the impact point.
     - effect `meteor_explode` (`particles/units/heroes/hero_techies/techies_remote_mines_detonate.vpcf`)
     - destroyed, which plays `Meteor.Explode`
  - Total delay from cast to impact: **1.15 s** after the cast point.
- **Immune to everything:** Shield, Alteration, Lightning, Gravity, Magnetize, Warpzone and Redirector all exclude it or cannot touch it. Damage is always applied at the stored target point, wherever the visual ends up.
- **FX:** `meteor_projectile` (`particles/meteor/meteor.vpcf`, custom), cast sound `Meteor.Cast`.

---

### 8.18 Splitter — column 4 (E)
- **Internal:** `warlock_splitter` (`spells/splitter.lua`, `projectiles/splitterprojectile.lua`, `splitterspawnerprojectile.lua`, `splitterchildprojectile.lua`). Display "Splitter" — "Cast a projectile which splits into minor missiles". Icon `skywrath_mage_concussive_shot`.
- **Shop:** buy 15, upgrades 7 8 9 10 11 12.
- **Cast:** point, **IGNORE_TURN**, CP **0.0**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 24 | 23 | 22 | 21 | 20 | 19 | 18 |
| damage (per child) | 30 | 35 | 40 | 45 | 50 | 55 | 60 |
| range (KV) | 900 | … | | | | | 900 |

**[FLAG]** The KV `range` is unused.

- **Stage 1, main bolt** (`SplitterProjectile`):
  - speed **700**, radius **50**, std collision, no damage of its own
  - `lifetime = min(1.0 × rm, dist/(700 × rm))`, then ×rm again in `setLifetime`. Effective: `min(1.0 × rm², dist/700)`. **[FLAG: rm² on the maximum]**
  - **Any** collision destroys it. On an obstacle it first reverses its velocity and sets a spawn offset `−n·((r_obst + 50 + 10) − hit_distance)`, so the split goes back the way it came.
  - **On destroy for any reason** (expiry, hit, round clear) it spawns stage 2.
- **Stage 2, spawner** (`SplitterSpawnerProjectile`):
  - spawns at the main bolt's position + offset, `velocity = 250·unit(main velocity)`
  - `lifetime 0.48` (×rm via setLifetime)
  - **empty collision matrix**: touches nothing, though Shield, Alteration and Warpzone CCs can still act on it
  - a periodic actor timer every `0.48/4 = 0.12 s` (unscaled base) spawns a **wave of 2 children**. After the 4th wave it destroys itself.
  - **[FLAG]** At rm = 1 the 4th wave and the 0.48 s death timer fire on the same tick in unspecified order, so the 4th wave may not spawn. The intended result is 4 waves = 8 children.
- **Stage 3, children** (`SplitterChildProjectile` = `SimpleProjectile`):
  - wave k = 0..3: `α = 0.48 × (1 − k/4)` = 0.48, 0.36, 0.24, 0.12
  - `child_dir = (dir + sign·α·perp)/(1 + α)` for sign = ±1, with `perp = (−dir.y, dir.x)`. It is **not normalised**.
  - Child speed = `600·√(1+α²)/(1+α)` and angle off the axis = `atan(α)`:

| wave | α | speed | angle |
|---|---|---|---|
| 0 | 0.48 | 449.7 | ±25.6° |
| 1 | 0.36 | 468.9 | ±19.8° |
| 2 | 0.24 | 497.6 | ±13.5° |
| 3 | 0.12 | 539.6 | ±6.8° |

  - radius **21**, damage = KV damage, kb 1.0
  - lifetime `1.2 × rm`, then ×rm again → **1.2 × rm²** **[FLAG]**
  - std collision: damages pawns, projectiles and obstacles
  - sound `Splitter.ChildHit` on hit
  - The children spread outward from a spawner that keeps moving forward at 250, giving a fan/cone of 8 bolts.
- **FX:** cast sound `Splitter.Cast`. Main `splitter_projectile` (`particles/units/heroes/hero_skywrath_mage/skywrath_mage_arcane_bolt.vpcf`, destruction sound `Splitter.Split`). Spawner `splitter_spawner_projectile` (`…/skywrath_mage_concussive_shot.vpcf`). Child `splitter_child_projectile` (`…/skywrath_mage_base_attack.vpcf`).

---

### 8.19 Snowball — column 4 (E)
- **Internal:** `warlock_snowball` (`spells/snowball.lua`, `projectiles/snowballprojectile.lua`, `modifiers/snowballmodifier.lua`). Display "Snowball" — "Spawns a snowball which will drag other players with it and explode". Icon `tusk_snowball`.
- **Shop:** buy 14, upgrades 6 7 8 9 10 11.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 19.0 | 18.0 | 17.0 | 16.0 | 15.0 | 14.0 | 13.0 |
| damage (contact DoT per second) | 30 | 35 | 40 | 45 | 50 | 55 | 60 |
| damage_min (explosion edge) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| damage_max (explosion centre; also dealt to an obstacle hit) | 45 | 60 | 75 | 90 | 105 | 120 | 135 |
| coll_radius | 75 | 77 | 79 | 81 | 83 | 85 | 87 |
| radius (explosion) | 200 | … | | | | | 200 |
| range | 575 | … | | | | | 575 |

- **Projectile:** speed **400**, radius `coll_radius`, lifetime `575/400 = 1.4375 s × rm`. Std collision, init 0. **Ignores all incoming damage**, so projectiles cannot destroy it.
- **On contact with an enemy pawn.** Overlap re-triggers this every tick.
  - **Drag:** `c = 425 − dir·v_pawn`. If `c > 0`, `v_pawn += c·dir`. The pawn's velocity along the roll direction becomes at least 425, slightly faster than the ball, so it is pushed ahead of it.
  - If the pawn has no `SnowballModifier`, add one:
    - `speed −100`
    - `time = 0.5 s` (**not** debuff-scaled)
    - attached effect `snowball_dps` (`particles/units/heroes/hero_crystalmaiden/maiden_crystal_nova.vpcf`, destruction sound `Snowball.DPS`)
    - on expiry, `receiveDamage{source = caster, amount = damage × 0.5}`, with no hit_normal (no knockback, but DP)
  - Net effect: about `damage/2` every 0.5 s while touching.
- **On an obstacle:** destroyed (explodes), then deals `damage_max` to the obstacle.
- **On an enemy projectile:** nothing happens to the Snowball. A damaging projectile still dies on its own.
- **On destroy (any reason, expiry included): explosion.**
  - `damageArea(location, 200, {amount_min 0, amount_max damage_max, knockback_factor 0.8})` against enemies
  - effect `snowball_explode` (`particles/econ/items/crystal_maiden/crystal_maiden_cowl_of_ice/maiden_crystal_nova_cowlofice.vpcf`)
  - destruction sound `Snowball.Explode`
- **Visual:** `snowball_projectile` = `ModelEffect` `models/particle/snowball.vmdl`, scale 0.4, rotated by pitch `+= 1000·dt·dir.y` and roll `+= 1000·dt·dir.x` per tick. Cast sound `Snowball.Cast`.
- **[FLAG]** `snowballmodifier.lua` redefines `GripModifier:onSpellCast`, an identical copy-paste with no behaviour change, and its `end_sound` is `self.dps_sound`, which is nil.

---

### 8.20 Shield — column 5 (C)
- **Internal:** `warlock_shield` (`spells/shield.lua`, `modifiers/shieldmodifier.lua`). Display "Shield" — "Activates a shield that will deflect projectile spells". Icon `faceless_void_chronosphere`.
- **Shop:** buy 12, upgrades 6 7 8 9 10 11.
- **Cast:** no target, **IMMEDIATE**, CP **0.0**, anim 1.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 14.0 | 13.0 | 12.0 | 11.0 | 10.0 | 9.0 | 8.0 |
| duration | 1.2 | … | | | | | 1.2 |
| radius | 200 | 210 | 220 | 230 | 240 | 250 | 260 |

- **Modifier `ShieldModifier`:** `time = 1.2 × dm`, native `modifier_omniknight_repel` (visual), cast sound `Shield.Cast`.
- **While active:**
  - The pawn CC's ENEMY/PROJECTILE entry is **disabled**: std (init 0) projectiles can no longer hit the body.
  - Temporary `ShieldCollisionComponent` `shield`: radius = KV radius, PLAYER channel, **init −3**, ENEMY{PROJECTILE}, **notifies only itself** (the projectile is never told), `accept_damage false`.
- **On the shield CC touching an enemy PROJECTILE-channel actor:**
  - `reflect = not (Swap or Gravity or WarpZone)`
  - `change_owner = reflect and not (Boomerang or Link)`
  - Boomerang: `stopAcceleration()`, which forces return mode.
  - If `change_owner`: `projectile.instigator = shielder` and `projectile.owner = shielder.owner`. **The projectile now belongs to the shielder**: it can hit its original caster, it credits damage to the shielder, and Homing retargets.
  - If `reflect`:
    - If moving toward the shielder, reflect velocity about the normal: `v −= 2(v·n)n`, with n pointing from the shielder to the projectile.
    - Sound `Shield.Reflect`, effect `shield_reflect` (`particles/units/heroes/hero_weaver/weaver_shukuchi_damage.vpcf`) at the contact point.
- **Effects on other spells:**
  - Lightning stops at the bubble without effect.
  - Swap passes through, so the shielder cannot be swapped.
  - Thrust bounces off the bubble with no damage.
  - Link on a shielded pawn breaks.
  - Windwalk and Gravity DPS, meteor, snowball drag and AoEs are unaffected, because they are not projectile collisions.
  - Lower-initiative projectiles (Bouncer, Homing, Magnetize, Boomerang, Link) could still hit the body from inside the radius.

---

### 8.21 Rush — column 5 (C)
- **Internal:** `warlock_rush` (`spells/rush.lua`, `modifiers/rushmodifier.lua`). Display "Rush" — "Enter a focused state where half damage taken is absorbed and converted into movement speed". Icon `ogre_magi_bloodlust`.
- **Shop:** buy 12, upgrades 6 7 8 9 10 11.
- **Cast:** no target, **IMMEDIATE**, CP **0.0**, anim 1.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 21 | 20 | 19 | 18 | 17 | 16 | 15 |
| duration | 6.0 | 6.5 | 7.0 | 7.5 | 8.0 | 8.5 | 9.0 |
| absorb_max | 50 | 70 | 90 | 110 | 130 | 150 | 170 |

- **Modifier `RushModifier`:**
  - `time = duration × dm`
  - native `modifier_ember_spirit_flame_guard` (visual)
  - sound `Rush.Cast`
  - **+35 move speed immediately** (`initial_speed_bonus = 35`)
- **Absorb** (`modifyDamagePostKB`, so **knockback is computed on the full damage**): for damage with a source other than yourself (lava, Scourge self-cost and similar are not absorbed):
  - `absorbed = min(remaining, 0.5 × amount)`
  - `remaining −= absorbed`
  - `move_speed += 1.5 × absorbed`, which accumulates into `bonus_ms`
  - the damage text turns orange (255,200,0)
  - HP loss is reduced by `absorbed`
  - DP gain is **not** reduced, because DP was added before this hook.
- On removal, all accumulated bonus speed (35 + 1.5 × total absorbed) is removed.
- **Link on a target with Rush breaks.**

---

### 8.22 Alteration — column 5 (C)
- **Internal:** `warlock_alteration` (`spells/alteration.lua`, `modifiers/alterationmodifier.lua`). Display "Alteration" — "Alters the position with the next enemy projectile coming close to hitting you". Icon `treant_overgrowth`.
- **Shop:** buy 11, upgrades 5 6 7 8 9 10.
- **Cast:** no target, **IMMEDIATE**, CP **0.0**, anim 1.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 19.0 | 17.5 | 16.0 | 14.5 | 13.0 | 11.5 | 10.0 |
| duration | 2.0 | … | | | | | 2.0 |
| radius | 120 | … | | | | | 120 |

- **Modifier `AlterationModifier`:** `time = 2.0 × dm`, native `modifier_treant_living_armor` (visual), cast sound `Alteration.Cast`. Temporary `AlterationCollisionComponent` `alteration`: radius 120, PLAYER channel, init −3, ENEMY{PROJECTILE}, notifies only itself, `accept_damage false`. The pawn body still accepts projectiles normally.
- **On touching an enemy PROJECTILE-channel actor** that is not Gravity or WarpZone **and is moving toward the caster** (`v·(caster − proj) > 0`):
  1. Sound `Alteration.Swap`, effect `alteration_swap` (`particles/prototype_fx/item_linkens_buff_explosion.vpcf`) at both positions.
  2. **Swap positions:** `caster.location ↔ projectile.location`. Velocities are kept, so the projectile continues on its old heading from where you were standing.
  3. The modifier is removed (one-shot).
- **[FLAG]** The caster's unit is not synced (`_updateLocation`), unlike Teleport, which causes about one tick of walk-velocity glitch. Visual only.
- Lightning is blocked at the 120 radius without effect. Thrust "hits" an Alteration user at 180 u.

---

### 8.23 Gravity — column 6 (Y)
- **Internal:** `warlock_gravity` (`spells/gravity.lua`, `projectiles/gravityprojectile.lua`). Display "Gravity" — "Cast an enchanted orb that will pull enemies with gravitational forces". Icon `enigma_black_hole`.
- **Shop:** buy 12, upgrades 7 8 9 10 11 12.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 21 | 20.5 | 20 | 19.5 | 19 | 18.5 | 18 |
| strength (pawn pull, u/s²) | 500 | 530 | 560 | 590 | 620 | 650 | 680 |
| damage (DPS) | 20 | 33.33 | 46.67 | 60 | 73.33 | 86.67 | 100 |
| range | 900 | … | | | | | 900 |

- **Orb:**
  - speed **450**, lifetime `900/450 = 2.0 s × rm`
  - CC `gravity` radius **25**: PROJECTILE channel, but it only collides with **obstacles**, which reflect it
  - it never touches pawns or projectiles
  - sound `Gravity.Cast` on cast
- **Pull (each orb pre-tick, `dt` = the orb's time-scaled dt):**
  - **Enemy pawns** with distance d ≤ **550**: `v += strength·(1 − d²/550²)·unit(orb − pawn)·dt / pawn.time_scale`.
  - **Every `Projectile` of any owner** (the caster's own included; Meteor, Gravity and Link excluded) with d ≤ **600**: `v += 1650·(1.5 − d²/600²)·unit(orb − proj)·dt / proj.time_scale`. This is 2475 u/s² at the centre and 825 u/s² at the edge.
  - Allies and the caster are not pulled.
  - Distances are 3D, but everything sits at z = 120.
- **DPS:** a GAME task (real time) every **0.2 s** deals `receiveDamage{amount = damage × 0.2, source = caster}` with **no hit_normal** (so no knockback, but DP) to every ENEMY pawn within **250** of the orb (3D `dist² ≤ 250²`). The task stops when the orb is destroyed.
- **Immune to:** Shield (not reflected), Alteration, Lightning, projectile collisions, and other Gravities. **Affected by:** Warpzone (orb slowed; its pull dt shrinks too), Magnetize (it is a Projectile), Redirector.
- **FX:** `gravity_projectile` (`particles/gravity/gravity.vpcf`, custom), destruction sound `Gravity.Destroyed`.

---

### 8.24 Grip — column 6 (Y)
- **Internal:** `warlock_grip` (`spells/grip.lua`, `projectiles/gripprojectile.lua`, `modifiers/gripmodifier.lua`). Display "Grip" — "Cast a missile that immobilizes its target". Icon `nevermore_shadowraze3`.
- **Shop:** buy 12, upgrades 6 7 8 9 10 11.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (= tooltip) | 24 | 20 | 17 | 15 | 13 | 12 | 10.5 |
| duration | 4.50 | 4.75 | 5.00 | 5.25 | 5.50 | 5.75 | 6.00 |
| dp_gain (per cast while gripped) | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

- **Projectile:** speed **1000**, radius **39**, lifetime **1.1 s × rm** (range 1100). Std collision, init 0. No damage.
- **On an enemy pawn:**
  1. Sound `Grip.Hit`.
  2. The pawn's walk velocity is set to 0 (knockback velocity is kept).
  3. `unit:Stop()` cancels the current order or cast.
  4. Add `GripModifier`:
     - `time = duration × target.debuff_factor × caster.dm`
     - `speed_bonus_abs = −10000` (cannot walk)
     - **`kb_reduction = 0.67`** (takes only 33% knockback while gripped)
     - native `modifier_ember_spirit_searing_chains` (visual)
     - **each spell the gripped pawn casts adds +5 DP**
     - sound `Grip.End` on removal
  - Casting is still allowed while gripped.
- **On anything else** (obstacle, projectile): destroyed with no effect and no damage to the other.
- **FX:** `grip_projectile` (`particles/units/heroes/hero_nevermore/nevermore_base_attack.vpcf`), destruction sound `Grip.ProjectileDestroyed`.

---

### 8.25 Warpzone — column 6 (Y)
- **Internal:** `warlock_warpzone` (`spells/warpzone.lua`, class `WarpZone`, actor `WarpZoneActor`, CC `WarpZoneCollisionComponent`). Display "Warpzone" — "Create a time sphere that slows time in an area for any missiles". Icon `antimage_spell_shield`.
- **Shop:** buy 12, upgrades 6 7 8 9 10 11. KV upgrade_cost has 7 entries **[FLAG]**.
- **Cast:** point + AoE indicator, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (KV, real) | 23 | 21 | 20 | 19 | 18 | 17 | 16 |
| tooltip CD | 30 | 29 | 28 | 27 | 26 | 25 | 24 |
| time_scale | 0.40 | 0.36 | 0.32 | 0.28 | 0.24 | 0.20 | 0.16 |
| radius | 200 | 210 | 220 | 230 | 240 | 250 | 260 |
| duration | 4.5 | … | | | | | 4.5 |
| range | 700 | … | | | | | 700 |

**[FLAG]** The real and tooltip cooldowns differ.

- **Mechanics:**
  - A static `WarpZoneActor` is placed at the cursor, clamped to 700 (**no range mastery**).
  - Lifetime `4.5 × caster.dm`, using a plain Actor timer.
  - It is registered as a temp actor, so it is removed at round start.
  - CC: PROJECTILE channel, **init −5**, ENEMY{PROJECTILE}, radius = KV radius, notifies only itself.
- **Each tick an ENEMY projectile overlaps the zone:** if it is not already scaled (and is not a WarpZone or Meteor), `projectile.time_scale *= time_scale` and it is recorded.
- **Every 0.1 s (GAME task):** each recorded actor whose 3D distance from the centre exceeds the radius gets `time_scale /= time_scale` and is forgotten. When the zone ends, everything recorded is unscaled.
- **What time_scale does to a projectile:** its movement, its pre-tick dt (steering, acceleration, Twin's ellipse progress), and its **actor timers (lifetime, Bouncer TTL, Drain turn time, Splitter spawn period, Link retract)** all run at that fraction. Its range is therefore preserved, but it is slowed in real time. GAME tasks (Gravity DPS, Meteor timing, modifier durations) are **not** affected.
- Only **enemy** projectiles are slowed. Your own and your allies' are not, and neither are pawns.
- **Exempt from:** Lightning (explicitly ignored), Shield and Alteration (explicit exclusions), Gravity, Magnetize.
- **FX:** a locust unit with particle `particles/warpzone.vpcf` (custom), CP1 = (radius, 1, 1). No sounds.
- **[FLAG]** Collision prediction ignores time_scale (§3.1), so it is slightly inaccurate inside zones.

---

### 8.26 Magnetize — column 6 (Y)
- **Internal:** `warlock_magnetize` (`spells/magnetize.lua`, `projectiles/magnetizeprojectile.lua`, `modifiers/magnetizemodifier.lua`). Display "Magnetize" — "Creates a missile that magnetizes its target repelling or attracting enemy projectiles". Icon `earth_spirit_magnetize`.
- **Shop:** buy 14, upgrades 5 6 7 8 9 10.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (KV, real) | 22 | 21 | 20 | 19 | 18 | 17 | 16 |
| tooltip CD | 20 | 19 | 18 | 17 | 16 | 15 | 14 |
| duration | 3.50 | 4.00 | 4.50 | 5.00 | 5.50 | 6.00 | 6.50 |

**[FLAG]** The real and tooltip cooldowns differ.

- **Projectile:** speed **800**, radius **36**, lifetime **1.2 s × rm** (range 960). Init −1, collision std + ALLY{PLAYER} + SELF{PLAYER}.
- **On collision:**
  - **Own caster:** ignored **unless the projectile has bounced off an obstacle** (`bounced`).
  - **Any pawn hit** (enemy, ally, or self after a bounce): sound `Magnetize.Hit`, then add `MagnetizeModifier`:
    - **enemy target:** `sign = +1` (**attract**), `time = duration × target.debuff_factor × caster.dm`
    - **ally or self:** `sign = −1` (**repel**), `time = duration × receiver.dm × (caster.dm if different)`
    - native `modifier_earth_spirit_magnetize` (visual), sound `Magnetize.End` on removal
    - then the projectile is destroyed
  - **Obstacle:** reflect (if moving toward it) and set `bounced = true`.
  - **Projectile:** destroyed, without damaging the other.
- **MagnetizeModifier effect (pawn pre-tick, applied per tick and not dt-scaled):** for every `Projectile` that is ENEMY to the magnetized pawn (Meteor excluded) with distance `d ≤ 300`:
  ```
  f   = 0.2·(1 − d²/90000)
  dir = sign·unit(pawn − proj)
  v   = (1 − f)·v + f·|v|·dir
  ```
  This blends the velocity direction toward the pawn (attract) or away from it (repel), with roughly preserved speed.
  - Example: you magnetize an enemy → *your* projectiles curve into them. You magnetize yourself or an ally → *their enemies'* projectiles curve away.
- **FX:** `magnetize_projectile` (`particles/units/heroes/hero_vengeful/vengeful_base_attack.vpcf`), destruction sound `Grip.ProjectileDestroyed` (shared with Grip).

---

### 8.27 Rockpillar — column 6 (Y)
- **Internal:** `warlock_rockpillar` (`spells/rockpillar.lua`). Display "Rockpillar" — "Spawn a rock pillar at the target location that blocks players and projectiles". Icon `earth_spirit_rolling_boulder`.
- **Shop:** buy 13, upgrades 5 6 7 8 9 10.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (KV, real) | 26.0 | 24.0 | 22.0 | 20.0 | 18.0 | 16.0 | 14.0 |
| tooltip CD | 24.0 | 22.0 | 20.0 | 18.0 | 16.0 | 14.0 | 12.0 |
| range | 650 | 725 | 800 | 875 | 950 | 1025 | 1100 |
| duration | 4.00 | … | | | | | 4.00 |

**[FLAG]** The real and tooltip cooldowns differ.

- **Mechanics:**
  - Spawns an `Obstacle` at the cursor, clamped to range (**no range mastery**), with `obstacle_def = {model 'models/props_rock/riveredge_rock006a.vmdl', radius 90, elasticity 0.5}`.
  - Static, mass 10000, **400 HP**, owner neutral (ENEMY to everyone, including the caster).
  - Registered as a temp actor, so it is removed at round start.
  - Removed after `4.0 × caster.dm` s (GAME task).
- **Behaves exactly like an arena obstacle:**
  - It blocks every warlock with elastic bounce and push-out. A pillar spawned on top of a warlock pushes them to its surface (§3.2).
  - It blocks projectiles according to each projectile's obstacle reaction: Fireball, Cluster, Splitter children, Twin and Homing damage it. Snowball deals `damage_max` and explodes. Lightning damages it. Drain, Magnetize, Bouncer, Recharge and Gravity reflect off it. Boomerang bounces at 750. Grip dies. Splitter reverses and splits. Link latches and pulls the caster to it. Swap trades places with it (combat only).
  - At 0 HP it **explodes**: 5–10 damage (`5 + 5·(1 − d/300)`) to **all** pawns within 300, with knockback. Allies of the destroyer gain no DP from it.
- **FX:** spawn effect `rockpillar_spawn` (`particles/econ/items/tinker/boots_of_travel/teleport_start_bots_dust.vpcf`) and sound `RockPillar.Spawn`. Death effect `rockpillar_death` (`particles/econ/items/undying/undying_manyone/undying_pale_tower_destruction_dust_hit.vpcf`) and sound `RockPillar.Death`. Destroyed-by-damage effect `obstacle_explode` (`particles/units/heroes/hero_jakiro/jakiro_liquid_fire_explosion.vpcf`).
- **[FLAG]** The expiry callback calls `GAME:removeObstacle` (which destroys the pillar) **before** checking `obstacle.exists`, so the death effect and sound never play.

---

### 8.28 Link — column 6 (Y)
- **Internal:** `warlock_link` (`spells/link.lua`, `projectiles/linkprojectile.lua`, `modifiers/linkmodifier.lua`). Display "Link" — "Shoot a magical link which can latch on enemies or allies and pull them to you". Icon `wisp_tether`.
- **Shop:** buy 12, upgrades 6 7 8 9 10 11.
- **Cast:** point, CP **0.2**, anim 2.

| Lv | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| CD (KV, real) | 17.0 | 15.0 | 13.0 | 11.0 | 9.0 | 7.0 | 7.0 (*) |
| tooltip CD | 20.0 | 18.0 | 16.0 | 14.0 | 12.0 | 10.0 | 8.0 |
| damage (DPS, enemies only) | 12 | 20 | 28 | 36 | 44 | 52 | 60 |
| range | 860 | … | | | | | 860 |
| speed | 950 | … | | | | | 950 |

(*) **[FLAG]** The KV `AbilityCooldown` has only **6** values for 7 levels; Dota uses the last value for Lv7. The real and tooltip cooldowns also disagree everywhere.

- **Class constants** (these override KV): `radius 35`, `speed 950`, `range 860`, `pull_accel 1550`, `loop_sound 'Link.Loop'`, `loop_duration 100000`.
- **Projectile:**
  - flies at 950 for `retract_time = 860 × rm / 950` s (0.905 s at rm 1)
  - then **retracts**: each tick `v = 950·unit(caster − pos)`, destroyed within 75 (3D) of the caster
  - **no lifetime timer**, destroyed immediately if the caster dies
  - Collision init −1: ALLY{PLAYER}, ENEMY{PLAYER, OBSTACLE}. It never touches projectiles.
  - A beam `link_beam` (`FollowLightningEffect` `particles/units/heroes/hero_stormspirit/stormspirit_electric_vortex.vpcf`) runs from the caster's `attach_hitloc` to the projectile. The projectile particle itself is empty (`effect_name ""`).
- **On any collision:** sound `Link.Hit`, then:
  - **Pawn (ally or enemy):** the beam end moves to the pawn. The **caster** gets `LinkModifier{linked = pawn, pull_linked = true, damage = DPS if enemy else nil, temporary}`. The projectile is destroyed while the beam is kept.
  - **Obstacle:** the beam end moves to the obstacle. The caster gets `LinkModifier{linked = obstacle, pull_linked = false}`, which pulls the caster toward the obstacle and deals no damage.
- **LinkModifier** (on the caster, `loop_sound 'Link.Loop'`):
  - Each caster pre-tick: `pulled.velocity += 1550·dir·dt`.
    - pull_linked (a pawn): the linked pawn is pulled toward the caster.
    - obstacle: the caster is pulled toward the obstacle.
  - DPS (enemy only): a GAME task every **0.2 s** deals `receiveDamage{amount = DPS × 0.2, source = caster}` with **no knockback** (but DP).
  - **Ends when any of these holds:**
    - the linked pawn is dead/disabled, or the linked actor no longer exists
    - the linked pawn has a **Shield or Rush** modifier
    - the distance is < **100** (**120** for obstacles)
    - the caster casts **Teleport or Swap with the cursor on an unsafe (lava) tile** and the link is on a pawn
    - the caster dies, or the round resets (`temporary`)
  - **There is no maximum duration.**
  - On end: the beam is destroyed and the loop sound and DPS task stop.
- **Immune to:** Gravity (explicitly excluded), Lightning, projectile collisions. **Affected by:** Shield (reflected, not stolen), Alteration, Warpzone, Magnetize, Redirector (re-aims the outbound link).
- **FX:** cast sound `Link.Cast`.

---

## 9. Passive items (context only; not spells)
These are `ModifierItem`s from `Shop.ITEM_DEFS`, applied as stat modifiers:

| Item | Effect per level |
|---|---|
| Ring of Health | hp_bonus 100 / 190 / 270 / 340 / 400 |
| Cursed Ring | hp 100/200, kb_reduction 0.15/0.15, debuff_factor +0.25/+0.30 |
| Cape | hp_regen 1.5 / 2.5 / 3.5. **[FLAG]** The shop UI data says 2 / 3.5 / 4.5. |
| Armor | kb_reduction 0.12 / 0.18 / 0.22 |
| Boots | move +18 / +29 / +40 |
| Pocket Watch | debuff_factor −0.35 / −0.45 |

---

## 10. Sound events (`content/dota_addons/warlock/soundevents/game_sounds_custom.vsndevts`) → source asset

| Event | Asset(s) |
|---|---|
| Lightning.Cast | sounds/weapons/hero/zuus/lightning_bolt.vsnd |
| Lightning.FBExplosion | sounds/weapons/hero/zuus/gods_wrath_cast.vsnd |
| Scourge.Cast | sounds/weapons/hero/abaddon/shield_detonate.vsnd |
| Boomerang.Hit | sounds/weapons/hero/bloodseeker/attack01/02/03.vsnd |
| Fireball.Explode, Cluster.Explode | sounds/weapons/hero/ogre_magi/fireblast_target.vsnd |
| Gravity.Cast | sounds/weapons/hero/medusa/snake_return.vsnd |
| Gravity.Destroyed | sounds/weapons/hero/lich/impact01/02.vsnd |
| Meteor.Cast / Meteor.Explode | sounds/weapons/hero/invoker/meteor_cast.vsnd / meteor_impact.vsnd |
| Teleport.Cast | sounds/weapons/hero/bane/brain_sap.vsnd |
| Bouncer.Hit | sounds/weapons/hero/templar_assassin/meld_end.vsnd |
| Bouncer.Explode | sounds/weapons/hero/terrorblade/ranged_impacts_01/02.vsnd |
| WindWalk.Hit / WindWalk.Cast | sounds/weapons/hero/axe/berserkers_shoutmask.vsnd / sounds/weapons/hero/clinkz/windwalk.vsnd |
| Shield.Cast | sounds/weapons/hero/invoker/alacrity.vsnd |
| Shield.Reflect | sounds/weapons/hero/leshrac/diabolic_edict01..06.vsnd |
| Swap.Swap | sounds/weapons/hero/vengeful_spirit/nether_swap.vsnd |
| Rush.Cast | sounds/weapons/hero/ember_spirit/searing_chains_cast.vsnd |
| Grip.Hit / Grip.End / Grip.ProjectileDestroyed | sounds/weapons/hero/bane/nightmare.vsnd / nightmare_end.vsnd / projectile_impact.vsnd |
| Drain.Hit / Drain.HealHit | sounds/weapons/hero/broodmother/spiderling_impact.vsnd / sounds/weapons/creep/neutral/troll_priest_heal.vsnd |
| Homing.Destroy | sounds/weapons/hero/chen/attack.vsnd |
| Thrust.Hit / Thrust.End / Thrust.Cast | sounds/weapons/hero/doom_bringer/lvl_death.vsnd / dark_seer/dota_dark_seer_ion_shield_end.vsnd / faceless_void/time_walk.vsnd |
| Magnetize.Hit / Magnetize.End | sounds/weapons/hero/keeper/mana_leak_target_fp.vsnd / earth_spirit/magnetize_end.vsnd |
| RockPillar.Spawn / RockPillar.Death | sounds/weapons/hero/earth_spirit/magnetize_cast.vsnd / magnetize_end.vsnd |
| Alteration.Cast / Alteration.Swap | sounds/items/refresher.vsnd / sounds/items/linkens_sphere.vsnd |
| Link.Cast / Link.Loop / Link.Hit | sounds/weapons/hero/razor/plasma_field.vsnd / static_attack_loop.vsnd / plasma_field_impact01..03.vsnd |
| Splitter.ChildHit / Splitter.Split / Splitter.Cast | sounds/weapons/hero/wisp/spirit_target.vsnd / chen/hp_port_in.vsnd / chen/hp_port_out.vsnd |
| Redirector.Cast | sounds/weapons/hero/puck/waning_rift.vsnd |
| Snowball.Cast / Snowball.Explode / Snowball.DPS | sounds/weapons/hero/tusk/snowball_ally.vsnd / snowball_target.vsnd / ancient_apparition/cold_feet_tick.vsnd |
| Pact.Cast / Pact.Enhance | sounds/weapons/hero/abaddon/shield_cast.vsnd / death_coil_impact.vsnd |
| Recharge.Cast / .Destroy / .Hit / .Refresh | sounds/weapons/hero/arc_warden/spark_wraith_cast.vsnd / puck/impact.vsnd / arc_warden/flux_cast.vsnd / arc_warden/tempest_double.vsnd |
| Twin.Hit / Twin.Cast | sounds/weapons/hero/dark_willow/ley_cast.vsnd / ley_counter.vsnd |

Custom particles live in `content/dota_addons/warlock/particles`: `particles/gravity/gravity.vpcf`, `particles/meteor/meteor.vpcf`, `particles/homing/homing_projectile.vpcf` and `particles/warpzone.vpcf`. Every other particle is a stock Dota asset; the paths are listed per spell. Dota "native modifiers" used purely as visuals or status:

| Native modifier | Used by |
|---|---|
| `modifier_invisible` | Windwalk (real invisibility) |
| `modifier_omniknight_repel` | Shield |
| `modifier_ember_spirit_flame_guard` | Rush |
| `modifier_treant_living_armor` | Alteration |
| `modifier_ember_spirit_searing_chains` | Grip |
| `modifier_earth_spirit_magnetize` | Magnetize |
| `modifier_dark_seer_ion_shell` | Thrust |
| `modifier_chen_test_of_faith_teleport` | Drain ally buff, Homing self-buff |
| `modifier_bristleback_viscous_nasal_goo` | Drain slow |

**[FLAG]** Some of these Dota modifiers have built-in gameplay effects in Dota (Flame Guard burn and absorb, Searing Chains damage, Ion Shell damage, Repel). They are added with a nil ability, so those effects are probably inert. Treat them as visuals and confirm against footage if possible.

---

## 11. Quick numeric index (Lv1 → Lv7)

| Spell | CD (real) | Key numbers |
|---|---|---|
| Fireball | 4.8 | dmg 70→112, speed 1000, r 25, range 1000, kb 1.0 |
| Scourge | 3.0, CP 0.9 | dmg 100/110/120, r 250, self −100, kb 0.75–1.0, DP refund 0/20/30 per hit |
| Redirector | 24 | +0.5 s lifetime (×rm), +30% KB taken for 8 s |
| Pact | 30 | ×1.5 next damage, 5 s window, −66 move speed for 6 s |
| Boomerang | 16→9.6 | dmg 70→106, range 800 (min 300), r 38, kb 0.95, launch 1500 + 300 lateral, return at 1000 |
| Lightning | 16.5→13 | dmg 70→118, range 600, width 25 + r, kb 0.92, detonates friendly Fireball (r 225, 2/3·(dmg+70), kb 1.35) |
| Homing | 16.5→9 | dmg 70→130, 4.5 s, steer 0.97/tick toward 1000, r 30, self-hit AoE 292 + 50 move speed (120 with Thrust) |
| Twin | 16→9.6 | 2 × dmg 44→72, range 800, ellipse area 450², path speed 1000, r 35 |
| Teleport | 16→7 | range 770→1190, velocity × 0.8 |
| Thrust | 16.5→9 | dmg 50→80, range 900, launch 1001, accel 1733.3, r 60, kb 1.2, ×0.2 brake on miss |
| Swap | 15.8→7 | speed 1983, max 0.4706 s (933 u), r 40 |
| Cluster | 15.5→11 | 4 × dmg 33→51, ±0.06/±0.18 rad, speed 844, range 672, r 22, kb 0.65 |
| Drain | 22→16 | dmg/heal 60→120, ±50 move speed for 4→10 s, 700 then 600, turn at ≤ 850, +1.2 s, kb 0.2 |
| Bouncer | 19→13 | dmg 54→102 ×0.7 per hit, speed 900, TTL 1 s, r 38, kb 1.2 |
| Recharge | 23.5→19 | dmg 60→102 +10/streak, speed 900, 1 s, r 35, refresh at 400 u/s |
| Windwalk | 29→17.5 | dmg 54→90, 2.6 s, +200 move speed, CC r 60, invisible |
| Meteor | 20→17 | dmg 40 / 110→170, AoE 225→304, range 1000, 0.55 + 0.60 s delay, kb 0.66 |
| Splitter | 24→18 | child dmg 30→60, main 700 u/s × 1 s (r 50), 4 waves × 2 children, r 21, 1.2 s |
| Snowball | 19→13 | explosion 0→45..135 (r 200), DoT 30→60/s, coll r 75→87, speed 400, range 575, drag 425, kb 0.8 |
| Shield | 14→8 | 1.2 s, radius 200→260, reflect + steal |
| Rush | 21→15 | 6→9 s, absorb 50% up to 50→170, +35 and +1.5 move speed per absorbed HP |
| Alteration | 19→10 | 2 s, r 120, one swap |
| Gravity | 21→18 | pull 500→680 (pawns ≤ 550), projectiles 1650·(1.5 − d²/600²) ≤ 600, DPS 20→100 within 250, speed 450, 2 s |
| Grip | 24→10.5 | root 4.5→6 s, KB taken ×0.33, +5 DP per cast, speed 1000, 1.1 s, r 39 |
| Warpzone | 23→16 | time scale 0.40→0.16, r 200→260, 4.5 s, range 700 |
| Magnetize | 22→16 | 3.5→6.5 s, steer f = 0.2·(1 − d²/300²) within 300, speed 800, 1.2 s, r 36 |
| Rockpillar | 26→14 | pillar r 90, 400 HP, 4 s, range 650→1100 |
| Link | 17→7 | DPS 12→60, pull 1550 u/s², speed 950, range 860, break < 100/120 |

---

## 12. Consolidated flags (ambiguities, contradictions, bugs)

1. **Homing is broken in this snapshot.** `projectiles/homingprojectile.lua` fails to parse (`else if` leaves one `end` missing). The loader's `pcall` hides the error, `HomingProjectile` is nil, and casting throws. A second typo, `instanceOf` for `instanceof`, would throw on obstacle hits. Rebuild the intended behaviour (§8.7).
2. **Homing burnout radius ×1.05 is never applied** (a local variable that is computed and not used).
3. **Drain collision radius is 0.** The spell reads `coll_radius`, which does not exist, so the lookup returns 0. The defined `radius = 24.5` is unused.
4. **Real cooldown ≠ tooltip (`cooldown2`)** for Homing, Twin, Warpzone (23–16 real vs 30–24 shown), Magnetize, Rockpillar and Link. Link's real cooldown array has only 6 values, so Lv7 = Lv6 = 7.0.
5. **Warpzone KV `upgrade_cost`** has 7 entries (6..12). The shop uses 6..11.
6. **Range mastery is applied twice** to Splitter's main-bolt maximum lifetime and child lifetime (rm²), and to Redirector's lifetime extension (`(remaining + 0.5) × rm`, which also re-multiplies the remaining time).
7. **Splitter 4th-wave race** at rm = 1: the spawner's death timer and its 4th spawn timer coincide, and timer iteration order is unspecified.
8. **Bouncer and Splitter KV `range`** values are never read.
9. **Rockpillar death effect and sound never play** (the `exists` check runs after the destroy).
10. **Scourge Lv1 self-cost uses `damage`**, so Pact makes it 150. Lv2/3 use a fixed 100. Self-cost also happens outside combat.
11. **Alteration** does not sync the unit after teleporting the caster (a one-tick glitch). Teleport and Swap do sync.
12. **Windwalk removal re-enables enemy-body collision** even if a Thrust is still active.
13. **TOI ignores `time_scale`** (minor prediction error inside Warpzones).
14. **Same-type temporary CCs**, if two instances ever overlap, overwrite the table slot and leave an orphaned active CC (not reachable with normal cooldowns).
15. **`snowballmodifier.lua` redefines `GripModifier:onSpellCast`** (identical body; harmless). Its `end_sound` is nil.
16. **The `luaabils/item_warlock_fireball*.lua` files are unused** (the items are datadriven).
17. **Cape regen:** server 1.5/2.5/3.5 vs shop UI 2/3.5/4.5 (not a spell, but visible).
18. **Hotkeys are not defined by the mod.** D/R/T/E/C/Y are column labels in comments only.
19. **Per-tick (not dt-scaled) rules:** friction 0.96, Homing α 0.97, Magnetize f. These are frame-rate dependent at the 0.035 s tick, so a fixed-timestep rebuild should run them per 35 ms tick to match.
20. **Dota native modifiers** may carry hidden Dota gameplay effects (§10). They are assumed to be visual only.
21. **No hit memory** on Boomerang, so it can hit the same enemy twice. Twin's two bolts can both hit. Bouncer retargets onto allies and self without decaying.
22. **Spells can never be sold or swapped** after purchase (no code path). One spell per column for the whole match.
