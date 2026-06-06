# SDK Reference

Source: https://vercel.com/docs/queues/sdk (Last updated March 5, 2026)

## Core interfaces

- Top-level helpers: `send`, `handleCallback`
- Push client: `QueueClient`
- Poll client: `PollingQueueClient`
- Node-style callback handler: `handleNodeCallback` (via `QueueClient` instance)

## Send options

`send(topic, payload, options)` options commonly used:
- `region`
- `retentionSeconds` (default 24h; min 60s; max 24h)
- `delaySeconds`
- `idempotencyKey`
- `headers`

`messageId` may be `null` when accepted for deferred processing.

## Push consumer behavior

Use `handleCallback(handler, { visibilityTimeoutSeconds, retry })`.

- SDK default visibility timeout: 5 minutes.
- SDK auto-extends visibility while handler is running.
- Retry callback return values:
  - `{ afterSeconds: number }`
  - `{ acknowledge: true }`
  - `undefined` (default retry behavior)

## Polling behavior

Use `PollingQueueClient({ region })` and call `receive(topic, consumerGroup, handler, options)`.

Common receive options:
- `limit` (default 1, max 10)
- `visibilityTimeoutSeconds`
- `messageId`

Treat `!result.ok && result.reason === "empty"` as a normal no-work result.

## Transports

`QueueClient` supports:
- `JsonTransport` (default)
- `BufferTransport`
- `StreamTransport`

Choose transport based on payload type and memory profile.
