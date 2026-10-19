import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useGame } from '../../game/store'
import { MAX_CHAT_LENGTH, type ChatLine } from '../../net/chat'

vi.mock('../../game/session', () => ({ session: { sendChat: vi.fn() } }))
vi.mock('../../game/store', async (importOriginal) => {
  const store = await importOriginal<typeof import('../../game/store')>()
  // SSR must use the test's current room rather than Zustand's boot hydration state.
  const useCurrent = (selector: (state: ReturnType<typeof store.useGame.getState>) => unknown) => selector(store.useGame.getState())
  return { ...store, useGame: Object.assign(useCurrent, store.useGame) }
})
import { ChatMessage, RoomChat, RoomChatLayout, chatComposer, chatShortcutTarget } from './Chat'

const initialStore = useGame.getState()
const line = (patch: Partial<ChatLine> = {}): ChatLine => ({ id: 1, player: 1, name: 'Thorn', color: 0xff7700, text: 'Good round!', ...patch })
const composer = () => ({ open: true, draft: 'One more round?', error: null, readId: 3 })

beforeEach(() => {
  useGame.setState({
    screen: 'lobby',
    settingsOpen: false,
    paused: false,
    lobby: { ...initialStore.lobby, role: 'client', status: 'open', roomCode: 'ABCDE', localPlayer: 0, chat: [line()] },
  })
})
afterEach(() => {
  useGame.setState(initialStore)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('room chat presentation', () => {
  it('exposes an accessible room-wide transcript with safely escaped player-controlled text', () => {
    const html = renderToStaticMarkup(createElement(ChatMessage, { line: line({ name: '<img src=x onerror=alert(1)>', text: '<script>alert("hi")</script>' }) }))
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    const panel = renderToStaticMarkup(createElement(RoomChat))
    expect(panel).toContain('aria-label="Room-wide chat"')
    expect(panel).toContain('role="log" aria-label="Room-wide messages"')
    expect(panel).toContain('Everyone in this room')
    expect(panel).toContain('Good round!')
    expect(panel).toContain('Room chat</h2>')
    expect(panel).toContain('aria-label="Message everyone in this room"')
    expect(panel).not.toContain('aria-label="Open room chat"')
  })

  it('reserves chat space in connected lobbies and results, keeping combat chat compact', () => {
    for (const screen of ['lobby', 'results'] as const) {
      useGame.setState({ screen })
      const html = renderToStaticMarkup(createElement(RoomChatLayout, { screen, children: createElement('main', { className: 'room-screen-content' }) }))
      expect(html).toContain('data-chat-docked="true"')
      expect(html).toContain('room-chat-dock')
      expect(html).toContain('aria-label="Message everyone in this room"')
    }
    useGame.setState({ screen: 'match' })
    const match = renderToStaticMarkup(createElement(RoomChatLayout, { screen: 'match', children: null }))
    expect(match).toContain('room-chat-layout pointer-events-none')
    expect(match).not.toContain('data-chat-docked')
    expect(match).toContain('aria-label="Open room chat"')
    expect(match).not.toContain('aria-label="Message everyone in this room"')
    useGame.setState({ screen: 'lobby', lobby: { ...useGame.getState().lobby, role: 'offline' } })
    const offline = renderToStaticMarkup(createElement(RoomChatLayout, { screen: 'lobby', children: null }))
    expect(offline).not.toContain('data-chat-docked')
    expect(offline).not.toContain('Room-wide chat')
  })

  it('shows only the latest three messages in the compact closed view', () => {
    useGame.setState({ lobby: { ...useGame.getState().lobby, chat: Array.from({ length: 5 }, (_, i) => line({ id: i + 1, text: `message-${i + 1}` })) } })
    const compact = renderToStaticMarkup(createElement(RoomChat, { compact: true }))
    expect(compact).not.toContain('message-1')
    expect(compact).not.toContain('message-2')
    for (const id of [3, 4, 5]) expect(compact).toContain(`message-${id}`)
    const full = renderToStaticMarkup(createElement(RoomChat))
    for (const id of [1, 2, 3, 4, 5]) expect(full).toContain(`message-${id}`)
    expect(compact).toContain('max-w-[340px]')
  })

  it('never exposes online chat offline, disconnected or outside the room screens', () => {
    for (const role of ['host', 'client'] as const) {
      useGame.setState({ lobby: { ...useGame.getState().lobby, role, status: 'open' } })
      expect(renderToStaticMarkup(createElement(RoomChat))).toContain('Room-wide chat')
    }
    for (const status of ['idle', 'connecting', 'error'] as const) {
      useGame.setState({ lobby: { ...useGame.getState().lobby, status } })
      expect(renderToStaticMarkup(createElement(RoomChat))).toBe('')
    }
    useGame.setState({ lobby: { ...useGame.getState().lobby, role: 'offline', status: 'open' } })
    expect(renderToStaticMarkup(createElement(RoomChat))).toBe('')
    useGame.setState({ lobby: { ...useGame.getState().lobby, role: 'client' } })
    for (const screen of ['boot', 'unsupported', 'menu', 'credits', 'replay'] as const) {
      useGame.setState({ screen })
      expect(renderToStaticMarkup(createElement(RoomChat))).toBe('')
    }
  })
})

describe('chat composer interaction state', () => {
  it.each(['invalid', 'limited', 'unavailable'] as const)('preserves an unsent draft after %s and clears it only after a successful retry', (result) => {
    const failed = chatComposer(composer(), { type: 'send', result, lastId: 5 })
    expect(failed.draft).toBe('One more round?')
    expect(failed.open).toBe(true)
    expect(failed.error).toBeTruthy()
    if (result === 'invalid') expect(failed.error).toContain(String(MAX_CHAT_LENGTH))
    if (result === 'limited') expect(failed.error).toContain('Wait a moment')
    if (result === 'unavailable') expect(failed.error).toContain('has not been sent')
    expect(chatComposer(failed, { type: 'send', result: 'sent', lastId: 6 })).toEqual({ open: false, draft: '', error: null, readId: 6 })
  })

  it('closing preserves a draft and opening acknowledges messages without submitting anything', () => {
    const closed = chatComposer(composer(), { type: 'close' })
    expect(closed.open).toBe(false)
    expect(closed.draft).toBe('One more round?')
    const reopened = chatComposer(closed, { type: 'open', lastId: 12 })
    expect(reopened).toEqual({ ...composer(), readId: 12 })
    expect(chatComposer(reopened, { type: 'read', lastId: 14 }).draft).toBe('One more round?')
  })

  it('leaves typing, native buttons, selects and modal controls in charge of Enter', () => {
    class Element {
      isContentEditable = false
      constructor(readonly tagName: string, readonly type = '', readonly blocked = false) {}
      closest(selector: string) { return this.blocked || selector.split(',').map((part) => part.trim()).includes(this.tagName.toLowerCase()) ? this : null }
    }
    vi.stubGlobal('HTMLElement', Element)
    const target = (tag: string, type = '', blocked = false) => new Element(tag, type, blocked) as unknown as HTMLElement
    expect(chatShortcutTarget(target('BODY'))).toBe(true)
    for (const el of [target('INPUT', 'text'), target('TEXTAREA'), target('SELECT'), target('SUMMARY'), target('BUTTON', '', true), target('SPAN', '', true), target('INPUT', 'range', true)]) {
      expect(chatShortcutTarget(el)).toBe(false)
    }
    const editable = target('DIV')
    Object.assign(editable, { isContentEditable: true })
    expect(chatShortcutTarget(editable)).toBe(false)
  })
})
