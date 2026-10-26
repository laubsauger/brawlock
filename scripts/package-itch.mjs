// Prepare the itch.io HTML5 upload from a relative-base client build with bundled media (docs/ITCH.md).
// Checks itch's limits (itch.io/docs/creators/html5). Does not upload.
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: node scripts/package-itch.mjs BUILD_DIR NEW_OUTPUT_DIR')
const source = resolve(input)
const destination = resolve(output)
if (destination === source || destination.startsWith(source + sep)) throw new Error('Package output must be outside the input build directory')
if (existsSync(destination)) throw new Error('Output already exists; use a new package directory')
// itch serves the game from its own host under /html/<id>/: a root path or hosted media would break there
const html = readFileSync(join(source, 'index.html'), 'utf8')
if (/(?:src|href)="\/(?!\/)/.test(html) || !html.includes('href="./brand/splash.webp"')) {
  throw new Error('Expected a relative-base build with bundled media (--base=./, no VITE_ASSET_BASE_URL)')
}
const version = JSON.parse(readFileSync(join(source, 'version.json'), 'utf8'))
// first-party only: operations shell, dev sound board, search-console ownership file
const skip = new Set(['admin.html', 'sounds.html', 'googlec523c567482e96c5.html', '.DS_Store'])
cpSync(source, destination, { recursive: true, filter: (path) => !skip.has(basename(path)) })

const files = []
const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) (entry.isDirectory() ? walk : (p) => files.push(p))(join(dir, entry.name)) }
walk(destination)
const MB = 1024 * 1024
const sizes = files.map((path) => statSync(path).size)
const total = sizes.reduce((a, b) => a + b, 0)
const problems = []
if (files.length > 1000) problems.push(`${files.length} files (itch allows 1000)`)
if (total > 500 * MB) problems.push(`${(total / MB).toFixed(0)} MB in total (itch allows 500 MB)`)
files.forEach((path, i) => {
  const name = relative(destination, path)
  if (sizes[i] > 200 * MB) problems.push(`${name} is ${(sizes[i] / MB).toFixed(0)} MB (itch allows 200 MB per file)`)
  if (name.length > 240) problems.push(`${name} has a path longer than 240 characters`)
})
if (problems.length) throw new Error(`The build does not fit itch.io's HTML5 limits:\n${problems.join('\n')}`)
console.log(`Prepared ${version.version} (${version.build}) for itch.io: ${files.length} files, ${(total / MB).toFixed(1)} MB. No upload performed.`)
