# Wild: omens, reactions and a ruleset worth switching on

Status: design draft, 2026-10-28; picked for the build list 2026-10-29; the four choices answered
(README Q34–37); first deck built 2026-11-01, voice, library and bot combos 2026-11-02, not
released (see Built). From
[03-moonshot-v2.md](../03-moonshot-v2.md) Bet 5 and [04-keystones.md](../04-keystones.md).

The developer's reaction to Wild as first proposed: "I do love the general idea of Wild, even
though it probably needs some more flash to it to justify it." The first proposal (a lava tide,
three spell reactions, a mutator of the week) was a lab. This draft gives it a show.

## Built (2026-11-01)

The first deck as answered: Blood Moon, Slick Stone, Overcharge, Sudden Collapse, Meteor Shower
and Pillar Storm, with Shatter, Nova and Fork; custom lobbies only; scene effects only; no Second
Chance. Files: `src/sim/wild.ts` (the deck, the seeded draw, the round's numbers through
`kbMultiplierOf`, `frictionOf` and `cooldownRateOf`, the meteors and pillars), the reactions in
`src/sim/spells/lightning.ts` (Shatter, Fork) and `src/sim/spells/gravity.ts` (Nova),
`src/game/wild.ts` (names, rules, colours), `src/ui/hud/OmenHud.tsx` (the card, the badge, the
discovery card), the Wild group in match options, `src/render/vfx/spells/wild.ts` (ambient layers,
reaction flashes), the warned spots in `src/render/vfx/spells/rockpillar.ts`, the bots' threat
zones (`src/bots/threats.ts`) and the results' Omens list (the match record's `omens`).

Numbers the spec left open:
- Slick Stone: friction 0.975 (classic 0.96), as the daily's omen of the same name.
- Meteor Shower: the first meteor 3 s into the fight, then every 4.5 s, 0.3 s sooner each time,
  never under 2 s. Each is a level-3 Meteor on a spot within 220 of a random living warlock,
  neutral (an enemy to everyone); its hover is the telegraph.
- Pillar Storm: the first warning 4 s in, then every 5.5 s: 1.1 s of glowing cracks within 220 of
  a warlock, then a pillar (radius 90, 400 HP, 6 s) bursts out and shoves off whoever stands
  there, as a Rockpillar does; it explodes when broken like any pillar.
- Shatter: any Snowball the beam meets, yours too, breaks into four shards in a ±36° fan
  (650 u/s for 0.55 s, half its damage, 70% of its knockback, a 120 blast), owned by the
  Lightning's caster. Shards never shatter again.
- Nova: a Fireball within 70 of a Gravity orb's centre goes off, once per orb, as a blast of
  200–320 radius and 0.9–1.5 knockback by the two spells' levels, owned by the orb's caster.
- Fork: Lightning stopped by an enemy Shield (not Alteration, which blocks it the same way)
  splits into two beams from the shield holder, back the way it came at ±25°, 60% damage. Forks
  never fork again.
- A neutral hit credits nobody: a knockout after a meteor goes to the last warlock who hit, as
  after a pillar's blast.

Changes from the spec:
- The omen is drawn when the shop before its round opens, and the badge shows it while players
  shop (Blood Moon or Overcharge can change a build); the card still turns over in the countdown.
- The announcer calls the omen after the round ("Round Two!", "Meteor Shower!"; pack 10 in
  `docs/ASSETS.md`) over a synthesized sting per omen (`omenSting`). No looping ambience: the
  omens that would want one (the Maw) are not in the deck.
- The discovery card shows once per reaction per browser; the Spell library lists the three
  reactions, the unseen ones as "???" with the two spells that make them.
- Bots read the numeric omens through the shared helpers and flee meteors and warned pillar
  spots. Those with a combo chance (Hard and up) Lightning a Snowball whose shards would fly into
  an enemy and send a Fireball into their own Gravity orb beside one.
- Browse games marks a Wild room ("· Wild").

Bot-only runs (2026-11-02, How it would be tested 1 and 2): six bots (two each of Medium, Hard
and Brutal), free for all, 200 rounds per condition, the omen forced every round:

| Condition | First knockout (median s) | Round (median s) | Deaths in the round's first half | Brutal seats win | Nova / Shatter per round |
|---|---|---|---|---|---|
| Classic | 89 | 158 | 9% | 48% | – |
| Blood Moon | 69 | 151 | 15% | 61% | 0.20 / 0.01 |
| Slick Stone | 67 | 150 | 17% | 57% | 0.17 / 0.01 |
| Overcharge | 74 | 154 | 14% | 57% | 0.38 / 0.03 |
| Sudden Collapse | 50 | 72 | 3% | 59% | 0.09 / 0 |
| Meteor Shower | 74 | 152 | 13% | 55% | 0.13 / 0.03 |
| Pillar Storm | 82 | 161 | 11% | 52% | 0.15 / 0.01 |

