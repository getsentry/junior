# Quickstart Reference

Source: https://vercel.com/docs/queues/quickstart (Last updated January 30, 2026)

## Baseline flow

1. Install SDK: `pnpm i @vercel/queue`
2. Link project and pull env for local auth:
`vc link` then `vc env pull`
3. Producer: call `send(topic, payload)` from server-side code.
4. Consumer: export `POST = handleCallback(async (message, metadata) => { ... })`.
5. Configure trigger in `vercel.json`:

```json
{
  "functions": {
    "app/api/queues/fulfill-order/route.ts": {
      "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "orders" }]
    }
  }
}
```

## Important behavior

- Triggered queue routes are private and invoked by Vercel queue infrastructure.
- Producers and consumers are decoupled by topic.
- Push consumers are invoked automatically after deployment.
