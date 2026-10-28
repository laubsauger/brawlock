import { useEffect, useRef, useState } from 'react'
import { online } from '../../game/session'
import { useAccount } from '../../game/accountState'
import { accountsEnabled } from '../../game/account'
import { useGame } from '../../game/store'
import { MAX_CHAT_LENGTH } from '../../net/chat'
import type { GlobalChatLine } from '../../net/globalChat'
import { PRESENCE_REGIONS } from '../../shared/presence'
import { SITE_HOST, SITE_URL, openSite } from '../../lib/site'
import { chatShortcutTarget, senderColor } from '../hud/Chat'
import { muteSender, reportGlobalChat, sendGlobalChat, unmuteAll, useChatMutes, useGlobalChat, useGlobalChatFeed } from '../lib/globalChat'
import { usePresenceRegion } from '../lib/presence'
import { Button, Kbd } from '../widgets'

const regionLabel = (id: string) => online.regions.find((region) => region.id === id)?.label ?? id
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * The main menu's chat with everyone online: passive like the in-game chat (the last lines
 * and a toggle, bottom right), a panel with the whole channel while open.
 */
export function GlobalChat({ onSignIn }: { onSignIn: () => void }) {
  const shown = accountsEnabled || !!SITE_URL
  useGlobalChatFeed(shown)
  if (!shown) return null
  return <GlobalChatBody onSignIn={onSignIn} />
}

