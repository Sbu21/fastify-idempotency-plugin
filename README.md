# fastify-idempotency

A [Fastify](https://fastify.dev) plugin that makes **unsafe HTTP requests safe to retry** using
[`Idempotency-Key`](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) headers.

If a client sends the same `Idempotency-Key` twice — because of a flaky network, a double-click, or an
automatic retry — the handler runs **once**. The first response is cached and **replayed** for every
later request with that key. This is the mechanism Stripe, Shopify, and PayPal use to stop a retried
"create payment" call from charging a customer twice.

```ts
import Fastify from 'fastify'
import idempotency from 'fastify-idempotency'

const app = Fastify()
await app.register(idempotency)

app.post('/orders', async (req, reply) => {
  reply.code(201)
  return createOrder(req.body) // a side effect we never want to run twice
})
```

```http
POST /orders   Idempotency-Key: abc-123     ->  201 Created   (handler runs, response cached)
POST /orders   Idempotency-Key: abc-123     ->  201 Created   (replayed; handler NOT run)
                                                  idempotent-replayed: true
```

## Why

`GET`, `PUT`, and `DELETE` are idempotent by HTTP definition — repeating them is harmless. `POST` and
`PATCH` are **not**: retrying "create order" or "charge card" can duplicate the side effect. The client
can't safely retry a request whose response it never received, because it doesn't know whether the
server processed it. An idempotency key breaks that uncertainty: the client picks a unique key per
logical operation and reuses it on every retry, and the server guarantees the operation happens once.

## Install

```bash
npm install fastify-idempotency
```

Requires Fastify `^5`.

## Behaviour

For a guarded method (`POST`/`PATCH` by default) carrying an `Idempotency-Key` header:

| Situation | Result |
| --- | --- |
| First time the key is seen | Handler runs; response is captured and stored |
| Key seen again, same payload, handler finished | Stored response **replayed** with `idempotent-replayed: true` |
| Key seen again **while the first request is still running** | `409 Conflict` |
| Key reused with a **different** request payload | `422 Unprocessable Entity` |
| Handler threw / responded `5xx` | Nothing cached — the key stays retryable |
| No key header (or non-guarded method) | Plugin does nothing; request passes through |

## Options

```ts
await app.register(idempotency, {
  headerName: 'idempotency-key',    // header to read the key from
  methods: ['POST', 'PATCH'],       // methods to guard
  ttl: 24 * 60 * 60 * 1000,         // how long a record lives (ms)
  enforceFingerprint: true,         // 422 if a key is reused with a different body
  requireKey: false,                // 400 if a guarded request omits the key
  store: new MemoryStore(),         // pluggable persistence (see below)
})
```

## Custom storage (Redis, etc.)

The default `MemoryStore` is per-process. For multiple instances behind a load balancer, implement the
`IdempotencyStore` interface against shared storage. The only rule: **`reserve` must be atomic** so two
concurrent requests with the same key can't both win.

```ts
import type { IdempotencyStore, StoredEntry } from 'fastify-idempotency'

class RedisStore implements IdempotencyStore {
  constructor(private redis: Redis) {}

  async reserve(key: string, entry: StoredEntry) {
    // SET key value NX PX ttl  -> atomic "create if absent"
    const won = await this.redis.set(rk(key), JSON.stringify(entry), 'PX', ttl(entry), 'NX')
    if (won) return undefined
    const raw = await this.redis.get(rk(key))
    return raw ? (JSON.parse(raw) as StoredEntry) : undefined
  }
  async complete(key: string, entry: StoredEntry) {
    await this.redis.set(rk(key), JSON.stringify(entry), 'PX', ttl(entry))
  }
  async delete(key: string) {
    await this.redis.del(rk(key))
  }
}
```

## Try it

```bash
npm install
npm run example       # starts a demo server on :3000
npm test              # 9 tests covering replay, 409, 422, TTL, 5xx, pass-through
```

See [`DOCUMENTATION.md`](./DOCUMENTATION.md) for a full explanation of how the plugin hooks into
Fastify's request lifecycle.

## License

MIT
