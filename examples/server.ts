/**
 * Runnable demo. Start it with:  npm run example
 *
 * Then, in another terminal, POST the same Idempotency-Key twice and watch
 * that only ONE order is actually created — the second call is replayed:
 *
 *   curl -s -XPOST localhost:3000/orders -H 'content-type: application/json' \
 *        -H 'idempotency-key: abc-123' -d '{"item":"book"}'
 *   curl -s -XPOST localhost:3000/orders -H 'content-type: application/json' \
 *        -H 'idempotency-key: abc-123' -d '{"item":"book"}'   # replayed
 *
 *   curl -s localhost:3000/orders   # only one order exists
 */
import Fastify from 'fastify'
import idempotency from '../src/index.js'

const app = Fastify({ logger: true })

await app.register(idempotency, { ttl: 60_000 })

interface Order {
  id: number
  item: string
}
const orders: Order[] = []

app.post<{ Body: { item: string } }>('/orders', async (req, reply) => {
  const order: Order = { id: orders.length + 1, item: req.body.item }
  orders.push(order) // the side effect we never want to duplicate
  reply.code(201)
  return order
})

app.get('/orders', async () => orders)

await app.listen({ port: 3000 })