Every omen brings the first knockout earlier; Pillar Storm only a little, and more or nearer
pillars made rounds longer (they are cover), as did a shove when one bursts: bots step off the
warned spots. The stronger tier wins more under every omen (Blood Moon most). Fork never happens
between bots (they never buy Shield) and Shatter seldom; both are under the spec's one-a-round
line, so the playtest decides whether they stay. Reproduce with `npm run bots:wild -- 200`
(`scripts/bots/wild.ts`, about two minutes).

Not built yet: Wild Hours (after the playtest), the moments engine naming each omen's best play.
Checked in a muted headless browser: the lobby deck, the card above the shop in the countdown, the
badge, Meteor Shower and Pillar Storm in a match against bots, the results' omens, and each omen's
scene effect in the render preview.

## The idea in one paragraph

Wild is the classic game with an **omen** over every round. At the countdown a card turns over in
the middle of the screen, the announcer calls its name, the arena shows it, and for one round the
world has one new rule: a blood moon that makes every hit push harder, meteors falling from the
sky, a lava tide that breathes in and out, pillars bursting out of the floor. Next round, a new
omen. On top of that, a handful of spell reactions work only in Wild: Lightning shatters a
Snowball, a Fireball pulled into a Gravity orb goes nova. Classic stays exactly classic; Wild is
the same game turned up, for an evening, a playlist slot or a custom lobby.

Why omens give it the flash a lab lacks: each round becomes an event with a name, the variety is
visible in the first five seconds, and every omen is chosen to make knockouts happen earlier
(the measured problem: most deaths come late, in the last rings of the shrink).

## The omen deck (v1 candidates)

Every omen is one rule for one round, readable from its card in a second. Feasibility is on
today's arena model (one layer number); none needs the tile refactor.

| Omen | Rule for the round | What players see | Sim feasibility |
|---|---|---|---|
| **Blood Moon** | Knockback ×1.5 | A red moon over the caldera; hits leave red streaks | Easy: the knockback formula already takes a multiplier (`src/sim/combat.ts:50`) |
| **Meteor Shower** | Neutral meteors fall on telegraphed spots every few seconds, more as the round goes on | Burning shadows grow on the floor, then impact | Medium: neutral owners already exist (`NEUTRAL_OWNER`, enemy to everyone, `src/sim/teams.ts:38`); Meteor's sim and VFX exist; bots already flee Meteor landing spots (area threats) |
| **The Maw Breathes** | Besides the normal shrink, the outer ring sinks for 3 s every 12 s and rises again | The lava heaves, the ring sinks with a groan and rises steaming | Medium: the layer goes down and back up; render already animates rings sinking and rising; bots need the tide in their edge lookahead |
| **Pillar Storm** | Pillars burst out of the floor at telegraphed spots mid-fight, and explode when broken | Cracks glow, then a pillar erupts and throws anyone on it | Easy to medium: Rockpillar already pushes obstacles mid-fight (`src/sim/spells/rockpillar.ts`) |
| **Slick Stone** | Friction lowered for the round: every slide goes further | A wet sheen on the tiles; longer skid marks | Easy: friction is one value read per tick (`src/sim/index.ts:287`) |
| **Overcharge** | Every cooldown runs at double speed | Hands and staffs crackle; cooldown sweeps race | Easy: one factor in the cooldown tick |
| **Volatile** | Every knockout explodes like a pillar (radius 300) | The body flashes white before it goes | Easy to medium: a death hook spawning the existing pillar explosion |
| **Hunter's Moon** | The leader is marked; knocking them out pays a bounty | A mark over the leader's head | Easy: bounties exist (`src/sim/bets.ts`) |
| **Sudden Collapse** | The arena shrinks every 4 s | Tiles pulse faster, the rumble never stops | Easy: the shrink period |
| **Second Chance** | The first warlock to fall in the round returns once, with half health, at the next shrink | A ghostly flame rises from the lava | Medium: a scheduled respawn, as in respawn modes |

The deck draws one omen per round from the match seed (deterministic, the same on every client),
never the same omen twice in a row, and no omen in the first round of a match so players get one
plain round to settle in. Ten omens, five rounds of a faster casual match: each match feels
different.

## Spell reactions (Wild only)

Reactions are the second layer: rules between spells, not per round. Three to five, each readable
and each scaled by the level of the spells involved, so a level-1 reaction is small (the tame
level-1 rule).

