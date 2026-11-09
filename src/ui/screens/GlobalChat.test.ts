import { describe, expect, it } from 'vitest'
import { chatStamp } from './GlobalChat'

describe('global chat stamps', () => {
  // the service keeps the last 100 lines, so the channel can open on lines from days ago
  const now = new Date(2026, 10, 4, 12, 0).getTime()

  it('a line from today shows its time; one from before midnight shows its day, not a time that reads as today', () => {
    const early = chatStamp(new Date(2026, 10, 4, 0, 5).getTime(), now)
    const lateYesterday = chatStamp(new Date(2026, 10, 3, 23, 59).getTime(), now)
    expect(early.today).toBe(true)
    expect(lateYesterday.today).toBe(false)
    expect(lateYesterday.label).not.toBe(chatStamp(new Date(2026, 10, 4, 23, 59).getTime(), now).label)
  })
})
