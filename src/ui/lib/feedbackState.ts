import { create } from 'zustand'
import type { FeedbackContext, FeedbackScreenshot, FeedbackSubmission } from '../../net/feedback'

export interface FeedbackDraft {
  context: FeedbackContext
  screenshot: FeedbackScreenshot | null
  captureError: string | null
}
export const useFeedback = create<{
  capturing: boolean
  error: string | null
  draft: FeedbackDraft | null
  open: () => Promise<void>
  close: () => void
}>((set, get) => ({
  capturing: false, draft: null, error: null,
  open: async () => {
    if (get().capturing || get().draft) return
    // Load collectors before taking the snapshot; the dialog never appears in its own attachment.
    set({ capturing: true, error: null })
    try {
      const [{ captureFeedbackContext }, { feedbackScreenshot }] = await Promise.all([import('./feedbackContext'), import('./feedbackScreenshot')])
      const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1)
      const panel = dialog?.getAttribute('aria-label') ?? null
      const context = captureFeedbackContext(panel)
      let screenshot: FeedbackScreenshot | null = null
      let captureError: string | null = null
      try { screenshot = await feedbackScreenshot() }
      catch (error) { captureError = error instanceof Error ? error.message : 'Screenshot capture failed.' }
      set({ draft: { context, screenshot, captureError } })
    } catch {
      set({ error: 'The report tools could not load. Reload Brawlock and try again, or contact us by email.' })
    } finally { set({ capturing: false }) }
  },
  close: () => set({ draft: null, error: null }),
}))

/** Reuse the receipt ID only for an identical payload after an uncertain network response. */
export function feedbackRequest(previous: { body: string; submission: FeedbackSubmission } | null, value: Omit<FeedbackSubmission, 'id'>) {
  const body = JSON.stringify(value)
  return previous?.body === body ? previous : { body, submission: { ...value, id: crypto.randomUUID() } }
}
