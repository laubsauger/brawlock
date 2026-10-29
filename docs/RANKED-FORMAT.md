# Ranked match format

This format shipped in release `a03358d76509` on 2026-10-19. See the [release record](../deploy/releases/2026-10-19.md) for the matching client/server rollout.

Ranked uses one locked preset: eight seats, Brutal bots filling spare seats, at least two distinct human identities, and a60-second lobby once the second human joins. Additional humans replace lobby bots; new ranked admission closes when the match starts. Casual Quick Play remains ten players, and custom games retain their existing configurable first-to rules.

Economy tuning prepared after that release: both Ranked and Quick Play now use **50 starting gold, 15 gold per completed round, 2 per kill, and 3 per round win** (the round's gold reaches a knocked-out warlock at the knockout, so it can shop while out; win gold comes with the win) in the server defaults (previous queue settings: 40/12/2/3). The larger shared budget gives the opening build another useful option and lets everyone progress between rounds without increasing winner-only rewards. For example, Teleport, Shield, Lightning and one Fireball upgrade cost 42 gold; maxing Teleport alone costs 63. Custom/offline defaults and prices are unchanged. This tuning requires a server rollout and applies to newly created queue rooms; it does not rewrite running matches.

## Match structure

Play five scheduled scoring rounds. A sole leader wins early if every opponent's score plus all remaining scheduled rounds is strictly below the leader's score. A sole leader after round five wins the match.

If round five ends with tied leaders, only those leaders enter one final brawl. Everyone keeps their connection, identity and loadout; other players spectate and can inspect or bet. Finalists get a 15-second preparation shop (it ends early when every finalist is ready: 3 s later, never before 6 s) and a smaller arena based on their count. Nonfinalists cannot buy during that final.

The final decides the champion without adding another scoring point to the five-round total; it still grants the configured round-win gold. Terminal winners are explicit state, so results, replay seeking and missed event batches resolve the same champion. Results show the champion first even when a losing finalist has the same scoring total. Elo is per match by the result (champion first, then round wins; survival order only splits equal standings); the final's round order counts only for its finalists, and other players retain their five-round record.

There is at most one final. If it ends with no eligible survivor, the tied finalists share the championship; bets are refunded as a drawn round. This is an explicit exceptional outcome, not a chain of extra rounds or a random tiebreak.

## Counting and departures

A ranked match counts (results, Elo) with at least two distinct humans who shared it and at least two minutes of play. If the match counts, leaving it is a loss, however early the player left; rejoining before the end clears the departure. If everyone leaves before two minutes, nobody gets a result. An empty room's bots playing on add no time. Server crashes, operational aborts and operator room closures give no result. Details: [PLAYER-PROFILES.md](PLAYER-PROFILES.md#departures-and-queue-history). (Until 2026-10-21 a departure needed 60 seconds of combat to count.)

## Duration and arena

The target is roughly15–20minutes; dominant wins and fast rounds can finish earlier. Normal ranked rounds collapse a layer every8seconds, reaching zero safe floor after160seconds from the full eight-player arena. Custom/casual retains10seconds per layer. The final starts at layer `min(15, 9 + finalistCount)` and collapses every6seconds, with60–84seconds until zero floor depending on its size.

Existing lava damage resolves survivors naturally. No extra chase timer, survivor award or arbitrary fight deadline was introduced. A conservative max-build sustain analysis gives24.1375HP/s versus100lava damage/s, with actual maximal Shield/Rush/Drain/Pact/lifesteal scenarios verified to end after full collapse. Match times remain a target rather than a forced minimum.

## Verification

-341 simulation tests pass, including early clinch, five distinct round winners,2–2 ties, bench behavior, final disconnects, economy retention, smaller arena and defensive/healing builds.
- Three ranked real-TCP queue/rematch/identity cases pass with eight seats and the five-round preset.
- Results/tracker/history regressions verify champion order and finalist-only counting/Elo.
- A recorded final replays and seeks deterministically with preserved loadouts, scoring totals and winner.
- Actual renderer/HUD checks at1280×900 and390×844 show the final roster, smaller arena, nonfinalist spectator notice and available betting without horizontal overflow.

The combined frozen source must still pass the broader prediction gates before commit/deployment; see artifacts/prediction-release-gate.md.
