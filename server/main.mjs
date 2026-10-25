// brawlock dedicated server entry (M4.1). Dev: `npm run server -- [options]`; production:
// `node server.mjs` from the bundle (npm run server:build), run by pm2 (deploy/).
// Options (flags override env):
//   --port / PORT (5350)            --host / HOST (127.0.0.1: behind nginx)
//   --max-rooms / MAX_ROOMS (200)   --origins / ALLOWED_ORIGINS (comma list; empty = any)
//   --region / REGION ('')          this server's region id (VITE_GAME_SERVERS), shown by /health
//   --data / DATA_DIR ('')          leaderboard.sqlite goes here ('' = no leaderboard)
//   --quick-seats / QUICKPLAY_SEATS (10)   humans per quick-play room, at most
//   --quick-fill / QUICKPLAY_BOT_FILL (10) bots top a quick-play table up to this many players
//   --quick-bots / QUICKPLAY_BOTS (hard)   default bot difficulty of quick play
//   --trust-proxy / TRUST_PROXY=1   (client IP from X-Forwarded-For, nginx on this host)
//   --demo CODE --bots hard,medium  a room that starts itself with these bots (local play)
//   --page URL                      the client page for the printed join link
import { startServer, jsonLog } from './listen.mjs'
import { INTERNET_ANCHORS } from './machine-monitor.mjs'
import { DEFAULT_SERVER_CONFIG } from '../src/net/server.ts'
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
const quickSeats = Math.max(2, Math.min(10, Number(arg('quick-seats', 'QUICKPLAY_SEATS', String(DEFAULT_SERVER_CONFIG.quickplay.seats))) || DEFAULT_SERVER_CONFIG.quickplay.seats))
const config = {
  maxRooms: Number(arg('max-rooms', 'MAX_ROOMS', '200')),
  region: String(arg('region', 'REGION', '')),
  quickplay: {
    ...DEFAULT_SERVER_CONFIG.quickplay,
    seats: quickSeats,
    fill: Math.max(0, Math.min(quickSeats, Number(arg('quick-fill', 'QUICKPLAY_BOT_FILL', String(DEFAULT_SERVER_CONFIG.quickplay.fill))) || 0)),
    bots: String(arg('quick-bots', 'QUICKPLAY_BOTS', DEFAULT_SERVER_CONFIG.quickplay.bots)),
  },
  // casual King of the Hill shares the quick-play table size and bots
  hill: {
    ...DEFAULT_SERVER_CONFIG.hill,
    seats: quickSeats,
    fill: Math.max(0, Math.min(quickSeats, Number(arg('quick-fill', 'QUICKPLAY_BOT_FILL', String(DEFAULT_SERVER_CONFIG.hill.fill))) || 0)),
    bots: String(arg('quick-bots', 'QUICKPLAY_BOTS', DEFAULT_SERVER_CONFIG.hill.bots)),
  },
  allowedOrigins: origins ? origins.split(',').map((s) => s.trim()).filter(Boolean) : null,
}
const trustProxy = ['1', 'true'].includes(String(arg('trust-proxy', 'TRUST_PROXY', '0')))
const dataDir = String(arg('data', 'DATA_DIR', ''))
if (process.env.NODE_ENV === 'production' && !process.env.ACCOUNTS_AUTHORITY_URL) throw new Error('Production ranked requires ACCOUNTS_AUTHORITY_URL')
if (process.env.NODE_ENV === 'production' && !process.env.MAINTENANCE_SECRET_FILE) throw new Error('Production requires MAINTENANCE_SECRET_FILE for regional updates')
// Production regions probe the internet path for the operations dashboard; dev and tests stay offline.
const anchors = process.env.NODE_ENV === 'production' ? INTERNET_ANCHORS : []
// pm2 only logs an unhandled rejection; exit so it restarts us instead of leaving a dead process.
const server = await startServer({ port, host, config, trustProxy, dataDir, anchors }).catch((error) => {
  jsonLog('error', 'server.start.failed', { error: String(error) })
  process.exit(1)
})

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
