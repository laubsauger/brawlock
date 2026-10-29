# Shop Ready: the shop ends when everyone is done

Status: **built 2026-10-29**, shipped in alpha.17, with Part 2 (shopping while out, round gold at the
knockout). Where the build differs from the first draft, this file says what was built and why. From [03-moonshot-v2.md](../03-moonshot-v2.md) Bet 1 and
[04-keystones.md](../04-keystones.md) Keystone 1 ("Ready ends the shop"). Shipped ahead of
[faster-casual.md](faster-casual.md), which is not built yet.

The developer (2026-10-28): "I do love the idea of having a ready button that lets the round start
when everyone is ready. I don't think it would happen often because people struggle with the bit
of time that is there, but it is still a great feature to have. So we should have that."

## Why

- The shop is a fixed timer: `shopSeconds` (25 s, `src/sim/config.ts:201`) before every round,
  15 s before a ranked final (`RANKED_FINAL_SHOP_SECONDS`, `config.ts:72`). Nobody can shorten it.
  A player alone against bots waits the full 25 s even with nothing left to buy.
- Shops are a large share of a short match. In the pace harness (scratch run on 2026-10-28, see
  [faster-casual.md](faster-casual.md)) the recommended casual preset runs 9.0 minutes p50 with
  full shops; with every shop at 12 s it runs 7.9 minutes (p90 9.2), at 6 s 7.2 minutes.
- Bots are done long before the timer. Last purchase after the shop opened, eight bots of one tier,
  six seeds, first four shops: Hard, Brutal and Uber p90 1.7 s, Medium p90 2.1 s, Easy p50 2.6 s,
  p90 and max 5.4 s. Bots spent their gold in every shop length tried, 6 s included (about 4 gold
  left at fight start in every scenario).
- The developer expects Ready to be used rarely. The pace targets therefore do not depend on it
  (faster-casual.md meets them with full 25 s shops); Ready lowers the floor for players who are
  done, most of all a player alone with bots.

## What the player sees

- **The button.** In the shop header, next to the round clock (`ShopClock`,
  `src/ui/hud/Shop.tsx:121-140`, placed at `Shop.tsx:400`), a Ready button. Pressing it marks you
  ready; pressing it again takes it back. A rebindable key does the same ("Ready" under Settings >
  Controls > Interface), so a player who closed the shop with B does not have to reopen it.
- **Who is ready.** With two or more humans who count (Rule 2), a count beside the button
  ("2/3 ready") and a check mark on each ready human's pill in the top bar. The pills show it to
  everyone, including spectators, benched players and the replay viewer. With one human the count
  is hidden: "1/1" says nothing.
- **The countdown.** When the last human readies, a toast says "Everyone is ready" (a toast, not a
  banner: the 3-2-1 banner starts on the same frame), the shop clock and the top clock jump to the
  new time, the button locks, and the existing 3-2-1 and round
  call ("Round Two!", "Final Round!") play as they do today. The new time is 3 s, but never earlier
  than 6 s after the shop opened (Rule 5).
- **Not shown** to spectators, to players benched for a ranked final, to a player whose seat is
  reserved until the fight ends, in the guided lesson (the shop shows "Practice · no timer"), in
  replays, and outside the shop phase. Bots never hold the shop up.

## Rules

Constants in `src/sim/config.ts` beside `ROUND_END_SECONDS` (line 106), in seconds and converted
with `ticks()` at the use site: `SHOP_READY_SECONDS = 3`, `SHOP_READY_MIN_SECONDS = 6`.

1. **Command.** `{ kind: 'shopReady'; ready: boolean }`. Valid only with exactly these two keys and
   a boolean `ready`; anything else is dropped by the sim (`validCommand`) and by the host
   (`sanitizeCommand`). It is idempotent: a resent or duplicated command changes nothing.
