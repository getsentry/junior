# Memory Plugin Tools

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-20

## Purpose

Define the explicit model-visible memory management and recall tools exposed by
the memory plugin.

Operator/admin memory commands are covered by [`./admin.md`](./admin.md). They
must not be exposed through this model-visible tool surface.

## Tool Surface

The plugin exposes memory tools from `tools(ctx)`:

```txt
rememberForRequester
rememberForConversation
removeMemory
listMemories
searchMemories
```

Tool schemas must be context-bound. All tools derive requester, source,
destination, conversation, and tenant/workspace authority from runtime context.

### rememberForRequester

`rememberForRequester` may accept:

- content
- optional expiration duration/date

`rememberForRequester` must not accept:

- requester id
- actor id
- Slack team id
- Slack channel id
- Slack thread timestamp
- arbitrary conversation id
- arbitrary owner id
- arbitrary scope enum
- arbitrary subject id
- arbitrary subject display name
- arbitrary subject enum
- raw source metadata

The tool stores a public/shareable first-person memory about the current
requester. Tool selection is the memory agent's subject decision; runtime
context derives source, requester, destination, stored scope, and subject ids.
The explicit tool path runs the same idempotency, lifecycle, embedding, and
storage validation paths as passive extraction. Explicit tool requests are
still subject to install-level memory policy.

For `personal` scope, `rememberForRequester` may store only public/shareable
first-person facts authored by the current requester. It must reject attempts
to create another person's personal memory, such as storing `David is xyz` as a
personal memory when the current requester is not David. Third-person facts may
be stored only as conversation-scoped operational knowledge when policy allows
them.

### rememberForConversation

`rememberForConversation` may accept:

- content
- optional expiration duration/date

`rememberForConversation` must not accept:

- requester id
- actor id
- Slack team id
- Slack channel id
- Slack thread timestamp
- arbitrary conversation id
- arbitrary owner id
- arbitrary scope enum
- arbitrary subject id
- arbitrary subject display name
- arbitrary subject enum
- raw source metadata

The tool stores public/shareable operational knowledge for the active
conversation. Tool selection is the memory agent's subject decision; runtime
context derives all channel, thread, scope, source, and subject ids. It must
not be used to create another person's personal profile memory.

The plugin derives stored scopes and subjects from runtime context and the
agent/extractor decision. In the first explicit storage slice,
`rememberForRequester` writes personal `user` subject memories for the current
requester, and `rememberForConversation` writes conversation subject memories
for the active conversation. The model cannot provide arbitrary scope enums,
subject ids, Slack user ids, display names, aliases, or subject classes.

Content eligibility is an agentic policy decision, not a deterministic regex
classifier. The fact that a user explicitly asked Junior to remember something
can satisfy the "explicit request" category, but it must not bypass:

- secret rejection by the agent/policy adjudicator
- source and scope rules
- workplace-sensitive category rejection by the agent/policy adjudicator
- public-content restrictions
- provider and embedding policy
- retention and lifecycle policy

If policy rejects an explicit memory request, the tool should return a
model-visible input error that explains the rejection at a high level without
echoing sensitive content.

### removeMemory

`removeMemory` accepts a memory id or short id prefix and archives only a memory
visible in the current context.

Ambiguous short prefixes must fail with a model-visible input error rather than
removing multiple rows.

### listMemories

`listMemories` lists only active memories visible in the current context. It
may accept an optional limit, but it must not search across unrelated users or
conversations. Current install policy must be applied before returning results.

The tool may include ids or short ids because explicit removal workflows need a
handle. Normal automatic memory injection should avoid ids.

### searchMemories

`searchMemories` is the model-visible recall path when automatic memory
injection is disabled, and it can supplement automatic recall when the model
needs a targeted lookup.

`searchMemories` may accept:

- query text
- optional limit

`searchMemories` must not accept:

- requester id
- actor id
- Slack team id
- Slack channel id
- Slack thread timestamp
- arbitrary conversation id
- arbitrary owner id
- arbitrary scope override

The tool derives visible scopes from runtime context, applies current install
policy, and runs the same retrieval pipeline as automatic memory injection.
Results must be active, visible, policy-allowed memories only.

Unlike `listMemories`, `searchMemories` is relevance-ranked and does not need
to return every visible memory. It may omit ids unless the model needs a handle
for a follow-up `removeMemory` request.

## Output Rules

Tool output must be concise and must not reveal hidden private metadata. For
private conversations, tool output may contain memory content because it is
model-visible response context, but logs/traces/reporting for that tool must
redact content according to [`../data-redaction-policy.md`](../data-redaction-policy.md).

## Related Specs

- `./index.md`
- `./policy.md`
- `./storage.md`
- `./retrieval.md`
- `./admin.md`
- `../plugin-prompt-hooks.md`
- `../data-redaction-policy.md`
