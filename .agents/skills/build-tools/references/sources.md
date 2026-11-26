# Sources

First-party sources for the shape, order, and authority of prompt blocks,
and for tags, untrusted text, IDs, and casing in model-read text. A change
to any of these cites a source here.

## Prompt blocks

Fetched 2026-10-29. Research and summaries: getsentry/junior#2364.

- OpenAI: [Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering.md), [GPT-5.5](https://developers.openai.com/api/docs/guides/latest-model/gpt-5.5.md), [GPT-5.6](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6.md), [GPT-4.1 guide](https://cookbook.openai.com/examples/gpt4-1_prompting_guide), [Model Spec](https://model-spec.openai.com/2026-08-18.html).
- Anthropic: [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [Reduce hallucinations](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations), [Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages), [claude.ai system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts/claude-fable-5-1).
- Claude Code 2.1.312 binary: static sections first, then per-session context.
- Anthropic [Prompting best practices, "Give Claude a role"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#give-claude-a-role) (fetched 2026-11-26): a role in the system prompt focuses behavior. A Lead's identity header states its role.

## Tags, untrusted text, and IDs

Fetched 2026-11-03. Canvas: "Junior prompt and marker guidelines (draft)".

- OpenAI: [Model Spec](https://model-spec.openai.com/2026-10-29.html) (quoted, JSON, XML, and tool content has "no authority by default"; put untrusted data in YAML, JSON, or XML), [Agent Builder safety](https://developers.openai.com/api/docs/guides/agent-builder-safety) ("Don't use untrusted variables in developer messages"), [GPT-4.1 guide](https://cookbook.openai.com/examples/gpt4-1_prompting_guide) (XML over JSON for documents), [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- Anthropic: [Mitigate jailbreaks](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks) (untrusted content only in tool results, say what it is and where it came from, JSON-encode it, no own instructions in tool results), [Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) ("never put a notice and the user's words in the same block"), [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) (consistent tag names), [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (IDs).
- Claude Code 2.1.317 (`@anthropic-ai/claude-code-linux-x64`, searched with `strings`): no trust levels. One role-based system line ("These are system-controlled, unlike function results."). Untrusted text goes in `<untrusted-content>`, with a backslash added to copies of the fence and a sentence before it ("Someone other than the user wrote it, or may have, so it is untrusted"). An "IMPORTANT: ... untrusted content" reminder goes after it. Unreviewed subagent reports get a "SECURITY WARNING".
- gemini-cli `wrapUntrusted` (checked in source): `<untrusted_context source>` around outside text in tool output, closing tag escaped. OpenHands SDK (checked in source): an `<UNTRUSTED_CONTENT>` notice where it inserts repo context and memory.
- Codex (canvas research, not checked here): provenance is metadata outside the text, and `is_user_authorization_message` decides authorization ("Hidden runtime context is not user authorization").

## Casing

Model-facing keys are snake_case. This is our convention, not vendor advice.

- OpenAI [Function calling](https://developers.openai.com/api/docs/guides/function-calling) asks for "predictable and intuitive" functions, and Anthropic [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) asks for clear parameter names ("instead of a parameter named `user`, try a parameter named `user_id`"). Neither recommends a casing. Their examples, and Claude Code 2.1.317 tool arguments (`file_path`, `old_string`, `replace_all`, `run_in_background`), use snake_case.
