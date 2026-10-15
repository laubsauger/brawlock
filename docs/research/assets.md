# Warlock Brawl: Asset Inventory for the Browser Rebuild

Source: `github.com/warlockbrawl/warlock` (shallow clone of `1cc00c9`, 2022-01-15), read-only.
Method: parsed files with my own scripts (python3 -I) outside the repo. Executed nothing from the repo. Full commit history came from the GitHub API, because the local clone is shallow.

Paths below are relative to the repo root unless noted otherwise.

---

## 0. TL;DR

| Category | Verdict |
|---|---|
| **License** | **None.** There is no LICENSE file and no license in the README, GitHub metadata (`license: null`), or the other org repos. Default copyright applies: all rights reserved by the authors. Code and any custom art cannot be copied without permission. Game *mechanics* and numeric constants are ideas or facts and can be re-implemented. |
| **Sounds** | **0 audio files in the repo.** All 52 sound events reference Dota 2 built-in `.vsnd` files (Valve-owned). **Nothing reusable.** Recreate everything. |
| **Item / spell icons** | 31 PNGs. **All are crops of Dota 2 item and ability icons** (made by `warlockgen/makeicon.py`). Spell icons are Dota `spellicons/*` referenced by name. **Cannot ship.** |
| **Loading screen** | Fan art of Dota's Warlock hero, signed **"BigGreenPepper"**. Third-party artist plus Valve IP. **Cannot ship.** |
| **Discord logo** | Discord trademark. Use only under Discord brand rules, or drop it. |
| **Tile textures** (3) | Provenance **unknown**. Nothing is credited in the commit. `tile2.jpg` was saved in Photoshop CS2 in **2010** (stock or web texture; predates the mod), and `tile1.tga` was written by the DevIL library (a conversion). **Do not ship. Replace with CC0.** |
| **Tile models** (9 SMD) | Trivial custom boxes by Robin Kahlow (192x192x32, optional rounded corners). Unlicensed, but trivial: **regenerate procedurally** (spec in §4). |
| **Minimap overview** | A flat red disc on black, trivially recreatable (no need to copy). |
| **Particles** (6 vpcf) | 2 custom effects (gravity, warpzone). They are useful **as parameter reference** (colors, rates, lifetimes), but they use Valve textures. Recreate in WebGPU. All 50+ other spell particles are Dota built-ins. |
| **Map** | The vmap/vpk contain only a Dota `dire_lava` plane, Dota props, and spawn markers. **Not reusable.** The arena itself is procedural and lives in Lua (§6). |
| **Hero models** | 7 Dota heroes (warlock, invoker, rubick, lina, oracle, arc_warden, crystal_maiden). **Cannot ship.** |
| **Obstacle models** | Dota props (stone_ruins, badside_rocks, barrels, poles, chest, riveredge_rock for Rock Pillar). **Cannot ship.** |
| **Font** | `Nunito-Regular.ttf`: SIL OFL 1.1 (Vernon Adams, 2011). **Reusable**, but better to pull the current Nunito from Google Fonts. |
| **Localization** | EN, RU, pt-BR, zh-CN. The text is the authors' copyrighted work (no license). Use as a **reference for the string inventory only**, rewrite the copy, or get permission. Short spell names and one-line descriptions are low-risk to paraphrase. |

**Net: nothing in the repo is safe to ship as-is except the OFL font.** What is valuable is *data*: the arena algorithm, constants, spell parameters, and the effect color and timing references. All of that can be re-implemented.

---

## 1. License and authorship

- **No LICENSE / COPYING file** anywhere. README.md is just a title and a Gitter badge.
- GitHub API: `warlockbrawl/warlock` has `license: null`. The other org repos (`warlockbrawl.com`, `inquisitor`, `warlock-patches`) have none either. `MPQExtractor` and `CASCExtractor` are forks with `NOASSERTION`.
- Repo created 2015-07-19, last push 2022-01-15, 25 stars, not archived.
- **Copyright header** (`game/.../vscripts/addon_game_mode.lua:2`): `Copyright (c) 2014 Krzysztof Lis (Adynathos), Zymoran, Toraxxx`.
- `@author Krzysztof Lis (Adynathos)` appears on most `base/*.lua` files plus `util/class.lua`, `util/set.lua`, `spells/lightning.lua`, and `test/test.lua`.
- In-game credit (`base/game.lua:114`): "Created by Toraxxx, Adynathos, Zymoran".
- **Commit authors (303 commits, 2014-08-08 to 2022-01-15):** Robin Kahlow 175, ToraxXx 93, Toraxxx (Robin Kahlow) 6, Torax 3 (all the same person, Robin Kahlow, "Toraxxx", tora@warlock.ai), zymoran 21, plus one each from VicPetrov, sides, lbc, and the Gitter badger. Adynathos's work predates the repo or was imported. He has no commits under his own name.
- `addoninfo.txt`: "Warlock Brawl is the official Dota 2 mod based on the Warcraft 3 map Warlock developed by its original creators."
- Third-party code inside (irrelevant to a TS rebuild, but noted):
  - `vscripts/heap.lua`: MIT, Roland Yonaba.
  - `vscripts/util/json.lua`: CC-BY 3.0, Jeffrey Friedl.
- **Implication:** to reuse *any* code, text, or custom assets verbatim we would need explicit permission from Kahlow, Lis, and Zymoran. They are reachable via the GitHub org; the Gitter/Discord links are probably dead. Re-implementing gameplay from observation and constants is fine.

---

## 2. Sounds

**Audio files in the repo: none.** There are no `.wav`, `.mp3`, `.ogg`, or `.vsnd` files. The only sound asset is `content/dota_addons/warlock/soundevents/game_sounds_custom.vsndevts` (2653 lines, 52 events). It is a pure *event table* pointing at Dota 2's built-in sound library (`sounds/weapons/hero/<dota_hero>/...`, `sounds/items/...`, `sounds/weapons/creep/...`).

