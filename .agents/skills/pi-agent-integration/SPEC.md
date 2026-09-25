# Pi Agent Integration Specification

## Intent

This skill helps agents implement and review the latest published `@earendil-works/pi-agent-core` API without adding avoidable wrapper behavior.

It is Pi integration guidance. It is not product documentation for a consuming app. It must distinguish declared API shape, implemented behavior, and unreleased upstream design.

## Scope

In scope:

- Pi `Agent` setup, streaming, queueing, continuation, abort, state, and turn hooks.
- Low-level agent loop APIs.
- `streamFn`, `streamProxy`, provider request hooks, and failure contracts.
- Tool execution, progress, result metadata, ordering, and termination.
- Current `AgentHarness` readiness and declared surface.
- Session, repository, environment, skill, prompt-template, compaction, search, and helper APIs.
- Known published defects and source-backed workarounds.

Out of scope:

- Consuming-product runtime policy, chat behavior, telemetry, or storage contracts.
- Legacy migration guidance unless the user asks for it.
- Provider-specific model recommendations outside the Pi API surface.
- Treating unreleased design documents or `main` behavior as a published contract.

## Users And Trigger Context

- Primary users: agents that implement, debug, or review Pi integrations.
- Common requests: integrate Pi, wire `Agent`, stream text, debug `continue()`, execute tools, proxy model calls, add sessions, or assess `AgentHarness`.
- Should not trigger for generic LLM SDK use or product-specific behavior that does not clearly depend on Pi.

## Runtime Contract

- First action: classify the request and load only the routed references it needs.
- Required output: guidance, edits, or findings grounded in npm `latest` and published implementation behavior.
- Required distinction: published contract, current implementation readiness, and unreleased upstream evidence.
- Non-negotiable constraints: keep guidance Pi-only, target npm `latest`, and avoid compatibility shims unless requested.
- Expected files: `SKILL.md` plus one or more direct `references/*.md` leaves.

## Source And Evidence Model

Authoritative sources:

- npm metadata for `@earendil-works/pi-agent-core`
- latest published package manifest, README, declarations, and implementation

Useful supporting sources:

- upstream changelog, tests, source, and design documents
- in-repo Pi consumers and validation results
- issue and pull request history for defects and migration changes

Use upstream `main` to find future changes and known defects. Do not use it to override the published contract.

Do not store secrets, customer data, private application identifiers, or unrelated consuming-product contracts.

## Reference Architecture

- `SKILL.md` contains routing, universal guardrails, implementation rules, verification, and version discipline.
- `references/api-surface.md` contains core `Agent`, loop, tool, stream, and proxy contracts.
- `references/common-use-cases.md` contains consumer task guidance.
- `references/harness.md` contains current harness readiness, sessions, and helper guidance.
- `references/troubleshooting-workarounds.md` contains failure diagnosis and workarounds.
- `SOURCES.md` contains provenance, decisions, coverage, triggers, and open gaps.
- `scripts/` and `assets/` are unused.

## Validation

- Run the repository skill validator after artifact changes.
- Confirm each runtime reference is routed directly from `SKILL.md`.
- Confirm files use skill-root-relative paths and contain no host-specific paths.
- Confirm the package identity, npm latest version, Node engine, exports, public types, and implementation status.
- Confirm streaming, continuation, queues, tools, loop signatures, proxy limitations, and harness readiness against the published package.
- Confirm trigger language covers Pi tasks and rejects generic SDK or unrelated product tasks.

## Known Limitations

- The skill follows npm `latest` and can become stale after any Pi release.
- `AgentHarness` is changing quickly. Every harness task needs a fresh implementation check.
- Upstream fixes can exist on `main` before npm publishes them.

## Maintenance Notes

- Update `SKILL.md` when triggers, universal guardrails, or readiness defaults change.
- Update the focused reference that owns an API or failure change.
- Update `SOURCES.md` for each package baseline, major decision, known gap, and validation result.
- Update this specification when scope, evidence rules, reference architecture, or acceptance gates change.
