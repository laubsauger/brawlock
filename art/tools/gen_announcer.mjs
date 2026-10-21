// Announcer pack via ElevenLabs text-to-speech (approach from martian-kombat/tools/gen-audio.mjs).
//
//   node art/tools/gen_announcer.mjs --voices                       list stock voices (name, id, labels)
//   node art/tools/gen_announcer.mjs --voice <id> --name <slug> [--pack 2] [--takes 1] [--key-takes 2]
//
// --pack picks one pack's lines (default: every line); --only <id> one line (a probe request);
// --key-takes gives the pack's key lines (marked `key` below) more takes than the rest.
//
// Custom narration: --text "Your line." --only line_id --out media/trailer/teaser30/voice/raw
// The API key comes from $ELEVENLABS_API_KEY (or ELEVEN_LABS_API_KEY), else from the .env file
// at $ELEVENLABS_ENV_FILE (default: this project's .env). It is only sent as a request header,
// never printed,
// logged or written anywhere. Raw takes land in art/archive/audio/announcer/<slug>/ with a
// .prompt.txt sidecar each. Existing takes are skipped (no re-rolls, no retries): every run costs
// at most lines x takes requests, and a failed request stops the run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'art/archive/audio/announcer')
const MODEL = 'eleven_multilingual_v2'

// [id, text, pack, key]
export const LINES = [
  ['first_blood', 'First Blood!', 1],
  ['double_kill', 'Double Kill!', 1],
  ['triple_kill', 'Triple Kill!', 1],
  ['multi_kill', 'Multi Kill!', 1],
  ['mega_kill', 'Mega Kill!', 1],
  ['ultra_kill', 'Ultra Kill!', 1],
  ['monster_kill', 'Monster Kill!', 1],
  ['killing_spree', 'Killing Spree!', 1],
  ['rampage', 'Rampage!', 1],
  ['unstoppable', 'Unstoppable!', 1],
  ['godlike', 'Godlike!', 1],
  // pack 2: round flow, round and match end, the arena, occasional calls
  ...['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'].map((n) => [`round_${n.toLowerCase()}`, `Round ${n}!`, 2]),
  ['fight', 'Fight!', 2, true],
  ['final_round', 'Final Round!', 2, true],
  ['match_point', 'Match Point!', 2],
  ['round_won', 'Round Won!', 2],
  ['draw', 'Draw!', 2],
  ['victory', 'Victory!', 2, true],
  ['defeat', 'Defeat!', 2, true],
  ['arena_shrinks', 'The Arena Shrinks!', 2],
  ['shutdown', 'Shutdown!', 2, true],
  ['revenge', 'Revenge!', 2],
  ['denied', 'Denied!', 2],
  ['close_call', 'Close Call!', 2],
  ['last_standing', 'Last Warlock Standing!', 2],
  ['ace', 'Ace!', 2],
  // pack 3: the last few tiles
  ['hurry_up', 'Hurry Up!', 3],
  // pack 4: round-win variety (round_won stays one of them; "Victory!" is the match's alone)
  ['round_taken', 'Round Taken!', 4],
  ['arena_is_yours', 'The Arena Is Yours!', 4],
  ['too_hot', 'Too Hot to Handle!', 4],
  ['still_standing', 'Still Standing!', 4],
  ['survivor', 'Survivor!', 4],
]

function apiKey() {
  const configured = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_API_KEY
  if (configured) return configured
  const file = process.env.ELEVENLABS_ENV_FILE ?? join(ROOT, '.env')
  if (!existsSync(file)) throw new Error('no ELEVENLABS_API_KEY in the environment and no env file')
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*ELEVEN_?LABS_API_KEY\s*=\s*(.*)\s*$/)
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
  const keyTakes = Number(arg('--key-takes', String(takes)))
  const pack = arg('--pack')
  const only = arg('--only')
  const style = Number(arg('--style', '0.7'))
  const stability = Number(arg('--stability', '0.4'))
  if (!voice || !slug) throw new Error('need --voice <id> --name <slug>')
  const customText = arg('--text')
  if (customText && !only) throw new Error('--text requires --only <line_id>')
  const dir = resolve(arg('--out', join(OUT, slug)))
  mkdirSync(dir, { recursive: true })
  let made = 0
  const lines = customText ? [[only, customText, 0]] : LINES
  for (const [id, text, linePack, isKeyLine] of lines) {
    if (pack && String(linePack) !== pack) continue
    if (only && id !== only) continue
    for (let t = 1; t <= (isKeyLine ? keyTakes : takes); t++) {
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