**Every referenced file is Valve-owned. Nothing is reusable.** All 52 events are referenced from the Lua.

Columns: vol = volume, pitch = playback pitch. "3D" means the event uses the positional `dota_src1_3d` stack (distance falloff); the rest use `dota_update_default`. These are useful as a mix reference.

| Event | Spell / use | Dota source file(s) | vol | pitch | 3D |
|---|---|---|---|---|---|
| Lightning.Cast | Lightning cast | zuus/lightning_bolt | 1.0 | 1.0 | |
| Lightning.FBExplosion | Lightning hitting a fireball | zuus/gods_wrath_cast | 1.0 | 1.05 | |
| Scourge.Cast | Scourge item | abaddon/shield_detonate | 0.75 | 1.0 | |
| Boomerang.Hit | Boomerang hit | bloodseeker/attack01-03 (random) | 1.0 | 1.0 | yes |
| Fireball.Explode | Fireball impact | ogre_magi/fireblast_target | 1.0 | 0.95 | |
| Cluster.Explode | Cluster impact | ogre_magi/fireblast_target | 0.25 | 1.0 | |
| Gravity.Cast | Gravity cast | medusa/snake_return | 0.75 | 1.0 | yes |
| Gravity.Destroyed | Gravity end | lich/impact01-02 | 1.0 | 1.0 | yes |
| Meteor.Cast | Meteor cast | invoker/meteor_cast | 1.0 | 1.0 | |
| Meteor.Explode | Meteor impact | invoker/meteor_impact | 1.0 | 1.0 | |
| Teleport.Cast | Teleport | bane/brain_sap | 0.8 | 0.95 | |
| Bouncer.Hit | Bouncer bounce | templar_assassin/meld_end | 1.0 | 1.0 | yes |
| Bouncer.Explode | Bouncer end | terrorblade/ranged_impacts_01-02 | 1.0 | 1.0 | yes |
| WindWalk.Cast | Windwalk cast | clinkz/windwalk | 1.0 | 1.0 | |
| WindWalk.Hit | Windwalk charge hit | axe/berserkers_shoutmask | 1.0 | 1.0 | |
| Shield.Cast | Shield cast | invoker/alacrity | 1.0 | 1.0 | |
| Shield.Reflect | Shield reflect | leshrac/diabolic_edict01-06 | 0.5 | 1.0 | |
| Swap.Swap | Swap | vengeful_spirit/nether_swap | 1.0 | 1.0 | |
| Rush.Cast | Rush | ember_spirit/searing_chains_cast | 1.0 | 1.0 | |
| Grip.Hit | Grip hit | bane/nightmare | 1.0 | 1.0 | |
| Grip.End | Grip end | bane/nightmare_end | 1.0 | 1.0 | yes |
| Grip.ProjectileDestroyed | Grip and Magnetize projectile death | bane/projectile_impact | 1.0 | 1.0 | yes |
| Drain.Hit | Drain hit | broodmother/spiderling_impact | 1.0 | 1.05 | |
| Drain.HealHit | Drain heal return | creep/neutral/troll_priest_heal | 1.0 | 1.0 | yes |
| Homing.Destroy | Homing end | chen/attack | 1.0 | 1.05 | yes |
| Thrust.Cast | Thrust cast | faceless_void/time_walk | 1.0 | 1.0 | |
| Thrust.Hit | Thrust hit | doom_bringer/lvl_death | 1.0 | 1.0 | |
| Thrust.End | Thrust end | dark_seer/ion_shield_end | 0.8 | 1.0 | |
| Magnetize.Hit | Magnetize hit | keeper/mana_leak_target_fp | 1.0 | 1.0 | |
| Magnetize.End | Magnetize end | earth_spirit/magnetize_end | 1.0 | 1.0 | |
| RockPillar.Spawn | Rock Pillar spawn | earth_spirit/magnetize_cast | 1.0 | 1.0 | |
| RockPillar.Death | Rock Pillar death | earth_spirit/magnetize_end | 1.0 | 1.0 | |
| Alteration.Cast | Alteration cast | items/refresher | 1.0 | 1.0 | yes |
| Alteration.Swap | Alteration trigger | items/linkens_sphere | 1.0 | 1.0 | |
| Link.Cast | Link cast | razor/plasma_field | 0.6 | rand | |
| Link.Loop | Link tether loop | razor/static_attack_loop | 1.0 | 1.0 | |
| Link.Hit | Link hit | razor/plasma_field_impact01-03 | 1.0 | rand | yes |
| Splitter.Cast | Splitter cast | chen/hp_port_out | 0.8 | rand | yes |
| Splitter.Split | Splitter split | chen/hp_port_in | 0.8 | rand | yes |
| Splitter.ChildHit | Splitter child hit | wisp/spirit_target | 0.7 | rand | yes |
| Redirector.Cast | Redirector item | puck/waning_rift | 1.0 | rand | |
| Snowball.Cast | Snowball cast | tusk/snowball_ally | 1.0 | rand | |
| Snowball.Explode | Snowball impact | tusk/snowball_target | 1.0 | 0.95 | |
| Snowball.DPS | Snowball DoT tick | ancient_apparition/cold_feet_tick | 0.25 | 1.0 | |
| Pact.Cast | Pact item | abaddon/shield_cast | 0.5 | rand | |
| Pact.Enhance | Pact proc | abaddon/death_coil_impact | 0.85 | rand | |
| Recharge.Cast | Recharge cast | arc_warden/spark_wraith_cast | 0.85 | rand | |
| Recharge.Hit | Recharge hit | arc_warden/flux_cast | 0.85 | rand | |
| Recharge.Destroy | Recharge end | puck/impact | 0.85 | rand | |
| Recharge.Refresh | Recharge cooldown refresh | arc_warden/tempest_double | 0.85 | rand | |
| Twin.Cast | Twin cast | dark_willow/ley_counter | 0.8 | rand | yes |
| Twin.Hit | Twin hit | dark_willow/ley_cast | 1.0 | 1.0 | yes |

