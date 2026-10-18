# Brawlock second sound effects review

[Open the second listening pass](http://127.0.0.1:5187/artifacts/audio-review-round2/index.html). The [original review](../audio-review/index.html) remains available with its existing browser feedback.

The first feedback contained one Like, three Maybes and 20 Passes. Three ice sounds were unreviewed. The resulting direction is saved in [Sound effects direction](../../docs/SOUND-EFFECTS-DIRECTION.md), and the original feedback JSON is archived unchanged at `art/archive/audio-review/feedback/round1-feedback-2026-10-18.json`.

| Candidates | Change based on the feedback |
|---|---|
| R01–R02 | The liked S05 recording, trimmed to its attack and layered under the current physical impact at two strengths |
| R03 | The same recording layered under the current spell explosion |
| R04–R05 | S11 shortened from 4.69 seconds to 0.28 and 0.52 seconds, with less low-end bulk |
| R06–R07 | S16 with 0.90 and 0.94 seconds of lead-in removed, shortened to 0.48 and 0.32 seconds |
| R08–R10 | Three natural CC0 thunder recordings, edited to short cracks or claps for Lightning |

R01–R03 are complete comparison mixes. R04–R10 are source edits to judge before integration. Five current complete sound recipes provide references. All listening copies use static peak normalization to −6 dBFS and lossless 48 kHz WAV. Equal peaks do not guarantee equal perceived loudness.

Mark Like, Maybe, or Pass; add notes; then Export feedback. This pass uses a separate browser storage key and review ID, so it does not overwrite the original choices. No production sound files, mappings, or recipes were changed by these auditions.

The three new thunder sources are [Thunder, Close by Fission9](https://freesound.org/people/Fission9/sounds/505113), [Thunderclap by Fission9](https://freesound.org/people/Fission9/sounds/534023), and [thunder sharp dry crack by cognito perceptu](https://freesound.org/people/cognito%20perceptu/sounds/536900). Complete metadata, edit parameters, mixture amounts and snapshot details are in [provenance.json](provenance.json).

Browser verification passed for all 15 referenced audio files, playback, stopping the preceding sound, saved choices and notes, filters, feedback export, preservation of the original review's saved state, and mobile layout at 390 pixels. Both Fireball edits reach 30% of their maximum 10 ms RMS envelope within the first 10 ms window. These measurements verify timing and file behavior; the remaining decision is which sound character you prefer.

Rebuild from the retained sources and snapshots with `python3 art/tools/refine_audio_review.py`. Fresh reference snapshots can be rendered with `node art/tools/render_audio_review.mjs http://127.0.0.1:5187 art/archive/audio-review/round2/baselines art/tools/audio_review_round2_cues.json` using the existing local Puppeteer tooling.
