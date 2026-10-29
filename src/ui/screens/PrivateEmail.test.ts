import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderMarkup, testId } from '../testing/markup'
import { PrivateEmail } from './PrivateEmail'

describe('account email', () => {
  it('starts hidden, so opening account settings on a stream does not leak it', () => {
    const element = createElement(PrivateEmail, { email: 'streamer@example.test' })
    expect(renderMarkup(element).get(testId('account-email-toggle')).attr('data-state')).toBe('hidden')
    // nowhere in the markup: not as text, not in a title or label
    expect(renderToStaticMarkup(element)).not.toContain('streamer@example.test')
  })
})
