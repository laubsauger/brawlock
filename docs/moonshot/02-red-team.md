# 02 · Red team

Phase 2 of the moonshot series. Written 2026-10-28 by a critic who did not write
[00-moonshot.md](00-moonshot.md) or [01-ground-truth.md](01-ground-truth.md) and was asked to find
out why the plan fails before a year goes into it. Sources: the three files in
[research/](research/), `docs/PLAN.md`, `docs/NEXT-SPRINT.md`, `docs/M4.md`,
`docs/RANKED-FORMAT.md`, `docs/PROGRESSION.md`, the project memory, and read-only checks of the
code, git history and `artifacts/analytics/report.json`. 01's verdicts were treated as claims;
where I re-checked one, the file and line are given.

---

## 0. Evidence this review adds

1. **The population evidence is thinner than 01 treats it.** The only snapshot covers two days
   (tracking began 2026-10-19): 77 new browsers, one guest-to-account conversion, three accounts.
   Unique humans in dedicated-server matches were EU casual 3, EU ranked 2, US casual 3, US custom
   3: at most seven distinct people (3 accounts, up to 4 guests). Of 10 casual matches, 6 were
   abandoned. Nothing in `server/` or `src/net/` filters the developer's or agents' headless
   browsers, so 77 is an upper bound (backlog §4's "81" sums daily `seen`). Current numbers are
   on the Operations dashboard; neither 00 nor 01 pulled them.
2. **The build lock is wider than 01 says.** `scripts/net-id.mjs` hashes all 36 non-test files in
   `src/net`, server-only code included (`server.ts` queue presets, `globalChat.ts`,
   `leaderboard.ts`), plus the cosmetics catalog `src/game/progressionCatalog.ts`. 90 of the 242
   commits since 2026-10-15 (37%, about seven a day) changed a hashed file. A queue tweak or a new
   hat orphans every stored replay and forces every client to reload.
3. **Original design, not code, is the slow part.** King of the Hill's first sim commit
   (`7667752`) landed 2026-10-25 11:53 and was in the casual queue at 12:25 (`4b96afd`). Then: 19
   hill commits in 35 hours, five capture times, a seal patch still uncommitted on 10-28, and
   match length still open (NEXT-SPRINT §7). Implementation took half an hour; four days of design
   iteration have not converged. 01's labels "include tests, not playtest iteration": they omit
   the cost the only original-design precedent shows to dominate.
4. **01's own labels add up to two to four years of one person.** Summing every row of 01 §2 and
   the §3 prerequisites (S 0.2-0.4, M 1-1.5, L 3-4.5, XL 6-9 weeks; thirty reactions as S sim plus
   S VFX; six arenas at M-L; six spell skins) gives about 100 developer-weeks at the low end of
   each label and 185 at midpoints, before playtests, music, art, voice, ops and moderation. One
   person has about 46 working weeks a year.
5. **The best bot ships in every client.** `src/game/session.ts` and `src/render/menuStage.ts`
   import the bots. M4 §8 names input automation as the one cheat left ("Detection only") and
   says "There is no fog of war, so there is no map hack". No detection exists.

---

## 1. Pre-mortem

It is October 2027 and the moonshot failed. Five ways it happened.

**A. The cathedral with no congregation.** The year went into prerequisites that 01 §3 says
players never see (tile model, mode framework, state ring and director, sim versioning), then
arenas, chemistry, the Pit and a Discord Activity. Nobody owned acquisition: still no social
channel (`docs/FEEDBACK.md`: "Social links are not guessed"), no retention metric, no contact with
the Warlock Steam group or the Dota workshop item's 644k subscribers (backlog §6). Each launch drew
the same few dozen people. Because every queue fills with bots, the split across casual, hill,
ranked, Blitz and new arenas in two regions never showed: every human got a full lobby, of nine
bots. Peak online stayed in the tens, the Battlerite tail (frontier §1). It became the
best-looking single-player bot brawler on the web, and nobody could say which bet had failed.

**B. Original design did not compress.** The 13-day build re-implemented a known game against 545
pinned values; agents are fast at that. The moonshot is almost all original design, and its one
precedent (KotH) did not converge in four days. The tile model took three times its L because
about 13 bot call sites, `bots/predict.ts` slides and a ladder already recalibrated nine times in
12 days moved with it. Each reaction then needed sim rules, VFX at the AAA bar, a tame level-1
variant, bot knowledge (bots fill 9 seats in 10; a reaction they cannot use or avoid is invisible
or a free exploit), announcer lines and a playtest. By month nine: the tile model, two arenas,
eight reactions, all off in ranked and the Caldera, and a queue of taste calls (music, lighting,
skins, names) waiting on the one person who approves them.

**C. Discord was the right door into the wrong room.** The Activity shipped in month six after
token auth, proxy mappings and a security review. People in the call on phones could not play
(Discord runs Activities on mobile; Brawlock is desktop only). Desktop players got WebGL2 at Low,
because nobody had checked WebGPU inside Discord's client (codebase-map §9). A group of five got a
ten-seat FFA in which five bots took most of the kills. The groups that liked it brought a spike
two 2-vCPU hosts could not hold: player rooms stall near 24 per host, bot-filled rooms are the
most expensive per human, shards were never merged (NEXT-SPRINT §2-3). Launch weekend was stall
weekend, and word of mouth gives no second launch. (The quiet version: about 2,000 players in the
first month, like Word Rummy in frontier §3, then nothing.)

**D. Nothing anyone shared still played.** Clip links, ghosts, the Daily Gauntlet and "Play from
here" all ride on replays, and a replay plays only on the build that recorded it. Sim versioning
(M to L) kept losing to features. With the netcode id moving on 37% of commits, cosmetic and queue
edits included, a clip posted on Friday asked for an older build by Monday. Rendered MP4 clips did
not unfurl as players in Discord (frontier §3: unproven, picky about codecs). The loop the north
star depends on ("one in five produces a shared link") broke quietly, and with no link-click
metric nobody noticed for months.

**E. The core lost its owners.** To keep human queues from splitting, new rules leaked into
default play: the Pit's curses and gold purses, Director-timed arena events, chemistry in casual.
Ranked kept the Caldera, but ranked was two humans and six Brutal bots whose leader focus and
grudges (NEXT-SPRINT §4) decided which human won, and a userscript wiring the shipped Uber bot into
a player's own inputs was enough to farm it. Warlock veterans, the one audience with an existing
reason to come, found neither the original nor a fair ladder. PLAN's gate ("innovation comes after
v1 ... feels right") never got a criterion (backlog §5), so it was never passed, only bypassed.

---

## 2. Bet by bet

### Bet 1 · A living arena and spells that talk to each other

**Strongest argument against.** It is the most expensive bet (about 27 to 57 of the summed
developer-weeks) and the one that most needs a community: reactions "discovered by players, named
by the community, clipped and shared" assume the crowd the evidence says is missing. The players
it should reach first, veterans and ranked players, will switch it off, as Smash rulesets switch
hazards off (frontier §2), so it lives outside the Caldera and ranked, in a queue that splits a
single-digit population. And since bots fill nine seats in ten, every reaction is first a bot-AI
feature.

**Hidden assumptions.**
- Reactions happen often enough in a ten-player FFA to be discovered. Lightning already detonates
  Fireballs (`sim/spells/lightning.ts`); nothing measures how often that happens.
- The tile model is L. It touches 40 to 50 call sites and forces a ladder rerun; smaller changes
  have moved ladder labels by up to 275 Elo (backlog §2).
- A floor of obsidian, cracks, scorches, craters and shards stays readable at the gameplay camera
  under the approved lighting and the tame level-1 rule.
- Art for six arenas fits inside "M to L each". 01 costs the rules, not the art.

**Cheap test.** Spell-to-spell reactions need no tile model. Build two or three (Lightning
shattering a Snowball, a Fireball pulled into Gravity) as a custom-lobby mutator (framework S,
each reaction S, codebase-map §4). Count reactions per match in bot-only runs; in two playtests,
ask after each round what happened. Under about one reaction a round, or players who cannot say
what happened, kills the thirty-reaction table. For arenas, The Maw's tide is the layer going down
and back up, and `Arena.setLayer` already diffs cells into sink and rise animations (codebase-map
§3): a tide mutator is S to M on the integer model, bots aside.

**Cheaper or better.** One "wild" ruleset toggle, like Smash's hazards switch, carrying the tide
and the reactions that pass, in custom lobbies and as a rotating casual playlist, not a new
queue. Fund the tile model only if players pick wild over classic.

### Bet 2 · Nobody waits

**Strongest argument against.** It treats the symptom. Waiting comes from long rounds: first kill
after about 107 s, 83% of deaths after about 11 layers (backlog §0), about 197 s per casual round
including the shop (1,671 s / 8.5 rounds), plus a 30 to 60 s lobby. The Pit builds a second game
(L, after the tile model) for players who die early in rounds that are too long; in a room of one
human and nine bots it is that human duelling bots in a side ring. Blitz's "whole match in four
minutes" fails arithmetic: a ten-player arena starts at layer 21 (`sim/mode.ts:200`, clamped), so
at double shrink speed a round can run 100 s, and first-to-3 FFA took 8.5 rounds: roughly 10 to
15 minutes.

**Hidden assumptions.**
- The fallen want a side game more than watching, betting or shopping. Fall Guys designed rounds
  to be as good to watch as to play (frontier §2).
- Pit prizes do not swing the main match. The Gulag's rocks did 1 HP and still broke duels.
- Arriving humans can take a bot seat at once. Today they enter "after the current fight"
  (`src/net/session.ts:249`), a wait of over a minute on average.
- "Ten seconds" fits the consent rules. The countdown went 5 s, 30 s, 60 s because "30 s felt
  rushed" (comment in `src/net/server.ts`).

**Cheap test.** From the match tracker, measure seconds dead per human and how many leave while
dead. Run casual for a week with a faster shrink and a smaller starting arena (exposing the shrink
period is S, 01 Bet 2) and compare abandonment (6 of 10 in the only snapshot). If dead time halves
and abandonment falls, the Pit is not needed.

**Cheaper or better.** Short rounds as the casual default: smaller arena, faster shrink, Medium and
Hard bots that stand closer to the edge than 610 units. Offer the existing respawn style as a
playlist, start quick play when one human is ready, and add the Haunting (S to M on the
`spectateBet` command path) only if dead time is still a problem.

### Bet 3 · Every match tells a story

**Strongest argument against.** Its output channels do not exist. The Director drives music nobody
has chosen (NEXT-SPRINT item 1, open since 10-20, synth ruled out as placeholder), barks that need
voice content, lighting that is approved and not to be reworked (memory
`showcase-and-look-prefs`), and a camera push onto the CC0 base character PLAN risk 9 calls the
biggest presentation weakness. It also needs Bet 5's oracle. In a lobby of nine bots the story is
mostly bots knocking out bots; a Medium bot's Fireball is no Play of the Round.

**Hidden assumptions.**
- A close-up of the warlock's face flatters the character art.
- A Director that times arena events reads as drama, not a hidden hand (frontier §5: hidden
  adjustment erodes trust).
- A video in the shop corner does not compete with a shop the vision calls "a highlight, not a
  menu" (memory `brawlock-vision`).
- Stems exist. A generated song is a full mix; stems need a composer or an untried separation.

**Cheap test.** Put the state ring and the showcase camera into offline practice only and replay
the deciding hit for two seconds at round end, skippable. Over ten playtest rounds: do players
watch or skip, and can they say who hit whom? One afternoon of the developer looking at a
close-up of the current warlock settles whether the camera push can ship.

**Cheaper or better.** The Final Blow as an instant replay, a Smash-style finish zoom at gameplay
pitch, the death recap with its chain of hits, and the announcer that exists. Defer the Director,
the adaptive score, the world and seasons until music exists and someone is watching.

### Bet 4 · Wherever your friends are

**Strongest argument against.** Distribution is the right problem, but the bet lists channels, not
a plan, and most are red in 01 (Brawlock TV, edge rooms, Covens) or deferred as business
decisions (Steam, portals). Discord, the best-evidenced, runs on phones the game does not support,
through a WebSocket-only proxy, with a third identity pool beside the site and itch. Its discovery
is word of mouth, which assumes groups already like the game. Its showcase hits are casual party
games; small developers report about 2,000 players a month (frontier §3).

**Hidden assumptions.**
- A ten-seat knockback FFA with five friends and five bots is what a voice call wants. The one
  data point says co-op beat PvP on Discord for new-user retention (Mojiworks, frontier §2).
- WebGPU works inside the Discord client; if not, the flagship channel shows the Low tier.
- Two hosts survive a launch spike, and clip links unfurl into video (frontier §3: test it).

**Cheap test.** Before the SDK, send a `?room=` link into five Discord friend groups the developer
is not in and count groups that start a match, finish it and play another. If groups in a call
will not play from a link, an in-call launcher will not save them. Alongside: a static
`og:video` page for unfurls (a day) and a hello-world Activity that reads `navigator.gpu` (S).

**Cheaper or better.** The cheapest first hundred players are the orphaned Warlock players: the
Steam group running since 2012, the Dota workshop item's subscribers, the lobbies still on WC3
Tracker (backlog §6, frontier §1). They need no SDK, know the rules, and the faithful core is what
they lost. Streamers next; frontier §3 shows that channel moved 2025's small hits.

### Bet 5 · Opponents with souls

**Strongest argument against.** The cheap half (motor model, offline oracle) is good, but the bet
misses the bots' two measured problems. Difficulty does not fit the player: guided practice ends
against Easy bots at 350 Elo while casual seats Medium at 1000 and Hard at 1825, the casual table
changed four times in eight days, and rating-based bot difficulty is "Not done" (backlog §2). And
they are passive: Hard keeps about 610 units from the edge and first kills after about 107 s. The
expensive half needs data that does not exist (01: learned bots red, ghosts yellow) and opens
integrity holes (Nexto, frontier §5). In a room of nine bots, your nemesis is a bot.

**Hidden assumptions.**
- A movement-plausibility metric can be set from the handful of humans ever recorded.
- Commitment and hysteresis leave the Elo labels in place; every bot change so far needed a
  ladder remeasure.
- Players want to fight a friend's ghost, and the friend agrees.

**Cheap test.** From replays the developer already has, compute orders and direction reversals per
second for humans and each bot tier. Add goal commitment and dodge hysteresis, rerun `LADDER=1`;
pass if bot reversals fall into the human range for under about 50 Elo. Before building Nemesis,
count human-on-human knockouts per week in tracked matches; if most players never see one, cut it.

**Cheaper or better.** Skill-matched bot difficulty in quick play from a hidden rating (M4 §3,
never built), and persistent named bot personas, labelled as bots, which can be honest rivals
without any data.

### Bet 6 · Players build the next mode

**Strongest argument against.** Workshops need makers and makers need players; the WC3 editor had
a platform of millions behind it. 01 marks the editor yellow and the Workshop red. Every community
mode would split the queue and arrive without bot support (bots key on the layer and cannot play
arbitrary arenas or rules), so in a game the bots populate, a community mode is one they play
badly. The mode framework is worth building, but for the developer, not for players.

**Hidden assumptions.** Makers exist. Content from strangers is safe because it is data (it is
deterministic, but nobody moderates its names, shapes or images). A browser editor at the AAA bar
is cheap. Room settings can carry a package (they take scalars of at most 16 characters,
`src/net/protocol.ts:397-401`).

**Cheap test.** Show the existing knobs (knockback and damage multipliers, friction, lava DPS) and
a few mutators in custom lobbies, and count over a month how many lobbies change anything. If
nobody touches the knockback multiplier, nobody will build an arena.

**Cheaper or better.** Extract `ModeRules` (M) and run a developer-curated "mutator of the week"
inside casual, with no new queue.

---

## 3. Blind spots

Ranked by how likely each is to sink the year on its own.

1. **No way to tell whether anything worked.** No retention, D1/D7, first-match completion or
   time-to-first-fight number is recorded (backlog §4); GA4 Realtime was never verified;
   analytics do not filter the developer's or agents' browsers; the only snapshot is two days long
   and nine days old. The month-12 targets have no baseline, and every kill criterion in 05 needs
   this first. Cost: S to M.
2. **No plan to find players.** 00 and 01 never say how the first hundred people arrive. No social
   channel exists, and the original community has not been contacted. Bet 4 lists platforms, not
   a plan to tell anyone the game exists.
3. **One developer, and the limit is judgment, not code.** The prompt assumed "unlimited dev
   resources"; 01 priced items in one-developer units but never added them up or scheduled them
   (100 to 185 weeks, §0). Agents compress implementation (KotH reached a queue in 32 minutes).
   They do not compress playtests, taste calls (music open eight days), approvals (level-1
   tameness, lighting, each arena) or operations (a release drains both regions for 10 to 20
   minutes). The moonshot multiplies exactly those.
4. **Money and purpose.** No revenue (Embers are cosmetic-only, no payment processor, donations
   "coming": `docs/PROGRESSION.md`, `7953878`), no budget, and no statement of whether success
   means a hobby, a portfolio or a business. Hosting is cheap (M4: about €10 to 50 a month up to
   100 CCU) and will not end the project; the developer's time and agent spend can. Discord IAP,
   portal ads and Steam are each a monetization decision the plan defers.
5. **Competitive integrity and cheating.** Ranked seats two humans with six Brutal bots whose
   targeting (leader focus, grudges) shapes which human wins. The frontier's rule "never let
   ranked contain a bot" is broken by the shipped format and not mentioned. The Uber bot is in
   every client and input automation has no detection. Ghosts and learned bots would make this worse.
6. **Capacity for success.** Player rooms stall near 24 per host, shards are unmerged, and
   one-human bot rooms cost the most per player (capacity report). A Discord or streamer spike
   lands on two 2-vCPU droplets with no spike plan and no "servers full" screen.
7. **Moderation and safety.** Global chat is only now getting report and hide. The moonshot adds
   Covens, a Workshop, uploaded clips, nemesis call-outs and ghosts of identifiable players, while
   guests can still show an account's claimed name (NEXT-SPRINT §8). One person moderates, and a
   ghost fitted from a player's matches is personal data (M4 §8 notes the GDPR cost).
8. **Desktop only versus "wherever your friends are".** Discord Activities and the big portals
   reach phones; the game refuses them (memory `no-phone-testing`). Defensible, but Bet 4 is
   written as if the choice had not been made.
9. **Legal, IP and the original authors.** The mechanics and 545 pinned values come from a repo
   with no license (memory `original-warlock-repo`). Mechanics and numbers are generally not
   protected, but a commercial Steam release with matching spell names and a name echoing
   "Warlock Brawl" deserves a trademark search and an hour with a lawyer (unverified, not in the
   research: Blizzard's 2020 custom-game terms claim maps made with its editor). One email asking
   the original authors for a blessing could also open the old community's channels.
10. **King of the Hill is broken today.** The live mode with a structural problem (hill contested
    62% of fight time, holds of 0.7 s, backlog §2) appears in 00 and 01 only as a cost precedent.
    Adding eight arenas while the one original mode does not work is the wrong order.

---

## 4. Contradictions

1. **Faithful core versus a living arena.** PLAN: "Innovation comes after v1 ships and the core
   feels right", and "feels right" has no criterion (backlog §5). The moonshot neither defines nor
   passes the gate; its rules either change default play (Pit prizes, Director events) or need
   separate queues, against frontier §1: "new modes should not split the human queue".
2. **"Ten seconds from a link" versus consent and the lobby record.** The lobby grew to 60 s
   because 30 s "felt rushed", and no player moves without their Ready. Starting with bots means
   joiners wait for the current fight to end.
3. **Blitz in four minutes versus the arena formula**: `13 + players` capped at 21 and 8.5 rounds
   per first-to-3 FFA give roughly 10 to 15 minutes at double shrink speed with ten seats.
4. **"The game freezes for a third of a second" versus the netcode.** The online sim cannot pause,
   hit-stop is capped at four frames, results open 600 ms after `gameOver`
   (`src/net/session.ts:317`). 01 caught this; the Friday-evening story still sells it.
5. **The Showdown dims the arena; the lighting is approved as is** (memory
   `showcase-and-look-prefs`: don't push lighting reworks).
6. **"A heartbeat and a low choir" versus no placeholder music**, a user who picks the music, and a
   combat soundtrack still unselected.
7. **Chemistry as spectacle versus tame level 1.** The starting kit is level 1 every round;
   reactions from it either stay tame and read weakly or break the rule. A floor that keeps
   scorches, craters and frozen trails also works against "hitbox cores above effects" (PLAN §5.2).
8. **Spell skins versus "Cosmetics change shape, never colour"** (`docs/PROGRESSION.md:21`) and the
   identity palette: a spell effect that keeps colour and silhouette has little left to skin. Each
   catalog addition also changes the netcode id, so every seasonal drop orphans replays and clips.
9. **"Nobody makes an account" versus account-only Embers, wardrobe and ranked.** itch guests are
   already a separate pool (`docs/ITCH.md`); Discord would be a third.
10. **The Hollow versus the netcode and M4 §8.** Every client steps the full state, and the
    anti-cheat stance rests on "no fog of war, so there is no map hack". Bots read it too.
11. **Friends' ghosts and nemesis call-outs versus the consent principle** that "came out of churn"
    (backlog §2): a friend's ghost is their behaviour, used without their opt-in.
12. **A weekly cadence versus the release rules.** Featured Workshop modes, weekly Cups and seasons
    against "ask before every release, ship substantial batches" (memory `release-only-on-ask`)
    and releases that drain both regions and force every client to reload.
13. **01 against itself.** Fact 1 says the audience is the constraint to *find*, yet nothing in its
    cheap wins (§4) or prerequisites (§3) finds anyone. Every green item improves the game for
    players who are not there.
14. **The plan against its evidence on PvE.** The frontier calls a solo or co-op roguelite "the
    strongest market evidence of any idea in the bank", and Discord's case study favours co-op.
    Ascension sits in the idea bank, and 01 never costs it.

---

## 5. Cut list and double-down list

**Kill for year one.**
- Edge rooms, twenty regions, "40 ms everywhere": XL, red, and more regions split a pool where US
  casual had 2 starts and 0 completions.
- Learned bots and spells as data (red in 01). The Sanctum, Brawlock TV, the Twitch channel, TV
  bets and Covens: crowd features without a crowd.
- The Hollow: unenforceable with this netcode. Lava Royale and forty-warlock Raids:
  `MAX_PLAYERS = 10` (`src/net/session.ts:305`).
- GPU fluid lava, fracture and compute cloth (no compute pass, none in the fallback), the world
  and narrative seasons, the AI caster.

**Defer until a named trigger.**
- Tile model, the Pit, six arenas, the remembering floor: until a wild-ruleset playlist shows
  players choosing it. Chemistry beyond three spell-to-spell reactions: until the frequency test
  passes.
- Discord Activity: until the five-group link test works, WebGPU in Discord is checked and shards
  are merged. Steam: until D7 retention is known.
- Durable clip links: until sim versioning or a build-free clip format exists (the local Final
  Blow and Play from here need neither). Director, adaptive score, Showdown: until music exists.
- Ghosts: until server-side style features exist for a few hundred humans. Forge and Workshop:
  until custom lobbies show people changing knobs. Spell skins: until the colour rule and the
  economy are decided.

**Keep, cheap and green in 01.** The motor model, `ModeRules`, the Final Blow as an instant
replay, Play from here, and the Daily Gauntlet (asynchronous, works at any population, needs only
the day's build kept on the server). The Haunting only if dead time persists; Nemesis only if
human-on-human knockouts are common.

**Double down.**
1. **Round length is the root variable.** The wait for the first fight, dead time, 28-minute
   matches, abandonment and the join-in-progress wait all depend on it, and existing constants
   tune it: arena size, shrink period, bot edge margins. The only recorded complaint from the
   original community agrees: "the arena shrinks too slowly with many players"
   (`docs/research/tech.md` §1.1). Targets: first death under 45 s, rounds under 90 s, casual
   matches under 10 minutes, first fight under 15 s after a click. One PLAN §2 deviation with a
   written reason, the kind the faithful rule allows.
2. **Bots are the product in most sessions: make them read as human and fit the player.** They
   fill nine seats in ten, and the menu backdrop shows them to every visitor. The motor model with
   a plausibility metric (which doubles as detection for input automation), skill-matched
   difficulty that closes the 350 to 1000/1825 cliff, and labelled persistent personas. Every
   hour here improves every session at any population.
3. **Measure, then find the first hundred.** Instrument the funnel (visit, first fight, first
   finished match, D1, D7) without developer and agent traffic. Then the cheapest channels in
   order: the orphaned Warlock community, five Discord friend groups by link, two or three
   streamers. Choose between a Discord Activity, portals and Steam once there are numbers.

Runner-up: solo and asynchronous content (Trials, the Gauntlet, later Ascension), the only content
in the bank that works at a population of one.

---

## 6. Verdict

The moonshot is a good catalogue of what a big game would want, written for an audience that does
not exist, for a team of one, with costs that leave out the one that dominates: playtest
iteration. Its own evidence says three things louder than any bet. Almost nobody plays yet (at
most seven people in the only snapshot). Matches are too slow (28 minutes, a first kill after
107 s). And bots are the opponents in nearly every session. Taken as written, the plan spends the
year on infrastructure for crowds (tile model, Pit, Director, Discord, Workshop) and fails by
story A or B. A plan that survives this critique is smaller and runs in a different order: short
rounds, bots that read as human and fit the player, measurement, and a deliberate search for the
first hundred players, with one cheap test per big bet (a wild-ruleset playlist, a link in five
Discord calls, an offline Final Blow) deciding whether that bet earns its L. If the tests pass,
chemistry, Discord and the Final Blow are still there in month four, now backed by evidence. If
they fail, the year was not spent finding that out.

## Triage

The plan's author answers the critique. Spot checks before answering: joiners do reserve a seat
"entering after the current fight" (`src/net/session.ts:249`); `MAX_PLAYERS = 10`
(`src/net/session.ts:305`); a fight starts at `13 + players` layers, clamped to 21
(`src/sim/mode.ts:219-220`); `scripts/net-id.mjs` hashes all of `src/net` and the cosmetics
catalog. All four claims hold.

**Accepted as written** (the critique is right and v2 changes because of it):

| Finding | What changes in [03-moonshot-v2.md](03-moonshot-v2.md) |
|---|---|
| §0.1, blind spot 1: no measurement; the population evidence is two days long and unfiltered | Measurement is the first work item of the year, before any bet. Every bet gets a number with a baseline, and developer and agent traffic is filtered out |
| Blind spot 2, Bet 4: no plan to find players | Finding the first hundred players becomes a bet of its own, in the critic's order: the orphaned Warlock community, `?room=` links in Discord friend groups, then streamers |
| §0.3, blind spot 3, story B: design iteration dominates and the bottleneck is one person's judgment | v2 plans in playtest cycles and decisions, not developer-weeks. Every bet starts with a cheap test that a playtest can settle |
| §0.4: 01's labels sum to two to four years for one person | v2 keeps the ambition but gates each large item behind a trigger, so the year funds only bets whose tests passed |
| Double-down 1, Bet 2: round length is the root variable; Blitz in four minutes fails the arena formula | Pace becomes keystone 1 in [04-keystones.md](04-keystones.md), with the critic's targets (first death under 45 s, rounds under 90 s, casual under 10 minutes). Blitz needs a smaller starting arena, not just a faster shrink |
| Double-down 2, Bet 5: bots must fit the player, not just stop dancing | Keystone 3 covers motor model, plausibility metric, skill-matched difficulty and labelled personas together |
| §0.2, story D: the netcode id moves on 37% of commits | Two ids instead of one: a live-compatibility id (protocol, server) and a sim id for replays that hashes only what changes simulation. Durable clips use a build-free format (keystone 2) |
| Contradiction 14: the PvE evidence is the strongest in the bank and Ascension was never costed | Co-op and solo modes built from existing bots and spells move from the idea bank into v2's bets |
| Bet 1 cheap test: three spell-to-spell reactions and a tide on the integer model, as one "wild" toggle | Adopted as the Wild ruleset: a playlist and lobby toggle, never ranked, never the Caldera. The tile model waits for players to choose Wild |
| Cuts: edge rooms, learned bots, spells as data, Sanctum, Brawlock TV, Covens, the Hollow, forty-warlock modes, GPU fluid, fracture and cloth, the AI caster | Cut from year one. The Hollow is cut outright: every client steps the full state, so fog of war would be a map hack waiting to happen |
| Story C, blind spot 6: a Discord spike lands on two hosts that stall near 24 player rooms | Shards merged and a "servers full" screen before any channel push |
| Contradiction 11: a friend's ghost is their behaviour used without opt-in | Ghosts are opt-in by their owner, and stay deferred until data exists |

**Accepted with a change:**

- **"Ten seconds from a link" versus consent and the 60 s lobby (contradiction 2).** The critique
  is right that shortening the countdown is the wrong fix: 30 s "felt rushed". The answer is to
  make the wait playable rather than shorter. A player who clicks Quick play is fighting in a
  warm-up arena within seconds; the lobby countdown, Ready and "Wait for players" stay exactly as
  they are; the match proper starts on schedule. Consent is unchanged because clicking Play is the
  consent to play. Keystone 1 designs it.
- **The Final Blow (contradiction 4).** The Friday story's live freeze is wrong for an online
  match. v2 keeps the effect as an instant replay played from a state ring during round end, plus
  a Smash-style finish zoom at gameplay pitch on the hit forecast to win the match. The sim never
  pauses.
- **The Pit (Bet 2).** Deferred, not cut: the Gulag shows it works, and the cheap measurement
  (seconds dead per human, departures while dead) decides. Faster rounds may make it unnecessary.
- **Nemesis (Bet 5).** The critic's test is right (count human-on-human knockouts first). Until it
  passes, the rival role goes to labelled bot personas, which work at any population.
- **Mutators and the Forge (Bet 6).** `ModeRules` is kept for the developer; a "mutator of the
  week" runs inside casual. Rotation should be server configuration, not a client release, so it
  does not collide with the release rules (contradiction 12).
- **Chemistry and the tame level-1 rule (contradiction 7).** Reactions scale with the level of
  the spells involved, like every other effect; a level-1 reaction is small and readable. Whether
  that still reads in play is part of the Wild test.

**Rejected or answered:**

- **"Crowd features without a crowd" includes the crowd itself.** The Haunting and live watchers
  need people; an ambient arena crowd does not. Smash's crowd is generated, not real spectators.
  An ambient crowd that cheers knockouts is presentation, works at a population of one, and is
  kept as a later presentation item. It must never pretend to be people: real watchers, if shown,
  are marked as such.
- **Spell skins versus "cosmetics change shape, never colour" (contradiction 8).** A skin can
  change shape and texture (a Fireball that is a skull, a Snowball that is a crystal) and keep the
  identity colour and the hitbox core. The critic is right that it touches the netcode id today;
  the id split above removes that. Still deferred, as an economy decision.

**Decisions only the developer can make** (v2 states its assumption for each; none is acted on
without a yes):

1. **What success means**: hobby, portfolio or business (blind spot 4). It decides whether
   portals, Steam and Discord monetization are worth their identity and ad trade-offs.
2. **Ranked with bots** (blind spot 5). The shipped format seats Brutal bots beside two humans,
   and their targeting shapes who wins. The frontier's rule "never let ranked contain a bot" and
   the population pull in opposite directions.
3. **A round-length deviation** from the original arena size and shrink period for casual. PLAN
   §2 allows deviations with a written reason; this is the largest one yet.
4. **The Showdown and the approved lighting** (contradiction 5). v2 assumes camera and sound only,
   no relighting, unless the developer wants to look at it.
5. **Desktop only inside Discord** (blind spot 8). v2 assumes a desktop gate with a spectator view
   for phones.
6. **King of the Hill's structure** (blind spot 10). It is in active development in the main tree.
   v2 lists the structural options (team hill, respawn style in the queue, ticket rate per player
   count) and leaves the call where it is.
7. **Contacting the original authors and community** (blind spot 9). Answered 2026-10-28: the
   developer had already reached the original authors and community, who received it well.
