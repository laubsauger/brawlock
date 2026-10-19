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
  Their ordinary eligible Elo/results remain unchanged.
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

- SQLite adds only `player_public_ids` and `player_details`; original player/result rows
  and the Elo formula are preserved. Existing players receive public IDs on upgrade;
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
