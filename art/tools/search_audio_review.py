"""Archive Openverse metadata for a separate listening review; never alter game assets.

Usage: python3 art/tools/search_audio_review.py
Public metadata requests only. Audition downloads are a separate, curated step.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'art/archive/audio-review/search'
QUERIES = {
    'dark_spell': 'dark magic',
    'magic_impact': 'magic impact',
    'gravity': 'gravity',
    'portal': 'magic portal',
    'teleport': 'teleport',
    'shield': 'force field',
    'magic_loop': 'magic loop',
    'ice': 'ice magic',
    'fire': 'fireball',
    'electric': 'electric zap',
    'stone': 'rock debris',
    'ui': 'menu click',
    'purchase': 'coin',
}


def search(item):
    name, query = item
    params = urllib.parse.urlencode({'q': query, 'license': 'cc0', 'page_size': 20})
    url = 'https://api.openverse.org/v1/audio/?' + params
    request = urllib.request.Request(url, headers={'User-Agent': 'brawlock-asset-research'})
    with urllib.request.urlopen(request, timeout=40) as response:
        data = json.load(response)
    (OUT / f'{name}.json').write_text(json.dumps({'query': query, 'url': url, **data}, indent=2))
    return name, data['result_count'], len(data['results'])


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    failures = []
    selected = {name: QUERIES[name] for name in sys.argv[1:]} if len(sys.argv) > 1 else QUERIES
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(search, item): item[0] for item in selected.items()}
        for future in as_completed(futures):
            try:
                name, total, count = future.result()
                print(f'{name}: archived {count} of {total} results', flush=True)
            except (urllib.error.URLError, TimeoutError) as error:
                name = futures[future]
                failures.append(name)
                print(f'{name}: SEARCH FAILED: {error}', flush=True)
    if failures:
        raise SystemExit('Incomplete searches: ' + ', '.join(failures))
