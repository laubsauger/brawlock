"""Bar-aligned 29.51-second edit of the existing selected No Safe Ground master."""
import json
import sys
import wave
from array import array
from pathlib import Path

root = Path(__file__).resolve().parents[2]
source = root / 'media/trailer/music/no_safe_ground.wav'
out = root / 'media/trailer/teaser30'
out.mkdir(parents=True, exist_ok=True)
spb, phase = 60 / 143.75, .07
with wave.open(str(source), 'rb') as w:
    assert w.getsampwidth() == 2, 'Expected the selected 16-bit PCM master'
    rate, channels = w.getframerate(), w.getnchannels()
    pcm = array('h', w.readframes(w.getnframes()))
    if sys.byteorder != 'little': pcm.byteswap()
beat = lambda b: round((phase + b * spb) * rate)
regions = [(0, beat(16)), (beat(32), beat(44)), (beat(76), beat(92)), (beat(116), len(pcm) // channels)]
edited = array('h')
for i, (start, end) in enumerate(regions):
    part = pcm[start * channels:end * channels]
    n = round(.004 * rate)
    # Four-millisecond de-click envelopes retain exact bar lengths; no overlap or phase drift.
    for frame in range(n):
        gain = frame / (n - 1)
        for ch in range(channels):
            if i: part[frame * channels + ch] = round(part[frame * channels + ch] * gain)
            if i < len(regions) - 1:
                idx = len(part) - 1 - (frame * channels + ch)
                part[idx] = round(part[idx] * gain)
    edited.extend(part)
if sys.byteorder != 'little': edited.byteswap()
with wave.open(str(out / 'no_safe_ground_30.wav'), 'wb') as w:
    w.setnchannels(channels)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(edited.tobytes())
(out / 'music.beats.json').write_text(json.dumps({
    'bpm': 143.75, 'firstDownbeat': phase, 'dur': len(edited) / channels / rate,
    'source': str(source.relative_to(root)),
    'sourceRegionsSeconds': [[a / rate, b / rate] for a, b in regions],
}, indent=2) + '\n')
print(f'{len(edited) / channels / rate:.4f}s, {rate}Hz, {channels} channels')
