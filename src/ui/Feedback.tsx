import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FEEDBACK_MESSAGE_MAX, validFeedbackSubmission, type FeedbackSubmission } from '../net/feedback'
import { feedbackRequest, useFeedback } from './lib/feedbackState'
import { Button, Modal, Segmented } from './widgets'

function FeedbackForm() {
  const draft = useFeedback((state) => state.draft)!
  const [kind, setKind] = useState<'bug' | 'feedback'>('bug')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [includeScreenshot, setIncludeScreenshot] = useState(!!draft.screenshot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const request = useRef<{ body: string; submission: FeedbackSubmission } | null>(null)
  const close = () => { if (!busy) useFeedback.getState().close() }
  // The underlying menu stays mounted, with focus and pointer access owned by this dialog.
  useEffect(() => {
    const root = document.getElementById('root')!
    const previous = root.inert
    root.inert = true
    return () => { root.inert = previous }
  }, [])
  const submit = async () => {
    if (busy) return
    const value = { kind, message: message.trim(), ...(email.trim() ? { contactEmail: email.trim() } : {}), context: draft.context,
      ...(includeScreenshot && draft.screenshot ? { screenshot: draft.screenshot } : {}) }
    request.current = feedbackRequest(request.current, value)
    if (!validFeedbackSubmission(request.current.submission)) { setError('Check your message and reply email. The report could not be validated.'); return }
    setBusy(true); setError(null)
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/feedback`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.current.submission), signal: AbortSignal.timeout(20_000) })
      const result: unknown = await response.json()
      if (!response.ok) {
        const detail = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'The report service could not accept this report.'
        throw new Error(response.status === 429 ? 'Too many reports just now. Please try again later.' : detail)
      }
      if (!result || typeof result !== 'object' || !('id' in result) || result.id !== request.current.submission.id) throw new Error('The report receipt was not confirmed. Please retry.')
      setReceipt(result.id as string)
    } catch (cause) {
      setError(cause instanceof Error && cause.name !== 'SyntaxError' && cause.name !== 'TypeError' ? cause.message : 'The report could not be sent. Your draft is still here; please retry.')
    } finally { setBusy(false) }
  }
  return <Modal title="Bugs & feedback" onClose={close} help={false} escDisabled={busy} width="max-w-2xl" footer={receipt ? <Button variant="primary" onClick={close}>Done</Button> : <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-ash">Sent privately to the Brawlock team.</span><Button variant="primary" disabled={busy || message.trim().length < 3} onClick={() => void submit()}>{busy ? 'Sending…' : 'Send report'}</Button></div>}>
    <p className="mb-5 text-sm text-ash">Send a bug report, suggestion or support request to the Brawlock team.</p>
    {receipt ? <div role="status" className="space-y-3"><h3 className="text-xl font-semibold text-gold">Report received. Thank you.</h3><p className="text-ash">{email.trim() ? 'We can reply to the email you provided.' : 'Your report helps us improve Brawlock.'}</p><p className="break-all text-xs text-ash">Reference: {receipt}</p></div> : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <Segmented label="Report type" value={kind} onChange={setKind} disabled={busy} options={[{ value: 'bug', label: 'Report a bug' }, { value: 'feedback', label: 'Share feedback' }]} />
      <label className="flex flex-col gap-2 text-bone">{kind === 'bug' ? 'What happened?' : 'What’s on your mind?'}<textarea autoFocus className="field min-h-28 w-full resize-y" required minLength={3} maxLength={FEEDBACK_MESSAGE_MAX} disabled={busy} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={kind === 'bug' ? 'What went wrong? What were you trying to do?' : 'What would make the game better?'} /></label>
      <label className="flex flex-col gap-2 text-sm text-ash">Reply email (optional)<input type="email" className="field w-full" autoComplete="email" maxLength={254} disabled={busy} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Only if you’d like us to get back to you" /></label>
      {draft.screenshot && <section className="rounded border border-gold/20 bg-black/20 p-3"><label className="flex cursor-pointer items-center gap-2 text-sm text-bone"><input type="checkbox" checked={includeScreenshot} disabled={busy} onChange={(event) => setIncludeScreenshot(event.target.checked)} />Attach screenshot from when you opened this report</label><details className="mt-2"><summary className="cursor-pointer text-sm text-gold">Preview screenshot</summary><a href={`data:${draft.screenshot.mime};base64,${draft.screenshot.data}`} target="_blank" rel="noreferrer"><img className="mt-2 w-full rounded border border-white/10" src={`data:${draft.screenshot.mime};base64,${draft.screenshot.data}`} alt="Game screen captured before the report dialog opened" /></a></details><p className="mt-2 text-xs text-ash">Check for anything private, including visible chat or account details. Uncheck to leave the screenshot out.</p></section>}
      {draft.captureError && <p role="status" className="text-sm text-[#ffd3a3]">Screenshot unavailable: {draft.captureError} Your report can still include the technical context below.</p>}
      <details className="rounded border border-white/10 p-3"><summary className="cursor-pointer text-sm text-gold">Technical context included automatically</summary><p className="my-2 text-xs text-ash">Version, browser, settings, connection, match state, recent game events and errors. No cookies, passwords, or chat history.</p><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs text-ash">{JSON.stringify(draft.context, null, 2)}</pre></details>
      <p className="text-xs text-ash">By sending, you share this message and the context shown above with us to investigate your report. <a href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noreferrer" className="underline">Privacy Policy</a></p>
      {error && <p role="alert" className="text-sm text-[#ffb6a0]">{error}</p>}
    </form>}
  </Modal>
}

export function FeedbackDialog() {
  const draft = useFeedback((state) => state.draft)
  const error = useFeedback((state) => state.error)
  if (!draft && !error) return null
  // Window-level match/replay shortcuts must not consume report-form keys,
  // including when matchmaking starts a game behind an already-open report.
  return createPortal(<div onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
    {error ? <Modal title="Bugs & feedback" help={false} onClose={useFeedback.getState().close} width="max-w-lg"><p role="alert" className="mb-4 text-ash">{error}</p><Button onClick={() => void useFeedback.getState().open()}>Try again</Button></Modal> : <FeedbackForm />}
  </div>, document.body)
}
