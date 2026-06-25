# Memory Plugin Extraction

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-24

## Purpose

Define passive memory learning through completed agent-run session processing
and the memory-owned internal extraction agent.

## What Belongs In Memory

A stored memory is a self-contained assertion that can improve future
assistance without requiring the original conversation.

A candidate may be stored only when all of these are true:

1. Install-level memory policy allows this category, scope, and source.
2. It is a public/shareable concrete fact, preference, relationship, durable
   project fact, durable workflow preference, or explicit user request to
   remember something.
3. It is useful beyond the current request/session or has an explicit
   expiration.
4. It is understandable without unresolved pronouns or hidden conversation
   context.
5. It has a runtime-derived source actor and source conversation.
6. It has a runtime-derived visibility scope.
7. It contains no credential, token, private key, password, recovery code,
   connection string with credentials, payment card number, or similar secret.
8. It is not merely an assistant claim, assistant action, tool result summary,
   system capability, implementation detail, or prompt/routing rule.
9. Personal-scoped identity, preference, or relationship facts are first-person
   facts authored by the current requester, not third-person profile facts
   about someone else.
10. It has a valid subject type: `user` for the current requester,
    `conversation` for the current conversation, or `general` for public
    operational/domain knowledge.

Examples that can be stored:

- `Prefers concise technical answers.`
- `Production deploy window is Mondays from 10:00 to 12:00 UTC.`
- `Incident follow-up lives in Linear.`
- `The Acme migration is paused.`

Examples that must not be stored:

- `The assistant searched GitHub.`
- `The user asked a question about the memory system.`
- `The OAuth token is xoxb-...`
- `David is on the billing team.` when proposed as David's personal memory by
  someone other than David
- `The requester prefers concise technical answers.`
- `My favorite CLI QA snack is mango chips.`
- `This thread says incident follow-up lives in Linear.`
- `The user is somewhere next week.`
- `The user has not decided what to do.`
- `Junior can use the scheduler plugin.`

## Passive Learning

The memory plugin processes completed agent-run sessions through a typed
`session.completed` plugin task. Conceptually this is a memory compaction pass:
the task loads a bounded completed-session projection and asks the memory-owned
extraction agent which durable public/shareable facts, if any, should survive
as long-term memory.

The `processSession` task must:

1. Run only after the user-visible agent run is delivered and the completed
   session record is durably committed enough that task failure cannot fail
   delivery.
2. Receive task params that contain stable references only, such as
   `conversationId` and `sessionId`. Params must not duplicate raw messages,
   source, destination, requester, tool payloads, or model output.
3. Load a bounded core-owned session projection from transcript/session storage.
   The projection may include user-authored messages, assistant reply text, and
   successful tool-call names, but not raw Pi internals, full transcript
   history, private tool arguments/results, provider credentials, or unrelated
   conversation context.
4. Skip passive extraction for unsupported sources. V1 supports local CLI
   sessions and `pub` sources with a stable source key. Non-local `priv`
   sources and sources without stable identity are ignored before model
   extraction.
5. Skip passive extraction when the completed session already called an
   explicit memory mutation tool (`createMemory` or `removeMemory`). Recall
   tools (`listMemories` and `searchMemories`) must not suppress passive
   extraction.
6. Provide visible existing memories as dedupe context only, not as source
   evidence for new memories.
7. Ignore assistant-authored claims as memory sources.
8. Extract candidate facts with a structured model output contract.
9. Reject malformed, incoherent, unsafe, out-of-scope, redundant, or
   non-durable facts.
10. Assign requester or conversation target from memory-agent output, while
    deriving all authority-bearing ids from runtime context.
11. Insert accepted memories idempotently with a stable key derived through the
    runtime source helper, completed session reference, and extracted fact
    content.
12. Generate embeddings for accepted rows when the host embedder is configured.
13. Avoid storing raw extraction prompt, raw model output, or raw session text
    beyond the accepted memory records.

Plugin tasks are best effort and at least once. If extraction or storage fails,
Junior logs safe metadata, retries according to core task policy, and the
completed user-visible run remains successful. Duplicate task delivery must not
create duplicate memories.

## Extraction Rules

Passive session extraction must follow these rules:

1. Extract only from user-authored text.
2. Prefer explicit `createMemory` tool writes over inferred passive learning.
3. Store facts, not conversation summaries.
4. Make content self-contained and perspective-neutral.
5. Reject unresolved references such as "that", "it", "the thing", "someone",
   or "somewhere" when the referenced value is not present.
6. Reject negative knowledge such as "the user has not decided yet".
7. Reject assistant/system implementation details.
8. Reject low-utility facts that will not help 30 days later unless they have
   explicit expiration.
9. Reject workplace-sensitive categories, such as
   HR/performance, protected-class, health, legal, financial, gossip, or
   coworker speculation.
10. Reject private or sensitive content instead of storing it under personal
    scope.
11. In V1 passive extraction, prefer conversation-scoped operational knowledge
    over personal memory unless the user makes a clear first-person statement.
