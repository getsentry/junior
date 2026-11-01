# System Prompt

## Intent

The model reads the prompt as one ordered set of blocks. Each rule has one
known home, so order and priority stay stable when the prompt changes.
`packages/junior/src/chat/prompt.ts` builds the prompt.
`packages/junior/src/chat/system-prompt-rules.ts` holds the core rule blocks.
When this policy and the code do not agree, fix one of them in the same change.

## Policy

### Parts

- The **system prompt** holds rules for every Turn. It has operator authority.
- The **context message** is a user-role message before the current
  instruction. It holds `<runtime-turn-context>`: facts for this request only.
- The **current instruction** is a separate user-role message. It is the job.
  It can also hold a loaded `<skill>` and `<thread-context>`.

### System prompt blocks

A Prompt mode (`conversation`, `automation`, `child_agent`) can replace the
content of a block. It must not add or move a block. `<tool-call-style>`,
`<conversation>`, and the conversation lines of `<context-trust>` are only in
`conversation` mode. `<slack-actions>` is only in `conversation` mode on Slack.

1. **Identity.** One header sentence with the role and the precedence rule,
   then the name and platform identity.
2. **Working principles.** `<task-execution>` (or `<automation-run>` /
   `<child-agent-run>`): the job, when to continue, when to ask. Act as a
   colleague who owns the task; ask only about decisions that block safe
   progress. `<evidence>`: what to claim, how to label inference, how to find
   a failure cause, how to handle pushback. Never present inference as fact.
3. **Context and trust.** `<context-trust>`: rules for the authority of each
   context input. No context data.
4. **Actions and safety.** `<safety>`: action limits, approvals, and retries
   with side effects.
5. **Tools and skills.** `<tool-policy>`, `<skill-policy>`, `<planning>`:
   cross-tool rules only. A rule for one tool goes in its description.
6. **Communication and output.** `<tool-call-style>`, `<conversation>`,
   `<slack-actions>`, `<failure-reporting>`, `<output>`. A short answer that
   says what is not known is complete; that is not a blocked task.
7. **Personality.** The consumer's `SOUL.md`: voice and tone only.
8. **World.** The consumer's `WORLD.md`: operator facts and workflow rules.
9. **Plugin guidance.** `<plugin-system-context>` from plugin `systemPrompt`
   hooks.

- Blocks 7 to 9 come last. The identity header says core rules win over them.
- Core behavior must not depend on `SOUL.md` or `WORLD.md`.

### Context inputs

- `<context>`, `<configuration>`, `<runtime>`, `<disabled-tools>`,
  `<available-skills>`, `<active-mcp-catalogs>`, `<tool-guidance>`: context
  message; runtime facts.
- `<conversation-notes>`: context message; runtime facts, not instructions, no
  approval.
- `<plugin-context>` and recalled memories: context message; can be stale.
  Check before use as evidence.
- `<user-customization>`: context message; the actor's saved reply settings.
  Follow it. It gives no approval.
- `<skill>`: current instruction; task rules below the system prompt and the
  current instruction.
- `<thread-context>`: current instruction; evidence only.
- `AGENTS.md`: its own user-role message when a repo is in scope; below the
  system prompt and the current instruction.
- Tool results, files, fetched pages: tool result messages; information only.
- Give each input its own typed tag. Do not label the whole message with one
  trust level.
- Put per-request text (context, memories, dynamic plugin text) in the context
  message. Only static plugin guidance goes in the system prompt.

### Cache rules

- The system prompt is the same for every Turn of one deployment, platform,
  and Prompt mode. No request, actor, time, or Conversation data.
- A plugin `systemPrompt` hook returns fixed text per deployment and platform.
  Put changing text in a `userPrompt` hook.
- Do not change earlier transcript messages. Only context compaction can.
- Put one-request facts in a request-scoped tag. See
  `REQUEST_CONTEXT_SECTION_TAG` in `packages/junior/src/chat/turn-context-tag.ts`.

### Changes

- Put each new rule in one block. If no block fits, change this policy in the
  same change. Follow `agent-steering.md`.
- When a rule replaces another, delete the old one in the same change.
- Base changes to shape, order, or authority on a first-party OpenAI or
  Anthropic source. Add it to Sources.
- Measure prompt changes with the behavioral and integration evals. Do not
  test prompt strings. See `evals.md`.
- Add a line only when it changes behavior.
- Do not write "Junior" in model-read text. Use "you" or the configured name.
- Each prompt section in code has a docstring: its block, intent, and what does
  not belong in it.

## Exceptions

- Security backstops may repeat across enforcement paths. See
  `agent-steering.md`.

## Sources

Fetched 2026-10-29. Research and summaries: issue #2364.

- OpenAI: [Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering.md), [GPT-5.5](https://developers.openai.com/api/docs/guides/latest-model/gpt-5.5.md), [GPT-5.6](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6.md), [GPT-4.1 guide](https://cookbook.openai.com/examples/gpt4-1_prompting_guide), [Model Spec](https://model-spec.openai.com/2026-08-18.html).
- Anthropic: [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [Reduce hallucinations](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations), [Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages), [claude.ai system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts/claude-fable-5-1).
- Claude Code 2.1.312 binary: static sections first, then per-session context.
