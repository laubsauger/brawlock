// Writes the daily verifier for this build (dist-daily/<dailyId>.mjs). The account service keeps
// the newest few in its daily folder and loads each in a worker: a release mid-day keeps
// verifying runs played on the previous build (docs/moonshot/specs/daily.md).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dailyBundle } from './daily-id.mjs'

const { id, code } = dailyBundle(process.cwd())
mkdirSync('dist-daily', { recursive: true })
writeFileSync(`dist-daily/${id}.mjs`, code)
console.log(`dist-daily/${id}.mjs`)
