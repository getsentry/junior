# Backfill Worksheet: `agent-prompt`

## Scope

- Capability: Agent prompt
- Change: `backfill-agent-prompt`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/agent-prompt/spec.md` after review; current prose source remains `specs/agent-prompt.md`

## Current-Source Inventory

### Existing Specs And Policies

- `specs/agent-prompt.md`: primary existing contract for prompt ownership, section boundaries, execution bias, source hierarchy, skill/tool policy, safety, bloat controls, and verification.
- `specs/agent-turn-handling.md`: observable turn behavior that prompt instructions are meant to support.
- `specs/agent-session-resumability.md`: durable session log and prohibition on prompt-side history/provider caches.
- `specs/oauth-flows.md`: authorization completion is represented by session-log projection; thread pending auth is callback routing/dedupe only.
- `specs/harness-agent.md`: Pi loop and final output mechanics.
- `specs/plugin-runtime.md`: plugin skills/tool guidance and plugin-specific prompt ownership.
- `specs/trusted-plugin-heartbeat.md`: trusted plugin tool descriptions and prompt guidance.
- `specs/testing.md`, `specs/unit-testing.md`, `specs/eval-testing.md`: test layer boundaries and warnings against brittle prompt substring tests.

### Code Paths

- `packages/junior/src/chat/prompt.ts`: `buildSystemPrompt()`, `buildTurnContextPrompt(...)`, behavior sections, output section, skill/capability/context formatting.
- `packages/junior/src/chat/respond.ts`: attaches system prompt, detects existing session bootstrap context, builds bootstrap context when needed, constructs tool guidance and active MCP catalogs.
- `packages/junior/src/chat/respond-helpers.ts`: runtime-turn-context detection, stripping, and refreshing helpers.
- `packages/junior/src/chat/skills.ts`: skill discovery, invocation parsing, metadata, user-callable skill handling, skill body loading.
- `packages/junior/src/chat/tools/**`: tool definitions with schemas, `promptSnippet`, and `promptGuidelines`.
- `packages/junior/src/cli/check.ts`: skill validation, including warnings about duplicating harness/MCP mechanics.
- `packages/junior/src/chat/services/turn-thinking-level.ts`: separate classifier prompt, not the core agent prompt.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/prompt.test.ts`
  - `packages/junior/tests/unit/services/context-compaction.test.ts`
  - `packages/junior/tests/unit/skills/skills.test.ts`
  - `packages/junior/tests/unit/skills/load-skill-tool.test.ts`
  - `packages/junior/tests/unit/skills/skill-frontmatter.test.ts`
  - `packages/junior/tests/unit/services/turn-thinking-level.test.ts`
- Integration:
  - `packages/junior/tests/integration/slack/new-mention-behavior.test.ts`
  - `packages/junior/tests/integration/slack/message-content-behavior.test.ts`
  - `packages/junior/tests/integration/slack/provider-default-config-behavior.test.ts`
  - `packages/junior/tests/integration/mcp-dynamic-tools.test.ts`
  - `packages/junior/tests/integration/slack/attachment-media-behavior.test.ts`
  - `packages/junior/tests/integration/slack/bot-image-hydration.test.ts`
- Evals:
  - `packages/junior-evals/evals/core/skill-invocation-control.eval.ts`
  - `packages/junior-evals/evals/core/research-reply-shape.eval.ts`
  - `packages/junior-evals/evals/core/passive-behavior.eval.ts`
  - `packages/junior-evals/evals/core/coding-file-tools.eval.ts`
  - `packages/junior-evals/evals/core/skill-infra.eval.ts`
  - Provider skill workflow evals under `packages/junior-evals/evals/github/*` and `sentry/*`
- Fixtures/MSW:
  - Eval skill fixtures and Slack harness fixtures provide prompt-facing behavior evidence.

### Package Docs And Scripts

- `packages/junior-evals/README.md`: evals as behavior tests for agent/prompt interpretation.
- `pnpm skills:check`: validates skill files and warns about prompt-boundary duplication.

## Prior Art

- Platform or API docs:
  - No external platform docs define Junior's prompt. Relevant prior art is internal agent architecture and general prompt-engineering practice around separating stable system instructions from volatile context.
- SDK/source references:
  - Provider prompt-prefix caching benefits from a byte-stable static prompt.
  - Pi session replay makes repeated runtime context dangerous if every user message carries a fresh copy; Codex-style sessions keep bootstrap material once per active projection and reset it after compaction.
- Comparable product or agent behavior:
  - Modern agents separate system/developer policy, user turn context, tool schemas, and skill/domain instructions to reduce prompt drift and improve evalability.
- Notes on applicability:
  - This capability should specify ownership and behavior outcomes, not exact prompt text.

## Implemented Behavior

- Behavior that code currently enforces:
  - `buildSystemPrompt()` is parameterless and returns a stable assembled prompt.
  - Static prompt sections include identity, personality, behavior, and Slack output.
  - Core behavior is split into named sections: tool policy, tool-call style, skill policy, execution contract, conversation, Slack actions, safety, and failure handling.
  - `buildTurnContextPrompt(...)` wraps dynamic bootstrap facts in `<runtime-turn-context>`.
  - Available skills expose names/descriptions/locations but not plugin metadata.
  - Active MCP catalogs expose provider/count summaries and route execution through MCP bridge tools.
  - Tool guidance is dynamic and tool-owned.
  - Follow-up context is omitted when restored Pi history already contains a runtime-turn-context bootstrap marker.
  - Compaction replacement history strips runtime-turn-context so a new projection gets fresh bootstrap context.
  - `buildTurnContextPrompt(...)` has no pending-auth or authorization-completed input today; auth completion reaches the model through session-log projection.
- Behavior that tests currently verify:
  - Prompt builder parameterlessness and stable return.
  - First-turn context rendering.
  - Skill availability without plugin metadata.
  - Follow-up context omission when bootstrap already exists.
  - Runtime-turn-context stripping in compaction replacement tests.
  - Skill invocation control via evals.
  - Research reply shape and canvas handoff via evals.
- Behavior that appears accidental or weakly enforced:
  - Prompt tests currently use inline snapshots, which can overfit exact wording.
  - Prompt bloat review depends on human review and specs more than tooling.
  - `WORLD.md` authority is less explicit than `SOUL.md`.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Stable core prompt owns platform behavior.
  - Session bootstrap context stays outside the system prompt, appears at most once per active Pi projection, and is refreshed after compaction/resume boundaries that require it.
  - Auth lifecycle state stays out of prompt context; authorization completion is chronological session history.
  - Skills/tools/plugins own domain-specific mechanics.
  - Prompt rules stay compact and non-duplicative.
  - Model-facing behavior is verified with evals when interpretation matters.
- Behavior that should remain implementation detail:
  - Exact wording of prompt bullets.
  - XML-ish tag names except where runtime stripping depends on them.
  - Exact ordering inside sections beyond ownership and priority boundaries.
  - The default `SOUL.md` text.
- Behavior that should be non-goal:
  - Re-specifying tool schemas.
  - Re-specifying Slack transport delivery.
  - Freezing plugin/provider workflows in core prompt.
  - Prompt-specific logs.

## Undefined Behavior / Open Questions

| Question                                                   | Evidence                                                                                                    | Options                                                                 | Recommendation                                                                       | Status |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| Should prompt tests avoid inline snapshots?                | `prompt.test.ts` snapshots exact context blocks; specs discourage static wording tests.                     | Keep snapshots, use structural assertions, or hybrid.                   | Move toward structural assertions for invariants; evals for behavior.                | open   |
| What authority can `WORLD.md` carry?                       | `SOUL.md` is described as voice-only; `WORLD.md` is included as session context.                            | Voice/context only, organization policy, or dynamic reference material. | Treat as context/reference, not platform behavior, unless separately specified.      | open   |
| Should thinking level be model-visible in runtime context? | Diagnostics/footer use thinking level; prompt runtime block currently includes conversation/trace IDs only. | Disclose, omit, or disclose only when relevant.                         | Omit unless eval evidence shows it improves behavior.                                | open   |
| What threshold requires a new prompt eval?                 | Spec says examples should be eval-driven; no formal threshold.                                              | Every prompt change, behavior-risk changes, or examples only.           | Require evals for behavior-risk changes; structural-only changes can use unit tests. | open   |
| Should tool guidance duplication be linted?                | CLI check warns for some skill duplication.                                                                 | Manual review, CLI lint, or eval-only.                                  | Add lint only for clear anti-patterns.                                               | open   |

## OpenSpec Requirements Draft

| Requirement                         | Scenarios                                                                | Source Evidence                                                                  | Notes                                                              |
| ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Prompt ownership boundaries         | Core behavior, personality customization, domain guidance                | `agent-prompt.md`, `prompt.ts`, plugin specs                                     | Avoid plugin-specific core prose.                                  |
| Static system prompt                | Parameterless, stable identity, no dynamic facts                         | `buildSystemPrompt()`, `prompt.test.ts`                                          | Cacheability/consistency.                                          |
| Session bootstrap runtime context   | Bootstrap, follow-up omission, compaction stripping                      | `buildTurnContextPrompt`, `respond-helpers`, tests                               | Runtime-turn-context tag matters.                                  |
| Authorization resume context        | Prompt excludes auth lifecycle hints; session projection owns completion | `agent-session-resumability.md`, `oauth-flows.md`, `session-log.ts`, `prompt.ts` | Prevents duplicate or stale auth hints on unrelated resumed turns. |
| Prompt section structure            | Behavior sections, output section, runtime facts                         | `prompt.ts`                                                                      | Section ownership is normative; exact bullets are not.             |
| Execution bias and source hierarchy | Act, repo evidence, live checks, conflicts                               | `prompt.ts`, turn-handling spec, evals                                           | Observable behavior belongs to turn handling/evals.                |
| Skill and tool policy               | Skill disclosure, user-callable skills, schemas, tool guidance           | `prompt.ts`, `skills.ts`, evals                                                  | Cross-link skill-runtime later.                                    |
| Runtime and safety boundaries       | Sandbox, unavailable sandbox, admin actions                              | `prompt.ts`, security policy                                                     | Generic safety only.                                               |
| Prompt bloat control                | New rule, duplicate behavior, examples                                   | canonical spec, CLI check                                                        | Mostly review/governance.                                          |
| Verification taxonomy               | Structural unit, behavior eval, runtime integration                      | testing specs and current tests                                                  | Key backfill outcome.                                              |

## Migration Notes

- Canonical spec updates:
  - Keep `specs/agent-prompt.md` authoritative until OpenSpec baseline is accepted.
  - Consider clarifying `WORLD.md` authority.
  - Consider adding explicit guidance against inline prompt snapshots except for structural fixtures.
- Index/pointer updates:
  - No index update needed; `specs/agent-prompt.md` is already listed.
- Superseded content:
  - None yet.
- Test/eval taxonomy changes:
  - Defer prompt test rewrites and eval mapping to follow-up tasks.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-agent-prompt' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests/evals were inventoried but not changed.
- Deferred verification: snapshot-vs-structural prompt tests, `WORLD.md` authority, prompt-eval threshold, tool-guidance linting.
