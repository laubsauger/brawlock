"""Build Enter-button auditions from archived Openverse previews; no game changes.

Requires art/archive/audio-review/enter/{sources,baselines} and ffmpeg/ffprobe.
Render the baseline with render_audio_review.mjs and enter/cues.json first.
"""
from pathlib import Path
import json

from build_audio_review import ROOT, command, preview

ARCHIVE = ROOT / 'art/archive/audio-review/enter'
OUT = ROOT / 'artifacts/audio-enter-review'
WORK = ARCHIVE / 'edits'


def source(prefix):
    matches = list((ARCHIVE / 'sources').glob(prefix + '*.json'))
    if len(matches) != 1:
        raise ValueError('Missing or ambiguous source: ' + prefix)
    metadata = json.loads(matches[0].read_text())
    if metadata['license'] != 'cc0':
        raise ValueError('Expected CC0: ' + prefix)
    return matches[0].with_suffix('.mp3'), metadata


def edit(name, prefix, start, duration, highpass, lowpass, fade):
    path, metadata = source(prefix)
    intermediate = WORK / (name + '.wav')
    filters = f'atrim=start={start}:duration={duration},asetpts=PTS-STARTPTS,aresample=48000,highpass=f={highpass},lowpass=f={lowpass},afade=t=in:d=0.001,afade=t=out:st={duration-fade}:d={fade}'
    command(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-af', filters, '-c:a', 'pcm_f32le', str(intermediate)])
    filename = 'audio/' + name + '.wav'
    length = preview(intermediate, OUT / filename)
    return {'file': filename, 'duration': length, 'sources': [metadata], 'processing': {'start': start, 'duration': duration, 'highpassHz': highpass, 'lowpassHz': lowpass, 'fadeOutSeconds': fade}}


def context(name, cue):
    filename = 'audio/' + name + '-menu.wav'
    # Illustrative fixed mix: existing first menu song, 0.5 song gain x 0.65 music.
    # The game's shared effects and browser start latency are not simulated here.
    command(['ffmpeg', '-v', 'error', '-y', '-i', str(OUT / cue), '-i', str(ROOT / 'public/audio/music/circle-of-ash-1.mp3'), '-filter_complex', '[0:a]aresample=48000,apad=whole_dur=6[s];[1:a]atrim=duration=6,asetpts=PTS-STARTPTS,aresample=48000,volume=0.325,afade=t=in:d=1.2,afade=t=out:st=5.5:d=0.5[m];[s][m]amix=inputs=2:normalize=0:duration=shortest[out]', '-map', '[out]', '-c:a', 'pcm_s16le', str(OUT / filename)])
    return filename


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    (OUT / 'audio').mkdir(parents=True, exist_ok=True)
    snapshots = json.loads((ARCHIVE / 'baselines/manifest.json').read_text())
    baseline_file = 'audio/current-uiReady.wav'
    duration = preview(ARCHIVE / 'baselines/uiReady.wav', OUT / baseline_file)
    baselines = [
        {'id': 'current', 'title': 'Current Enter · isolated', 'file': baseline_file, 'duration': duration},
        {'id': 'current-menu', 'title': 'Current Enter · with menu music', 'file': context('current', baseline_file), 'duration': 6},
    ]
    iron = edit('e01-forged-gate', 'a094a313', 0.065, 1.25, 65, 4500, 0.5)
    gong = edit('e02-ritual-gong', 'c8d52a28', 10.915, 1.65, 65, 4500, 0.7)
    impact = edit('e03-arena-arrival', '2e291c8c', 0.235, 1.45, 55, 5200, 0.55)
    boom = edit('e04-iron-thunder', 'e26ac0c1', 0.05, 1.6, 60, 4200, 0.65)
    mixed = WORK / 'pact-seal.wav'
    command(['ffmpeg', '-v', 'error', '-y', '-i', str(OUT / iron['file']), '-i', str(OUT / gong['file']), '-filter_complex', '[0:a][1:a]amix=inputs=2:weights=1 0.45:normalize=0:duration=longest[out]', '-map', '[out]', '-c:a', 'pcm_f32le', str(mixed)])
    seal_file = 'audio/e05-pact-seal.wav'
    seal = {'file': seal_file, 'duration': preview(mixed, OUT / seal_file), 'sources': iron['sources'] + gong['sources'], 'processing': {'inputs': [iron['file'], gong['file']], 'weights': [1, 0.45], 'alignment': 'both attacks at the trigger'}}
    choices = [
        ('E01', 'Forged gate', 'Low metal strike · 1.25 s', 'Try this for a physical entrance accent with a compact tail. Judge the metal attack on both headphones and speakers.', iron),
        ('E02', 'Ritual gong', 'Low gong strike · 1.65 s', 'The percussion-led option. Judge whether its low resonance feels suitably ominous or too ceremonial.', gong),
        ('E03', 'Arena arrival', 'Cinematic impact · 1.45 s', 'A broader entrance impact. Compare its body with E01 and pass if it feels too much like a generic trailer boom.', impact),
        ('E04', 'Iron thunder', 'Metallic cinematic impact · 1.60 s', 'The heavier designed-effect option. Pass if its processed texture still feels too synthetic.', boom),
        ('E05', 'Pact seal', 'Metal attack + low gong · 1.65 s', 'A combined option: E01 provides the attack and E02 adds a quieter ritual tail. Compare it directly with E01; is the extra resonance useful?', seal),
    ]
    candidates = []
    for code, title, role, listen, audio in choices:
        metadata = audio['sources'][0]
        candidates.append({'id': 'enter-' + code.lower(), 'code': code, 'title': title, 'badge': 'CC0 source mix' if code == 'E05' else 'CC0 source edit', 'creator': ' + '.join(item['creator'] for item in audio['sources']), 'source': metadata['foreign_landing_url'], 'license': 'cc0', 'licenseUrl': metadata['license_url'], 'role': role, 'listen': listen, **audio, 'contextFile': context(code.lower(), audio['file'])})
    result = {
        'review': 'brawlock-enter-sfx-2026-10-19', 'storageKey': 'brawlock-enter-sound-review-v1',
        'title': 'Enter the arena',
        'subtitle': 'Five heavier directions for the splash-screen Enter button. Compare the current chime, listen alone or over the menu theme, then mark what works.',
        'notice': 'Use the first player for the effect alone and the second for a six-second preview over Circle of Ash. Effects are peak-matched to −6 dBFS; perceived loudness still differs. The music mix is illustrative, with a fixed fade and balance. These auditions do not change game audio.',
        'baselineCapturedAt': snapshots['capturedAt'],
        'footer': 'Five Enter candidates · Sources and edits archived · This review saves separately from earlier feedback. Export your choices when ready.',
        'groups': [{'id': 'enter', 'title': 'Splash-screen Enter', 'description': 'Immediate weight on the click, followed by a short dark tail. E01 and E05 test a physical metal attack; E02 tests a low ritual gong; E03–E04 test broader cinematic impacts.', 'baselineNote': 'The current three-note synthetic chime', 'baselines': baselines, 'candidates': candidates}],
    }
    template = Path(__file__).with_name('audio_review.html').read_text()
    marker = "    const votes = el('div', 'votes');"
    if template.count(marker) != 1 or template.count('@@DATA@@') != 1:
        raise ValueError('Review template changed; inspect player insertion')
    template = template.replace(marker, "    card.append(el('p', 'listen', 'With menu music'), audioPlayer(track.contextFile, track.code + ' — with menu music'));\n" + marker)
    payload = json.dumps(result, ensure_ascii=False).replace('<', '\\u003c')
    (OUT / 'index.html').write_text(template.replace('@@DATA@@', payload))
    (OUT / 'review.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
    (OUT / 'provenance.json').write_text(json.dumps({'snapshots': snapshots, 'context': {'song': 'public/audio/music/circle-of-ash-1.mp3', 'musicGain': 0.325, 'fadeInSeconds': 1.2, 'durationSeconds': 6, 'note': 'Illustrative mix, not a capture of the game audio graph'}, 'candidates': candidates}, indent=2, ensure_ascii=False))
    print('Built Enter review: ' + str(OUT / 'index.html'))


if __name__ == '__main__':
    main()
