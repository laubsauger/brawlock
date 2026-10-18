# Brawlock sound effects review

[Open the listening page](http://127.0.0.1:5187/artifacts/audio-review/index.html) through the existing Brawlock development server. You can also open `index.html` directly: the review data is embedded and all listening files are local.

The page contains 27 new candidates in nine categories, alongside ten snapshots of the current game's complete sound recipes. The shortlist comes from 177 distinct results in ten archived Openverse searches. Candidates were selected using their source metadata and likely gameplay role; your listening decisions determine which ones move forward.

## Use the review

1. Play the current sound at the top of a category, then audition its three candidates.
2. Mark Like, Maybe, or Pass. Clicking the selected verdict again clears it.
3. Add notes, including timestamps for longer recordings. Use Overall direction for broader preferences or sounds you want to keep.
4. Click Export feedback and attach `brawlock-sound-feedback.json` in the conversation.

Choices save in the current browser and origin. Export before switching browsers or opening the page through another address. Playing a sound stops the previous one; Stop audio or Escape stops playback.

## What is included

| Category | Candidate codes | Possible uses |
|---|---|---|
| Dark spells | S01–S03 | Scourge and dark spell gestures |
| Arcane force | S04–S06 | Gravity, Warp Zone, projectile impacts |
| Teleport and swap | S07–S09 | Departure, arrival, position changes |
| Shield and reflection | S10–S12 | Barrier texture, activation, impact |
| Ice and snowball | S13–S15 | Cast, launch, burst |
| Fire and big impacts | S16–S18 | Fireball variation, fire texture, Meteor |
| Lightning and electricity | S19–S21 | Lightning, Link, Bouncer accents |
| Stone and arena | S22–S24 | Rockpillar, obstacle breaks, collapse |
| Shop purchases | S25–S27 | Physical accents for purchases and upgrades |

Candidate previews are individual source recordings. The current references include the game's synthesis and sample layers. A liked source still needs a deliberate edit and an in-game mix check before integration. No game sound mappings or production audio files were changed by this review.

## Sources and processing

All candidates are indexed as CC0 by [Openverse](https://api.openverse.org/v1/), with recordings hosted by Freesound. Each card links to its provider page. Full metadata and provider links are in [provenance.json](provenance.json); the page's data is in [review.json](review.json).

Original preview MP3s and metadata are retained in `art/archive/audio-review/candidates/`. Search responses are in `art/archive/audio-review/search/`. Current recipe WAV snapshots and their capture manifest are in `art/archive/audio-review/baselines/`. The archive is local and gitignored, following the existing audio workflow.

Listening copies are full-duration, lossless PCM WAV files at 48 kHz, statically peak-normalized to −6 dBFS after resampling. Floating-point peaks are measured before conversion to 16-bit PCM. No pitch changes, automatic sound replacements, or production mix changes were made. Equal peaks do not imply equal perceived loudness.

## Verification and reproduction

Browser checks passed for all 37 audio files, advancing playback, stopping the previous sound, saved verdicts and notes, category/search/verdict filters, feedback export, and a 390-pixel mobile viewport without horizontal page overflow. Preview screenshots and the measured audio checks are saved alongside this file.

The review tools live under `art/tools/`:

- `search_audio_review.py`: archives public Openverse search metadata; accepts query names to run selected searches.
- `audio_review_selection.json`: the shortlist, proposed uses and listening questions.
- `render_audio_review.mjs`: snapshots the current recipes through the local Vite server using the existing local Puppeteer installation.
- `build_audio_review.py`: archives selected downloads, prepares listening copies, and builds the page from `audio_review.html`.

The combined music prompts, Suno field guide, track-length plan and extension workflow are in [the soundtrack guide](../../docs/SOUNDTRACK.md).
