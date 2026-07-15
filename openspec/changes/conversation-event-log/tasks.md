# Tasks

## 1. Event Contract And Pi Adapter

- [x] Define the runtime-schema-owned `ConversationEvent` envelope and event
      data union over only the existing ordered history kinds.
- [x] Isolate deterministic `ConversationEvent[] -> PiMessage[]` projection in
      the Pi-owned module.
- [x] Preserve message boundaries, provenance, context epochs, model binding,
      authorization observations, and bounded sequence projection.
- [x] Hard-cut storage writes and SQL rows to canonical events without changing
      API payloads or runtime behavior.
- [x] Restrict legacy `pi_message` to the bounded Redis/import and rolling-worker
      compatibility seams; never expose raw persistence data through the API.
- [x] Add focused adapter parity tests and update owning module documentation.

## 2. Canonical Event Writes

- [x] Use `(conversationId, seq)` as stable event identity and persist schema
      versions on every physical event row.
- [x] Persist Junior-owned message, tool, authorization, subagent, and context
      events through `ConversationEventStore`.
- [x] Rewrite legacy SQL message rows in bounded, retry-safe batches while a
      database-only compatibility view supports rolling old workers.
- [x] Keep Pi messages derived rather than separately persisted.
- [ ] Add turn outcome, delivery, and explicit turn-correlation event variants.

## 3. Event API And Dashboard

- [ ] Return one ordered, authorized, privacy-safe event array from conversation
      detail reporting.
- [ ] Move turn grouping, tool activity, failures, compactions, and delivery
      presentation into the dashboard client.
- [ ] Remove the parallel transcript, activity, and context-event API views once
      all consumers use events.

## 4. Child Conversations

- [ ] Add parent/root conversation lineage and parent turn/event correlation.
- [ ] Record subagent start and finish references without copying child events.
- [ ] Represent shared context with an immutable parent sequence fork point.
- [ ] Verify isolated and shared child Pi projections and inherited privacy.

## 5. Cleanup And Verification

- [ ] Make remaining visible-message and aggregate stores explicit read models.
- [ ] Remove obsolete transcript reconstruction and legacy compatibility after
      migration completion.
- [ ] Verify retention, purge, redaction, idempotency, replay parity, and event
      tree behavior.
- [ ] Move durable invariants into owning code and documentation, then delete
      this completed plan.
