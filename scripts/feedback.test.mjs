import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { normalizeSnapshot, parseArgs, renderFeedback } from './feedback.mjs'

const id = 'fbac426c-a5f4-4318-93eb-1b8d86eec849'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII='
function report() {
  return { id, kind: 'bug', message: 'The ready button does not respond.', receivedAt: 1792454400000, accountId: null,
    context: { release: '0.1.0-alpha.5', build: 'fixture-123', netcode: 'dev-fixture', screen: 'lobby', panel: null, connection: { region: 'eu', room: 'ABCDE', transport: 'server', rttMs: 42, lossPct: 0 }, device: { width: 1920, height: 1080, dpr: 1 }, recentEvents: [], errors: [] },
    screenshot: { mime: 'image/png', data: png, width: 1, height: 1 } }
}

test('requires explicit live collection and validates bounded collection/cursor arguments', () => {
  assert.throws(() => parseArgs([]), /Usage/)
  assert.throws(() => parseArgs(['--collect', '--input', 'fixture.json']), /Usage/)
  for (const limit of ['0', '101', 'NaN', '1.5']) assert.throws(() => parseArgs(['--collect', '--limit', limit]), /limit/)
  assert.throws(() => parseArgs(['--collect', '--before', '1;whoami']), /cursor/)
  assert.throws(() => parseArgs(['--input', 'fixture.json', '--before', `1792454400000:${id}`]), /only to --collect/)
  const args = parseArgs(['--collect', '--limit', '50', '--before', `1792454400000:${id}`])
  assert.equal(args.limit, 50)
  assert.equal(args.before, `1792454400000:${id}`)
})

test('accepts documented local detail formats and rejects summary-only or duplicate reports', () => {
  for (const value of [report(), [report()], { reports: [report()], nextBefore: null }]) assert.equal(normalizeSnapshot(value).reports[0].id, id)
  assert.throws(() => normalizeSnapshot([{ id, kind: 'bug', message: 'Summary only', receivedAt: 1, accountId: null }]), /Invalid feedback detail/)
  assert.throws(() => normalizeSnapshot([report(), report()]), /Duplicate feedback IDs/)
  assert.throws(() => normalizeSnapshot({ reports: [report()], nextBefore: '<script>' }), /pagination cursor/)
})

test('escapes messages, contact, account, context and search attributes; embeds only PNG/JPEG base64 images', () => {
  const value = report()
  value.message = '</script><img src=x onerror=alert(1)> & "hello"'
  value.accountId = '"><svg onload=alert(2)>'
  value.contactEmail = '<iframe>email@example.test'
  value.context.errors = [{ message: '</pre><script>alert(3)</script>' }]
  const html = renderFeedback(normalizeSnapshot([value]))
  assert.match(html, /&lt;\/script&gt;&lt;img/)
  assert.match(html, /&lt;\/pre&gt;&lt;script&gt;alert\(3\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<img src=x|<svg onload|<iframe>|<script>alert/)
  assert.match(html, /src="data:image\/png;base64,iVBOR/)
  assert.match(html, /Content-Security-Policy/)
  for (const control of ['id="search"', 'id="kind"', 'value="bug"', 'value="feedback"', 'Captured context']) assert.ok(html.includes(control))
  for (const image of [{ ...value.screenshot, mime: 'image/svg+xml' }, { ...value.screenshot, data: '" onerror="bad' }]) assert.throws(() => normalizeSnapshot([{ ...report(), screenshot: image }]), /screenshot/)
})

test('writes private standalone files, tightens existing permissions and preserves the last export on invalid input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brawlock-feedback-'))
  try {
    const input = join(dir, 'input.json'), output = join(dir, 'out')
    mkdirSync(output, { mode: 0o755 })
    for (const name of ['index.html', 'report.json']) { writeFileSync(join(output, name), 'older', { mode: 0o644 }); chmodSync(join(output, name), 0o644) }
    writeFileSync(input, JSON.stringify([report()]))
    const run = () => spawnSync(process.execPath, [new URL('./feedback.mjs', import.meta.url).pathname, '--input', input, '--out', output], { encoding: 'utf8' })
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), join(output, 'index.html'))
    assert.equal(statSync(output).mode & 0o777, 0o700)
    for (const name of ['index.html', 'report.json']) assert.equal(statSync(join(output, name)).mode & 0o777, 0o600)
    const html = readFileSync(join(output, 'index.html'), 'utf8')
    const json = readFileSync(join(output, 'report.json'), 'utf8')
    assert.equal(JSON.parse(json).reports[0].id, id)
    writeFileSync(input, JSON.stringify({ reports: [{ ...report(), screenshot: { ...report().screenshot, mime: 'text/html' } }] }))
    assert.equal(run().status, 1)
    assert.equal(readFileSync(join(output, 'index.html'), 'utf8'), html)
    assert.equal(readFileSync(join(output, 'report.json'), 'utf8'), json)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
