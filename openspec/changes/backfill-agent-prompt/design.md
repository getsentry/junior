## Context

The canonical `specs/agent-prompt.md` already establishes the desired ownership model: static platform rules live in `buildSystemPrompt()`, session bootstrap facts live in `buildTurnContextPrompt(...)`, skills own domain mechanics, and plugin/provider-specific strategy reaches the model through dynamic capability surfaces rather than core prompt prose.

Current implementation reflects that split:

- `buildSystemPrompt()` is parameterless and returns byte-stable prompt text assembled from identity, personality, behavior, and output sections.
- `buildTurnContextPrompt(...)` wraps session bootstrap context in `<runtime-turn-context>`, including capability lists, active MCP catalogs, requester, artifacts, configuration, runtime IDs, and explicit skill triggers.
- Follow-up turns omit bootstrap context when restored Pi history already carries it, so the session does not accumulate duplicate runtime blocks.
- Compaction replacement history omits old bootstrap context; the next turn after projection reset receives fresh bootstrap context.
- Authorization resume state is intentionally excluded from prompt context; auth completion is represented by the agent session log and its Pi projection.
- Prompt unit tests assert structural rendering today, including snapshots; the spec should prefer structural invariants and behavior evals over exact prose assertions.

## Goals / Non-Goals

**Goals:**

- Specify prompt ownership, section boundaries, dynamic context placement, and bloat controls.
- Preserve model-facing behavior requirements without pinning exact prompt wording.
- Record which behavior belongs in prompt evals versus runtime integration tests.
- Keep plugin/provider-specific guidance out of the core prompt and inside skills/tools/tool guidance.

**Non-Goals:**

- Rewriting the prompt or changing model behavior.
- Freezing exact prompt prose, bullet order beyond section ownership, or snapshot strings.
- Re-specifying Pi loop mechanics, Slack transport, plugin manifests, or tool schemas.
- Creating prompt-specific observability requirements.

## Decisions

### Decision: Specify prompt invariants, not exact prose

The OpenSpec requirements use structural and behavioral invariants: static prompt is parameterless, bootstrap context is injected once per active projection, behavior sections remain separated, plugin-specific knowledge stays dynamic, and duplicate rules are rejected. Exact strings remain implementation detail unless an eval proves wording needs to be constrained.

Alternatives considered:

- Snapshot all prompt text as the contract: rejected because it makes harmless wording changes expensive and hides actual model behavior risk.
- Leave prompt behavior entirely to evals: rejected because ownership and section boundaries are deterministic code contracts.

### Decision: Keep execution-bias behavior shared with `agent-turn-handling`

`agent-prompt` owns the prompt rules that encourage acting, using tools, and asking only when blocked. `agent-turn-handling` owns observable turn behavior. The two should align but not duplicate each other's full text.

Alternatives considered:

- Move execution bias entirely to turn handling: rejected because the prompt still needs platform instructions.
- Duplicate all turn handling rules in prompt spec: rejected because it increases drift.

### Decision: Keep skill and plugin domain policy outside core prompt

The core prompt may disclose available skill names/descriptions and active MCP provider counts, but it must not embed provider-specific workflows, default targets, config keys, or installed plugin catalogs. That material belongs to skill bodies, tool descriptions, schemas, `promptSnippet`, or `promptGuidelines`.

Alternatives considered:

- Put provider guidance in the core prompt for better model behavior: rejected because it does not scale and violates plugin ownership.
- Hide all dynamic capability context: rejected because the model needs actionable capability surfaces.

### Decision: Keep auth lifecycle out of turn prompt context

An auth-resumed turn may need fresh bootstrap facts such as requester, artifacts, configuration, and available capability surfaces, but it should not receive a separate prompt flag saying that authorization completed. That fact is chronological session history owned by `agent-session-resumability`, and Pi should see it through the deterministic projection of `authorization_completed`.

Alternatives considered:

- Add auth completion fields to `buildTurnContextPrompt(...)`: rejected because turn context is volatile current-environment data, not lifecycle history.
- Keep only thread `pendingAuth` and infer completion from callback state: rejected because `pendingAuth` is a routing/dedupe mechanism and may be stale, cleared, or unrelated to future turns.

## Risks / Trade-offs

- [Risk] Requirements are too abstract to prevent prompt regressions. Mitigation: verification map pairs structural unit tests with behavior evals.
- [Risk] Static tests become brittle. Mitigation: explicitly prefer structural assertions over exact prose snapshots.
- [Risk] Plugin-specific guidance leaks back into core prompt. Mitigation: dedicated requirement and verification action.
- [Risk] Prompt and turn-handling specs overlap. Mitigation: prompt owns instructions and context placement; turn-handling owns observable response behavior.
- [Risk] Resume lifecycle facts leak into turn context and duplicate session projection. Mitigation: auth resume context explicitly forbids prompt-only lifecycle hints.

## Open Questions

- Should prompt-builder unit tests move away from inline snapshots toward structural/tag assertions?
- Should `WORLD.md` be treated as voice/context only, or can it carry organization policy beyond personality?
- Should the selected thinking level be disclosed inside runtime context once it is chosen, or remain only in diagnostics/footer metadata?
- How strict should prompt-bloat review be before requiring a new eval for added examples?
- Should plugin tool guidance have lint rules for duplication with core prompt sections?

## Migration Plan

1. Validate this OpenSpec change.
2. Review current prompt tests against the verification map and identify brittle snapshot coverage.
3. After acceptance, archive this capability into `openspec/specs/agent-prompt/spec.md`.
4. Use future prompt changes to add evals for model interpretation, not substring tests, unless the invariant is structural.
