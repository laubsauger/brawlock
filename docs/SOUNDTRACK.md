# Brawlock soundtrack and Suno prompt guide

An instrumental dark-fantasy score for Brawlock: ritual drums, low strings, threatening brass, iron bells and a recognizable melodic theme. Combat arrangements need space for spell sounds and readable impacts. The menu establishes the musical identity; preparation, combat and results give it different energy levels.

The prompts and slider values below are suggested starting points. Suno documents the controls, but the requested tempo, duration, melodic details and loop behavior still need checking in the generated audio.

## Soundtrack plan

The default match ends at five round wins, with 25-second shop phases between rounds. Music must support repeated rounds and changes of state. A track does not need to last an entire match: suitable loop points and several distinct combat cues provide coverage and variety.

| Use | Track | Target duration |
|---|---|---|
| Main menu and lobby | Circle of Ash | Initial 2–3 minutes; optionally extend to 3–5 minutes |
| Shop and preparation | Pacts and Embers | 2–3 minutes, loopable |
| Combat A | Iron in the Circle | Initial 2–3 minutes; optionally extend to 3–4 minutes |
| Combat B | Obsidian Teeth | 3–4 minutes, loopable |
| Combat C | Runebreaker | 3–4 minutes, loopable |
| Final shrinking arena | The Last Ring | 1–2 minutes, loopable |
| Match results | The Embers Remain | 45–90 seconds, loopable |
| Trailer | Into the Lava | Approximately 75–90 seconds, edited to the footage |

Prioritize two additional combat tracks, then the results cue. Extend a successful recording rather than regenerating a longer version from scratch. A restrained menu extension is useful if players spend a long time in the lobby.

Suggested playback behavior for later integration: choose a different combat cue between rounds, avoid consecutive repeats and loop the active cue if the fight outlasts it. Combat cues should establish useful battle music immediately. Trigger endgame music from the actual game state rather than relying on a timed crescendo. Keep menu playback continuous across related menu screens. These are integration recommendations; this guide does not implement them.

## Suno fields

Use Create → Custom. The Styles field describes sound and arrangement; Lyrics contains sung words. With Instrumental enabled, leave Lyrics blank and put the arrangement directions in Styles.

| Field | Starting value |
|---|---|
| Model | v6 |
| Instrumental | On |
| Lyrics | Blank |
| Styles | The corresponding track prompt below |
| Exclude | Shared exclusion list below |
| Vocal Gender | Unset |
| Weirdness | 30% |
| Style Influence | 85% |
| Variety | 0% |
| Audio or reference | Empty for the first theme; use the winning theme when developing related cues |
| Audio Influence | Applicable only with attached audio; audition for the desired balance |
| Max Mode | Off for initial auditions; consider On for final tracks longer than two minutes |
| Title | The corresponding title below |

Weirdness runs from Safe to Chaos; Suno calls 50% the normal expected setting. Style Influence controls adherence to the style input. Audio Influence appears when audio is uploaded. Variety at zero prevents that control from adjusting the style tags. Max Mode costs additional credits and is intended for uses including longer tracks and consistent style. v6 supports up to eight minutes per generation; that is a maximum, not a promised length.

Use concrete musical decisions in Styles: instrument roles, tempo, rhythm, mood, melodic character and arrangement. An ostinato is a repeating musical pattern; a pedal is a sustained or repeated foundation note. Neither the game title nor the word "epic" specifies those decisions on its own.

### Shared Exclude field

```text
pop, dance-pop, EDM drops, four-on-the-floor dance beat, trap hi-hats, rap, lead vocals, spoken word, choir, acoustic singer-songwriter, uplifting major-key anthem, sentimental piano ballad
```

## 1. Main menu and lobby

Title:

```text
Brawlock — Circle of Ash
```

Styles:

```text
Instrumental dark fantasy video game main-menu theme. 96 BPM, 4/4, D Phrygian. Menacing, commanding, with restrained swagger. Low cellos carry a memorable four-note motif, answered by rough low brass and a distant iron bell. Deep hide drums play a deliberate, syncopated ritual rhythm over a sustained D bass pedal. Dry percussion, dark room ambience, clear separation between instruments. Establish the melody early. Alternate a sparse bell-and-cello passage with a fuller statement of the theme, then return to the opening texture. Maintain a steady sense of anticipation, with measured changes in intensity and an ending suitable for editing into a loop. Entirely instrumental.
```

The scene is dangerous warlocks gathering before a duel. Look for a memorable tune and controlled intensity that remains comfortable over several minutes.

## 2. Shop and preparation

Title:

```text
Pacts and Embers
```

Styles:

```text
Instrumental dark fantasy video game preparation music. 76 BPM, 4/4, D Phrygian. Quiet intrigue and controlled anticipation. Muted plucked strings trade short phrases with a low bronze bell over a warm cello drone. Sparse hand drums maintain a gentle pulse. Introduce a short four-note melody and leave generous silence between its phrases. Small variations in instrumentation every eight bars, stable harmony, restrained dynamics. Intimate stone-room acoustics, clear midrange, soft percussion transients. Sustain this reflective mood throughout, returning naturally to the opening texture for a loop edit. Entirely instrumental.
```

Give players a breather while they choose spells, while keeping the sense of a dangerous place.

## 3. Regular combat A

Title:

```text
Iron in the Circle
```

Styles:

```text
Instrumental dark fantasy arena combat game score. 128 BPM, 4/4, D Phrygian. Aggressive, focused momentum. Short bowed cello patterns lock to pounding hide drums with syncopated accents. Low brass delivers brief threatening answers, and occasional struck iron accents mark the phrases. A sustained D bass foundation keeps the harmony tense. Establish the combat rhythm immediately and sustain it through repeating eight-bar sections with small rhythmic variations. Compact melodic phrases, dry punchy percussion, restrained upper register, open space between accents for gameplay sound effects. Consistent battle intensity and recurring material suitable for a loop edit. Entirely instrumental.
```

Forward motion and aggression with a relatively sparse arrangement. Extend a successful take if more internal variation is needed.

## 4. Final shrinking arena

Title:

```text
The Last Ring
```

Styles:

```text
Instrumental dark fantasy sudden-death arena game score. 144 BPM, 4/4, D Phrygian. Urgent, claustrophobic tension. Tight repeated low-string figures and hard hide-drum strokes drive a relentless pulse. Short dissonant brass answers and sharp iron strikes create danger, with friction between D and E-flat over a sustained D bass. Begin at high tension. Alternate denser rhythmic passages with brief stripped-back passages that retain the pulse. Keep the orchestration compact, the attacks precise, and the melody fragmented. Stable tempo, clear percussion, restrained reverb, recurring sections suitable for a loop edit. Entirely instrumental.
```

Higher pressure and less breathing room while preserving clarity for the fight.

## 5. Trailer

Title:

```text
Into the Lava
```

Styles:

```text
Instrumental dark fantasy arena game trailer score, approximately 80 seconds. 128 BPM, 4/4, D Phrygian. Begin with a solitary iron bell and a threatening low-cello melody. Bring in syncopated hide drums and short low-string patterns, then develop the melody into a forceful low-brass statement. Build through distinct phrases with clear accents for gameplay cuts. Briefly strip back to bell and bass before the final full-ensemble return. Heavy, physical percussion, rough brass texture, clear melodic identity, and audible space for spell impacts. Finish with a decisive unison accent and a short natural decay for the game logo. Entirely instrumental.
```

Use the winning menu recording as a reference. The trailer can have a deliberate build and final accent because its length will be controlled by the edit.

## 6. Regular combat B

Title:

```text
Obsidian Teeth
```

Styles:

```text
Instrumental dark fantasy arena combat game music. 124 BPM, 4/4, D Phrygian. Heavy, predatory momentum. Interlocking low hide drums and dry wooden strikes drive a muscular syncopated rhythm. Bowed double bass and cellos play short descending phrases, with occasional rough low-brass answers. Sparse bronze bell accents suggest dangerous magic. Start directly with the established battle pulse. Develop recurring sections through changing drum patterns, bass movement and brief melodic variations. Alternate fuller passages with lean percussion-and-bass passages while maintaining momentum. Clear space for spell sounds, controlled dynamics, short reverb. Target a three-to-four-minute arrangement with a recurring passage suitable for a loop edit. Entirely instrumental.
```

More physical and percussive than Iron in the Circle, giving the rotation a different character.

## 7. Regular combat C

Title:

```text
Runebreaker
```

Styles:

```text
Instrumental dark fantasy spell-duel game score. 132 BPM, 4/4, D Phrygian. Tense, agile, dangerous. Low strings maintain a restless repeating pulse while muted hammered strings and dark metallic bells exchange short angular melodies. Tight frame drums add irregular accents over a grounded bass pedal. Occasional low-brass phrases add weight. Begin with immediate rhythmic movement. Develop several recurring instrumental sections, varying the melodic responses and percussion density. Brief sparse passages retain the pulse before the full rhythm returns. Precise attacks, restrained high frequencies, clear separation for gameplay effects. Target three to four minutes, with stable tempo and material suitable for a loop edit. Entirely instrumental.
```

More arcane and agile, providing contrast to the heavier drum-and-brass tracks.

## 8. Match results

Title:

```text
The Embers Remain
```

Styles:

```text
Instrumental dark fantasy game results-screen music. 72 BPM, 4/4, D minor with occasional Phrygian color. Solemn satisfaction after a dangerous contest. Warm low cellos carry a short dignified melody, answered by a distant bronze bell and restrained horns. Sparse deep drum accents, spacious arrangement, gentle room ambience. Open with a brief statement of arrival, then settle into a quiet reflective passage. Understated strength and lingering mystery. Target sixty to ninety seconds, ending in a sustained low-string texture suitable for a loop edit. Entirely instrumental.
```

A release of tension after winning or losing, with enough restraint for reviewing scores.

## Keeping the tracks coherent

For the initial theme, generate three pairs using the same settings. Choose on melodic identity, instrumental character, and whether the track becomes tiring. Keep the successful recordings as the references for related cues.

Repeating D Phrygian in text provides a common harmonic palette but does not reliably preserve the same melody. Attach the winning theme when developing a related recording and add this direction:

```text
Preserve the reference track's main melodic motif and instrumental character. Rearrange that theme into the structure described here.
```

Check the actual results for unwanted vocals, clipping, distracting flourishes and a usable loop passage. Final loop points should be edited and checked in an audio editor; requesting a loop in the prompt does not guarantee a seamless file.

## Extending a recording you already like

Choose the recording's … menu → Remix/Edit → Extend. Select a continuation point before the existing outro or fade. Keep the original style description and add this extension direction:

```text
Continue the existing instrumental game score, preserving its tempo, tonal center, instrumental character and main melodic motif. Develop a contrasting middle passage with reduced instrumentation, then return to the established theme with subtle rhythmic and orchestral variations. Maintain the original energy level. Keep the pulse running through transitions. Sustain the arrangement for approximately two additional minutes before returning to a recurring texture suitable for a loop edit.
```

Audition the extension. Once it works, choose Create → Get Whole Song to join it to the original. Judge continuity at the join and the additional musical variation before keeping the longer take.

## Official Suno references

- [Custom Mode and the Instrumental toggle](https://help.suno.com/en/articles/3726721)
- [Creative Sliders](https://help.suno.com/en/articles/6141377)
- [v6 FAQ: Variety, Max Mode and references](https://help.suno.com/en/articles/13924481)
- [v6 capabilities and maximum generation length](https://help.suno.com/en/articles/13924801)
- [Exclude field](https://help.suno.com/en/articles/3161921)
- [Musical prompt vocabulary](https://help.suno.com/en/articles/9010177)
- [Extend and Get Whole Song](https://help.suno.com/en/articles/2409601)
