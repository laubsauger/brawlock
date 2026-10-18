// brawlock dedicated server entry (M4.1). Dev: `npm run server -- [options]`; production:
// `node server.mjs` from the bundle (npm run server:build), run by pm2 (deploy/).
// Options (flags override env):
//   --port / PORT (5350)            --host / HOST (127.0.0.1: behind nginx)
//   --max-rooms / MAX_ROOMS (200)   --origins / ALLOWED_ORIGINS (comma list; empty = any)
//   --region / REGION ('')          this server's region id (VITE_GAME_SERVERS), shown by /health
//   --trust-proxy / TRUST_PROXY=1   (client IP from X-Forwarded-For, nginx on this host)
//   --demo CODE --bots hard,medium  a room that starts itself with these bots (local play)
//   --page URL                      the client page for the printed join link
import { startServer, jsonLog } from './listen.mjs'
import { parseRoomCode } from '../src/net/code.ts'

const args = process.argv.slice(2)
const arg = (name, env, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i >= 0) return i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : 'true'
  return process.env[env] ?? fallback
}
const port = Number(arg('port', 'PORT', '5350'))
const host = arg('host', 'HOST', '127.0.0.1')
const origins = arg('origins', 'ALLOWED_ORIGINS', '')
const config = {
  maxRooms: Number(arg('max-rooms', 'MAX_ROOMS', '200')),
  region: String(arg('region', 'REGION', '')),
  allowedOrigins: origins ? origins.split(',').map((s) => s.trim()).filter(Boolean) : null,
}
const trustProxy = ['1', 'true'].includes(String(arg('trust-proxy', 'TRUST_PROXY', '0')))
const server = await startServer({ port, host, config, trustProxy })

const demo = arg('demo', 'DEMO_ROOM', '')
if (demo) {
  const parsed = parseRoomCode(demo)
  if ('problem' in parsed) {
    jsonLog('error', 'demo.code', { problem: parsed.problem })
    process.exit(1)
  }
  const bots = String(arg('bots', 'DEMO_BOTS', 'hard')).split(',').filter(Boolean)
  await server.createRoom({ code: parsed.code, auto: true, bots })
  const ws = `ws://${host === '0.0.0.0' ? 'localhost' : host}:${server.port}`
  const page = arg('page', 'PAGE', 'http://localhost:5173/')
  console.log(`play: ${page}?server=${encodeURIComponent(ws)}&room=${parsed.code}`)
}

let stopping = false
const stop = async (signal) => {
  if (stopping) return
  stopping = true
  jsonLog('info', 'server.stop', { signal })
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
