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
  outside complete-match coverage. An eligible unrecovered departure is recorded as a loss.
- Detail includes combat against bots. The existing leaderboard K/D and Elo remain
  human-only; the UI labels these scopes separately.
- `coverage.detailedMatches` counts complete recorded matches, `totalMatches` counts all
  counted ranked results, and the two detail timestamps describe actual coverage.
  No detail means `detail:null`, zero covered matches and null timestamps. Historical
  spells, economy and Hall records are never reconstructed or filled with fake zeros.
- The shared `addRecordedMatch` fold maintains compact lifetime aggregates. Public reads
  do not scan unlimited match history. Recorder work is additional to server telemetry's
  physics-only `simStep` measurements.

## Storage and rollout

- SQLite adds `player_public_ids`, `player_details`, `match_history`, `match_history_seats`
  and `ranked_result_flags`; existing schemas and rows are preserved. Normal completed-match
  Elo remains unchanged; qualifying departures use the explicit forfeit rule below. Existing players receive public IDs on upgrade;
  reopening preserves those IDs. Detail folds commit inside the existing receipt transaction.
- EU sends optional per-seat `stats` through its existing authenticated durable outbox to
  the US authority. Both regions forward public reads to that same authority. Retries keep
  the original payload/fingerprint and cannot double-count detail or Elo.
- Upgrade the US authority before EU writers and public readers: an old authority's strict
  validator rejects the new optional detail field. Legacy submissions/outbox rows without
  detail remain accepted. Deploy the authority without overlapping old/new authority writers.
- For rollback, drain and acknowledge new-detail outboxes against the new authority first,
  then roll regions back before the authority. Alternatively stop delivery and preserve the
  outbox until a compatible authority is restored; prefer a coordinated freeze.
  Never drop detail, rewrite queued payloads or change idempotency fingerprints.
- Old binaries ignore the additive tables. Re-upgrading backfills any old-writer players
  again while preserving previously assigned public IDs and detail.

## Departures and queue history

- Each human seat accumulates combat ticks while connected, including time watching after
  death; shop time and bot-controlled intervals do not count. A disconnected seat with at
  least 60 seconds receives a loss if it has not rejoined when the match finishes.
- Forfeits override earlier round wins. Elo gives a forfeiter a score of zero against each
  rated opponent using the existing expected-score/K calculation. If both opponents forfeit,
  each receives a loss penalty; departure penalties are intentionally not zero-sum.
- Normal completed ranked matches retain the two-minute/two-human eligibility rule. A
  qualifying first-round departure can settle sooner only with 60 seconds of simultaneous
  opposing human combat participation and distinct identities. No completed round is invented.
- Last-human departure settles before room removal and account-claim release. Abandonment
  has no winners or completion rewards; operational shutdowns/simulation failures remain
  aborts. A victory already reached before a transport closes keeps its result.
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
