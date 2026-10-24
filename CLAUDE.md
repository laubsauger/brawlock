# brawlock: project notes

Browser remake of Warlock / Warlock Brawl. Plan: `docs/PLAN.md`. Original mechanics reference: `docs/research/` (`spells.md`, `systems.md`, `assets.md`, `tech.md`).

## Rules

- v1 is faithful to the original numbers and rules. Deviations are listed in `docs/PLAN.md` §2; anything else that differs needs a reason in the code comment.
- Standalone game, not a mod: every setting has real UI. No chat or console commands.
- Never copy code, text or art from the original repo (no license). Re-implement from the research docs.
- AAA presentation bar: readable effects, smooth 60+ fps, polished flow.

## Architecture

- `src/sim/`: pure deterministic TypeScript. No three, React, DOM, net, `Math.random`, `Date`, `performance`. Engine trig only via `sim/math.ts`. State is plain data (`SimState` in `sim/types.ts`). API: `createMatch`, `step` in `sim/index.ts`. 60 Hz fixed step; original per-tick constants (0.035 s) are converted.
- `src/net/` + `src/game/session.ts`: PeerJS for signaling; reliable channel for lobby/control, raw unreliable channel (`ordered: false, maxRetransmits: 0`) for gameplay. Host-authoritative.
- `src/bots/`: bots return `InputCommand`s from `SimState`, same pipeline as humans.
- `src/render/`: r3f + `three/webgpu` + TSL. Reads `game/frame.ts` imperatively in `useFrame`. Never put per-frame data in React state.
- `src/ui/`: React screens and HUD. zustand (`game/store.ts`) with narrow selectors. HUD numbers update from rAF via refs.
- `src/audio/`: thin WebAudio layer, buses, mute.
- Units: original game units (pawn radius 30). Render scale `WORLD_SCALE = 0.01`.

## Commands

- `npm run dev`, `npm run build`, `npm test`, `npm run typecheck`
- Deploy: push to `main`, GitHub Actions publishes to Pages.

## Testing: selective by default

The full suite and a cold typecheck take minutes. Run what covers the change:

- After an edit: `npx vitest run <touched files/dirs>` (or `npx vitest run --changed`), plus the suites that use the changed module. `npm run typecheck` in the main tree is incremental; never run a cold `tsc -b` in a fresh worktree or export just to re-check code that already passed.
- Full `npm test` only when asked, for a release, or when a change reaches far into shared core (sim rules, net protocol, session flow used everywhere). Not as a routine end step: a specific, smaller change gets its own suites only. Never again for the same diff on another base, after a commit-only step, or to re-check unchanged code.
- A test that takes more than ~2 s is a cost to fix (shorter simulated time, fewer seeds, earlier exit once its condition holds), not to accept.

## Gotchas

- Bare `three` is aliased to `three/webgpu` in Vite (one three instance). Tests run without the alias.
- WebGPU first; three falls back to WebGL2 automatically. Keep the fallback working.
