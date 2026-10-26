/**
 * Embed origins run the game client in a cross-site iframe (itch.io serves HTML games from
 * https://html-classic.itch.zone). They reach only the guest endpoints, with CORS and without
 * cookies: a request from one never carries or receives a session or browser-binding cookie.
 */
export function embedOrigins(list = []) {
  for (const value of list) {
    let url
    try { url = new URL(value) } catch { throw new Error('Embed origins must be exact HTTPS origins (HTTP localhost for development)') }
    if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
      throw new Error('Embed origins must be exact HTTPS origins (HTTP localhost for development)')
    }
  }
  return list
}

/** CORS headers for an accepted embed origin; the preflight adds methods, headers and max-age. */
export function embedCors(origin, preflight = false) {
  return {
    'access-control-allow-origin': origin, vary: 'Origin',
    ...(preflight ? { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' } : {}),
  }
}
