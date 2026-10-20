import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { feedbackRequest, useFeedback } from './feedbackState'
import type { FeedbackSubmission } from '../../net/feedback'

const sources = vi.hoisted(() => ({ collectorError: false, imageError: false }))
vi.mock('./feedbackContext', () => ({ captureFeedbackContext: () => {
  if (sources.collectorError) throw new Error('Collector failed')
  return { capturedAt: 100, screen: 'lobby' }
} }))
vi.mock('./feedbackScreenshot', () => ({ feedbackScreenshot: async () => {
  if (sources.imageError) throw new Error('Scene is not ready')
  return { mime: 'image/jpeg', data: 'snapshot', width: 100, height: 100 }
} }))

beforeEach(() => {
  sources.collectorError = false; sources.imageError = false
  useFeedback.setState({ capturing: false, draft: null, error: null })
  vi.stubGlobal('document', { querySelectorAll: () => [] })
})
afterEach(() => vi.unstubAllGlobals())

describe('report retries', () => {
  it('keeps one UUID for the same frozen payload and replaces it after edits', () => {
    const draft = { kind: 'bug', message: 'A hit went missing', context: { capturedAt: 100 } } as Omit<FeedbackSubmission, 'id'>
    const first = feedbackRequest(null, draft)
    expect(feedbackRequest(first, structuredClone(draft))).toBe(first)
    const edited = feedbackRequest(first, { ...draft, message: 'Changed details' })
    expect(edited.submission.id).not.toBe(first.submission.id)
    expect(first.submission.context.capturedAt).toBe(100)
    const withEmail = feedbackRequest(first, { ...draft, contactEmail: 'player@example.com' })
    expect(withEmail.submission.id).not.toBe(first.submission.id)
  })

  it('shows a collector failure without inventing context or rejecting the click promise', async () => {
    sources.collectorError = true
    await expect(useFeedback.getState().open()).resolves.toBeUndefined()
    expect(useFeedback.getState()).toMatchObject({ capturing: false, draft: null, error: expect.stringContaining('could not load') })
  })

  it('keeps real diagnostics with an explicit screenshot failure and no fake attachment', async () => {
    sources.imageError = true
    await useFeedback.getState().open()
    expect(useFeedback.getState().draft).toEqual({ context: { capturedAt: 100, screen: 'lobby' }, screenshot: null, captureError: 'Scene is not ready' })
    useFeedback.getState().close()
    expect(useFeedback.getState().draft).toBeNull()
  })
})
