/** A value that a store may return synchronously or asynchronously. */
export type MaybePromise<T> = T | Promise<T>

/** A response captured from a completed handler, ready to be replayed. */
export interface CachedResponse {
  statusCode: number
  headers: Record<string, string | number | string[]>
  payload: string
}

/**
 * One record in the store, keyed by an Idempotency-Key.
 *
 * While a request is in flight the entry exists with `response` undefined
 * (a "reservation"). Once the handler finishes, `response` is filled in.
 */
export interface StoredEntry {
  /** sha256 of method + url + body, used to detect key reuse with a different payload. */
  fingerprint: string
  /** epoch milliseconds at which this entry should be treated as gone. */
  expiresAt: number
  /** the captured response; absent while the original request is still running. */
  response?: CachedResponse
}

/**
 * Pluggable persistence for idempotency records.
 *
 * `reserve` MUST be atomic (check-and-set in a single step) so that two
 * concurrent requests carrying the same key cannot both win the reservation.
 * The in-memory default achieves this trivially on Node's single thread; a
 * Redis implementation would use `SET key value NX PX ttl`.
 */
export interface IdempotencyStore {
  /**
   * Claim `key` for the current request if it is free (or expired).
   * @returns the existing entry if the key is already taken, otherwise `undefined`.
   */
  reserve(key: string, entry: StoredEntry): MaybePromise<StoredEntry | undefined>
  /** Overwrite the entry for `key` once the response is known. */
  complete(key: string, entry: StoredEntry): MaybePromise<void>
  /** Remove `key` (e.g. after a server error, so the client may retry). */
  delete(key: string): MaybePromise<void>
}

export interface IdempotencyOptions {
  /** Header to read the key from. Default: `idempotency-key`. */
  headerName?: string
  /** HTTP methods the plugin guards. Default: `['POST', 'PATCH']`. */
  methods?: string[]
  /** How long a record lives, in milliseconds. Default: 24h. */
  ttl?: number
  /** Persistence backend. Default: in-memory `MemoryStore`. */
  store?: IdempotencyStore
  /** Reject (422) if a key is reused with a different request payload. Default: true. */
  enforceFingerprint?: boolean
  /** Reject (400) guarded requests that omit the key. Default: false. */
  requireKey?: boolean
}
