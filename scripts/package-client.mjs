// Split a verified root-path client build into first-party app + Pages media.
// Does not upload, deploy, modify credentials, or replace an existing output.
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { releaseMetadata } from './release-version.mjs'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: node scripts/package-client.mjs BUILD_DIR NEW_OUTPUT_DIR')
const source = resolve(input)
const destination = resolve(output)
if (destination === source || destination.startsWith(source + sep)) throw new Error('Package output must be outside the input build directory')
if (existsSync(destination)) throw new Error('Output already exists; use a new package directory')
const html = readFileSync(join(source, 'index.html'), 'utf8')
const version = JSON.parse(readFileSync(join(source, 'version.json'), 'utf8'))
const release = releaseMetadata(version)
const mediaOrigin = 'https://laubsauger.github.io/brawlock/'
if (!html.includes(`${mediaOrigin}brand/splash.webp`) || !/<script[^>]+src="\/assets\//.test(html)) {
  throw new Error('Expected a root-path build with public media on the Brawlock Pages origin')
}
const manifest = JSON.parse(readFileSync(join(source, 'brand/site.webmanifest'), 'utf8'))
if (!manifest.icons.every((icon) => icon.src.startsWith(`${mediaOrigin}brand/`))) {
  throw new Error('Install manifest icons must use the Pages origin')
}
mkdirSync(destination, { recursive: true })
const web = join(destination, 'web')
mkdirSync(web)
for (const path of ['index.html', 'sounds.html', 'about.html', 'privacy.html', 'terms.html', 'googlec523c567482e96c5.html', 'version.json', 'assets', 'brand/site.webmanifest']) {
  cpSync(join(source, path), join(web, path), { recursive: true })
}
const pages = join(destination, 'pages')
cpSync(source, pages, { recursive: true })
const redirect = (path) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Brawlock has moved</title><script>location.replace(${JSON.stringify(`https://brawlock.osc.link${path}`)}+location.search+location.hash)</script><a href="https://brawlock.osc.link${path}">Open Brawlock</a></html>\n`
writeFileSync(join(pages, 'index.html'), redirect('/'))
writeFileSync(join(pages, 'sounds.html'), redirect('/sounds.html'))
writeFileSync(join(destination, 'hosting.json'), JSON.stringify({
  build: version.build, ...release,
  appOrigin: 'https://brawlock.osc.link', mediaOrigin,
  web: 'web', pages: 'pages',
}) + '\n')
console.log('Prepared web/ (small app) and pages/ (public media and legacy entry redirects). No deployment performed.')
