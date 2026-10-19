"""Audition vocal deaths and announcer processing; never alter game audio.

Sources/snapshots: art/archive/audio-review/death; existing announcer raw takes.
"""
from pathlib import Path
import json
import math
import re

from build_audio_review import ROOT, command, preview, probe

ARCHIVE = ROOT / 'art/archive/audio-review/death'
OUT = ROOT / 'artifacts/death-voice-review'
WORK = ARCHIVE / 'edits'


def source(prefix):
    paths = list((ARCHIVE / 'sources').glob(prefix + '*.json'))
    if len(paths) != 1:
        raise ValueError('Missing/ambiguous source: ' + prefix)
    metadata = json.loads(paths[0].read_text())
    if metadata['license'] != 'cc0':
        raise ValueError('Expected CC0')
    return paths[0].with_suffix('.mp3'), metadata


def edit(name, prefix, start, length):
    path, meta = source(prefix)
    intermediate = WORK / (name + '.wav')
    command(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-af', f'atrim=start={start}:duration={length},asetpts=PTS-STARTPTS,aresample=48000,highpass=f=70,lowpass=f=6500,afade=t=in:d=0.003,afade=t=out:st={length-min(0.12,length/3)}:d={min(0.12,length/3)}', '-ac', '1', '-c:a', 'pcm_f32le', str(intermediate)])
    destination = OUT / 'audio' / (name + '.wav')
    preview(intermediate, destination)
    return destination, {'source': meta, 'start': start, 'duration': length, 'filters': '70–6500 Hz, 3 ms fade in, short fade out; static peak match −6 dBFS; no pitch change'}


def mix(name, paths, weights):
    destination = OUT / 'audio' / (name + '.wav')
    temporary = WORK / (name + '.wav')
    inputs = [part for path in paths for part in ['-i', str(path)]]
    command(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ''.join(f'[{i}:a]' for i in range(len(paths))) + f'amix=inputs={len(paths)}:weights=' + ' '.join(str(x) for x in weights) + ':normalize=0:duration=longest[out]', '-map', '[out]', '-ac', '1', '-c:a', 'pcm_f32le', str(temporary)])
    preview(temporary, destination)
    return destination


