// Daily verifiers (docs/moonshot/specs/daily.md): one bundle per client build in a folder
// (scripts/build-daily.mjs writes `<dailyId>.mjs`), the newest few accepted. Each job runs in a
// fresh worker thread with a time limit, one at a time, so a slow or hostile tape cannot stall the
// account service. Uploading a new bundle needs no restart.
import { Worker } from 'node:worker_threads'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
import(workerData.file)
  .then((m) => parentPort.postMessage({ ok: true, out: m.verify(workerData.input) }))
  .catch((e) => parentPort.postMessage({ ok: false, error: String(e && e.message || e) }))
`

export class VerifierBusy extends Error {}

/** `dir`: the bundles; `keep`: how many builds are accepted (newest first). */
export function createVerifierPool(dir, { keep = 5, timeoutMs = 2000, queueMax = 32 } = {}) {
  let queue = Promise.resolve()
  let waiting = 0
  const ids = () => {
    let files = []
    try {
      files = readdirSync(dir).filter((f) => /^[0-9a-f]{12}\.mjs$/.test(f))
    } catch { return [] }
    return files.map((f) => ({ id: f.slice(0, 12), at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, keep).map((x) => x.id)
  }
  const runOne = (id, input) => new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: { file: pathToFileURL(join(dir, `${id}.mjs`)).href, input }, resourceLimits: { maxOldGenerationSizeMb: 64 } })
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('The verifier took too long.')) }, timeoutMs)
    worker.once('message', (m) => {
      clearTimeout(timer)
      void worker.terminate()
      if (m.ok) resolve(m.out)
      else reject(new Error(m.error))
    })
    worker.once('error', (e) => { clearTimeout(timer); reject(e) })
  })
  return {
    ids,
    /** Verify with build `id`'s bundle; null when that build has no verifier here. Throws VerifierBusy when the queue is full. */
    run(id, input) {
      if (!ids().includes(id)) return Promise.resolve(null)
      if (waiting >= queueMax) return Promise.reject(new VerifierBusy('Verification is busy.'))
      waiting++
      const job = queue.then(() => runOne(id, input))
      queue = job.catch(() => {}).finally(() => { waiting-- })
      return job
    },
  }
}