("rand" means `pitch_rand_min/max` is set: randomized pitch.)

Also not in the event table: the lava burn and the omniknight/invisibility visuals come from native Dota modifiers (§5.3). Spells with no own sound event: Scourge uses Scourge.Cast via the item; Warpzone and Fireball cast have none.

**Sound design takeaways for the rebuild:**
- About 52 one-shots plus 1 loop (Link).
- Random variants matter: Boomerang has 3, Gravity.Destroyed 2, Bouncer.Explode 2, Shield.Reflect 6, Link.Hit 3.
- Pitch randomization is used on about a third of events.
- Cluster.Explode reuses the fireball sound at 0.25 volume because there are 4 projectiles.

---

## 3. Textures and images

| File | Dims | Format | Purpose | Provenance and verdict |
|---|---|---|---|---|
| `content/.../materials/tile1.tga` | 512x512 | TGA RGB 32bpp (DevIL-written) | Platform type 1: white/grey 4x4 stone slabs | Unknown source, added 2015-08-07 by Kahlow. **Replace.** |
| `content/.../materials/tile2.jpg` | 512x512 | JPEG, EXIF "Adobe Photoshop CS2 Windows 2010:08:10" | Platform type 2: dense green grass | Pre-dates the mod by 4 years, so almost certainly a stock or web texture. **Replace.** |
| `content/.../materials/tile3.tga` | 512x512 | TGA RGBA 32bpp | Platform type 3: brown dirt/sand | Unknown. **Replace.** |
| `content/.../materials/overviews/warlock.tga` | 1024x1024 | TGA RLE 24bpp | Minimap overview: solid disc RGB(91,0,0) on black. Disc diameter 756 px at 16 units/px = **radius ~6048 units** (matches `GAME_ARENA_RADIUS` 5910). Center (511.5, 508.5). | Trivial. Recreate in code. |
| `content/.../panorama/images/custom_game/LoadingScreen.jpg` | 1900x1201 | progressive JPEG | Loading screen | **Fan art of Dota's Warlock hero, signed "BigGreenPepper"** (bottom right). **Cannot ship.** |
| `content/.../panorama/images/custom_game/Discord-Logo-Color.png` | 245x240 | PNG palette | Discord link on loading screen | Discord trademark. |
| `game/.../resource/flash3/images/items/*.png` (31 files) | 88x64 (Dota item icon size); `warlock_fireball.png` and `warlock_scourge.png` are 124x64 | PNG RGBA/RGB | Shop item icons: armor(1-3), boots(1-3), cape(1-3), cursed_ring(1-2), ring_of_health(1-5), pocket_watch(1-2), scourge, scourge_incarnation(1-2), fireball, pact, redirector | **All Dota item/ability art** (see below). **Cannot ship.** |

**How the item icons were made.** `warlockgen/makeicon.py`:
- It takes a source image (its usage example is `"F:/script/icons/items/talisman_of_evasion.png"`, a Dota item icon dump).
- It center-crops to 88x64, or crops 36 px off the right to remove white.
- It writes `<name>.png`, then `<name>1..N.png` with a level number drawn top-right in Nunito 22pt: yellow `(255,255,0)`, or red `(255,0,0)` for the max level.

Visual check confirms Dota art throughout: Boots of Speed, Cloak/hood, Ring of Health, Ring (cursed), Talisman of Evasion (pocket watch), Chainmail/Platemail-style armor, a Phoenix/Ogre fire splash (fireball), a spectral hooded figure (scourge), and a Puck-style blue orb (redirector).

**Spell icons are not files.** They use Dota's built-in `spellicons/*` by name, via `AbilityTextureName` in `scripts/npc/npc_abilities_custom.txt` and `file://{images}/spellicons/*_png.vtex` in `panorama/scripts/custom_game/shop/warlock_shop_data.js`:

| Spell | Dota icon used |
|---|---|
| boomerang | bounty_hunter_shuriken_toss |
| lightning | lina_laguna_blade |
| homing | puck_illusory_orb |
| twin | dark_willow_bedlam |
| cluster | ember_spirit_searing_chains |
| bouncer | viper_poison_attack |
| drain | necrolyte_death_pulse |
| recharge | vengefulspirit_wave_of_terror |
| windwalk | elder_titan_echo_stomp_spirit |
| meteor | invoker_chaos_meteor |
| splitter | skywrath_mage_concussive_shot |
| snowball | tusk_snowball |
| gravity | enigma_black_hole |
| grip | nevermore_shadowraze3 |
| warpzone | antimage_spell_shield |
| magnetize | earth_spirit_magnetize |
| rockpillar | earth_spirit_rolling_boulder |
| link | wisp_tether |
| teleport | rubick_telekinesis |
| swap | vengefulspirit_nether_swap |
| thrust | disruptor_glimpse |
| shield | faceless_void_chronosphere |
| rush | ogre_magi_bloodlust |
| alteration | treant_overgrowth |
| empty slots | rubick_empty1 |

**Referenced but missing from the repo:** `panorama/layout/custom_game/warlock_images.xml` references `custom_game/masteries/{warlock_duration_mastery, warlock_life_steal_mastery, warlock_range_mastery, warlock_jack_of_all_trades}.png` and `custom_game/spells/{warlock_boomerang, warlock_lightning}.png`. None of these exist in the tree.

---

## 4. Models

### 4.1 Arena tiles: `content/dota_addons/warlock/models/tiles/`

There are 9 `.smd` files (Valve Studiomdl text format, version 1, a single bone "root"), each with a `.vmdl` wrapper:
- `tileN_Kround`, where N (1..3) is the texture/platform type and K (0..2) is the number of rounded corners.
- The `.vmdl` is a plain `CVModel` with one mesh. The `.vmat` files use `global_lit_simple.vfx` with only a color texture.

