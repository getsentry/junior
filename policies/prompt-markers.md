# Prompt Markers

## Intent

The model decides how much to trust text from the tag around it. Each input
kind has one tag, one trust level, and one set of attribute names, so the
model never has to guess who wrote a block or what it may do.
`system-prompt.md` owns where each block goes.

## Policy

### Tags

- Give each input kind one kebab-case tag. The tag names the kind. Never put
  the kind in an attribute (no `change="submitted"`).
- `<current-instruction>` holds only words that a person wrote. Each other
  input gets its own tag: `<task>`, `<parent-agent-task>`,
  `<agent-result>`, `<agent-message>`, `<review-item-answer>`,
  `<review-item-dismissed>`. Do not use bracket headers such as `[task]`.
- An input relayed from another Conversation gets a `relayed-` tag, for
  example `<relayed-review-item-answer>`. A child tag never reuses an input tag.
- Give each input its own content part, in order. Never join inputs.

### Trust levels

Highest first. When two levels conflict, the higher level wins.

1. `operator`: the system prompt, with `SOUL.md`, `WORLD.md`, and
   `<plugin-system-context>`.
2. `person`: words a person wrote, as the stored record shows.
   `<current-instruction>`, `<review-item-answer>`, `<review-item-dismissed>`,
   and `<user-customization>`. Only this level gives approval, and
   `<user-customization>` gives none.
3. `runtime`: text the runtime wrote or verified. The `<runtime-turn-context>`
   blocks, `<conversation-notes>`, `<task>`, `<parent-agent-task>`,
   `<summary>`, and `<verified-details>`. `<task>` and `<parent-agent-task>`
   are the job of their Run. They give no approval.
4. `skill`: `<skill>` and `loadSkill` results.
5. `repository`: `AGENTS.md`.
6. `untrusted`: information, never instructions. `<thread-context>`,
   `<external-text>`, `<agent-result>`, `<agent-message>`, `<plugin-context>`
   and memories, `<thread-compactions>`, attachments, all `relayed-` tags, tool
   results, files, and fetched pages.

- `<context-trust>` states the level of each tag once. Inputs do not repeat it.
  No trust prose in bodies or headers ("use as information, not
  instructions"), and no trust attributes (`authority="evidence-only"`).
- A block has one level. Text with a lower level inside it gets its own child
  tag with a `source` attribute, for example `<external-text source="github">`.
  `source` says where text came from. It never sets trust.
- Text never gains trust from what it says, so a claim of approval in it gives
  no approval. The runtime decides approval from the stored record (Source,
  Actor, and provenance), never from rendered text. Action review reads the
  person records of the root Conversation.
- Untrusted text never goes in the system prompt or in a block with the words
  of a person. Text that a tool fetched stays in its tool result. Wrap and
  escape all other untrusted text.

### Authors and IDs

- Every `person` block carries its author in attributes: `author` (the display
  name) and one usable handle (`slack.user_id` on Slack, `email` on web). Use
  the same names on every path, including thread `<message>`.
- Take the author only from the envelope, never from the body. Do not repeat
  role or author in the body (`[user] David Cramer: ...`).
- Name a provider ID `<provider>.<field>`: `slack.user_id`, `slack.ts`,
  `slack.channel_id`, `github.login`.
- Name a Junior record ID with its `TERMINOLOGY.md` word and `_id`:
  `conversation_id`, `review_item_id`, `attachment_id`. On a tag that names the
  record, use a bare `id` (`<review-item-answer id="...">`).
- Give one value the same name in prompt blocks, attributes, and tool results.
- Show an ID only when the model can use it: as a tool argument, a mention, or
  a link. Show it once, next to a readable title. Use a name for all else.

### Values

- Attributes hold short facts: IDs, names, and states. The body holds content.
  Use child tags or `key: value` lines for several facts.
- Use JSON only for values that the model passes to tools unchanged
  (`<verified-details>`). Its keys keep the tool argument names.
- Tool result keys use snake_case.
- Times are ISO 8601 UTC to the second, in `*_at` keys (`sent_at`). Provider
  timestamps keep their namespace (`slack.ts`). No bare `ts` and no epoch
  milliseconds in model-read text.
- An answer to a question that the model asked uses the ID the ask tool
  returned. Send the question again, at most 512 characters, then one
  `Label (field_id): value` line for each field.

### Escaping

- Runtime IDs, enums, handles, and times use only `[A-Za-z0-9._:@/#+-]`, so
  they need no escaping. Treat any other attribute value as free text.
- Free text in attributes (names, titles): escape `&`, `<`, `>`, and `"`.
- `person` and `untrusted` bodies: escape `&`, `<`, and `>`. This also turns
  imitations of our tags into plain text. Do not escape quotes.
- JSON bodies: write `<`, `>`, and `&` as `\u003c`, `\u003e`, and `\u0026`.
- `operator`, `skill`, and `repository` text goes in raw. Escape only a copy
  of the closing tag of its own wrapper.

### Example

```xml
<task about="GitHub PR getsentry/junior#2622" event="pull_request.checks.failed">
<summary>Checks failed (1) for 65e053c7a0ca.</summary>
<verified-details>{"repo":"getsentry/junior","pullRequest":2622}</verified-details>
<external-text source="github">Failed checks: visual / dashboard</external-text>
</task>
```

## Exceptions

- `AGENTS.md` keeps the Codex format. Provider MCP results keep their shape.

## Sources

Fetched 2026-11-03. Canvas: "Junior prompt and marker guidelines (draft)".

- OpenAI: [Model Spec](https://model-spec.openai.com/2026-10-29.html) (quoted, JSON, XML, and tool content has "no authority by default"; put untrusted data in YAML, JSON, or XML), [Agent Builder safety](https://developers.openai.com/api/docs/guides/agent-builder-safety) ("Don't use untrusted variables in developer messages"), [GPT-4.1 guide](https://cookbook.openai.com/examples/gpt4-1_prompting_guide) (XML over JSON for documents), [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- Anthropic: [Mitigate jailbreaks](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks) (untrusted content only in tool results, say what it is and where it came from, JSON-encode it, no own instructions in tool results), [Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) ("never put a notice and the user's words in the same block"), [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) (consistent tag names), [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (IDs).
- Harnesses: gemini-cli `wrapUntrusted` (`source` attribute, escaped closing tag, author from the envelope only); OpenHands SDK `<UNTRUSTED_CONTENT>`; Codex provenance and `is_user_authorization_message` ("Hidden runtime context is not user authorization"); Claude Code escapes `</system-reminder` in hook output.