12. Personal-scoped memories must be public/shareable first-person facts from
    the current author/requester.
13. Assign `user` subject only for the current author/requester; do not create
    third-party user subjects in V1.
14. Preserve provenance for third-party claims when the source matters for
    correctness.
15. Store the minimum useful assertion rather than a direct quote or broad
    summary.
16. Store ownership, subject, and provenance in structured fields, not content
    prose. Remove requester names, display names, `the requester`, `the user`,
    `I`, `my`, thread labels, channel labels, and source labels from accepted
    content.

The plugin must route extracted candidates through the memory agent before
storage. The extraction prompt is guidance, not the security boundary.

## Memory Agent Review

The memory agent is the shared internal semantic system for explicit
`createMemory` candidates and passive extraction candidates. Passive extraction
may use separate generate-and-review model calls internally, but both steps
belong to the memory agent rather than a caller-provided policy hook.

The default V1 passive-extraction shape is:

1. The memory agent proposes structured candidate memories from the bounded
   completed-session projection.
2. The memory agent accepts only candidates that satisfy public/shareable memory
   guidance.
3. Deterministic validation applies only hard structural rules, such as schema
   shape, runtime-owned authority, source visibility, lifecycle bounds,
   idempotency, and storage constraints before storage.

Memory agent review should receive only the candidate memory or bounded
completed-session text, the minimum source context needed to judge it, and
public/shareable memory guidance. It should not receive unrestricted transcript
history, raw tool
payloads, provider credentials, or unrelated conversation context unless those
fields are part of the bounded extraction input. Prompt inputs should use the
same structured context-block style as Junior's run context, with separate
`<runtime>` and source blocks. Explicit `createMemory` review uses a singular
`<candidate>` block and the current user-authored message as bounded source
context. Passive extraction uses the completed session's bounded user-authored
messages plus visible existing memories for dedupe. Existing memories must not
be used as source evidence for new facts.

The memory agent model is host-owned but selected by the memory plugin. An
explicit `createMemoryPlugin({ modelId })` option wins, then `AI_MEMORY_MODEL`,
then the host structured-model default. Model choice is an implementation
tuning knob; runtime context, source authority, and storage validation remain
the boundary.

Memory agent output must be structured. For explicit review it should include:

- decision: `store` or `reject`
- normalized rejection reason code when rejected
- optional adjusted memory type, subject, scope, expiration, or content rewrite

For passive extraction it should include an array of accepted candidate
memories with target, canonical stored content, and optional expiration.
Requester-target passive memories in V1 focus on durable first-person
preferences, opinions, and habits. Broader public requester facts can still be
handled by the explicit reviewed `createMemory` path. Rejections are
represented by omitting a candidate from the array.

The content field is canonical stored memory text. Requester memory content
must omit ownership from prose because ownership lives in structured metadata.
For example, `I prefer terse PR summaries` should become requester memory
`Prefers terse PR summaries`, and `This thread says deploy runbooks live in
Notion` should become conversation memory `Deploy runbooks live in Notion`.

The memory agent may narrow, rewrite, or reject extracted candidates, but it
may not override hard structural validators. If extraction and review disagree,
the stricter outcome wins. If the memory agent fails or returns malformed
output, the candidate is rejected unless it came from an explicit tool
workflow that can return a model-visible retryable error.

## Secret Rejection

Every entry point must use the same policy guidance before writing memory
content:

- `createMemory`
- passive extraction
- repair/import workflows
- tests and fixture helpers that create real memory records

Explicit tools may use explicit user intent as a policy input, but they do not
bypass the policy guidance. Secret handling may use a dedicated scanner as a
hard safety backstop, but scanner matches are not a substitute for agentic
memory eligibility decisions.

The policy guidance must reject at least:

- API keys and access tokens
- Slack tokens
- passwords and passphrases
- private keys
- recovery codes and MFA codes
- credit card numbers
- Social Security numbers
- connection strings with embedded credentials

If a user explicitly asks Junior to remember a secret, the correct behavior is
a model-visible rejection, not storage with a special classification.

## Duplicate And Supersession Rules

Duplicate prevention is required before insertion where the relevant signal is
available:

- same source, completed session reference, and extracted fact index
- high lexical or embedding similarity to an active memory in the same scope

V1 storage enforces source/fact idempotency. Exact normalized-content equality
is not a durable identity for memory facts and must not be the only duplicate
suppression strategy.

Supersession is allowed when a new memory clearly replaces an old memory in the
same scope, such as a changed preference. Superseded memories remain archived
in place and are excluded from recall and list results unless explicitly
requested by an administrative repair workflow.

V1 may implement conservative supersession only. If conflict is uncertain,
store the new fact without archiving the old one or skip the new fact; do not
guess.

## Related Specs

- `./index.md`
- `./policy.md`
- `./storage.md`
- `./security.md`
- `../plugin-prompt-hooks.md`
- `../plugin-tasks.md`
- `../data-redaction-policy.md`
