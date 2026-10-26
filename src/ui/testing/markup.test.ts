import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { parseMarkup, renderMarkup, testId } from './markup'

/** Why: UI tests assert absence with find() === undefined, so a parser that silently misses elements would pass them all. */
describe('static markup queries', () => {
  it('finds React-rendered elements by test id, role, attribute prefix, class and descendant chain', () => {
    const html = renderMarkup(createElement('section', { 'data-testid': 'panel', 'data-state': 'open', style: { maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' } },
      createElement('img', { src: 'a.png', alt: '' }),
      createElement('button', { className: 'chip primary', 'aria-label': 'Bet 1 gold on <Thorn>' }, 'pays ', 2),
      createElement('details', null, createElement('p', { role: 'note' }, 'Fish & chips')),
    ))
    const panel = html.get(testId('panel'))
    expect(panel.attr('data-state')).toBe('open')
    expect(panel.style).toEqual({ 'max-height': 'calc(100dvh - 16px)', 'overflow-y': 'auto' })
    expect(html.findAll('button')).toHaveLength(1)
    expect(html.get('[aria-label^="Bet 1"]').attr('aria-label')).toBe('Bet 1 gold on <Thorn>')
    expect(html.get('button.chip.primary').text).toBe('pays 2')
    expect(html.get('details [role="note"]').text).toBe('Fish & chips')
    expect(html.get('[role="note"]').closest('details')).toBeDefined()
    expect(html.get('button').closest('details')).toBeUndefined()
    expect(html.find('details button')).toBeUndefined()
    expect(html.find(testId('missing'))).toBeUndefined()
    expect(() => html.get(testId('missing'))).toThrow('missing')
    // the void img does not swallow its siblings
    expect(html.get('img').children).toHaveLength(0)
    expect(panel.text).toBe('pays 2Fish & chips')
  })

  it('decodes entities and keeps raw script text', () => {
    const html = parseMarkup('<p title="a &quot;b&quot; &#x27;c&#x27;">x&lt;y&#160;z</p><style>a>b{}</style>')
    expect(html.get('p').attr('title')).toBe('a "b" \'c\'')
    expect(html.get('p').text).toBe('x<y z')
    expect(html.get('style').text).toBe('a>b{}')
  })
})
