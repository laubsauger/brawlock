# Research · The external frontier

Input for the moonshot series ([00-moonshot.md](../00-moonshot.md)). External research only:
what other games, platforms and papers show, with sources. Retrieved 2026-10-28.

How to read it:

- Every non-obvious claim has a link and a date. "Retrieved" means the number was read on
  2026-10-28 from a live page that changes.
- Player counts from SteamCharts, SteamDB, Steambase, Tracker.gg and Raijin are Steam-only and
  the trackers disagree with each other. Sales from Raijin, SteamPulse, VGI or Alinea are
  third-party estimates, not developer figures.
- **Unverified** marks a claim I found in only one weak source, or could not open. **Older**
  marks a source from before 2024 that is still the best one available.
- "My estimate" marks arithmetic I did on published prices or limits.

---

## 1. Genre history and population

### The Warlock line

| Game | Years | Peak concurrent (Steam) | Late numbers | What happened |
|---|---|---|---|---|
| Warlock (WC3 map, Zymoran and Adynathos) | ~2008 to 2012 dev | n/a | 19 tracked lobbies, 7 hosts (WC3 Tracker, retrieved) | Map page says its successor "can now be played in Dota 2" |
| Warlock Brawl (Dota 2 custom game) | 2015 to ~2022 | n/a | Unverified: Workshop page returned 429 | Ranked mode added Feb 2018; last fix Jan 2022 |
| Spellsworn (Frogsong) | EA Nov 2016, F2P Mar 2018 | 1,517 (25 Mar 2018) | 6 online, 2026-10-19 | Alive in name only |
| Battlerite (Stunlock) | 2017, maintenance from 2019 | 44,850 (Nov 2017) | 35 to 55 monthly avg in 2025 and 2026 | Development stopped after Season 3 |
| Acolyte Fight! (browser) | Sep 2018 | n/a | Unknown | Domain now redirects to the creator's own engine, Easel |
| Magicka: Wizard Wars (Paradox) | to Jul 2016 | Unverified | n/a | Servers closed 21 Jul 2016 over server cost |
| Spellbreak (Proletariat) | Sep 2020 to early 2023 | Unverified on Steam | 5M players in 20 days | Shut down after Blizzard bought the studio |

