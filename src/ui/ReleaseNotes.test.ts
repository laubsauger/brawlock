import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReleaseNotesButton, ReleaseNotesContent } from './ReleaseNotes'
import { currentRelease, readSeenRelease, releaseNotes, RELEASE_SEEN_KEY, rememberRelease, shouldAnnounceRelease, useReleaseNotes } from './lib/releaseNotes'

describe('release notes', () => {
  it('never asks first-time visitors to dismiss release notes', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    expect(shouldAnnounceRelease(readSeenRelease(storage))).toBe(false)
    rememberRelease(currentRelease.version, storage)
    expect(values.get(RELEASE_SEEN_KEY)).toBe(currentRelease.version)
    expect(shouldAnnounceRelease(readSeenRelease(storage))).toBe(false)
  })

  it('announces a changed release once for returning players, then remembers acknowledgement', () => {
    const values = new Map([[RELEASE_SEEN_KEY, releaseNotes[1].version]])
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    expect(shouldAnnounceRelease(readSeenRelease(storage))).toBe(true)
    rememberRelease(currentRelease.version, storage)
    expect(shouldAnnounceRelease(readSeenRelease(storage))).toBe(false)
  })

  it('keeps unavailable preference storage optional rather than blocking a first visit', () => {
    const storage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(readSeenRelease(null)).toBeNull()
    expect(shouldAnnounceRelease(readSeenRelease(storage))).toBe(false)
    expect(() => rememberRelease(currentRelease.version, storage)).not.toThrow()
  })

  it('offers a labeled current-version button and keeps earlier notes collapsed until requested', () => {
    const button = renderToStaticMarkup(createElement(ReleaseNotesButton))
    expect(button).toContain('What’s new')
    expect(button).toContain(`v${currentRelease.version}`)
    expect(button).toContain('data-testid="open-release-notes"')
    const html = renderToStaticMarkup(createElement(ReleaseNotesContent))
    expect(html).toContain(currentRelease.title)
    for (const release of releaseNotes) {
      expect(html).toContain(`Release v${release.version}`)
      expect(html).toContain(`dateTime="${release.releaseDate}"`)
      expect(html).toContain(release.title)
    }
    expect(html).toContain('Earlier releases')
    expect(html).not.toContain('<details open')
    expect(html).not.toMatch(/TODO|TBD|undefined/)
  })

  it('can be opened manually without changing the current game screen', () => {
    expect(useReleaseNotes.getState().open).toBe(false)
    useReleaseNotes.getState().show()
    expect(useReleaseNotes.getState().open).toBe(true)
    useReleaseNotes.getState().hide()
    expect(useReleaseNotes.getState().open).toBe(false)
  })
})
