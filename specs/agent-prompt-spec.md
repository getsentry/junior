# Agent Prompt Spec

## Metadata

- Created: 2026-04-28
- Last Edited: 2026-05-06

## Changelog

- 2026-04-28: Initial spec defining ownership, structure, and bloat controls for the core agent prompt.
- 2026-04-30: Reworked the core prompt contract around fixed operating sections, source hierarchy, explicit completion gates, OpenClaw-style tool-call/safety boundaries, and stable-before-volatile ordering.
- 2026-05-06: Required the initial system prompt to be byte-stable across conversations and turns, with volatile runtime context moved into per-turn user-message context.
- 2026-05-06: Clarified that deployment-stable assistant identity belongs in the system prompt while requester identity remains per-turn context.

## Status

Active

## Purpose

Define the canonical contract for Junior's platform-owned agent prompt so prompt changes stay compact, non-duplicative, and measurable.

## Scope

- `buildSystemPrompt()` in `packages/junior/src/chat/prompt.ts`.
- `buildTurnContextPrompt(...)` in `packages/junior/src/chat/prompt.ts`.
- Platform-owned behavior, capability, context, and Slack output instructions.
- Boundaries between the core harness prompt, deployment personality files, and skill instructions.

## Non-Goals

- Defining Pi agent loop mechanics or terminal output assembly; see `./harness-agent-spec.md`.
- Defining Slack delivery transport behavior; see `./slack-agent-delivery-spec.md` and `./slack-outbound-contract-spec.md`.
- Defining test-layer taxonomy; see `./testing/index.md`.
- Defining provider-specific prompt overlays unless this repository owns that overlay.

## Contracts

### Prompt ownership

- The core prompt owns platform behavior: tool-use policy, execution bias, context boundaries, Slack output shape, and failure reporting expectations.
- `SOUL.md` and other deployment-authored personality files are voice-only. Platform behavior must still work if those files are empty or heavily customized.
- Skill files own domain-specific workflow mechanics. They must not duplicate generic harness behavior such as "use tools before answering" or "ask only when blocked."

### Section boundaries

`buildSystemPrompt()` must be static: no parameters, no requester/thread/session/runtime/model/provider/catalog data, and no content that can vary between conversations or turns. Deployment-stable assistant identity, such as the bot Slack username, belongs here. This is required for provider prompt-prefix caching and for consistent multi-turn behavior.

`buildTurnContextPrompt(...)` owns volatile prompt context. It is attached to the current user turn, including requester identity and resumed-turn context, and may vary by conversation or turn. Completed turns must strip this context before storing durable Pi message history so prior turns are not replayed with stale runtime facts.

The combined prompt surface must keep these concerns distinct:

1. Identity/personality.
2. Core operating rules.
3. Slack output contract.
4. Available and loaded capabilities.
5. Runtime and thread context.

Context blocks describe facts. Behavior and output blocks carry instructions.

Prompt order is part of the contract. Stable, high-priority operating rules live in the system prompt. Volatile requester, artifacts, active catalogs, configuration defaults, runtime metadata, and resume state must stay out of the system prompt and live in per-turn context.

The core operating rules must be split into fixed sections:

1. Tool policy.
2. Tool-call style.
3. Skill policy.
4. Execution contract.
5. Conversation/thread continuity.
6. Slack side-effect actions.
7. Safety.
8. Failure handling.

These sections are separate because each owns a distinct decision. Do not collapse them back into one flat list when adding new behavior.

### Execution bias

The execution contract must include compact execution-bias rules:

- Default to acting in-turn.
- Use relevant available skills/tools to satisfy the request.
- Continue until done or blocked.
- Ask the user only when access or required input is missing.
- Treat plans, promises, and "I can check" offers as incomplete when an available tool or source can move the request forward.
- Require final answers to cover the user's actual ask, including requested follow-up checks.
- State when a fact cannot be verified.

Do not restate these rules in skills or add sibling bullets that say the same thing with different wording.

### Source hierarchy

The tool policy must tell the model when source-backed work is required and which source class to try first:

1. Conversation/thread context.
2. User-provided attachments, links, and reference files.
3. Local/sandbox files when present.
4. Loaded skill references.
5. Repository or provider tools.
6. Public web.

For repository or implementation questions, repository evidence is required before generic product framing or memory. When the repository is not locally mounted, the model should use the configured source provider rather than pretending local files are available.

Mutable facts need live checks. Examples include files, repos, versions, issues, services, clocks, and live provider data.

### Tool and skill policy

- Tool schemas remain the source of truth for tool parameters. The prompt may state when to use tools, not re-document every tool schema.
- The model should load the best-matching skill when relevant and avoid preloading unrelated skills.
- After loading a plugin-backed skill, the prompt may describe the generic MCP lookup path, but provider-specific tool strategy belongs in the skill or plugin docs.
- Skill selection should be explicit: scan available skills, load one clearly matching skill, choose the most specific skill when several match, and avoid loading any skill when none clearly applies.
- Tool-call style belongs in its own section: call routine tools directly, narrate only when it helps, and prefer first-class tools over asking the user to perform equivalent manual work.

### Runtime and safety boundaries

The tool policy must make sandbox workspace ownership explicit: sandbox-backed file and shell tools inspect the isolated sandbox workspace, not arbitrary host files. If sandbox execution is unavailable, the model should report that blocker instead of implying local inspection succeeded.

Runtime facts should live in a compact runtime block inside per-turn context. Include only facts that help the model choose valid behavior, such as runtime version, model ids, selected thinking level, channel capabilities, and sandbox workspace root. Do not mix requester, artifacts, or configuration defaults into that runtime block.

The safety section must stay generic and runtime-level: remain within the user's request, respect stop/pause/audit/approval boundaries, avoid access expansion, and avoid administrative prompt/tool/security/config changes unless explicitly requested and supported by an available tool.

### Bloat controls

- Each behavior bullet should own one distinct decision the model must make.
- Before adding a new prompt rule, first try to replace or sharpen an existing rule with the same owner.
- Remove or merge rules that differ only by example, tone, or repeated ask/act/verify language.
- Add examples only when evals show the compact rule is insufficient.
- Prompt wording is not a behavior contract by itself; validate prompt behavior with evals or integration tests, not static substring assertions.

### Output contract

- The Slack output section owns formatting and delivery shape only.
- It should stay compact: Slack `mrkdwn` constraints, brevity, canvas handoff rules, and final user-facing response requirements.
- Behavioral rules such as when to use tools or ask questions do not belong in the output section.

## Failure Model

Prompt changes are rejected or revised when they introduce:

1. Duplicate rules across core prompt, skills, or personality files.
2. Multiple adjacent bullets that all express the same ask/act/verify policy.
3. Tool-schema restatement in prompt prose.
4. Skill instructions that override generic harness behavior without a domain-specific reason.
5. Static prompt tests that assert wording instead of behavior.

## Observability

No prompt-specific logs are required.

When debugging prompt behavior, use existing turn diagnostics, observed tool invocations, assistant posts, and eval results to identify whether the failure is prompt wording, missing tool access, weak skill guidance, or runtime behavior.

## Verification

- Typecheck must pass after prompt code changes.
- Prompt behavior changes require eval coverage when the contract depends on model interpretation.
- Runtime or Slack delivery behavior changes require integration coverage at the appropriate boundary.
- Prompt prose should be reviewed against this spec for ownership, duplication, and section placement.

## Related Specs

- `./harness-agent-spec.md`
- `./harness-tool-context-spec.md`
- `./slack-agent-delivery-spec.md`
- `./slack-outbound-contract-spec.md`
- `./testing/index.md`
