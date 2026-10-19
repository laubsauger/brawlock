/**
 * WebSocket transport for the dedicated server (M4 prototype, docs/M4.md).
 *
 * One TCP stream carries everything, so both paths are the reliable one: the
 * transport starts in 'reliable' mode (no raw channel to wait for) and the same
 * ping probes measure RTT. Client side: `wsNet(url)` dials `<url>/ws?room=<CODE>`
 * (online.ts decides when). Server side: server/ wraps each accepted socket in a
 * TextSocket and hands a SocketTransport to the room (server.ts, dedicated.ts).
 */
import { BaseTransport, type HostEndpoint, type NetFactory, type Transport } from './transport'
import type { VerifiedAccount } from './accounts'

/** A message-oriented text socket: what both ends of the link need. */
export interface TextSocket {
  send(text: string): void
  close(): void
  onText(cb: (text: string) => void): void
  onClose(cb: () => void): void
  /** bytes queued for sending (TCP backlog), when known */
  bufferedAmount?(): number
  /** Trusted regional revocation is moving this controller, rather than an ordinary disconnect. */
  transferring?(): boolean
}

/** grace period for queued frames (leave, kick) before a local close */
const FLUSH_MS = 150
/**
 * TCP backlog beyond which "unreliable" frames (snapshots, input repeats) are dropped
 * like UDP would: a queued snapshot is stale by the time it arrives, the next one heals.
 */
const CONGESTED_BYTES = 256 * 1024
const CONNECT_TIMEOUT_MS = 8000

export class SocketTransport extends BaseTransport {
  transferring = false
  prepareHandoff(): void { this.transferring = true }
  constructor(private readonly socket: TextSocket, readonly account?: VerifiedAccount | null) {
    super()
    // TCP: there is no unordered channel to probe for
    this.unreliableMode = 'reliable'
    socket.onText((t) => this.receive(t, false))
    socket.onClose(() => this.remoteClosed('closed'))
    this.start()
  }

  sendUnreliable(data: string): void {
    if ((this.socket.bufferedAmount?.() ?? 0) > CONGESTED_BYTES) return
    super.sendUnreliable(data)
  }

  protected rawReliable(data: string): void {
    this.socket.send(data)
  }

  protected rawUnreliable(): boolean {
    return false
  }

  protected shutdown(): void {
    setTimeout(() => this.socket.close(), FLUSH_MS)
  }
}

/** Minimal shape of the WebSocket API (browser and Node 22+ global). */
interface WebSocketLike {
  readonly readyState: number
  readonly bufferedAmount: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(): void
}
type WebSocketCtor = new (url: string) => WebSocketLike

/** The browser / Node WebSocket as a TextSocket. */
export function webSocketText(ws: WebSocketLike): TextSocket {
  let closeCb: (() => void) | null = null
  let closed = false
  const fire = () => {
    if (closed) return
    closed = true
    closeCb?.()
  }
  return {
    send: (t) => {
      if (ws.readyState === 1) ws.send(t)
    },
    close: () => ws.close(),
    bufferedAmount: () => ws.bufferedAmount,
    onText: (cb) => {
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') cb(e.data)
      }
    },
    onClose: (cb) => {
      closeCb = cb
      ws.onclose = fire
      ws.onerror = fire
    },
  }
}

/** `ws://host:port` without a trailing slash, or null when the value is not a ws(s) URL. */
export function serverUrlFrom(search: string): string | null {
  const v = new URLSearchParams(search).get('server')
  if (!v) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/**
 * NetFactory for a dedicated server: join(code) opens `<serverUrl>/<code>`. Hosting
 * is the server's job, so host() rejects with a friendly message.
 */
export function wsNet(serverUrl: string, Ctor: WebSocketCtor = (globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket, authorize?: () => Promise<string | null>, onConflict?: (value: unknown) => void, playToken?: () => string): NetFactory {
  return {
    host(): Promise<HostEndpoint> {
      return Promise.reject(new Error('Connected to a dedicated server: rooms are hosted there. Open the page without ?server= to host yourself.'))
    },
    join(code: string): Promise<Transport> {
      return new Promise((resolve, reject) => {
        let ws: WebSocketLike
        try {
          ws = new Ctor(`${serverUrl}/ws?room=${encodeURIComponent(code)}`)
        } catch {
          reject(new Error('Could not reach the server.'))
          return
        }
        const timer = setTimeout(() => {
          ws.close()
          reject(new Error('The server did not answer.'))
        }, CONNECT_TIMEOUT_MS)
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error('Could not reach the server.'))
        }
        ws.onclose = () => {
          clearTimeout(timer)
          reject(new Error('The server connection closed before joining completed.'))
        }
        ws.onopen = async () => {
          if (!authorize) {
            clearTimeout(timer)
            resolve(new SocketTransport(webSocketText(ws)))
            return
          }
          try {
            const token = await authorize()
            if (ws.readyState !== 1) throw new Error('The server connection closed before sign-in completed.')
            ws.onmessage = (event) => {
              try {
                const reply = typeof event.data === 'string' ? JSON.parse(event.data) : null
                clearTimeout(timer)
                if (reply?.rankedConflict) onConflict?.(reply.rankedConflict)
                if (reply?.t !== 'account-ready') throw new Error(typeof reply?.message === 'string' ? reply.message : 'The server could not verify your account.')
                resolve(new SocketTransport(webSocketText(ws)))
              } catch (error) { ws.close(); reject(error) }
            }
            ws.send(JSON.stringify({ t: 'account', token, ...(playToken ? { playToken: playToken() } : {}) }))
          } catch (error) { clearTimeout(timer); ws.close(); reject(error) }
        }
      })
    },
  }
}
