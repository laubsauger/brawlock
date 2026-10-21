# Live operations dashboard

Open **https://brawlock.osc.link/admin.html** after deploying this release. Sign in with the existing Google flow. Every `/api/admin/` request checks the authoritative verified user record and linked Google provider; only the operator account configured in the server-only `server/operator.mjs` has access. A claimed player name, supplied email header, device ID or client UI cannot grant access. Anonymous requests return 401; other accounts return 403. No bearer token is delivered to the browser. The page has no game renderer, media preloads or Google Analytics.

## Automatic collection

The existing US account service starts the collector at boot; no CLI, open browser or extra PM2 service is needed. Every ten seconds it reads both fixed regional HTTPS `/internal/monitoring` endpoints using the existing protected regional credential. Redirects are refused, reads have a five-second deadline and an 8 MiB limit, and polls cannot overlap. An unreachable or older region records an explicit outage instead of zero CPU or zero players. The application version is checked once a minute. The browser reads cached fleet data every five seconds while visible. A failed collection stops neither sign-in nor feedback; collection errors are logged without credentials or provider data.

Metrics include host CPU/steal/available RAM/load, process CPU/RSS, simulation step cost and rate, event-loop delay, human seats/bots/rooms/connections, region maintenance status, process uptime and release version/date/commit/netcode. The account service also records deduplicated app presence, including menus. Ten one-second process/host windows retain CPU and event-loop peaks between collection requests. Linux host counters are unavailable on other platforms; this is shown explicitly. Event-loop measurements include the native sampler's ~20 ms baseline. Simulation rate sums all rooms. Player latency comes from the existing transport probes and client reports, not an HTTP health-check RTT; RTT p95 is across connected peers' smoothed measurements, not a percentile of all historical packets. No new gameplay telemetry messages are required.

`AUTH_DATA_DIR/monitoring.sqlite` is a separate schema-1 WAL database, initialized additively with private permissions. It keeps seven days of numeric history, plus one anonymous latest snapshot per service. History queries bucket to about 360 points per service; charts retain maxima, show gaps and mark failed observations. Buckets may contain several samples, so a shared timestamp indicates a window rather than proof that peaks occurred in the same millisecond. Empty-server RTT stays null. The database uses SQLite `NORMAL` sync: a power failure may lose the newest monitoring samples; game/account durability is unchanged.

The **Player activity** tab collects the existing 30-day account + regional activity reports automatically when opened, caching the rendered explorer for one minute. It never requires a manual SSH collector. Reload the tab's frame to refresh that historical snapshot. Missing regional reports return an explicit error rather than incomplete totals. The **Bugs & feedback** tab reads the private inbox automatically every 30 seconds; screenshots and diagnostics require the same authorization as fleet metrics.

## Feedback email forwarding with Resend

Feedback is stored before notification. The account service uses Resend's HTTPS API with a server-only, send-only API key restricted to the verified sender domain. Player Google sign-in remains limited to basic identity; there is no Gmail authorization, additional Google scope or mail callback. The dashboard shows configuration, queue depth, last accepted delivery and bounded errors. It never returns the key or accepts browser-supplied recipients.

Digests contain up to 25 report excerpts and a link to the private inbox. Screenshots, diagnostic context and reply addresses remain in the inbox. At most one digest is attempted per fifteen minutes; delivery timestamps preserve that cooldown across restarts. This limits this sender to roughly 96 digests per day, within Resend's current free tier (100/day, 3,000/month). Other uses of the same Resend account share its quota. Failed sends remain queued; no paid overage or upgrade is enabled by the application.

Before sending, SQLite freezes the report IDs, exact JSON request and idempotency key in the additive `feedback_mail_outbox` table. New reports cannot change a retry body. A confirmed Resend response atomically marks those IDs delivered and clears the outbox. A lost response or acknowledgement failure retries the same request after restart. Resend retains idempotency keys for 24 hours; an unresolved request retried beyond that window can result in a duplicate digest. Provider acceptance does not guarantee inbox delivery; use Resend delivery logs for bounces.

