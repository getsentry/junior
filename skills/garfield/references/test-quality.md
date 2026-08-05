# Test Quality Policy

## Intent

Tests should prove real contracts with the least brittle machinery. Prefer moving, narrowing, or deleting weak tests over adding low-fidelity coverage.

## Policy

- Name the distinct regression each proposed test would catch. Strengthen an existing higher-fidelity test before adding another test, and delete lower-fidelity duplicates that prove no separate contract.
- Use the highest-fidelity deterministic layer: end-to-end for user behavior, integration for wiring and external boundaries, component for cross-module contracts, unit for local invariants. Do not default to unit tests for product behavior.
- Use real modules, shared fixtures, in-memory adapters, test clients/servers, and protocol-level HTTP interception before mocks. Mock or fake one explicit boundary only.
- Treat broad module mocks, global `fetch` mocks, singleton seams, generic dependency bags, and production dependency parameters for local helpers as signs the test is in the wrong layer.
- Name harness ports for real boundaries: model replies, queue wakeups, state storage, HTTP, sandbox execution, external delivery.
- Assert outcomes, durable state, external payloads, or user-visible behavior. Do not assert internal calls, call counts, prompt prose, or implementation identifiers. Minimize logs, spans, Sentry events, metrics, analytics, tracing, and telemetry assertions; use them only when instrumentation output is the requested contract, and prefer spying on or capturing the real delivery path over mocking telemetry modules.
- Use representative data that would fail if the contract were miswired: non-null and plural fields, distinct identities, negative cases, or realistic boundary failures. Do not build an exhaustive branch matrix when one representative case proves the invariant.
- Centralize recurring setup in shared fixtures with narrow read-only inspection, such as outboxes or captured deliveries. Do not expose broad mutable internals.
- Reuse a shared deterministic multi-session harness for lock, retry, and concurrency contracts. Add bespoke raw-client polling or lock orchestration only when the contract is critical, simpler layers cannot prove it, and the maintenance cost is proportionate.
- When tests, fixtures, scripts, or boundary checks change, verify commands, coverage scripts, and generated test artifacts still point at the new names.
- Add tests only for requested behavior, existing contracts, real regressions, or realistic boundaries touched by the slice.
- Leave missing command execution to validation review and comment-only concerns to code-comments review.

## Exceptions

- Local fakes or module mocks are acceptable for one explicit boundary in a pure unit or component invariant when no shared adapter expresses the case clearly.
- Third-party SDK clients and nondeterministic system boundaries may be mocked when a protocol-level interceptor or shared test adapter is impractical.
