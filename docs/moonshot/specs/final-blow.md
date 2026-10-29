# The Final Blow and the finish zoom

Status: implementation spec, 2026-10-28. From [03-moonshot-v2.md](../03-moonshot-v2.md) Bet 2 and
Bet 8 and [04-keystones.md](../04-keystones.md) Keystone 2 ("The Final Blow", "The finish zoom").
Needs [moments.md](moments.md). Ships in one release batch with it and
[results-reel.md](results-reel.md), on the developer's yes.

The developer (2026-10-28): "I love Final Blow, I love the finish zoom ... probably need some
fleshing out here and there."

## Why

- The hit that wins a round is usually seconds before the death: the round decider's sealing hit
  came p50 2.2 s, p90 5.3 s and at most 10.7 s before the last death (448 round deciders, the
  [moments.md](moments.md) harness). At round end today the player sees a warlock already burning,
  then the hero shot (`src/render/victoryCamera.ts`). A replay of the decisive hit answers "who hit
  whom" (04's test question).
- The netcode cannot freeze the present: clients get `death`, `roundWin` and `gameOver` only from
  the authority (`AUTHORITATIVE_EVENTS`, `src/net/predict.ts:64`), after the predicted visuals. A
  replay from recent confirmed states fits that and the sim never pauses.
- The slack is fixed: 3 s of round end (`ROUND_END_SECONDS`, `src/sim/config.ts:106`), and results
  0.6 s after `gameOver` (`GAME_OVER_LINGER_MS`, `src/net/session.ts:317`), which in rounds mode comes
  3 s after the deciding `roundWin` (`endRound`, `src/sim/mode.ts:334-347`).
- The finish zoom is Smash's rule (frontier §6): a forecast, not knowledge, so it can be wrong, and
  a wrong one is still drama. Live play gets camera and sound only, because a player who survives
  the forecast must see the present.

### Measurements (2026-10-28, 60 bot matches, 456 rounds)

- Decider hit to death within 4.4 s: 82%; 5.1 s: 88%; 6.7 s: 96%; 7.4 s: 97%. An 8 s ring holds the
  full round version when the hit came at most 7.4 s before the death (97% of round deciders) and
  the match version up to 6.7 s (96%).
- `cloneState` of a ten-warlock fight state: 18.7 µs; about 30 KB of heap per retained state
  (9.4 KB as JSON); 240 states (8 s at 30 per second): about 7 MB.
- Finish zoom with the rules below: fires in 274 of 456 rounds (60%), 1.2 times in such a round;
  4% of zooms hit a warlock who survived the round (13 of 323); 67% landed on the hit that later
  sealed the knockout; 55% of round deciders had a zoom on their sealing hit; zoom to death p50
  2.2 s, p90 4.0 s. In five human replays (re-simulated on their builds, see moments.md): 33 zooms
  in 29 of 40 rounds, 2 on a survivor, 24 on the eventual sealing hit.

## What the player sees

- **Round Final Blow.** A beat after a round is won, letterbox bars slide in with a small "Replay"
  kicker and the camera cuts to a low side view of the decisive hit at half speed. A lower third
  names the hitter, the spell icon and the victim, with chips for traits (reflected, detonation,
  pillar blast, long flight). If the victim burned for a while, a cut shows the splash. About 2.2 s,
  then a cut back to the winner's hero shot, and the shop opens on time.
- **Match Final Blow.** The round that wins the match gets the long version: a short run-up at full
  speed, the hit at a third of speed with a brief freeze on impact, the flight, the splash, then the
  winner's hero shot with the Victory or Defeat call. The results open when it ends (at most 6.3 s
  after the round is won instead of 3.6 s).
- **Finish zoom (live).** When your side lands a hit on the last opponent and the forecast says it
  ends in the lava (or it kills outright), the camera punches in toward the victim for half a
  second, effects dip and a stinger plays. Stronger when the round decides the match. Nothing slows
  down. Spectators and players already out get it on any round-ending hit; a player fighting for
  their own warlock never does.
