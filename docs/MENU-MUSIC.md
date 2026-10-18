# Menu music

Two user-supplied versions of **Brawlock — Circle of Ash**, in their supplied order:

| Runtime file | Supplied source | Duration | Source integrated loudness |
|---|---|---:|---:|
| `public/audio/music/circle-of-ash-1.mp3` | `Brawlock — Circle of Ash.mp3` | 112.4 s | −15.83 LUFS |
| `public/audio/music/circle-of-ash-2.mp3` | `Brawlock — Circle of Ash (1).mp3` | 122.0 s | −16.19 LUFS |

The MP3 audio streams were copied without re-encoding; embedded cover art and metadata were removed with `ffmpeg -map 0:a:0 -c:a copy -map_metadata -1`. The supplied M4A alternatives contain Opus, so the standard MP3 versions are used for browser playback. Originals remain in Downloads. The source metadata identifies the artist as laub and the generator as Suno; these user-supplied songs are separate from the CC0 effects collection.

`src/audio/menuMusic.ts` owns one HTML audio element routed through the existing Web Audio music bus, volume control and master mute. The splash waits for the first song to become playable. The second song is not requested until the first ends; ending the second returns to the first. Songs stream instead of retaining two fully decoded AudioBuffers.

Playback starts inside the splash Enter gesture, with a 1.2 s fade-in. Menu, lobby, credits and results share the queue without restarts. Entering a match fades out over 0.8 s and pauses at the current position; returning to the menus resumes with the fade-in. Hidden tabs pause, and resume only when the menu is still active. Replay entry stops menu music. Existing shop/fight synthesis is unchanged; later soundtrack integration remains separate.

New settings default music to 50%, with an additional 0.5 song trim on the calibrated music bus. Saved choices are respected, including mute and zero volume. Missing or stalled music is reported and does not substitute procedural music or block the game indefinitely.

Verification includes queue order, first-only preload, rapid fade reversal, position-preserving menu return, hidden-tab behavior, late song completion during fade-out, missing-file/loading failure and a separate streaming asset-size budget.
