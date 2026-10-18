import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (value?: unknown) => void
interface FakeConnection {
  open: boolean
  emit(event: string, value?: unknown): void
  close: ReturnType<typeof vi.fn>
  peerConnection: { createDataChannel: ReturnType<typeof vi.fn> }
}
interface FakePeer {
  args: unknown[]
  connections: FakeConnection[]
  destroyed: boolean
  emit(event: string, value?: unknown): void
  destroy: ReturnType<typeof vi.fn>
  reconnect: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
}
const probe = vi.hoisted(() => ({ peers: [] as FakePeer[] }))
vi.mock('peerjs', () => {
  class Emitter {
    private listeners = new Map<string, Listener[]>()
    on(event: string, listener: Listener) {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
      return this
    }
    emit(event: string, value?: unknown) {
      for (const listener of this.listeners.get(event) ?? []) listener(value)
    }
  }
  class Connection extends Emitter {
    open = true
    send = vi.fn()
    close = vi.fn(() => { this.open = false })
    peerConnection = { createDataChannel: vi.fn(() => ({ readyState: 'connecting', bufferedAmount: 0, close: vi.fn(), send: vi.fn() })) }
  }
  class Peer extends Emitter {
    destroyed = false
    disconnected = false
    connections: Connection[] = []
    destroy = vi.fn(() => { this.destroyed = true })
    reconnect = vi.fn()
    connect = vi.fn((_id: string, _options: unknown) => {
      const connection = new Connection()
      this.connections.push(connection)
      return connection
    })
    args: unknown[]
    constructor(...args: unknown[]) {
      super()
      this.args = args
      probe.peers.push(this)
    }
  }
  return { Peer }
})

import { createPeerNet, peerNet } from './peer'

const relayConfig = (): RTCConfiguration => ({
  iceServers: [
    { urls: 'stun:relay.brawlock.test:3478' },
    { urls: ['turn:relay.brawlock.test:3478?transport=udp', 'turns:relay.brawlock.test:5349?transport=tcp'], username: 'expiry:device', credential: 'short-lived-secret' },
  ],
  iceTransportPolicy: 'all',
})
async function peerAt(index = 0): Promise<FakePeer> {
  await vi.waitFor(() => expect(probe.peers).toHaveLength(index + 1))
  return probe.peers[index]
}
async function openJoin(peer: FakePeer) {
  peer.emit('open')
  peer.connections.at(-1)!.emit('open')
}

