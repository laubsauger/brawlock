import { expect, it, vi } from 'vitest'
import { SocketTransport, type TextSocket } from './ws'

it('holds the destination before an asynchronous socket close can remove its sole player', () => {
  vi.useFakeTimers()
  const calls: string[] = []
  const socket: TextSocket = { send() {}, close: () => { calls.push('closed') }, onText() {}, onClose() {},
    holdForHandoff: () => { calls.push('held') } }
  const transport = new SocketTransport(socket)
  try {
    transport.prepareHandoff()
    expect(calls).toEqual(['held'])
    transport.close()
    expect(calls).toEqual(['held'])
    vi.advanceTimersByTime(150)
    expect(calls).toEqual(['held', 'closed'])
  } finally { transport.close(); vi.runOnlyPendingTimers(); vi.useRealTimers() }
})
