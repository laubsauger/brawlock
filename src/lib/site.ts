/**
 * The first-party site (VITE_SITE_URL, e.g. https://brawlock.osc.link/) of a build hosted
 * elsewhere: itch.io runs this client from its own HTML host inside an iframe (docs/ITCH.md).
 * Unset for the first-party build, which reaches its services same-origin.
 */
export const SITE_URL: string | null = import.meta.env.VITE_SITE_URL || null

/** A first-party service path, resolved on the site for a build hosted elsewhere. */
export const siteApi = (path: string): string => (SITE_URL ? new URL(path, SITE_URL).href : path)

/** A request to the site from elsewhere is cross-site: no cookies go along. */
export const siteCredentials: RequestCredentials = SITE_URL ? 'omit' : 'same-origin'
