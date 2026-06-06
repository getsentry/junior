# Pi Agent Integration Specification

## Intent

This skill helps agents integrate the latest `@earendil-works/pi-agent-core` APIs into apps, libraries, runtimes, and harnesses without inventing avoidable wrapper behavior.

It is an integration-documentation skill, not product documentation for any consuming app.

## Scope

In scope:

- Pi `Agent` setup, streaming, queueing, continuation, abort, and state behavior.
- Pi low-level loop APIs.
- Pi `streamFn` and `streamProxy` integration.
- Pi tool execution, hooks, queue modes, and termination behavior.
- Pi `AgentHarness`, sessions, resources, skills, prompt templates, compaction, and environment interfaces.
- Troubleshooting based on published Pi package contracts.

Out of scope:

- Consuming-product-specific runtime policies, chat behavior, telemetry, or storage contracts.
- Legacy package migrations unless explicitly requested by the user.
- Provider-specific model recommendations outside the Pi API surface.

## Users And Trigger Context

- Primary users: agents implementing or reviewing Pi integrations.
- Common user requests: "integrate pi-agent-core", "wire Agent streaming", "debug continue()", "use AgentHarness", "fix Pi tool execution", "proxy Pi model calls".
- Should not trigger for generic LLM SDK usage, unrelated skill authoring, or product-specific behavior that does not mention or clearly depend on Pi.

## Runtime Contract

- Required first actions: classify the request and load only the routed reference files needed.
- Required outputs: implementation guidance, code edits, or review findings grounded in latest Pi package contracts.
- Non-negotiable constraints: keep guidance Pi-only, target npm `latest`, and do not add compatibility shims unless requested.
- Expected bundled files loaded at runtime: `SKILL.md` plus one or more direct `references/*.md` files.

## Source And Evidence Model

Authoritative sources:

- npm metadata for `@earendil-works/pi-agent-core`
- latest published package README
- latest published package declarations
- latest published package implementation files when declarations are ambiguous

Useful improvement sources:

- upstream Pi repository tests and changelog, when available
- concrete failure reports from Pi integrations
- validation results from skill updates

Data that must not be stored:

- secrets
- customer data
- private application URLs or identifiers
- consuming-product-specific internal contracts unless the user explicitly asks for that scope

## Reference Architecture

- `SKILL.md` contains routing, guardrails, minimal implementation rules, verification, and version discipline.
- `references/` contains focused lookup leaves for API surface, common use cases, harness use, and troubleshooting.
- `SOURCES.md` contains source inventory, decisions, coverage, trigger quality notes, and gaps.
- `scripts/` and `assets/` are unused.

## Validation

- Lightweight validation: run the skill structural validator after artifact changes.
- Deeper validation: manually confirm every runtime reference is directly routed from `SKILL.md`, avoids host-specific paths, and changes an agent decision or verification step.
- Acceptance gates: package identity is current, no consuming-product-specific guidance remains, latest-only stance is explicit, and `continue()`/stream/tool/harness contracts match published Pi sources.

## Known Limitations

- The skill intentionally follows npm `latest`; it may need refresh when Pi publishes a new latest version.
- The skill is intentionally example-light until stable upstream examples or tests are captured as evidence.

## Maintenance Notes

- Update `SKILL.md` when trigger scope, routing, guardrails, or verification gates change.
- Update `references/*.md` when the Pi API behavior changes.
- Update `SOURCES.md` when source baselines, decisions, coverage, or gaps change.
- Update `SPEC.md` when scope, evidence policy, reference architecture, or validation expectations change.
