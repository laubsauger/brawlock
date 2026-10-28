import { afterEach, describe, expect, it } from 'vitest'
import { openChat, type ChatSpeaker } from '../../server/chat.mjs'
import { GLOBAL_CHAT_REPORTS_TO_HIDE, mergeGlobalChat, readGlobalChat, type GlobalChatLine, type GlobalChatRead } from './globalChat'

const origin = 'http://localhost:5352'
const embed = 'https://html-classic.itch.zone'
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })

function fixture() {
  const clock = { now: 1_000_000 }
  const people = new Map<string, ChatSpeaker>()
  const inbox: { accountId: string; message: string }[] = []
  const chat = openChat(':memory:', { origin, secret: 'test-chat-secret', embeds: [embed], now: () => clock.now, waitMs: 50,
    speaker: async (request) => people.get(request.headers.get('cookie') ?? '') ?? null,
    feedback: { note: (accountId, message) => { inbox.push({ accountId, message }); return 'note' } } })
  cleanups.push(() => chat.close())
  const account = (id: string, name: string | null) => {
    people.set(`session=${id}`, { id, profile: name ? { name, color: 0x3fa7ff } : null })
    return `session=${id}`
  }
  const post = (path: string, cookie: string, body: unknown, headers: Record<string, string> = {}) => chat.handler(new Request(`${origin}${path}`, {
    method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'x-brawlock-client-ip': '10.0.0.1', ...headers }, body: JSON.stringify(body) }))
  const say = (cookie: string, text: string, region = 'eu') => post('/api/chat', cookie, { text, region })
  const report = (cookie: string, id: number) => post('/api/chat/report', cookie, { id })
  const read = async (query = '', headers: Record<string, string> = {}) => {
    const response = await chat.handler(new Request(`${origin}/api/chat${query}`, { headers: { 'x-brawlock-client-ip': '10.0.0.9', ...headers } }))
    return { response, body: readGlobalChat(await response.json()) }
  }
  const since = (r: GlobalChatRead, after: number) => `?epoch=${r.epoch}&after=${after}&v=${r.version}`
  const admin = async (body?: unknown) => (await chat.admin(new Request(`${origin}/api/admin/chat`,
    body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json()
  return { clock, account, post, say, report, read, since, admin, inbox }
}

describe('global chat service', () => {
  it('posts under the account name from the session, with an opaque sender instead of the account id', async () => {
    const t = fixture()
    // Guests read along; posting needs an account with a claimed name, so nobody can post as someone else.
    expect((await t.say('', 'hi')).status).toBe(401)
    expect((await t.say(t.account('acct-nameless', null), 'hi')).status).toBe(403)
    const flame = t.account('acct-flame-0001', 'Flame')
    const sent = await t.say(flame, '  gg   everyone ')
    expect(sent.status).toBe(201)
    const raw = await sent.text()
    expect(raw).not.toContain('acct-flame-0001')
    const { body } = await t.read()
    expect(body?.full).toBe(true)
    expect(body?.lines).toEqual([expect.objectContaining({ id: 1, name: 'Flame', color: 0x3fa7ff, region: 'eu', text: 'gg everyone' })])
    expect(body?.lines[0].sender).toMatch(/^[0-9a-f]{16}$/)
    expect((await t.say(flame, 'hi', 'mars')).status).toBe(400)
  })

  it('holds a read until the next message and then sends only what is new', async () => {
    const t = fixture()
    const ash = t.account('acct-ash-00001', 'Ash')
    await t.say(ash, 'first')
    const first = (await t.read()).body!
    const held = t.read(t.since(first, 1))
    await t.say(ash, 'second')
    const next = (await held).body!
    expect(next.full).toBe(false)
    expect(next.lines.map((line) => line.text)).toEqual(['second'])
    // Nothing new: the read answers empty after the wait instead of hanging.
    const quiet = (await t.read(t.since(next, 2))).body!
    expect(quiet.lines).toEqual([])
    expect(quiet.version).toBe(next.version)
  })

  it(`hides a line for everyone once ${GLOBAL_CHAT_REPORTS_TO_HIDE} different accounts report it; the inbox hears once`, async () => {
    const t = fixture()
    const troll = t.account('acct-troll-001', 'Troll')
    const [a, b, c] = ['acct-a-000001', 'acct-b-000001', 'acct-c-000001'].map((id, i) => t.account(id, `Reporter${i}`))
    await t.say(troll, 'something vile')
    const before = (await t.read()).body!
    expect((await t.report(troll, 1)).status).toBe(400)
    expect((await t.report(a, 1)).status).toBe(200)
    expect((await t.report(a, 1)).status).toBe(200) // the same reporter twice counts once
    expect((await t.report(b, 1)).status).toBe(200)
    expect((await t.read()).body!.lines).toHaveLength(1)
    expect((await t.report(c, 1)).status).toBe(200)
    expect((await t.read(t.since(before, 1))).body!.hidden).toEqual([1])
    expect((await t.read()).body!.lines).toEqual([])
    expect(t.inbox).toHaveLength(1)
    expect(t.inbox[0].message).toContain('something vile')
    // The operator can bring it back; clients that dropped it reload the whole channel.
    const [row] = (await t.admin()).reports
    expect(row).toMatchObject({ name: 'Troll', reports: 3, status: 'hidden' })
    await t.admin({ action: 'show', line: row.line })
    const shown = (await t.read(t.since(before, 1))).body!
    expect(shown.full).toBe(true)
    expect(shown.lines.map((line) => line.text)).toEqual(['something vile'])
  })

  it('an operator mute silences the account and removes its lines; a 24 hour mute ends by itself', async () => {
    const t = fixture()
    const spam = t.account('acct-spam-0001', 'Spammer')
    const judge = t.account('acct-judge-001', 'Judge')
    await t.say(spam, 'buy gold')
    await t.say(judge, 'please stop')
    await t.report(judge, 1)
    const [row] = (await t.admin()).reports
    await t.admin({ action: 'mute', line: row.line, hours: 24 })
    const refused = await t.say(spam, 'still here')
    expect(refused.status).toBe(403)
    expect((await refused.json()).until).toBe(t.clock.now + 24 * 3600_000)
    expect((await t.read()).body!.lines.map((line) => line.name)).toEqual(['Judge'])
    t.clock.now += 24 * 3600_000 + 1
    expect((await t.say(spam, 'back')).status).toBe(201)
    await t.admin({ action: 'mute', line: row.line, hours: null })
    expect(await (await t.say(spam, 'again')).json()).toMatchObject({ until: null })
    const { mutes } = await t.admin()
    expect(mutes).toEqual([expect.objectContaining({ name: 'Spammer', until: null })])
    await t.admin({ action: 'unmute', sender: mutes[0].sender })
    expect((await t.say(spam, 'sorry')).status).toBe(201)
  })

  it('limits how fast one account can post', async () => {
    const t = fixture()
    const fast = t.account('acct-fast-0001', 'Fast')
    for (const text of ['a', 'b', 'c']) expect((await t.say(fast, text)).status).toBe(201)
    expect((await t.say(fast, 'd')).status).toBe(429)
    t.clock.now += 5000
    expect((await t.say(fast, 'e')).status).toBe(201)
  })

  it('lets an embedded client (itch.io) read with CORS but never post', async () => {
    const t = fixture()
    const ash = t.account('acct-ash-00001', 'Ash')
    const { response } = await t.read('', { origin: embed })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(embed)
    expect((await t.read('', { origin: 'https://elsewhere.test' })).response.status).toBe(403)
    // A cross-site request never carries the session, so a post from the embed is refused outright.
    expect((await t.post('/api/chat', ash, { text: 'hi', region: 'eu' }, { origin: embed })).status).toBe(403)
    expect((await t.post('/api/chat/report', ash, { id: 1 }, { origin: embed })).status).toBe(403)
  })
})

describe('global chat client', () => {
  const line = (id: number, text = `line ${id}`): GlobalChatLine => ({ id, at: id, sender: '0123456789abcdef', name: 'Ash', color: null, region: 'eu', text })

  it('merges reads in id order without duplicates and drops hidden lines', () => {
    // An own line arrives from the send before the read that also carries it.
    const merged = mergeGlobalChat([line(1), line(3)], { full: false, lines: [line(2), line(3)], hidden: [1] })
    expect(merged.map((l) => l.id)).toEqual([2, 3])
    expect(mergeGlobalChat(merged, { full: true, lines: [line(1)], hidden: [] }).map((l) => l.id)).toEqual([1])
  })

  it('rejects a malformed answer instead of showing part of it', () => {
    const good = { epoch: '0a1b2c3d', version: 2, full: true, lines: [line(1)], hidden: [] }
    expect(readGlobalChat(good)).not.toBeNull()
    expect(readGlobalChat({ ...good, lines: [{ ...line(1), sender: 'acct-flame-0001' }] })).toBeNull()
    expect(readGlobalChat({ ...good, lines: [{ ...line(1), text: '' }] })).toBeNull()
  })
})
