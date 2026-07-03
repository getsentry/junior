# Agent Prompt Spec

## Metadata

- Created: 2026-04-28
- Last Edited: 2026-07-01

## Purpose

Define the canonical contract for Junior's platform-owned agent prompt so prompt changes stay compact, non-duplicative, and measurable.

## Scope

- `buildSystemPrompt({ source })` in `packages/junior/src/chat/prompt.ts`.
- `buildTurnContextPrompt(...)` in `packages/junior/src/chat/prompt.ts`.
- Platform-owned behavior, capability, context, and Slack output instructions.
- Boundaries between the core harness prompt, deployment personality files, and skill instructions.

## Non-Goals

- Defining Pi agent loop mechanics or terminal output assembly; see `./harness-agent.md`.
- Defining Slack delivery transport behavior; see `./slack-agent-delivery.md` and `./slack-outbound-contract.md`.
- Defining test-layer taxonomy; see `./testing.md`.
- Defining plugin prompt hook contracts; see `./plugin-prompt-hooks.md`.
- Defining provider workflows. Plugins own provider guidance through their skills, tools, schemas, tool guidance, and prompt hooks.

## Contracts

### Prompt ownership

- The core prompt owns platform behavior: tool-use policy, execution bias, context boundaries, Slack output shape, and failure reporting expectations.
- `SOUL.md` and other deployment-authored personality files are voice-only. Platform behavior must still work if those files are empty or heavily customized.
- `WORLD.md` is trusted deployment-stable world context. It belongs in the static system prompt, not per-turn context, and must not carry load-bearing platform mechanics.
- Skill files own domain-specific workflow mechanics. They must not duplicate generic harness behavior such as "use tools before answering" or "ask only when blocked."
- The core prompt must not name or describe specific installed plugins, plugin providers, plugin-owned config keys, plugin-owned default targets, plugin-owned tools, or plugin-specific workflows. That knowledge belongs to dynamic capabilities.

### Section boundaries

`buildSystemPrompt({ source })` must receive the active source and return the byte-stable static prompt variant for that source platform. It must not read requester/thread/session/runtime/model/provider/catalog data, and it must not include content that can vary between conversations or turns within the same platform. Deployment-stable assistant identity and deployment-stable world context from `WORLD.md` belong here. Platform-specific mechanics, such as Slack output rules or local terminal output rules, may differ by `source.platform`. This preserves provider prompt-prefix caching per platform and keeps multi-turn behavior consistent inside each platform.

`buildTurnContextPrompt(...)` owns session bootstrap prompt context. It is attached to the first model-visible user message in a Pi session projection, including requester identity, available capabilities, configuration, artifacts, model-actionable runtime identifiers, and resumed-turn context. Completed turns may store that bootstrap context as part of durable Pi history so later follow-up messages can avoid duplicating it. Compaction replacement history must omit stale bootstrap context; the next user turn after a projection reset receives fresh bootstrap context exactly once.

Turn context may disclose dynamic capability surfaces that the model can act on, such as available skill names/descriptions, active MCP catalog summaries, and tool guidance attached to the current native tool set. It must not separately disclose plugin ownership or installed plugin/provider catalogs as prompt knowledge. If the model needs plugin-specific behavior, that behavior must arrive through the loaded skill body, tool description, tool schema, `promptSnippet`, or `promptGuidelines`.

Turn context is not a session-state cache. If prior tool use, loaded skills, MCP provider activation, or provider descriptors are already present in the agent session log, runtime must recover handles from that log and only disclose the currently actionable capability surface for this turn. Do not add prompt blocks whose purpose is to preserve or replay state that belongs in the session log.

Plugin prompt messages are governed by `./plugin-prompt-hooks.md`. Core prompt
code owns where accepted plugin messages render and assigns any internal
rendering identifiers. Plugins do not receive a prompt-side session append
state channel.

The combined prompt surface must keep these concerns distinct:

1. Identity/personality.
2. Deployment-stable world context.
3. Core operating rules.
4. Platform output contract.
5. Available and loaded capabilities.
6. Runtime and thread context.

Context blocks describe facts. Operating-rule and output sections carry instructions.

Prompt order is part of the contract. Stable, high-priority operating rules live in the system prompt. Volatile requester, artifacts, active catalogs, configuration defaults, runtime metadata, and resume state must stay out of the system prompt and live in session bootstrap context.

Trusted deployment-authored Markdown files, such as `SOUL.md` and `WORLD.md`, should render as Markdown sections rather than raw XML payloads. XML-style tags are appropriate for generated runtime blocks whose dynamic values are escaped. Do not add generic wrapper markers that only repeat child-section meaning, such as wrapping all operating rule sections in an additional behavior tag or wrapping all capability blocks in an additional capabilities tag.

