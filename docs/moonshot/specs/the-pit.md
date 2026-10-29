# The Pit: the fallen keep fighting

Status: **parked**, 2026-10-29. The developer: "the pit is not yet clear or convincing to me."
Kept as a draft. It returns only if the dead-time trigger below still holds after faster casual
rounds and shopping while out ([shop-ready.md](shop-ready.md) Part 2), which already give a
knocked-out player something to do. From [00-moonshot.md](../00-moonshot.md) Bet 2 and the red team's
[triage](../02-red-team.md#triage) (deferred behind a dead-time measurement).

The developer liked it ("I love the gulag"). The precedent is Warzone's Gulag: the eliminated
fight a duel while the match goes on, with a prize for the winner
([research/frontier.md](../research/frontier.md) §2).

## The problem it answers

In a ten-warlock round the first knockout watches for about two minutes today (bot-only rounds
last about three minutes, the first death comes after about a minute). Faster casual rounds
([faster-casual.md](faster-casual.md)) shrink that wait; the Pit fills what remains. The trigger in
[05-roadmap.md](../05-roadmap.md) §4 stands: build it if, after faster rounds, humans still spend
more than 40% of fight time dead or leave while dead.

## How it plays

- **Winner stays on.** The first two warlocks to fall drop into the Pit, a small ring of rock
  beside the caldera, and duel. The winner stays; whoever falls next in the main fight drops in as
  the next challenger. A Pit champion can hold it through several challengers, and their streak
  shows.
- **Short duels.** The Pit is small (a few tiles across) and its edge sinks steadily, so a duel is
  over in about 30 s at most.
- **Your own build**, cooldowns reset and knockback points cleared on entry, full health. The
  shop work you did still matters.
- **Bots too.** Fallen bots enter the Pit like anyone else, so a lone human always has someone to
  duel. This is what makes it work at a population of one.
- **The round ends, the Pit ends.** Whoever holds the Pit when the round is decided is the Pit
  champion.

## The prize

The Gulag's lesson is to cap the swing: its spectator rocks did a single point of damage and
still broke duels. Options, from flavor to swing:

| Prize | Effect | Swing |
|---|---|---|
| **Pit gold** | Each Pit win pays a little gold (for example 2), the champion a little more | Small: shop money, like kill gold |
| **The Pit Crown** | The champion starts the next round crowned: a visible mark, a line from the announcer, a stat | None: glory only |
| **Revenge** | The champion's own killer is marked next round; knocking them out pays double kill gold | Small, personal, readable |
| **Second Chance** | The champion returns to the main fight at the next shrink with half health | Large: can decide a round |

Recommendation: Pit gold, the Crown and Revenge in casual; Second Chance only as a Wild omen
([wild.md](wild.md)), where swings are the point.

## Presentation

- **The fall.** A knocked-out warlock's death plays as today; a beat later the screen washes to
  ash and they land in the Pit with a thud. A plate reads "The Pit" with the current champion's
  name.
- **The Pit itself.** A small ring of scorched stone in a side cavern, its own rim of lava,
  torches, a ring of ambient spectators (generated, as the arena crowd would be; never posing as
  people).
- **The main fight stays in view** through the top bar, the kill feed and the announcer. A
  picture-in-picture view of the main arena is a later option: it is a second scene render and
  costs frames.
- **When your Pit run ends** you return to spectating the main fight as today, betting included.

## Two ways to build it

**A. Zones in the one simulation.** The Pit is a second safe area in the same `SimState`, placed
far enough from the caldera that no spell range crosses (centre about 4,600 units out, inside the
outer wall at 5,910; Teleport's longest range is 1,190). Pawns and projectiles carry a zone, and
collision, area damage and targeting only see their own zone.

- For: one stream, one replay, nothing new in the netcode.
- Against: every spell that searches for warlocks (Homing, Bouncer, Drain, Gravity, Link,
  Magnetize, area blasts, Swap) must learn zones, and one missed site lets a spell reach across.
  Bots key their safety on the arena layer and would need Pit awareness. The tile model is not
  needed (the Pit's floor is a second circle test), but the render's arena grid stops at radius
  2,000, so the Pit needs its own small floor mesh.

**B. A second simulation in the room.** The room runs a small Pit match beside the main one: its
own `SimState`, stepped in lockstep, fed the inputs of whoever is in the Pit.

- For: the classic sim is untouched; every spell and bot works unchanged, because a Pit is just a
  tiny match. The renderer already swaps sources (`src/render/source.ts`), so the client draws
  whichever simulation its player is in.
- Against: the input stream, prediction, keyframes and replays must carry two simulations; the
  Pit's result reaches the main match as a command at the next round start; swapping the scene
  between two arenas needs a transition so the rebuild does not hitch.

**Recommendation: B.** It keeps the faithful sim and every bot untouched and moves the work into
the netcode, where it is contained and testable. Estimate: three to six weeks.

## A cheap test before either

The Pit's fun can be tried without any netcode: in **offline** matches, a fallen player drops into
a local Pit duel against a bot, using the practice loop that already runs local matches
(`src/game/practice.ts`). A week of work, playable by anyone solo, and it answers the real
question: do people enjoy the Pit more than watching?

## Rules to pin down in the spec

- Order and fairness: who enters first when two warlocks fall on the same tick (lower player id,
  as elsewhere), and what happens when a Pit duel is running and three more fall.
- Disconnects and bot takeovers inside the Pit.
- Teams and Shuffle: is the Pit free-for-all even in team modes (recommended: yes, it is a side
  game).
- King of the Hill and respawn modes: no Pit (they already respawn).
- Ranked: no Pit.
- Spectator bets: still placeable from the Pit's HUD.
- Stats: Pit wins and streaks are their own counters, never merged into kills.

## Choices for the developer

1. **The prize** (table above).
2. **Build A or B** (recommended B), after the offline test.
3. **Where the Pit lives first**: offline only, casual, or as a Wild feature.
4. **Picture-in-picture** of the main fight, or the top bar and kill feed only.