| Variant | Triangles | SMD verts | Unique positions | Top/bottom/side tris |
|---|---|---|---|---|
| `*_0round` | 12 | 36 | 8 | 2 / 2 / 8: a plain box |
| `*_1round` | 32 | 96 | 18 | 8 / 8 / 16 |
| `*_2round` | 44 | 132 | 24 | 12 / 12 / 20 |

Geometry facts:
- **Bounds:** x,y in [-96, 96], z in [0, 32]. That is a 192x192 footprint (= `ARENA_TILE_SIZE`) and 32 high (= `ARENA_TILE_HEIGHT`), with the origin at the bottom center.
- **Same geometry across textures:** tile1/2/3 are byte-identical apart from the material name.
- **Rounded corners:** each is a quarter circle approximated by **2 segments** (3 points), with center at (86.33, 86.39) and radius about 9.65 (≈ 5% of the tile size). The points are (86.33, 96), (93.12, 93.12), (96, 86.39).
- **Which corners round:** in model space, `1round` rounds the (+x,+y) corner, and `2round` rounds both +y corners, (+x,+y) and (-x,+y). The top face is a fan around (±86.4, 86.4).
- **UVs:** each face is mapped 0..1. The top face carries the full texture, the sides stretch it. On `2round` the UV has a -0.05 overshoot.
- **Normals:** flat per face.

**Convertible to glTF?** Trivially. The SMD triangles are explicit (position, normal, UV, single bone), so a 20-line parser can emit glTF. However:
- They are unlicensed custom work.
- They are geometrically trivial.

**Recommendation:** generate the tile mesh procedurally in TS (a box with chamfered or rounded corners, plus an optional bevel) or instance one mesh per corner mask. The arena corner rule (§6.3) needs at most 16 corner masks, or a shader that rounds per-corner from a 4-bit mask.

**Orientation note.** The arena pattern table (§6.3) implies that at yaw 0 the model's rounded side faces world **-X**, not +Y. This is consistent with Source's legacy SMD import applying a +90° Z rotation. This is irrelevant if we implement the corner rule directly.

### 4.2 Everything else is Dota-owned

- **Heroes** (`scripts/npc/herolist.txt`, `npc_heroes_custom.txt` override_hero, `base/config.lua HERO_SETTINGS` scales): warlock 0.65, invoker 0.55, rubick 0.50, lina 0.65, oracle 0.65, arc_warden 0.65, crystal_maiden 0.68. Cast animations map to Dota activities.
- **Obstacles** (`base/obstacles.lua`, 3 variations with collision radii):
  1. stone_ruins001a-005a (r=60)
  2. badside_rocks001 (r70), 002 (r45), 003 (r60), 004 (r40)
  3. barrel001/002 (r50), wooden_pole_01/02 (r35), merchant_debris_chest001 (r50)
  - All have elasticity 0.5. **Variation k also selects tile texture k** (stone ruins → white slabs, rocks → grass, debris → dirt).
- **Spell models:** Rock Pillar uses `models/props_rock/riveredge_rock006a.vmdl`. Snowball uses `models/particle/snowball.vmdl` (Tusk). `models/particle/meteor.vmdl` is precached (Invoker). The dummy/locust unit uses `models/development/invisiblebox.vmdl`.

---

## 5. Particles

### 5.1 Custom `.vpcf` files in the repo (6)

All of them reference **Valve particle textures** (`materials/particle/*.vtex`), so even these are not standalone. Use them as a **parameter reference** only.

**`particles/gravity/gravity.vpcf`**: Gravity orb, KV3 format. Root plus 2 children.

- **Root:** a rope (`C_OP_RenderRopes`) spawned on an **epitrochoid** around control point 3.
  - `C_INIT_CreateInEpitrochoid`: radius1 1.2, radius2 2.0, offset 6.0, density 12, local coordinates.
  - Particle radius 2-3, life 0.3 s.
  - Color goes from (228,255,180) to (148,222,18) starting at 0.4.
  - Fade-in 0.5, fade-out 2.0. Texture `particle_beam_generic`, add-self 4.
  - In effect, a swirling lime-green spirograph ring.
- **`gravity_glow.vpcf`:** additive sprite, radius 120, color (148,222,18), overbright 5, texture `particle_glow_05`, emit 150/s, life 0.1 s, fade-in 0.5. A big lime glow halo.
- **`gravity_trail.vpcf`:** rope trail, radius 10-12 (scale ×10 at start), color (148,222,18,α55) going to (166,236,91). Texture `beam_jagged_04`, V-scroll -166.7, world size 333.3. Emit 16/s, life 0.4 s, fade-out 0.75.
- **Recreate as:** lime additive glow sprite + animated epitrochoid ribbon + jagged trail ribbon.

**`particles/warpzone.vpcf`**: Warpzone (time-slow sphere). Old text-schema format. Parent with 2 children:
- **`warpzone_rings.vpcf`:** sprites oriented flat to the ground (`m_nOrientationType=2`).
  - Radius comes from **control point 1** (CP1.x → radius, 0..1000 maps 1:1), so the radius is driven by spell AoE.
  - Emit 10/s, life 1.0 s, random rotation 0-360°.
  - Random color between (231,133,255) and (0,72,161), interpolating to (130,136,255) over its life.
  - Fade-in by 0.5, fade-out 0.7 to 1.0. Radius scales 1.0 to 0.6 over 0.5 to 1.0 s.
  - Texture `particle_heroring_6_crisp`, not additive.
  - In effect: expanding/shrinking purple-to-blue rings stacked on the ground.
- **`warpzone_sparks.vpcf`:** trails (`C_OP_RenderTrails`) spawned in a flat disc of radius 150.
  - `C_OP_TwistAroundAxis` force 500 makes the sparks orbit.
  - **Refractive** (`m_bRefract`, blur 20). Color (25,78,255) to (75,52,255).
  - Emit 40/s, life 1 s. Fade-in by 0.2, fade-out 0.5 to 1.0. Texture `base_trail`, length scale 2, radius scale 10.
