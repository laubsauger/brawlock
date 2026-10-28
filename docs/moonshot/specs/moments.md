# Moments: what mattered in a match

Status: implementation spec, 2026-10-28. From [03-moonshot-v2.md](../03-moonshot-v2.md) Bet 2 and
Bet 8 and [04-keystones.md](../04-keystones.md) Keystone 2 ("The moments engine"). Feeds
[final-blow.md](final-blow.md) and [results-reel.md](results-reel.md). Ships in one release batch
with both, on the developer's yes.

The developer (2026-10-28): "I love Final Blow, I love the finish zoom, I love the results reel and
clips and outstanding moments ... probably need some fleshing out here and there."

## Why

- The Final Blow, the results reel and later the coach, Play of the Round and Brawlock TV all need
  one answer to "what mattered here". Today nothing computes it. The announcer
  (`src/game/announcer.ts`) only talks about the local player, live, with voice pacing; the match
  stats (`src/game/stats.ts`) only count.
- The death event points at the wrong instant. Most deaths are lava burns: in the measurement below
  the decisive push came 2.6 s before the lava death at the median, 5.5 s at p90 and 10.7 s at the
  most. A replay of "the death" would show a warlock already burning.
- 04 proposed "the last knockback hit within 4 s before the death". Measured, that misses 29% of
  lava deaths (only 71% of lava deaths had their last knockback hit within 4 s), because a
  full-health warlock lives 10 s in lava (`PAWN_MAX_LIFE` 1000, `lavaDps` 100). This spec replaces
  the fixed window with the lava stay the hit caused, which finds the decisive hit for 91 to 99% of
  deaths. It also replaces 04's eight-tile long flight (3 in 36 matches) with six tiles.
- One pure module means the live client, the replay player and a dedicated server all name the same
  moments from the same ticks.

### Measurements (2026-10-28)

[research/moments-experiment.ts](../research/moments-experiment.ts) ran the rules of this spec
over 60 seeded bot-only matches (real sim and bots, nothing changed in the repo) and five human
replays. Counts per match unless marked.

| Table | Matches, rounds | Knockouts (share of deaths) | Round deciders | Match deciders | Multi | Denied | Reflected | Detonation | Pillar | Clutch | Close call | Long flight | Comeback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FFA 10 (5 Medium, 5 Hard), first to 3 | 10, 88 | 72 (91%) | 85 of 88 rounds | 10 of 10 | 2.6 | 22.6 | 0.2 | 0.6 | 0.1 | none (FFA) | 2.7 | 6.8 | 2 of 10 |
| FFA 6 (Medium to Uber), first to 3 | 10, 90 | 42.6 (95%) | 88 of 90 | 10 of 10 | 2.0 | 6.7 | 0 | 0.1 | 0 | none (FFA) | 0.9 | 1.5 | 0 of 10 |
| Duel (Brutal–Uber, Hard–Brutal), first to 5 | 30, 200 | 6.6 (99%) | 197 of 200 | 28 of 30 | 0 | 1.6 | 0 | 0.03 | 0 | none | 0.1 | 0.13 | 4 of 30 |
| Teams 3v3, first to 5 | 10, 78 | 27.5 (94%) | 78 of 78 | 10 of 10 | 0.8 | 6.0 | 0 | 0.2 | 0 | 0.7 (9% of rounds) | 0.4 | 1.8 | 2 of 10 |
| Human replays (12 human seats with Medium to Brutal bots; 3 rounds-mode FFA, 2 King of the Hill) | 5, 40 | 62.8 (97%) | 39 of 40 | 4 of 5 | 1.4 | 32.7 (3 matches) | 1.2 | 0.4 | 0 | none (FFA) | 1.6 | 10 | not run |

