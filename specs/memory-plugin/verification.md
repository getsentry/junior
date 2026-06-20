# Memory Plugin Verification

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-20

## Purpose

Define the memory plugin's failure model, observability rules, and verification
requirements.

## Failure Model

1. Missing required SQL database: startup and `junior upgrade` fail according
   to [`../plugin-database.md`](../plugin-database.md).
2. Unapplied memory migrations: plugin hooks do not run; startup fails for the
   required plugin.
3. Missing embedding provider: memory write and lexical recall still work;
   vector recall and embedding repair are disabled.
4. Embedding provider failure: store the memory row, log safe metadata, and
   leave the row eligible for repair.
5. Embedding dimension mismatch: reject the embedding row, log safe metadata,
   and continue without vector recall for that memory.
6. `userPrompt` retrieval failure: omit memory contribution, log safe metadata,
   and continue unless the failure indicates a broken required migration.
7. Prompt message validation failure: omit the prompt message.
8. `observeTurn` enqueue failure: log safe metadata and do not fail the
   completed turn.
9. Task delivery failure: core retries according to the task runner policy.
10. Task retry bound exceeded or observation payload expired: mark or drop the
    task with safe metadata; do not fail the completed user turn.
11. Duplicate post-turn observation or duplicate task delivery: task
    idempotency and source idempotency suppress duplicate stored memories.
12. Secret detection match: reject the write with a model-visible tool input
    error for explicit tools or drop the passive fact with safe logging.
13. Visibility mismatch: fail closed and omit the memory.
14. Malformed stored rows: ignore the row for recall/list, log safe metadata,
    and leave repair to a future administrative workflow.

## Observability

Logs and spans may include:

- plugin name
- hook name
- memory operation name
- memory id or bounded id prefix
- scope type
- subject type
- memory type
- embedding provider/model/dimensions
- extracted candidate fact count
- accepted/rejected fact counts
- rejection reason code
- duration
- outcome

Logs and spans must not include:

- raw memory content
- raw private conversation text
- extraction prompt text
- model extraction output
- SQL parameter values containing user data
- provider credentials
- authorization URLs
- Slack tokens
- raw tool arguments or results for private conversations

Use `app.*` attributes for memory-specific telemetry when no OpenTelemetry
semantic key exists.

## Verification

Use integration tests for:

- memory plugin packaged storage migrations are discovered and applied through
  `junior upgrade`
- storage migrations provide the authoritative memory-record mechanism required
  by the first storage slice in `storage.md`
- explicit memory creation stores a personal memory under the current requester
- explicit conversation memory stores under the current conversation without
  accepting model-supplied Slack ids
- explicit personal user-subject memory can be created only for the current
  requester/author
- explicit personal memory rejects third-party user profile facts such as
  storing `David is xyz` on David's behalf
- explicit memory creation is rejected when it violates install policy or
  workplace-sensitive category rules
- install policy can disable passive extraction without disabling explicit
  memory tools
- install policy can disable automatic memory injection without disabling
  explicit memory tools
- install policy can reject workplace-sensitive passive facts
- stricter current policy hides previously stored memories from automatic memory
  injection and list/search results
- `listMemories` returns only memories visible in the current context
- `searchMemories` returns only relevant memories visible in the current
  context
- `searchMemories` cannot search across unrelated users or conversations
- `removeMemory` archives only visible memories
- `userPrompt` injects visible memories into each fresh triggering prompt when
  `autoInjectMemories` is `true`
- `userPrompt` returns no memory contribution when `autoInjectMemories` is
  `false`
- memory recall survives a follow-up prompt without requiring a search tool when
  automatic memory injection is enabled
- memory recall works through `searchMemories` when automatic memory injection
  is disabled
- lexical recall works when embeddings are unavailable
- vector recall works after embedding rows are created
- embedding failures leave memories listable and lexically recallable
- private conversation memory content is absent from logs, traces, and
  dashboard reporting payloads
- passive `observeTurn` enqueues an extraction task without failing delivery
- extraction task payloads contain references rather than raw private text
- extraction task handlers can run in a separate worker invocation
- policy adjudication rejects extracted candidates that violate installed
  workplace policy
- malformed or failed policy adjudication fails closed for passive extraction
- duplicate observation or task delivery of the same turn stores accepted
  memories once

When the future admin CLI is implemented, use integration tests for:

- admin CLI commands default to redacted output
- full content display requires explicit operator flags
- admin repair reports counts and ids without making policy-hidden memories
  visible

Use unit tests for:

- memory type, scope, and subject parsers
- install policy parser and policy evaluation predicates
- secret detection
- storable-fact validation
- explicit-tool policy filtering
- policy adjudication output parsing
- TTL calculation
- visibility predicates
- semantic duplicate detection
- prompt contribution formatting bounds
- tool schema rejection of actor, destination, team, channel, and conversation
  fields
- embedding provider response validation
- lexical/vector result fusion

Use evals for:

- explicit "remember this" behavior
- later recall of stored preferences or facts
- use of `searchMemories` when automatic memory injection is disabled
- refusal to remember secrets
- explicit create rejection for policy-disallowed workplace-sensitive facts
- refusal or policy rejection for workplace-sensitive facts
- passive extraction quality once the extraction task is implemented
- model use of current user corrections over stale memories

## Related Specs

- `./index.md`
- `./policy.md`
- `./storage.md`
- `./security.md`
- `./retrieval.md`
- `./extraction.md`
- `./tools.md`
- `./admin.md`
- `../testing.md`
