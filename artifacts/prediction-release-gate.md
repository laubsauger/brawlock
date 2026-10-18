# Combined release gate, 2026-10-18

The user has confirmed the other prediction/cast-feedback thread is finished and cleared the combined commit/push/deployment. Do not revert or overwrite that work. Earlier snapshots below document the investigation; final frozen-source gates supersede them.

Current snapshot: 35 dedicated-server TCP cases pass (`/private/tmp/brawlock-final-tcp.log`). The broader unit run has 1110 passing tests and four prediction-event failures while `src/net/predict.ts` is actively changing (`/private/tmp/brawlock-final-unit-tests.log`).

Reproduction: `npm test -- src/net/session.predict.test.ts`

- Event delivery beam/explosion/death/damage, RTT200/10%loss/seed23: one duplicate event (`:981`).
- Recharge chains RTT200/10%loss/seed32: five extra cast and projectileSpawn events (`:1162`).
- Cluster/Twin/Splitter RTT80/10%loss/seed33: one extra castCancel (`:1162`).
- Cluster/Twin/Splitter RTT200/10%loss/seed34: six extra casts and twenty extra projectileSpawn events (`:1162`).

The release must rerun the final frozen snapshot's unit, dedicated TCP, typecheck and build gates after that thread resolves these. Source can change after this report; treat these as observations, not a final verdict.

## Updated combined snapshot

A later combined run after the other thread's predictor edits passed all1141 tests across106 files outside `src/net/dedicated.test.ts`: `/private/tmp/brawlock-ranked-combined-tests.log` (2026-10-18,22:57local). The four earlier event failures are resolved in this observed checkout. Typecheck and server build also pass. This does not lift the user's explicit release hold: wait for their confirmation that the parallel thread is done, then verify/build the final immutable revision and run the dedicated gates for it.

Final observed snapshot:1181/1181 non-TCP tests across110files pass (`/private/tmp/brawlock-current-final-tests.log`) and35/35 dedicated TCP cases pass (`/private/tmp/brawlock-current-final-tcp.log`). Typecheck/client build pass; touch-only menu gates and desktop nemesis badge clearances have browser proof. Release remains explicitly on hold pending the user's parallel-thread completion signal.

The completion signal has now arrived. The release gate reruns the combined unit and dedicated TCP suites against the accepted source, then builds matching production client/server artifacts from the release commit. Local evidence binaries remain ignored and are archived in `media/session-2026-10-18/`.

Final accepted source (2026-10-19):1181/1181 non-TCP tests across110files and35/35 dedicated TCP tests pass. The first TCP run exposed a test setup race: it issued owner commands after welcome but before lobby ownership arrived. Its setup now waits for the owner lobby, as the real UI does; focused and full reruns pass without production changes or added timeouts. Typecheck, production `/brawlock/` build and actual desktop ten-player Brutal fight/movement/cast smoke pass. Logs: `/private/tmp/brawlock-release-final-unit.log`, `/private/tmp/brawlock-release-final-tcp.log`, `/private/tmp/brawlock-release-production-build.log`, `/private/tmp/brawlock-production-smoke.log`.
