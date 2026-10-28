# The results reel, then clips that outlive a build

Status: implementation spec, 2026-10-28. From [03-moonshot-v2.md](../03-moonshot-v2.md) Bet 2 and
Bet 8 and [04-keystones.md](../04-keystones.md) Keystone 2 ("The reel", "Clips that outlive a
build", "Sharing"). Needs [moments.md](moments.md) and reuses [final-blow.md](final-blow.md)'s
playback, camera and plans. The reel ships in one release batch with both, on the developer's yes.
Clips are a later phase (Q2 in 05), each step on its own yes.

The developer (2026-10-28): "I love the results reel and clips and outstanding moments ... probably
need some fleshing out here and there."

## Why

- A match ends on a table of numbers. The three moments a player remembers are the local half of
  "keep and share", and they cost no server.
- Everything needed is already on every peer that steps the input stream: the recorder keeps the
  start state and every confirmed input (`src/game/replay/recorder.ts`), the replay player
  re-simulates them exactly and checks hashes (`src/game/replay/player.ts`), and the moments engine
  names what mattered.
- "Watch replay" on the results screen is refused while the player is in a room
  (`src/ui/lib/replays.ts:35-38`: the viewer drives the global frame buffer), so online players
  can only watch their match after leaving the room. The reel uses a private player and source, so
  it works in rooms.

### Measurements (2026-10-28)

The [moments.md](moments.md) harness picked a reel per match with the rules below (score from
moments.md Rule 15, the local player weighted 1.5) over 60 bot matches:

| Table | Reel slots | Match decider | Round deciders | Multi | Other | With the local player |
|---|---|---|---|---|---|---|
| FFA 10, first to 3 | 30 | 10 (incl. 2 comebacks) | 11 | 8 | 1 detonation | 18 |
| FFA 6, first to 3 | 30 | 8 | 16 | 5 | 1 detonation | 26 |
| Duel, first to 5 | 90 | 28 (incl. 4 comebacks) | 61 | 0 | 1 detonation decider | 90 |
| Teams 3v3, first to 5 | 30 | 8 (incl. 1 comeback) | 12 | 4 | 5 clutches, 1 denied | 24 |

The match decider was in the top three in 54 of the 58 matches that had one; in the other four,
the local player's own moments or an overlapping clutch or double ranked higher. The three
windows, each capped at 6 s, summed to p50 9 s and p90 14.9 s.

## What the player sees

- **Highlights first.** When the results open after a match with a reel, the match scene fills the
  screen behind the Victory or Defeat title. Up to three moments play in match order through the
  Final Blow's replay camera, each with a caption at the bottom: what it was (a knockout, a double,
  a clutch, a denial), who did it to whom in their colours, the round, and trait chips. Pips show
  1, 2, 3 and a Skip control. About 10 to 15 s in all, then the usual board appears.
- **Skip.** Any key or click goes to the board. Enter during the highlights only skips; it never
  marks you Ready by accident.
- **Again.** "Watch highlights" next to "Watch replay" plays them again, in rooms too.
- **Settings > Gameplay:** "Results highlights" (on or off).
- **The replay viewer** shows moment markers on the timeline beside rounds and kills, and a
  Highlights button that plays the reel for any stored replay.
- **No reel** after an abandoned match, for snapshot spectators (they record no replay,
  `recorder.ts:1-9`), when no moment scores at least 1.0, or when the replay desyncs.
- **Reduced motion:** normal speed, static gameplay-angle camera, captions without motion.

## Rules

Constants in `src/game/replay/reel.ts`: `REEL_SIZE` 3, `REEL_MIN_SCORE` 1.0, `REEL_LOCAL_WEIGHT` 1.5,
`REEL_MAX_PER_ACTOR` 2, `REEL_MOMENT_MAX` 6 s of match time, `REEL_GAP` 0.4 s, `PREPARE_BUDGET_MS` 6.

1. **Candidates.** `matchMoments.all()` at match end. At `gameOver` the engine finalizes every
   moment (a chain stops growing; an unconfirmed close call is dropped, [moments.md](moments.md)
   Rule 16).