- **Recreate as:** ground-decal ring sprites + swirling refraction streaks (a screen-space distortion pass in WebGPU).

**Missing custom particles.** `particles/homing/homing_projectile.vpcf` and `particles/meteor/meteor.vpcf` are referenced by `spells/homing.lua` and `spells/meteor.lua`, but they are **not in the repo**. Commit `f6e3cc1` (2016-10-31, "replaced broken particles (meteor/homing/fireball/gravity)") deleted the earlier versions. Those earlier versions were themselves **copies of Dota particles** (phoenix_base_attack*, pugna_base_attack*, wisp_base_attack*).

### 5.2 Particle paths used by spells (all Dota built-ins unless marked CUSTOM)

The `effect_name` values come from `vscripts/warlock/spells/*.lua` and `base/*.lua`. All live under `particles/`, which is omitted below.

| Spell | Effects (role) |
|---|---|
| Fireball | `units/heroes/hero_phoenix/phoenix_base_attack` (projectile) |
| Cluster | `hero_phoenix/phoenix_base_attack` (4 smaller projectiles) |
| Lightning | `hero_lina/lina_spell_laguna_blade` (beam); `hero_phoenix/phoenix_supernova_reborn_star_sphere` (explosion when it hits a fireball) |
| Meteor | **CUSTOM (missing)** `meteor/meteor.vpcf` (falling meteor); `hero_techies/techies_remote_mines_detonate` (impact); model `models/particle/meteor.vmdl` |
| Homing | **CUSTOM (missing)** `homing/homing_projectile.vpcf`; `hero_wisp/wisp_base_attack_explosion` and `hero_wisp/wisp_guardian_explosion` (explosions); `hero_doom_bringer/doom_bringer_lvl_death` |
| Gravity | **CUSTOM** `gravity/gravity.vpcf` |
| Warpzone | **CUSTOM** `warpzone.vpcf` (CP1 = radius) |
| Boomerang | `hero_silencer/silencer_glaives_of_wisdom` (projectile); `hero_sniper/sniper_assassinate_impact_blood` (hit) |
| Bouncer | `hero_visage/visage_soul_assumption_bolt` |
| Drain | `hero_dazzle/dazzle_poison_touch` (projectile); `hero_venomancer/venomancer_base_attack` (heal return) |
| Grip | `hero_nevermore/nevermore_base_attack` (projectile); native modifier `modifier_ember_spirit_searing_chains` (rooted visual) |
| Magnetize | `hero_vengeful/vengeful_base_attack` (projectile); native `modifier_earth_spirit_magnetize`; precached espirit_magnetize_* (8 files) |
| Swap | `hero_chaos_knight/chaos_knight_chaos_bolt` (projectile); `hero_nevermore/nevermore_shadowraze` (swap burst) |
| Teleport | `hero_vengeful/vengeful_nether_swap` (origin) and `vengeful_nether_swap_blue` (destination) |
| Thrust | `hero_stormspirit/stormspirit_overload_discharge`; native `modifier_dark_seer_ion_shell` |
| Shield | `hero_weaver/weaver_shukuchi_damage`; native `modifier_omniknight_repel` |
| Link | `hero_stormspirit/stormspirit_electric_vortex` (tether) |
| Splitter | `hero_skywrath_mage/skywrath_mage_arcane_bolt` (main), `skywrath_mage_concussive_shot` (split), `skywrath_mage_base_attack` (children) |
| Twin | `hero_dark_willow/dark_willow_base_attack` (projectiles), `dark_willow_wisp_aoe_cast_glow` |
| Recharge | `econ/items/templar_assassin/templar_assassin_butterfly/templar_assassin_meld_attack_butterfly` (projectile), `.../templar_assassin_trap_explosion_shock_butterfly` (hit); `hero_puck/puck_base_attack` (refresh projectile) |
| Snowball | `econ/items/crystal_maiden/crystal_maiden_cowl_of_ice/maiden_crystal_nova_cowlofice`; `hero_crystalmaiden/maiden_crystal_nova`; model `models/particle/snowball.vmdl` |
| Rock Pillar | `econ/items/tinker/boots_of_travel/teleport_start_bots_dust` (spawn), `econ/items/undying/undying_manyone/undying_pale_tower_destruction_dust_hit` (death) |
| Rush | native `modifier_ember_spirit_flame_guard` (flame aura) |
| Windwalk | native `modifier_invisible` |
| Alteration | `prototype_fx/item_linkens_buff_explosion`; native `modifier_treant_living_armor` |
| Pact (item) | `generic_gameplay/rune_doubledamage`; `econ/items/abaddon/abaddon_alliance/abaddon_aphotic_shield_alliance_explosion`; `econ/courier/courier_oculopus/courier_oculopus_ambient` |
| Redirector (item) | `econ/courier/courier_faceless_rex/cour_rex_flying`; `econ/items/ursa/ursa_swift_claw/ursa_swift_fury_sweep_dim_b_blue` |
| Scourge (item) | `econ/generic/generic_aoe_explosion_sphere_1/generic_aoe_explosion_sphere_1` (npc_items_custom.txt) |
| Obstacle explosion | `hero_jakiro/jakiro_liquid_fire_explosion` |
| Lava burn | native `modifier_phoenix_icarus_dive_burn` → `hero_phoenix/phoenix_icarus_dive_burn_debuff` |
| Spawn / respawn invulnerability (2 s) | native `modifier_omninight_guardian_angel`. The spelling is consistent across all 8 uses in `mode.lua` and appears to be Valve's own internal modifier name. |
| Floating "evade"-style message | `msg_fx/msg_evade` (`base/game.lua:294`) |
| Precache only | `particle_folder` `units/heroes/hero_warlock`, `hero_omniknight`; `hero_bristleback/bristleback_viscous_nasal_goo_debuff`; `hero_ember_spirit/ember_spirit_searing_chains_debuff`; `hero_dark_seer/dark_seer_ion_shell`; `hero_treant/treant_livingarmor` |

