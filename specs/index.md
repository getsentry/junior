# Spec Index

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-03-06

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Added canonical agent execution discipline spec.
- 2026-03-05: Added canonical session resumability spec for multi-slice serverless execution.
- 2026-03-06: Added canonical sandbox snapshot lifecycle spec.


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

## Naming Rules

- Normative specs use `*-spec.md`.
- Policy specs use `*-policy.md`.
- Domain indexes use `index.md`.
- Historical docs are moved to `specs/archive/` and must not be treated as canonical implementation contracts.

## Canonical Specs

- `specs/security-policy.md`
- `specs/skill-capabilities-spec.md`
- `specs/oauth-flows-spec.md`
- `specs/harness-agent-spec.md`
- `specs/agent-session-resumability-spec.md`
- `specs/agent-execution-spec.md`
- `specs/harness-tool-context-spec.md`
- `specs/durable-workflows-spec.md`
- `specs/plugin-spec.md`
- `specs/sandbox-snapshots-spec.md`
- `specs/providers/catalog-spec.md`
- `specs/logging/index.md`
- `specs/testing/index.md`

## Domain Indexes

- Logging: `specs/logging/index.md`
- Testing: `specs/testing/index.md`

## Archive Policy

- Archive documents preserve historical context and decisions but are non-normative.
- If an archive and canonical spec conflict, canonical spec wins.
- New implementation changes must update canonical specs, not archive docs.