def sequence(name, paths):
    destination = OUT / 'audio' / (name + '.wav')
    inputs = [part for path in paths for part in ['-i', str(path)]]
    filters = ';'.join(f'[{i}:a]aresample=48000,aformat=channel_layouts=mono,apad=pad_dur=0.6[p{i}]' for i in range(len(paths)))
    filters += ';' + ''.join(f'[p{i}]' for i in range(len(paths))) + f'concat=n={len(paths)}:v=0:a=1[out]'
    command(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', filters, '-map', '[out]', '-c:a', 'pcm_s16le', str(destination)])
    return {'file': 'audio/' + destination.name, 'duration': round(probe(destination), 3)}


def candidate(code, title, role, listen, audio, metadata, processing):
    return {'id': 'death-voice-' + code.lower(), 'code': code, 'title': title, 'badge': 'Audition only', 'creator': metadata['creator'], 'source': metadata['url'], 'license': metadata['license'], 'licenseUrl': metadata['licenseUrl'], 'role': role, 'listen': listen, **audio, 'processing': processing}


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    (OUT / 'audio').mkdir(parents=True, exist_ok=True)
    current = {}
    for name in ['death', 'killConfirm']:
        current[name] = OUT / 'audio' / ('current-' + name + '.wav')
        preview(ARCHIVE / 'baselines' / (name + '.wav'), current[name])
    # Mix the original snapshots before normalization so their relative game levels survive.
    killer = mix('current-credited-kill', [ARCHIVE / 'baselines/death.wav', ARCHIVE / 'baselines/killConfirm.wav'], [1, 1])
    cries = [edit('cry-' + str(i), prefix, start, length) for i, (prefix, start, length) in enumerate([
        ('4d506ee0', 0.025, 1.35), ('e46f2779', 0.005, 1.4), ('d94d4a88', 0.005, 0.95),
    ], 1)]
    grunts = [edit('grunt-' + str(i), prefix, start, length) for i, (prefix, start, length) in enumerate([
        ('62fda412', 0.325, 0.45), ('1be3ef8d', 0.315, 0.4), ('758b5863', 0.345, 0.4),
    ], 1)]
    vocal_mix = [mix('vocal-kill-' + str(i), [path, current['death'], current['killConfirm']], [1, 0.18, 0.28]) for i, (path, _) in enumerate(cries, 1)]
    def credit(edits):
        metadata = [m['source'] for _, m in edits]
        return {'creator': ' + '.join(dict.fromkeys(m['creator'] for m in metadata)), 'url': metadata[0]['foreign_landing_url'], 'license': 'cc0', 'licenseUrl': metadata[0]['license_url']}
    deaths = [
        candidate('D01', 'Three death cries', 'Three vocal variants · 0.95–1.40 seconds each', 'Shorter voiced deaths. Each attack is followed by silence so you can judge all three variations separately.', sequence('death-cries', [p for p, _ in cries]), credit(cries), [m for _, m in cries]),
        candidate('D02', 'Three short grunts', 'Three dry vocal variants · 0.40–0.45 seconds each', 'The restrained option. Compare their character with D01; they may be too brief if you want a substantial death cry.', sequence('death-grunts', [p for p, _ in grunts]), credit(grunts), [m for _, m in grunts]),
        candidate('D03', 'Credited kill · voice leads', 'Three complete audition mixes · cry + quieter impact + personal reward', 'Compare with the current credited-kill reference. The voice leads; the death body and killer confirmation are much quieter. This tests the mix as well as the vocal choice.', sequence('vocal-kills', vocal_mix), credit(cries), {'voices': [m for _, m in cries], 'relativeWeights': {'voice': 1, 'peakMatchedDeath': 0.18, 'peakMatchedKillConfirm': 0.28}, 'note': 'Illustrative blend; final runtime gains still need calibration'}),
    ]
    lines = ['first_blood', 'double_kill', 'godlike']
    speech = {}
    for voice in ['maverick', 'arena']:
        speech[voice] = sequence(voice + '-comparison', [ROOT / 'public/audio/announcer' / f'{voice}_{line}.ogg' for line in lines])
    picks = json.loads((ROOT / 'art/archive/audio/announcer/maverick/picks.json').read_text())
    dry = []
    for line in lines:
        path = ROOT / 'art/archive/audio/announcer/maverick' / picks[line]['take']
        temporary = WORK / ('dry-' + line + '.wav')
        filters = 'aresample=48000,silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,highpass=f=70,equalizer=f=280:t=q:w=0.8:g=-1.5,equalizer=f=2600:t=q:w=0.8:g=2.5,acompressor=threshold=0.12:ratio=1.8:attack=8:release=90:makeup=1'
        command(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-af', filters, '-ac', '1', '-c:a', 'pcm_f32le', str(temporary)])
        measured = command(['ffmpeg', '-hide_banner', '-nostats', '-i', str(temporary), '-af', 'ebur128=peak=true', '-f', 'null', '-']).stderr
        loudness = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', measured)[-1])
        peak = float(re.findall(r'Peak:\s+(-?[\d.]+) dBFS', measured)[-1])
        if not math.isfinite(loudness + peak):
            raise ValueError('Silent announcer take: ' + line)
        gain = min(-16 - loudness, -1.5 - peak)
        destination = OUT / 'audio' / ('maverick-dry-' + line + '.wav')
        duration = probe(temporary)
        command(['ffmpeg', '-v', 'error', '-y', '-i', str(temporary), '-af', f'volume={gain}dB,afade=t=in:d=0.003,afade=t=out:st={max(0,duration-0.08)}:d=0.08', '-c:a', 'pcm_s16le', str(destination)])
        dry.append(destination)
    own = {'creator': 'Brawlock / ElevenLabs', 'url': 'https://elevenlabs.io', 'license': 'ElevenLabs', 'licenseUrl': 'https://elevenlabs.io'}
    announcers = [
        candidate('V01', 'Daniel · currently called Arena', 'Alternate voice pack · First Blood / Double Kill / Godlike', 'This is what selecting Arena plays. Compare it directly with the Maverick reference before deciding whether the voice selection explains the weak sound.', speech['arena'], own, 'Current shipped Daniel/Arena samples, unaltered apart from pauses between clips'),
        candidate('V02', 'Maverick · drier presence', 'Original voice, alternate processing · same three calls', 'The same selected raw Maverick takes with less room sound, a small presence lift and gentle compression. Loudness targets the existing −16 LUFS with peak headroom; no pitch shift or new voice generation.', sequence('maverick-dry-comparison', dry), own, {'takes': {line: picks[line]['take'] for line in lines}, 'filters': filters, 'level': 'Static gain toward −16 LUFS, capped at −1.5 dB true peak; short fades; no added echo'}),
    ]
    snapshots = json.loads((ARCHIVE / 'baselines/manifest.json').read_text())
    result = {'review': 'brawlock-death-voice-2026-10-19', 'storageKey': 'brawlock-death-voice-review-v1', 'title': 'Death voices & announcer', 'subtitle': 'Compare vocal death variations, the full credited-kill mix, and Maverick versus Daniel. Mark the direction you want before any sound pack changes.', 'notice': 'D01–D03 each play three variants in order. Death previews use −6 dBFS peaks; announcer references retain their current processing, and V02 targets their existing loudness. The references are separate world-death and killer-heard sounds. No game death or announcer audio is replaced by this review.', 'baselineCapturedAt': snapshots['capturedAt'], 'footer': 'Three death directions · Two announcer alternatives · Independent saved feedback · Sources, takes and processing retained locally.', 'groups': [
        {'id': 'death', 'title': 'Give deaths a voice', 'description': 'A killer currently hears the shared death effect plus a private kill confirmation. Judge the vocal character and the combined mix separately. Rotation among approved variants would happen once per death; these sequences demonstrate variation rather than playing all three on one kill.', 'baselineNote': 'Current complete recipes', 'baselines': [{'id': 'death', 'title': 'World death only', 'file': 'audio/current-death.wav', 'duration': probe(current['death'])}, {'id': 'credited-kill', 'title': 'Credited kill · both effects', 'file': 'audio/' + killer.name, 'duration': probe(killer)}], 'candidates': deaths},
        {'id': 'announcer', 'title': 'Voice selection or processing?', 'description': 'Maverick is the default. The saved Arena setting chooses Daniel; selecting Maverick never substitutes Daniel. These are First Blood, Double Kill and Godlike in the same order. Your active saved setting cannot be read from this review.', 'baselineNote': 'Default Maverick · current shipped samples', 'baselines': [{'id': 'maverick', 'title': 'Maverick · current', **speech['maverick']}], 'candidates': announcers},
    ]}
    template = Path(__file__).with_name('audio_review.html').read_text()
    if template.count('@@DATA@@') != 1:
        raise ValueError('Review template changed')
    payload = json.dumps(result, ensure_ascii=False).replace('<', '\\u003c')
    (OUT / 'index.html').write_text(template.replace('@@DATA@@', payload))
    (OUT / 'review.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
    (OUT / 'provenance.json').write_text(json.dumps({'snapshots': snapshots, 'candidates': deaths + announcers}, indent=2, ensure_ascii=False))
    print('Built: ' + str(OUT / 'index.html'))


if __name__ == '__main__':
    main()