Sources: [Hive Workshop, Warlock 1.01b](https://www.hiveworkshop.com/threads/warlock-1-01b.92687/);
[WC3 Tracker](https://www.wc3tracker.com/map/warlock);
[Warlock Brawl changelog](https://steamcommunity.com/sharedfiles/filedetails/changelog/296662770);
[SteamDB Spellsworn](https://steamdb.info/app/360620/graphs);
[Steambase Spellsworn](https://steambase.io/apps/spellsworn);
[SteamCharts Battlerite](https://steamcharts.com/app/504370);
[itch.io Acolyte Fight](https://raysplaceinspace.itch.io/acolytefight);
[TechRaptor, Wizard Wars closing](https://techraptor.net/content/paradox-closing-magicka-wizard-wars) (Apr 2016, older);
[Shacknews, Spellbreak 5M](https://shacknews.com/article/120517/spellbreak-has-attracted-over-5-million-players-to-its-magic-based-battle-royale) (Sep 2020, older);
[Game Informer, Proletariat to Blizzard](https://gameinformer.com/2022/06/29/blizzard-acquires-spellbreak-developer-proletariat-to-work-on-world-of-warcraft) (Jun 2022, older).

**Battlerite** is the best documented death in the genre. Stunlock said in July 2019 that
retaining players had always been its biggest challenge, that gameplay changes and marketing had
shrinking returns, that Season 3 would be the last planned, and that servers would stay online
([PC Gamer, Jul 2019](https://www.pcgamer.com/due-to-declining-player-numbers-battlerites-next-season-may-be-its-last), older).
Players blame the Battlerite Royale spin-off for splitting a small player base and taking
development time; others say the decline came first (Steam forum opinion, summarized in
[Wikipedia](https://en.wikipedia.org/wiki/Battlerite)). The game still has "Very Positive"
reviews from about 59,000 reviewers and spikes on sales: January 2025 peaked at 448 and
September 2026 averaged 194 with a 627 peak ([SteamCharts](https://steamcharts.com/app/504370),
retrieved; I found no news explaining the September 2026 spike). Stunlock's next game, V Rising,
passed 5 million sales by 9 January 2025 ([Gematsu](https://www.gematsu.com/2025/01/v-rising-sales-top-five-million)).

**Spellsworn** is the closest commercial Warlock clone. Reviews call it "heavily based off of a
Warcraft 3 mod called Warlocks" and praise the nostalgia and spell combinations, but criticize
balance, content and onboarding ("the first couple matches are going to be rough")
([MMOHuts first look](https://mmohuts.com/?p=176949), older;
[CGM, F2P launch](https://www.cgmagonline.com/newswire/pvp-arena-brawler-spellsworn-goes-free-play-march), 2018, older).

**Acolyte Fight!** was the browser Warlock-like: HTML5, "quick one-minute matches", server-based
multiplayer, released 13 Sep 2018 by raysplaceinspace. On 2026-10-28, `acolytefight.io` returned
a 301 to `acolyte.easel.games`. Easel is the same author's browser game engine with built-in
rollback netcode at 60 Hz, peers relayed through Cloudflare, and (May 2026) a physics engine with
incremental rollback ([Easel rollback docs](https://easel.games/docs/learn/multiplayer/rollback-netcode);
[Easel blog, 1 May 2026](https://easel.games/blog/2026-rollback-physics)). I found no player
numbers or postmortem for Acolyte Fight.

**Dota 2 Arcade context.** Dota Auto Chess reached about 500,000 concurrent players in 2019, half
of Dota 2's population ([PC Gamer](https://www.pcgamer.com/a-dota-2-custom-mode-may-be-2019s-most-popular-new-game), older).
Valve later told Arcade creators to stop all monetization and some shut down their games
([esports.gg](https://esports.gg/news/dota-2/valve-to-stop-all-forms-of-monetization-in-the-dota-2-arcade);
date not shown, unverified).

### Adjacent top-down arena games, 2023 to 2026

- **Omega Strikers** (3v3 knockback soccer): peak a little over 19,000; content development ended
  at the end of 2023 because the game "makes less than it costs to build and maintain"; servers
  stay up ([Nintendo Life, Nov 2023](https://www.nintendolife.com/news/2023/11/f2p-eshop-title-omega-strikers-ends-development-just-months-after-launch);
  [Odyssey FAQ](https://support.odysseyinteractive.gg/hc/en-us/articles/20078372545819)).
- **Supervive** (Theorycraft, ex-Riot): up to 48,000 concurrent in early access, about 15,000 at the
  July 2025 1.0, servers off 25 Feb 2026, refunds for recent purchases
  ([Sheep Esports](https://www.sheepesports.com/articles/supervive-will-end-its-live-service-in-late-february/en);
  [PC Gamer](https://www.pcgamer.com/games/moba/another-moba-gives-up-supervive-developed-by-former-riot-devs-is-closing-in-february-just-7-months-after-it-launched), late 2025).
- **BAPBAP** (F2P top-down roguelite battle royale): peak 1,216 on 24 Aug 2025, 316 in Dec 2025;
  reviews cite "limited content and low player count"
  ([Steambase mirror](https://47ab254a.web-app-326.pages.dev/games/bapbap);
  [Vaporlens](https://vaporlens.app/app/2226280/bapbap); third-party trackers).
- **Mage Arena** (2025, solo dev, $2.99, cast spells by speaking them into the mic): peak 13,450 on
  29 Jul 2025, five days after early access; about 2 million copies by a later weekly report
  ([PC Gamer](https://www.pcgamer.com/games/action/steams-latest-mini-hit-is-mage-arena-a-voice-powered-spellcasting-game-that-costs-usd3);
  [Alinea Analytics](https://alineaanalytics.substack.com/p/peak-sold-18-million-copies-last), estimate).
- **Spell Brigade** (co-op wizard survivors-like): over 125,000 copies in under two months of early
  access ([GamesUnit](https://gamesunit.de/artikel/a-magical-celebration-the-spell-brigade-sold-over-125-000-copies-in-less-than-two-months-205120.html)).
  **Wizard of Legend** sold 500,000 in about two months in 2018 with PvP as a side mode
  ([PC Gamer](https://pcgamer.com/wizard-of-legend-has-sold-half-a-million-copies-is-on-sale), older);
  its sequel (June 2025) is co-op only.

### What the pattern says

1. F2P PvP arena games with a small team die from retention plus cost, not from bad reviews:
   Battlerite still holds "Very Positive" reviews, and the studios cited retention (Stunlock) and
   cost (Paradox, Odyssey), not quality.
2. Peaks come from novelty and streamers (Mage Arena; Spellbreak passed 40,000 concurrent Twitch
   viewers at launch, [Game Rant](https://gamerant.com/spellbreak-twitch/), Sep 2020, older); the
   long tail needs a reason to return that is not "the next season".
3. Spin-off modes that split a small queue are blamed for accelerating decline (Battlerite Royale).
4. Wizard games that sold well recently are cheap, co-op or comedic: Mage Arena is PvP but a $3
   voice-comedy game, Spell Brigade is co-op. F2P skill-first PvP arenas did not hold players.

### Implications for Brawlock

- The Warlock audience is real but small and nostalgic; no successor kept it. Growth has to come
  from people who never played Warlock, through friends and clips, not from a revived fanbase.
- Plan for a Battlerite-sized tail (tens of concurrent players) from day one: every mode must
  work with bots filling seats, and new modes should not split the human queue.
- Cost closed Wizard Wars' servers and ended Omega Strikers' development. Keep cost per match
  near zero (see §4) so a quiet year never forces a shutdown.
- The 2025 hits suggest a co-op or PvE wizard mode (Ascension, Raids) is a better commercial bet
  than another PvP mode.

---

## 2. Design lessons from adjacent games

### Platform fighters and knockback

- **Smash knockback.** The community-reconstructed formula grows with the target's damage and the
  move's damage, scaled by a weight factor `200/(w+100)`, a per-move growth value and base
  knockback ([SSBWiki, Knockback](https://www.ssbwiki.com/KB)). Growth values are designed per
  move, not derived. This is the same family as Warlock's knockback-grows-with-damage rule.
- **Rage**, a comeback multiplier: in Ultimate an attacker's own damage raises their knockback from
  1.0x at 35% to 1.1x at 150% (Smash 4: up to 1.15x). SSBWiki notes it is "not necessarily
  comeback-friendly": a leader at high damage benefits too, and in Smash 4 it caused early KOs on
  set-knockback moves, which Ultimate removed ([SSBWiki, Rage](https://www.ssbwiki.com/Rage)).
- **Hazards off is the competitive default.** Standard Ultimate rulesets turn stage hazards, items
  and Final Smash meter off to minimize randomness
  ([esports.net ruleset guide](https://www.esports.net/news/super-smash-bros/ultimate-tournament-rules/)).
  Smash shipped a hazards toggle rather than separate stages.
- **Brawlhalla** is the F2P success: simple controls, full cross-play since 9 Oct 2019, licensed
  crossover skins, early esports ([PCGamesN](https://www.pcgamesn.com/brawlhalla/cross-play), older;
  [GGRecon](https://ggrecon.com/articles/how-brawlhalla-became-one-of-the-world-s-favourite-fighting-games)).
  Steam peak 34,816 on 24 Feb 2021 ([SteamDB](https://steamdb.info/app/291550/charts)); about
  10,700 online with a 13,061 daily peak in mid-2026 ([Tracker.gg](https://tracker.gg/population/steam/291550)).
  Ubisoft's careers page says over 65 million players (undated).
- **Rivals of Aether 2**: peak 11,765 on 24 Oct 2024, monthly peaks between about 760 and 2,560 in
  2026 ([SteamDB](https://steamdb.info/app/2217000/charts); [Raijin](https://raijin.gg/app/2217000/Rivals_of_Aether_II)).
  Forum posts report slow matchmaking outside 1v1 (anecdotal): a small population cannot fill many
  queues.

### Party brawlers and elimination downtime

- **Party Animals** peaked at 104,174 on 20 Sep 2023 and has had revival months since
  ([SteamDB](https://steamdb.info/app/1260320/charts); [Tracker.gg](https://tracker.gg/population/steam/1260320)).
  **Stick Fight** sold an estimated 4.9 to 8.9 million on Steam, **Gang Beasts** about 1.3 million
  on Steam ([Raijin](https://raijin.gg/app/674940/Stick_Fight_The_Game); estimates disagree).
  Cheap, physical, funny with friends.
- **Fall Guys.** Designers said each round should be "just as good, if not better, to spectate than
  to play" ([Gamepur Q&A](https://www.gamepur.com/features/fall-guys-developers-q-and-a), 2020, older).
  Eliminated players can spectate or leave without losing rewards
  ([GamePressure](https://www.gamepressure.com/fall-guys-ultimate-knockout/elimination-can-i-leave-earlier/z3d7a7), older).
  The F2P relaunch reached 50 million players in two weeks (cumulative, June 2022)
  ([Game Developer](https://gamedeveloper.com/business/fall-guys-hit-50-million-players-two-weeks-after-freemium-switch), older).
- **Warzone's Gulag** is the closest precedent for the Pit: eliminated players fight 1v1 for a
  respawn while others watch from a balcony and throw rocks that do 1 point of non-lethal damage
  ([Call of Duty guide](https://www.callofduty.com/content/atvi/callofduty/warzone/web/fr_ca/strategyguide/infil-tactics-in-the-warzone/wz-gulag.html), 2020, older).
  It only works up to a point in the match and once per player. Spectator interference kept
  breaking its intent: rocks that set off a duelist's claymore, snowballs that damaged before the duel
  ([Mein-MMO](https://mein-mmo.de/en/warzone-players-die-from-snowballs-in-the-gulag-before-the-1v1-developers-intervene,1071699)).
- **Ultimate Chicken Horse** rewrote its scoring because a leader could lock in the win and trailing
  players wanted the game to end; points now include an underdog bonus
  ([Game Developer, Clever Endeavour](https://www.gamedeveloper.com/business/don-t-fear-game-design-change-), older).
- **Mario Kart's blue shell**: critics call it a rubber band that punishes good play; director Kosuke
  Yabuki said they tested without it and "it feels like something's missing"
  ([Game Developer](https://gamedeveloper.com/design/-sometimes-life-isn-t-fair-i-mario-kart-i-director-defends-blue-shell-game-design), older).
- **Lethal League** escalates by design: the ball speeds up on every hit, a smash doubles its speed,
  and in Blaze damage scales with speed ([Nintendo Wire](https://nintendowire.com/features/impressions-lethal-league-blaze/), older).
  Nidhogg's designer likewise built a tug-of-war around waiting for the other player to commit
  ([Venus Patrol, Jan 2014](https://venuspatrol.com/2014/01/beast-emerges-qa-nidhogg-creator-messhof/), older).

### Systemic chemistry

- **Breath of the Wild** splits physics (movement) from a "chemistry engine" (state). Fire, water,
  ice, wind and electricity are elements; trees, rocks, weapons are materials; rules between them
  produce "multiplicative gameplay" (GDC 2017;
  [Engadget](https://www.engadget.com/2017/03/12/breath-of-the-wild-gdc-talk/);
  [Thumbsticks](https://www.thumbsticks.com/gdc-17-breath-of-the-wild-science-lies), older).
  The talk showed a top-down, NES-style prototype that actually ran on the 3D physics and
  chemistry engine underneath.
- **Divinity: Original Sin 2** grew from an arena prototype used to test elemental combinations;
  the designers wanted "combinations that we'll probably never see", and early tests had "lava
  surfaces everywhere" ([PC Gamer, making of DOS2](https://www.pcgamer.com/the-making-of-divinity-original-sin-2), older).
- **Magicka**: eight elements queued into spells (five slots in Magicka 2), opposed elements cancel,
  water plus fire becomes steam, Arcane makes beams, friendly fire is always on by choice
  ([Co-Optimus interview](https://co-optimus.com/interview/613/page/2/magicka-is-co-op-spell-casting-meets-monty-python-humor.html);
  [TheSixthAxis review](https://www.thesixthaxis.com/2015/06/03/magicka-2-review/), older).
- **Noita** simulates every pixel as cellular automata on the CPU in a custom engine; the GDC 2019
  talk covers scaling it and adding rigid bodies
  ([GDC Vault](https://gdcvault.com/play/1025695/Exploring-the-Tech-and-Design), older).
- **Destruction alone does not retain.** The Finals (destruction as its pitch) peaked at
  242,399 at launch and averaged 11,760 in February 2025
  ([Insider Gaming](https://insider-gaming.com/the-finals-current-player-count/)).

### Roguelites and PvE in PvP games

- **Hades** sold 1 million by September 2020, 700,000 of them in early access
  ([GameSpot](https://gamespot.com/articles/hades-has-sold-1-million-copies-nearly-one-third-sold-in-last-few-days/1100-6482388/), older).
  Hades II hit 112,947 concurrent at its 25 Sep 2025 1.0 launch and an estimated 2 million early
  access sales ([TweakTown](https://www.tweaktown.com/news/107930/hades-ii-hits-100k-players-on-steam-in-24-hours-dethrones-silksong-as-1-best-seller-on-eshop/index.html);
  [Notebookcheck](https://www.notebookcheck.net/Supergiant-Games-director-says-Hades-3-isn-t-a-sure-thing-despite-the-success-of-Hades-2.1125776.0.html), Alinea estimate).
- **Vampire Survivors** began as a free Phaser browser game on itch.io (31 Mar 2021) and moved to
  Unity at version 1.6 ([Phaser](https://phaser.io/news/2024/02/vampire-survivors-space-54);
  [Wikiwand](https://www.wikiwand.com/en/articles/Vampire_Survivors)). Steam peak about 77,000 in
  Feb 2022, about 6.6 million Steam copies estimated
  ([Raijin](https://raijin.gg/app/1794680/Vampire_Survivors), estimate). **Brotato**: over 10 million
  copies by 2025 per [Wikipedia](https://en.wikipedia.org/wiki/Brotato) (Raijin estimates about
  3 million on Steam; unresolved). **Megabonk** sold a million in two weeks in 2025
  ([PC Gamer](https://www.pcgamer.com/games/roguelike/vampire-survivors-like-megabonk-makes-megabucks-selling-a-million-copies-in-2-weeks-and-currently-has-more-daily-players-than-borderlands-4-on-steam-ill-be-eating-spaghetti-with-extra-sauce-tonight)).
- **Overwatch 2** cancelled its PvE Hero Mode in May 2023: the work "was huge, with no defined end
  date" and it pulled people off the live game
  ([Windows Central](https://www.windowscentral.com/gaming/overwatch-2-director-on-scrapped-pve-co-op-hero-mode-this-has-been-hard-for-us), older).
- On Discord, Mojiworks measured collaborative play against PvP in internal tests: 50% higher
  new-user retention and 30% more play time
  ([Discord case study, Mojiworks](https://discord.com/build-case-studies/mojiworks), undated, vendor source).

### Implications for Brawlock

- Keep the Caldera exactly classic and make chemistry, living arenas and events a separate
  ruleset, as Smash does with its hazards toggle. Ranked players will turn variance off.
- The Pit is proven by the Gulag, with two cautions: cap spectator influence hard (Gulag rocks did
  1 HP and still broke duels), and decide whether the Pit prize can swing a match or only flavor it.
- Any catch-up mechanic must also help the leader stay interesting (Rage, UCH, blue shell). Prefer
  visible, earned comebacks (bounties on streaks) over silent rubber bands.
- Chemistry works when it is a small table of state rules between elements and surfaces, not
  scripted pairs (BotW, Magicka). Prototype the rule table in the sim with placeholder visuals
  first, as Nintendo did with its top-down prototype.
- A solo or co-op roguelite (Ascension) has the strongest market evidence of any idea in the bank,
  and the Overwatch 2 lesson is to scope it as a mode built from existing spells and bots, not a
  second game.

---

## 3. Distribution for browser games in 2025 and 2026

### Discord Activities

- **Reach.** Activities opened to all developers on 26 Sep 2024. Discord then had 200 million
  monthly users and said apps were used by over 25% of them
  ([Discord blog](https://discord.com/blog/build-where-the-world-plays)).
- **Successes (vendor-reported).** Death by AI (Playroom): nearly 7 million players and over
  1 million hours "in just weeks" (same blog). Chef Showdown (Mojiworks, PlayCanvas + Nakama): about
  1 million players on its October 2023 launch weekend, over 14 million to date, sessions 3x longer
  than on its other platforms ([case study](https://discord.com/build-case-studies/mojiworks)).
  Krunker Strike FRVR, built on three.js and WebGL with Node and Go backends, "more than doubled"
  its player base after launching as an Activity; FRVR's founder called Discord "the most exciting
  new games channel by a wide margin" ([case study](https://discord.com/build-case-studies/frvr)).
  Small developers report far less: Word Rummy drew about 2,000 players in its first month
  ([Stone Fruit dev log](https://brittgibbons.substack.com/p/dev-log-series-building-a-game-for)).
- **Networking constraints** ([Discord networking docs](https://docs.discord.com/developers/activities/development-guides/networking), retrieved):
  all traffic goes through the Discord proxy at `{clientId}.discordsays.com`, which runs on
  Cloudflare Workers. "We currently only support websockets"; WebTransport is in progress; "WebRTC
  is not supported." A CSP blocks any unmapped host (`blocked:csp`); URL mappings are set in the
  Developer Portal and `patchUrlMappings` rewrites `fetch`, `WebSocket` and XHR. Cookies need
  `SameSite=None; Partitioned`. Client-supplied identity must be verified server-side.
- **Practice.** A January 2026 port needed one mapping per backend, stable tunnel domains, bundling
  of any SDK that injects scripts, cache-busted file names because Discord caches aggressively, and
  a mock SDK to keep hot reload working outside Discord
  ([Chips of Fury dev log, 22 Jan 2026](https://chipsoffury.com/posts/discord-activity/)).
- **Money.** Discord takes 15% of the first $1M of sales, then 30%
  ([GamesBeat, Sep 2024](https://gamesbeat.com/discord-opens-activities-in-app-games-and-features-to-all-developers/);
  [Cinevva guide, Jul 2026](https://app.cinevva.com/guides/publish-game-discord-activities)).
  IAP launched for US, UK and EU developers on desktop; whether that has widened is unverified.
- **Discovery.** There is no browse-all store; discovery is the in-call App Launcher, the App
  Directory after verification, and word of mouth (Cinevva guide). Activities also run on Discord's
  mobile clients.

### Web portals

- **CrazyGames**: 35 million monthly users in 2024
  ([Mobidictum](https://mobidictum.com/crazygames-reaches-35-million-monthly-users/)); 50 million in
  2025 per an employee's year-end post (unverified,
  [LinkedIn](https://tr.linkedin.com/in/yagizefemertol)). Requirements: initial download ≤50 MB,
  total ≤250 MB, ≤1,500 files; ads only through its SDK and the game must work with AdBlock; Full
  Launch requires CrazyGames account login and forbids external login; multiplayer Full Launch asks
  for invite links, an instant-multiplayer flow, rooms kept across rounds and a disable-chat
  preference; multiplayer games may skip Basic Launch; IAP only for selected games via Xsolla
  ([CrazyGames requirements](https://docs.crazygames.com/requirements/intro/), retrieved). It ran a
  browser multiplayer jam with Photon in spring 2025
  ([Pocket Gamer](https://www.pocketgamer.com/features/crazy-web-multiplayer-jam-2025)).
- **Poki**: about 100 million monthly players, 625 million players in 2025, 1 billion plays in a
  month (June 2025); top games earn up to €1 million a year, mostly from rewarded video
  ([Mobidictum interview](https://mobidictum.com/pokis-web-gaming-interview-michiel-van-amerongen);
  [Tech Funding News](https://techfundingnews.com/browser-gaming-website-poki-won-big-at-the-dutch-game-awards-celebrating-hitting-1-billion-monthly-plays/)).
  A third-party guide reports a 50/50 split on Poki-driven traffic (unverified,
  [Cinevva](https://app.cinevva.com/guides/publish-game-poki)). Poki publishes **netlib**, a WebRTC
  P2P library with reliable and unreliable channels and free hosted signaling and TURN on
  Cloudflare; it is beta and has no lobby listing yet ([GitHub](https://github.com/poki/netlib)).
- **YouTube Playables**: initial bundle must be under 30 MiB (15 MiB recommended), 250 MiB total,
  and games "must not make external calls", which rules out live multiplayer
  ([Google FAQ](https://developers.google.com/youtube/gaming/playables/support/certification_faq);
  [stability requirements](https://developers.google.com/youtube/gaming/playables/certification/requirements_stability?hl=de);
  [FRVR channel docs](https://docs.frvr.com/requirements/channels/youtube/)). Revenue share is
  still a limited pilot ([Google](https://developers.google.com/youtube/gaming/playables/reference/monetization)).
- **Reddit (Devvit)**: Devvit Web supports standard web stacks including Phaser and three.js;
  Reddit Developer Funds ran 1 Apr to 31 Dec 2025 with a per-app cap of $116,500 (from a mirror of
  Reddit's post, unverified). I could not open Reddit's docs to check realtime limits.

### Steam with web technology

- **Cookie Clicker** shipped on Steam on 1 Sep 2021 as "an electron wrapper around the HTML game",
  $4.99, while the browser version stayed free ([SteamDB](https://steamdb.info/app/1454400/info);
  [PC Gamer](https://www.pcgamer.com/uk/cookie-clicker-is-now-on-steam), older). Peak 67,806 in
  September 2021, still 8,300 to 10,200 average players a month in 2026
  ([SteamCharts](https://steamcharts.com/app/1454400), retrieved).
- Vampire Survivors started in the browser (§2); CrossCode shipped on NW.js; Steam features come
  through bindings such as steamworks.js ([Summer Engine guide](https://www.summerengine.com/make-great-games/threejs-game-on-steam), vendor source).
- **Krunker** (browser shooter, 2018) claimed over 200 million unique players when FRVR
  bought it in May 2022 ([Game Developer](https://www.gamedeveloper.com/press-release/frvr-acquires-popular-free-to-play-shooter-krunkerio), older).

### Clips and streamers

- **Medal** has about 10 million monthly users capturing about 2 billion clips a year; its spinout
  General Intuition raised a $133.7M seed in October 2025 to train agents on those clips
  ([SiliconANGLE, 16 Oct 2025](https://siliconangle.com/?p=716580);
  [Investgame](https://investgame.net/news/133m-seed-funding-to-launch-an-ai-research-lab-for-gaming/)).
  Overwolf's **Outplayed** lists 9 million+ downloads (undated) and needs the Overwolf desktop app
  ([Overwolf](https://game.overwolf.com/outplayed-record-gameplay)). Neither works in a browser game
  without integration.
- **Link unfurls.** Community reports say Discord shows direct MP4 links as GIF-like previews without
  seeking or audio, and that its embed player is picky about codecs
  ([Discord feedback thread](https://support.discord.com/hc/nl/community/posts/360061405831-Treat-Links-to-Mp4-Files-Like-Videos-Not-GIfs);
  [gist, 2024](https://gist.github.com/Clybius/103bdf0ebde254c348e38f023191f494)). Pages with
  `og:video` and oEmbed unfurl into a player for some hosts
  ([Videobot docs](https://docs.videobot.com/publishing/advanced/oembed), vendor). I found no
  official Discord spec: test it.
- **Streamer discovery** made 2025's biggest small hits. PEAK reached about 114,000 concurrent and
  2 million sales in nine days after its 16 Jun 2025 launch, with 3.32 million hours watched in
  release week ([Streams Charts](https://streamscharts.com/news/peak-release-viewership-statistics);
  [Mein-MMO](https://mein-mmo.de/en/developers-create-a-surprising-hit-on-steam-played-by-over-114000-players-using-their-power-and-a-stuffed-animal-to-troll-twitch-streamers,1508374)).
  REPO entered Twitch's top ten within a week of its February 2025 launch
  ([Streams Charts](https://streamscharts.com/news/repo-twitch-viewership)). For browser games,
  Agar.io and Slither.io grew through YouTubers including PewDiePie with no ad budget
  ([Wikipedia, Slither.io](https://en.wikipedia.org/wiki/Slither.io), older).

### Implications for Brawlock

- A Discord Activity is the best-evidenced channel for a group game, and Krunker Strike shows a
  three.js shooter fits. But inside Discord only WebSockets work: the P2P custom rooms cannot run
  there, so a Discord room must be a dedicated-server room reached through a URL mapping.
- Discord runs Activities on phones. Brawlock is desktop-only, so the Activity needs a clear
  "join from desktop" gate (or a spectator view) for mobile participants.
- CrazyGames and Poki want instant play, platform login, SDK ads and rooms that persist across
  rounds. That conflicts with Brawlock's own accounts and with any ad-free stance: decide per
  portal before building, and expect the Embers and ranked flows to need a portal mode.
- YouTube Playables can only carry an offline bots or trials demo. Skip it unless a solo mode
  exists.
- A clip that unfurls inline is unproven on Discord for self-hosted MP4. Budget a test page with
  `og:video` early; streamer-facing tools (clean observer view, Twitch-friendly clips) are the
  channel that actually moved 2025's small multiplayer hits.

---

## 4. Tech frontier

### WebGPU coverage

- Chrome and Edge since 113 (May 2023); Safari 26 on macOS, iOS, iPadOS and visionOS since
  September 2025; Firefox 141 on Windows since 22 Jul 2025, Firefox 145 and 147 on Apple Silicon
  Macs; Firefox on Linux and Intel Macs still Nightly-only; Chrome on Linux from 144 (Intel Gen12+)
  and 147 (NVIDIA, Wayland, driver 535.183.01+)
  ([Wikipedia, WebGPU](https://en.wikipedia.org/wiki/WebGPU), retrieved;
  [PCWorld](https://www.pcworld.com/article/2851602/firefox-is-finally-getting-webgpu-but-only-on-windows.html);
  [Utsubo, 29 Apr 2026](https://www.utsubo.com/blog/frontier-web-apis-2026-production-ready)).
- caniuse gives 87.82% global support including 2.02% partial, marks desktop Safari 26 to 27 as
  partial, and still lists Firefox as disabled by default, which contradicts Mozilla's shipping
  ([caniuse](https://caniuse.com/webgpu), retrieved). Utsubo estimates a "~5–10% tail" still needs
  WebGL2.
- three.js documents automatic WebGL2 fallback in WebGPURenderer
  ([three.js manual](https://threejs.org/manual/en/webgpurenderer)). One benchmark found
  WebGLRenderer faster than WebGPURenderer with many separate meshes as of r176
  ([ICS Media](https://ics.media/en/entry/250501/), date unclear).
- **Compute in shipped games:** I found tutorials and demos (a million-particle TSL galaxy, GPU
  rigid bodies) but no named shipped web game that uses WebGPU compute. Sources disagree on whether
  three.js emulates compute on the WebGL2 fallback.

### WebTransport

- Browsers: Chrome 97 (2022), Firefox 114 (2023), Safari 26.4 (March 2026), so it is Baseline
  "newly available" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API);
  [9to5Mac](https://9to5mac.com/?p=1044958); Utsubo).
- Servers, October 2026: **Node** has no stable WebTransport; `node:quic` is experimental since
  23.8 behind `--experimental-quic` and needed a special build flag in an April 2026 PR
  ([@types/node quic.d.ts](https://cdn.jsdelivr.net/npm/@types/node@25.0.3/quic.d.ts);
  [nodejs/node#62876](https://github.com/nodejs/node/pull/62876)). The community package
  `@fails-components/webtransport` (libquiche) is the usual route
  ([npm](https://www.npmjs.com/package/@fails-components/webtransport)). **Deno** has an unstable
  built-in server API ([Deno docs](https://docs.deno.com/examples/web_transport/)). **Bun** has
  experimental HTTP/3 (`Bun.serve({ h3: true })`), with WebTransport only in community packages
  and the feature request still open ([Bun issue](https://github.com/oven-sh/bun/issues/13656);
  [Bun on X](https://x.com/bunjavascript/status/2048857521243504708)). **Cloudflare Workers** have no
  WebTransport or UDP; there is a workerd tracking issue (mirror,
  [workerd#6451](https://vat.pages.dev/cloudflare/workerd/issues/6451), unverified). WebTransport
  also needs HTTP/3 end to end, which many load balancers lack (Utsubo).

### Edge compute as the authoritative server

- **Cloudflare Durable Objects** ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
  [limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
  [location](https://developers.cloudflare.com/durable-objects/reference/data-location/), retrieved):
  - Requests $0.15 per million after 1 million a month; duration $12.50 per million GB-s at 128 MB
    per object after 400,000 GB-s; incoming WebSocket messages bill at 20:1; outgoing messages are
    free.
  - CPU budget 30 s per request, reset by each incoming WebSocket message, configurable to 5 min;
    soft limit 1,000 requests per second per object; single-threaded.
  - Location hints (`wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `apac-ne`, `apac-se`, `oc`,
    `afr`, `me`) are "best effort and not a guarantee", apply only to the first `get()`, and
    objects do not currently move after creation (relocation is planned).
- **My estimate** for a 10-player, 3-minute match sending inputs at 30 Hz: 300 messages/s is 15
  billed requests/s, 2,700 per match ($0.0004); 180 s at 0.125 GB is 22.5 GB-s ($0.0003). Under
  $0.001 per match before the $5 monthly minimum. At 60 Hz the input rate (600/s) stays under the
  1,000/s soft limit but not by much.
- **Cloudflare Realtime SFU DataChannels** gained unordered and partially reliable delivery
  (`ordered: false`, `maxRetransmits: 0`) on 13 Aug 2026, with unlimited subscribers per
  publisher ([changelog](https://developers.cloudflare.com/changelog/post/2026-08-13-datachannels-reliability-ordering/);
  [docs](https://developers.cloudflare.com/realtime/sfu/features/datachannels/)). SFU and TURN cost
  $0.05/GB egress after 1,000 GB a month free; whether that covers DataChannels is not stated
  ([pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)). It is a relay, not compute:
  something else must run the simulation.
- PartyKit rooms are Durable Objects ([PartyKit docs](https://docs.partykit.io/how-partykit-works/)).
  I found hobby games on it (a 100-human, 500-bot snake server) but no shipped commercial action
  game with published numbers.

### WebCodecs and video export

- Chrome 94+, Safari 16.4 (video) and 26 (audio, full surface), Firefox 130+ on desktop with encode
  and decode; Firefox Android still lacks it; AV1 encode is Chrome-only, so ship H.264 as the
  baseline and check `VideoEncoder.isConfigSupported()`
  ([Mozilla intent to ship](https://groups.google.com/a/mozilla.org/g/dev-platform/c/ax5NcNNgGwY/m/U2zzLK26AAAJ);
  [caniuse](https://caniuse.com/webcodecs); Utsubo).
- **Mediabunny** (zero dependencies, WebCodecs-backed) writes MP4 with fast start, fragmented MP4
  and WebM, and replaces the older mp4-muxer and webm-muxer
  ([docs](https://mediabunny.dev/guide/introduction); [GitHub](https://github.com/Vanilagy/mediabunny)).

### Rollback netcode in the browser

- **Easel** (published by the same raysplaceinspace account as Acolyte Fight) runs browser games at 60 Hz with rollback, relays inputs
  peer-to-peer through Cloudflare, and in May 2026 replaced full-world snapshots with incremental
  rollback that snapshots "perhaps less than 30" changed objects per frame, "30-50x fewer than
  before" ([Easel docs](https://easel.games/docs/learn/multiplayer/rollback-netcode);
  [Easel blog](https://easel.games/blog/2026-rollback-physics)).
- **NetplayJS** (TypeScript, WebRTC, last pushed Oct 2024) and **GGRS** (Rust, browser via WASM and
  Matchbox) are the open libraries ([NetplayJS](https://github.com/rameshvarun/netplayjs)). GGRS's
  docs warn that floating-point results can differ across platforms and advise fixed-point or
  integer math ([GGRS setup](https://docs.rs/crate/ggrs/latest/source/docs/setup.md)).

### Implications for Brawlock

- WebGPU-first with the WebGL2 fallback is right for a desktop audience; Linux Firefox and older
  Macs are the fallback population. Any GPU-compute effect (fluid lava, fracture, cloth) must be
  cosmetic with a cheap path, since nobody has shipped this at scale on the web and the fallback's
  compute support is unclear.
- WebTransport is client-ready but not server-ready in Node, and unavailable in Workers and in
  Discord. WebRTC unreliable channels remain the only practical UDP-like path outside Discord.
- Durable Objects could host the pure-TypeScript sim near players for well under a cent per match,
  but location hints are coarse (11 hints, some of which place the object in another region; best
  effort; no migration) and the transport is WebSocket only. Measure tick jitter in a DO before
  betting on it; "rooms near everyone" is achievable at the region level, not per city.
- Clip export in the browser is ready: WebCodecs H.264 plus Mediabunny on Chrome, Safari 26 and
  desktop Firefox. Rendering a clip from a replay offscreen avoids screen capture entirely.
- Brawlock's deterministic sim with engine trig in `sim/math.ts` already meets the precondition
  that rollback libraries warn about. Easel shows incremental snapshots are what make rollback
  affordable once arenas gain destructible state.

---

## 5. Bots and AI

### Bots that copy people

- **Killer Instinct Shadows** (2015) use case-based reasoning: every action and
  the full match state are recorded, a parser labels higher-level patterns (setups, zoning, combo
  breakers, taunts), each match yields 400 to 700 patterns, and up to 40 matches are kept per
  player. At runtime a nearest-neighbour search over "over 40 metrics" retrieves patterns, ranks
  them by value, sometimes picks a worse one to bait, and abandons patterns that keep getting
  punished. Limits: the metrics need expert design, a pattern must be seen several times, and 40
  matches can be too few ([Game Developer, AI and Games, 13 Oct 2017](https://www.gamedeveloper.com/programming/the-killer-groove-the-shadow-ai-of-killer-instinct), older).
  Shadows copy quirks too, including taunts ([Kotaku](https://kotaku.com/1708162982), older).
- **Forza Drivatars** began at Microsoft Research Cambridge and moved to the cloud in Forza
  Motorsport 5 (2013); they learn when a player brakes, accelerates and turns and generalize to
  situations the player never drove ([Game Developer](https://www.gamedeveloper.com/design/how-forza-s-drivatar-actually-works);
  [Xbox Wire, Sep 2014](https://news.xbox.com/en-us/2014/09/30/games-forza-horizon-2-drivatars/), older).
- **GT Sophy** (Sony AI, deep RL): Sophy 2.0 shipped 2 Nov 2023 for 340+ cars on 9 tracks, more
  tracks in January 2025, Sophy 2.1 in Custom Races on 27 Mar 2025, PS5 only. Sony AI's president
  called it a "formidable, human-like" opponent, aimed at beginners through experts
  ([Sony AI](https://ai.sony/articles/sonyai022/);
  [GTPlanet, Nov 2023](https://www.gtplanet.net/gt7-spec2-november-sophy-20231101/);
  [MP1st, March 2025](https://mp1st.com/title-updates-and-patches/gran-turismo-7-update-1-570-patch-notes-for-march)).
- **Research.** A December 2024 paper trained 2v2 shooter agents by imitating human trajectories
  and found evaluators judged them human-like in a Turing-style video test; it used ray-cast
  sensors, not pixels, so inference is cheap enough for production
  ([arXiv 2501.00078](https://arxiv.org/html/2501.00078v1)). Sony researchers cloned behaviour from
  pixels in VizDoom and could steer agents aggressive or passive
  ([arXiv 2401.03993](https://arxiv.org/pdf/2401.03993v1.pdf), Jan 2024). Both human evaluations
  are small.
- **World models.** Microsoft's Muse (WHAM, February 2025) was trained on over 1 billion images and
  controller actions from about seven years of Bleeding Edge play
  ([Microsoft Research](https://www.microsoft.com/en-us/research/blog/introducing-muse);
  [Azure AI Labs](https://labs.ai.azure.com/innovations/muse/)). General Intuition is betting
  $133.7M on agents trained from game clips (§3).

### Risks seen in shipped games

- **ML bots as cheats.** Nexto, a public RLGym Rocket League bot, was wired into ranked play by third
  parties in late 2022; a YouTuber's test found it hard to tell from a strong human, and Psyonix
  ran a ban wave
  ([PC Gamer](https://www.pcgamer.com/uh-oh-people-are-now-using-a-machine-learning-bot-to-cheat-in-rocket-league);
  [PC Gamer, ban wave](https://pcgamer.com/psyonix-unleashes-banwave-against-the-rocket-league-bot-menace), older).
- **Undisclosed bots.** Marvel Rivals players documented Quick Play lobbies of level-1 bot accounts
  after consecutive losses; NetEase never confirmed it, and the story stayed in the press for months
  ([Push Square, Jan 2025](https://www.pushsquare.com/news/2025/01/the-invisible-womans-marvel-rivals-super-power-exposes-quickplay-bots);
  [TheGamer via OpenCritic](https://opencritic.com/news/19030/marvel-rivals-hasnt-got-rid-of-bot-players-its-just-made-them-act-more-human-)).
  Fortnite announced its bots openly in 2019: more for new players, none in competitive
  ([Inven Global](https://invenglobal.com/articles/9134/fortnite-is-adding-bots-to-matches-to-help-new-players-learn-the-game), older).

### Dynamic difficulty

- A randomized field experiment in a free-to-play mobile game found easier difficulty raised
  engagement, long-term retention and spending, with effects varying by player type
  ([Ascarza, Netzer, Runge](https://business.columbia.edu/sites/default/files-efs/citation_file_upload/ascarza_netzer_runge_2023-12-04.pdf), IJRM, listed 2025).
- In an online game, players preferred adaptive opponents from deep player models over fixed
  difficulty, while heuristic tuning read as rubber-banding
  ([Newcastle Open Lab](https://openlab.ncl.ac.uk/research/enemy-within-long-term-motivation-effects-of-deep-player-behavior-models-for-dynamic-difficulty-adjustment)).
  A 2025 review notes hidden adjustment can erode trust and hybrids with player choice are emerging
  ([preprints.org](https://www.preprints.org/manuscript/202511.2251), preprint).

### AI commentary

- Konami ran AI live commentary for the Master Duel qualifiers of the Yu-Gi-Oh! World Championship
  on 29 Aug 2025, in ten languages, drawing on 12,000+ cards and deck win rates; human casters kept
  the main days ([Siliconera](https://www.siliconera.com/yu-gi-oh-world-championship-2025-will-have-ai-commentary/);
  [Master Duel Meta, Jul 2025](https://www.masterduelmeta.com/articles/quick-news/july-29-2025/ai-live-commentary/)).
  I found no review of how it landed.
- A research system generates League of Legends commentary with GPT-4o vision and TTS and also
  drives the spectator camera; keeping speech in sync with the camera was a main problem
  ([IJIMAI paper](https://www.ijimai.org/index.php/ijimai/article/download/6566/3671/7275)).

### Implications for Brawlock

- Ghosts do not need deep learning. KI's design (record states and actions, cluster into patterns,
  retrieve by nearest neighbour, drop what gets punished) maps onto Brawlock's replays and the
  existing scripted bot as a fallback, and it can run inside the bot tick budget.
- Imitation from state features (positions, cooldowns, edge distance), not pixels, is the cheap,
  proven route to human-like style. Keep the scripted ladder as the calibrated strength reference.
- Always label bots and ghosts. Marvel Rivals shows the cost of hiding them; Fortnite shows open
  bots for new players are accepted. Never let ranked contain a bot.
- A strong public bot becomes a cheat tool (Nexto). Keep learned models server-side or ship only
  weakened versions, and keep server-side input sanity checks.
- An AI caster is at pilot stage across the industry. The moonshot's split (code picks the moment,
  a language model only drafts lines offline) matches where the evidence is; live LLM speech has a
  sync problem nobody has solved.

---

## 6. Presentation

- **Smash's Finish Zoom** fires when the game calculates a hit "will likely result in a
  game-winning KO", from knockback and launch angle only, so the victim can still survive. The
  camera zooms to the impact, time slows, the background turns red, a fixed sound plays and the
  victim's face changes ([SSBWiki, Final Zoom](https://www.ssbwiki.com/Final_Zoom), retrieved).
  Sakurai said the zoom was meant mainly for one-on-one fights
  ([Nintendo Wire, Jul 2018](https://nintendowire.com/news/2018/07/11/new-interview-with-masahiro-sakurai-approaching-on-the-switch-news-feed/), older).
- **Hit-stop.** Sakurai's first design video, "Stop for Big Moments!" (August 2022), compares
  footage with and without freezes on impact and names "boss stop" for the freeze on a boss kill
  ([Automaton](https://automaton-media.com/en/news/20220824-15208/);
  [GamesRadar](https://www.gamesradar.com/smash-bros-masahiro-sakurai-has-started-a-fascinating-youtube-game-design-series), older).
  Vlambeer's "The Art of Screenshake" (November 2013) adds 30 small feedback tweaks to a dull
  shooter, including camera kick opposite the shot
  ([Game Developer](https://gamedeveloper.com/design/vlambeer-co-founder-shares-advice-on-building-better-action-games), older).
- **Left 4 Dead's AI Director** (Valve's GDC 2009 slides,
  [PDF](https://cdn.fastly.steamstatic.com/apps/valve/2009/GDC2009_ReplayableCooperativeGameDesign_Left4Dead.pdf), older,
  read directly):
  - Goal: "algorithmically adjusting game pacing on the fly to maximize 'drama'", copying the
    "spiky" pacing of Counter-Strike, because "constant, unchanging combat is fatiguing" and "long
    periods of inactivity are boring". If intensity is too high, major threats are removed for a
    while.
  - Each survivor's intensity is one float. It rises with damage taken, incapacitation, being
    pushed off a ledge, and nearby kills (inversely with distance); it decays toward zero, but not
    while enemies are engaging that survivor. The Director tracks the maximum over the team.
  - States: Build Up (full threat until intensity crosses a peak threshold), Sustain Peak (3 to 5 s
    more), Peak Fade (minimal threat until intensity decays, so a fight can finish without eating
    the rest), Relax (30 to 45 s, or until the team has moved on). Boss encounters ignore it.
- **Adaptive music.** In Doom (2016) "the game engine stitches these puzzle pieces together
  depending on what the player is doing": exploring, fighting many or few demons, a boss, low health
  ([Bethesda, 28 Sep 2016](https://bethesda.net/en/news/inside-the-doom-score-mick-gordon-interview), older).
  I found no primary source on Hades' stem system.
- **Observer modes.** Dota 2's Directed Camera anticipates events and moves to them so all
  spectators share one view ([Liquipedia](https://liquipedia.net/dota2/Spectating)); an early
  reviewer still preferred a skilled human
  ([Game Informer, 2011](https://gameinformer.com/games/dota_2/b/pc/archive/2011/10/06/a-new-way-to-play-like-the-pros), older).
  I found no published scoring rules for Valve's directors.
- **Crowds.** Smash's crowd chants the names of human-controlled characters, gasps when a player
  recovers near the ledge and cheers multi-hits; the trigger logic is not fully known
  ([SSBWiki, Crowd](https://www.ssbwiki.com/Crowd), fan wiki). Jackbox's audience mode (Quiplash,
  30 Jun 2015) lets up to 10,000 people vote beside eight players
  ([Engadget](https://www.engadget.com/2015-06-30-quiplash-10000-players-twitch.html), older).
  Research on audience participation games groups the design space into agency, pacing and
  community ([Striner and Webb, CHI 2021](https://ir.cwi.nl/pub/30827/30827.pdf)); in a CrowdChess
  study, streamers preferred aggregated crowd input over handing control to one viewer
  ([Saarland preprint](https://umtl.cs.uni-saarland.de/paper_preprints/paper_crowdchess_a_system_to_investigate_shared_game_control_in_live-streams.pdf)).

### Implications for Brawlock

- Port Finish Zoom literally: predict "this hit likely ends the match" from the sim's knockback and
  heading toward lava, trigger only then, and accept false positives as drama. Keep the full
  version for duels and the final blow, smaller for rounds, as Sakurai did for FFA.
- Scale hit-stop by impulse and reserve the longest freeze for match-deciding hits. The sim must
  not pause: freeze presentation only, or the network clock drifts.
- The L4D Director transfers almost unchanged: per-warlock intensity from damage, near-lava
  moments and nearby knockouts, a max over the lobby, and Build Up / Sustain / Fade / Relax states.
  In Brawlock it should drive music, light and camera, and fire arena events only during Build Up,
  never at Peak.
- Doom stitches pre-made segments by game state rather than mixing every layer live. Four stems
  (percussion, bass, choir, lead) switched by Director state is a modest version of the same idea;
  start with state changes, not continuous mixing.
- Spectator influence should be aggregated (votes, cheers) and bounded, per the CrowdChess and
  Gulag evidence. A name chant on a streak is cheap, proven in Smash, and needs no network
  feature.
