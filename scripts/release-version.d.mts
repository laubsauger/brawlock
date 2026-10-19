export interface ReleaseMetadata { version: string; releaseDate: string; tag: string }
export function releaseMetadata(pkg: { version?: unknown; releaseDate?: unknown }): ReleaseMetadata
export function readReleaseMetadata(root: string): ReleaseMetadata
