# Poll Mode Reference

Source: https://vercel.com/docs/queues/poll-mode (Last updated March 5, 2026)

## When poll mode fits

- Scheduled/cron batch processing
- Client-driven pull workflows
- Rate-controlled downstream integrations
- Mixed delivery with push and poll on same topic

## Required setup

Use `PollingQueueClient` with explicit region:

```ts
import { PollingQueueClient } from "@vercel/queue";

const queue = new PollingQueueClient({ region: process.env.QUEUE_REGION! });
export const { send, receive } = queue;
```

Region is required because messages can only be consumed in the region they were sent to.

## Receive behavior

`receive(topic, consumerGroup, handler, options)`:
- auto-ack on successful handler completion
- retry on thrown errors
- options include `limit`, `visibilityTimeoutSeconds`, and `messageId`

Handle empty queue as normal control flow:
- `!result.ok && result.reason === "empty"`

## Mixed mode

Push and poll can coexist on the same queue.
Each consumer group chooses its own delivery mode independently.