function GlobalChatBody({ onSignIn }: { onSignIn: () => void }) {
  const lines = useGlobalChat((s) => s.lines)
  const live = useGlobalChat((s) => s.live)
  const muted = useChatMutes((s) => s.muted)
  const account = useAccount((s) => s.player)
  const settings = useGame((s) => s.settingsOpen)
  const region = usePresenceRegion()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<string>('all')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [reported, setReported] = useState<ReadonlySet<number>>(new Set())
  const visible = lines.filter((line) => (filter === 'all' || line.region === filter) && !muted.includes(line.sender))
  const lastId = visible.at(-1)?.id ?? 0
  const [readId, setReadId] = useState(lastId)
  const own = account?.profile?.name
  const unread = visible.filter((line) => line.id > readId && line.name !== own).length
  const input = useRef<HTMLInputElement>(null)
  const transcript = useRef<HTMLOListElement>(null)
  const atBottom = useRef(true)

  useEffect(() => {
    if (open) setReadId(lastId)
    const list = transcript.current
    if (list && atBottom.current) list.scrollTop = list.scrollHeight
  }, [open, lastId])

  useEffect(() => {
    if (open && !settings) input.current?.focus()
  }, [open, settings])

  useEffect(() => {
    if (settings || open) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !chatShortcutTarget(event.target)) return
      event.preventDefault()
      atBottom.current = true
      setOpen(true)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [settings, open])

  const send = async () => {
    if (busy || !region || !draft.trim()) return
    setBusy(true)
    const problem = await sendGlobalChat(draft, region)
    setBusy(false)
    setError(problem)
    if (!problem) { setDraft(''); atBottom.current = true }
  }
  const report = async (line: GlobalChatLine) => {
    const problem = await reportGlobalChat(line.id)
    if (!problem) setReported((ids) => new Set([...ids, line.id]))
    setNote(problem ?? `Reported ${line.name}'s message. Thank you.`)
  }

  const canPost = !!account?.profile && accountsEnabled
  const recent = visible.slice(-3)
  return (
    <section
      className={`global-chat fixed z-20 ${open ? 'global-chat-open room-chat-composing pointer-events-auto rounded-md p-3' : 'room-chat-overlay pointer-events-none'}`}
      aria-label="Global chat"
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <header className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="pointer-events-auto flex items-center gap-2 rounded px-1 py-0.5 text-sm font-semibold text-bone hover:text-gold"
          aria-expanded={open}
          aria-label={open ? 'Close global chat' : `Open global chat${unread ? `, ${unread} unread messages` : ''}`}
          onClick={() => { atBottom.current = true; setOpen((o) => !o) }}
        >
          Global chat {!open && <Kbd>Enter</Kbd>}
          {!open && unread > 0 && <span className="rounded bg-gold/15 px-1.5 text-xs text-gold">{unread}</span>}
        </button>
        {open && <div className="flex gap-0.5" role="group" aria-label="Show messages from">
          {['all', ...PRESENCE_REGIONS].map((id) => <button key={id} type="button" aria-pressed={filter === id}
            className={`rounded px-1.5 py-0.5 text-xs ${filter === id ? 'bg-gold/15 text-gold' : 'text-ash hover:text-bone'}`}
            onClick={() => setFilter(id)}>{id === 'all' ? 'All' : regionLabel(id)}</button>)}
        </div>}
      </header>
      <ol
        ref={transcript}
        role="log"
        aria-label="Global messages"
        aria-live="polite"
        aria-relevant="additions"
        className={`mt-1.5 space-y-1 ${open ? 'max-h-[min(24vh,220px)] overflow-y-auto overscroll-contain pr-1' : ''}`}
        onScroll={(event) => {
          const list = event.currentTarget
          atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24
        }}
      >
        {(open ? visible : recent).map((line) => <li key={line.id} className="group break-words text-sm leading-snug [overflow-wrap:anywhere]" title={`${regionLabel(line.region)} · ${clock(line.at)}`}>
          <b style={line.color === null ? undefined : { color: senderColor(line.color) }} className={line.color === null ? 'text-bone' : undefined}>{line.name}</b>
          <span className="text-ash">: </span><span className="text-bone">{line.text}</span>
          {open && line.name !== own && <span className="ml-1.5 inline-flex gap-1.5 text-xs opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <button type="button" className="text-ash underline-offset-2 hover:text-bone hover:underline" onClick={() => muteSender(line.sender)}>Mute</button>
            {canPost && !reported.has(line.id) && <button type="button" className="text-ash underline-offset-2 hover:text-[#ffb3a6] hover:underline" onClick={() => void report(line)}>Report</button>}
          </span>}
        </li>)}
      </ol>
      {open && <>
        {!visible.length && <p className="mt-1 text-xs text-ash">{live ? 'No messages yet. Say hello to everyone online.' : 'Connecting to global chat…'}</p>}
        {note && <p className="mt-1.5 text-xs text-ash" role="status">{note}</p>}
        {canPost ? <form
          className="mt-2"
          onSubmit={(event) => { event.preventDefault(); void send() }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
            if (event.nativeEvent.isComposing && event.key === 'Enter') event.preventDefault()
          }}
        >
          <div className="flex gap-1.5">
            <input
              ref={input}
              className="field min-w-0 flex-1 px-2 py-1.5 text-sm"
              aria-label="Message everyone online"
              aria-invalid={!!error}
              aria-describedby={error ? 'global-chat-error' : undefined}
              placeholder="Message everyone online…"
              maxLength={MAX_CHAT_LENGTH}
              autoComplete="off"
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setError(null) }}
            />
            <Button size="sm" type="submit" disabled={!draft.trim() || busy || !region}>Send</Button>
          </div>
          {error && <p id="global-chat-error" className="mt-1 text-xs text-[#ffb3a6]" role="alert">{error}</p>}
        </form> : <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ash">
          <span>{accountsEnabled ? account ? 'Choose your player name to chat.' : 'Sign in to chat. Guests can read along.' : `Chat with an account on ${SITE_HOST}.`}</span>
          <Button size="sm" variant="ghost" onClick={accountsEnabled ? onSignIn : openSite}>{accountsEnabled && account ? 'Choose name' : 'Sign in'}</Button>
        </div>}
        {muted.length > 0 && <p className="mt-1.5 text-xs text-ash">{muted.length} muted in this browser · <button type="button" className="underline-offset-2 hover:text-bone hover:underline" onClick={unmuteAll}>Unmute all</button></p>}
      </>}
    </section>
  )
}
