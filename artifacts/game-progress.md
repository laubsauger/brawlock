# Combined release — 2026-10-19

Previously deployed: a0ae2e044221, protocol7/netf5e7a2c073f1 on Pages +USWest.

The user explicitly authorized the combined commit/push/deployment and has confirmed the other prediction/cast-feedback thread is finished. Its changes are included in the combined release gate. Preserve all concurrent edits; never checkout/reset.

## Current implementation

- Room-wide reliable chat across lobby/match/results, bounded history, host-owned identity, rate limits and protected typing.
- Casual Quick Play never changes Elo; separate fixed-rule Ranked waits for two distinct humans, then a60-second lobby, eight seats and Brutal bots. New ranked admission closes once started; authenticated reconnect proofs retain seats.
- Ranked now has five scheduled scoring rounds, early clinch and one smaller-arena leaders-only final; see docs/RANKED-FORMAT.md.341 sim tests, dedicated ranked cases, finalist-only ratings/results regressions, deterministic final replay/seek and actual desktop/phone HUD proof pass.
- Shared global ratings: existing US SQLite is canonical; EU sends authenticated HTTPS mutations through a durable outbox. Atomic receipts prevent double rewards after retries/lost replies. Delayed saves cannot override a later explicit lobby transition.
- Wider tabbed settings; first-run suggested name+preferred color; profile editor; preferred colors requested at lobby entry without stealing another human's color. Stats unifies leaderboard access; profile Elo shortcut and footer credits.
- Betting choices fit a3×3 grid; knockout feedback higher; seven-level progression table fits its hover card.
- Winner camera holds until phase boundary and returns once; forward replay seeks do not retain another round's shot. Floor albedo lifted about4%.
- Ten-warlock menu tableau; old sparring scene retained at ?menuScene=sparring, reduced-motion static composition.
- Shoulder facing cue retains its player-color panel and chevron, with a softer transition, thinner woven line and no chevron emission; avoids the bright diagonal strip amplified by bloom.
- Quick Play's prominent action line states whether it creates a public game with bots or joins an existing lobby/match; casual/no-Elo rules remain visible alongside the regional badge.
- Explicit authenticated TURN configuration replaces broken bundled PeerJS TURN hosts. Credential issuer limits origins/rate/TTL, client caches until renewal, long-lived hosts refresh credentials without dropping existing channels.
- Deployment kit preserves protected config/secrets/data and requires the dedicated unprivileged runtime. Internal rating proxy body limit aligned with128KiB backend contract.

## Infrastructure staged/live components

- Additional AmsterdamEU host167.99.216.102 provisioned only for Brawlock. US147.182.251.185 retained; other US apps untouched.
- Both us.brawlock.osc.link and eu.brawlock.osc.link TLS ready; old brawlock.osc.link alias retained.
- Both hosts have brawlock user +enabled pm2-brawlock service, protected regional config/rating token/TURN secret. US Brawlock is STILL on its original root PM2 until coordinated migration; EU game bundle not started. Existing US ratings remain in place.
- Authenticated coturn is live on EU, nonroot, UDP/TCP3478/TLS5349 and a bounded relay range. Private/loopback/link-local targets denied, coherent96-allocation quota/120-port range/64KiB per-link and6MiB aggregate bandwidth budget configured; no anonymous allocation. Real UDP/TCP/TLS payload and Chrome unreliable datachannel checks passed from the phone hotspot, selected relay candidates both ends. A separate54-simultaneous-allocation proof (ten-player star, three transports) relayed all54 payloads and released every allocation.
- The user has confirmed the combined source is ready. Final immutable build and verification precede the coordinated deployment. Infra audit/scripts are local under /private/tmp/brawlock-eu-infra-audit; contain protected operational evidence, never stage secrets.

## Verification so far

-35/35 latest dedicated TCP tests pass (156seconds, after ranked8/final and global rating updates): chat/waiting seat, ranked identity/countdown/rematch, shared ratings/recovery and ICE HTTP.
- Focused session/rating/ICE tests pass; typecheck and client build pass.
- Real two-browser clients chat in lobby +shop; sender labels/literal markup/Enter/no game input verified.
- Real victory camera return sampled45→55.41degrees monotonically through shop boundary; clears after~.8seconds, no reversal.
- Responsive browser QA passed: menus fit1440×900/1280×720/390×844; all five settings tabs, first-run identity/profile editing, nine betting choices and ten-player KO strip at desktop/phone/landscape UI scales1/1.2; Grip/Fireball seven-level cards fit without inner scrolling.42 focused UI tests, typecheck and diff-check pass. Fifteen final UI captures archived.
- Latest pre-release combined unit snapshot passes1181/1181 across110 files; earlier four prediction-event failures are resolved in this checkout. See [prediction-release-gate.md](prediction-release-gate.md). The other thread is now declared done; verify/build the final frozen source and rerun dedicated checks.
- Composed chat/betting stacking and pointer input are verified. User then explicitly scoped gameplay to desktop: touch-only devices are menu-only, with mouse/keyboard notices and UI+session guards for offline/host/queues/invites/rejoin. Menu/music/settings/stats/guides/replays remain accessible. Latest unverified landscape match-polish edits were precisely removed; do not continue mobile gameplay QA.
- Nemesis skull pips now participate in the badge name row; border encloses them, names retain4px clearance, and width estimates include kills. Real desktop rendering verified1/3/12kill presentations.
- Shoulder material verified at a frozen pose before/after, through movement/casts, and across four player colors at gameplay scale. A separate tiny pre-existing tunic/arm seam remains: experimental cap deletion was fully removed because eliminating its boundary would risk visible garment holes. Those experimental screenshots do not represent shipped geometry.
- Final accepted-source non-TCP suite:1181/1181 across110files. Production build under `/brawlock/` passes; actual desktop splash→menu→solo lobby→ten-player Brutal fight, movement and Fireball cast verified with no page/asset errors. Desktop menu fits1280×720 and1440×900; Quick Play empty/existing/error states verified.
- Final dedicated TCP suite:35/35 pass after a test-only owner-lobby readiness correction; no extra timeout or production change. Both hosts passed read-only deployment preflight: US has no connected clients, existing ratings/other-app inventory intact; EU services and protected configuration ready.

## Local capture archive and next sprint

Ignored gallery: media/session-2026-10-18/index.html; refresh with python3 media/collect-session.py. Includes recent screenshots, before/after evidence and motion clips; originals retained and manifest records sources. Entire /media/ is gitignored and user-deletable.

Next release: [account identity and reserved names](../docs/ACCOUNT-IDENTITY-PLAN.md), then [persistent earned progression currency](../docs/NEXT-SPRINT.md). Neither is implemented in this release.

## Ability readability pass — current thread

- All28 abilities audited:20 cancellable windups and8 instant abilities. See docs/ABILITY-READABILITY-AUDIT.md and artifacts/ability-readability/README.md.
- Attached hand/body signature pass implemented; warm projectile charges now differ by shape, Gravity has a palm spiral, old detached charge forms/free motes removed. Correct spell palette drives sleeve runes. Cancel extinguishes inward; committed release remains the first outbound object/flash.
- Scourge local-only pose/radius contract preserved, with visibility/cancel regressions. Previous prediction cancellation boundary retained;118 focused VFX/sim/predictor/session tests, typecheck and production build pass.
- Normal-camera and lowFX/reduced-motion captures cover20 windups. Local comparison gallery at /artifacts/ability-readability/index.html; motion/grayscale/POV review complete; controls and captures verified. No git commit or deployment performed by this thread.
