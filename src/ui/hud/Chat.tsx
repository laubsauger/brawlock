import { useEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { session } from '../../game/session'
import { useGame } from '../../game/store'
import { MAX_CHAT_LENGTH, type ChatLine } from '../../net/chat'
import { isTypingTarget } from '../lib/keys'
import { Button, Kbd } from '../widgets'

const EMPTY: readonly ChatLine[] = []

interface ComposerState {
  open: boolean
  draft: string
  error: string | null
  readId: number
}
type SendResult = ReturnType<typeof session.sendChat>
type ComposerAction =
  | { type: 'open'; lastId: number }
  | { type: 'read'; lastId: number }
  | { type: 'close' }
  | { type: 'draft'; text: string }
  | { type: 'send'; result: SendResult; lastId: number }

/** Sending is authoritative: a rejected message must never erase the player's draft. */
export function chatComposer(state: ComposerState, action: ComposerAction): ComposerState {
  if (action.type === 'open') return { ...state, open: true, error: null, readId: action.lastId }
  if (action.type === 'read') return state.readId === action.lastId ? state : { ...state, readId: action.lastId }
  if (action.type === 'close') return { ...state, open: false, error: null }
  if (action.type === 'draft') return { ...state, draft: action.text, error: null }
  if (action.result === 'sent') return { open: false, draft: '', error: null, readId: action.lastId }
  const errors = {
    invalid: `Type a message of up to ${MAX_CHAT_LENGTH} characters.`,
    limited: 'Messages are arriving too quickly. Wait a moment and try again.',
    unavailable: 'Chat is disconnected. Your message has not been sent.',
  }
  return { ...state, error: errors[action.result] }
}

/** Enter on an existing control belongs to that control, including menu buttons. */
export function chatShortcutTarget(target: EventTarget | null): boolean {
  return !isTypingTarget(target) && !(target instanceof HTMLElement && target.closest('button, a, summary, [role="button"], input, textarea, select, [role="dialog"]'))
}

function senderColor(color: number): string {
  // Keep every chosen player color readable against the dark transcript.
  const channel = (shift: number) => Math.round(((color >>> shift) & 255) * 0.65 + 255 * 0.35)
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`
}

export function ChatMessage({ line }: { line: ChatLine }) {
  if (line.system) return <li className="break-words text-sm italic leading-snug text-ash [overflow-wrap:anywhere]" data-chat-system>{line.text}</li>
  return (
    <li className="break-words text-sm leading-snug [overflow-wrap:anywhere]">
      <b style={{ color: senderColor(line.color) }}>{line.name}</b><span className="text-ash">: </span><span className="text-bone">{line.text}</span>
    </li>
  )
}

/** Dock chat beside room screens; preserve its measured overlay during combat. */
export function RoomChatLayout({ screen, children }: { screen: string; children: ReactNode }) {
  const connected = useGame((s) => s.lobby.role !== 'offline' && s.lobby.status === 'open')
  const docked = connected && (screen === 'lobby' || screen === 'results')
  const wrapper = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const element = wrapper.current!
    const measure = () => setHeight(element.getBoundingClientRect().height)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])
  return <div className="room-chat-layout pointer-events-none relative h-full overflow-hidden" data-chat-docked={docked || undefined} data-screen={screen} style={{ '--room-chat-offset': screen === 'match' && height > 0 ? `${height + 10}px` : '0px', '--spectator-bets-display': expanded ? 'none' : 'flex' } as CSSProperties}>
    {children}
    <div ref={wrapper} className={docked ? 'room-chat-dock' : 'pointer-events-none fixed left-3 z-[45] w-[min(340px,calc(100vw-24px))] sm:[@media(max-height:520px)]:w-[min(340px,40vw)]'} style={docked ? undefined : { bottom: screen === 'match' ? 'calc(var(--hud-bottom-h, 72px) * var(--ui-scale, 1) + 18px)' : 96 }}>
      <RoomChat compact={!docked} onExpandedChange={setExpanded} />
    </div>
  </div>
}

/** One instance survives lobby, combat and results without losing drafts or unread state. */
export function RoomChat({ compact = false, onExpandedChange }: { compact?: boolean; onExpandedChange?: (expanded: boolean) => void }) {
  const role = useGame((s) => s.lobby.role)
  const status = useGame((s) => s.lobby.status)
  const code = useGame((s) => s.lobby.roomCode)
  const screen = useGame((s) => s.screen)
  if (role === 'offline' || status !== 'open' || !['lobby', 'match', 'results'].includes(screen)) return null
  return <ChatBody key={code} compact={compact} onExpandedChange={onExpandedChange} />
}

function ChatBody({ compact, onExpandedChange }: { compact: boolean; onExpandedChange?: (expanded: boolean) => void }) {
  const lines = useGame((s) => s.lobby.chat) ?? EMPTY
  const local = useGame((s) => s.lobby.localPlayer)
  const settings = useGame((s) => s.settingsOpen)
  const paused = useGame((s) => s.paused)
  const lastId = lines.at(-1)?.id ?? 0
  const [composer, dispatch] = useReducer(chatComposer, { open: false, draft: '', error: null, readId: lastId })
  const input = useRef<HTMLInputElement>(null)
  const transcript = useRef<HTMLOListElement>(null)
  const atBottom = useRef(true)
  const wasOpen = useRef(false)
  const recent = lines.slice(-3)
  const unread = lines.filter((line) => line.id > composer.readId && line.player !== local).length

  useEffect(() => {
    onExpandedChange?.(composer.open)
    return () => onExpandedChange?.(false)
  }, [composer.open, onExpandedChange])

  useEffect(() => {
    if (composer.open || !compact) dispatch({ type: 'read', lastId })
    const list = transcript.current
    const justOpened = composer.open && !wasOpen.current
    wasOpen.current = composer.open
    if (list && (atBottom.current || justOpened)) list.scrollTop = list.scrollHeight
  }, [lines, lastId, composer.open, compact])

  useEffect(() => {
    if (composer.open && !settings && !paused) input.current?.focus()
  }, [composer.open, settings, paused])

  useEffect(() => {
    if (settings || paused) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !chatShortcutTarget(event.target)) return
      // Capture precedes Results' rematch shortcut and the gameplay key handlers.
      event.preventDefault()
      event.stopImmediatePropagation()
      dispatch({ type: 'open', lastId })
      input.current?.focus()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [lastId, settings, paused])

  const expanded = !compact || composer.open
  return (
    <section
      className={`${compact && !expanded ? 'pointer-events-none' : 'pointer-events-auto'} w-full min-w-0 ${compact ? 'room-chat-overlay max-w-[340px]' : 'flex h-full flex-col'} ${expanded ? `${compact ? 'room-chat-composing' : 'hud-plate'} rounded-md p-3` : ''}`}
      aria-label="Room-wide chat"
      data-chat-presentation={!compact ? 'docked' : expanded ? 'composing' : 'passive'}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <header className="flex items-center justify-between gap-2">
        {!compact ? <h2 className="font-semibold text-bone">Room chat</h2> : <button
          type="button"
          className="pointer-events-auto flex items-center gap-2 rounded px-1 py-0.5 text-sm font-semibold text-bone hover:text-gold"
          aria-expanded={composer.open}
          aria-label={composer.open ? 'Close room chat' : `Open room chat${unread ? `, ${unread} unread messages` : ''}`}
          onClick={() => dispatch(composer.open ? { type: 'close' } : { type: 'open', lastId })}
          disabled={settings || paused}
        >
          Chat {!composer.open && <Kbd>Enter</Kbd>}
          {!composer.open && unread > 0 && <span className="rounded bg-gold/15 px-1.5 text-xs text-gold">{unread}</span>}
        </button>}
        {expanded && <span className="text-xs text-ash">Everyone in this room</span>}
      </header>
      <ol
        ref={transcript}
        role="log"
        aria-label="Room-wide messages"
        aria-live="polite"
        aria-relevant="additions"
        className={`mt-2 space-y-1 ${!compact ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1' : expanded ? 'max-h-[min(24vh,180px)] overflow-y-auto overscroll-contain pr-1' : 'pointer-events-none'}`}
        onScroll={(event) => {
          const list = event.currentTarget
          atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24
        }}
      >
        {(expanded ? lines : recent).map((line) => <ChatMessage key={line.id} line={line} />)}
      </ol>
      {expanded && lines.length === 0 && <p className="mt-1 text-xs text-ash">Say hello to the room.</p>}
      {(composer.open || !compact) && (
        <form
          className="mt-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (settings || paused) return
            dispatch({ type: 'send', result: session.sendChat(composer.draft), lastId })
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              dispatch({ type: 'close' })
            }
            if (event.nativeEvent.isComposing && event.key === 'Enter') event.preventDefault()
          }}
          onKeyUp={(event) => event.stopPropagation()}
        >
          <div className="flex gap-1.5">
            <input
              ref={input}
              className="field min-w-0 flex-1 px-2 py-1.5 text-sm"
              aria-label="Message everyone in this room"
              aria-invalid={!!composer.error}
              aria-describedby={composer.error ? 'room-chat-error' : undefined}
              placeholder="Message the room…"
              maxLength={MAX_CHAT_LENGTH}
              autoComplete="off"
              value={composer.draft}
              disabled={settings || paused}
              onChange={(event) => dispatch({ type: 'draft', text: event.target.value })}
            />
            <Button size="sm" type="submit" disabled={!composer.draft.trim() || settings || paused}>Send</Button>
          </div>
          {composer.error && <p id="room-chat-error" className="mt-1 text-xs text-[#ffb3a6]" role="alert">{composer.error}</p>}
          <p className="mt-1 text-xs text-ash">Enter to send · Esc to close</p>
        </form>
      )}
    </section>
  )
}