- **Control.** Any key or click skips the Final Blow. Settings > Gameplay: "Final Blow replay" (Off,
  Match point only, Every round) and "Finish zoom" (on or off). With the system's reduced-motion
  preference the replay plays at normal speed from a fixed gameplay-angle camera and the zoom is
  off (its sound stays).

## Rules

Constants in `src/game/finalBlow.ts` and `src/game/finishZoom.ts`, seconds, converted with
`ticks()` at the use site:

| Constant | Value |
|---|---|
| `FB_DELAY` | 0.3 s after the displayed `roundWin` |
| Round plan | `[H - 0.3, H + 0.5]` at speed 0.5 (1.6 s); then `[H + 0.5, D + 0.1]` at 1x when `D <= H + 1.0`, else a cut to `[D - 0.4, D + 0.2]` at 1x. At most 2.2 s |
| Match plan | `[H - 1.0, H - 0.25]` at 1x; `[H - 0.25, H + 0.6]` at 0.35 with a 0.15 s freeze at `H`; then `[H + 0.6, D + 0.4]` at 1x when `D <= H + 1.6`, else a cut to `[D - 0.6, D + 0.4]`; then 1.2 s of the live hero shot. At most 6.0 s |
| `RING_SECONDS` | 8 s, at most 30 states per second |
| `RESULTS_HOLD_MAX` | 6.5 s after the displayed `roundWin` |
| Finish zoom | punch `0.16` of camera distance (`0.24` when the round decides the match), focus `0.35` of the way to the victim, envelope 0.08 s in, 0.12 s hold, 0.30 s out; once per victim per 2 s, at most 2 per round |

1. **Trigger.** When `MatchWorld` (mode `'match'`) handles a displayed `roundWin`
   (`src/render/scene/MatchWorld.ts:1281`), the controller asks `matchMoments.deciderOf(round)`
   ([moments.md](moments.md) Rule 8). The engine runs on the confirmed stream, which on every role
   is observed before the same event reaches the screen (`src/net/session.ts:1566`, `:2278`,
   `:2091`). It plays when the setting allows the kind (`matchDecider` makes it a match Final
   Blow), a decider exists, the tab is visible and the offline game is not paused. Otherwise
   nothing changes: the hero shot plays as today.
2. **Plan.** `planFinalBlow(moment, ring, kind, reducedMotion)` turns the decider (hit tick `H`,
   death tick `D`) into segments `{ from, to, speed }`, an optional freeze, camera shots and a
   total length, as in the table. A gap between segments is a cut.
3. **Ring coverage.** The plan needs ring states from its first tick. If the ring starts later, the
   plan drops to the death only: `[D - 1.0, D + 0.3]` at 0.6x, labelled the same (3% of measured
   round deciders). At start the plan takes references to the states it needs that already exist;
   the ring never mutates a kept state, so later drops cannot take them away. The few states after
   the death that do not exist yet are read when playback reaches them, by which time they do
   (playback starts after the death and runs slower than real time).
4. **Timing.** Start `FB_DELAY` after the displayed `roundWin` on the world clock (a hit-stop or an
   offline pause delays it). A round Final Blow ends at its plan's end, or 0.3 s after the
   displayed live state leaves `roundEnd`, whichever comes first: prediction can show the shop up
   to 0.5 s early (`MAX_AHEAD_TICKS`, `predict.ts:43-52`), and the next fight is 25 s away, so
   nothing that matters is hidden. A match Final Blow holds the results (Rule 9).
5. **Camera.** Shots use `CamPose` and `orbit()` from the promoted camera module (Design):
   - *Push*: target 65% of the way from the hitter to the victim at `H`, 60 units above the floor;
     yaw side-on to the victim's knockback direction (`moment.camera.dir`, else hitter to victim),
     on the side nearer the arena centre; pitch 38 degrees, distance 1,000 easing to 850 over the
     slow segment, FOV 40. The target follows the victim with a lag (rate 4 per second) so the
     flight stays in frame; if the hitter and the victim's whole path do not fit 80% of the frame
     width, the distance grows up to 1,400.
   - *Death*: after a cut, the same yaw (no line crossing), pitch 50, distance 900, on the victim's
     death position. Without a cut the push shot eases out to 1,050.
   - *Match*: the push shot orbits 20 degrees during the slow segment; during the freeze the world
     stops and the camera keeps moving.
   - *Guards*: camera at least 250 units above the floor; a pillar within its radius plus 60 of the
     camera-to-target line flips the side, and if both sides are blocked the pitch rises to 55.
   - *Hitter gone*: if the hitter's pawn is dead at `H` (a projectile still in flight), the target
     is the victim alone.
