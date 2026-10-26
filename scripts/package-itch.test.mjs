import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const relativeIndex = '<link rel="preload" href="./brand/splash.webp"><script type="module" src="./assets/main.js"></script>'
function build(dir, index = relativeIndex) {
  const source = join(dir, 'build')
  mkdirSync(join(source, 'assets'), { recursive: true }); mkdirSync(join(source, 'brand'))
  writeFileSync(join(source, 'index.html'), index)
  writeFileSync(join(source, 'assets/main.js'), '// fixture')
  writeFileSync(join(source, 'brand/splash.webp'), 'webp')
  writeFileSync(join(source, 'version.json'), JSON.stringify({ build: 'fixture-build', version: '0.1.0-alpha.1', releaseDate: '2026-10-26' }))
  for (const name of ['admin.html', 'sounds.html', 'googlec523c567482e96c5.html', 'privacy.html', 'terms.html', 'about.html']) writeFileSync(join(source, name), name)
  return source
}
const pack = (source, output) => spawnSync(process.execPath, ['scripts/package-itch.mjs', source, output], { encoding: 'utf8' })

test('itch packages keep the game and its policies but drop first-party-only pages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brawlock-itch-package-'))
  try {
    const output = join(dir, 'itch')
    const packaged = pack(build(dir), output)
    assert.equal(packaged.status, 0, packaged.stderr)
    for (const kept of ['index.html', 'assets/main.js', 'brand/splash.webp', 'version.json', 'privacy.html', 'terms.html', 'about.html']) assert.ok(existsSync(join(output, kept)), kept)
    // the operations shell and its OAuth callback only work on the first-party origin
    for (const dropped of ['admin.html', 'sounds.html', 'googlec523c567482e96c5.html']) assert.ok(!existsSync(join(output, dropped)), dropped)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('root-path and hosted-media builds are refused: itch serves the game under /html/<id>/ on its own host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brawlock-itch-package-'))
  try {
    const rooted = pack(build(dir, '<link href="/brand/splash.webp"><script src="/assets/main.js"></script>'), join(dir, 'a'))
    assert.notEqual(rooted.status, 0)
    assert.match(rooted.stderr, /relative-base build/)
    rmSync(join(dir, 'build'), { recursive: true })
    const hosted = pack(build(dir, '<link href="https://laubsauger.github.io/brawlock/brand/splash.webp"><script src="./assets/main.js"></script>'), join(dir, 'b'))
    assert.notEqual(hosted.status, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a build over itch.io\'s 1000-file limit is refused before any upload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brawlock-itch-package-'))
  try {
    const source = build(dir)
    mkdirSync(join(source, 'many'))
    for (let i = 0; i < 1000; i++) writeFileSync(join(source, 'many', `${i}.ogg`), '')
    const packaged = pack(source, join(dir, 'itch'))
    assert.notEqual(packaged.status, 0)
    assert.match(packaged.stderr, /itch allows 1000/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