There are 65 unique particle path strings in total. **All but 4 (gravity, warpzone, plus the missing homing and meteor) are Valve built-ins.** For the rebuild, the Dota hero names in this table are the best "look reference" to watch on YouTube or Liquipedia when designing replacements.

### 5.3 Native Dota modifiers used for visuals

`modifier_phoenix_icarus_dive_burn` (lava), `modifier_invisible` (windwalk, plus a fix-invisibility hack), `modifier_omninight_guardian_angel`, `modifier_chen_test_of_faith_teleport` (homing), `modifier_treant_living_armor` (alteration), `modifier_ember_spirit_searing_chains` (grip), `modifier_earth_spirit_magnetize`, `modifier_ember_spirit_flame_guard` (rush), `modifier_omniknight_repel` (shield), `modifier_dark_seer_ion_shell` (thrust).

---

## 6. Map and arena geometry

### 6.1 `content/dota_addons/warlock/maps/warlock.vmap` (457 KB, binary DMX "vmap 18")

- An embedded 512x512 JPEG thumbnail (extracted) shows a **lava sea** with a row of player-start dummies and a few white cubes.
- Comment string: **"Decompiled by BSPSource v1.3.11 from warlock"**. The map was ported from the Source 1 (2014) version.
- Materials: `materials/blends/dire_lava.vmat` (Dota), `materials/blends/cracks_base001_fall.vmat`, `dev/black`, `tools/toolsnodraw`, `tools/toolsskybox`. Sky `sky_day01_01`. Height-fog textures `effects/fog_world_00`, `fow_clouds_00`.
- Props: `models/props_garden/bad_stonewall003{,b,c}.vmdl` (Dota).
- **No arena tiles in the map.** The arena is spawned at runtime from Lua.

### 6.2 `game/dota_addons/warlock/maps/warlock.vpk` (compiled; VPK v1, 17 entries)

- World node mesh: only `dire_lava` and `dev/black` materials, plus the props above.
- **Entity lump** (`default_ents.vents_c`):
  - `dota_minimap_boundary` at (-6000,-6000,-1000) and (6000,6000,1000).
  - `world_bounds` min (-5408,-6536) max (5664,5236), z 448.
  - `env_fog_controller` (start 2000 / end 4000).
  - `env_global_light` angles (45, 20, 180).
  - 10 `info_player_start_*` and 10 `ent_fow_revealer` lined up at x = -270..30 step 30, y=0. These are placeholders; real spawns come from Lua.
  - A `structure_seal` func_brush.
- **Overview config** (`game/.../resource/overviews/warlock.txt`): pos_x -8192, pos_y 8192, scale 16, so 1024 px covers 16384 units.
- **Nothing reusable.** Takeaways: the playfield is a lava plane about 12000 units wide, and the hard boundary radius is 5910.

### 6.3 Arena algorithm (`warlockgen/arenagen.py` produces `tile_code.lua`, embedded verbatim as `Arena.LAYERS` in `base/arena.lua`)

**Constants** (`base/arena.lua`, `base/config.lua`, `base/mode.lua`):

```
ARENA_TILE_SIZE        = 192        -- world units per tile
ARENA_TILE_HEIGHT      = 32
ARENA_TILE_Z           = 42.5       -- tile origin (bottom); top at 74.5
ARENA_MAX_COORD        = 20         -- grid index range [-20, 20]
SHRINK_PERIOD          = 10 s       -- remove one layer every 10 s during combat
DAMAGE_PERIOD          = 0.25 s
DAMAGE_PER_SECOND      = 100        -- lava: 25 dmg per 0.25 s tick
DAMAGE_KB_POINT_FACTOR = 0.5        -- lava damage counts 0.5x toward knockback vulnerability
LAVA_MODIFIER          = modifier_phoenix_icarus_dive_burn (visual only)
Config.ARENA_RADIUS_PER_LAYER = 100
Config.ARENA_BASE_LAYER       = 13
Config.ARENA_LAYER_PER_PLAYER = 1
Config.ARENA_SPAWN_INSET      = 600
Config.GAME_ARENA_RADIUS      = 5910 -- hard wall (actor.lua)
Config.GAME_Z                 = 120  -- pawn height
Config.OBSTACLE_MAX_COORD     = 1000 -- obstacles spawn uniformly in [-1000,1000]^2
Mode.OBSTACLE_COUNT_MIN/MAX   = 2 / 8
Mode.SHOP_TIME                = 30 s
generator: tile_size=192, max_radius=2000, radius_step=100, Grid(20,20)
```

**Step 1: the tile set for a radius.**

```
tiles(r) = { (x, y) in [-20..20]^2 : (192x)^2 + (192y)^2 < r^2 }
```
The test is strict `<` and uses the tile *center*, so this is a pixelated disc.

The generator builds grids for r = 0, 100, 200, ..., 2000 (21 grids). I verified `Arena.LAYERS` reproduces exactly this cumulative set.

**Step 2: layer index ↔ radius.**
- Lua `current_layer` L (1-based) corresponds to grid index L-1, i.e. **radius = (L-1)*100**.
- L=1 is empty and L=21 is radius 2000.
- `setLayer` clamps to [1, 21] and walks the forward or backward deltas one step at a time.