6. **Plate and HUD.** `src/ui/hud/FinalBlowPlate.tsx`: letterbox bars (7% of the height each), the
   kicker, a lower third with hitter, cause icon and victim as in the kill feed (identity colours,
   PLAN §5.2's glyph halo, no boxy panel), trait chips and a skip hint. While it plays the HUD hides
   the action bar, vitals, kill feed, spectate chip, shrink warning and death recap; the announcer
   banner stays. No post-processing or lighting change: arena lighting is approved.
7. **Point of view.** The replay is neutral: its source has `localPlayer` -1, so replayed hits give
   no hurt flash, shake or hit-stop, Scourge previews show as others see them, and every nameplate
   shows. The victim may be the local player; the Final Blow still plays, as a kill cam (the
   developer, 2026-10-29).
8. **Sound.** Live effects dip to 0.35 through a new `moment` gain while it plays. Replayed events go
   through `audio.playReplayEvents`: one-shot effects at the camera target, no announcer, no
   UI-bus cues, no music intensity, no travel loops, a low-pass (3 kHz) on the replay bus during
   slow segments. A `finalBlowImpact` cue marks the hit. The live round-win line (already playing)
   is on the announcer bus and is not dipped.
9. **Results hold.** A match Final Blow defers the results screen, not the session: the session
   still calls `setScreen('results')` at its usual time; the UI port in `src/game/session.ts:160`
   records it and shows the results when the Final Blow ends, is skipped or aborted, or at
   `RESULTS_HOLD_MAX`, whichever comes first. Any other screen change cancels the hold at once.
   `GAME_OVER_LINGER_MS` stays: it is host timing that every peer and the dedicated server share,
   while a hold must be per viewer (one player skips, another watches). King of the Hill ends in
   the `roundWin` tick, so its hold is longer but capped the same.
10. **Skip.** While it plays, a capture-phase `keydown` and `pointerdown` listener ends it at once
    and consumes the event (`preventDefault`, `stopImmediatePropagation`), except modifier-only
    keys and the wheel. Esc skips and does not open the menu. One `final_blow` analytics event per
    replay, `{ kind, skipped, seconds }`, through `trackEvent` (a new entry in the `Events` map of
    `src/lib/analytics.ts:101`, consent only), measures the skip rate behind 05's kill criterion.
11. **Reduced motion** (`prefers-reduced-motion`, read as `MatchWorld.ts:217` does): every segment
    at 1x, no freeze, one static `gameplay()` pose (60 degrees, 1,100 units) on the hit midpoint and
    another on the death after a cut, bars appear without sliding.
12. **Where it runs.** Offline matches against bots (the first playtest, 05 week 3), P2P and
    dedicated rooms, spectators and dead players (snapshot spectators fill the ring from snapshots,
    `session.ts:2091`). Not in the guided lesson (`src/game/practice.ts`: no recorder, no rounds),
    the menu backdrop (mode `'menu'`) or the replay viewer, where the viewer owns time
    ([results-reel.md](results-reel.md) adds highlight playback there). The finish zoom follows the
    displayed stream into the viewer, which feeds the audio engine at 2x and slower
    (`src/game/replay/viewer.ts:24-25`).
13. **Edge cases.** No decider (a warlock walked in, a tile sank, a hill ticket or deathmatch timer
    ended the round): no Final Blow. Leaving, an abort or a new match during playback: it stops and
    the source is restored in the same frame. The tab hidden during playback: it stops. Settings
    changed during playback apply to the next one. Ranked finals and team modes: as any round.
    60 Hz: the ring keeps every second state; plans are in seconds. Low quality and the WebGL2
    fallback: the same, nothing new is rendered.

### Finish zoom rules

14. **Where it is decided.** `FinishZoomTracker.update(events, state, localPlayer)` in
    `src/game/finishZoom.ts`, fed by `AudioEngine.playEvents` (`src/audio/engine.ts:457`) next to the
    announcer: the displayed stream, so on a client the zoom lands with the predicted hit the player
    sees. It emits through a `finishZooms` emitter shaped like `announcements`.
15. **Candidate.** A `damage` event with `kb > 0` from a player other than the victim's owner, in
    phase `fight`. `V` is the target pawn in the state after the tick.
16. **Deciding.** `V`'s side has no other living member, and either `V` is alive and exactly one
    other side is alive, or `V` is dead (a predicted kill) and at most one side is alive.
17. **Whose zoom.** For a local player with a living member on their side, the other living side
    must be theirs and `V` is never the local warlock. A spectator, an eliminated player or a
    player whose side is all dead gets any deciding hit.
18. **Forecast.** Lethal when `V` is dead, or
    `lavaOutcome(state, V, physVelocity(V), V.hp, V.moveSpeed, state.arena.layer).lethal`
    (`src/bots/predict.ts:40-87`, 4 s horizon, walking back as anyone would). Teleport, Shield and
    the next shrink are not forecast; that is what makes a wrong zoom possible.
19. **Kind.** `'match'` when `gameWinners` is non-null on a copy of the scores with the round point
    added to the other side's members (or on a ranked final); else `'round'`.
20. **Gates.** Once per victim per 2 s, at most 2 per round; reset at `phase: fight` and when the
    tick goes back. Off with the setting; under reduced motion only the sound plays.
21. **Effect.** `MatchWorld` queues the zoom and applies it when it consumes that tick's events:
    `cameraRig.punch(V.x, V.y, amount)` at gameplay pitch (04: no close-up before the character
    upgrade). The audio engine dips effects to 0.4 through the `moment` gain (0.03 s down, back from
    0.35 s) and plays `finishStinger` on the UI bus. No slow motion, no added hit-stop (the existing
    one fires only on hits to your own warlock, `MatchWorld.ts:1173-1183`), no post change.

## Design

| Layer | File and seam | Change |
|---|---|---|
| Ring | `src/game/stateRing.ts` (new) | `StateRing`: `observe(state, events)` clones kept states (`cloneState` with `events: []`) and keeps every tick's events; `window(from, to)`, `oldest`, `reset()` |
| | `src/game/session.ts:128-131` | `observe` feeds the ring after the moments engine; `start` and `abort` reset it. Cloning in one place is needed because the stream client steps its confirmed state in place (`src/net/session.ts:2267-2278`) |
| Plan | `src/game/finalBlow.ts` (new) | constants, `planFinalBlow`, the controller (settings, trigger, skip, hold) and a zustand flag `finalBlow: { kind, hitter, victim, cause, traits, partial } \| null`, set twice per replay, never per frame |
| Player | `src/render/finalBlowPlayer.ts` (new) | per frame: advance the plan clock by real dt, push the two ring states around the playback tick into a private source with a forced alpha, push crossed ticks' events, set the camera pose and the world time scale, feed `playReplayEvents` |
| Source | `src/render/source.ts:22-52` | `createPrivateSource(logCap)`: today the log keeps 120 batches (`:49`); a replay window needs up to `ticks(RING_SECONDS)` |
| World | `src/render/scene/MatchWorld.ts` | the six seams below |
| Pawns | `src/render/scene/Pawns.ts:714-750` | `PawnView.rewind()`: clears `deathConfirmed`, `deathAt`, `spin`, `cause`, `customDeath`, `edgeOverride`, `placed`, the round epoch and the character's celebrate and death poses |
| Camera | `src/render/cameraRig.ts:96-203` | `punch(x, y, amount)` and an exported pure `punchEnvelope(age)`; `update` (`:147`) renders `dist * (1 - amount * env)` and shifts the focus toward the point by `0.35 * env`, leaving `dist`, `targetDist` and the wheel alone |
| Audio | `src/audio/engine.ts:259-306`, `:457`, `:496-500` | a `moment` gain after `duck` (sfx, duck, moment, master; the reverb send moves after it), so the announcer's dip and the moment's dip do not cancel each other's automation; `finishZoom(z)`; `playReplayEvents(events, listener)` on a `replay` gain with its low-pass; cues `finishStinger` and `finalBlowImpact` (synth first, then a CC0 or CC-BY sample from Openverse) |
| Zoom | `src/game/finishZoom.ts` (new) | tracker and emitter (Rules 14-20) |
| Results | `src/game/session.ts:160-163` | the hold (Rule 9); `sessionScreen` updates at once, only the store's screen waits |
| HUD | `src/ui/hud/FinalBlowPlate.tsx` (new), `src/ui/hud/Hud.tsx:331-385` | the plate; `data-final-blow` on the HUD root hides the listed parts |
| Settings | `src/game/store.ts:32-99`, defaults near `:190`; `src/ui/SettingsModal.tsx:365` | `finalBlow: 'off' \| 'match' \| 'round'` (default `'round'`, Open question 1), `finishZoom: boolean` (default on); a Segmented and a Switch in Gameplay |

`MatchWorld` seams:

1. **`setSource(src)`.** `opts.source` becomes swappable. A soft rewind keeps every `PawnView` and
   calls `rewind()` on it; clears lingers (`:538`), after-hits, the sink queue, `deathFocus`
   (`:214`), `held` (`:622`) and `victoryShot` (`:215`); sets `lastEventTick` and `lastStateTick` to
   -1, so the next frame takes the existing `first` path (arena tiles and pillars snap, no sink or
   rise animation). Unlike `resetMatch` (`:856-870`) nothing is disposed or rebuilt and the camera
   is not recentred.
2. **`setTimeScale(k)`.** `update` (`:630`) scales the world clock by `k`, so particles, cloth and
   animations slow with the replay (they all follow the world clock); `k = 0` is the freeze and
   uses the frozen path that hit-stop uses (`:636-646`).
3. **Cinematic pose.** In `updateCamera` after `cameraRig.update` (`:2514`): while a pose is set the
   camera takes it (cuts, no blend), the victory shot and the locator are skipped, and the rig's
   focus follows the pose's target so the shadow frustum and the audio listener stay with the shot.
4. **Return to live.** After the swap back, when the live state is in `roundEnd` or `gameOver`, the
   world celebrates the living winners and sets the victory shot as at `:1286-1295`, and skips live
   events older than the return tick (they happened off screen; round end has no combat).
5. **Finish zoom.** Subscribe to `finishZooms` in the constructor and unsubscribe in `dispose`
   (the effect-cleanup lint); apply in `consumeEvents` (`:1068`), mode `'match'` only.
6. **Trigger.** In the `roundWin` case (`:1281`), match mode: `finalBlow.onRoundWin(curr, t)`.

Promoted from the showcase (which then imports them back): `showcase/cam.ts` becomes
`src/render/cinematic/cam.ts` unchanged (pure, no three: `CamPose`, `orbit`, `gameplay`, the eases,
`FLOOR`); the director's sub-tick write (`director.ts:72-78`, forced alpha through `currAt` and
`prevAt`) becomes `writeSubTick(buf, prev, curr, alpha, now)`; `action.ts`'s idea of framing the
whole action from a dry run becomes `frameAction(states, pawnIds)` over recorded states. The
`cameraRig.update` monkeypatch in `camRig.ts:22-49` stays dev-only; shipping code uses seam 3.

