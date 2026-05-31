## Context

Junior uses two related but distinct serialization mechanisms:

- Chat SDK `concurrency: "queue"` serializes live Slack webhook message handling per normalized thread key and provides queued/skipped messages to the next dispatched turn.
- Junior's state adapter locks are also used by resume callbacks so timeout/OAuth continuation does not run concurrently with a live thread handler.

These mechanisms are transport/runtime coordination. They are not the canonical agent session history. Durable recovery and Pi continuation are owned by `agent-session-resumability`.

Current implementation:

- configures production Chat SDK concurrency as `queue`
- sets queue entry TTL to `turnTimeoutMs + 60_000`
- wraps state adapter locks with a minimum active lock TTL and heartbeat for SDK-sized locks
- stops lock heartbeats on release/disconnect/force-release and after a bounded max age
- keeps caller-facing lock/queue identifiers unprefixed while applying storage key prefixes underneath
- rehydrates attachments after queue serialization
- treats user follow-up during awaiting timeout continuation as a retry/reschedule signal rather than a new active turn
- acquires the same thread lock for resumed Slack turns and returns lock-busy errors to callback handlers for retry/reschedule

## Goals / Non-Goals

**Goals:**

- Specify live Slack message queue and skipped-message preservation.
- Specify per-thread lock ownership, heartbeat, release, prefixing, and max-age behavior.
- Specify resume callback lock behavior at the coordination boundary.
- Keep queue/lock behavior separate from durable session log and Slack reply behavior.

**Non-Goals:**

- Defining a general workflow queue or durable job runner.
- Replacing timeout/auth session resumability.
- Specifying provider credential leases.
- Freezing exact retry delay values.
- Specifying Chat SDK internals beyond the behavior Junior depends on.

## Decisions

### Decision: Queue serializes live ingress, session log owns recovery

The queue prevents concurrent live message handlers and preserves skipped messages. It does not own turn recovery after timeouts, callbacks, or process loss. Recovery must reduce durable session/thread state.

Alternatives considered:

- Treat the queue as the durable turn workflow: rejected because queue entries are transport artifacts with TTL and serialization limitations.
- Ignore skipped messages and rely on Slack history: rejected because the Chat SDK already provides ordered skipped user input and ignoring it loses messages.

### Decision: Heartbeat SDK-sized locks but bound heartbeat lifetime

Long Junior turns can outlive short default lock TTLs, so SDK-sized active locks need heartbeat extension. The heartbeat must stop on release and after a bounded max age so abandoned locks eventually recover.

Alternatives considered:

- Use very long static locks for every lock: rejected because unrelated long-lived locks should use explicit TTL and not inherit turn heartbeat behavior.
- Do not heartbeat locks: rejected because long turns can lose ownership before completing.

### Decision: Resume handlers use the same logical thread lock

Timeout/OAuth resume paths must acquire the same thread lock as live handlers before reading/writing thread and session state. Lock-busy callbacks retry/reschedule rather than racing the live handler.

Alternatives considered:

- Let resume callbacks run without the live lock: rejected because they can race final delivery/state writes.
- Drop lock-busy callbacks immediately: rejected because callbacks are often scheduled while the live handler is still unwinding.

## Risks / Trade-offs

- [Risk] Queue and session-resume specs overlap. Mitigation: queue spec owns serialization/locks; session spec owns durable Pi/session lifecycle.
- [Risk] Lock heartbeat can hide stuck workers. Mitigation: heartbeat max age is bounded by turn timeout plus active lock TTL.
- [Risk] Queue serialization strips attachment fetchers. Mitigation: dispatcher rehydrates fetchers before runtime.
- [Risk] Exact Chat SDK queue semantics may change. Mitigation: local tests assert Junior's wrapper behavior and skipped-message consumption.

## Open Questions

- Should queue entry TTL be normative as `turnTimeoutMs + margin`, or only required to exceed maximum live turn duration?
- Should active lock heartbeat max age be configurable independently from turn timeout?
- Should resume lock-busy retry/reschedule live in this capability or remain entirely in `agent-session-resumability`?
- What queue max-size/drop behavior applies when a thread receives many messages during one long turn?
- Should Chat SDK queue entry serialization assumptions be captured in a local reference document?

## Migration Plan

1. Validate this OpenSpec change.
2. Review overlap with `agent-session-resumability` and `slack-ingress-routing`.
3. After acceptance, archive this capability into `openspec/specs/queue-and-locking/spec.md`.
4. Use the verification map to split skipped-message and queue tests from broader Slack behavior suites if useful.
