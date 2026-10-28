# Moonshot specs

Implementation specs and design drafts for the parts of the moonshot the developer picked on
2026-10-28 ("there's a lot of good stuff in here that we can start to flesh out and work towards
specing the stuff that is clear"). Each spec was written against the code, with measurements from
the real sim and bots; the harnesses live in [../research/](../research/).

| Spec | Status | In one line |
|---|---|---|
| [shop-ready.md](shop-ready.md) | implementation spec | Everyone Ready ends the shop: cut to 3 s, never before 6 s |
| [faster-casual.md](faster-casual.md) | implementation spec | Brisk casual: five scheduled rounds, arena capped at layer 15, a ring every 6 s; about 9 minutes a match instead of 28 |
| [bot-motion.md](bot-motion.md) | implementation spec, prototype in [research/bot-motion-prototype/](../research/bot-motion-prototype/) | Bots stop dancing: reversals from 1.2 to 0.3 a second, no shared think clock, inside the human band |
| [moments.md](moments.md) | implementation spec | The moments engine: knockouts and the hit that caused them, deciders, multi-knockouts, denies, reflections, close calls, long flights |
| [final-blow.md](final-blow.md) | implementation spec | The deciding hit replayed at round end (2.2 s) and match end (6 s), plus the live finish zoom |
| [results-reel.md](results-reel.md) | implementation spec | The match's best moments on the results screen; clips and sharing as the later phase |
| [daily.md](daily.md) | implementation spec | The daily Gauntlet: five seeded waves, the day's named champion and omen, server-verified board |
| [wild.md](wild.md) | design draft | Wild with an omen over every round, spell reactions, Wild Hours in casual |
| [the-pit.md](the-pit.md) | design draft | The fallen duel in the Pit, winner stays on; offline test first |

Shared pieces: Brisk casual and the daily use the same new match settings (`arenaBase`,
`arenaCap`, `shrinkSeconds`, plus `scheduledRounds` for Brisk). The daily's omens share names with
Wild's deck. The Final Blow and the reel read the moments engine.

Suggested build order: shop Ready (small, wanted), bot motion (prototype exists), Brisk casual with
the arena settings, the moments engine, then the Final Blow and finish zoom, the reel, the daily.
Wild and the Pit wait for their tests in [../05-roadmap.md](../05-roadmap.md).

## Open questions, with the recommended answer

Answering "defaults" accepts every recommendation below; anything else can be changed one by one.

**Shop Ready**
1. Cut to 3 s with a 6 s floor (Easy bots need 5.4 s to buy): **keep**.
2. Un-ready allowed: **yes**, as in the lobby.
3. A default key: **unbound**, the button is enough; rebindable.
4. On in ranked too (both humans must agree): **yes**.
5. Bump `PROTOCOL_VERSION` for the new command: **yes**.

**Faster casual**
6. A ring every 6 s or 7 s: **6 s** (every target met at p50); 7 s is the fallback if it feels rushed.
7. Tied leaders play ranked's final in casual: **yes**, same rules as ranked.
8. Embers per casual match (three times as many matches an hour): **keep 20 for now** and watch
   the economy.
9. A one-click Classic / Brisk button in custom lobbies: **yes**.
10. King of the Hill quick play unchanged in this release: **yes**.

**Bot motion**
11. Accept each tier up to about 50 Elo weaker against its old self, then relabel: **yes**.
12. Easy keeps the original AI's movement (it is already calm): **yes**.
13. Keep Medium = 1000 as the anchor when relabelling: **yes**.
14. Gate click-flip per second once the replay tool reports it: **yes**.
15. More human replays (ten or more players, duels and hill included): **ask regular players**.
16. The cheat risk: the repository is public, so the bot code is downloadable anyway; hiding it in
    the client bundle protects nothing. **Rely on detection later** (bot order timing is a
    fingerprint).

**Moments, Final Blow, reel**
17. Final Blow on every round for the playtest, match point only if it gets old: **every round**.
18. A 0.15 s freeze on the match-winning hit: **yes**.
19. Replay your own death (a kill cam): **yes**.
20. Esc skips the replay: **yes**.
21. The replay camera is closer than play: **check the current warlock up close first**; if it does
    not hold up, use the play pitch until the character upgrade.
22. Zoom for spectators and the eliminated on any round-ending hit: **yes**.
23. Close calls confirmed after 5 s, the announcer still says it at 1 s: **yes**.
24. Long flight from 6 tiles: **yes**. Denies kept in FFA (they score low): **yes**.
25. Highlights full screen before the results table, autoplay once with a skip: **yes**.
26. Leave the match decider out of the reel after its Final Blow played: **yes**.
27. Clips for accounts only at first; the link preview test on Discord, Reddit and X: **yes**.

**Daily**
28. The Gauntlet rather than the cheaper Duel: **Gauntlet**.
29. Unlimited attempts with Best and First-try boards: **yes**.
30. Embers for the daily: **none at first**; streak rewards later.
31. The board for accounts only: **yes**.
32. A dice salt per attempt (precomputed runs do not transfer): **yes**.
33. Seven champions by weekday, a Brutal Sunday: **yes**.
34. Verifier bundles per build, so a release mid-day loses no runs: **yes**.
35. Add the arena settings now, shared with Brisk: **yes**.

**Wild and the Pit** (design drafts, no defaults yet): which omens make the first deck, Wild Hours
in casual or custom lobbies only, sky tints per omen; the Pit's prize, build A or B, offline test
first.