2. **Weight.** Reel score = moment score, times `REEL_LOCAL_WEIGHT` when the local player is among
   its actors or victims. A replay recorded by a spectator weights no one.
3. **Selection.** By reel score, highest first: skip a candidate whose window overlaps one already
   chosen (a double never plays beside its own knockouts); skip a third moment by the same first
   actor while another candidate reaches `REEL_MIN_SCORE`; stop at `REEL_SIZE` or below
   `REEL_MIN_SCORE`. Zero picks: no highlights, the board as today.
4. **The decider, once.** Selection runs when the results screen first shows, after any hold, so it
   knows how the match Final Blow went: if it played to its end (not skipped, not switched off),
   the match decider is left out and the next candidate takes its place; otherwise it is in (Open
   question 2).
5. **Order.** Match order (by `tick`).
6. **Plans.** Camera shots from final-blow.md Rule 5 on `moment.camera`:

   | Kind | Plays |
   |---|---|
   | Knockout | final-blow.md's round plan with 0.5 s of run-up instead of 0.3 |
   | Multi-knockout | first link's window to the last death + 0.3 s at 1x, 0.8 s at 0.5x around each sealing hit, links cut together to fit `REEL_MOMENT_MAX` |
   | Denied | pusher's hit - 0.3 s to the Teleport + 0.8 s, 0.5x from 0.4 s before the Teleport to 0.3 s after |
   | Clutch | the last 4 s before the decider's hit at 1x, then the round plan of the decider |
   | Close call | hit - 0.3 s to hit + 1.5 s, 0.6x for the first 0.8 s |

   Between moments the letterbox closes for `REEL_GAP`.
7. **Getting there.** Before a moment, the reel restores the nearest keyframe at or before its first
   tick and re-simulates to it in slices of at most `PREPARE_BUDGET_MS` per frame, during the gap.
   Keyframes: the replay player's own (every 10 s as it plays, `player.ts:19-20`) plus a clone of the
   state at every `phase: fight` taken by the recorder during the match, so a seek re-simulates at
   most one round. If preparing outlasts the gap, the bars stay closed until it is done.
