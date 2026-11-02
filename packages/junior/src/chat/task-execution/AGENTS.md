# Task Execution

- A queue message only tells a worker to check for work. Do not put work or
  authority in queue payloads.
- The Conversation lease is the only owner of queue-driven execution. Never
  run one Conversation in parallel.
- `turn-cursor.ts` is private to this module. Use `checkpoint.ts`.
- Dispatch and Agent invocation ids come from mailbox metadata, then the
  checkpoint. Never from the queue payload, the Conversation Source, or
  Conversation id patterns.
- Child work without a Destination gets its authority from its stored Agent
  invocation.
- A web Turn drains steered web messages only from the Turn Actor.
- Dispatch projection updates take the dispatch lock only while they hold the
  Conversation lease. Lock order stays one-way.
- Heartbeats repair missing wakes and abandoned leases. Do not make them a
  second scheduler for healthy work.
- OAuth callbacks never run the agent or write agent history.
- Runtime status is `paused`. The SQL label `awaiting_resume` does not define
  execution state.
- `tests/integration/durable-queue.test.ts` uses the production
  `createConversationWork`. It may fake only model generation and Slack I/O.
