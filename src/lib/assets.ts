import { resolveAssetBase } from './assetBase'

// The root default also supports the existing standalone Node audio tools.
export const ASSET_BASE = resolveAssetBase(import.meta.env?.VITE_ASSET_BASE_URL, import.meta.env?.BASE_URL ?? '/')
export const assetUrl = (path: string): string => ASSET_BASE + path