2. **Ready seats.** A player counts, and may send the command, when all of these hold:
   the phase is `shop`; the seat's `slot.kind` is `'human'`; its `PlayerScore.connected` is true;
   and `isRoundParticipant(state, player)` (`src/sim/teams.ts:58-60`). So bots, human seats driven
   by a replacement bot (a leaver with `botsReplaceLeavers`), disconnected humans and players
   benched for a ranked final never count: for the rule they are always ready. Spectators and
   seats reserved until a fight ends cannot send input at all (the host drops it,
   `src/net/session.ts:1295`).
3. **Applying.** An accepted `ready: true` adds the player to `state.shopReady` (ascending, no
   duplicates); `ready: false` removes them. A command from anyone else, or outside the shop phase
   (round end, fight, a dead player shopping in a respawn mode), is ignored: no state change, no
   event. Commands apply in the sim's input order (by player, then tick stamp), before the phase
   timer of the same tick.
4. **All ready** holds when at least one seat counts and every counted seat is in `shopReady`.
   With no counted seat (bot-only matches: the menu backdrop, test and ladder harnesses, a room
   whose humans all left) the shop runs its full time, as today.
5. **The cut.** Each tick in the shop phase, after commands, connection patches and roster
   changes and before the timer counts down, if all ready holds:
   `target = max(ticks(SHOP_READY_SECONDS), ticks(SHOP_READY_MIN_SECONDS) - elapsed)`, where
   `elapsed = shopLength - phaseTicksLeft` and
   `shopLength = ticks(rankedFinal ? RANKED_FINAL_SHOP_SECONDS : shopSeconds)` (the value
   `prepareForRound` set). If `phaseTicksLeft > target`, set `phaseTicksLeft = target`
   and emit `{ type: 'allReady'; saved }` with the ticks removed.
6. **Never longer.** The cut only shortens. A shop already at or under the target (a custom
   `shopSeconds` of 6 or less, the last 3 s of any shop) is untouched. The cut is final: an
   un-ready, a reconnect or a new human after it does not restore time, and `allReady` fires at
   most once per shop (after a cut, `phaseTicksLeft` stays at or under the target).
7. **Un-ready** is allowed for the whole shop phase. It matters only before the cut; the UI locks
   the button once the cut has happened or 3 s or less remain. Precedent: the lobby Ready toggles
   (`src/ui/screens/Lobby.tsx:544-545`).
8. **Clearing.** `startRound` deletes `state.shopReady` and `state.shopCut` (the cut marker, so
   the cut happens at most once a shop and the HUD can lock the button); the list is created by
   the first Ready, in the shop or while out (Rule 14). A roster change that gives a seat a new occupant (its
   `kind` or `profileId` differs, `src/sim/roster.ts:6-11`) removes that id: a new occupant never
   inherits consent, the rule the lobby already follows (`src/net/session.ts:1201`). A disconnect
   keeps the entry; while disconnected the seat does not count, and a returning player is still
   ready.
9. **Seats taken over mid-shop.** A human who takes a bot's seat (or an open seat) during the
   shop counts from the next tick and is not ready, so they get the time they need (they also get
   the full Fresh start refund that shop). If the cut already happened, it stands (Rule 6). A
   human who leaves mid-shop stops counting at once; if everyone left is ready, the cut fires on
   that tick.
10. **Modes.** Rounds: every shop. Deathmatch: the one shop before round 1. King of the Hill,
    rounds style: every shop; respawn style: the opening shop only (its shop stays open during the
    fight, where Ready does not exist). Ranked: every shop including the final's preparation
    shop, where only finalists count. Custom `shopSeconds`: any value, Rule 6 applies.
11. **Offline and practice.** Offline matches (`role: 'offline'`) work as above: the local human is
    the only counted seat. The guided lesson cannot be cut: it drops every command but its lesson
    command (`src/game/practiceScenario.ts:77-83`), forces `phaseTicksLeft = 2` each tick
    (line 75), and 2 ticks is under every target. Its shop shows no button.

## Design

