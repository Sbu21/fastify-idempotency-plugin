import { setTimeout as sleep } from 'node:timers/promises'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import idempotency, { type IdempotencyOptions } from '../src/index.js'

let app: FastifyInstance

afterEach(async () => {
  await app?.close()
})

/** Build an app whose POST /orders handler counts how many times it ran. */
async function buildApp(opts: IdempotencyOptions = {}) {
  let calls = 0
  app = Fastify()
  await app.register(idempotency, opts)
  app.post('/orders', async (req) => {
    calls += 1
    return { id: calls, body: req.body }
  })
  app.get('/orders', async () => {
    calls += 1
    return { id: calls }
  })
  return { calls: () => calls }
}

describe('fastify-idempotency', () => {
  it('runs the handler once and replays the cached response on retry', async () => {
    const { calls } = await buildApp()
    const headers = { 'idempotency-key': 'key-1' }
    const payload = { item: 'book' }

    const first = await app.inject({ method: 'POST', url: '/orders', headers, payload })
    const second = await app.inject({ method: 'POST', url: '/orders', headers, payload })

    expect(calls()).toBe(1)
    expect(first.json()).toEqual(second.json())
    expect(first.headers['idempotent-replayed']).toBeUndefined()
    expect(second.headers['idempotent-replayed']).toBe('true')
  })

  it('runs the handler again for a different key', async () => {
    const { calls } = await buildApp()
    const payload = { item: 'book' }

    await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': 'a' }, payload })
    await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': 'b' }, payload })

    expect(calls()).toBe(2)
  })

  it('passes through (runs every time) when no key header is present', async () => {
    const { calls } = await buildApp()

    await app.inject({ method: 'POST', url: '/orders', payload: { item: 'book' } })
    await app.inject({ method: 'POST', url: '/orders', payload: { item: 'book' } })

    expect(calls()).toBe(2)
  })

  it('rejects with 422 when a key is reused with a different payload', async () => {
    await buildApp()
    const headers = { 'idempotency-key': 'key-2' }

    await app.inject({ method: 'POST', url: '/orders', headers, payload: { item: 'book' } })
    const conflict = await app.inject({ method: 'POST', url: '/orders', headers, payload: { item: 'pen' } })

    expect(conflict.statusCode).toBe(422)
  })

  it('returns 409 while a request with the same key is still in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    app = Fastify()
    await app.register(idempotency)
    app.post('/slow', async () => {
      await gate
      return { ok: true }
    })

    const headers = { 'idempotency-key': 'key-3' }
    const inFlight = app.inject({ method: 'POST', url: '/slow', headers, payload: {} })
    // Let the first request reach (and pass) the reservation step.
    await sleep(20)
    const concurrent = await app.inject({ method: 'POST', url: '/slow', headers, payload: {} })

    expect(concurrent.statusCode).toBe(409)

    release()
    const finished = await inFlight
    expect(finished.statusCode).toBe(200)
  })

  it('treats an expired record as gone and re-runs the handler', async () => {
    const { calls } = await buildApp({ ttl: 30 })
    const headers = { 'idempotency-key': 'key-4' }
    const payload = { item: 'book' }

    await app.inject({ method: 'POST', url: '/orders', headers, payload })
    await sleep(60)
    await app.inject({ method: 'POST', url: '/orders', headers, payload })

    expect(calls()).toBe(2)
  })

  it('does not cache server errors, so the client can retry', async () => {
    let calls = 0
    app = Fastify()
    await app.register(idempotency)
    app.post('/flaky', async () => {
      calls += 1
      if (calls === 1) throw new Error('transient failure')
      return { ok: true }
    })

    const headers = { 'idempotency-key': 'key-5' }
    const failed = await app.inject({ method: 'POST', url: '/flaky', headers, payload: {} })
    const retried = await app.inject({ method: 'POST', url: '/flaky', headers, payload: {} })

    expect(failed.statusCode).toBe(500)
    expect(retried.statusCode).toBe(200)
    expect(retried.headers['idempotent-replayed']).toBeUndefined()
  })

  it('ignores methods outside the guarded set', async () => {
    const { calls } = await buildApp()
    const headers = { 'idempotency-key': 'key-6' }

    await app.inject({ method: 'GET', url: '/orders', headers })
    await app.inject({ method: 'GET', url: '/orders', headers })

    expect(calls()).toBe(2)
  })

  it('rejects with 400 when requireKey is on and the header is missing', async () => {
    await buildApp({ requireKey: true })

    const res = await app.inject({ method: 'POST', url: '/orders', payload: { item: 'book' } })

    expect(res.statusCode).toBe(400)
  })
})
