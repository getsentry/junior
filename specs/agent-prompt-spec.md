# Agent Prompt Spec

## Metadata

- Created: 2026-04-28
- Last Edited: 2026-04-28

## Changelog

- 2026-04-28: Initial spec defining ownership, structure, and bloat controls for the core agent prompt.

## Status

Active

## Purpose

Define the canonical contract for Junior's platform-owned agent prompt so prompt changes stay compact, non-duplicative, and measurable.

## Scope

- `buildSystemPrompt(...)` in `packages/junior/src/chat/prompt.ts`.
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

`buildSystemPrompt(...)` must keep these concerns distinct:

1. Identity/personality.
2. Runtime and thread context.
3. Available and loaded capabilities.
4. Core behavior rules.
5. Slack output contract.

Context blocks describe facts. Behavior and output blocks carry instructions.

### Execution bias

The core behavior rules must include one compact execution-bias rule:

- Default to acting in-turn.
- Use relevant available skills/tools to satisfy the request.
- Continue until done or blocked.
- Ask the user only when access or required input is missing.
- State when a fact cannot be verified.

Do not restate this rule in skills or add sibling bullets that say the same thing with different wording.

### Tool and skill policy

- Tool schemas remain the source of truth for tool parameters. The prompt may state when to use tools, not re-document every tool schema.
- The model should load the best-matching skill when relevant and avoid preloading unrelated skills.
- After loading a plugin-backed skill, the prompt may describe the generic MCP lookup path, but provider-specific tool strategy belongs in the skill or plugin docs.

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
