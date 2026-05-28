import { createHash } from 'node:crypto'
import fp from 'fastify-plugin'
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify'
import { MemoryStore } from './store.js'
import type {
  CachedResponse,
  IdempotencyOptions,
  IdempotencyStore,
  StoredEntry,
} from './types.js'

const DEFAULT_TTL = 24 * 60 * 60 * 1000 // 24h

// Headers that describe the transport, not the payload. They must be
// recomputed per connection, so we never store or replay them.
const HOP_BY_HOP = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'date',
])

// Make the active key visible to later hooks (onSend/onError) and to handlers.
declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey?: string
  }
}

/** Stable fingerprint of the request that a key is bound to. */
function fingerprint(req: FastifyRequest): string {
  const body = req.body === undefined ? '' : JSON.stringify(req.body)
  return createHash('sha256').update(`${req.method}\n${req.url}\n${body}`).digest('hex')
}

/** Re-emit a previously captured response. */
function replay(reply: FastifyReply, cached: CachedResponse): void {
  reply.code(cached.statusCode)
  for (const [name, value] of Object.entries(cached.headers)) {
    if (value !== undefined) reply.header(name, value)
  }
  reply.header('idempotent-replayed', 'true')
  reply.send(cached.payload)
}

const idempotency: FastifyPluginCallback<IdempotencyOptions> = (fastify, opts, done) => {
  const headerName = (opts.headerName ?? 'idempotency-key').toLowerCase()
  const methods = new Set((opts.methods ?? ['POST', 'PATCH']).map((m) => m.toUpperCase()))
  const ttl = opts.ttl ?? DEFAULT_TTL
  const store: IdempotencyStore = opts.store ?? new MemoryStore()
  const enforceFingerprint = opts.enforceFingerprint ?? true
  const requireKey = opts.requireKey ?? false

  // preHandler runs AFTER body parsing & validation, so the body is available
  // to fingerprint. Sending a reply here short-circuits the route handler.
  fastify.addHook('preHandler', async (req, reply) => {
    if (!methods.has(req.method)) return

    const key = req.headers[headerName]
    if (typeof key !== 'string' || key.length === 0) {
      if (requireKey) reply.code(400).send({ error: `Missing ${headerName} header` })
      return
    }

    const reqFingerprint = fingerprint(req)
    const reservation: StoredEntry = { fingerprint: reqFingerprint, expiresAt: Date.now() + ttl }
    const existing = await store.reserve(key, reservation)

    if (!existing) {
      // We won the reservation: let the handler run, capture it in onSend.
      req.idempotencyKey = key
      return
    }

    if (enforceFingerprint && existing.fingerprint !== reqFingerprint) {
      reply.code(422).send({ error: 'Idempotency-Key reused with a different request payload' })
      return
    }
    if (!existing.response) {
      // Reserved but not finished: a concurrent retry is still in flight.
      reply.code(409).send({ error: 'A request with this Idempotency-Key is already in progress' })
      return
    }
    replay(reply, existing.response)
  })

  // onSend sees the serialized payload and the final status/headers.
  fastify.addHook('onSend', async (req, reply, payload) => {
    const key = req.idempotencyKey
    if (!key) return payload

    // Server errors stay retryable: drop the reservation, cache nothing.
    if (reply.statusCode >= 500) {
      await store.delete(key)
      return payload
    }

    const headers: CachedResponse['headers'] = {}
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value
    }
    const body = typeof payload === 'string' ? payload : payload == null ? '' : String(payload)
    const response: CachedResponse = { statusCode: reply.statusCode, headers, payload: body }
    await store.complete(key, {
      fingerprint: fingerprint(req),
      expiresAt: Date.now() + ttl,
      response,
    })
    return payload
  })

  // A thrown handler error never reaches onSend with our key intact, so
  // release the reservation here to keep the request retryable.
  fastify.addHook('onError', async (req) => {
    if (req.idempotencyKey) await store.delete(req.idempotencyKey)
  })

  done()
}

export default fp(idempotency, {
  fastify: '5.x',
  name: 'fastify-idempotency',
})

export { MemoryStore } from './store.js'
export type {
  CachedResponse,
  IdempotencyOptions,
  IdempotencyStore,
  MaybePromise,
  StoredEntry,
} from './types.js'