8. **Playing.** The reel steps its player forward only as playback needs ticks, keeps a clone of the
   previous and current state (the player steps in place, `player.ts:71-93`) and writes them with a
   forced alpha into a private source (final-blow.md's sub-tick write); each step's events go to the
   source and to `audio.playReplayEvents`.
9. **Truth.** The player checks the recorded hashes as it steps; a desync stops the reel and shows
   the board. A wrong moment is never shown.
10. **Ending.** Skip, the last moment, or leaving the results screen (lobby, menu, a new match)
    stops the reel in the same frame: the world goes back to `globalSource`, the
    layer back to its hidden warm state. Keyframes and the in-memory replay are released when the
    results screen closes.
11. **Library replays.** Moments come from `ReplayData.moments` when stored, else from
    `momentsOfReplay` in slices with a "preparing" state; without round keyframes the first seek
    re-simulates from the start in slices (a 30-minute match is about 54,000 ticks, measured at
    roughly 10 µs a tick with bots thinking, less without).
12. **Captions.** Kind and traits name the moment: Knockout, Round decider, Final blow, Reflected,
    Detonation, Pillar blast, Long flight, Double or Triple knockout, Denied, Clutch 1v2 (1v3 ...),
    Close call, and a Comeback chip. Copy is for the developer to tune; tests read `data-*` only.

## Design

| Layer | File and seam | Change |
|---|---|---|
| Model | `src/game/replay/reel.ts` (new) | `selectReel(moments, local, { excludeDecider })`, plans per kind, `ReelPlayer` (owns a `ReplayPlayer`, its keyframes, the prepare slices and the playback clock) and a `reel` store flag `{ state: 'playing' \| 'done' \| 'none', index, count }`, changed per moment, never per frame |
| Recorder | `src/game/replay/recorder.ts:71-80` `observe` | at `phase: fight` (beside `:76`) clone the state into `roundKeyframes` (memory only, never saved) |
| Hook | `src/game/replay/hook.ts:32-41` `finish` | also hands the in-memory `ReplayData` and the keyframes to the reel, whatever happens to the IndexedDB save |
| Player | `src/game/replay/player.ts:96-105` | `addKeyframe(tick, state)` and `restoreNearest(tick)` (restore without stepping), so the reel can step in budgeted slices |
| Glue | `src/game/session.ts:132-140` `finish` | `reel.prepare({ data, keyframes, moments: matchMoments.all(), local })`; `abort` clears it; selection waits for the results screen (Rule 4) |
| Render | `src/render/finalBlowPlayer.ts` | generalized to `src/render/cinematic/replayPlayback.ts`: frames from the state ring (Final Blow) or from a `ReplayPlayer` (reel) |
| Layer | `src/ui/MatchLayer.tsx:21-23` | `shown` also while `reel.state === 'playing'` on results; `live` stays false, so no input attaches |
| Results | `src/ui/screens/Results.tsx` | `ResultsReel.tsx` (new) renders highlights mode in place of the board (`:156`); the Enter handler (`:109-119`) ignores Enter while the reel plays (the reel's capture listener consumed it); a `watch-highlights` button beside both "Watch replay" buttons (`:326-331`, `:350-355`) |
| Viewer | `src/ui/screens/Replay.tsx:267-290` | moment markers from `ReplayData.moments`; a Highlights button |
| Settings | `src/game/store.ts:32-99`, `src/ui/SettingsModal.tsx:365` | `resultsReel: boolean`, default on; a Switch in Gameplay |

Budgets: no new memory during the match beyond round keyframes (about 30 KB each, a few hundred KB
per match); the replay's input steps are already held by the recorder. Preparing never takes more
than 6 ms of a frame; playback costs one sim step and one `cloneState` (18.7 µs measured) per
displayed tick. The scene costs what live play costs.

## Out of scope

Clips, uploads and sharing (below), the netcode id split (its own change, earlier in 05), a reel
for spectators without a replay, music, the coach, saving highlights as files.

## Clips and sharing: the later phase

Not in this batch. Each step on the developer's yes. The unfurl test comes before any clip
infrastructure (steps 3 and 4); the id split helps replays on its own and is already scheduled
earlier (05 week 1).

1. **The unfurl test, first** (a day, 05 week 2). A static page on the domain that would serve
   clips (`brawlock.osc.link/c/test`): `og:video` with a 10 to 15 s H.264 and AAC MP4 at 1280x720,
   fast start, cut from the showcase clips in `media/showcase`; `og:video:type`, width and height;
   `og:image` (a poster); `twitter:card` `player` with a player page; an oEmbed link. Post it in a
   Discord server and a Discord DM, on X, in Slack and on Reddit. Record per platform: inline video,
   poster only or nothing; autoplay; sound; where a click goes. Check that the host serves byte
   ranges and the right content type, since inline players need both. The result decides whether a
   shared clip is a video or a poster with a link, and whether the account authority must serve
   the files.
2. **Split the netcode id** (04, 05 week 1). `scripts/net-id.mjs:9-26` gains `simId(root)`: a hash of
   the non-test `.ts` files in `src/sim`, of the command codec (`encodeCmd` and `decodeCmd` move from
   `src/net/stream.ts` to `src/net/commandCodec.ts`, so the protocol around them can change without
   touching replays) and of `src/game/replay/player.ts` (how recorded steps are applied).
   `vite.config.ts:21,78` defines `__SIM_ID__`. `ReplayData` gains an optional `simId`
   (`REPLAY_VERSION` stays 1); `checkReplay` (`format.ts:113`) accepts a matching `simId`, or, for
   replays recorded before the split, a matching `netId`. Live compatibility (servers,
   `src/net/online.ts`) keeps the live id. Tests: in a copied fixture tree, editing
   `src/game/progressionCatalog.ts` or `src/net/session.ts` changes the live id and not the sim id;
   editing a `src/sim` file changes both; a recorded replay plays when only the live id differs and
   is refused when the sim id differs. Before the change, a one-off script over git history
   measures how often the sim id would have moved (the live id moves on about 37% of commits, 02 §0).
3. **The build-free clip track.** What the renderer needs, not what the sim needs. Per tick: each
   warlock's position, facing, hp, alive flag, cast (spell, started, progress), knockback velocity
   (lean and tumble), lava ticks and the modifiers that change its look; each projectile's id,
   kind, spell, owner, position, radius, level and the `data` keys effects read; pillars; arena
   layer and hill; the tick's events the renderer and audio use. Slots carry name, colour, team and
   cosmetics. The field list comes from an audit of what `MatchWorld`, `Pawns.ts` and the effect
   modules read, not from guesswork. Positions in whole units and angles in 1/256 turns,
   delta-coded per tick, gzipped; a 10 s clip of ten warlocks should be a few tens of KB (measured
   on fixtures before the schema is frozen). A `TrackSource` (a `RenderSource`) rebuilds
   state-shaped frames with neutral defaults. The schema is versioned (`CLIP_TRACK_VERSION`), and
   golden fixtures in `src/game/clip/fixtures/` must keep decoding into frames that pass a
   render-input validator, so the schema changes deliberately or not at all.
4. **Make, upload, land, care** (04 "Sharing"): a Clip button on the Final Blow, the reel and the
   viewer; WebCodecs H.264 at 1280x720 rendered offscreen from the track and muxed with Mediabunny;
   track, video and poster to the account authority (size caps, rate limits, accounts first);
   `/c/<id>` pages in the form the unfurl test proved, with an attribution parameter for the funnel;
   blurred names as an option, owner delete, reports to the feedback inbox, 90-day expiry unless
   pinned. Kill criterion (05 §5): under 2% of matches produce a clip after six weeks means the
   local reel stays and the share pipeline stops.

## Acceptance

1. `src/game/replay/reel.test.ts`, crafted moments: selection follows the weighted score; no two
   windows overlap; a third moment by one actor only when nothing else qualifies; the decider is
   left out only after a fully watched match Final Blow; nothing under `REEL_MIN_SCORE`; match
   order. Why: the reel must show three different moments, and the player's own first.
2. Seeded duel recorded with `ReplayRecorder`: restoring from a round keyframe and stepping lands
   on the hash forward play reaches (the guarantee `seek` gives today); every prepare slice stays
   within its tick budget; a corrupted recorded hash stops the reel with `data-state="done"`.
3. `player.ts`: seeking with an injected keyframe gives the same state hash as seeking without it.
4. UI (`renderMarkup`): `results-reel` with `data-state` (`playing`, `done`, `none`),
   `data-index` and `data-count`; `results-board` absent while playing; `watch-highlights` present
   when a reel exists; Enter while playing gives `done` and leaves `quick-ready` at
   `data-state="reviewing"`.
5. Browser check (muted headless): an offline match, then results: three moments play, Skip works,
   the board appears; no prepare slice over 8 ms; the heap returns to its pre-reel size after
   leaving the results.

Measurements: the harness's reel table above, rerun with the shipped scoring, plus a human row from
playtest replays. Numbers after release: reel completion rate and Watch highlights clicks.

Playtest questions: did players watch to the end? Were the three moments the match's best? Did
anyone ask to save or send one (the demand signal for clips)?

## Open questions for the developer

1. **Where.** Full-screen highlights before the board (this spec, no canvas resize), or a small
   reel card beside the board (needs the canvas moved into a panel, a resize on every results)?
2. **The decider twice.** After a fully watched match Final Blow, leave it out of the reel (this
   spec) or keep it as the reel's last beat?
3. **Autoplay** on results, or only a Play highlights button?
4. **Clips for guests** or accounts only at first (05 §6 item 10)?
5. **Unfurl platforms.** Discord first; which others matter?

## Rollout

The reel: one release batch with [moments.md](moments.md) and [final-blow.md](final-blow.md), only on
the developer's yes. Client-only; the netcode id stays. Clips: later, starting with the unfurl test
and the id split, each on its own yes. In the same change, docs follow the code: `docs/M4.md`'s
replay section (round keyframes, the optional `moments` field, highlights in rooms), 04's reel
paragraph, and codebase-map §7 ("Replays").
