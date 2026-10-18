"""Download a curated CC0 shortlist and build the independent listening page.

Usage: python3 art/tools/build_audio_review.py
Requires archived searches, render_audio_review.mjs snapshots, and ffmpeg/ffprobe.
All output is review material. Nothing in public/audio or src/audio is modified.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import json
import math
import re
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / 'art/archive/audio-review'
OUTPUT = ROOT / 'artifacts/audio-review'
SELECTION = Path(__file__).with_name('audio_review_selection.json')
TEMPLATE = Path(__file__).with_name('audio_review.html')


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def probe(path):
    result = command(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(path)])
    duration = float(json.loads(result.stdout)['format']['duration'])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f'Invalid audio duration: {path}')
    return duration


def preview(source, destination):
    probe(source)
    # Measure floating-point peaks after resampling. volumedetect converts to s16,
    # which clips decoded MP3 overshoots before measuring and understates their level.
    result = command(['ffmpeg', '-hide_banner', '-nostats', '-i', str(source), '-af', 'aresample=48000,aformat=sample_fmts=flt,astats=metadata=0:reset=0', '-c:a', 'pcm_f32le', '-f', 'null', '-'])
    matches = re.findall(r'Peak level dB: (-?[\d.]+)', result.stderr)
    if not matches:
        raise ValueError(f'No non-silent peak found in {source}')
    gain = -6 - float(matches[-1])
    command(['ffmpeg', '-hide_banner', '-nostats', '-y', '-i', str(source), '-map', '0:a:0', '-af', f'aresample=48000,volume={gain:.3f}dB', '-c:a', 'pcm_s16le', str(destination)])
    return round(probe(destination), 3)


def download(metadata):
    if metadata['license'] != 'cc0' or metadata.get('mature'):
        raise ValueError('Candidate must be non-mature CC0: ' + metadata['id'])
    if not metadata['url'].startswith('https://cdn.freesound.org/'):
        raise ValueError('Expected the documented Freesound preview host: ' + metadata['url'])
    folder = ARCHIVE / 'candidates'
    destination = folder / (metadata['id'] + '.mp3')
    if not destination.exists():
        request = urllib.request.Request(metadata['url'], headers={'User-Agent': 'brawlock-asset-research'})
        with urllib.request.urlopen(request, timeout=35) as response:
            content = response.read()
        if len(content) < 100:
            raise ValueError('Empty preview: ' + metadata['id'])
        temporary = destination.with_suffix('.part')
        temporary.write_bytes(content)
        probe(temporary)
        temporary.rename(destination)
    probe(destination)
    (folder / (metadata['id'] + '.json')).write_text(json.dumps(metadata, indent=2))
    return metadata['id'], destination


def main():
    (ARCHIVE / 'candidates').mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'audio').mkdir(parents=True, exist_ok=True)
    selection = json.loads(SELECTION.read_text())
    searches = {}
    for path in sorted((ARCHIVE / 'search').glob('*.json')):
        data = json.loads(path.read_text())
        for item in data['results']:
            searches[item['id']] = item
    chosen = []
    for group in selection['groups']:
        for candidate in group['candidates']:
            matches = [item for identifier, item in searches.items() if identifier.startswith(candidate['prefix'])]
            if len(matches) != 1:
                raise ValueError('Ambiguous or missing selection: ' + candidate['prefix'])
            metadata = matches[0]
            # A reviewed selection can later ship; historical reviews still rebuild.
            candidate['metadata'] = metadata
            chosen.append(metadata)
    identifiers = [item['id'] for item in chosen]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError('Duplicate candidates in the shortlist')
    downloads = {}
    errors = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(download, metadata): metadata for metadata in chosen}
        for future in as_completed(futures):
            try:
                identifier, path = future.result()
                downloads[identifier] = path
                print('Archived: ' + futures[future]['title'], flush=True)
            except Exception as error:
                errors.append((futures[future]['id'], str(error)))
    if errors:
        raise RuntimeError('Candidate downloads failed: ' + json.dumps(errors))
    baselines = json.loads((ARCHIVE / 'baselines/manifest.json').read_text())
    result = {'review': selection['review'], 'storageKey': 'brawlock-sound-review-v1', 'baselineCapturedAt': baselines['capturedAt'], 'previewProcessing': 'Static peak normalization to -6 dBFS after 48 kHz resampling, full preview duration, lossless PCM WAV. No pitch changes or replacement of game assets.', 'groups': []}
    provenance = []
    ordinal = 1
    for group in selection['groups']:
        entry = {key: group[key] for key in ['id', 'title', 'description', 'baselineNote']}
        entry['baselines'] = []
        for baseline in group['baselines']:
            filename = 'audio/current-' + baseline['id'] + '.wav'
            duration = preview(ARCHIVE / 'baselines' / (baseline['id'] + '.wav'), OUTPUT / filename)
            entry['baselines'].append({**baseline, 'file': filename, 'duration': duration})
        entry['candidates'] = []
        for candidate in group['candidates']:
            metadata = candidate['metadata']
            filename = 'audio/' + metadata['id'] + '.wav'
            duration = preview(downloads[metadata['id']], OUTPUT / filename)
            item = {'id': metadata['id'], 'code': f'S{ordinal:02}', 'badge': 'CC0', 'title': metadata['title'], 'creator': metadata['creator'], 'source': metadata['foreign_landing_url'], 'license': metadata['license'], 'licenseUrl': metadata['license_url'], 'file': filename, 'duration': duration, 'role': candidate['role'], 'listen': candidate['listen']}
            entry['candidates'].append(item)
            provenance.append({'code': item['code'], 'category': group['title'], 'metadata': metadata})
            ordinal += 1
        result['groups'].append(entry)
    payload = json.dumps(result, ensure_ascii=False).replace('<', '\\u003c')
    template = TEMPLATE.read_text()
    if template.count('@@DATA@@') != 1:
        raise ValueError('Expected exactly one review data placeholder')
    (OUTPUT / 'index.html').write_text(template.replace('@@DATA@@', payload))
    (OUTPUT / 'provenance.json').write_text(json.dumps(provenance, indent=2, ensure_ascii=False))
    (OUTPUT / 'review.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(f'Built {len(chosen)} new candidates and {sum(len(group["baselines"]) for group in result["groups"])} current-sound snapshots: {OUTPUT / "index.html"}', flush=True)


if __name__ == '__main__':
    main()
