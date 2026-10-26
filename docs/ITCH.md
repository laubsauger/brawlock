# itch.io build

Brawlock is also published as an HTML5 game at https://prompin.itch.io/brawlock. It is the same client, built for itch's host, and it plays on the same game servers and in the same player pool as https://brawlock.osc.link.

## How it differs from the first-party build

itch serves the uploaded files from `https://html-classic.itch.zone/html/<upload id>/` inside a cross-site iframe on itch.io. So the build:

- uses relative paths (`--base=./`) and bundles all media in the upload instead of loading it from GitHub Pages;
- sets `VITE_SITE_URL=https://brawlock.osc.link/`, which sends the guest play permission (`/api/play`), bug reports (`/api/feedback`) and invite links to the first-party site;
- has no sign-in. OAuth providers refuse to load inside an iframe, and browsers block the site's cookies there. Casual, King of the Hill, custom and peer-to-peer games work as guests. Everything that needs an account sends the player to the site in a new tab and says what they miss: the player card's Account action (with a note: no ranked Elo, Embers or wardrobe as a guest), Ranked, Wardrobe, and the Embers line on the results of an official game.

itch keeps the iframe's storage separate from the site, so a browser is a different guest on itch than on brawlock.osc.link (separate name, stats and device id).

## Server side

The embed origin is allowed in exactly two places:

- **Accounts service** (US): `AUTH_EMBED_ORIGINS=https://html-classic.itch.zone` in `/etc/brawlock/accounts.config.cjs` (see the template). Requests from that origin get CORS on `/api/play` and `/api/feedback` only. They never carry or receive a cookie: the play permission is keyed to the device id the client sends and is always a guest's, and a report never attaches an account.
- **Game servers** (both regions): `https://html-classic.itch.zone` in `ALLOWED_ORIGINS`. `deploy/configure-region.cjs` adds it next to the site origin.

`html-classic.itch.zone` is shared by every HTML game on itch, and the Origin header carries no path. Any itch game could therefore request the same guest permissions or rooms. That gives it nothing a script outside a browser could not already do by sending a forged Origin.

## Publishing

`.github/workflows/itch.yml` runs when `deploy/release.mjs` publishes a `v*` tag after fleet proof. It builds with the release settings, checks itch's limits (`scripts/package-itch.mjs`: 1000 files, 200 MB per file, 500 MB in total), keeps the result as the `itch-html5` artifact and pushes it with butler to `prompin/brawlock:html5`. A manual run (Actions → Publish to itch.io → Run workflow, or `gh workflow run itch.yml -f tag=v…`) takes an existing `v*` tag, so itch never runs netcode the servers do not have yet. It builds that tag's source with the workflow from the branch it runs on, which republishes a release whose own workflow was out of date.

One-time setup:

1. Create an API key at https://itch.io/user/settings/api-keys and store it as the repository secret `BUTLER_API_KEY`. Without it the push step fails and the build stays in the artifact.
2. After the first push, open the project's edit page, tick "This file will be played in the browser" on the `html5` upload, and save.
3. Embed options: "Click to launch in fullscreen", fullscreen button on, mobile friendly off, SharedArrayBuffer off.

## Local build

```sh
VITE_SITE_URL=https://brawlock.osc.link/ VITE_GAME_SERVERS='[…same as the workflow…]' npm run build -- --base=./ --outDir dist-itch
node scripts/package-itch.mjs dist-itch itch-package
```

`itch-package/` is the upload; zip its contents (with `index.html` at the top level) for a manual upload.