| Layer | File and seam | Change |
|---|---|---|
| Sim types | `src/sim/types.ts:141-150` `InputCommand` | add `{ kind: 'shopReady'; ready: boolean }` |
| | `src/sim/types.ts:477-499` `SimState` | add `shopReady?: PlayerId[]` (humans who pressed Ready for the coming fight, ascending) and `shopCut?: boolean` |
| | `src/sim/types.ts:374-475` `SimEvent` | add `{ type: 'allReady'; saved: number }` (ticks removed from the shop) |
| Sim rules | `src/sim/config.ts:105-106` | the two constants |
| | `src/sim/shop.ts` | `canReady(state, player)`, `setShopReady(state, player, ready)`, `allReady(state)`, `shopLength(state)`, `readyCut(state)` and `shopReadyView(state, player)` for the HUD: `{ shown, can, mine, ready, total, starting }` |
| | `src/sim/pawn.ts:83-114` `applyCommand` | `case 'shopReady': setShopReady(...)` |
| | `src/sim/index.ts:160-183` `validCommand` | `case 'shopReady': Object.keys(cmd).length === 2 && typeof cmd.ready === 'boolean'`; export `shopReadyView` |
| | `src/sim/mode.ts` `prepareForRound` | uses `shopLength(state)`, and runs `readyCut` as the shop opens, so a shop everyone readied for while out opens already cut and its banner shows the real time |
| | `src/sim/mode.ts` `startRound` | `delete state.shopReady`, `delete state.shopCut` |
| | `src/sim/mode.ts:394-400` `phaseTick` | before the shop/roundEnd branch: `if (state.phase === 'shop') readyCut(state)` (Rule 5) |
| | `src/sim/roster.ts:6-11` | drop the id from `shopReady` when the occupant changes (Rule 8) |
| Net | `src/net/protocol.ts:323-367` `sanitizeCommand` | `case 'shopReady'`: exactly two keys, boolean `ready` |
| | `src/net/protocol.ts:70` | `PROTOCOL_VERSION` 9 → 10 (see netcode below) |
| | `src/net/predict.ts:64` `AUTHORITATIVE_EVENTS` | add `'allReady'`: the banner plays from the authority only, as `phase` does. A client that predicts its own last Ready sees the clock move with prediction and the banner on confirmation |
| HUD | `src/ui/hud/shopView.ts:7-52` | `ShopView.readyState` from `shopReadyView` |
| | `src/ui/hud/Shop.tsx:388-404` header | `ShopReady` button and count beside `ShopClock`; hidden with `guidedSpell` |
| | `src/ui/hud/Shop.tsx:121-140` `ShopClock` | `data-cut` written from the rAF after a cut |
| | `src/ui/hud/TopBar.tsx:172-209` `useScoreRefs` | write `data-ready` on the pill root (`ScorePill` line 211, `BroadcastSide` line 237) from the rAF, as `data-out` is written; a check glyph styled from it |
| | `src/ui/hud/Hud.tsx` `onBatch` | `case 'allReady'`: toast and `sfx('ready')`; `src/audio/events.ts` lists the event as handled by the HUD |
| | `src/ui/lib/keys.ts:10-31, 72-80` | a `shopReady` bind action in the Interface group; the key handler issues `{ kind: 'shopReady', ready: !mine }` only when `can` |
| Render | `src/render/scene/MatchWorld.ts` | done earlier (commit 4d86f85): the shop ward eases over `ticks(3)` instead of a 180-tick literal |

The button sends through `input.issue` (`src/game/input.ts:48`), like Fresh start
(`Shop.tsx:471`). No session, dedicated-room or server code changes: the host steps the command
like any other input, P2P and dedicated alike, and the P2P host's own Ready takes its usual
fairness delay.

### Audio and announcer

The local toggle plays the Button sound the lobby uses (`'ready'` on, `'back'` off). `allReady`
plays the existing `'ready'` cue with its toast. No new announcer voice line: the countdown call
already fires at 3 s (`src/game/announcer.ts:532-538`) and the HUD's 3-2-1 at `Hud.tsx:167-176`,
both from `phaseTicksLeft`, so they follow the cut without change.