beforeEach(() => {
  vi.useFakeTimers()
  probe.peers.length = 0
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('explicit PeerJS ICE configuration', () => {
  it('refreshes long-lived host credentials for new peers and stops refreshing on close', async () => {
    const first = relayConfig(), next = relayConfig()
    next.iceServers![1].credential = 'renewed'
    const getConfig = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next)
    const hosting = createPeerNet(getConfig).host(), peer = await peerAt()
    peer.emit('open')
    const host = await hosting
    await vi.advanceTimersByTimeAsync(30_000)
    expect((peer.args[1] as { config: RTCConfiguration }).config.iceServers![1].credential).toBe('renewed')
    expect(peer.destroy).not.toHaveBeenCalled()
    host.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getConfig).toHaveBeenCalledTimes(2)
  })
  it('waits for the configured servers before registering a host', async () => {
    const config = relayConfig()
    let provide!: (config: RTCConfiguration) => void
    const getConfig = vi.fn(() => new Promise<RTCConfiguration>((resolve) => { provide = resolve }))
    const hosting = createPeerNet(getConfig).host()
    await vi.dynamicImportSettled()
    expect(probe.peers).toHaveLength(0)
    provide(config)
    const peer = await peerAt()
    expect(peer.args).toEqual([expect.stringMatching(/^brawlock-[A-Z]{5}$/), { config }])
    expect((peer.args[1] as { config: RTCConfiguration }).config).toBe(config)
    peer.emit('open')
    const host = await hosting
    expect(getConfig).toHaveBeenCalledOnce()
    host.close()
  })

  it('passes the full same credentialed config to the client constructor and retains channel options', async () => {
    const config = relayConfig(), getConfig = vi.fn(async () => config)
    const joining = createPeerNet(getConfig).join('ABCDE')
    const peer = await peerAt()
    expect(peer.args).toEqual([{ config }])
    expect((peer.args[0] as { config: RTCConfiguration }).config).toBe(config)
    await openJoin(peer)
    const transport = await joining
    expect(peer.connect).toHaveBeenCalledExactlyOnceWith('brawlock-ABCDE', { reliable: true, serialization: 'raw' })
    expect(peer.connections[0].peerConnection.createDataChannel).toHaveBeenCalledExactlyOnceWith('rt', { negotiated: true, id: 1000, ordered: false, maxRetransmits: 0 })
    expect(getConfig).toHaveBeenCalledOnce()
    transport.close()
  })

  it.each(['host', 'join'] as const)('rejects %s readably before opening any peer when ICE lookup fails', async (operation) => {
    const cause = new Error('ICE credentials endpoint unavailable')
    const getConfig = vi.fn(async (): Promise<RTCConfiguration> => { throw cause })
    const net = createPeerNet(getConfig)
    const result = operation === 'host' ? net.host() : net.join('ABCDE')
    await expect(result).rejects.toMatchObject({ message: 'Could not load the connection servers. Check your internet connection and try again.', cause })
    expect(probe.peers).toHaveLength(0)
    expect(getConfig).toHaveBeenCalledOnce()
  })

  it('reuses one config through host code collisions', async () => {
    const config = relayConfig(), getConfig = vi.fn(async () => config)
    const hosting = createPeerNet(getConfig).host()
    const first = await peerAt()
    first.emit('error', { type: 'unavailable-id', message: 'Taken' })
    const second = await peerAt(1)
    expect(first.destroy).toHaveBeenCalledOnce()
    expect((second.args[1] as { config: RTCConfiguration }).config).toBe(config)
    expect(getConfig).toHaveBeenCalledOnce()
    second.emit('open')
    const host = await hosting
    host.close()
  })

  it('keeps existing join retries on the configured peer without refetching credentials', async () => {
    const config = relayConfig(), getConfig = vi.fn(async () => config), status = vi.fn()
    const joining = createPeerNet(getConfig).join('ABCDE', status)
    const peer = await peerAt()
    peer.emit('open')
    expect(peer.connections).toHaveLength(1)
    peer.emit('error', { type: 'peer-unavailable', message: 'Host away' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(peer.connections).toHaveLength(2)
    expect(peer.connections[0].close).toHaveBeenCalledOnce()
    expect(probe.peers).toHaveLength(1)
    expect(getConfig).toHaveBeenCalledOnce()
    expect((peer.args[0] as { config: RTCConfiguration }).config).toBe(config)
    expect(status).toHaveBeenLastCalledWith('Host not reachable (maybe app-switched). Retrying (1/8)…')
    peer.connections[1].emit('open')
    const transport = await joining
    transport.close()
  })

  it('fetches fresh credentials for a later operation instead of retaining expired credentials', async () => {
    const firstConfig = relayConfig(), nextConfig = relayConfig()
    nextConfig.iceServers![1].credential = 'new-secret'
    const getConfig = vi.fn().mockResolvedValueOnce(firstConfig).mockResolvedValueOnce(nextConfig)
    const net = createPeerNet(getConfig)
    const hosting = net.host(), hostPeer = await peerAt()
    hostPeer.emit('open')
    const host = await hosting
    host.close()
    const joining = net.join('ABCDE'), clientPeer = await peerAt(1)
    expect((hostPeer.args[1] as { config: RTCConfiguration }).config).toBe(firstConfig)
    expect((clientPeer.args[0] as { config: RTCConfiguration }).config).toBe(nextConfig)
    await openJoin(clientPeer)
    const transport = await joining
    transport.close()
    expect(getConfig).toHaveBeenCalledTimes(2)
  })

  it('makes the unconfigured factory explicitly STUN-only without library TURN defaults', async () => {
    const hosting = peerNet.host(), peer = await peerAt()
    expect(peer.args[1]).toEqual({ config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } })
    expect(JSON.stringify(peer.args)).not.toContain('turn.peerjs.com')
    peer.emit('open')
    const host = await hosting
    host.close()
  })
})
