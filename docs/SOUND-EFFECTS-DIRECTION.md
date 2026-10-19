# Brawlock sound effects direction

The first listening review favors short, weighty attacks with a physical character. Synthetic and arcade-like spell sounds, painful hiss, and overly bright or crispy explosions were rejected. Lightning should have a snappy thunder-clap character rather than a sustained electrical buzz.

## First review decisions

24 of 27 candidates were reviewed: one Like, three Maybes, and 20 Passes. The three ice candidates, S13–S15, were unreviewed; their omission is not approval or rejection.

| Candidate | Verdict | Constraint and next audition |
|---|---|---|
| S05 Energy impact 1 | Like | Suitable as a possible impact layer; do not interpret this as approval for casts. Audition the recording under physical and magical impacts. |
| S11 Sci-Fi Impact | Maybe | Closer to the desired character, but too long and chunky. Audition shorter, leaner edits before deciding. |
| S16 JM_FX_Fireball 02 | Maybe | The attack arrives too late. Move the useful attack to the start and audition a tighter tail. |
| S20 Zap | Maybe | Still too buzzy. Search for short thunder cracks and claps for Lightning rather than treating the existing recording as accepted. |

S01–S04, S06–S10, S12, S17–S19, and S21–S27 were passed. Do not reuse those candidates as approved sounds. Preserve the current dark-spell, teleport, stone and shop effects while exploring a better direction. Ice remains undecided.

## Editing priorities

- Put the perceptually useful attack at the trigger; remove unnecessary lead-in.
- Keep body and weight without long, bulky tails that obscure the next spell.
- Use accepted recordings as layers where appropriate; approval of a source does not approve every possible spell assignment.
- Judge sharpness and hiss separately from volume. Equal peaks do not imply equal perceived loudness.
- Compare edited candidates with current complete sound recipes before integrating them.

The second audition pass tested impact layering, shorter reflection effects, earlier Fireball attacks, and natural thunder for Lightning.

The original exported feedback is preserved byte-for-byte at `art/archive/audio-review/feedback/round1-feedback-2026-10-18.json` (local archive). It was exported at `2026-10-18T16:51:23.934Z` and contains the user's original notes.

## Second review decisions and implementation

All ten options were reviewed: two Likes, seven Passes and one Maybe. The feedback is preserved unchanged at `art/archive/audio-review/feedback/round2-feedback-2026-10-18.json`, exported at `2026-10-18T17:15:19.272Z`.

- **R01 selected:** add the trimmed S05 recording subtly under the existing physical-impact recipe. Keep the procedural body and existing thud variants. R02's stronger mix and R03's explosion use were rejected, so this source is used only for `impact`.
- **R05 selected:** use the fuller 0.52-second S11 edit as the recording layer for shield reflection, retaining the existing procedural recipe. R04's shorter version was rejected.
- **R06 and R07 rejected:** retain the current Fireball sources. Separately, the user requested a modest earlier fade on the existing cast: reduce its two whoosh recordings from 1.5 to 1.3 seconds and from 1.2 to 1.05 seconds, with smooth fades. Keep the attack, pitch, synthesis and gain settings.
- **Lightning decision:** retain the current in-game thunder, as confirmed after the second review. R08 was marked Maybe but was not selected; R09 and R10 were rejected.

The selected recordings ship in the existing Opus and AAC formats, with source credits and reproducible processing entries. The original audition pages remain historical references; their saved ratings are preserved.

## Music defaults and kill feedback

Music defaults to 65% on fresh loads or when no music preference is saved. Existing saved volumes, including zero and the previous 50% value, are preserved.

Every credited kill already triggers a centered confirmation exclusively for the killer. Its dry slam now finishes with two short, mellow metallic coin strikes. This ordinary kill reward remains separate from the existing bounty settlement, and disconnects, self-deaths, other players and spectators do not receive it.

The shared death sound has a tighter second low-body answer at 65 ms, using its existing synthesis layers and node budget. Death visuals add a small matching pressure echo while preserving cause-specific effects, quiet disconnects, and player effect settings.

## Death voices and announcer audition

The user still finds the death impact too synthetic and wants short vocal deaths with variation. The [death and announcer listening page](../artifacts/death-voice-review/index.html) compares three death cries (D01), three shorter grunts (D02), and three complete killer-heard mixes with the voice leading and the impacts reduced (D03). Each sequence plays three separate examples; it does not propose three simultaneous screams on one death. Current shared death and combined death-plus-killer-confirmation snapshots are included. Installed 2026-10-19 (hybrid sound style): every death plays one of the four cries (D01 plus Thanra's "Male Death Scream") or three grunts (D02), slightly varied in pitch, with the voice leading and the body impact and burn reduced under it (`src/audio/hybrid.ts` `death`; encoded by `art/tools/process_audio.py`, `death_cry_*` / `death_grunt_*`). The synth-only style keeps the synthesized death.

The existing shared death impact and private killer confirmation both contribute to what a killer hears. Final integration should balance both against the approved voice rather than simply add another loud layer. Keep the personal reward exclusive to the credited killer and preserve quiet disconnects. Once variants are selected, avoid immediate repeats and play one vocal per death.

Maverick remains the default announcer. The saved `arena` option selects Daniel and is now labelled **Daniel (Arena)** in settings; selecting Maverick never substitutes Daniel. The listening page compares the current Maverick samples, the current Daniel samples (V01), and the same selected raw Maverick takes with drier processing (V02). No announcer recording or default has been changed by this audition. Its feedback uses a separate browser storage key and review ID. Sources, trims, blend weights, raw-take choices and processing are retained in the page's `provenance.json`; rebuild with `python3 art/tools/build_death_voice_review.py`.

## Splash Enter audition

The user requested a much more substantial, epic entrance sound for **Press Enter**. The previous `uiReady` recipe was a click followed by three bright FM-bell notes. The [Enter listening pass](../artifacts/audio-enter-review/README.md) offered five edited options: low metal, low ritual gong, two cinematic impacts, and a metal/gong combination. Each has an isolated preview and a preview over the current menu theme, plus a snapshot of the old sound for comparison. Keep the attack on the click and the tail short enough to hand over to the music.

**Selected: E04 — Iron thunder.** The user's “iron thunder works” approves the 1.60-second metallic cinematic impact. It now replaces the `uiReady` chime in normal hybrid mode, at fixed playback speed and with no synthetic chime layered over it. The selected stereo audition master is encoded unchanged as Opus and AAC (`ui_enter`), retaining its trimmed attack, 60–4200 Hz filtering, and 0.65-second fade. The splash preloads and decodes this one sample before Enter so the first gesture can play the chosen recording immediately. Music timing and saved volume settings remain unchanged. Credits include EminYILDIRIM's CC0 source.
