const CLIENT_KEY = 'brawlock.clientKey'
let tabKey: string | null = null
let controller: string | null = null

/** Unique to this document, including duplicated tabs with cloned sessionStorage. */
export function controllerKey(): string {
  return controller ??= crypto.randomUUID()
}

function randomKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

/** Per tab reconnect key, survives reloads; account control uses the document key above. */
export function clientKey(): string {
  if (tabKey) return tabKey
  try {
    let key = sessionStorage.getItem(CLIENT_KEY)
    if (!key) { key = randomKey(); sessionStorage.setItem(CLIENT_KEY, key) }
    return tabKey = key
  } catch {
    return tabKey = randomKey()
  }
}