One-time setup:

1. Remove the previously added `gmail.send` scope from the game's Google Data Access configuration and the unused `/api/admin/mail/callback` redirect. Keep the original `/api/auth/callback/google` sign-in URI. No Google mail authorization is needed.
2. Create a free Resend account. A credit card is not required for the free tier.
3. Add a sender subdomain in [Resend Domains](https://resend.com/domains), for example `brawlock.osc.link`. Add the exact DNS records Resend supplies, then verify the domain. Keep receiving, open tracking and click tracking disabled for these private notifications; do not replace the game's existing A records or unrelated mail records.
4. Create a **Sending access** API key restricted to that domain. Save its value to a private local file and provide its path to the operator tooling; never paste the key into chat or check it into Git.
5. Install it as `/etc/brawlock/resend-api-key`, owner `root:brawlock`, mode 0640. In the protected `/etc/brawlock/accounts.config.cjs`, set `RESEND_API_KEY` by reading that protected file (as shown in the template) and set `FEEDBACK_MAIL_FROM` to the verified sender, e.g. `Brawlock <feedback@brawlock.osc.link>`. For local tooling, the ignored `.env` uses `RESEND_API_KEY`; Node can load it with `--env-file=.env`. The checked-in template documents these optional fields; routine deployments preserve the protected config.
6. Restart the account service through the normal deployment process. The dashboard's **Bugs & feedback** tab shows the configured sender status and any delivery problem. Both settings absent means explicitly unconfigured; partial or malformed settings fail startup rather than silently choosing a sender or another provider.

Delivery acknowledgements and the pending envelope use additive side tables in `feedback.sqlite`; its user_version stays 1 so the preceding inbox service remains readable on rollback. No account/rating migration or report deletion is needed. Old undelivered reports are queued after configuration. To disable forwarding, remove both optional mail settings with the service stopped, then revoke the key in Resend if desired. Reports continue to collect in the private inbox. No credentials are stored in the public client or monitoring database.

References: [Resend free-tier billing](https://resend.com/legal/terms-of-service), [pricing](https://resend.com/pricing), [verified domains](https://resend.com/docs/dashboard/domains/introduction), [idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

## Release and recovery

Deploy matching client, regional game bundles and account bundle through the normal [release tool](../deploy/TOOLS.md). Client packaging includes `admin.html` and redirects the legacy Pages admin path to the first-party origin. Existing first-party `/api/` and regional reverse proxies already cover these paths; no new public port, database listener, nginx site or secret is required. The regional endpoint rejects browser Origin headers and requires the shared private bearer. A partly updated fleet shows unavailable metrics or differing commits until the rollout completes.

PM2 boot restoration already restarts the account/game processes and therefore the collector. Routine stopped backups copy the whole service data directory, including monitoring SQLite/WAL, pending email envelopes and delivery acknowledgements. The Resend API key remains in the protected configuration directory. Treat those backups as secrets. Keep these files when replacing bundles. Rollback to the preceding binaries ignores monitoring data and the additive feedback mail tables; it does not erase history or require a rating/account migration. Monitoring history starts at the first deployed sample and cannot reconstruct old CPU or ping measurements.

Verification:

```sh
node --test server/monitoring.test.mjs server/feedback-mail.test.mjs scripts/analytics-report.test.mjs
npx vitest run src/net/accounts.test.ts src/net/feedback.test.ts src/net/monitoringTcp.test.ts src/ui/lib/feedbackContext.test.ts src/ui/lib/feedbackState.test.ts
npm run build
npm run accounts:build
npm run server:build
```

Real loopback tests require local socket permission. Browser QA uses synthetic fleet fixtures; do not present those screenshots as production measurements. Live checks after rollout: anonymous admin API=401, another Google account=403, operator dashboard updates without an SSH report command, both regions expose the expected release, a local match produces RTT, and queued feedback appears even before Resend is configured.
