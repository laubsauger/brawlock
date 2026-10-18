# Multiplayer, presentation and shop session

Committed and deployed at the user’s later explicit request: **6cd960a**. Client: https://laubsauger.github.io/brawlock/ . Dedicated server: protocol **6**, netcode **73190d1c8b01**, healthy. No checkout or reset performed. Separate audio-feedback assets, tools, docs and selected SFX edits remain unstaged for the other agent.

## Multiplayer and identity

- Local and remote players retain shared simulation prediction. Bot decisions already delayed by their reaction time are now published before execution, reducing speculative wrong turns without adding remote presentation delay.
- Quickplay reuses public games with available or replaceable bot seats. A joining player reserves a seat, watches the current round finish, and activates next round. Waiting, activation, joins and departures are communicated in the browser and match HUD. Leaving while waiting releases the reservation.
- Persistent records, reconnects, payouts and renamed players resolve by profile/device identity. Names update in the live session and leaderboard while past match records retain their historical labels. Duplicate active identities cannot steal another profile’s seat.
- Bot targeting uses opportunity, soft crowd pressure and fading retaliation rather than fixed chase timers, spacing rules or chaser caps.

## Shop, HUD and onboarding

- Bottom toolbar is a single compact icon row, with redundant HP/knockback readouts removed. Cooldowns use large numbers and radial progress.
- Spell columns have distinct subtle category colors, a choose-one cue, selected states and clear upgrade behavior. Spell icons share the left-hand item icon size.
- Ability, item and mastery cards retain current-to-next comparisons and now include the entire level progression without buying. Long tables scroll; cards fit the viewport and support pointer and keyboard interaction.
- Hover cards and Character Sheet values include the owner’s mastery, level, item effects, relevant active effects and public match multipliers. Fixed-range exceptions and actual projectile travel caps follow the simulation. Target-dependent values are identified.
- Loadout inspection works while shopping or spectating. Shopping shows the last committed combat build, explicitly labeled; current purchases and masteries remain hidden. Tooltips use that same saved build. Living opponents cannot be inspected during combat. This is presentation privacy, not server-side secrecy: shared simulation state still contains the builds.
- First-play guide intercepts play actions before matchmaking, hosting or offline startup. It uses four existing clips, can be skipped, remembers completion and stays available from How to play. Established players bypass automatic onboarding.
- Main menu has clearer play/browser hierarchy, a profile editor, larger gently glowing logo and icons for secondary actions. Background sparring uses the real simulation and a restrained moving camera; reduced motion keeps it static.

## Combat and round presentation

- Small impacts keep an upright bounce; strong sustained displacement can launch the warlock. Launch clips no longer restart repeatedly, and late confirmed death causes do not rewind the death animation.
- Confirmed local deaths have stronger feedback and a cause recap. Round epochs prevent stale corpse state from carrying into a later round.
- The last killer gets a subtle personal red health-bar outline, retained across rounds and name changes but never inherited by a replacement occupant.
- Living round winners perform a summoning celebration. A sole survivor gets a modest front-facing full-body camera move during the existing round-end interval. Reduced motion disables the camera move.
- Confirmed shield ownership reversals get a short inward/outward filament accent. Collected bounties transfer a bounded gold effect toward the collector and show the exact credited amount.
- Results select up to five varied, evidence-based praise and roast facts, including shield returns, environmental kills, demolition, streaks, repeated misses and substantial rivalries. Sample thresholds suppress empty or misleading awards.
- Floor is slightly brighter; lava uses existing shader noise for broader swells and bubbles. Charge-up rings emphasize the final moment while reducing particle emission. Cape mantle geometry is slimmer at the upper back with existing body collision preserved.
- Lavafalls have more irregular cooled banks and hot threads. Environment props are divided into conservatively bounded sectors so unseen geometry can be culled.
- Earlier synthesis work added low-mid weight and reduced brittle clicks/source counts. The subsequent audio-feedback round is handled separately; no subjective listening approval is claimed here.

## Spectator wagers and bounties

- Dead human players can place one immutable 1-gold pick per round while at least two teams remain alive. Stake, target, round and duplicate commands are validated by the simulation.
- A correct pick returns its stake plus at most 1 bonus gold, while the pool lasts. Remaining gold becomes a next-round bounty on surviving round winners. Bounties accumulate until an attributed kill claims them; identity changes cannot redirect ownership or held credits.
- Draws refund stakes. Disabling bounties refunds unmatched losing stakes instead of silently destroying them. Betting and bounties have independent host settings; neither applies in deathmatch.
- Bounty value sits beside the overhead name without adding another vertical HUD row. State, command validation and settlement survive prediction, replay and late/resend handling.

## Reference behavior preserved

