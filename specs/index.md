# Spec Index

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-05-28

## Purpose

Define spec taxonomy, naming conventions, and canonical source-of-truth documents for Junior.

## Template

- New specs must start from `specs/spec-template.md`.
- Required metadata fields are enforced by `specs/AGENTS.md`.

## Taxonomy

- Canonical normative specs: active implementation contracts that must match current runtime behavior.
- Policy specs: security and governance constraints (`*-policy.md`).
- Archive specs: historical evaluations, completed trackers, and superseded design docs (`specs/archive/**`).

## Naming Rules

- Normative specs use concise kebab-case names. The `-spec` suffix is allowed but not required.
- Policy specs use `*-policy.md`.
- Historical docs are moved to `specs/archive/` and must not be treated as canonical implementation contracts.

## Available Docs

- `specs/security-policy.md`
- `specs/chat-architecture.md`
- `specs/agent-turn-handling.md`
- `specs/slack-agent-delivery.md`
- `specs/slack-outbound-contract.md`
- `specs/credential-injection.md`
- `specs/oauth-flows.md`
- `specs/agent-prompt.md`
- `specs/context-compaction.md`
- `specs/advisor-tool.md`
- `specs/scheduler.md`
- `specs/trusted-plugin-heartbeat.md`
- `specs/trusted-plugin-dispatch.md`
- `specs/harness-agent.md`
- `specs/agent-session-resumability.md`
- `specs/agent-execution.md`
- `specs/harness-tool-context.md`
- `specs/plugin.md`
- `specs/plugin-manifest.md`
- `specs/plugin-runtime.md`
- `specs/sandbox-snapshots.md`
- `specs/instrumentation.md`
- `specs/logging.md`
- `specs/tracing.md`
- `specs/otel-semantics.md`
- `specs/testing.md`
- `specs/unit-testing.md`
- `specs/integration-testing.md`
- `specs/eval-testing.md`
- `specs/slack-http-mocking.md`

## Ownership Map

OpenSpec backfill note:

- Active backfill changes under `openspec/changes/backfill-*` are review artifacts until archived into `openspec/specs/`.
- Existing `specs/*.md` files remain canonical for runtime work until the corresponding OpenSpec backfill is accepted and canonicalized.
- When an OpenSpec backfill is accepted, update this map before archiving or narrowing the superseded prose.

For chat/agent/Slack turn behavior:

- `specs/chat-architecture.md` owns the end-to-end turn data flow, data authority map, and module boundaries.
- `specs/agent-turn-handling.md` owns user-message response policy: when Junior answers, stays silent, asks, uses tools, satisfies Slack side effects, handles resumed turns, and considers a turn complete.
- `specs/agent-execution.md` owns coding-agent execution discipline and the repository-wide model-repairable tool failure contract.
- `specs/harness-agent.md` owns the Pi agent turn runtime contract, final output resolution, and turn diagnostics.
- `specs/harness-tool-context.md` owns context-bound tool targeting and missing-context failure behavior.
- `specs/agent-session-resumability.md` owns session record schema, Pi session continuation, timeout callbacks, and slice lifecycle.
- `specs/context-compaction.md` owns reusable Pi history compaction, internal context forks, and visible-thread compaction bounds.
- `specs/slack-agent-delivery.md` owns Slack entry surfaces, progress UX, continuation acknowledgements, and final reply delivery.
- `specs/slack-outbound-contract.md` owns Slack API write formatting, file uploads, reactions, retries, and error mapping.

For auth, credentials, and plugins:

- `specs/security-policy.md` owns global sandbox, credential, token, authorization-link privacy, and redaction invariants.
- `specs/credential-injection.md` owns requester-bound provider credential leasing and sandbox egress credential injection.
- `specs/oauth-flows.md` owns provider OAuth authorization-code flow, Slack private-link UX, callbacks, and auth resume behavior.
- `specs/plugin.md` owns the high-level plugin architecture for self-contained provider integrations.
- `specs/plugin-manifest.md` owns plugin manifest fields, validation, and compatibility rules.
- `specs/plugin-runtime.md` owns plugin discovery, loading, skills, MCP runtime, and provider activation.
- `specs/trusted-plugin-dispatch.md` owns durable trusted plugin agent dispatch.
- `specs/trusted-plugin-heartbeat.md` owns trusted plugin heartbeat and tool hook behavior.

For tools and runtime support:

- `specs/advisor-tool.md` owns provider-agnostic advisor/sub-agent tool behavior.
- `specs/scheduler.md` owns scheduled Junior tasks and run lifecycle.
- `specs/sandbox-snapshots.md` owns sandbox dependency snapshot behavior.

For observability:

- `specs/instrumentation.md` owns shared observability policy and the logging/tracing/semantics index.
- `specs/logging.md` owns structured log records, event names, log context, redaction, and console rendering.
- `specs/tracing.md` owns span boundaries, span names/ops, span attributes, and error/status semantics.
- `specs/otel-semantics.md` owns OpenTelemetry semantic attribute selection and `app.*` fallback naming.

For testing:

- `specs/testing.md` owns top-level test taxonomy and layer-selection rules.
- `specs/unit-testing.md` owns local deterministic unit-test boundaries.
- `specs/integration-testing.md` owns real-runtime integration-test boundaries and fake-agent seams.
- `specs/eval-testing.md` owns model/eval behavior tests and rubric boundaries.
- `specs/slack-http-mocking.md` owns Slack MSW fixtures, handlers, and HTTP request assertions.

## Archived Superseded Specs

- `specs/archive/provider-catalog.md` (superseded by `specs/plugin.md`)

## Archive Policy

- Archive documents preserve historical context and decisions but are non-normative.
- If an archive and canonical spec conflict, canonical spec wins.
- New implementation changes must update canonical specs, not archive docs.
