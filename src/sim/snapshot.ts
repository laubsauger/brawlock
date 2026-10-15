/**
 * Determinism helpers: canonical hash and deep clone of plain-data SimState.
 */
import type { SimState } from './types'

/** Deep copy of plain data (objects, arrays, primitives). */
export function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) {
    const out = new Array(v.length)
    for (let i = 0; i < v.length; i++) out[i] = deepClone(v[i])
    return out as T
  }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object)) out[k] = deepClone((v as Record<string, unknown>)[k])
  return out as T
}

export function cloneState(state: SimState): SimState {
  return deepClone(state)
}

function num(n: number): string {
  if (n !== n) return 'NaN'
  if (n === 0) return '0' // +0 and -0 hash the same
  return String(n)
}

/** Canonical serialization: object keys sorted, undefined fields skipped. */
export function canonicalize(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  switch (typeof v) {
    case 'number':
      return num(v)
    case 'boolean':
      return v ? 'true' : 'false'
    case 'string':
      return JSON.stringify(v)
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']'
      const o = v as Record<string, unknown>
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(o[k])).join(',') + '}'
    }
    default:
      return 'null'
  }
}

/** 32-bit FNV-1a over the canonical serialization (UTF-16 code units). */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function hashState(state: SimState): number {
  return hashString(canonicalize(state))
}
