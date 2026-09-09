# Briefs

This module owns the provider-neutral Brief shape, generator input adapters,
evidence checks, version storage, post-Turn generation, and Markdown rendering.

A Brief is a compact record of a Conversation. It keeps a deterministic record, intent, outcome, decisions, open decisions, durable facts, evidence links, and keywords after the transcript expires.

The record comes from `BriefInput`, not from the model. It contains the activity range, duration, human message, assistant message, tool result, resource event, and Turn counts, named participants, Location, and code changes with their states and known dates. Each generated version covers entries through its `throughIndex`.

## Invariants

- `generateBrief` is pure. Callers supply the input, previous Brief, prompt, model id, and structured completion function.
- Code change and resource links come from trusted input. The model cannot add them.
- A model URL and transcript text are HTML-unescaped before the evidence check. URL normalization then removes common trailing punctuation, a trailing `/http` or `/https` fragment, and a trailing slash. The normalized URL is kept only when it matches a complete normalized URL token in deterministic evidence, an input entry, or the previous Brief.
- Code changes and resources take priority when the 40-link cap applies.
- User and assistant text is limited to 4,000 characters per entry. The 60,000-character input budget keeps these messages before tool results and drops the oldest message only when the messages alone exceed the budget.
- Tool result text is limited to 1,500 characters per entry. Newest tool results fill the remaining budget. Retained entries keep their original order, and the prompt reports omitted message and tool-result counts.
- Each decision has a kind. `stated` means a human stated the choice. `confirmed` means a human accepted Junior's proposal. `assumed` means Junior chose without confirmation or objection.
- Core drops decision and open-decision attribution unless it matches a named participant, without case differences, or `Junior`. A decision attributed to Junior or no one is `assumed`. A decision attributed to a human cannot be `assumed`. The evidence check counts these kind coercions.
- Core drops facts, decisions, and open decisions that contain Junior runtime markers. The evidence check counts dropped attribution and marker items.
- When linked evidence exists, core reports a merged claim in the summary or outcome if no code change or resource has a `merged` state. It does not flag conversations without linked evidence or rewrite model prose.
- Output caps and normalization apply after model output is parsed. Summary, intent, and outcome truncation uses a sentence boundary when one occurs after 60% of the limit.
- Output depth follows the record's human user-message count. Small Briefs have at most 3 decisions, 2 open decisions, 5 facts, and 5 keywords. Medium Briefs have at most 8, 5, 10, and 8. Large Briefs have at most 20, 10, 15, and 12. Small means at most 3 user messages. Medium means at most 12.
- `searchText` contains Brief content, link labels, participant names, and code change Repository numbers and states. It does not contain transcript text that the Brief omitted.

The default prompt is in `prompt.ts`. The package uses tsdown, which does not copy Markdown assets. Keeping the prompt in a TypeScript string makes the source and packaged CLI use the same text without a file-system lookup.

A run without `--model` resolves the app's configured default model when the run starts. The default model gives more accurate decisions than the fast model in production samples.

## Storage and generation

`junior_conversation_briefs` stores append-only versions. Each completed Turn
can own only one version. The task allocates the next version while the
Conversation row is locked. Storage rejects an insert after transcript purge
when the root is not public.

The core `briefs.updateBrief` task runs after completed Slack, web, and local
Turns with a user instruction. It skips child Conversations. Before a model
call, it skips a Turn whose terminal event is already covered by the latest
Brief. A retry with the same `turnId` re-emits the stored version's idempotent
`briefs/brief_updated` event, which repairs a failed first emission without a
second model call. The task uses the configured default structured model. The
event carries the version, model id, item counts, and model cost. Its cost
appears in the Conversation auxiliary-cost breakdown under the `briefs`
namespace.

A public Brief survives transcript purge. A non-public root loses every Brief
in its Conversation tree when purge scrubs private metadata. Remaining private
Brief rows keep that tree eligible for another purge pass. This rule prevents
private derived content from outliving the transcript. Later readers must apply
the Conversation privacy gate before they expose a current private Brief.

The SQL and snapshot input adapters use the same reporting-event-to-entry
mapping. The SQL adapter also reads code changes and `resource_link`
annotations from their durable stores.

## Snapshots

A version 1 snapshot contains the conversation detail report, every older event page, and a code change list. `junior briefs pull` follows every `previousCursor` and writes the complete report without a token. The current detail API does not include code changes, so pulled snapshots start with an empty code change list. A local fixture can add code changes before replay.

`briefInputFromSnapshot` accepts only available event history. It resolves each message author by Slack user id or email across all events. It uses the best full name, Slack user name, or email that it sees for that identity. It leaves the author unset when none exists and never uses a raw Slack user id or fallback label as a name. User-role resource events become `event` entries. They stay in the prompt but do not become participants or user messages.

The adapter does not generate a Brief from redacted or expired transcript content.

This module does not own API privacy gates or search scope. Those boundaries must preserve these evidence and purge rules.
