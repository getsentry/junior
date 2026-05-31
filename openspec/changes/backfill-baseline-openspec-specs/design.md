## Context

Junior currently keeps canonical contracts in `specs/*.md`, with several strong documents for chat architecture, Slack delivery, agent sessions, prompt behavior, plugins, testing, and observability. OpenSpec is now available in the repository, but it has no baseline capability specs under `openspec/specs/`; current OpenSpec changes are new deltas rather than a backfilled capability catalog.

Existing eval and test files are useful coverage evidence, but their names and boundaries are historical. They must not define the future spec taxonomy. Each backfilled spec should start from product/runtime capability boundaries, then map current tests/evals to those boundaries.

## Goals / Non-Goals

**Goals:**

- Backfill a coherent baseline OpenSpec capability catalog for Junior.
- For every capability, inspect current code, existing specs, tests/evals, and relevant prior art before writing requirements.
- Record undefined behavior and open questions instead of silently turning assumptions into requirements.
- Produce OpenSpec-format requirements with scenarios, plus verification maps that classify coverage as unit, integration, or eval.
- Keep current canonical specs and OpenSpec artifacts aligned while backfilling.

**Non-Goals:**

- Rewriting all runtime behavior during the backfill.
- Treating existing eval file names as the desired capability taxonomy.
- Copying existing markdown specs verbatim into OpenSpec.
- Archiving existing canonical specs until a specific backfilled capability has been reviewed and accepted.

## Decisions

### Decision: Backfill by capability, not by existing file name

Each backfill change should define one capability or a tightly coupled capability group. The capability name should describe the product/runtime behavior, not the legacy doc or test file that inspired it.

Alternatives considered:

- One giant OpenSpec change for every baseline spec: rejected because review and validation would be too broad.
- Mirroring every file in `specs/`: rejected because some docs are architecture or policy indexes, while OpenSpec specs should be behavior capabilities.

### Decision: Use a fixed backfill worksheet for every spec

Each capability backfill must complete the same worksheet:

1. Current-source inventory: code, canonical specs, tests, evals, fixtures, package docs.
2. Prior-art review: platform docs, SDK docs, product norms, or established implementation patterns.
3. Behavior extraction: what is implemented, what is intended, what is only tested, and what is undocumented.
4. Undefined behavior and open questions.
5. OpenSpec requirements and scenarios.
6. Verification map.
7. Migration/update plan for canonical specs, indexes, and eval/test taxonomy.

Alternatives considered:

- Let each backfill author choose their own process: rejected because drift is the main risk.
- Require external research for every internal-only capability: rejected; prior art may be local source, library docs, or comparable repo patterns when external product docs do not exist.

### Decision: Treat tests/evals as coverage inventory

Existing evals and tests should be mapped to requirements, then deliberately kept, renamed, split, moved, replaced, or deleted. Backfill tasks must not claim a requirement is verified merely because a similarly named eval exists.

Alternatives considered:

- Preserve eval names for continuity: rejected because the user explicitly called out that current eval scope/names may be wrong.
- Rename all evals before specs: rejected because the spec taxonomy should drive the verification taxonomy.

### Decision: Keep open questions first-class

Every backfilled spec must include an "Open Questions / Undefined Behavior" section in its change design or companion notes. Open questions must be resolved, explicitly deferred, or represented as non-goals before the spec is archived into a canonical baseline.

Alternatives considered:

- Encode best guesses as requirements: rejected because this would overfit undocumented current behavior.
- Block all specs until all unknowns are resolved: rejected because some behavior can be specified while narrower questions remain tracked.

## Risks / Trade-offs

- [Risk] Backfill becomes a documentation-only exercise disconnected from code. -> Mitigation: require code/test/eval inventory and verification maps for every capability.
- [Risk] Current bugs get canonized as desired behavior. -> Mitigation: require prior-art and intent review, and list undefined behavior explicitly.
- [Risk] Scope explodes. -> Mitigation: each capability gets its own change or small grouped change; this meta-change only creates the task queue.
- [Risk] Existing specs and OpenSpec specs diverge. -> Mitigation: every backfill task includes index updates and canonical-spec alignment or an explicit deferral.
- [Risk] Evals remain misnamed or poorly scoped. -> Mitigation: every model-dependent capability includes a verification taxonomy audit.

## Migration Plan

1. Land this meta-change as the baseline work queue.
2. Work through Tier 0 first: agent turn behavior, Slack delivery, resumability, prompt, harness, compaction.
3. For each capability, create a dedicated OpenSpec change using the fixed worksheet.
4. Update canonical `specs/` docs and indexes as each capability becomes authoritative.
5. Reorganize eval/test files only after their target requirements are clear.
6. Archive or cross-link superseded prose once each backfilled capability is accepted.

## Open Questions

- Should `openspec/specs/` become the canonical source and `specs/` become generated/archive, or should both coexist with clear ownership?
- Should policy specs such as security and testing be represented as OpenSpec capabilities, or kept as policy docs with OpenSpec task coverage only?
- Should provider packages share one `provider-packages` spec or one capability spec per provider once their workflows are audited?
