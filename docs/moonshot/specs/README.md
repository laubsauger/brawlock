# Moonshot specs

Implementation specs and design drafts for the parts of the moonshot the developer picked on
2026-10-28 ("there's a lot of good stuff in here that we can start to flesh out and work towards
specing the stuff that is clear"). Each spec was written against the code, with measurements from
the real sim and bots; the harnesses live in [../research/](../research/).

| Spec | Status | In one line |
|---|---|---|
| [shop-ready.md](shop-ready.md) | shipped in alpha.17 (2026-10-29) | Everyone Ready ends the shop: cut to 3 s, never before 6 s. Part 2: shop while out, with the round's gold paid at the knockout |
| [faster-casual.md](faster-casual.md) | implementation spec | Brisk casual: five scheduled rounds, arena capped at layer 15, a ring every 7 s, 30 gold a round; about 9 minutes a match instead of 28, builds as large as today |
| [bot-motion.md](bot-motion.md) | shipped in alpha.17 (2026-10-29) | Bots stop dancing: reversals from 1.2 to 0.3 a second, no shared think clock, inside the human band |
| [moments.md](moments.md) | implementation spec | The moments engine: knockouts and the hit that caused them, deciders, multi-knockouts, denies, reflections, close calls, long flights |
| [final-blow.md](final-blow.md) | implementation spec | The deciding hit replayed at round end (2.2 s) and match end (6 s), your own death included (a kill cam), plus the live finish zoom |
| [results-reel.md](results-reel.md) | implementation spec | The match's best moments on the results screen; clips and sharing as the later phase |
| [daily.md](daily.md) | design draft, format and rewards answered | The daily Gauntlet: five seeded waves, the day's named champion and omen, server-verified board, 15 Embers a day and 75 on every seventh day of a streak |
| [wild.md](wild.md) | design draft, picked | Wild with an omen over every round, spell reactions, Wild Hours in casual |
| [the-pit.md](the-pit.md) | parked | The fallen duel in the Pit, winner stays on; "not yet clear or convincing" |

Shared pieces: Brisk casual and the daily use the same new match settings (`arenaBase`,
`arenaCap`, `shrinkSeconds`, plus `scheduledRounds` for Brisk). The daily's omens share names with
Wild's deck. The Final Blow and the reel read the moments engine.

Build order (2026-10-29): shop Ready with shopping while out (built), bot motion (built), Brisk
casual with the arena settings, the moments engine, the Final Blow and finish zoom, the reel, the
daily Gauntlet with its rewards, then Wild. The Pit stays parked.

## Answered on 2026-10-29

- **Faster casual: "a bit more explorative."** A ring every 7 s instead of 6, and 30 gold a round
  instead of 15, so five shops buy what nine did (182 gold spent per warlock, today 171). The match
  stays at 8.9 minutes p50 with Ready ([faster-casual.md](faster-casual.md) finding 9).
- **Bots: no relabel.** Human ratings never use bot Elo; the labels only change if the calibration
  check moves one beyond its ±50 ([bot-motion.md](bot-motion.md), Calibration step 5).
- **The kill cam: yes.** The Final Blow plays when you were the victim.
- **Daily rewards: yes, with a seven-day streak.** 15 Embers a day, 75 on every seventh day, one
  grace day a week ([daily.md](daily.md), Rewards).
- **Shopping while out**, a new idea: already allowed by the sim, but a knocked-out warlock holds
  about 4 gold. The round's gold now arrives at the knockout and the knockout card offers the shop
  ([shop-ready.md](shop-ready.md) Part 2).
- **Picked:** the daily Gauntlet, Wild, the Final Blow, the finish zoom. **Parked:** the Pit.

## Open questions, with the recommended answer

Answering "defaults" accepts every recommendation below; anything else can be changed one by one.

**Shop Ready**
1. Cut to 3 s with a 6 s floor (Easy bots need 5.4 s to buy): **keep**.
2. Un-ready allowed: **yes**, as in the lobby.
3. A default key: **unbound**, the button is enough; rebindable.
4. On in ranked too (both humans must agree): **yes**.
5. Bump `PROTOCOL_VERSION` for the new command: **yes**.
6. Round gold at the knockout in ranked too: **yes**, the amount is the same for everyone.
7. The shop opening itself after your knockout: **built as a button on the knockout card instead**;
   opening by itself hid the spectator bets.

**Faster casual**
8. Tied leaders play ranked's final in casual: **yes**, same rules as ranked.
9. Embers per casual match (three times as many matches an hour): **keep 20 for now** and watch
   the economy.
10. A one-click Classic / Brisk button in custom lobbies: **yes**.
11. King of the Hill quick play unchanged in this release: **yes**.

**Bot motion**
12. Easy keeps the original AI's movement (it is already calm): **yes** (built that way).
13. Gate click-flip per second once the replay tool reports it: **yes** (built: flips/s ≤ 0.35,
    strong humans top at 0.31).
14. More human replays (ten or more players, duels and hill included): **ask regular players**.
15. The cheat risk: the repository is public, so the bot code is downloadable anyway; hiding it in
    the client bundle protects nothing. **Rely on detection later** (bot order timing is a
    fingerprint).

**Moments, Final Blow, reel**
16. Final Blow on every round for the playtest, match point only if it gets old: **every round**.
17. A 0.15 s freeze on the match-winning hit: **yes**.
18. Esc skips the replay: **yes**.
19. The replay camera is closer than play: **check the current warlock up close first**; if it does
    not hold up, use the play pitch until the character upgrade.
20. Zoom for spectators and the eliminated on any round-ending hit: **yes**.
21. Close calls confirmed after 5 s, the announcer still says it at 1 s: **yes**.
22. Long flight from 6 tiles: **yes**. Denies kept in FFA (they score low): **yes**.
23. Highlights full screen before the results table, autoplay once with a skip: **yes**.
24. Leave the match decider out of the reel after its Final Blow played: **yes**.
25. Clips for accounts only at first; the link preview test on Discord, Reddit and X: **yes**.

**Daily**
26. Unlimited attempts with Best and First-try boards: **yes**.
27. Reward amounts: **15 a day, 75 on every seventh day**, one grace day a week.
28. The streak badge (an emblem not for sale) as its own later step: **yes**.
29. The board for accounts only: **yes**.
30. A dice salt per attempt (precomputed runs do not transfer): **yes**.
31. Seven champions by weekday, a Brutal Sunday: **yes**.
32. Verifier bundles per build, so a release mid-day loses no runs: **yes**.
33. Add the arena settings now, shared with Brisk: **yes**.

**Wild** ([wild.md](wild.md), choices at the end)
34. First deck: **Blood Moon, Slick Stone, Overcharge, Sudden Collapse, Meteor Shower, Pillar
    Storm**; reactions **Shatter, Nova, Fork**.
35. **Custom lobbies first**, Wild Hours in casual after the playtest.
36. **Scene effects only**, no sky or fog tints (the lighting is approved).
37. Second Chance: **out of the first deck**.
