import { useFeedback } from './lib/feedbackState'

/** Kept independent of the modal/widgets so every shared menu can expose it. */
export function FeedbackButton({ compact = false }: { compact?: boolean }) {
  const capturing = useFeedback((state) => state.capturing)
  return <button type="button" className={`btn btn-ghost btn-sm ${compact ? '' : 'text-[#e4c49b]'}`} disabled={capturing} onClick={() => void useFeedback.getState().open()} data-testid="open-feedback" data-feedback-exclude>
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m4 9 15-5v16L4 15ZM4 9H2v6h2M7 16l2 6h3l-2-5M22 9v6" /></svg>
    <span className="btn-label">{capturing ? 'Capturing…' : compact ? 'Feedback' : 'Bugs & feedback'}</span>
  </button>
}
