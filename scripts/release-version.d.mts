export interface ReleaseMetadata { version: string; releaseDate: string; tag: string }
export interface ReleaseNotes { version: string; releaseDate: string; title: string; changes: string[] }
export function releaseMetadata(pkg: { version?: unknown; releaseDate?: unknown }): ReleaseMetadata
export function readReleaseMetadata(root: string): ReleaseMetadata
export function validateReleaseNotes(notes: unknown, release: ReleaseMetadata): ReleaseNotes[]
export function readReleaseNotes(root: string, release?: ReleaseMetadata): ReleaseNotes[]
