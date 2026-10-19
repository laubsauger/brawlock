import { afterEach, describe, expect, it } from 'vitest'
import { betterAuth } from 'better-auth'
import { testUtils } from 'better-auth/plugins'
import { accountOptions, openAccounts } from '../../server/accounts.mjs'
import { openTestDatabase, removeDir, tempDir } from '../../server/test-dir.mjs'

const origin = 'http://localhost:5352'
const secret = 'public-passkey-fixture-secret-0123456789abcdef'
const providers = { google: { clientId: 'test-client', clientSecret: 'test-provider-secret' } }
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.reverse()) close(); cleanups.length = 0 })

const bytes = (text: string) => new TextEncoder().encode(text)
const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => [...part]))
const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const hash = async (value: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', value))

// Small fixture encoder for the CBOR formats used by a WebAuthn "none" attestation.
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>
function cbor(value: Cbor): Uint8Array<ArrayBuffer> {
  const length = (major: number, n: number) => n < 24 ? Uint8Array.of(major * 32 + n)
    : n < 256 ? Uint8Array.of(major * 32 + 24, n) : Uint8Array.of(major * 32 + 25, n >> 8, n & 255)
  if (typeof value === 'number') return length(value < 0 ? 1 : 0, value < 0 ? -value - 1 : value)
  if (typeof value === 'string') return concat(length(3, bytes(value).length), bytes(value))
  if (value instanceof Uint8Array) return concat(length(2, value.length), value)
  return concat(length(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]))
}

async function fixture() {
  const dir = tempDir('brawlock-passkey-uv-')
  cleanups.push(() => removeDir(dir))
  const config = { file: `${dir}/accounts.sqlite`, origin, secret, providers }
  const accounts = await openAccounts({ ...config, migrate: true })
  cleanups.push(accounts.close)
  const db = openTestDatabase(config.file)
  cleanups.push(() => db.close())
  const options = accountOptions({ database: db, origin, secret, providers })
  const helper = betterAuth({ ...options, plugins: [...options.plugins ?? [], testUtils()] })
  const { test } = await helper.$context
  const user = test.createUser({ email: 'passkey@example.com', name: 'Passkey fixture' })
  await test.saveUser(user)
  const session = await test.login({ userId: user.id })
  const headers = new Headers(session.headers)
  headers.set('origin', origin)
  headers.set('content-type', 'application/json')
  const request = (path: string, body?: unknown) => accounts.handler(new Request(`${origin}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const captureChallenge = async (path: string) => {
    const response = await request(path)
    expect(response.status).toBe(200)
    const cookies = new Map((headers.get('cookie') ?? '').split('; ').filter(Boolean).map((value) => {
      const at = value.indexOf('=')
      return [value.slice(0, at), value.slice(at + 1)]
    }))
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]
      const at = pair.indexOf('=')
      cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '))
    return await response.json() as { challenge: string }
  }
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey)
  const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, unb64(jwk.x!)], [-3, unb64(jwk.y!)]]))
  const credential = crypto.getRandomValues(new Uint8Array(32))
  const rpHash = await hash(bytes('localhost'))
  const clientData = (type: string, challenge: string) => bytes(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  const register = async (verified: boolean) => {
    const { challenge } = await captureChallenge('/passkey/generate-register-options')
    const authData = concat(rpHash, Uint8Array.of(0x41 | (verified ? 4 : 0), 0, 0, 0, 0), new Uint8Array(16), Uint8Array.of(0, credential.length), credential, cose)
    return request('/passkey/verify-registration', { name: 'Fixture key', response: {
      id: b64(credential), rawId: b64(credential), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64(clientData('webauthn.create', challenge)), attestationObject: b64(cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'] },
    } })
  }
  const authenticate = async (verified: boolean, counter: number) => {
    const { challenge } = await captureChallenge('/passkey/generate-authenticate-options')
    const data = clientData('webauthn.get', challenge)
    const authData = concat(rpHash, Uint8Array.of(1 | (verified ? 4 : 0), 0, 0, 0, counter))
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, concat(authData, await hash(data))))
    // WebCrypto emits IEEE P1363; WebAuthn ES256 assertions carry ASN.1 DER.
    const integer = (n: Uint8Array) => {
      let start = 0
      while (start < n.length - 1 && n[start] === 0) start++
      const v = n.slice(start)
      const positive = v[0] & 0x80 ? concat(Uint8Array.of(0), v) : v
      return concat(Uint8Array.of(2, positive.length), positive)
    }
    const pair = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)))
    return request('/passkey/verify-authentication', { response: {
      id: b64(credential), rawId: b64(credential), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(concat(Uint8Array.of(0x30, pair.length), pair)), userHandle: b64(bytes(user.id)) },
    } })
  }
  return { register, authenticate, db, user }
}

describe('passkey user verification', () => {
  it('rejects a valid possession-only registration before storing its credential', async () => {
    const f = await fixture()
    const response = await f.register(false)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ message: 'Verify your identity with your passkey to continue.' })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM passkey').get()).toEqual({ n: 0 })
  })

  it('rejects a correctly signed assertion without UV, then accepts a verified assertion', async () => {
    const f = await fixture()
    expect((await f.register(true)).status).toBe(200)
    const sessions = f.db.prepare('SELECT COUNT(*) AS n FROM session').get()
    const rejected = await f.authenticate(false, 1)
    expect(rejected.status).toBe(401)
    expect(await rejected.json()).toMatchObject({ message: 'Verify your identity with your passkey to continue.' })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM session').get()).toEqual(sessions)
    expect(f.db.prepare('SELECT counter FROM passkey').get()).toEqual({ counter: 0 })
    const accepted = await f.authenticate(true, 2)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ user: { id: f.user.id } })
    expect(f.db.prepare('SELECT counter FROM passkey').get()).toEqual({ counter: 2 })
  })
})
