# First-party game, GitHub Pages media

Approved hosting direction: the page at `https://brawlock.osc.link` owns account cookies, OAuth callbacks and passkeys. Heavy public media remains at `https://laubsauger.github.io/brawlock/`, fetched directly by each browser. DigitalOcean does not proxy those downloads. Regions retain their existing US/EU endpoints.

The media split is implemented and tested locally. The account API proxy and standalone auth service are now running on US; the first-party static game page, Pages redirects and matching regional game cutover remain pending. The current Pages entry and game services still run the previous release. No further DNS decision is needed from the user for this layout.

## What goes where

| Content | Host |
|---|---|
| Splash, wordmark, icons, textures, GLB model, ability posters/videos, sound samples, streaming music | GitHub Pages |
| Main page, JS/CSS bundles and small worker script | First-party game host |
| Tiny install manifest and current version check | First-party game host |
| Login, callbacks, session/profile requests | Same-origin account service |
| Match connections, room discovery, global ratings | Existing regional services |

Keeping code and the worker on the game origin avoids cross-origin worker restrictions and keeps release/version ownership with the page. The install manifest stays there because its start URL must refer to the game; its icon URLs point to Pages. Google Fonts already load from Google's font hosts.

`VITE_ASSET_BASE_URL` is the explicit public-media directory. It accepts an absolute HTTPS URL ending in `/`, without credentials, query or fragment; invalid configuration fails the build. If it is unset, the existing local or `/brawlock/` Pages behavior is preserved. It does not alter Vite's application base, OAuth callback, invite links, account endpoint or version polling. There is no retry against DigitalOcean if the media origin fails.

Vite's documented `renderBuiltUrl` hook handles public asset references in HTML and inline splash CSS before JS runs. Runtime texture/model/icon/preview/audio loaders share the media base. Streaming music sets `crossOrigin=anonymous` before assigning its source so it remains audible through Web Audio. Sample decoding and textures use CORS fetches; GitHub Pages currently supplies `Access-Control-Allow-Origin: *` and byte-range support. If a first-party Content Security Policy is added, its image/media/connect directives must allow the Pages origin.

## Build and package

Build the **same approved source revision** that supplies both the app and Pages media. Keep the established regional environment and enable accounts for the combined account-ranked release:

```
VITE_ACCOUNTS_ENABLED=true VITE_ASSET_BASE_URL=https://laubsauger.github.io/brawlock/ npm run build -- --base=/
node scripts/package-client.mjs dist /private/tmp/brawlock-client-RELEASE
```

The package command requires a new output directory and refuses an ordinary Pages build. It makes `web/` with only page/code/version/manifest files, and `pages/` with the public media and legacy entry redirects. It does not upload anything, change the current workflow or publish an account feature. Keep `VITE_GAME_SERVERS` set to the approved US/EU list as in the current release workflow.

For the upcoming combined release, GitHub Actions must build the root-path client once and publish this `pages/` artifact, retaining `web/` and its matching source/build record for the first-party deployment. Do not change `base` to the CDN URL: it is also used by login, invites and version checks. Do not proxy `/textures`, `/audio` or video paths through the droplet.

## Coordinated rollout

1. Complete and exercise maintenance/drain, then prepare the first-party HTTPS site/account proxy and regional account admission without switching the old entry early. Same-origin proxy paths include `/api/auth`, `/api/account` and `/api/progression`; keep `/internal/accounts` private. Retain existing regional API aliases needed during the explicit compatibility transition.
2. Apply the user's authorized fresh-season reset during cutover: wipe old device-based ratings and match history after a private operational backup. The earlier legacy-preservation plan is superseded; do not publish a legacy ladder or import device Elo. Keep the separate account database, new accounts/reserved names, provider credentials and session secret intact. Origin-local settings/replays do not automatically transfer between domains, and no cross-origin history-import flow is included.
3. Publish matching Pages media and verify required files, CORS, streaming playback and range requests. Retain paths still required by clients in the agreed compatibility window. Public media uses stable filenames; this slice does not introduce immutable per-release media snapshots. Future incompatible asset changes must retain old names or introduce a new path before removing the old one.
4. Publish the matching first-party page/code and version notice only after its media, account authority and both advertised regions pass the combined admission/reconnect/result gates. The old Pages `index.html` and `sounds.html` redirects preserve query strings and hashes; the media paths themselves remain served normally. Do not configure a blanket Pages-origin redirect.
5. Verify a real Google login/callback and logout, passkey enrollment/reuse, cross-device identity, invites, preloader, shop previews, textures/model, sample audio, audible menu music and in-game worker loading from the published first-party page. The earlier local provider URL/WebAuthn proofs do not establish a successful public Google login. Confirm browser media requests go directly to Pages rather than the droplet. Retain matching packages for rollback; never roll the client back to removed media.

The prepared `.github/workflows/deploy.yml` builds once, publishes the Pages media/redirect package and retains `first-party-client` for the droplet. It has not run for this release yet; the live Pages entry is still the previous full client. Use `deploy/web.sh` to stage/activate the matching app and [the fleet checklist](../deploy/RELEASE.md) for the coordinated switch. Record the exact source/build, both packages and live gate results in the release receipt.

GitHub Pages has a soft bandwidth limit of 100 GB/month and a 1 GB published-site limit, so this reduces DigitalOcean transfer rather than establishing unlimited hosting. See [GitHub's limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits). The media-host setting can point at a dedicated static host later without changing account identity. Vite reference: [advanced base options](https://vite.dev/guide/build#advanced-base-options).

## Validation

59 focused routing/audio tests pass, including media URLs, CORS-before-source ordering, same-origin account calls and the unchanged single-player streaming queue. Both the root-path production build with separate Pages media and the existing `/brawlock/` Pages build pass. Build inspection verifies HTML splash/preloads use the intended host while JS, worker, manifest and version routing remain local. Package checks verify that heavy directories are excluded from `web/`, manifest icons use Pages, and both old entry redirects preserve query strings and hashes. An earlier prepared package was about 3.3 MB for the first-party app and 47.9 MB for Pages (including duplicate code). Re-measure the final combined build; these are artifact sizes, not per-player downloads.

Actual browser proof passed from an independent local origin to live GitHub Pages: texture image decode, a 12-byte GLB range request/header, sample audio decode, video metadata and nonzero streaming music signal measured through Web Audio with final output gain zero. There were no page errors and no canvases/3D scenes. Local evidence is under `/private/tmp/brawlock-split-assets/`; no browser credentials or game sessions were used.