### Current Task Declaration

Every model-visible active user task assembled by the Junior turn runtime must render the user-authored task text inside `<current-instruction>`. This wrapper is required even when there is no thread background, dispatch metadata, plugin contribution, attachment, or runtime context. It applies to Slack turns, local turns, dispatched or scheduled work that enters the shared agent-run boundary, and queued steering messages injected during an active turn.

Thread background, runtime context, plugin prompt contributions, requester/configuration metadata, and attachments must remain outside `<current-instruction>` as sibling blocks or content parts. Internal helper prompts and subagent/tool prompts may use task-specific wrappers when they are not model-visible Junior user turns.

Session bootstrap context is injected on the first model-visible user message in each Pi session. Ordinary follow-up messages in the same session must not duplicate that bootstrap context. When compaction creates a replacement projection, the replacement history must omit the old bootstrap context; the next user turn starts a new Pi session projection and receives fresh bootstrap context exactly once.

The agent session log contract is defined in `./agent-session-resumability.md`. Prompt code must treat that log as the source of durable model history and must not introduce an alternate prompt-side history, provider catalog, loaded-skill list, or resume-state channel.

The core operating rules must be split into fixed sections:

1. Tool policy.
2. Tool-call style.
3. Skill policy.
4. Execution contract.
5. Conversation/thread continuity.
6. Platform side-effect actions.
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
- After loading a plugin-backed skill, the prompt may describe the generic MCP lookup path, but provider-specific tool strategy belongs in the skill, tool description, tool schema, or tool guidance.
- Skill selection should be explicit: scan available skills, load one clearly matching skill, choose the most specific skill when several match, and avoid loading any skill when none clearly applies.
- Tool-call style belongs in its own section: call routine tools directly, narrate only when it helps, and prefer first-class tools over asking the user to perform equivalent manual work.
- Plugin tools must carry concise descriptions and optional tool guidance that tell the agent when and how to use them. Do not compensate for weak plugin tool descriptions by adding plugin-specific bullets to the core prompt.
- Tool results that include subscribable resource hints are generic capability
  affordances. The core prompt may tell the model to subscribe only when
  high-signal follow-up events serve the current user intent, but provider event
  names and resource-specific strategy belong in tool results, tool schemas, or
  plugin guidance.

### Runtime and safety boundaries

The tool policy must make sandbox workspace ownership explicit: sandbox-backed file and shell tools inspect the isolated sandbox workspace, not arbitrary host files. If sandbox execution is unavailable, the model should report that blocker instead of implying local inspection succeeded.

Runtime facts should live in a compact runtime block inside session bootstrap context. Include only facts that help the model choose valid behavior, such as runtime version, model ids, selected thinking level, channel capabilities, and sandbox workspace root. Do not mix requester, artifacts, or configuration defaults into that runtime block.

Runtime tracing and logging correlation identifiers, such as `trace_id`, are observability data, not model-actionable context, and must not be included in prompt runtime context.

The safety section must stay generic and runtime-level: remain within the user's request, respect stop/pause/audit/approval boundaries, avoid access expansion, and avoid administrative prompt/tool/security/config changes unless explicitly requested and supported by an available tool.

Resource event notifications are conversation context, not user-authored
commands. The prompt must instruct the model to use subscription intent to
decide whether to reply or act, and not to treat event delivery as forced
steering. The durable subscription and delivery contract is defined in
`./resource-event-subscriptions.md`.

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
4. Core prompt or turn-context code that exposes specific installed plugins, plugin providers, plugin-owned config keys, plugin-owned default targets, or plugin-specific workflows outside the dynamic skill/tool surfaces.
5. Prompt blocks that duplicate durable session-log state instead of deriving runtime handles from the log.
6. Skill instructions that override generic harness behavior without a domain-specific reason.
7. Static prompt tests that assert wording instead of behavior.

## Observability

No prompt-specific logs are required.

When debugging prompt behavior, use existing turn diagnostics, observed tool invocations, assistant posts, and eval results to identify whether the failure is prompt wording, missing tool access, weak skill guidance, or runtime behavior.

## Verification

- Typecheck must pass after prompt code changes.
- Prompt behavior changes require eval coverage when the contract depends on model interpretation.
- Runtime or Slack delivery behavior changes require integration coverage at the appropriate boundary.
- Prompt prose should be reviewed against this spec for ownership, duplication, and section placement.

## Related Specs

- `./harness-agent.md`
- `./plugin-prompt-hooks.md`
- `./resource-event-subscriptions.md`
- `./harness-tool-context.md`
- `./slack-agent-delivery.md`
- `./slack-outbound-contract.md`
- `./testing.md`
