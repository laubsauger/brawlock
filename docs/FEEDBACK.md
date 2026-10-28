# Contact and private feedback

Players can open **Bugs & feedback** from the main menu, lobby, pause menu, stats, replay controls, and shared dialog headers (including Settings and Wardrobe). Contact uses the private in-game form; public pages link to `/?feedback=1` without publishing a mailbox address. Social links are not guessed; add only confirmed channel URLs.

Reports support guests and accounts. Opening the form freezes the context and captures the visible game scene plus UI before the dialog appears. The match pause scrim and pause menu are excluded from the attachment so the arena underneath remains visible; opening and closing the report does not resume the match. Players can preview or exclude the attachment, choose bug/feedback, write a message, and optionally supply a reply email. Sending is explicit. Successful submissions display a durable reference; an identical retry reuses its UUID. Closing before submitting sends nothing.

Capture limitation: the attachment combines real renderer pixels with a rasterized copy of the UI. Cross-origin display fonts can render differently in the attachment, including wider text or clipped headings. The live UI is unaffected; the separate diagnostic context retains the screen and dialog names.

Diagnostics use explicit field allowlists: release/build/netcode, screen/dialog, browser and viewport, supported settings, connection/region/room, rendering counters, public match state, own build, up to 50 recent game events and eight redacted errors. No storage dumps, credentials, cookies, chat text, account profiles or hidden opponent purchases. Screenshots can show any visible UI, including chat/account details; the form calls this out before sending. A capture failure is shown explicitly and does not invent a blank attachment. Collection happens on demand, with no per-frame pixel copies.

## Service and deployment

The existing account authority handles `POST /api/feedback`. Its separate `AUTH_DATA_DIR/feedback.sqlite` store is initialized additively, independent of account/progression schema versions. It uses private directory/file permissions, atomic SQLite screenshot BLOB writes and a versioned schema. It persists across releases in the existing data directory. Include this database and its WAL in the same consistent backup process as other service data; do not copy only a live SQLite main file.

Deploy the account bundle and `deploy/web.nginx.conf` together: only the exact feedback POST path gains a 512 KiB request limit; other account routes remain at 32 KiB. Screenshot limits are 256 KiB decoded and 1600 pixels on each axis. Exact-origin JSON requests, server-derived account identity, trusted proxy IPs and bounded per-IP rate limits protect submission. The private inbox routes require the existing account-region bearer token and are served only on loopback; nginx must never proxy `/internal/` publicly. `VITE_ACCOUNTS_ENABLED=true npm run dev` enables the local feedback proxy to port 5352 alongside the existing account proxies.

## Review reports

The normal web inbox is `https://brawlock.osc.link/admin.html` → **Bugs & feedback**, protected by the verified operator Google account. The first report of a global chat line also lands here, as kind `chat` with the reported text; hide the line or mute its sender under **Global chat** (see [ACCOUNTS.md](ACCOUNTS.md#global-chat)). Optional Resend digests are configured on the server after sender-domain verification; see [Operations dashboard](OPERATIONS-DASHBOARD.md). The address is never exposed to players.

For a private offline export:

```sh
npm run feedback -- --collect
open artifacts/feedback/index.html
```

The collector uses the configured account authority via SSH and its protected remote token file; no token is printed or copied into the browser. The exported inbox supports search and Bug/Feedback filtering, screenshot previews and expandable diagnostics. It contains private player data: directory mode 0700, files 0600, and `/artifacts/feedback/` is ignored by Git. Do not upload it as a public QA artifact.

Collect at most 100 reports at once; use `--before TIMESTAMP:UUID` with the cursor shown in the exported inbox for older reports. Offline development: `npm run feedback -- --input /path/to/fixture.json --out /private/tmp/brawlock-feedback-review`. The deployed [operations dashboard](OPERATIONS-DASHBOARD.md) supplies an automatically refreshed private inbox and optional Resend email digests. The offline collector remains useful for private exports. Reports are never published as public issues.

Reports currently have no automatic retention expiry. For an operator-approved deletion request, stop the account authority, back up consistently, delete the exact report UUID from both `feedback` and `feedback_delivery` in `feedback.sqlite`, clear any pending `feedback_mail_outbox` envelope containing that UUID, and restart. Remove corresponding private exports and account for backups according to the operator's retention process. Do not delete or migrate `accounts.sqlite` to remove a feedback report.
