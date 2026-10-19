/** Media hosting is independent of the app path used by login, invites and updates. */
export function resolveAssetBase(configured: string | undefined, appBase: string): string {
  if (configured === undefined) return appBase
  let url: URL
  try { url = new URL(configured) } catch { throw new Error('VITE_ASSET_BASE_URL must be an absolute HTTPS directory URL ending in /') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !configured.endsWith('/') || url.href !== configured) {
    throw new Error('VITE_ASSET_BASE_URL must be an absolute HTTPS directory URL ending in /')
  }
  return configured
}
