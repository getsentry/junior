---
name: vercel-queues
description: Build and operate Vercel Queues with @vercel/queue across push and poll consumers. Use when users ask about "vercel queues", "@vercel/queue", "queue/v2beta", "handleCallback", "PollingQueueClient", "receive", queue retries, visibility timeouts, idempotency keys, or queue region routing.
---

Implement queue producers and consumers using Vercel Queues docs and SDK contracts.

## Step 1: Classify the request

Choose one path before writing code:

| Request type | Primary reference |
| --- | --- |
| First-time setup, minimal producer + consumer | `references/quickstart.md` |
| SDK usage, options, retries, transport behavior | `references/sdk.md` |
| API-level integration (custom clients, non-SDK consumers) | `references/api.md` |
| Delivery semantics and architecture decisions | `references/concepts.md` |
| Polling workers and mixed push/poll design | `references/poll-mode.md` |
| Local setup and debugging | `references/local-dev.md` |

If the task spans multiple categories, read only the relevant files above.

## Step 2: Apply core guardrails

1. Design consumers as idempotent because delivery is at-least-once.
2. Pick push mode by default on Vercel unless the task explicitly needs scheduled/batched/client-driven polling.
3. For poll mode, pin an explicit region and use the same region for send and receive.
4. Use bounded retry strategy for poison messages (`acknowledge: true` after threshold).
5. Keep topic and consumer names within `^[A-Za-z0-9_-]+$`.

## Step 3: Implement with minimal surface

1. Prefer top-level `send` and `handleCallback` for standard Vercel push mode.
2. Use `QueueClient` only when you need custom options (`transport`, `token`, `headers`, `deploymentId`).
3. Use `PollingQueueClient` for poll mode (`receive`) and handle `{ ok: false, reason: "empty" }` explicitly.
4. Keep `vercel.json` trigger mapping explicit and scoped to the consumer route.

## Step 4: Validate behavior

1. Verify producer returns `messageId` and treat nullable `messageId` as acceptable deferred acceptance.
2. Verify consumer behavior across success, retry, and poison-message paths.
3. Verify visibility timeout assumptions match workload duration.
4. Verify region assumptions in poll mode.

## Step 5: Troubleshoot from first principles

1. Authentication issues: check OIDC/token source and env loading.
2. Missing deliveries: verify topic name, trigger registration, and region alignment.
3. Duplicate processing: verify idempotency key strategy and consumer idempotency.
4. Backlog growth: inspect consumer throughput, retry policy, and visibility timeout.