| L | radius | tiles | max \|grid\| | half-extent (units) |
|---|---|---|---|---|
| 2 | 100 | 1 | 0 | 96 |
| 3 | 200 | 5 | 1 | 288 |
| 4 | 300 | 9 | 1 | 288 |
| 5 | 400 | 13 | 2 | 480 |
| 6 | 500 | 21 | 2 | 480 |
| 7 | 600 | 29 | 3 | 672 |
| 8 | 700 | 45 | 3 | 672 |
| 9 | 800 | 57 | 4 | 864 |
| 10 | 900 | 69 | 4 | 864 |
| 11 | 1000 | 89 | 5 | 1056 |
| 12 | 1100 | 101 | 5 | 1056 |
| 13 | 1200 | 121 | 6 | 1248 |
| 14 | 1300 | 145 | 6 | 1248 |
| 15 | 1400 | 177 | 7 | 1440 |
| 16 | 1500 | 193 | 7 | 1440 |
| 17 | 1600 | 221 | 8 | 1632 |
| 18 | 1700 | 241 | 8 | 1632 |
| 19 | 1800 | 277 | 9 | 1824 |
| 20 | 1900 | 301 | 9 | 1824 |
| 21 | 2000 | 341 | 10 | 2016 |

**Step 3: round lifecycle** (`base/mode.lua`):
- **Prepare / shop phase:**
  - Pick a random obstacle variation v (1..3) and set the platform type to v (tile texture v).
  - `setLayer(0)` clears everything (clamped to 1).
  - `setLayer(13+1=14)`, i.e. radius 1300 for the shop.
  - Spawn 2-8 random obstacles.
