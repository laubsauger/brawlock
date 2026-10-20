import { useFeedback } from './lib/feedbackState'

/** Kept independent of the modal/widgets so every shared menu can expose it. */
export function FeedbackButton({ compact = false }: { compact?: boolean }) {
  const capturing = useFeedback((state) => state.capturing)
  return <button type="button" className={`btn btn-ghost btn-sm ${compact ? '' : 'text-[#e4c49b]'}`} disabled={capturing} onClick={() => void useFeedback.getState().open()} data-testid="open-feedback" data-feedback-exclude>
    <span className="btn-label">{capturing ? 'Capturing…' : compact ? 'Feedback' : 'Contact & feedback'}</span>
  </button>
}