The human row re-simulates the five exported matches of `research/replay-motion.ts` on the builds
that recorded them (none desynced; the oldest build predates the deny rule, so denies cover three
matches). Humans made 140 of its 314 knockouts and 5 of its 6 reflected kills: stolen kills are six
times as common per match as in bot FFA. Every bot multi-knockout was a double. Sealing hit to lava
death: p50 2.6 s, p75 4.0, p90 5.5, p95 6.5, max 10.7 s (1,371 bot lava knockouts); in the human
replays p50 2.2, p90 5.1, max 11.3 s (239). Sealing flight: p50 670 units (3.5 tiles), p90 1,072,
p95 1,216, max 2,002. The sealing hitter differs from the sim's kill credit (`death.killer`, the
last hitter) in 7 of 1,618 knockouts (a later hit without knockback, or a pillar blast the sim does
not credit). With the announcer's 1 s confirmation, 24 of 39 close calls (FFA 10) ended in death
within 3 s; with this spec's 5 s rule, 10 of 43. The prototype engine costs about 2.4 µs per tick
for ten warlocks (Node 24, finish-zoom forecasts included). Bots inflate Denied (they Teleport out
of lethal slides by design) and rarely steal or detonate (71 Shield steals, 7 stolen hits, 2
reflected kills in ten FFA 10 matches).

## What the player sees

Nothing by itself: [final-blow.md](final-blow.md) replays its deciders and
[results-reel.md](results-reel.md) plays its best three, titled from kind and traits.

## Rules

Constants in `src/game/moments.ts`, in seconds or game units, converted with `ticks()` at the use
site (module-level tick values go in `onTickRate`, the CLAUDE.md rule; the tick-rate lint test
covers this file):

| Constant | Value | Why |
|---|---|---|
| `SEAL_GRACE` | 0.5 s | a slide that stops at the edge and tips in a moment later is still the push |
| `SEAL_FLIGHT_EXTRA` | 2 s | added to the longest possible lava stay (`maxHp / lavaDps`, 10 s by default) |
| `LONG_FLIGHT` | 6 tiles (`6 * ARENA_TILE_SIZE`, 1,152 units) | about the top 7% of sealing flights; 8 tiles was 3 in 36 matches |
| `CLOSE_CALL_SAFE` | 5 s | a kept moment must be true; the announcer's 1 s is for a timely voice line |
| `MOMENT_PRE`, `MOMENT_POST` | 0.5 s, 0.5 s | default window margins |
| Shared | `MULTI_WINDOW` 3 s (`src/render/overlay/killStamps.ts:14`, via `KillTally`), `CLOSE_CALL_HP` 0.08 (`announcer.ts:214`), `FLIGHT_START_SPEED` 200 and `FLIGHT_STOP_SPEED` 20 (`stats.ts:341-344`), `OBSTACLE_EXPLODE_RADIUS` 300 (`src/sim/config.ts:80`) | one definition each |

1. **Input.** `update(events, state)` once per authoritative tick with the pair
   `MatchRecorder.observe` receives (`src/net/session.ts:1566` host and offline, `:2278` stream
   client): never predicted states, so a mispredicted hit never becomes a moment. Snapshot and
   classic clients pass several ticks' events with one state (`:2091`, `:2160`; Rule 16).
2. **Order within a tick.** Events first, in array order (the sim pushes a lethal `damage` before
   its `death`, the last `death` before `roundWin`, `roundWin` before `gameOver`), then the state
   pass (flights, lava stays, slide snapshots, clutch candidates, close-call confirmation), then the
   stolen-projectile table for the next tick. All distances use `hypot` from `src/sim/math.ts`, as
   `src/bots/predict.ts` does, so a server and a client compare thresholds bit for bit.
