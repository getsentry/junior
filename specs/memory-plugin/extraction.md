# Memory Plugin Extraction

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-20

## Purpose

Define passive memory learning through completed-turn observation and plugin
background tasks.

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

- `User prefers concise technical answers.`
- `User's production deploy window is Mondays from 10:00 to 12:00 UTC.`
- `The #infra conversation uses Linear for incident follow-up.`
- `User wants Junior to remember that the Acme migration is paused.`

Examples that must not be stored:

- `The assistant searched GitHub.`
- `The user asked a question about the memory system.`
- `The OAuth token is xoxb-...`
- `David is on the billing team.` when proposed as David's personal memory by
  someone other than David
- `The user is somewhere next week.`
- `The user has not decided what to do.`
- `Junior can use the scheduler plugin.`

## Passive Learning

The memory plugin observes completed turns through `observeTurn(ctx)`.

The observation hook must:

1. Run only after the user-visible turn is durably committed enough that
   observation failure cannot fail delivery.
2. Enqueue one plugin background task for extraction from the completed turn.
3. Ignore assistant-authored claims as memory sources.
4. Skip task enqueueing when the source is not allowed to expose private turn
   text to the trusted memory plugin.
5. Skip task enqueueing when install policy disables passive extraction for the
   current source, scope, or requester.
6. Skip task enqueueing unless the source conversation is classified as
   `public` by Junior's existing conversation privacy/destination visibility
   contracts.
7. Use a stable idempotency key derived from the completed turn or source event.

The observation hook does not perform extraction inline. It requests work from
core:

```ts
await ctx.tasks.enqueue({
  name: "extractMemories",
  idempotencyKey: ctx.observationId,
  payload: {
    observationId: ctx.observationId,
  },
});
```

The payload must contain stable references and safe metadata only. It must not
contain raw private user text, raw assistant text, raw tool payloads,
credentials, or tokens. Core owns how the task is delivered: the existing
serverless queue, a signed callback, a future dedicated task worker, or a local
test worker are all valid implementations.

Core must not require plugin code to know queue topic names, queue message
shape, Vercel-specific APIs, callback routes, visibility timeouts, or
acknowledgement semantics.

## Extraction Task Handler

The memory plugin's `extractMemories` task handler must:

1. Reload the bounded observation payload for the referenced completed turn
   through `ctx.observation.load()`.
2. Reload current install-level memory policy.
3. Process only that completed turn.
4. Extract candidate facts with a structured model output contract.
5. Ignore assistant-authored claims as memory sources.
6. Skip extraction when the bounded observation payload is unavailable,
   expired, malformed, or no longer visible to the plugin.
7. Run policy adjudication for extracted candidates.
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
retrieval slices, not exact-content storage identity.

The task handler must be safe to run in a separate serverless invocation from
the original user turn. It must not depend on process memory, live Slack
clients, raw HTTP requests, provider tokens, or the model-visible prompt object
from the original run.

## Extraction Rules

Extraction must follow these rules:

1. Extract only from user-authored text.
2. Prefer explicit "remember" requests over inferred passive learning.
3. Store facts, not conversation summaries.
4. Make content self-contained.
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

The plugin must have a deterministic post-extraction validation layer. The
extraction prompt is guidance, not the security boundary.

## Policy Adjudication

Policy enforcement may use a second model call after extraction. This should be
the default V1 shape when passive extraction is enabled:

1. The extraction model proposes structured candidate memories from the bounded
   observation payload.
2. A policy adjudicator, typically the configured fast/auxiliary model, reviews
   each candidate against the installed memory policy and workplace guidance.
3. The deterministic validator applies hard rules and rejects anything unsafe or
   malformed before storage.

The policy adjudicator should receive only the candidate memory, the minimum
source context needed to judge it, and the installed policy guidance. It should
not receive unrestricted transcript history, raw tool payloads, provider
credentials, or unrelated conversation context.

Policy adjudication output must be structured. It should include:

- candidate id
- decision: `allow` or `reject`
- normalized rejection reason code when rejected
- optional adjusted memory type, subject, scope, expiration, or content rewrite
- confidence

The adjudicator may narrow, rewrite, or reject extracted candidates, but it may
not override hard validators. If extraction and policy adjudication disagree,
the stricter outcome wins. If the policy adjudicator fails or returns malformed
output, the candidate is rejected unless it came from an explicit tool workflow
that can return a model-visible retryable error.

## Secret Rejection

Every entry point must call the same secret detector before writing memory
content:

- `createMemory`
- passive extraction
- repair/import workflows
- tests and fixture helpers that create real memory records

Every entry point must also run the same deterministic policy filter before
writing memory content. Explicit tools may use explicit user intent as a policy
input, but they do not bypass the filter.

The detector must reject at least:

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
