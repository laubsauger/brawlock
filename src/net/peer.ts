/**
 * PeerJS NetFactory. PeerJS only brokers the WebRTC connection (public 0.peerjs.com
 * signaling, default ICE servers incl. PeerJS TURN) and carries the reliable
 * channel; gameplay rides a raw pre-negotiated unreliable RTCDataChannel on the
 * same RTCPeerConnection. (PeerJS `reliable: false` only sets ordered:false and
 * still retransmits, so it is not used.)
 *
 * Rooms: the host registers the deterministic PeerJS id `brawlock-<CODE>` for a
 * random 5-letter room code (code.ts) and retries with a new code if the broker
 * reports the id taken. Clients dial the id derived from the code.
 *
 * Lessons carried over from wave-rider's p2p.ts:
 * - B21: a dropped client must never destroy the host's peer; the room code stays valid.
 * - B40: app-switching (sharing the link from a phone) kills the signaling socket
 *   and the broker forgets the id. Re-register the same id on 'disconnected' and
 *   when the tab becomes visible again.
 * - Joins retry: the host may be app-switched right now. 'peer-unavailable' →
 *   retry after a pause; an offer relayed into a dead socket never errors →
 *   per-attempt timeout re-dials.
 *
 * peerjs is imported lazily so offline play and tests never load it.
 */
import type { DataConnection, Peer as PeerType } from 'peerjs'
import { newRoomCode, peerIdForCode, roomLink } from './code'
import { BaseTransport, type HostEndpoint, type NetFactory, type Transport } from './transport'

type PeerCtor = typeof import('peerjs').Peer

let peerCtor: Promise<PeerCtor> | null = null
function loadPeer(): Promise<PeerCtor> {
  peerCtor ??= import('peerjs').then((m) => m.Peer)
  return peerCtor
}

/** SCTP stream id of the raw gameplay channel. Must match on both sides; < 1024 for every browser. */
const RAW_CHANNEL_ID = 1000
/** drop unreliable frames instead of queueing them behind congestion */
const RAW_MAX_BUFFERED = 64 * 1024
const BROKER_TIMEOUT_MS = 15000
const JOIN_ATTEMPT_MS = 7000
const JOIN_RETRY_PAUSE_MS = 3000
const JOIN_MAX_ATTEMPTS = 8
/** fresh codes tried when the broker says a code's id is taken */
const HOST_CODE_ATTEMPTS = 5
/** grace period for queued reliable frames (leave, kick) before a local close */
const FLUSH_MS = 150

const textDecoder = new TextDecoder()
function asText(d: unknown): string {
  if (typeof d === 'string') return d
  if (d instanceof ArrayBuffer) return textDecoder.decode(d)
  if (ArrayBuffer.isView(d)) return textDecoder.decode(d)
  return String(d)
}

class PeerTransport extends BaseTransport {
  private raw: RTCDataChannel | null = null
  private readonly conn: DataConnection
  private readonly onShutdown: (() => void) | null

  constructor(conn: DataConnection, onShutdown: (() => void) | null = null) {
    super()
    this.conn = conn
    this.onShutdown = onShutdown
    conn.on('data', (d) => this.receive(asText(d), false))
    conn.on('close', () => this.remoteClosed('closed'))
    conn.on('error', (e) => console.warn('[net] connection error', e.type, e.message))
    this.openRaw()
    this.start()
  }

  private openRaw(): void {
    try {
      const dc = this.conn.peerConnection.createDataChannel('rt', {
        negotiated: true,
        id: RAW_CHANNEL_ID,
        ordered: false,
        maxRetransmits: 0,
      })
      dc.binaryType = 'arraybuffer'
      dc.onmessage = (e) => this.receive(asText(e.data), true)
      dc.onclose = () => {
        if (this.raw === dc) this.raw = null
        this.rawLost()
      }
      this.raw = dc
    } catch (e) {
      // stays 'pending' and falls back to the reliable channel after RAW_TIMEOUT_MS
      console.warn('[net] raw unreliable channel failed, using the reliable channel', e)
    }
  }

  protected rawReliable(data: string): void {
    if (this.conn.open) void this.conn.send(data)
  }

  protected rawUnreliable(data: string): boolean {
    const dc = this.raw
    if (!dc || dc.readyState !== 'open') return false
    if (dc.bufferedAmount > RAW_MAX_BUFFERED) return true // congested: drop, like UDP
    try {
      dc.send(data)
    } catch {
      return false
    }
    return true
  }

  protected shutdown(): void {
    const { conn, raw, onShutdown } = this
    this.raw = null
    setTimeout(() => {
      raw?.close()
      conn.close()
      onShutdown?.()
    }, FLUSH_MS)
  }
}

/** B40: keep the broker registration alive across app switches. */
function armReconnect(peer: PeerType): void {
  peer.on('disconnected', () => {
    if (!peer.destroyed) peer.reconnect()
  })
  if (typeof document === 'undefined') return
  const onVisible = () => {
    if (peer.destroyed) {
      document.removeEventListener('visibilitychange', onVisible)
      return
    }
    if (document.visibilityState === 'visible' && peer.disconnected) peer.reconnect()
  }
  document.addEventListener('visibilitychange', onVisible)
}

