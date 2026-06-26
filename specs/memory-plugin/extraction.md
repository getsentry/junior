# Memory Plugin Extraction

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-20

## Purpose

Define passive memory learning through completed-session plugin background
tasks.

## What Belongs In Memory

A stored memory is a self-contained assertion that can improve future
assistance without requiring the original conversation.

A candidate may be stored only when all of these are true:

1. Install-level memory policy allows this category, scope, and source.
2. It is a public/shareable concrete fact, preference, relationship, durable
   project fact, durable workflow preference, or explicit user request to
   remember something.
3. It is useful beyond the current turn or has an explicit expiration.
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

The memory plugin learns passively from its `extractMemories`
`session.completed` plugin background task. Junior core schedules registered
plugin tasks after successful completed sessions; the memory plugin owns the
memory-specific decision about whether that completed session is learnable.

Core scheduling must:

1. Run only after the user-visible turn is durably committed enough that
   scheduling failure cannot fail delivery.
2. Enqueue the registered `extractMemories` plugin background task for the
   completed session.
3. Use a stable task id derived from the plugin, task name, and
   completed-session reference.

The task params must contain stable references and safe metadata only. They must
not contain raw private user text, raw assistant text, raw tool payloads,
credentials, or tokens. Core owns how the task is delivered through the generic
plugin background task contract.

Core must not require plugin code to know queue topic names, queue message
shape, Vercel-specific APIs, callback routes, visibility timeouts, or
acknowledgement semantics.

## Extraction Task Handler

The memory plugin's `extractMemories` task handler must:

1. Reload the bounded completed-session projection through
   `ctx.session.load()`.
2. Reload current install-level memory policy.
3. Skip extraction when passive extraction is disabled, the source is not
   learnable, the source is private, the source conversation is not classified
   as public by Junior's existing conversation privacy/destination visibility
   contracts, or the bounded session projection is unavailable, expired,
   malformed, or no longer visible to the plugin.
4. Process only that completed turn.
5. Extract candidate facts with a structured model output contract.
6. Ignore assistant-authored claims as memory sources.
7. Run memory agent review for extracted candidates.
8. Reject malformed, low-confidence, incoherent, semantically duplicative,
   unsafe, or out-of-scope facts.
9. Reject facts disallowed by install policy, including non-public or
   workplace-sensitive categories.
10. Convert relative times to absolute dates using `observed_at`.
11. Assign type, subject, scope, and optional expiration.
12. Run centralized secret detection immediately before writing memory rows.
13. Insert accepted memories transactionally.
14. Generate or queue embeddings for accepted rows when configured and allowed
    by policy.
15. Archive expired, superseded, or explicitly removed memories in bounded
    batches.
16. Avoid storing raw extraction prompt, raw model output, or raw turn text
    beyond the accepted memory records.

Extraction tasks must be idempotent. If the same completed turn is observed or
delivered more than once, source idempotency fields must prevent duplicate
memory writes. Semantic duplicate detection belongs in the extractor and
retrieval pipeline, not exact-content storage identity.

The task handler must be safe to run in a separate serverless invocation from
the original user turn. It must not depend on process memory, live Slack
clients, raw HTTP requests, provider tokens, or the model-visible prompt object
from the original run.

## Extraction Rules

Extraction must follow these rules:

1. Extract only from user-authored text.
2. Prefer explicit "remember" requests over inferred passive learning.
3. Store facts, not conversation summaries.
4. Make content self-contained and perspective-neutral.
5. Reject unresolved references such as "that", "it", "the thing", "someone",
   or "somewhere" when the referenced value is not present.
6. Reject negative knowledge such as "the user has not decided yet".
7. Reject assistant/system implementation details.
8. Reject low-utility facts that will not help 30 days later unless they have
   explicit expiration.
9. Assign `context`, `event`, `task`, or `observation` for facts that should
   decay.
10. Treat extraction confidence below the configured threshold as not stored.
11. Reject workplace-sensitive categories disallowed by install policy, such as
    HR/performance, protected-class, health, legal, financial, gossip, or
    coworker speculation.
12. Reject private or sensitive content instead of storing it under personal
    scope.
13. In V1 passive extraction, prefer conversation-scoped operational knowledge
    over personal memory.
14. Personal-scoped memories must be public/shareable first-person facts from
    the current author/requester.
15. Assign `user` subject only for the current author/requester; do not create
    third-party user subjects in V1.
16. Preserve provenance for third-party claims when the source matters for
    correctness.
17. Store the minimum useful assertion rather than a direct quote or broad
    summary.
18. Store ownership, subject, and provenance in structured fields, not content
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
   completed-session task projection.
2. The memory agent reviews each candidate against the installed memory policy
   and workplace guidance.
3. Deterministic validation applies only hard structural rules, such as schema
   shape, runtime-owned authority, source visibility, lifecycle bounds,
   idempotency, and storage constraints before storage.

Memory agent review should receive only the candidate memory, the minimum
source context needed to judge it, and the installed policy guidance. It should
not receive unrestricted transcript history, raw tool payloads, provider
credentials, or unrelated conversation context unless those fields are part of
the bounded extraction input. Prompt inputs should use the same structured
context-block style as Junior's turn context, with separate `<runtime>` and
`<source-context>` blocks. Explicit `createMemory` review uses a singular
`<candidate>` block and the current user-authored message as bounded source
context. Passive extraction may add bounded prior-thread context, such as
compacted thread context or selected user-authored messages, inside the same
`<source-context>` block and batch proposed facts inside `<candidates>`.

Memory agent review output must be structured. It should include:

- candidate id
- decision: `store` or `reject`
- normalized rejection reason code when rejected
- optional adjusted memory type, subject, scope, expiration, or content rewrite

The structured content field is the canonical stored memory text. The memory
agent must use that field to return perspective-neutral fact text. For example,
`I prefer terse PR summaries` should become `Prefers terse PR summaries`, and
`This thread says deploy runbooks live in Notion` should become
`Deploy runbooks live in Notion`.

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

- same source observation id and same extracted fact index
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
- `../data-redaction-policy.md`
