# Public player profiles

- Leaderboard rows contain `publicId`, a random UUID persisted by the rating authority.
  It is independent of private device IDs, browser profile IDs, names and short display tags.
- `GET /profiles/:publicId` returns the same public rank, Elo, human-only K/D and recent
  results as the existing self lookup, plus `coverage` and nullable `detail`.
  Invalid IDs return 400; an unknown valid ID returns `{found:false}`.
- The online client rejects malformed/missing public IDs explicitly. It never uses a
  display tag or name as a substitute identity.

## Recorded detail

- One bounded `MatchTracker` observes each new ranked match on its dedicated server.
  It shares the local profile's spell, movement, survival, economy and Hall definitions.
- Only seats controlled by a human continuously from match start through finish receive
  detail. Late joins and any bot takeover omit detail for that match, even after reconnect.
  A recovered connection can finish normally, but the interrupted detailed counters stay
  outside complete-match coverage; their human-controlled part counts as activity (below).
  An unrecovered departure from a match that counts is recorded as a loss (Departures below).
- Detail includes combat against bots. The existing leaderboard K/D and Elo remain
  human-only; the UI labels these scopes separately.

## Unfinished and partly played ranked games

- Combat that complete-match detail leaves out still counts toward the same profile totals
  (damage, kills by cause, spells and accuracy, movement, survival, economy, time played,
  Hall of Fame): aborted games, unrated ranked games (too short, one human, no round between
  humans), bot-controlled intervals, reconnects and departures. Only intervals a human
  controlled the seat count. Casual quick play has its own aggregate (next section); custom
  games feed none.
- `ServerMatchTracker` keeps each seat's human-controlled pieces: the match tracker covers a
  seat until its first bot takeover; each return gets a fresh tracker that sees only that
  interval. Pieces merge with `mergeMatchStats` (counters add, bests keep the larger piece).
  First blood counts only if the human drew it. Seats send `partialStats` and `controlTicks`
  (human-controlled ticks, every phase) and never together with complete `stats`.
- A ranked match that ends without any result (room closed mid-match, simulation failure,
  operational stop) hands its activity once to the authority as an `aborted` submission:
  no Elo, result, history row, player row or Embers. The tracker reports only while its
  match is active, so a second abort, an abort after finish or the next start cannot repeat
  it; a new start while a match is still active reports that match first.
- The authority folds activity in the same receipt transaction as the match, into a separate
  `player_activity` aggregate. Retried deliveries (same key and payload) fold nothing again;
  a changed payload under the same key is rejected. Devices in more than one seat and seats
  without human fight time are excluded. A seat whose complete stats were already folded as
  detail for that match is never folded again as activity.
- Wins, losses, Elo, `matches`, rounds, the leaderboard's ranked K/D, history and rewards
  ignore activity entirely. An unfinished game is therefore not a game in any denominator:
  win rate stays wins over counted results, so an aborted or crashed game cannot lower it.
  A departure from a match that counts is a counted result and a loss (Departures below).
- Profile reads add `activity` (the same aggregate shape as `detail`, or `null`). `detail` and
  `coverage` keep their complete-match meaning. The profile UI shows one set of totals
  (detail plus activity plus casual) and says how many partial and casual games they include.
- The public profile's K/D tile is kills and deaths from that same merged set (by cause, bots
  included, disconnects not deaths); its subline keeps the leaderboard's ranked K/D against
  humans. Personal bests (Hall of Fame) take the best of all three parts. Win rate stays
  ranked wins over counted ranked results.
- Device-local career stats do the same for games that end without a result on this browser
  (leaving, host gone, aborted): kills, deaths, damage, time, counters and personal bests are
  added; games, wins, losses, rounds, streaks, local ratings, encounters and history are not.
## Casual quick-play combat

- Casual quick play (queue `casual`: public quick-play rooms on our servers) feeds the same
  profile totals: complete games (`stats`) and the human-controlled part of interrupted ones
  (`partialStats`, including a casual game closed without a result, sent as `aborted`). The
  selection is the same as activity: devices in exactly one seat, seats with human fight
  time. Custom server rooms, P2P and offline games feed no server aggregate.
- It folds into its own `player_casual` aggregate in the same receipt transaction, so retries,
  reconnects and takeovers fold a game once, and ranked coverage stays exact. Casual adds no
  wins, losses, Elo, ranked match count, departure loss or Embers.
- Profile reads add `casual` (aggregate or `null`). The UI counts casual games apart from
  ranked ones ("2 detailed matches, + 1 partial · + 3 casual"), so ranked numbers keep their
  meaning. Profiles are still keyed by a ranked player row: a casual-only player has no
  public profile yet, but their casual totals are kept and appear once they have one.
- Load: one submission per casual match end (already sent for history) plus at most one per
  casual match that ends without a result.

## Gaps and coverage

- Not covered: a crashed server process loses the activity of its running matches (no
  periodic checkpoints), and a hard shutdown can close the US store before an aborted
  match's activity is written. Regional outbox submissions are durable once queued.
- `coverage.detailedMatches` counts complete recorded matches, `totalMatches` counts all
  counted ranked results, and the two detail timestamps describe actual coverage.
  No detail means `detail:null`, zero covered matches and null timestamps. Historical
  spells, economy and Hall records are never reconstructed or filled with fake zeros.
