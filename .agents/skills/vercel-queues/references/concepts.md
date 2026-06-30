# Concepts Reference

Source: https://vercel.com/docs/queues/concepts (Last updated March 5, 2026)

## Core model

- Producers publish to topics.
- Consumer groups read independently from the same topic.
- Messages persist until acknowledged or expired.
- Delivery is at-least-once.

## Design implications

1. Build idempotent handlers.
2. Isolate workloads by consumer group instead of topic duplication when appropriate.
3. Use retries and visibility timeout as reliability controls, not application-level locks.
4. Expect occasional redelivery on failure boundaries.

## Push vs poll

- Push mode: Vercel invokes configured routes from `vercel.json`.
- Poll mode: application controls polling schedule and pace.

New poll consumer groups can start from beginning of non-expired history, enabling replay/backfill patterns.