Budgets: the ring about 0.6 ms of CPU per second of play and at most 8 MB; entering and leaving a
Final Blow at most 4 ms of main thread each with no pipeline compile or texture upload (perf
harness); playback costs what live play costs (same scene, no extra pass); the zoom forecast runs
only on deciding hits (about one per round, at most 120 iterations at 30 Hz).

## Out of scope

- Any sim or netcode change: no pause, no new message, `GAME_OVER_LINGER_MS` unchanged.
- Post effects (desaturation, radial blur, red background), relighting, new VFX.
- A close-up finish zoom (after the character upgrade, 03 Bet 8), the Director and the crowd.
- Final Blows in the replay viewer, deathmatch and hill ticket ends; Final Blow clips (results-reel.md).

## Acceptance

Tests (state and numbers, never copy):

1. `src/game/finalBlow.test.ts`: for death delays from 0 to 10.7 s (the measured maximum), the round
   plan is at most 2.2 s and `FB_DELAY` plus the plan stays at least 0.5 s inside
   `ROUND_END_SECONDS` (imported, so a shorter round end fails here first); the slow segment
   contains the hit; a cut appears past the join limit; the match plan is at most 6.0 s; reduced
   motion gives speed 1 everywhere, no freeze and static poses; a short ring gives the death-only
   plan; no decider, no plan.