- The shared `addRecordedMatch` fold maintains compact lifetime aggregates. Public reads
  do not scan unlimited match history. Recorder work is additional to server telemetry's
  physics-only `simStep` measurements.

## Storage and rollout

- SQLite adds `player_public_ids`, `player_details`, `match_history`, `match_history_seats`,
  `ranked_result_flags`, `player_activity` and `player_casual` (all `CREATE TABLE IF NOT
  EXISTS`); existing schemas and rows are preserved. Normal completed-match
  Elo remains unchanged; departures use the explicit forfeit rule below. Existing players receive public IDs on upgrade;
  reopening preserves those IDs. Detail folds commit inside the existing receipt transaction.
- EU sends optional per-seat `stats` through its existing authenticated durable outbox to
  the US authority. Both regions forward public reads to that same authority. Retries keep
  the original payload/fingerprint and cannot double-count detail or Elo.
- Upgrade the US authority before EU writers and public readers: an old authority's strict
  validator rejects the new optional detail field, and likewise the activity fields
  (`partialStats`, `controlTicks`, `aborted`) and an `aborted` casual submission; a rejected
  payload stalls the FIFO outbox. Legacy submissions/outbox rows without
  detail remain accepted. Deploy the authority without overlapping old/new authority writers.
- For rollback, drain and acknowledge new-detail outboxes against the new authority first,
  then roll regions back before the authority. Alternatively stop delivery and preserve the
  outbox until a compatible authority is restored; prefer a coordinated freeze.
  Never drop detail, rewrite queued payloads or change idempotency fingerprints.
- Old binaries ignore the additive tables. Re-upgrading backfills any old-writer players
  again while preserving previously assigned public IDs and detail.

## Departures and queue history

- One rule: if the match counts, leaving it is a loss. A match counts with at least two
  distinct humans who shared it and at least two minutes of play (`LB_MIN_HUMANS`,
  `LB_MIN_SECONDS`). A human who has not rejoined when it finishes receives a loss however
  early they left, even during the first shop. Rejoining before the end clears the departure.
- A match that does not count gives nobody a result, departures included: its history shows
  plain losses, never `forfeit`. That also covers casual and custom history.
- "Shared it": opposing seats both human-controlled at the same moment, any phase (tracked as
  `combatPairs` entries; their ticks still count shared fight time only). A departure needs
  no completed round between the humans, but is rated only against humans it shared the match
  with, never against later bot-seat joins.
- An abandoned match (every human gone) lasts until its last human left: bots playing on in
  an empty room during a reconnect window add no time, so they cannot make it count.
- Forfeits override earlier round wins. Elo gives a forfeiter a score of zero against each
  rated opponent using the existing expected-score/K calculation. If both opponents forfeit,
  each receives a loss penalty; departure penalties are intentionally not zero-sum.
- Until 2026-10-21 a departure needed 60 seconds of combat participation (and a match with a
  qualifying departure could settle before two minutes). Queued submissions under that rule
  stay valid: their flags only mark those longer departures.
- Last-human departure settles before room removal and account-claim release. Abandonment
  has no winners or completion rewards; operational shutdowns/simulation failures and
  operator room closures remain aborts with no result. A victory already reached before a transport closes keeps its result.
- `GET /players/:identity/history` and `GET /profiles/:publicId/history` return `{matches:[]}`,
  newest first, optionally filtered with `queue=ranked|casual|custom`, `limit=1..10`.
  Casual/custom records never update ranked Elo/totals. New receipts save history and ranked
  mutations atomically; old payloads/fingerprints are accepted without rewriting.
- Public history exposes random match UUIDs and a public roster, never room codes, receipt
  keys or private identities. Builds contain exactly 12 loadout slots/levels plus three mastery
  levels. A departed human keeps the last human-controlled build; bot purchases are excluded.
  Old records omit builds and queue labels instead of reconstructing them.
- Deploy the upgraded authority before new regional writers/readers. For rollback, drain new
  history submissions with the compatible authority first; preserve pending outboxes intact.

## Recent global matches

Stats → Matches → **Global** shows the ten latest completed public server games across all
regions, with queue filters, winner(s), region, player/bot counts, duration and completion age.
Expand a row for the recorded scoreboard and equipment; Refresh matches requests a new page.
Personal history and device history remain separate. This is completed-game activity, not
a count of players currently online. Peer-hosted games are not submitted to the authority.

`GET /matches?queue=ranked|casual|custom&limit=1..10` uses the existing shared authority,
regional read rate limits and private RPC. Responses omit personal outcomes, Elo deltas,
room codes, internal receipts and device/account identifiers. Publication requires an
explicit server-side `public:true` receipt, sampled from public room state at match start
and completion. Private games and legacy rows with unknown visibility stay off the feed;
they remain available through the existing personal history API. Aborted games publish no
result. The additive `match_history_public` table is committed with the result and receipt,
so retries cannot duplicate publication.

Upgrade the US rating authority before EU writers and client readers: older authorities
strictly reject the new optional `public` receipt field. Old queued receipts still validate
unchanged. Before rollback, drain these new receipts with the compatible authority; retain
any undelivered outbox intact. Older binaries ignore the publication table and keep reading
personal history. No backfill guesses which old games were public.