3. **Hits.** Each `damage` event `e` on pawn `V` (owner `v`) with `e.kb > 0`, or in the tick of
   `V`'s death, is attributed to `src = e.source`. A pillar blast has `source: null` and
   `cause: 'obstacle'` (`src/sim/combat.ts:210-227`): `src` is the `by` of the same tick's
   `obstacleDestroyed` event nearest to `(e.x, e.y)` within `OBSTACLE_EXPLODE_RADIUS` (the event's
   position is the pawn's, the blast hit pawns strictly inside the radius). The hit is kept when
   `src` is a player, `src !== v`, and `src` is on another team than `v` at that tick. Lava and
   sourceless damage are never hits. Fully absorbed Rush hits still push (`combat.ts:62-78`) and
   count. The ledger per pawn keeps hits for `maxHp / lavaDps + SEAL_FLIGHT_EXTRA`; it is cleared
   at every `phase: fight`.
4. **Flights.** A hit with `e.kb >= FLIGHT_START_SPEED` starts a flight at `(e.x, e.y)`. It ends
   at the first state where `V`'s knockback speed (`|v - walkV|`) is below `FLIGHT_STOP_SPEED`, at
   the next knockback hit on `V`, or at `V`'s death; its length is the straight line from start to
   end. A hit below the start speed has length 0 and ends at once.
5. **Lava stays.** Per pawn, `stayStart` is the tick of the first state of the current unbroken run
   with `alive && lavaTicks > 0` (`src/sim/lava.ts:21-26`); a state with `lavaTicks === 0` clears
   it.
6. **The sealing hit** of a `death` (cause other than `'disconnect'`):
   - cause `'lava'`: `H` is `V`'s most recent hit. It seals when `stayStart` is known,
     `death.tick - H.tick <= maxHp / lavaDps + SEAL_FLIGHT_EXTRA`, and either `H.tick >= stayStart`
     (it kept them in) or `H`'s flight was still running at `stayStart` or ended at most
     `SEAL_GRACE` before it (it carried them in). A warlock who walked in, or whose tile sank, has
     no sealing hit even though the sim credits the last hitter.
   - any other cause: the hit recorded in the death's own tick (the lethal instance), if any.
7. **Knockout.** Every death with a sealing hit `H` makes one moment: `actors [H.src]`,
   `victims [v]`, `tick H.tick`, `end death.tick`, window
   `[H.tick - MOMENT_PRE, death.tick + MOMENT_POST]`, `cause H.cause`. Traits:
   - `reflected`: same tick, a `projectileHit` or `projectileExpire` for an id that in the previous
     state had `data.origOwner` set and different from its `owner`, with `owner === H.src` and
     `spell === H.cause`. Recharge sets `origOwner` to its own caster (`recharge.ts:45`) and Shield
     only on the first steal (`shield.ts:47-50`), so neither an orb nor a stolen-back shot counts.
   - `detonation`: `H.cause === 'lightning'` and the same tick has an `explosion` with
     `spell: 'lightning'` whose radius contains `(H.x, H.y)` (`lightning.ts:63-75`; a plain beam
     hit has no explosion).
   - `pillarBlast`: `H` was attributed through `obstacleDestroyed.by` (Rule 3), or the death's
     cause is `'obstacle'`.
   - `longFlight`: `H`'s flight is longer than `LONG_FLIGHT`.
8. **Round decider.** At a `roundWin` event, the knockout of the last `death` in the same tick. If
   that death has no knockout, the latest knockout among that tick's other deaths; otherwise none.
   It gains `roundDecider`. Rounds without a death in the `roundWin` tick (King of the Hill ticket
   ends) have none; deathmatch never emits `roundWin` from a death and has none.
9. **Match decider.** When `gameWinners(state)` is non-null at that `roundWin` (the announcer's own
   check, `announcer.ts:494`; it covers first-to scores, ranked clinches and the ranked final's
   `rankedFinal.winners`), the round decider also gains `matchDecider`. A hill match ended by a
   ticket outside a round win has none.
10. **Multi-knockout.** Every death goes through a `KillTally` (`announcer.ts:321-350`, shared with
    the announcer and the stats) with `now = tick / TICK_HZ`. A kill with `chain === 2` creates a
    moment for the killer; each further link extends it (`count = chain`, victims appended,
    `end` and `to` moved). Credit is `death.killer`, as in the kill feed and the announcer, so a
    chain can include an unsealed kill. Window `[first link's knockout from, or its death minus
    3.5 s; last death + MOMENT_POST]`. `final` turns true once `MULTI_WINDOW` passes without a link.
11. **Denied.** A `teleport` event for pawn `P` in phase `fight`, `P` alive in the previous state,
    for which `isDeniedEscape(slide, slide, e.toX, e.toY, state)` holds (`src/game/teleportSave.ts:66-78`),
    where `slide` is `P`'s snapshot from the previous state written with `writeSlide` plus its
    `hp` and `moveSpeed`: the announcer's exact call (`announcer.ts:470-477`), for every pawn and
    without `DENIED_COOLDOWN`. `actors [P's owner]`; `victims [pusher]` when `P`'s most recent hit's
    flight was still running or ended within `SEAL_GRACE` of the slide, else empty. Window
    `[pusher hit (or the teleport minus 1 s) - MOMENT_PRE, teleport + 1 s]`.
12. **Clutch.** Team modes only (sides of two or more at `phase: fight`; in FFA everyone is alone).
    A player becomes a candidate on the first state where they are their side's only living member
    with two or more enemies alive; `count` is the most enemies alive at once meanwhile. At
    `roundWin`, a living candidate in `e.players` makes a clutch: `actors [player]`, `victims` the
    enemies who died after the candidacy began, `tick` the `roundWin` tick, window from the later of
    the candidacy start and the round decider's `from` to `roundWin + 1 s`, at most its last 8 s.
13. **Close call.** A `damage` event with `source` a player other than the target's owner and
    `amount > 0`, after which the target is alive with `hp <= CLOSE_CALL_HP * maxHp`: the
    announcer's hit rule, shared as `isCloseCallHit` (Design). It is confirmed when the pawn is
    alive and not in lava `CLOSE_CALL_SAFE` after the hit, or alive at its round's `roundWin`,
    whichever comes first. A later qualifying hit before confirmation restarts the clock. At most
    one per player per round. Window `[hit - MOMENT_PRE, confirmation + MOMENT_POST]`, capped at 6 s.
14. **Comeback.** A trait, not a moment: rounds mode, the match decider gains `comeback` when a
    winner was at some `roundWin` two or more round wins behind the leader (team modes: by the best
    member's score). Measured in 8 of 60 matches.
15. **Scoring.** `score = base x stakes x spectacle x novelty`, rounded to 3 decimals.
    - base: knockout 1.0, times 1.8 `reflected`, 1.6 `detonation`, 1.5 `pillarBlast`,
      1.3 `longFlight`, 1.2 `comeback` (each that applies); multi-knockout `0.9 x count`; denied
      1.2; clutch `1.5 + 0.5 x (count - 2)`; close call 0.8.
    - stakes: 1; 1.5 with `roundDecider` (a clutch takes its round's stakes); 2.5 with
      `matchDecider`.
    - spectacle: knockouts `0.85 + 0.15 x min(2, H.kb / 1500)` (0.85 to 1.15; sealing knockback
      p50 1,520 u/s, p90 1,934); others 1.
    - novelty: for moments with stakes 1, `max(0.4, 0.8^k)` where `k` counts earlier moments of the
      same kind by the same first actor this match; deciders are exempt. Without the exemption the
      match decider, always late, dropped out of the top three in every measured duel.
    - The engine knows nothing of the viewer. Local relevance belongs to the reel
      (results-reel.md).
16. **Edge cases.** `cause: 'disconnect'` deaths make nothing; a seat taken over by a bot keeps its
    id and its moments. When the first of two lethal hits in one tick ends the round, the second is
    ignored (`mode.ts:265-268`), so a draw is nearly impossible (none in 456 measured rounds; if one
    happens, the tick's last death decides). A ranked final's round win is the match decider. King
    of the Hill has knockouts in both styles and deciders only in the rounds style. The engine
    resets on `reset()` (recorder start) and when `state.tick` goes back more than a second, as the
    announcer does (`announcer.ts:443`); a keyframe resync does not reset it. Snapshot and classic
    clients sample flights and stays per snapshot, so a threshold can flip in rare cases; their
    moments stay local and are never compared with anyone's. At `gameOver` every moment becomes
    final: a chain stops growing and an unconfirmed close call is dropped.

## Design

| Layer | File and seam | Change |
|---|---|---|
| Engine | `src/game/moments.ts` (new) | `MomentsEngine`, constants, scoring, the `matchMoments` instance and a `momentEvents` emitter shaped like `announcements` (`announcer.ts:625-640`) |
| Shared rules | `src/game/announcer.ts:213-216` | export `CLOSE_CALL_HP` and `isCloseCallHit(e, pawnAfter)`; the announcer's damage case (`:465-469`) calls it, so both use one rule |
| | `src/game/teleportSave.ts`, `src/game/stats.ts:341-344`, `KillTally` | used as they are |
| Live feed | `src/game/session.ts:128-131` `createRecorder().observe` | `matchMoments.update(events, state)` next to the tracker and the replay; `matchMoments.reset()` in `start` (`:117`) and `abort` |
| Replay | `src/game/replay/moments.ts` (new) | `momentsOfReplay(data, budgetMs)`: steps a `ReplayPlayer` and feeds a fresh engine, in slices so the main thread keeps its frames |
| Storage | `src/game/replay/format.ts:30-59`, `asReplay` `:122` | optional `moments?: MomentRecord[]` (the ten best, compact); `REPLAY_VERSION` stays 1 because older builds ignore the field; `asReplay` validates it or drops it |
| | `src/game/replay/recorder.ts:82` `finish` | takes the record list from the hook (`hook.ts:32`) |
| Server (later) | `src/net/leaderboard.ts:378` `ServerMatchTracker.observe` | not in this batch. The same engine can run there for Play of the Round and the coach; the dedicated test below proves it is cheap and agrees with the client |

Data shape (04's `{ kind, tick, from, to, actors, score, camera }`, extended):

```ts
export type MomentKind = 'knockout' | 'multiKnockout' | 'denied' | 'clutch' | 'closeCall'
export type MomentTrait = 'roundDecider' | 'matchDecider' | 'reflected' | 'detonation' | 'pillarBlast' | 'longFlight' | 'comeback'

export interface Moment {
  id: number                // creation order within the match
  kind: MomentKind
  traits: MomentTrait[]     // sorted, no duplicates
  round: number
  tick: number              // the instant that matters (sealing hit, Teleport, round win, hit)
  end: number               // knockout: death tick; multi: last death; else = tick
  from: number              // window to show, ticks
  to: number
  actors: PlayerId[]        // first = who did it
  victims: PlayerId[]
  cause: string | null      // sealing hit's spell id or 'obstacle'
  count: number             // multi: knockouts; clutch: enemies faced; else 1
  score: number
  camera: { subject: EntityId; other: EntityId | null; x: number; y: number; dirX: number; dirY: number }
  final: boolean            // false while a chain can grow or a close call is pending
}

export class MomentsEngine {
  reset(): void
  /** one authoritative tick; returns the moments created or changed by it */
  update(events: readonly SimEvent[], state: MomentsView): readonly Moment[]
  all(): readonly Moment[]
  deciderOf(round: number): Moment | null
}
export type MomentsView = Pick<SimState, 'tick' | 'phase' | 'round' | 'pawns' | 'projectiles' | 'scores' | 'slots' | 'settings' | 'arena' | 'rankedFinal'>
```

`camera`: `subject` is the victim's pawn (knockout), the Teleporter (denied), the clutch or
close-call player; `other` is the hitter's pawn; `(x, y)` the key instant's position; `dir` the
victim's knockback direction in the state after the hit (`vx - walkVx`, normalized), 0 when none.
Consumers read positions from states; the engine stores no positions over time.

What it shares instead of duplicating: `KillTally` and its `MULTI_WINDOW`, `isDeniedEscape` and
`writeSlide`, the close-call hit rule and HP threshold, `gameWinners` at `roundWin`, the flight
speeds. What it does not take over: the announcer keeps its own instance on the displayed stream,
because a voice line must come with the predicted hit, with cooldowns and caps; the engine runs on
the confirmed stream with neither. The match stats keep their per-player flight measure (the
Frequent Flyer award); the engine measures flights per hit.

Budgets: at most 10 µs per tick for ten warlocks on the client (measured prototype 2.4 µs); no
allocation on ticks without `damage`, `death`, `teleport` or `roundWin`; per-pawn memory bounded by
the hit ledger (a few dozen entries); about 100 moments in a ten-warlock match (72 knockouts and 23
denies measured), each a small object, dropped at `reset()`.

## Out of scope

- Changes to what the announcer says or when (only the close-call predicate becomes a shared
  export), and to kill credit (the sim keeps crediting the last hitter).
- First Blood, streaks, Shutdown, Revenge and Ace as moments; Swap or Alteration escapes as
  denies; an FFA clutch; a comeback moment of its own.
- Moments on the server, Play of the Round, the coach. Timeline markers are in results-reel.md.

## Acceptance

Unit tests, `src/game/moments.test.ts`, from crafted event sequences and hand-built states (`fight()` and
`pawn()` from `src/sim/testkit.ts`, then edited). Each states why it matters:

1. A push, then a lava death 3 s later: one knockout whose actor is the pusher and whose tick is the
   push tick. Most deaths are lava burns; the moment must be the push, not the burn.
2. A push whose slide stops on ground, then a walk into the lava (or a tile sinking) and death: no
   knockout, while `death.killer` still names the pusher. A moment must be caused, not credited.
3. A push into lava, a second small hit by someone else during the stay, death: the second hit
   seals. It is the hit that kept them in, and the sim credits it too.
4. A death 9 s into a stay after a push (full-health warlock): still sealed. 04's 4 s window misses
   every lava death whose push came earlier than that, 29% of those measured.
5. A direct Fireball kill: knockout at the death tick, cause `fireball`.
6. A pillar broken by A blasts B into lava: `pillarBlast`, actor A; with `by: null`, no knockout.
7. Lightning detonating a Fireball near B: `detonation`; a plain Lightning beam hit: no trait.
8. A Fireball stolen by B's Shield kills A: `reflected`, actor B; a Recharge orb: not reflected.
9. `roundWin` in the tick of the last death: `roundDecider`; with `gameWinners` non-null:
   `matchDecider` and stakes 2.5. A hill ticket end: no decider.
10. Two credited kills 2.5 s apart, a third 2 s later: one multi-knockout, count 3. A kill 3.5 s
    after the previous: a new chain. The chain matches `KillTally` exactly.
11. Teleports out of a lethal slide and out of a harmless one: one denied, with the pusher as
    victim. A table test feeds the same cases to the announcer and the engine and requires the same
    verdict: one rule.
12. 3v3: last alive against two, wins: clutch, count 2. The candidate dies: none. FFA: never.
13. 8% after a hit, alive and off lava 5 s later: close call. Dead at 4 s: none. A second one in the
    same round: none.
14. Scoring: a match decider outranks a double knockout; the fourth ordinary knockout by one player
    scores below their first; a round decider is exempt from novelty.
15. Determinism: the same sequence fed twice gives deep-equal moments.

Seeded matches, `src/game/moments.match.test.ts` (well under 2 s; one assertion at the end, per
CLAUDE.md):

- Three seeded duels (Hard against Brutal, first to 2) and one ten-bot FFA round: each round with a
  sealed last death has exactly one `roundDecider`, on that death; the last round's is the
  `matchDecider`; knockouts are at least 90% of deaths; every moment has `from <= tick <= end <= to`.
- Replay equivalence: the match recorded with `ReplayRecorder` and fed back through
  `momentsOfReplay` gives deep-equal moments (what the reel and a server rely on).
- A dedicated-session test (`src/net/dedicated.test.ts` pattern): server and client moments agree.
- `TICK_HZ=60 npx vitest run src/game/moments*.test.ts` and `npm run lint:invariants` pass.

Measurements before release: rerun the table above with the shipped engine, the human row through
`momentsOfReplay` over every human replay available (five on 2026-10-28; more from playtests).

Playtest questions (with the Final Blow, one evening): did the replayed hit look like the one that
won the round? When a warlock walked into the lava alone, did anyone miss a replay?

## Open questions for the developer

1. **Close calls.** The engine confirms after 5 s, the announcer after 1 s. Keep them different
   (recommended: the voice must be quick, a kept moment must be true), or slow the voice line down?
2. **Long flight at six tiles.** Six tiles is about the top 7% of sealing flights. Or keep eight as
   a rare trophy (0.08 per match)?
3. **Denies in FFA.** Bots deny 22 times in a ten-warlock match. They score low and rarely reach the
   reel. Fine, or drop denies without a pusher?

## Rollout

One release batch with [final-blow.md](final-blow.md) and [results-reel.md](results-reel.md), only on
the developer's yes. The engine has no setting and no UI of its own. No change to `src/sim` or
`src/net`: the netcode id stays, no server deploy. In the same change, docs follow the code:
04-keystones.md's moments table gets the stay rule, six tiles and the 5 s close call with these
measurements, and PLAN §5.4 gains a short paragraph on moments next to the camera.