2. `src/game/stateRing.test.ts`: at 60 Hz it keeps 30 states per second; nothing older than 8 s;
   mutating a state after `observe` leaves the ring unchanged (the stream client case); event
   batches come back in tick order.
3. Results hold (UI-port unit test with a fake controller): `'results'` waits while holding and
   appears on end, skip and the cap; `'lobby'` cancels and applies at once; the session's own
   screen reads `'results'` throughout.
4. `src/game/finishZoom.test.ts` (crafted states): fires on a lethal slide of the last opponent and
   on a predicted kill; not on a non-lethal slide, a non-last opponent, the local warlock or a
   teammate; `'match'` when the round decides the match; spectators and eliminated players fire on
   any deciding hit; the 2 s gate holds.
5. `punchEnvelope`: 0 at 0, 1 by 0.08 s, 0 by 0.5 s, never above 1 (pure, like
   `victoryCamera.test.ts`).
6. UI (`renderMarkup`): `final-blow` with `data-state` and `data-kind`, absent when the flag is
   null; `setting-final-blow` (`data-state` off, match or round) and `setting-finish-zoom`.
7. `src/game/finalBlow.match.test.ts`: seeded duels through engine, ring and planner: every round
   decider gets a plan and at least 95% are full (measured 97%).

Browser check (muted headless, never the user's browser): an offline match against bots shows a
Final Blow each round, the pawn view count is unchanged afterwards, entering and leaving stay within
4 ms in the perf harness, and the forced WebGL2 fallback plays it too.

Playtest (offline first, ten rounds per player): do players watch or skip? Can they say who hit whom?
Does the match Final Blow feel earned or long? Did the zoom ever cost anyone sight of their own
warlock? Numbers after release: skip rate per kind (kill criterion, 05 §5: over 60% after two
weeks means match only), and how many turn the zoom off.

## Open questions for the developer

1. **Default.** Every round (recommended for the playtest) or match point only (05 §6 item 3)?
2. **The hero shot.** The round replay takes most of the round-end hero shot (0.3 s before, about
   0.5 s after). Keep, or shorten the slow segment to give the hero shot a full second?
3. **Camera height.** The replay looks from 850 to 1,000 units at 38 degrees, closer and lower than
   play (1,100 at 60). If the current warlock does not hold up there (an afternoon's check), use 60
   degrees and 1,000 until the character upgrade.
4. **The freeze.** 0.15 s on the match-winning impact (Sakurai's "boss stop"): wanted?
5. **Your own death.** Answered 2026-10-29: yes, a kill cam. The round's last knockout replays
   even when you were the victim.
6. **Zoom for onlookers.** Spectators and eliminated players get the zoom on any round-ending hit
   (recommended). Or only for your side's wins?
7. **Esc** skips the replay instead of opening the menu. Fine?

## Rollout

One release batch with [moments.md](moments.md) and [results-reel.md](results-reel.md), only on the
developer's yes, after the offline playtest (05 week 3). Client-only: no `src/sim` or `src/net`
change, so the netcode id stays and servers are untouched. In the same change, docs follow the code:
PLAN §5.4 describes the Final Blow, the finish zoom and the cinematic camera seam; 04's Final Blow
section gets the 8 s ring, the plans and the hold in the UI port instead of a longer linger; the
codebase map's "Hit-stop and slow motion today" (§5) gains the world time scale.
