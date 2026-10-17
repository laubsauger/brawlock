// npm run server [-- --port 5350 --bots hard,medium --room ABCDE --host 127.0.0.1]
// Starts the local dedicated server prototype and prints the link that joins its room.
import { startServer } from './listen.mjs'
import { newRoomCode, parseRoomCode } from '../src/net/code.ts'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const port = Number(arg('port', '5350'))
const host = arg('host', '127.0.0.1')
const bots = arg('bots', 'hard').split(',').filter(Boolean)
const parsed = parseRoomCode(arg('room', newRoomCode()))
if ('problem' in parsed) {
  console.error(parsed.problem)
  process.exit(1)
}
const page = arg('page', 'http://localhost:5173/')
const server = await startServer({ port, host, bots })
await server.room(parsed.code)
const ws = `ws://${host === '0.0.0.0' ? 'localhost' : host}:${server.port}`
console.log(`brawlock dedicated server on ${ws} (bots: ${bots.join(', ') || 'none'})`)
console.log(`play: ${page}?server=${encodeURIComponent(ws)}&room=${parsed.code}`)
const stop = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
