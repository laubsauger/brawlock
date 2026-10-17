// Dedicated server prototype (M4, docs/M4.md): HTTP server whose WebSocket upgrades at
// /<ROOM CODE> join that room. Node glue only (plain JS: @types/node is not a project
// dependency yet); framing, transport and room logic are typed code in src/net.
import http from 'node:http'
import { createHash } from 'node:crypto'
import { FrameDecoder, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT, WS_GUID, decodeText, encodeFrame, encodeText } from '../src/net/wsframe.ts'
import { SocketTransport } from '../src/net/ws.ts'
import { createRoom } from '../src/net/dedicated.ts'
import { parseRoomCode } from '../src/net/code.ts'
import { startClock } from '../src/net/clock.ts'
import { DEFAULT_SETTINGS, createMatch, step } from '../src/sim/index.ts'
import { createBot } from '../src/bots/index.ts'

const MAX_MESSAGE_BYTES = 64 * 1024

/** A raw upgraded socket as a TextSocket (src/net/ws.ts). */
function wrapSocket(socket, log) {
  const decoder = new FrameDecoder(MAX_MESSAGE_BYTES)
  let textCb = null
  let closeCb = null
  const early = []
  let closed = false
  const finish = () => {
    if (closed) return
    closed = true
    closeCb?.()
  }
  socket.on('data', (chunk) => {
    let msgs
    try {
      msgs = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    } catch (e) {
      log(`ws protocol error: ${e.message}`)
      socket.destroy()
      return
    }
    for (const m of msgs) {
      if (m.opcode === OP_TEXT) {
        const t = decodeText(m.payload)
        if (textCb) textCb(t)
        else if (early.length < 256) early.push(t)
      } else if (m.opcode === OP_PING) socket.write(encodeFrame(OP_PONG, m.payload))
      else if (m.opcode === OP_CLOSE) {
        socket.end(encodeFrame(OP_CLOSE, m.payload.subarray(0, 2)))
        finish()
      }
    }
  })
  socket.on('close', finish)
  socket.on('error', finish)
  return {
    send(text) {
      if (!closed && socket.writable) socket.write(encodeText(text))
    },
    close() {
      if (closed) return
      socket.end(encodeFrame(OP_CLOSE, new Uint8Array([0x03, 0xe8])))
      finish()
    },
    onText(cb) {
      textCb = cb
      for (const t of early.splice(0)) cb(t)
    },
    onClose(cb) {
      closeCb = cb
    },
    bufferedAmount: () => socket.writableLength,
  }
}

/**
 * Start a server. Rooms are created on first join of their code and run `bots` and
 * `settings`. Returns the bound port and a close() that ends every room and socket.
 */
export async function startServer(opts = {}) {
  const { port = 5350, host = '127.0.0.1', bots = ['hard'], settings, autoStartMs, rematchMs, timeScale = 1, log = (m) => console.log(m) } = opts
  const deps = {
    createMatch,
    step,
    createBot,
    defaultSettings: DEFAULT_SETTINGS,
    // timeScale > 1 (tests): sim time runs faster than wall time; clients must use the same scale
    startClock: timeScale === 1 ? startClock : (onPulse) => startClock((t) => onPulse(t * timeScale)),
    now: () => performance.now() * timeScale,
    random: Math.random,
  }
  const rooms = new Map()
  const sockets = new Set()
  const roomFor = (code) => {
    let r = rooms.get(code)
    if (!r) {
      r = createRoom({ code, bots, settings, autoStartMs, rematchMs, log }, deps)
      rooms.set(code, r)
      log(`room ${code} opened`)
    }
    return r
  }
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`brawlock dedicated server prototype, ${rooms.size} room(s)\n`)
  })
  server.on('upgrade', async (req, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const parsed = parseRoomCode(decodeURIComponent((req.url ?? '/').replace(/^\//, '')))
    const key = req.headers['sec-websocket-key']
    if ('problem' in parsed || typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    const acceptKey = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`)
    socket.setNoDelay(true)
    const text = wrapSocket(socket, log)
    const room = await roomFor(parsed.code)
    room.accept(new SocketTransport(text))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return {
    port: server.address().port,
    async room(code) {
      return roomFor(code)
    },
    async close() {
      for (const r of rooms.values()) (await r).close()
      for (const s of sockets) s.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
