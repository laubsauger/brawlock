import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('first-party packages retain public policies and the exact Google ownership file across releases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brawlock-site-package-'))
  try {
    const source = join(dir, 'build'), output = join(dir, 'package')
    mkdirSync(join(source, 'brand'), { recursive: true }); mkdirSync(join(source, 'assets'))
    writeFileSync(join(source, 'index.html'), '<img src="https://laubsauger.github.io/brawlock/brand/splash.webp"><script src="/assets/main.js"></script>')
    writeFileSync(join(source, 'sounds.html'), 'sound board')
    writeFileSync(join(source, 'admin.html'), 'private operations shell')
    writeFileSync(join(source, 'assets/main.js'), '// fixture')
    writeFileSync(join(source, 'assets/site.css'), 'body { color: white }')
    writeFileSync(join(source, 'brand/site.webmanifest'), JSON.stringify({ icons: [{ src: 'https://laubsauger.github.io/brawlock/brand/icon.png' }] }))
    writeFileSync(join(source, 'version.json'), JSON.stringify({ build: 'fixture-build', version: '0.1.0-alpha.1', releaseDate: '2026-10-19' }))
    const documents = ['about.html', 'privacy.html', 'terms.html', 'googlec523c567482e96c5.html']
    for (const name of documents) writeFileSync(join(source, name), readFileSync(resolve(name.startsWith('google') ? `public/${name}` : name)))
    const packaged = spawnSync(process.execPath, ['scripts/package-client.mjs', source, output], { encoding: 'utf8' })
    assert.equal(packaged.status, 0, packaged.stderr)
    for (const name of documents) {
      for (const target of ['web', 'pages']) assert.deepEqual(readFileSync(join(output, target, name)), readFileSync(join(source, name)))
    }
    assert.equal(readFileSync(join(output, 'web/googlec523c567482e96c5.html'), 'utf8'), 'google-site-verification: googlec523c567482e96c5.html')
    assert.equal(readFileSync(join(output, 'web/admin.html'), 'utf8'), 'private operations shell')
    assert.ok(readFileSync(join(output, 'pages/admin.html'), 'utf8').includes('https://brawlock.osc.link/admin.html'))
    assert.ok(readFileSync(join(output, 'pages/index.html'), 'utf8').includes('https://brawlock.osc.link/'))
    assert.ok(readdirSync(join(output, 'web/assets')).includes('site.css'))

    // Exercise web.sh's actual package validation without contacting any host.
    const bin = join(dir, 'bin'); mkdirSync(bin)
    for (const name of ['ssh', 'rsync']) writeFileSync(join(bin, name), '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 })
    const staged = spawnSync('bash', ['deploy/web.sh', output, 'fixture-build', '--stage-only'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    assert.equal(staged.status, 0, staged.stderr)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