### Replays and spectators

The command rides the confirmed input stream, so the recorder stores it like any other
(`src/game/replay/format.ts`: commands in `encodeCmd`'s object form, no format change), and a
replay reproduces the cut tick for tick. Snapshot spectators receive `shopReady` in the state. The
replay viewer and spectators see the pill marks, never the button.

### Netcode id

The change touches `src/sim` and `src/net`, so `scripts/net-id.mjs` produces a new id: clients of
the old build cannot join new dedicated rooms, and replays recorded before the release do not play
on it, as with every sim change. Bump `PROTOCOL_VERSION` as well: `sanitizeCommand` passes unknown
kinds through, so a stale P2P tab hosting for a new client would put `shopReady` into its stream,
ignore it in its own sim, and heal the client by keyframe every second. The version check at
`src/net/session.ts:1085` turns that into a clear "reload" message instead. Faster casual changes
the id in the same batch; one bump covers both.

## Part 2: shopping while out

The developer, 2026-10-29: "maybe we do actually allow players to already start buying stuff in
the shop while they are dead and waiting for the next round", then "maybe we should get gold in
the moment then?"

**It already exists, and almost nobody can use it.** Since 2026-10-15 a knocked-out warlock may buy
(`SHOP_RULE = 'shopPhaseOrDead'`, `src/sim/config.ts:159`; `canBuy`, `src/sim/shop.ts:45-51`;
[PLAN §2](../../PLAN.md)), bots already do (`src/bots/controller.ts:404`), and the shop clock says
"You are out: buy for the next round" (`src/ui/hud/Shop.tsx:132`). Two things make it empty:

- **No gold.** The round's gold is paid at round end (`endRound`, `src/sim/mode.ts:335`), and
  warlocks spend almost all of their gold before the fight (about 4 gold left at fight start, see
  [faster-casual.md](faster-casual.md) finding 8). A warlock who is out holds about 4 gold plus
  any kill gold, which buys nothing.
- **Nobody sees it.** The shop opens itself only in the shop phase (`Hud.tsx` `onPhase`); a player
  who was out had to know to press B.

**The time is there.** Bot casual tables (32 matches each, [research/casual-pace.ts](../research/casual-pace.ts)):
a knocked-out warlock waits for the round to end for 38 s at the median today (p90 105 s), and
20 s (p90 46 s) in the 5-round casual preset. A fifth of all fight time is spent out. The 25 s
shop could be mostly done by then.

### Rules

12. **Round gold on knockout.** In modes where a knocked-out warlock stays out until the round
    ends (Rounds, Teams and Shuffle, King of the Hill rounds style, ranked and its final), the
    warlock's `roundGold` is paid at the knockout instead of at round end. The amount is the same
    for everyone and does not depend on the round's outcome, so nothing is decided early.
    `endRound` pays it only to the players not yet paid this round: survivors, benched finalists,
    and players without a pawn. Win gold stays at round end (in team modes it goes to dead
    teammates of the winning team too). Respawn modes (Deathmatch, King of the Hill respawn
    style) change nothing: their deaths are not "out".
13. **Once per round.** `PlayerScore.roundPaid?: boolean`, set when paid, cleared by `endRound`
    when it skips that payment. A draw (everyone out) pays each at their knockout and nobody again at round end.
    A warlock who joins between rounds is paid as today (`src/sim/roster.ts:19`).
14. **Ready while out.** A knocked-out player may send `shopReady` during the fight. Rule 2 counts
    them from the moment they are out; Rule 3 accepts it. `state.shopReady` then lives from the
    first knockout of the fight to the next `startRound` (Rule 8 changes: `prepareForRound` keeps
    the list instead of clearing it). The cut follows Rule 5 from the shop's first tick, so when
    every counted human readied while out, the shop lasts 6 s (the floor) instead of 25 s.
15. **Unchanged:** Fresh start stays between rounds only (`freshStartRefund`, `shop.ts:77`);
    nothing bought while out touches the current fight (the pawn is out); a spectator bet still
    costs its 1 gold stake, which the earlier gold now always covers.

### What the player sees

- **The knockout card offers the shop**: "Shop for the next round" with the shop key, under
  "Watching the rest of the round" (`src/ui/hud/DeathFeedback.tsx`). The card hides while the shop
  is open; the shop's clock reads "Out: buy for next round".
- **Why not open the shop by itself** (the first draft): a headless check showed it covers the
  spectator bets (the bet panel hides while any panel is open) and the card's docked corner. The
  knocked-out player is the one with time to bet, so the shop waits for a click or B.
- **The gold** arrives at the knockout and shows with the existing gold delta.
- **Ready** sits in the shop header as in the shop phase; the top bar's check mark appears when
  the shop phase starts (Rule 14).

### Design additions

| Layer | File and seam | Change |
|---|---|---|
| Sim | `src/sim/types.ts` `PlayerScore` | `roundPaid?: boolean` |
| | `killPawn` (`src/sim/combat.ts:110`, where kill gold is paid) | pay `roundGold` to the victim's score when the mode keeps them out (Rule 12) |
| | `src/sim/mode.ts` `endRound` | skip and clear scores with `roundPaid` |
| | `src/sim/shop.ts` | `readySeat` accepts a knocked-out round participant during the fight (Rule 14) |
| | `src/sim/mode.ts` `prepareForRound` | keep `shopReady`; `startRound` still deletes it |
| HUD | `src/ui/hud/DeathFeedback.tsx` | the knockout card's shop button, shown from the rAF while the local player is out, can buy and the shop is closed; the card hides while the shop is open |
| Bots | none | bots already buy while out; they now have the gold to |

`LADDER=1 npx vitest run src/bots/ladder.test.ts` at 30 and 60 Hz: bot buys move from the shop
phase into the fight, which can shift seeded outcomes though not strength.

### Tests (added to `shopReady.test.ts`)

11. *The out are paid when they fall.* A Rounds match: a warlock knocked out at 20 s holds
    `roundGold` more gold at once, and the same total after round end as today.
12. *Nobody is paid twice.* A draw pays each warlock once; a survivor is paid at round end only.
13. *Respawn modes do not change.* A Deathmatch death pays no round gold.
14. *Out and ready.* Two humans, both out and ready during the fight: the next shop lasts
    `SHOP_READY_MIN_SECONDS`.
15. *The outcome stays hidden.* Win gold still arrives only with `roundWin`.

**PLAN §2** gains to the existing shop row: "the round's gold is paid at the knockout to a warlock
who stays out until round end (the original paid everyone at round end)."

## Out of scope

- A Ready in the round-end pause, the lobby (it has its own) or the results screen.
- Voting to extend the shop, or a host override.
- Bots that wait for humans, or bot readiness in the sim: bots always count as ready.
- Telling players who is holding the shop up beyond the pill marks (no names in a banner, no
  nudges): the developer's concern is that people already feel the time is short.
- Analytics storage. The `allReady` event carries `saved`, so the pace instrumentation
  (Keystone 1, test 1) can sum seconds saved per match when it lands.

## Acceptance

Run the new and touched suites at both rates (`npx vitest run <files>` and
`TICK_HZ=60 npx vitest run <files>`), and `npm run lint:invariants` (new rAF hooks, and the
render tick literal replaced). No ladder run: bot code does not change.

Sim, `src/sim/shopReady.test.ts` (new). Each test says why the behavior matters:

1. *Every person decides.* Two humans and eight bots, 25 s shop: one Ready changes nothing; the
   second Ready at 10 s ends the shop at 13 s; `allReady` fires once with `saved` equal to the
   removed ticks.
2. *Nobody is rushed in the first seconds.* Both ready at 1 s: the fight starts 6 s after the shop
   opened, not at 4 s.
3. *Bots never hold the shop up.* One human and nine bots: one Ready cuts the shop.
4. *A leaver does not hold the room hostage.* A human who disconnects unready (a bot takes over)
   stops counting; the others' Ready cuts the shop on that tick.
5. *A newcomer gets time.* A slot patch turning a bot seat human during the shop blocks the cut
   until they ready; after a cut, the same patch does not restore time.
6. *The cut is final and never lengthens.* Un-ready after the cut leaves the timer; a
   `shopSeconds` of 5 is never lengthened to 6.
7. *Only real seats speak.* `shopReady` from a bot seat, during round end or fight, or from a
   benched player in the ranked final's shop is ignored; in that shop only finalists count.
8. *Harnesses do not move.* In a seeded bot-only match every shop lasts its full `shopSeconds`
   and no `allReady` fires, so the ladder, the Elo scripts and the menu backdrop keep their timing.
9. *Malformed input is harmless.* Extra keys or a non-boolean `ready` are dropped.
10. *Modes.* The deathmatch and respawn-hill opening shops can be cut; in their fights the command
    does nothing.

Net and replay:

- `src/net/protocol.test.ts`: `sanitizeCommand` keeps `{ kind, ready: boolean }` and drops the rest.
- `src/net/predict.test.ts`: a locally predicted last Ready does not play `allReady` until the
  authority sends it.
- `src/net/session.test.ts`: a P2P host and a client, both Ready: the shop ends early on both
  peers with equal state hashes.
- `src/game/replay/replay.test.ts` (pattern of `rankedFinal.test.ts`): a recorded match with a cut
  replays to the same final hash and the same fight start tick.

UI (`renderMarkup`, state not copy):

- `shop-ready`: `data-state` is `idle`, `ready` or `starting`; absent with `guidedSpell`, for a
  reserved seat and for a benched finalist.
- `shop-ready-count`: `data-ready` and `data-total` as numbers; absent with one counted human.
- Score pills: `data-ready="true"` on ready humans during the shop, no attribute outside it. Not a
  markup test in the build: the pills and the knockout card's shop button are written from the rAF
  (as `data-out` is), which static markup does not run; both were checked in a muted headless run
  of the dev build (Ready, the cut, knockout, the card's button, Ready while out, a 6 s shop).

Playtest questions (one evening, casual and a custom room of four or more):

- Did anyone press Ready, and how many seconds after the shop opened?
- Did the jump to the countdown feel clear, or abrupt?
- Did anyone feel pushed by others being ready? Did they notice the pill marks?
- Alone against bots: did Ready get used every shop?

## Open questions for the developer

1. **The numbers.** Cut to 3 s, never before 6 s after the shop opened. The 6 s floor exists for
   Easy bots (5.4 s to finish buying) and for the round result to land before the countdown. Keep,
   or drop the floor?
2. **Un-ready.** Recommended yes, as in the lobby. Or a one-way Ready?
3. **Default key.** Unbound by default, or a key in the Brawlock preset?
4. **Ranked.** Recommended on in ranked too (both humans must agree). Confirm.
5. **`PROTOCOL_VERSION` bump.** The repo bumps it for wire changes only; a new command kind is one.
   Confirm.
6. **Round gold at the knockout in ranked** too (recommended: the amount is the same for everyone),
   or casual and custom only?
7. **The shop opening itself** after your knockout: built as a button on the knockout card
   instead (see Part 2, What the player sees). Revisit if players miss it.

## Rollout

One release batch with [faster-casual.md](faster-casual.md), only on the developer's yes: server
and client deploy together (new netcode id). In the same change, docs follow the code:
`docs/PLAN.md` §2 gains a row ("The shop always ran its full time" → "Added: when every connected
human is Ready the shop ends 3 s later, never before 6 s after it opened; bots count as ready;
the shop time stays the maximum"), §3.4 mentions Ready, and `docs/RANKED-FORMAT.md` says the final's
15-second preparation shop can end early when every finalist is ready.
