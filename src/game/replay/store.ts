/**
 * Local replay library: IndexedDB in the browser (an in-memory fallback without it, and
 * for tests). Keeps the newest REPLAY_KEEP replays plus every pinned one (imports are
 * pinned). Values are the compressed `.brawlock` bytes with a small meta for lists.
 */
import { decodeReplay, encodeReplay, metaOf, replayFileName, type ReplayData, type ReplayMeta } from './format'

export const REPLAY_KEEP = 20

export interface StoredReplay {
  meta: ReplayMeta
  bytes: Uint8Array
}

export interface ReplayBackend {
  put(r: StoredReplay): Promise<void>
  get(id: string): Promise<StoredReplay | null>
  delete(id: string): Promise<void>
  list(): Promise<ReplayMeta[]>
}

export function memoryBackend(): ReplayBackend {
  const m = new Map<string, StoredReplay>()
  return {
    put: async (r) => void m.set(r.meta.id, { meta: { ...r.meta }, bytes: r.bytes }),
    get: async (id) => m.get(id) ?? null,
    delete: async (id) => void m.delete(id),
    list: async () => [...m.values()].map((r) => ({ ...r.meta })),
  }
}

const STORE = 'replays'

/** IndexedDB backend, or null where IndexedDB is unavailable (private mode, node). */
export function indexedDbBackend(name = 'brawlock-replays'): ReplayBackend | null {
  if (typeof indexedDB === 'undefined') return null
  let dbp: Promise<IDBDatabase> | null = null
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'meta.id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }))
  const tx = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db()
    return new Promise<T>((resolve, reject) => {
      const r = run(d.transaction(STORE, mode).objectStore(STORE))
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }
  return {
    put: async (r) => void (await tx('readwrite', (s) => s.put(r))),
    get: async (id) => ((await tx('readonly', (s) => s.get(id))) as StoredReplay | undefined) ?? null,
    delete: async (id) => void (await tx('readwrite', (s) => s.delete(id))),
    list: async () => ((await tx('readonly', (s) => s.getAll())) as StoredReplay[]).map((r) => r.meta),
  }
}

export class ReplayLibrary {
  private readonly backend: ReplayBackend
  private readonly listeners = new Set<() => void>()

  constructor(backend: ReplayBackend) {
    this.backend = backend
  }

  /** Notified after every save / delete / pin. Returns unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private changed(): void {
    for (const cb of this.listeners) cb()
  }

  async save(d: ReplayData, pinned = false): Promise<ReplayMeta> {
    const bytes = await encodeReplay(d)
    const meta = metaOf(d, bytes.length, pinned)
    await this.backend.put({ meta, bytes })
    await this.prune()
    this.changed()
    return meta
  }

  /** Newest first. */
  async list(): Promise<ReplayMeta[]> {
    try {
      return (await this.backend.list()).sort((a, b) => b.date - a.date)
    } catch {
      return []
    }
  }

  async has(id: string): Promise<boolean> {
    try {
      return (await this.backend.get(id)) !== null
    } catch {
      return false
    }
  }

  async load(id: string): Promise<ReplayData | null> {
    try {
      const r = await this.backend.get(id)
      return r ? await decodeReplay(r.bytes) : null
    } catch {
      return null
    }
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    const r = await this.backend.get(id)
    if (!r) return
    await this.backend.put({ meta: { ...r.meta, pinned }, bytes: r.bytes })
    if (!pinned) await this.prune()
    this.changed()
  }

  async remove(id: string): Promise<void> {
    await this.backend.delete(id)
    this.changed()
  }

  /** The `.brawlock` file for sharing. */
  async exportFile(id: string): Promise<{ name: string; bytes: Uint8Array } | null> {
    const r = await this.backend.get(id)
    return r ? { name: replayFileName(r.meta), bytes: r.bytes } : null
  }

  /** Add a shared `.brawlock` file (kept pinned). Null if the bytes are not a replay. */
  async importFile(bytes: Uint8Array): Promise<ReplayMeta | null> {
    const d = await decodeReplay(bytes)
    if (!d) return null
    return this.save(d, true)
  }

  /** Drop unpinned replays beyond the newest REPLAY_KEEP. */
  private async prune(): Promise<void> {
    const unpinned = (await this.backend.list()).filter((m) => !m.pinned).sort((a, b) => b.date - a.date)
    for (const m of unpinned.slice(REPLAY_KEEP)) await this.backend.delete(m.id)
  }
}

/** The app's replay library. */
export const replays = new ReplayLibrary(indexedDbBackend() ?? memoryBackend())