The reference actively heals accumulated knockback points by nominal healing / 2, including healing at full HP; passive HP regeneration is separate. The user confirmed preserving this behavior. Regression coverage was added without changing the healing rules.

Reference: [Warlock pawn healing implementation](https://github.com/warlockbrawl/warlock/blob/1cc00c90b960fe77772d61b24083f238554006c4/game/dota_addons/warlock/scripts/vscripts/base/pawn.lua#L219-L225).

## Measured evidence and limits

- Scripted bot turns at about 160 ms RTT and 10% packet loss: mean remote error 28.12 → 0.26 units; largest displayed step 28.14 → 4.02 units; local input reaction 5 ms. This isolates the network mechanism, not a full human multiplayer playtest.
- Eight-player stream: 18.8 KB/s versus 221.0 KB/s snapshots; ten-player: 24.7 versus 265.3 KB/s. Existing ≥10× bandwidth gate retained.
- Seeded FFA mean largest target pile: hard 2.11 → 1.91, mixed 2.09 → 1.89, brutal 2.44 → 2.10. Weakest-victim kill share was mixed; no blanket claim of reduced finishing.
- Same-view environment comparison: 83 → 86 draw calls, 126,024 → 112,804 scene triangles; environment triangles 46,650 → 33,430. Authored geometry unchanged; sectorization costs roughly 2 MB additional vertex buffers. Both samples held 60 FPS; no GPU timing improvement is claimed.
- Character remains 12,145 triangles and five preview draw calls. Cape checks covered idle, run, turn and celebration from three angles. Motion fixture reduced five clip restarts in 1.5 seconds to one launch.
- Browser checks used one existing isolated Chrome process, with sequential fixtures. Verified responsive menu/shop/HUD, guide entry and cleanup, celebration and rival marker identity, wagers and collection, results, and ability progression. Synthetic fixtures supplement, rather than replace, human online playtesting.

Review captures: [menu](polish-session/menu-desktop.png), [mobile menu](polish-session/menu-mobile.png), [shop](polish-session/shop-desktop.png), [mobile shop](polish-session/shop-mobile.png), [victory](polish-session/victory.png), [bounty collection](polish-session/bounty-collection.png), [results](polish-session/results.png), [mobile results](polish-session/results-mobile.png), [ability progression](polish-session/progression-desktop.png), [mobile progression](polish-session/progression-mobile.png).

## Verification

- Latest non-dedicated run: **83 files / 949 tests passed** (18.66 s), including the final tooltip and pointer-travel regressions.
- Dedicated server integration run: **26 tests passed** (93.70 s), covering real loopback room reuse, reservation, next-round activation, renaming, database cache and restart behavior. No network runtime code changed after that run; the later simulation stats edit only widens readonly input types.
- Total verified: **84 files / 975 tests**, across those two runs.
- Client production build (including TypeScript) and dedicated-server production build passed. Existing Three/R3F and large-chunk warnings remain. Whitespace checks passed.
- Actual browser progression check passed: seven future levels, effective Duration, pointer travel across other icons, horizontal scrolling, keyboard entry/exit, no preview purchases, live upgrades, and bounded desktop/narrow-screen layout. The isolated verification browser was closed afterward.
- No required implementation work remains in this session’s scope. A human high-latency multiplayer playtest and listening review remain useful release review, not completed automated proof.

## Menu music and live release

- Added both supplied Circle of Ash songs as one streaming MP3 queue, with first-song-only splash preload. The second song waits until its turn. Source audio was copied without re-encoding, removing only cover art and metadata.
- Fresh-install music volume is 50%; saved choices and mute still apply. Menu navigation is continuous; entering a match fades and pauses, returning resumes the same position with a fade-in. Hidden tabs pause playback.
- Browser verification passed for real preload/gesture start, queue 1 → 2 → 1, lobby continuity, match fade/pause, position-preserving return and a single song player.
- Exact staged release validation: **956 tests / 84 files passed**, then **26 dedicated integration tests passed** after fixing their predicted-versus-confirmed combat-entry synchronization. Total **982 tests / 85 files**. The initial combined run exposed those two test timing races; production joining rules did not change for that correction.
- Exact staged client build and deployed GitHub Pages build passed. Existing dedicated deployment script built and reloaded the server from the same commit, preserving leaderboard data.
- Commit: [6cd960a](https://github.com/laubsauger/brawlock/commit/6cd960a60403a9c386d0dbd1a4a61d8d018fa8e1). [Client deployment](https://github.com/laubsauger/brawlock/actions/runs/39151787244) succeeded.
- Live-page smoke passed: client version `6cd960a60403`, server protocol `6`, netcode `73190d1c8b01`, Quick Play enabled, first song served under the Pages base path and playing after Enter, one song player, no page errors. No public test room was created.

[Playtest build](https://laubsauger.github.io/brawlock/). Refresh existing tabs before testing.
