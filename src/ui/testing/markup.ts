import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * UI tests read React static markup as a small element tree, so they find an element by test id,
 * role or aria label and assert its state and numbers, not its sentences or styling classes.
 * No DOM library: this parses only what renderToStaticMarkup writes.
 *
 * Convention for components a test needs to read:
 * - `data-testid` names the element;
 * - what it shows goes in data attributes: `data-state` for one closed set of values
 *   ("open", "closed", ...), a named `data-<what>` when there are several (`data-outcome`,
 *   `data-pick`), numbers as they are (`data-pot="2"`);
 * - tests assert those, aria attributes and the numbers in `text`. Copy, classes and inline
 *   styles can change without a test noticing, unless they are the behavior under test.
 */
export class MarkupElement {
  readonly children: (MarkupElement | string)[] = []

  constructor(readonly tag: string, readonly attrs: Readonly<Record<string, string>>, readonly parent: MarkupElement | null) {}

  attr(name: string): string | undefined {
    return this.attrs[name]
  }

  /** Decoded text of everything inside, as textContent. */
  get text(): string {
    return this.children.map((child) => (typeof child === 'string' ? child : child.text)).join('')
  }

  /** Inline style declarations by property name. */
  get style(): Record<string, string> {
    const out: Record<string, string> = {}
    let depth = 0
    let start = 0
    const css = this.attrs.style ?? ''
    for (let i = 0; i <= css.length; i++) {
      const ch = css[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if ((ch === ';' && depth === 0) || i === css.length) {
        const declaration = css.slice(start, i)
        const colon = declaration.indexOf(':')
        if (colon > 0) out[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim()
        start = i + 1
      }
    }
    return out
  }

  matches(selector: string): boolean {
    return matchesChain(this, parseSelector(selector))
  }

  /** Elements inside this one matching a CSS selector subset: tag, #id, .class, [attr], [attr="v"], [attr^="v"], [attr*="v"], [attr$="v"], descendant combinator. */
  findAll(selector: string): MarkupElement[] {
    const chain = parseSelector(selector)
    const out: MarkupElement[] = []
    const walk = (el: MarkupElement) => {
      for (const child of el.children) {
        if (typeof child === 'string') continue
        if (matchesChain(child, chain)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  find(selector: string): MarkupElement | undefined {
    return this.findAll(selector)[0]
  }

  /** As find, but a missing element fails the test with the selector in the message. */
  get(selector: string): MarkupElement {
    const el = this.find(selector)
    if (!el) throw new Error(`No element matches ${selector}`)
    return el
  }

  /** This element or its nearest ancestor matching the selector. */
  closest(selector: string): MarkupElement | undefined {
    const chain = parseSelector(selector)
    for (let el: MarkupElement | null = this; el && el.parent; el = el.parent) if (matchesChain(el, chain)) return el
    return undefined
  }
}

export const testId = (id: string) => `[data-testid="${id}"]`

/** Render to static markup and parse it; the result is the root, so `.find` and `.text` cover everything. */
export function renderMarkup(element: ReactElement): MarkupElement {
  return parseMarkup(renderToStaticMarkup(element))
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const RAW_TEXT = new Set(['script', 'style'])
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
  if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? entity
  return String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
})

export function parseMarkup(html: string): MarkupElement {
  const root = new MarkupElement('#root', {}, null)
  let current = root
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0 || lt > i) current.children.push(decode(html.slice(i, lt < 0 ? html.length : lt)))
    if (lt < 0) break
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4)
      i = close < 0 ? html.length : close + 3
      continue
    }
    // the tag ends at the first '>' outside a quoted attribute value
    let end = lt + 1
    for (let quote = ''; end < html.length; end++) {
      const ch = html[end]
      if (quote) { if (ch === quote) quote = '' }
      else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
    }
    const inner = html.slice(lt + 1, end)
    i = end + 1
    if (inner[0] === '/') {
      const name = inner.slice(1).trim().toLowerCase()
      let open: MarkupElement | null = current
      while (open && open !== root && open.tag !== name) open = open.parent
      if (!open || open === root) throw new Error(`Unmatched </${name}> in markup`)
      current = open.parent!
      continue
    }
    const name = (/^[^\s/>]+/.exec(inner)?.[0] ?? '').toLowerCase()
    const attrs: Record<string, string> = {}
    for (const m of inner.slice(name.length).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[m[1]] = decode(m[2] ?? m[3] ?? m[4] ?? '')
    }
    const el = new MarkupElement(name, attrs, current)
    current.children.push(el)
    if (RAW_TEXT.has(name)) {
      const close = html.indexOf(`</${name}`, i)
      const stop = close < 0 ? html.length : close
      if (stop > i) el.children.push(html.slice(i, stop))
      i = close < 0 ? html.length : html.indexOf('>', close) + 1
    } else if (!VOID.has(name) && !inner.endsWith('/')) current = el
  }
  return root
}

interface Compound {
  tag: string | null
  ids: string[]
  classes: string[]
  attrs: { name: string; op: string | null; value: string }[]
}

function parseSelector(selector: string): Compound[] {
  const chain: Compound[] = []
  let current: Compound | null = null
  const compound = (): Compound => {
    if (!current) {
      current = { tag: null, ids: [], classes: [], attrs: [] }
      chain.push(current)
    }
    return current
  }
  const s = selector.trim()
  let i = 0
  while (i < s.length) {
    const rest = s.slice(i)
    let m: RegExpExecArray | null
    if (/^\s/.test(rest)) {
      current = null
      i++
    } else if ((m = /^\[\s*([^\s~|^$*=\]]+)\s*(?:([\^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/.exec(rest))) {
      compound().attrs.push({ name: m[1], op: m[2] ?? null, value: m[3] ?? m[4] ?? m[5] ?? '' })
      i += m[0].length
    } else if ((m = /^([#.])([\w-]+)/.exec(rest))) {
      if (m[1] === '#') compound().ids.push(m[2])
      else compound().classes.push(m[2])
      i += m[0].length
    } else if ((m = /^(\*|[A-Za-z][\w-]*)/.exec(rest))) {
      compound().tag = m[1] === '*' ? null : m[1].toLowerCase()
      i += m[0].length
    } else throw new Error(`Unsupported selector: ${selector}`)
  }
  if (chain.length === 0) throw new Error('Empty selector')
  return chain
}

function matchesCompound(el: MarkupElement, c: Compound): boolean {
  if (c.tag && el.tag !== c.tag) return false
  if (c.ids.some((id) => el.attrs.id !== id)) return false
  if (c.classes.length) {
    const classes = (el.attrs.class ?? '').split(/\s+/)
    if (c.classes.some((name) => !classes.includes(name))) return false
  }
  return c.attrs.every(({ name, op, value }) => {
    const actual = el.attrs[name]
    if (actual === undefined) return false
    if (op === '=') return actual === value
    if (op === '^=') return actual.startsWith(value)
    if (op === '*=') return actual.includes(value)
    if (op === '$=') return actual.endsWith(value)
    return true
  })
}

/** The last compound matches the element; each earlier one matches some ancestor, in order. */
function matchesChain(el: MarkupElement, chain: Compound[]): boolean {
  if (!matchesCompound(el, chain[chain.length - 1])) return false
  let ancestor = el.parent
  for (let k = chain.length - 2; k >= 0; k--) {
    while (ancestor && ancestor.parent && !matchesCompound(ancestor, chain[k])) ancestor = ancestor.parent
    if (!ancestor || !ancestor.parent) return false
    ancestor = ancestor.parent
  }
  return true
}
