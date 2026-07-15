# Canonical Conversation Event Log

## Summary

Make one ordered, append-only Junior conversation event log the canonical
history for model context, operator history, delivery facts, and child-agent
lineage. Pi and the dashboard consume separate projections of the same events.

## Motivation

Before this change, Junior reconstructed related views from agent steps, delivered
messages, turn-session records, activity records, and context events. Pi needs
an exact model context, while the dashboard needs chronological operational
history. Treating both as variants of one transcript makes failures difficult
to correlate and encourages duplicate message representations.

The pre-cutover store persisted ordered agent steps and filtered host-only steps
out of Pi context. This change makes that event boundary explicit and extends it
rather than creating another transcript or lifecycle sidecar.

## Design

`ConversationEvent` is the canonical persisted history contract. Every event
has stable conversation ordering, a timestamp, and a versioned payload. The
first slice formalizes only the durable event kinds Junior already stores; turn
lifecycle, delivery, correlation, and lineage variants are added with their
own write boundaries in later slices.

The storage cutover rewrites existing `pi_message` rows into Junior-owned
`message` events. Their opaque continuity payload is interpreted as a Pi
message only by the Pi adapter; Pi no longer owns the persisted event contract.

Two primary adapters consume the log:

- the Pi adapter selects model-relevant events and deterministically produces
  `PiMessage[]`;
- the conversation detail API projects persistence events into a separate
  Junior-owned, authorized, redacted reporting-event contract, and the
  dashboard builds its own timeline presentation from that safe contract.

The raw persistence union is never an API or dashboard contract. In particular,
legacy Pi roles, provider fields, and permissive message payloads do not cross
the reporting boundary merely because they are readable during migration.

Conversation list/search tables may remain materialized read models. Queue
wakeups, leases, resumability cursors, and credentials remain mutable control
state rather than conversation history.

Subagents use independent conversation streams in the same event system. Child
conversation metadata records parent/root lineage and a shared-context fork
point when needed. Parent events reference child execution without copying the
child event stream.

## Rollout

1. Formalize the event contract, isolate Pi projection, rename the physical
   table, persist schema versions, and cut every application reader and writer
   over to canonical Junior events.
2. Rewrite legacy SQL message rows in bounded batches. A database-only view
   translates old worker reads and writes during the rolling-deploy window; it
   stores no duplicate rows and is removed in the next release.
3. Expose privacy-safe events from the detail API and move timeline shaping to
   the dashboard.
4. Add child-conversation lineage and context-fork projection.
5. Remove obsolete transcript reconstruction and demote remaining message
   stores to explicit read models.

## Non-Goals

- Event-sourcing queue leases, credentials, or other mutable control state.
- Sending delivery, retry, failure, or provider diagnostics into Pi context.
- Copying child conversation events into parent conversations.
- Duplicating physical event rows or retaining parallel application stores.
- Persisting raw provider errors or private payloads as operational metadata.

## Compatibility

The in-place table rename preserves sequence identity and payload bytes. Old
workers remain compatible through the temporary SQL view while the application
uses only `junior_conversation_events`; the view and triggers are dropped after
the rolling-deploy window. Internal runtime and dashboard contracts may use
hard cutovers because their producers and consumers ship together.
