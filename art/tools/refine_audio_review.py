"""Build the focused second listening pass from round-one feedback.

Uses the archived source previews, three archived thunder recordings, and fresh
recipe snapshots in art/archive/audio-review/round2/baselines. Never edits game audio.
"""
from pathlib import Path
import json
from build_audio_review import ROOT, command, preview

ARCHIVE = ROOT / 'art/archive/audio-review'
WORK = ARCHIVE / 'round2/edits'
OUT = ROOT / 'artifacts/audio-review-round2'


def source(prefix, folder):
    matches = list(folder.glob(prefix + '*.json'))
    if len(matches) != 1:
        raise ValueError('Missing or ambiguous source: ' + prefix)
    metadata = json.loads(matches[0].read_text())
    if metadata['license'] != 'cc0':
        raise ValueError('Expected CC0 source: ' + prefix)
    return matches[0].with_suffix('.mp3'), metadata


def edit(name, source_path, start, duration, highpass, lowpass, fade):
    intermediate = WORK / (name + '-float.wav')
    filters = f'atrim=start={start}:duration={duration},asetpts=PTS-STARTPTS,aresample=48000,highpass=f={highpass},lowpass=f={lowpass},afade=t=in:d=0.001,afade=t=out:st={duration-fade}:d={fade}'
    command(['ffmpeg', '-hide_banner', '-nostats', '-y', '-i', str(source_path), '-af', filters, '-c:a', 'pcm_f32le', str(intermediate)])
    destination = OUT / 'audio' / (name + '.wav')
    length = preview(intermediate, destination)
    return {'file': 'audio/' + name + '.wav', 'duration': length, 'processing': {'start': start, 'duration': duration, 'highpassHz': highpass, 'lowpassHz': lowpass, 'fadeOutSeconds': fade}}


def layer(name, baseline, extra, amount):
    intermediate = WORK / (name + '-float.wav')
    command(['ffmpeg', '-hide_banner', '-nostats', '-y', '-i', str(OUT / baseline['file']), '-i', str(OUT / extra['file']), '-filter_complex', f'[0:a][1:a]amix=inputs=2:duration=longest:weights=1 {amount}:normalize=0[out]', '-map', '[out]', '-c:a', 'pcm_f32le', str(intermediate)])
    destination = OUT / 'audio' / (name + '.wav')
    duration = preview(intermediate, destination)
    return {'file': 'audio/' + name + '.wav', 'duration': duration, 'processing': {'baseline': baseline['id'], 'sourceEdit': extra['processing'], 'relativeLayerGain': amount}}


