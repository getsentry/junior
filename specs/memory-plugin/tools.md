# Memory Plugin Tools

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-28

## Purpose

Define the explicit model-visible memory management and recall tools exposed by
the memory plugin.

Operator/admin memory commands are covered by [`./admin.md`](./admin.md). They
must not be exposed through this model-visible tool surface.

## Tool Surface

The plugin exposes local memory tools from `tools(ctx)`. Junior prefixes them at
the tools hook boundary before showing them to the model:

```txt
memory_createMemory
memory_removeMemory
memory_listMemories
memory_searchMemories
```

Tool schemas must be context-bound. All tools derive requester, source,
destination, conversation, and tenant/workspace authority from runtime context.

### memory_createMemory

`memory_createMemory` may accept:

- content
- optional `expires_at` expiration selector: exact ISO timestamp, or the
  literal `never` for memories with no expiration. Omission also means no
  expiration.

`memory_createMemory` must not accept:

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

The tool submits one public/shareable memory candidate. The candidate content
must be self-contained natural-language text, such as `I prefer terse status
updates`, while vague references like `remember this` are invalid. The outer
agent provides the candidate text; it does not select storage scope, subject,
or canonical stored content.

Ordinary technical, workflow, communication, tool, language, product,
repository, or project preferences and opinions are valid candidates when the
current requester explicitly asks Junior to remember them. The outer agent
should call `memory_createMemory` for those requests instead of asking the
requester to rephrase them as safer memory text. The memory agent owns the
semantic store-or-reject decision and canonical rewrite.

The outer agent should not call `memory_createMemory` for ordinary organic
statements that merely reveal a durable task, process, project, channel, or
operational fact. Those are passive-learning candidates handled by
completed-session processing, not explicit memory-tool requests. Organic
first-person personal facts should be stored passively only when they are
clearly durable and useful beyond the active task.

The explicit tool path uses runtime context for source and idempotency. It must
run through the memory agent's explicit-create review path. The memory agent
decides store/reject, memory kind, and canonical perspective-neutral content.
The plugin derives the storage target from the reviewed kind: requester for
`preference`, conversation for `procedure` and `knowledge`.

The model cannot provide arbitrary scope enums, subject ids, Slack user ids,
display names, aliases, or subject classes.

Content eligibility is an agentic policy decision, not a deterministic regex
classifier. The fact that a user explicitly asked Junior to remember something
can satisfy the "explicit request" category, but it must not bypass:

- secret rejection by the memory agent
- source and scope rules
- workplace-sensitive category rejection by the memory agent
- public-content restrictions
- provider and embedding policy
- retention and lifecycle policy

If policy rejects an explicit memory request, the tool should return a
model-visible input error that explains the rejection at a high level without
echoing sensitive content.

If memory agent review is unavailable or returns malformed output, the tool
must fail closed and must not write the candidate.

### memory_removeMemory

`memory_removeMemory` accepts a memory id or short id prefix and archives only a
memory visible in the current context.

Ambiguous short prefixes must fail with a model-visible input error rather than
removing multiple rows.

### memory_listMemories

`memory_listMemories` lists only active memories visible in the current context.
It may accept an optional limit, but it must not search across unrelated users
or conversations. Future install policy must be applied before returning results
when that policy surface exists.

The tool may include ids or short ids because explicit removal workflows need a
handle. Normal automatic memory injection should avoid ids.

### memory_searchMemories

`memory_searchMemories` is the model-visible targeted recall path for cases
where the model needs a more specific lookup than automatic recall supplied.

`memory_searchMemories` may accept:

- query text
- optional limit

`memory_searchMemories` must not accept:

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

Unlike `memory_listMemories`, `memory_searchMemories` is relevance-ranked and
does not need to return every visible memory. It may omit ids unless the model
needs a handle for a follow-up `memory_removeMemory` request.

## Output Rules

Tool output must be concise and must not reveal hidden private metadata. For
private conversations, tool output may contain memory content because it is
model-visible response context, but logs/traces/reporting for that tool must
redact content according to [`../data-redaction-policy.md`](../data-redaction-policy.md).
Model-visible memory projections may include the memory id, content,
`createdAtMs`, `observedAtMs`, and optional `expiresAtMs`. They must not include
hidden ownership, source, subject, Slack, actor, or provenance fields.

## Related Specs

- `./index.md`
- `./policy.md`
- `./storage.md`
- `./retrieval.md`
- `./admin.md`
- `../plugin-prompt-hooks.md`
- `../data-redaction-policy.md`
