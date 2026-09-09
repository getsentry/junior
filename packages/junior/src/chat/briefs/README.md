# Briefs

This module owns the provider-neutral Brief shape, generator input, local snapshot adapter, evidence checks, and Markdown rendering.

A Brief is a compact record of a Conversation. It keeps intent, outcome, decisions, open decisions, durable facts, evidence links, and keywords after the transcript expires.

## Invariants

- `generateBrief` is pure. Callers supply the input, previous Brief, prompt, model id, and structured completion function.
- Code change and resource links come from trusted input. The model cannot add them.
- A model URL is kept only when it matches deterministic evidence or when the exact URL occurs in an input entry or the previous Brief.
- Code changes and resources take priority when the 40-link cap applies.
- User and assistant text is limited to 4,000 characters per entry. The 60,000-character input budget keeps these messages before tool results and drops the oldest message only when the messages alone exceed the budget.
- Tool result text is limited to 1,500 characters per entry. Newest tool results fill the remaining budget. Retained entries keep their original order, and the prompt reports omitted message and tool-result counts.
- Output caps and normalization apply after model output is parsed.
- `searchText` contains Brief content and link labels. It does not contain transcript text that the Brief omitted.

The default prompt is in `prompt.ts`. The package uses tsdown, which does not copy Markdown assets. Keeping the prompt in a TypeScript string makes the source and packaged CLI use the same text without a file-system lookup.

A run without `--model` resolves the app's configured fast model when the run starts. This keeps the CLI and background generation on the same model configuration without pinning a provider model in core.

## Snapshots

A version 1 snapshot contains the conversation detail report, every older event page, and a code change list. `junior briefs pull` follows every `previousCursor` and writes the complete report without a token. The current detail API does not include code changes, so pulled snapshots start with an empty code change list. A local fixture can add code changes before replay.

`briefInputFromSnapshot` accepts only available event history. It does not generate a Brief from redacted or expired transcript content.

This module does not own SQL storage, version allocation, purge policy, privacy gates, search scope, or post-turn scheduling. Those boundaries must preserve these evidence rules when they call the generator.
