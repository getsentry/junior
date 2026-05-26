# Spec Index

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-05-26

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Added canonical agent execution discipline spec.
- 2026-03-05: Added canonical session resumability spec for multi-slice serverless execution.
- 2026-03-06: Added canonical sandbox snapshot lifecycle spec.
- 2026-03-21: Added canonical chat architecture spec.
- 2026-04-15: Added canonical Slack agent delivery spec.
- 2026-04-16: Added canonical Slack write contract spec.
- 2026-04-28: Added canonical agent prompt spec.
- 2026-05-06: Added draft advisor tool spec.
- 2026-05-13: Added ownership map for chat, agent session, and Slack delivery specs.
- 2026-05-18: Added draft scheduler spec for scheduled Junior tasks.
- 2026-05-26: Added draft trusted plugin heartbeat spec for scheduler packaging.

## Status

Active

## Purpose

Define spec taxonomy, naming conventions, and canonical source-of-truth documents for Junior.

## Template

- New specs must start from `specs/templates/spec-template.md`.
- Required metadata/changelog fields are enforced by `specs/AGENTS.md`.

## Taxonomy

- Canonical normative specs: implementation contracts that must match current runtime behavior.
- Policy specs: security and governance constraints (`*-policy.md`).
- Index specs: curated navigators for a domain (`index.md`).
- Archive specs: historical evaluations, completed trackers, and superseded design docs (`specs/archive/**`).
- Draft specs: proposed contracts that are not yet canonical runtime behavior.

## Naming Rules

- Normative specs use `*-spec.md`.
- Policy specs use `*-policy.md`.
- Domain indexes use `index.md`.
- Historical docs are moved to `specs/archive/` and must not be treated as canonical implementation contracts.

## Canonical Specs

- `specs/security-policy.md`
- `specs/chat-architecture-spec.md`
- `specs/slack-agent-delivery-spec.md`
- `specs/slack-outbound-contract-spec.md`
- `specs/skill-capabilities-spec.md`
- `specs/oauth-flows-spec.md`
- `specs/agent-prompt-spec.md`
- `specs/harness-agent-spec.md`
- `specs/agent-session-resumability-spec.md`
- `specs/agent-execution-spec.md`
- `specs/harness-tool-context-spec.md`
- `specs/plugin-spec.md`
- `specs/sandbox-snapshots-spec.md`
- `specs/providers/catalog-spec.md`
- `specs/logging/index.md`
- `specs/testing/index.md`

## Ownership Map

For chat/agent/Slack turn behavior:

- `specs/chat-architecture-spec.md` owns the end-to-end turn data flow, data authority map, and module boundaries.
- `specs/agent-session-resumability-spec.md` owns checkpoint schema, Pi session continuation, timeout callbacks, and slice lifecycle.
- `specs/slack-agent-delivery-spec.md` owns Slack entry surfaces, progress UX, continuation acknowledgements, and final reply delivery.
- `specs/slack-outbound-contract-spec.md` owns Slack API write formatting, file uploads, reactions, retries, and error mapping.

## Domain Indexes

- Logging: `specs/logging/index.md`
- Testing: `specs/testing/index.md`

## Draft Specs

- `specs/advisor-tool-spec.md`
- `specs/scheduler-spec.md`
- `specs/trusted-plugin-heartbeat-spec.md`

## Archive Policy

- Archive documents preserve historical context and decisions but are non-normative.
- If an archive and canonical spec conflict, canonical spec wins.
- New implementation changes must update canonical specs, not archive docs.
