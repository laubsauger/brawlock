"""Encode the approved E04 audition unchanged into browser delivery formats.

Rebuild the audition first with build_enter_audio_review.py if its master is absent.
"""
from pathlib import Path
import hashlib
import json
import shutil

from build_audio_review import ROOT, command

master = ROOT / 'artifacts/audio-enter-review/audio/e04-iron-thunder.wav'
archive = ROOT / 'art/archive/audio/review_selected'
archive.mkdir(parents=True, exist_ok=True)
shutil.copyfile(master, archive / 'ui_enter.wav')
review = json.loads((ROOT / 'artifacts/audio-enter-review/review.json').read_text())
selected = next(item for group in review['groups'] for item in group['candidates'] if item['code'] == 'E04')
metadata = {**selected, 'approved': 'User: iron thunder works', 'masterSha256': hashlib.sha256(master.read_bytes()).hexdigest(), 'delivery': {'id': 'ui_enter', 'loop': False, 'duration': 1.6, 'formats': ['Opus 96 kbps', 'AAC 96 kbps'], 'processing': 'Encode approved stereo PCM master unchanged; no extra normalization, filtering, pitch change or limiter'}}
(archive / 'ui_enter.json').write_text(json.dumps(metadata, indent=2))
for extension, codec, extra in [('ogg', 'libopus', ['-vbr', 'on', '-application', 'audio']), ('m4a', 'aac_at', [])]:
    destination = ROOT / 'public/audio' / ('ui_enter.' + extension)
    command(['ffmpeg', '-v', 'error', '-y', '-i', str(master), '-c:a', codec, '-b:a', '96k', *extra, str(destination)])
    print(destination)