def candidate(code, title, metadata, role, listen, audio, mixed=False):
    return {'id': 'round2-' + code.lower(), 'code': code, 'title': title, 'badge': 'Review mix' if mixed else 'CC0 source edit', 'creator': ('Brawlock + ' if mixed else '') + metadata['creator'], 'source': metadata['foreign_landing_url'], 'sourceId': metadata['id'], 'license': 'CC0 source + current game audio' if mixed else 'cc0', 'licenseUrl': metadata['license_url'], 'role': role, 'listen': listen, **audio}


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    (OUT / 'audio').mkdir(parents=True, exist_ok=True)
    snapshots = json.loads((ARCHIVE / 'round2/baselines/manifest.json').read_text())
    baseline = {}
    titles = {'impact': 'Physical impact', 'explosion': 'Spell explosion', 'reflect': 'Shield reflection', 'fireballCast': 'Fireball cast', 'beamZap': 'Lightning beam zap'}
    for name, title in titles.items():
        filename = 'audio/current-' + name + '.wav'
        duration = preview(ARCHIVE / 'round2/baselines' / (name + '.wav'), OUT / filename)
        baseline[name] = {'id': name, 'title': title, 'file': filename, 'duration': duration}
    impact_source, impact_meta = source('145799e4', ARCHIVE / 'candidates')
    shield_source, shield_meta = source('178c4ee7', ARCHIVE / 'candidates')
    fire_source, fire_meta = source('0f416b9b', ARCHIVE / 'candidates')
    impact_edit = edit('s05-impact-layer', impact_source, 0.705, 0.55, 70, 4800, 0.14)
    impacts = [
        candidate('R01', 'Physical impact · subtle layer', impact_meta, 'S05 under the current physical impact', 'Compare the body with the current physical impact. Is this enough extra weight?', layer('r01-impact-subtle', baseline['impact'], impact_edit, 0.18), True),
        candidate('R02', 'Physical impact · stronger layer', impact_meta, 'S05 under the current physical impact', 'The same source is more prominent here. Choose whether the extra weight improves the hit or overpowers it.', layer('r02-impact-stronger', baseline['impact'], impact_edit, 0.36), True),
        candidate('R03', 'Spell explosion · impact layer', impact_meta, 'S05 under the current explosion, not a cast', 'Does the liked impact character also suit an explosive spell hit?', layer('r03-explosion-layer', baseline['explosion'], impact_edit, 0.28), True),
    ]
    shields = [
        candidate('R04', 'Shield impact · short', shield_meta, 'S11 reduced to a 0.28-second impact', 'The long tail is removed and some low-end bulk is reduced. Judge whether the remaining hit has the right character.', edit('r04-shield-short', shield_source, 0, 0.28, 170, 5200, 0.10)),
        candidate('R05', 'Shield impact · fuller', shield_meta, 'S11 reduced to a 0.52-second impact', 'A little more body and tail than R04. Which length feels appropriate for a reflection?', edit('r05-shield-fuller', shield_source, 0, 0.52, 140, 5200, 0.20)),
    ]
    fire = [
        candidate('R06', 'Fireball · earlier attack', fire_meta, 'S16 with 0.90 seconds of lead-in removed', 'The main attack now arrives near the beginning. Compare its character and responsiveness with the current Fireball.', edit('r06-fireball-early', fire_source, 0.90, 0.48, 65, 6500, 0.10)),
        candidate('R07', 'Fireball · compact attack', fire_meta, 'S16 with 0.94 seconds removed and a shorter tail', 'The tighter option. Does it keep enough fire texture while responding immediately?', edit('r07-fireball-compact', fire_source, 0.94, 0.32, 65, 6000, 0.10)),
    ]
    thunder = []
    for code, name, prefix, start, duration, fade, listen in [
        ('R08', 'Lightning · close thunder', 'ae930eab', 0.78, 0.55, 0.25, 'A short close-thunder excerpt. Does this move Lightning toward the clap you described?'),
        ('R09', 'Lightning · cracking thunderclap', '679eb912', 1.02, 0.50, 0.24, 'A tighter natural thunderclap with the long rumble removed. Compare the attack with R08.'),
        ('R10', 'Lightning · dry thunder crack', '5e06dffa', 2.62, 0.42, 0.20, 'An excerpt around the strongest dry crack. Pass if it is still too sharp or heavy for a frequent spell.'),
    ]:
        path, metadata = source(prefix, ARCHIVE / 'round2/sources')
        audio = edit(code.lower() + '-thunder', path, start, duration, 95, 6500, fade)
        thunder.append(candidate(code, name, metadata, 'Natural thunder edited for a Lightning attack', listen, audio))
    groups = [
        {'id': 'impact', 'title': 'Impact layers', 'description': 'Your S05 like was for impact layering. These are complete comparison mixes using the current effects, with its lead-in removed.', 'baselineNote': 'Current physical impact and spell explosion', 'baselines': [baseline['impact'], baseline['explosion']], 'candidates': impacts},
        {'id': 'shield', 'title': 'Shorter shield impacts', 'description': 'You found S11 closer to the right character but too long and chunky. These two edits test shorter tails and less low-end bulk.', 'baselineNote': 'Current shield reflection', 'baselines': [baseline['reflect']], 'candidates': shields},
        {'id': 'fire', 'title': 'Earlier Fireball attacks', 'description': 'Your S16 note was that the attack arrived too late. Both edits skip the long build-up and start around the main burst.', 'baselineNote': 'Current Fireball cast', 'baselines': [baseline['fireballCast']], 'candidates': fire},
        {'id': 'lightning', 'title': 'Thunder for Lightning', 'description': 'Your S20 note called for a snappy thunder clap. These are three natural recordings, trimmed into short attacks for comparison.', 'baselineNote': 'Current Lightning beam zap', 'baselines': [baseline['beamZap']], 'candidates': thunder},
    ]
    result = {'review': 'brawlock-openverse-sfx-round2-2026-10-18', 'storageKey': 'brawlock-sound-review-round2-v1', 'title': 'Sound effects second pass', 'subtitle': 'Ten focused options based on your feedback: impact layers, shorter shield hits, earlier Fireball attacks, and natural thunder. Compare them with the current effects, then mark your choices.', 'notice': 'R01–R03 are complete impact mixes. R04–R10 are edited source sounds to judge before mixing. All previews are peak-matched to −6 dBFS; perceived loudness can still differ. This page has its own saved feedback, and the original review remains available. These auditions do not change game audio.', 'baselineCapturedAt': snapshots['capturedAt'], 'footer': 'Second listening pass · 10 candidates · 5 current references · Your first feedback is preserved. Production game audio is unchanged. Export this pass separately when ready.', 'groups': groups}
    payload = json.dumps(result, ensure_ascii=False).replace('<', '\\u003c')
    template = Path(__file__).with_name('audio_review.html').read_text()
    if template.count('@@DATA@@') != 1:
        raise ValueError('Expected one review data placeholder')
    (OUT / 'index.html').write_text(template.replace('@@DATA@@', payload))
    (OUT / 'review.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
    (OUT / 'provenance.json').write_text(json.dumps({'priorFeedback': 'art/archive/audio-review/feedback/round1-feedback-2026-10-18.json', 'sources': [impact_meta, shield_meta, fire_meta] + [json.loads(path.read_text()) for path in sorted((ARCHIVE / 'round2/sources').glob('*.json'))], 'snapshots': snapshots, 'candidates': [item for group in groups for item in group['candidates']]}, indent=2, ensure_ascii=False))
    print(f'Built second listening pass: {OUT / "index.html"}')


if __name__ == '__main__':
    main()