| Reaction | Rule | Notes |
|---|---|---|
| **Shatter** | Lightning hitting a Snowball breaks it into four ice shards in a fan | Like Lightning detonating a Fireball today (`src/sim/spells/lightning.ts`), a named check in one place |
| **Nova** | A Fireball pulled into a Gravity orb's core detonates as a ring blast | Gravity already bends projectiles; the reaction adds the detonation |
| **Lava Wave** | A Meteor landing in lava throws a wave that pushes warlocks near the edge outward | Uses the landing point's lava test |
| **Fork** | A Lightning reflected by a Shield splits into two beams | Shield reflection already exists |
| **Slingshot** | Link plus Gravity flings the linked warlock past the caster | Optional; hardest to read |

Each reaction gets a discovery card the first time a player sees it ("Shatter! Lightning breaks
Snowballs into shards"), and the Spell library gains a Reactions page that fills in as you see
them.

## Presentation (the flash)

- **The omen reveal.** During the 3-2-1 countdown a card turns over in the middle of the screen:
  the omen's sigil, its name and one line of rule. The announcer calls the name. The card shrinks
  into a small badge beside the round counter for the rest of the round.
- **The arena shows it.** Each omen has an ambient layer: a red moon disc in the sky, falling
  embers before a Meteor Shower, a wet sheen for Slick Stone, crackling hands for Overcharge.
  These are effects in the scene, not a relight: the approved arena lighting stays as it is. Any
  change of the sky's or fog's color is a separate question for the developer.
- **Sound.** A short sting per omen under the announcer call; a looping ambience where it fits
  (the Maw's breathing, the meteor whistle).
- **Results.** The results screen lists the match's omens and who won each round under which
  omen; the moments engine ([moments.md](moments.md)) can name the best play of each omen.

## Where Wild lives

- **Custom lobbies**: a Wild switch in match options, with the omen deck shown and each omen
  toggleable.
- **Wild hours, not a Wild queue.** The population cannot fill two casual queues. Instead, the
  casual queue turns Wild at announced times (for example Friday and Saturday evenings, EU and US
  prime time), shown in the menu with a countdown ("Wild Hour in 2 h 14 min"). Time-boxed events
  concentrate players and give a reason to come back at a time.
- **Never ranked, never the classic default.** Competitive Smash plays with hazards off; ranked
  Warlock players will want the same.

## Bots

Bots fill nine seats in ten, so every omen and reaction needs bot support or it is invisible:

- Blood Moon, Slick Stone, Overcharge, Hunter's Moon, Sudden Collapse: bots read the changed
  numbers through the same helpers (knockback forecast, slide forecast with the round's friction,
  cooldowns), so mostly free.
- Meteor Shower, Pillar Storm, Volatile: telegraphed spots join the bots' area threats
  (`src/bots/threats.ts`).
- The Maw: the tide joins the edge and shrink lookahead (`safetyLayer` in `controller.ts`).
- Reactions: Hard and up learn to use Shatter and Nova as combos, as they already detonate
  Fireballs with Lightning (`comboChance`).

## How it would be tested

1. **Bot-only frequencies**: per omen, the first knockout time, round length and deaths before
   the late shrink, against classic rounds. An omen that does not bring knockouts earlier, or
   that one tier wins far more often, is cut or retuned.
2. **Reaction frequency**: reactions per round in bot-only and in playtests; under about one a
   round, a reaction is invisible and gets cut.
3. **One playtest evening** of Wild in a custom lobby: after each round, can players name the
   omen and say what it did? Which omens do they want again?
4. **A first Wild Hour** in casual, compared with ordinary casual hours on matches finished,
   abandonment and returns.

## What it costs, roughly

- The omen framework (deck, seeded draw, a round hook, the event, the reveal card, the badge):
  about a week.
- Each easy omen: a day or two including its ambient effect and sting; medium ones (Meteor Shower,
  The Maw, Second Chance): about a week each with bot support.
- Each reaction: a few days including VFX at the project's bar and bot use.
- A first deck of six omens and three reactions is about a month of focused work, mostly
  presentation.

## Choices for the developer

1. **Which omens** make the first deck (the table is a menu, not a list to build whole).
   Recommended six: Blood Moon, Slick Stone, Overcharge and Sudden Collapse (easy, each a
   number the bots already read), Meteor Shower and Pillar Storm (the most visible). Reactions:
   Shatter, Nova and Fork.
2. **Wild Hours** in the casual queue at fixed times, or Wild only in custom lobbies at first.
   Recommended: custom lobbies first, for the playtest evening; Wild Hours after it.
3. **Sky and fog tints** per omen (a lighting change), or scene effects only. Recommended: scene
   effects only, since the arena lighting is approved.
4. **Second Chance**: too swingy for casual, or the most exciting omen in the deck. Recommended:
   out of the first deck; tried in a custom lobby later.