const BROKER_DOWN = 'Could not reach the connection broker. Check your internet connection and try again.'

/** the code's PeerJS id is already registered (another live room): pick another code */
class CodeTaken extends Error {}

/** Register `brawlock-<code>` at the broker. Resolves once the id is ours. */
function registerHost(Peer: PeerCtor, code: string): Promise<HostEndpoint> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(peerIdForCode(code))
    let opened = false
    let listener: ((t: Transport) => void) | null = null
    const backlog: Transport[] = []
    const timeout = setTimeout(() => {
      if (opened) return
      peer.destroy()
      reject(new Error(BROKER_DOWN))
    }, BROKER_TIMEOUT_MS)
    armReconnect(peer)
    peer.on('open', () => {
      if (opened) return // reconnect() re-fires open with the same id
      opened = true
      clearTimeout(timeout)
      resolve({
        id: code,
        onConnection(cb) {
          listener = cb
          for (const t of backlog.splice(0)) cb(t)
        },
        close() {
          setTimeout(() => peer.destroy(), FLUSH_MS + 50)
        },
      })
    })
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        const t = new PeerTransport(conn)
        if (listener) listener(t)
        else backlog.push(t)
      })
    })
    peer.on('error', (err) => {
      if (!opened) {
        clearTimeout(timeout)
        peer.destroy()
        if (err.type === 'unavailable-id') reject(new CodeTaken(code))
        else reject(new Error(err.type === 'browser-incompatible' ? 'This browser does not support WebRTC.' : BROKER_DOWN))
        return
      }
      // B21: never destroy the host peer on errors after open; clients may still (re)join
      console.warn('[net] host peer error', err.type, err.message)
    })
  })
}

export const peerNet: NetFactory = {
  /** Endpoint id = the room code clients type or open via ?room=. */
  async host(): Promise<HostEndpoint> {
    const Peer = await loadPeer()
    for (let attempt = 1; ; attempt++) {
      try {
        return await registerHost(Peer, newRoomCode())
      } catch (e) {
        if (!(e instanceof CodeTaken) || attempt >= HOST_CODE_ATTEMPTS) {
          throw e instanceof CodeTaken ? new Error('Could not reserve a room code. Try again.') : e
        }
      }
    }
  },

  /** `code` must already be normalized (parseRoomCode). */
  async join(code: string, onStatus?: (msg: string) => void): Promise<Transport> {
    const Peer = await loadPeer()
    const hostPeerId = peerIdForCode(code)
    return new Promise((resolve, reject) => {
      const peer = new Peer()
      let conn: DataConnection | null = null
      let attempts = 0
      let timer: ReturnType<typeof setTimeout> | null = null
      let done = false

      const finish = (err: string | null, t?: Transport) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        if (err) {
          conn?.close()
          peer.destroy()
          reject(new Error(err))
        } else {
          resolve(t!)
        }
      }
      const retry = (why: string) => {
        if (done) return
        if (attempts >= JOIN_MAX_ATTEMPTS) {
          finish('No room with that code. It may have closed (codes change every time the host opens a lobby). Ask the host for the current code.')
          return
        }
        attempts++
        onStatus?.(`${why} Retrying (${attempts}/${JOIN_MAX_ATTEMPTS})…`)
        if (timer) clearTimeout(timer)
        timer = setTimeout(tryConnect, JOIN_RETRY_PAUSE_MS)
      }
      const tryConnect = () => {
        if (done || peer.destroyed) return
        conn?.close()
        const c = peer.connect(hostPeerId, { reliable: true, serialization: 'raw' })
        conn = c
        c.on('open', () => {
          if (c !== conn || done) return
          finish(null, new PeerTransport(c, () => peer.destroy()))
        })
        c.on('error', (e) => {
          if (c !== conn || done) return
          if (e.type === 'negotiation-failed') {
            finish(
              'Could not open a direct connection to the host (strict NAT or firewall). Try another network, or let the other player host.',
            )
          }
        })
        if (timer) clearTimeout(timer)
        // an offer relayed into a dead socket never errors: re-dial
        timer = setTimeout(() => retry('Host not reachable (maybe app-switched).'), JOIN_ATTEMPT_MS)
      }

      armReconnect(peer)
      onStatus?.('Connecting to host…')
      peer.on('open', () => {
        if (!conn) tryConnect()
      })
      peer.on('error', (err) => {
        if (done) {
          console.warn('[net] client peer error', err.type, err.message)
          return
        }
        if (err.type === 'peer-unavailable') {
          retry('Host not reachable (maybe app-switched).')
          return
        }
        if (err.type === 'browser-incompatible') finish('This browser does not support WebRTC.')
        else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed')
          finish(BROKER_DOWN)
        else finish(`Connection failed: ${err.message || err.type}`)
      })
    })
  },
}

/** Shareable invite link for a room code: the app URL with ?room=CODE. */
export function joinUrlFor(code: string): string {
  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost'
  return roomLink(`${origin}${import.meta.env.BASE_URL}`, code)
}
