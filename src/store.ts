import type { IdempotencyStore, StoredEntry } from './types.js'

/**
 * Default in-memory store backed by a `Map`.
 *
 * `reserve` is a single synchronous check-and-set, so it is atomic with
 * respect to Node's event loop: no `await` can interleave between the
 * existence check and the write. Good for a single process or for tests;
 * swap in a Redis-backed store for multi-instance deployments.
 */
export class MemoryStore implements IdempotencyStore {
  private readonly entries = new Map<string, StoredEntry>()

  reserve(key: string, entry: StoredEntry): StoredEntry | undefined {
    const existing = this.entries.get(key)
    if (existing && existing.expiresAt > Date.now()) {
      return existing
    }
    // Free or expired: claim it for this request.
    this.entries.set(key, entry)
    return undefined
  }

  complete(key: string, entry: StoredEntry): void {
    this.entries.set(key, entry)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }
}