- **Round start:**
  - `setLayer(13 + playerCount*1)`, i.e. **radius = (12 + playerCount)*100**. Examples: 2p → 1400, 4p → 1600, 8p+ → 2000 (clamped at L=21).
  - Start auto-shrink: every 10 s, `setLayer(L-1)`, so the radius drops by 100 units every 10 s. The first shrink happens 10 s after start (the task's first fire is at `now + period`).
  - A full arena vanishes after (L-1)*10 s, e.g. 140 s for 2 players.
- **Spawns:**
  - radius = (13 + playerCount)*100 - 600, e.g. 2p → 900. Note this formula is 100 larger than the actual tile radius (L vs L-1). That is a quirk worth preserving or fixing consciously.
  - Team angle = 2π / activeTeamCount × teamId.
  - Teammates are offset by 0.2 rad × (index - (size-1)/2).
  - Spawn z = 120.

**Step 4: lava test** (`isLocationSafe`):
```
gx = floor(x/192 + 0.5); gy = floor(y/192 + 0.5)   -- nearest tile center
safe = |gx|<=20 && |gy|<=20 && tile(gx,gy) exists
```
- Collision uses the full **square** cell, not the rounded visual.
- Every 0.25 s, each pawn not on a safe tile takes 25 damage (`is_lava=true`, KB factor 0.5) and gets the burn visual.

**Step 5: hard wall** (`Actor:_arenaBoundsCheck`):
- If |pos| ≥ 5910, the position is clamped to the circle and the **radial velocity component is removed**. It is a slide, not a reflection.
- An `onArenaBoundCollision` hook fires.

**Step 6: tile removal animation** (`Arena:setTileStatus`):
- Logical removal is **immediate**: the tile counts as lava at once.
- Visually, the tile sinks 0.5 units every 0.05 s (10 u/s) from z=42.5 to 39.5 (3 units, about 0.3 s).
- Its render color goes from white to (255,128,128) via `c = 128 + 127*(z-39.5)/3`, i.e. it fades to red. Then it is destroyed.
- Added tiles pop in instantly.

**Step 7: corner styles** (visual only). `style` is an int:
- **yaw = (style % 4) × 90°**
- **model = floor(style / 4)** → 0 / 1 / 2 rounded corners

The patterns are checked in order, with offsets as (dx,dy) neighbors; the first match wins.

| style | set (must exist) | not_set (must be empty) | meaning |
|---|---|---|---|
| 8 | (+1,0) | (-1,0),(0,+1),(0,-1) | end cap, only the +x neighbor; round the 2 far (-x) corners |
| 9 | (0,+1) | (-1,0),(0,-1),(+1,0) | end cap toward +y; round the -y corners |
| 10 | (-1,0) | (+1,0),(0,+1),(0,-1) | end cap toward -x; round the +x corners |
| 11 | (0,-1) | (-1,0),(0,+1),(+1,0) | end cap toward -y; round the +y corners |
| 4 | (+1,0),(0,-1) | (-1,0),(0,+1) | outer corner; round (-x,+y) |
| 5 | (0,+1),(+1,0) | (0,-1),(-1,0) | round (-x,-y) |
| 6 | (-1,0),(0,+1) | (+1,0),(0,-1) | round (+x,-y) |
| 7 | (0,-1),(-1,0) | (0,+1),(+1,0) | round (+x,+y) |
| 0 | — | — | default: square |

(The comments in `arenagen.py` name the directions inconsistently. Trust the offsets.)

**Equivalent simple rule for the rebuild:** round a tile corner **iff both orthogonal neighbors adjacent to that corner are missing**; diagonals are ignored. The one exception is a fully isolated tile (all 4 neighbors missing), which stays square (style 0); that only happens at r=100. A "corridor" tile with two opposite open sides stays square under both.
- Corner radius ≈ 9.65 units, i.e. ≈ 0.05 × tile size.
- `Arena.LAYERS` stores per-step forward and backward deltas (add / remove / change-style), so styles of the remaining edge tiles are updated as the ring shrinks. In TS, just recompute the style of the changed ring plus its neighbors, or recompute everything (at most 341 tiles).

**Step 8: precomputation.** `arenagen.py` exists only because Lua runs on a Valve server. In TS, compute `tiles(r)` and the styles at runtime. It is cheap.

---

## 7. Fonts and misc

- **`warlockgen/Nunito-Regular.ttf`** (49,792 bytes). Name table:
  - "Copyright (c) 2011 by vernon adams"
  - License "SIL Open Font License, Version 1.1"
  - "Nunito is a trademark of vernon adams"
  - Version 1.000
- It is **OFL, so shippable** (keep the license, don't sell the font alone). Prefer the current Nunito variable font from Google Fonts / github.com/googlefonts/nunito (also OFL), which has more weights and glyphs. It was used only by `makeicon.py` for level digits.
- **Loading screen** (`panorama/layout/custom_game/custom_loading_screen.xml` + `styles/custom_game/warlockloadingscreen.css`): the BigGreenPepper art plus a Discord logo link. Recreate with original art.
- **Panorama UI** (XML/JS/CSS for the shop, scoreboard, camera, start selection) is custom code by the authors (unlicensed) and depends on `s2r://panorama/styles/dotastyles.vcss_c` (Valve). Use it as a **layout and feature reference** only.
- `warlockgen/warlockgen.py` plus `template_*.txt` / `base_npc_items_custom.txt` generate the KV ability and item definitions and localization from a spell table. These are useful as a data-schema reference.
- `resource/flash3/custom_ui.txt`: legacy Flash UI manifest. Irrelevant.

---

## 8. Localization

| Language | `resource/addon_<lang>.txt` (tooltips, ~462 keys) | `panorama/localization/addon_<lang>.txt` (shop/UI, ~112 keys) |
|---|---|---|
| English | 462 keys, UTF-16LE | 112 keys, ASCII |
| Russian | 436 keys, UTF-16LE | 107 keys, UTF-8 BOM |
| Simplified Chinese ("术士大战") | 462 keys, UTF-16LE | 112 keys, UTF-16LE |
| Brazilian Portuguese | 436 keys, **Latin-1** (mixed encodings) | 107 keys, UTF-8 BOM |

What the files contain:
- **resource:** Dota-style tooltip keys (`DOTA_Tooltip_ability_warlock_<spell>`, `_Description`, and stat labels like Damage/AoE/Force/Cooldown/Range/Collision radius), item tooltips, and team names. The team names are **Red, Blue, Teal, Purple, Yellow, Orange, Green, Gray, Light Blue, Dark Green**: 10 teams, matching `addoninfo` MaxPlayers 10.
- **panorama:** `WL_shop_ability_<spell>` plus `_description`, masteries, and UI strings.

**Reuse:** the text is the authors' copyrighted work (no license), though the one-line spell descriptions are short and functional. Options:
1. Ask for permission. It's easy since we're asking anyway.
2. Rewrite the descriptions and use the files only as the **key inventory** (which strings and stats exist per spell) and as a sanity check for translations.

Factual stat labels are not protectable. Brand names like "Warlock Brawl" (and the WC3 "Warlock" map name) should be cleared separately.

---

## 9. Replacement asset sources (shortlist; licenses as stated by the sources, so verify per pack)

| Need | Source | License |
|---|---|---|
| Characters (wizard/mage), rigged + animated | **KayKit** by Kay Lousberg (Adventurers / Dungeon packs include a mage), kaylousberg.itch.io | CC0 |
| Characters, props, rocks, animations | **Quaternius** (RPG Character Pack, Ultimate Modular/Animated Characters, Universal Animation Library, nature/rock packs), quaternius.com | CC0 (check each pack's license page) |
| Props, rocks, barrels, UI, particle sprites, audio | **Kenney** (Nature Kit, Dungeon/Castle kits, Particle Pack, UI Pack, Impact/Interface/RPG audio), kenney.nl | CC0 |
| PBR tile textures (stone slab, grass, dirt), lava, HDRIs | **Poly Haven** (polyhaven.com), **ambientCG** (ambientcg.com) | CC0 |
| SFX (spells, impacts, whooshes) | **Sonniss #GameAudioGDC bundles** (sonniss.com/gameaudiogdc) | Royalty-free, commercial use, no attribution, unlimited projects. Since 2024 the license forbids AI training and redistributing the raw files. Read the current EULA. |
| SFX | **freesound.org** | Per-file; **filter to CC0**. CC-BY needs credits; avoid NC. |
| SFX / music | **OpenGameArt.org** | Mixed (CC0 / CC-BY / CC-BY-SA / GPL); check each item |
| Spell / item icons (vector, recolorable) | **game-icons.net** (4000+ SVG icons; very good fit for spell slots) | **CC BY 3.0**: attribution required ("Icons made by {author}. Available on https://game-icons.net") |
| Painterly spell icons | OpenGameArt "Painterly Spell Icons" (J. W. Bjerk / eleazzaar) | CC-BY 3.0 / CC-BY-SA / GPL (pick one) |
| Fonts | **Google Fonts** (Nunito etc.) | SIL OFL 1.1 |
| Animations for any humanoid | Mixamo (Adobe account) | Free and royalty-free in games, but raw files can't be redistributed. Fine for a shipped game build, not for an open-source repo. |

**Practical recommendation:**
- Do VFX procedurally in WebGPU (glow sprites, ribbons, rings, distortion), using §5 as the color/timing spec and Kenney's CC0 particle sprites where needed.
- Build the arena procedurally (§6.3) with CC0 PBR textures plus an animated lava shader.
- Use game-icons.net for spell icons (with a credits screen) and KayKit or Quaternius for the warlock character.
- Source SFX from the Sonniss GDC bundles plus CC0 freesound.

---

## Appendix: files examined

- Images: 36 (3 tile textures, 1 overview, 2 panorama, 31 item icons) plus 1 TTF.
- Models: 9 SMD + 9 vmdl + 9 tile vmat + 1 overview vmat.
- Particles: 6 vpcf. Sound events: 1 vsndevts.
- Map: 1 vmap (binary DMX) + 1 vpk (17 entries, extracted to the scratchpad only for string inspection).
- Code: Lua under `game/dota_addons/warlock/scripts/vscripts/` (base, warlock/spells, projectiles, modifiers); KV under `scripts/npc`; `warlockgen/*.py`.
- Scratch tools I wrote (not from the repo): `scratchpad/tools/{parse_snd.py, parse_smd.py, vpk_list.py, arena_sim.py}`. Previews: `scratchpad/previews/`.
