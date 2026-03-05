# API Reference

Source: https://vercel.com/docs/queues/api (Last updated March 5, 2026)

## Base URL and auth

- Region endpoint format: `https://{region}.vercel-queue.com/api/v3`
- Auth header: `Authorization: Bearer <vercel-oidc-token>`
- Optional deployment isolation header: `Vqs-Deployment-Id`

Messages are region-scoped: produce and consume in the same region.

## Naming rules

- Topic and consumer names must match: `^[A-Za-z0-9_-]+$`

## Primary endpoints

- SendMessage: `POST /api/v3/topic/{topic}`
- ReceiveMessages: `POST /api/v3/topic/{topic}/consumer/{consumer}`
- ReceiveMessageById: `POST /api/v3/topic/{topic}/consumer/{consumer}/id/{messageId}`
- AcknowledgeMessage: `DELETE /api/v3/topic/{topic}/consumer/{consumer}/lease/{receiptHandle}`
- ExtendLease: `PATCH /api/v3/topic/{topic}/consumer/{consumer}/lease/{receiptHandle}`

## Operational constraints

- TTL defaults to 24h (min 60s, max 24h)
- API visibility timeout defaults to 60s (max 3600s)
- Receive max messages per call: 10
- Idempotency dedup window tracks original message lifetime (up to TTL)

## Response and error notes

- Send may return `201 Created` with messageId or `202 Accepted` for deferred delivery.
- Receive may return `204 No Content` when empty.
- Concurrency/rate limit surfaces as `429`.
