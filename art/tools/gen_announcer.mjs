// Announcer pack via ElevenLabs text-to-speech (approach from martian-kombat/tools/gen-audio.mjs).
//
//   node art/tools/gen_announcer.mjs --voices                       list stock voices (name, id, labels)
//   node art/tools/gen_announcer.mjs --voice <id> --name <slug> [--takes 2]
//
// The API key comes from $ELEVENLABS_API_KEY, else from the .env file at $ELEVENLABS_ENV_FILE
// (default: ../martian-kombat/.env). It is only ever sent as the request header: never printed,
// logged or written anywhere. Raw takes land in art/archive/audio/announcer/<slug>/ with a
// .prompt.txt sidecar each. Existing takes are skipped (no re-rolls, no retries): every run costs
// at most lines x takes requests, and a failed request stops the run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'art/archive/audio/announcer')
const MODEL = 'eleven_multilingual_v2'

export const LINES = [
  ['first_blood', 'First Blood!'],
  ['double_kill', 'Double Kill!'],
  ['triple_kill', 'Triple Kill!'],
  ['multi_kill', 'Multi Kill!'],
  ['mega_kill', 'Mega Kill!'],
  ['ultra_kill', 'Ultra Kill!'],
  ['monster_kill', 'Monster Kill!'],
  ['killing_spree', 'Killing Spree!'],
  ['rampage', 'Rampage!'],
  ['unstoppable', 'Unstoppable!'],
  ['godlike', 'Godlike!'],
]

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  const file = process.env.ELEVENLABS_ENV_FILE ?? resolve(ROOT, '../martian-kombat/.env')
  if (!existsSync(file)) throw new Error('no ELEVENLABS_API_KEY in the environment and no env file')
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.*)\s*$/)
    if (m) return m[1].replace(/^['"]|['"]$/g, '')
  }
  throw new Error('ELEVENLABS_API_KEY not found in the env file')
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

async function listVoices(key) {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } })
  if (!res.ok) throw new Error(`voices ${res.status}`)
  const { voices } = await res.json()
  for (const v of voices) {
    const l = v.labels ?? {}
    console.log([v.name, v.voice_id, v.category, l.gender, l.age, l.accent, l.description, l.use_case, l.descriptive].filter(Boolean).join(' | '))
  }
}

async function tts(key, voiceId, text, style, stability) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability, similarity_boost: 0.75, style } }),
  })
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return Buffer.from(await res.arrayBuffer())
}

async function main() {
  const key = apiKey()
  if (process.argv.includes('--voices')) return listVoices(key)
  const voice = arg('--voice')
  const slug = arg('--name')
  const takes = Number(arg('--takes', '1'))
  const style = Number(arg('--style', '0.7'))
  const stability = Number(arg('--stability', '0.4'))
  if (!voice || !slug) throw new Error('need --voice <id> --name <slug>')
  const dir = join(OUT, slug)
  mkdirSync(dir, { recursive: true })
  let made = 0
  for (const [id, text] of LINES) {
    for (let t = 1; t <= takes; t++) {
      const file = join(dir, `${id}_take${t}.mp3`)
      if (existsSync(file)) continue
      const audio = await tts(key, voice, text, style, stability)
      writeFileSync(file, audio)
      writeFileSync(
        file.replace(/\.mp3$/, '.prompt.txt'),
        `text: ${text}\nvoice: ${slug} (${voice})\nmodel: ${MODEL}\nvoice_settings: stability ${stability}, similarity_boost 0.75, style ${style}\ntake: ${t}\ngenerated: ${new Date().toISOString()}\nsource: ElevenLabs text-to-speech\n`,
      )
      made++
      console.log(`${slug}/${id}_take${t}.mp3`)
    }
  }
  console.log(`${made} requests made`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
