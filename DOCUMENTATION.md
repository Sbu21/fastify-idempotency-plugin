# `fastify-idempotency` — Framework Extension Documentation

> **Assignment category (b):** an extension/plugin for an existing application framework.
> **Host framework:** [Fastify](https://fastify.dev) (v5), the Node.js web framework.
> **What the extension adds:** transparent, retry-safe request handling via `Idempotency-Key` headers.

This document is the **documentation deliverable (grade D)**. It explains the framework being extended,
the extension mechanism it exposes, how this plugin plugs into that mechanism, the public API, the design
decisions behind it, and how it is tested. The companion [`README.md`](./README.md) is the
user-facing quick start.

---

## 1. The problem the extension solves

HTTP methods split into two groups:

- **Idempotent** (`GET`, `PUT`, `DELETE`, `HEAD`): performing them once or many times leaves the server in
  the same state. A client can safely retry them.
- **Non-idempotent** (`POST`, `PATCH`): each call can produce a *new* side effect — a new order, a new
  charge, a new email.

The danger appears at the boundary of an unreliable network. A client sends `POST /payments`, the server
processes it and charges the card, but the **response is lost** on the way back (timeout, dropped
connection, mobile handoff). The client now faces an impossible question: *did it work?* If it retries, it
may charge the customer twice. If it doesn't, the payment may never be recorded.

The industry-standard fix — used by Stripe, Shopify, PayPal, and standardised in the IETF
`Idempotency-Key` header draft — is:

1. The client generates a unique key (e.g. a UUID) for each *logical* operation.
2. It sends that key in an `Idempotency-Key` header, and **reuses the same key on every retry**.
3. The server guarantees the operation executes **at most once per key**, and returns the *same* response
   for every retry.

`fastify-idempotency` implements step 3 as a reusable Fastify plugin, so application authors get this
guarantee without writing it into every route handler.

---

## 2. The host framework: Fastify

Fastify is a Node.js web framework focused on low overhead and a strong plugin model. Three of its design
features are what make this extension possible and are worth understanding:

### 2.1 Everything is a plugin

In Fastify there is no separate "middleware" concept bolted onto the side; **the application itself is a
tree of plugins**. You add functionality by writing a function with the signature
`(fastify, options, done)` (or an `async` version) and registering it:

```ts
app.register(myPlugin, { /* options */ })
```

Fastify calls that function, handing it a `fastify` instance to attach routes, hooks, and decorators to.
This is the extension point our plugin targets.

### 2.2 Encapsulation, and how to opt out of it

By default, anything a plugin adds (routes, hooks, decorators) is **encapsulated**: it is visible only to
that plugin and its children, not to siblings or the parent. This keeps large apps from leaking state
between feature modules.

But a *cross-cutting* concern like idempotency must apply to routes the user registers in the **parent**
scope. To break out of encapsulation, Fastify provides the `fastify-plugin` wrapper. Wrapping a plugin
with `fp(...)` tells Fastify "do not create a new encapsulation context — install my hooks into the scope
that registered me." This plugin uses exactly that:

```ts
export default fp(idempotency, { fastify: '5.x', name: 'fastify-idempotency' })
```

Without `fp`, the `preHandler`/`onSend`/`onError` hooks would only fire for routes defined *inside* the
plugin — useless for a guard that must wrap the host application's own routes.

### 2.3 The request lifecycle and hooks

Every Fastify request flows through an ordered series of **lifecycle hooks**. A plugin extends behaviour by
registering callbacks on these hooks. The ones relevant here, in execution order:

```
Incoming request
   │
   ├─ onRequest        (no body parsed yet)
   ├─ preParsing
   ├─ preValidation
   ├─ (body parsing + schema validation)
   ├─ preHandler   ◄── we read the key, fingerprint the body, look up / reserve, maybe replay
   │
   ├─ ROUTE HANDLER    (the side effect — skipped entirely if we replied in preHandler)
   │
   ├─ preSerialization
   ├─ onSend       ◄── we capture the final status/headers/body and store it
   │
   └─ Response sent
         │
         └─ onError  ◄── fires instead if the handler threw; we release the reservation
```

Two facts drive the whole design:

1. **`preHandler` runs *after* body parsing.** That is why the key lookup happens there and not in
   `onRequest`: we need the parsed body to fingerprint the request (see §4.3). Replying inside a
   `preHandler` hook short-circuits the lifecycle — Fastify skips the route handler entirely, which is
   precisely how a replay avoids re-running the side effect.
2. **`onSend` sees the *serialized* payload** plus the final status code and headers, which is exactly the
   snapshot we must store to replay later.

---

## 3. Architecture

The plugin is three files, intentionally small:

```
src/
├── index.ts   the plugin: lifecycle hooks + option handling + replay logic
├── store.ts   the default in-memory store (MemoryStore)
└── types.ts   the public contracts (IdempotencyStore, options, stored shapes)
```

### 3.1 The state machine of a key

Each `Idempotency-Key` moves through a small state machine, persisted as a `StoredEntry`:

```
                        reserve() succeeds
        (no entry) ───────────────────────────►  RESERVED (in flight)
            ▲                                       │   │
            │ ttl expiry / delete()                 │   │ handler finishes  -> complete()
            │                                        │   ▼
            │                                        │  COMPLETED (response cached)
            │             5xx / thrown               │   │
            └──────────── delete() ◄─────────────────┘   │ later request with same key
                                                          ▼
                                                      replay stored response
```

- A **reservation** is a `StoredEntry` whose `response` field is still `undefined`. Its existence is how a
  concurrent second request detects "already in progress" and returns `409`.
- **Completion** fills in the `response`. From then on, matching requests are replayed.
- A **server error** deletes the entry so the operation remains retryable — caching a `500` would
  permanently wedge the client.

### 3.2 The three hooks (in `src/index.ts`)

| Hook | Responsibility |
| --- | --- |
| `preHandler` | Skip non-guarded methods. Read the key. Compute the request fingerprint. Call `store.reserve`. Branch into: *proceed* (won the reservation), *replay* (completed entry), *409* (reservation still open), or *422* (fingerprint mismatch). |
| `onSend` | Only for requests that won a reservation this round. Capture status, headers (minus hop-by-hop), and serialized body; `store.complete`. If status ≥ 500, `store.delete` and cache nothing. |
| `onError` | A thrown handler bypasses a clean `onSend`; release the reservation with `store.delete` so the client can retry. |

The active key is threaded between hooks by decorating the request object (`req.idempotencyKey`), declared
through TypeScript module augmentation so it is fully typed for consumers.

---

## 4. Key design decisions and trade-offs

### 4.1 Why a pluggable store with an atomic `reserve`

The single subtle correctness problem is **concurrency**: two retries of the same operation can arrive at
the same instant. A naive `get`-then-`set` has a race — both requests read "absent" and both run the
handler, defeating the purpose. The fix is to make reservation a **single atomic check-and-set**, expressed
as one `reserve(key, entry)` method on the store:

- The in-memory default is atomic for free: Node runs JavaScript on one thread, and `reserve` performs its
  `Map.get`/`Map.set` with no intervening `await`, so no other request can interleave.
- A distributed store maps cleanly onto the same contract: Redis's `SET key val NX PX ttl` is an atomic
  "create if absent." The interface was deliberately shaped (`reserve` / `complete` / `delete`) so the
  abstraction matches what real backends offer, rather than the leaky `get`/`set` pair.

This keeps the plugin process-correct out of the box while leaving multi-instance deployments a clean
extension point (documented in the README).

### 4.2 Replaying responses faithfully — but not hop-by-hop headers

A replay must reproduce the original status, body, and content headers (e.g. `content-type`). It must
**not** replay *hop-by-hop* / transport headers (`content-length`, `transfer-encoding`, `connection`,
`date`), which describe one specific TCP exchange and are recomputed by Fastify per response. Storing and
re-sending them would corrupt the reply. The plugin filters these out at capture time. A diagnostic header
`idempotent-replayed: true` is added so clients and tests can tell a replay from a fresh response.

### 4.3 Fingerprinting to catch key misuse

The `Idempotency-Key` spec says a key identifies one specific request. If a client reuses a key with a
*different* body — almost always a bug — silently replaying the old response would hide it. The plugin
computes a `sha256` over `method + url + body` and, when `enforceFingerprint` is on (default), rejects a
mismatch with `422`. This is opt-out for users who want pure key-based semantics.

### 4.4 Never cache server errors

Responses with status ≥ 500 (or thrown exceptions) represent *transient* failures the client should be
able to retry. Caching them would turn a temporary blip into a permanent dead end for that key, so the
reservation is released instead. Client errors (`4xx`) **are** cached: they are deterministic given the
same input, so replaying them is correct and saves recomputation.

### 4.5 Scope kept deliberately small

In keeping with "minimum code that solves the problem," the plugin ships only an in-memory store and
documents Redis as an interface to implement, rather than bundling a Redis dependency. TTL is a simple
wall-clock expiry rather than a background sweeper. These are conscious scope choices appropriate to the
assignment, with the extension points clearly marked.

---

## 5. Public API reference

### `register(idempotency, options)`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `headerName` | `string` | `'idempotency-key'` | Header carrying the key. |
| `methods` | `string[]` | `['POST', 'PATCH']` | HTTP methods the plugin guards. |
| `ttl` | `number` (ms) | `86_400_000` (24h) | Lifetime of a stored record. |
| `enforceFingerprint` | `boolean` | `true` | Return `422` when a key is reused with a different payload. |
| `requireKey` | `boolean` | `false` | Return `400` when a guarded request omits the key. |
| `store` | `IdempotencyStore` | `new MemoryStore()` | Persistence backend. |

### `interface IdempotencyStore`

```ts
reserve(key: string, entry: StoredEntry): MaybePromise<StoredEntry | undefined>
complete(key: string, entry: StoredEntry): MaybePromise<void>
delete(key: string): MaybePromise<void>
```

`reserve` returns `undefined` when the caller won the reservation, or the existing entry when the key is
already taken. It **must** be atomic.

### Response codes the plugin can emit

| Code | When |
| --- | --- |
| `409 Conflict` | Same key, first request still in flight. |
| `422 Unprocessable Entity` | Same key, different request payload (when `enforceFingerprint`). |
| `400 Bad Request` | Guarded request missing the key (when `requireKey`). |
| *(replayed code)* | Any later matching request — the original status, plus `idempotent-replayed: true`. |

---

## 6. Testing strategy

Tests use Fastify's `app.inject()` — a built-in way to dispatch a fully-realised request through the entire
lifecycle **without opening a TCP socket**, which makes them fast and deterministic. The suite
(`test/idempotency.test.ts`, run with Vitest) covers every branch of the state machine:

| Test | Verifies |
| --- | --- |
| replay | Handler runs **once**; second response equals the first and carries `idempotent-replayed`. |
| different key | A new key re-runs the handler. |
| no header | Pass-through: handler runs on every call. |
| `422` reuse | Same key + different body is rejected. |
| `409` in flight | Concurrency: a handler is held open on a gate, a second request with the same key gets `409`. |
| TTL expiry | After `ttl` elapses the key is treated as gone and the handler re-runs. |
| `5xx` not cached | A thrown handler releases the reservation; the retry runs fresh. |
| non-guarded method | `GET` is ignored. |
| `requireKey` | Missing key yields `400` when required. |

```
✓ test/idempotency.test.ts (9 tests)
  Test Files  1 passed (1)
       Tests  9 passed (9)
```

The `409` test is the interesting one: it deliberately stalls the first handler on an unresolved promise,
fires a second request with the same key, asserts the `409`, then releases the gate and asserts the first
request completes with `200` — proving the reservation logic under genuine concurrency.

---

## 7. How to run it

```bash
npm install
npm test            # run the 9-test suite
npm run build       # emit dist/ (ESM + CJS + .d.ts types)
npm run example     # start the demo server on http://localhost:3000
```

Demo (two identical requests, one created order):

```bash
curl -XPOST localhost:3000/orders -H 'content-type: application/json' \
     -H 'idempotency-key: abc-123' -d '{"item":"book"}'   # -> 201 {"id":1,...}
curl -XPOST localhost:3000/orders -H 'content-type: application/json' \
     -H 'idempotency-key: abc-123' -d '{"item":"book"}'   # -> 201 {"id":1,...}  idempotent-replayed: true
curl     localhost:3000/orders                            # -> [{"id":1,"item":"book"}]  (only ONE order)
```

---

## 8. Limitations and possible extensions

- **Single process by default.** The in-memory store does not share state across instances; a Redis (or
  other shared) store implementing `IdempotencyStore` lifts this, and the `reserve` contract is already
  shaped for it.
- **No background eviction.** Expired entries are skipped on read but only the in-memory map's growth is
  unbounded until accessed; a production store (Redis with `PX`) evicts automatically.
- **Body fingerprint uses `JSON.stringify`.** Two semantically-equal bodies with different key ordering
  would fingerprint differently. A canonical-JSON pass would harden this.
- **Streamed/binary responses** are stored as their string form; very large or streaming responses are out
  of scope for this implementation.

These are intentional boundaries for an assignment-scoped extension, each with a clear path forward.
