// The capacity server for builds that have server/shards.mjs (build.mjs picks it): config.shards
// room processes behind one front. Otherwise identical to server.mjs.
import { readFileSync } from 'node:fs'
import { shardIndex, startSharded } from '../../server/shards.mjs'
import { DEFAULT_SERVER_CONFIG } from '../../src/net/server.ts'
import { resolve, sep } from 'node:path'

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (!config.run || !Number.isInteger(config.port) || ![ '/var/lib/brawlock/capacity/', resolve('artifacts/capacity') + sep ].some(root => config.data.startsWith(root))) throw new Error('Invalid isolated capacity server configuration')
for (const key of ['ACCOUNTS_AUTHORITY_URL', 'RATING_AUTHORITY_URL', 'RATING_AUTHORITY_TOKEN', 'DATA_DIR', 'TURN_SECRET_FILE']) {
  if (process.env[key]) throw new Error(`Refusing inherited production setting: ${key}`)
}
// shards > 1: a front on config.port and one room process per shard (server/shards.mjs)
const server = await startSharded({ host: '127.0.0.1', port: config.port, dataDir: config.data,
  ratingAuthorityUrl: '', accountsAuthorityUrl: '', ratingAuthorityToken: config.token,
  streamEvery: config.streamEvery ?? 1, tickHz: config.tickHz ?? 30,
  config: { ...DEFAULT_SERVER_CONFIG, region: `capacity-${config.run}`, maxRooms: 48, emptyRoomMs: 10_000,
    // All isolated clients share one SSH-loopback IP. These are not public admission benchmarks.
    maxConnsPerIp: 400, connectsPerMin: 1500, roomCreatesPerMin: 120, lookupsPerMin: 6000 },
}, config.shards ?? 1)
let closing = false
const stop = async () => { if (closing) return; closing = true; await server.close(); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
setTimeout(stop, 14 * 60_000).unref()
if (shardIndex === null) console.log(JSON.stringify({ event: 'capacity.ready', run: config.run, port: server.port, shards: config.shards ?? 1 }))
