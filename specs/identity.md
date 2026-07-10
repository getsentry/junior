# Identity Spec

## Metadata

- Created: 2026-06-05
- Last Edited: 2026-06-10

## Purpose

Define how Junior carries human, system, delegated, destination, and display identity through chat turns, scheduled work, plugin dispatch, credential resolution, conversation history, and Slack side effects.

## Scope

- Current user actors and system actors.
- Service-principal and install-owned credential identities.
- Slack message authors, actors, task creators, and conversation managers.
- Delegated credential subjects for stored user OAuth lookup.
- Destination identity for platform conversations, dispatch records, sandbox sessions, and context-bound tools.
- Identity context carried through ingress, queue work, callbacks, dispatch records, scheduler tasks, sandbox egress, and conversation state.

## Non-Goals

- Provider-specific permission envelopes beyond how they receive the current actor and optional credential subject.
- Slack profile lookup rules beyond the identity data required by runtime behavior.
- Workspace membership and channel access policy not already owned by Slack runtime specs.
- Human-facing naming style beyond separating display labels from authority.

## Terms

- **Identity context:** the runtime-owned bundle of current actor, destination, optional credential subject, and correlation ids carried across a behavior boundary.
- **Actor:** the current authority for behavior. An actor is either a user actor or a system actor.
- **User actor:** the human currently asking Junior to act.
- **System actor:** a named Junior-owned execution authority, such as `scheduler` or a plugin dispatch actor.
- **Run actor:** the single actor a run executes as (see `multi-actor-runs.md`). "Requester" is retired vocabulary for this concept; the codebase-wide rename is complete (#786).
- **Author:** the actor metadata persisted with a conversation message for transcript attribution.
- **Creator:** audit and notification metadata for durable objects such as scheduled tasks. Creator is not automatically the actor for later execution.
- **Credential subject:** an explicit subject used only to choose a stored user OAuth token. It is not the current actor and does not grant actor semantics.
- **Service principal:** a provider credential identity owned by the installation, app, or operator environment. It is not a user actor and must be selected by the current actor's credential envelope.
- **Destination identity:** the Slack conversation, dispatch destination, sandbox session, or artifact scope where behavior executes.
- **Display identity:** profile fields shown to humans. Display identity is presentation data, not authority.

## Contracts

### Identity Context

Every behavior that can read credentials, perform side effects, send platform output, run tools, dispatch work, or mutate durable state must have explicit identity context.

The current actor must be a real user actor or a named system actor. Synthetic ids such as `unknown`, empty strings, whitespace-padded ids, previous message authors, task creators, Slack display names, and destination membership are not valid substitutes for actor context.

### Boundary Parsing

Untrusted external data is parsed once at the boundary that receives it:

- Slack ingress and Slack adapter payloads parse Slack user ids before creating internal work.
- Local CLI parses local session ids and actor configuration before creating internal work.
- Plugin APIs parse plugin-provided credential subjects before binding or persisting them.
- Signed callback and sandbox egress contexts verify signatures and parse actor payloads before issuing credentials.

Boundary parsing accepts only exact identifiers. It must not trim, rewrite, or otherwise repair a malformed actor id into a usable one.

### Owned State

After Junior persists, signs, or dispatches identity context, downstream runtime code treats that context as owned state. Owned state must be asserted exactly. Runtime reads must not normalize malformed actor ids into valid ones.

Invalid owned identity state is a broken contract. The correct outcome is fail closed, block, or surface an operational error, not continue with a guessed actor.

### Role Separation

The current actor controls the permission envelope for behavior.

Actor, author, creator, actor, credential subject, service principal, destination, and display identity are separate fields with separate meanings:

- An actor authorizes current behavior.
- A persisted author attributes a conversation message.
- A creator explains who made or confirmed a durable object.
- A credential subject selects a stored user OAuth token only when the current actor contract allows delegated credentials.
- A service principal supplies install-owned or app-owned provider access when allowed for the current actor.
- A destination tells Junior where to post or which context-bound tool target to use.
- A display name is never an authorization principal.

Copying one role into another is allowed only where a spec names that exact transition.

Junior-owned provider resources should use Junior's service-principal identity
when the provider supports one. Human identity is an explicit exception for
operations whose meaning is inherently personal, such as approving a pull
request. Requester, creator, author, and contributor metadata may credit a
human without changing the credential principal that executes the operation.

### System Actors

System actors are first-class actors, not absent users. They must have stable names and explicit credential envelopes.

System actors do not imply a human actor, do not start interactive auth flows, and do not inherit creator or channel-member credentials. They may use service-principal or install-owned credentials only when the provider broker explicitly supports that system actor envelope.

If a system actor needs a stored user OAuth token, the run must carry an explicit delegated credential subject allowed by the relevant spec. That subject still does not become the actor.

### Scheduler And Dispatch

Scheduled runs execute as a Junior system actor, not as the user who created the task. Creator metadata may be used for audit and private notification, but not as actor identity.

Plugin dispatch also executes as a system actor unless a future spec defines a different actor model. Plugin metadata and idempotency keys are correlation data, not actor sources.

Scheduled tasks and plugin dispatches may carry an explicit delegated user credential subject only under the Slack private direct conversation exception defined by the scheduler and dispatch specs. That subject is not the actor.

### Local CLI

Local CLI runs must use explicit local identity context and must not fabricate
Slack identity state.

First implementation rules:

1. Local CLI runs execute as the named Junior system actor `local-cli`.
2. Local CLI runs do not have a Slack actor unless they are replaying a
   verified Slack-originated continuation, which ordinary local chat does not do.
3. Local CLI destination identity uses a local conversation/session id, not a
   Slack channel id or Slack thread timestamp.
4. Local CLI must disable interactive OAuth and Slack private auth flows until a
   separate local user/auth contract exists.
5. If a future local mode needs user-bound credentials, it must introduce an
   explicit non-Slack user actor and credential-subject contract instead of
   reusing Slack actor fields.

### Turn Continuation Actor Identity

A turn continuation resumes the same actor turn in a later execution context
(timeout resume, auth resume). Actor identity for a continuation MUST be
reconstructed from the durable turn session record, not from a new Slack profile
lookup.

At the start of a Slack turn the actor identity resolved at the Slack
boundary is persisted in `AgentTurnSessionRecord.actor`. That stored
actor is owned state for the lifetime of the turn. Continuation endpoints
MUST reconstruct runtime `Actor` state from this stored actor when
resuming.

Canonical stored Slack actors include `platform: "slack"`, `teamId`,
`slackUserId`, and optional display/contact fields. Continuation endpoints MUST
assert stored `teamId` and `slackUserId` against the active source and
turn author when those fields are present. Legacy stored actors without
`teamId` may reuse display/contact fields only after the stored `slackUserId`
matches the turn author; the runtime actor still uses the active source
team id.

Continuation endpoints MUST NOT call live Slack actor helpers such as
`lookupSlackActor` to re-derive actor display or contact fields.
Those helpers are fresh-turn boundary resolution paths. Re-querying Slack during
continuation creates a dependency on external profile availability that can cause
actor display and contact fields to disappear across serverless invocations.

If a session record does not contain stored actor display or contact fields
(for example, records that predate this contract), the continuation proceeds
with actor id only and no recovered display fields. It MUST NOT perform a live
Slack lookup to repair missing fields.

Fresh OAuth replay (`resumePendingOAuthMessage`) is not a turn continuation for
this purpose. It replays the user's original message after OAuth connection and
is treated as a fresh turn that may resolve identity through the normal live
Slack boundary path.

### Conversation History

User-authored conversation messages must carry exact author identity when they are committed to durable state. Conversation rendering may sanitize display labels so platform ids are not shown as names, but it must not repair or reinterpret stored author ids.

Prompt context must preserve who is asking now versus who authored prior messages. A later user in the same Slack thread becomes the current actor for the new turn without changing attribution for earlier messages.

Run-level attribution of the distinct actors that originated instruction-authority input to a run (`run.actors`) is derived from this per-message provenance and specified in `multi-actor-runs.md`. It is attribution only and never an authority source.

The durable Pi session log records per-message provenance (`{ authority: "instruction" | "context", actor?: Actor }`) aligned one-to-one with the committed messages, rather than a single latest-wins requester. User-authored turn input is an `instruction` attributed to its own actor; synthetic or system-originated user-role messages (authorization observations, compaction summaries, plugin dispatch) are unattributed `context`. Actors are platform-neutral identity values (today's `Requester` type) so Slack and local identities are preserved. Legacy entries without provenance decode as unattributed context, and misaligned provenance fails closed rather than being zipped or truncated. `AgentTurnSessionRecord` persists this provenance aligned to `piMessages`.

### Slack Side Effects

Actor-sensitive Slack side effects, including ephemeral responses and OAuth continuations, must use the current actor id from turn context. They must not fall back to channel id, bot id, last human author, task creator, or display profile fields.

Destination-sensitive Slack side effects must use runtime-owned destination context. Model arguments may not override context-bound destinations unless a separate spec allows it.

## Failure Model

- Missing or malformed actor id at ingress rejects the payload or records a terminal failure for that work item.
- Missing identity context in an internal call is a programming error.
- Malformed actor identity in owned state fails closed and should be investigated or migrated explicitly.
- Missing display identity may degrade presentation only; it must not change the actor id or credential subject.
- Missing delegated user credentials block the run or start the approved private auth flow only when the current actor model permits it.
- Missing system-actor credential envelopes block system work rather than falling back to a creator, last author, or actor-shaped user.

## Observability

Logs and spans may include safe identity dimensions needed for debugging:

- actor type and id
- credential subject type and user id when present
- service-principal or provider credential class when present
- destination platform and conversation id
- creator user id for scheduled-task audit

Logs and spans must keep these roles distinct. They must not include OAuth tokens, provider credentials, raw authorization URLs, Slack tokens, prompt text, private tool payloads, or raw conversation state.

## Verification

Use integration tests for behavior that crosses real runtime boundaries:

- Slack ingress persists the real actor/author identity and rejects synthetic or malformed actor ids.
- Slack DM and channel paths preserve the current actor through first delivery, retry, and continuation.
- Turn continuation identity: seed a session record with `AgentTurnSessionRecord.actor` containing Slack user id, username, full name, and email; resume through a continuation endpoint while making live Slack profile lookup unavailable; verify the resumed turn receives actor identity from the stored session record and that no live Slack lookup is performed.
- Workspace-scoped actor identity: seed a session record with canonical Slack actor state containing `platform`, `teamId`, and `slackUserId`; resume through a continuation endpoint; verify mismatched stored team or user ids fail closed.
- Absent continuation identity: when a continuation session record has no stored actor display or contact fields, verify the resumed turn proceeds with actor id only and does not attempt a live Slack lookup.
- Scheduler dispatch runs with a system actor and does not use creator identity as actor.
- Plugin dispatch carries a system actor through callback, retry, continuation, credential context, and Slack delivery.
- Private direct scheduled tasks may carry an explicit credential subject; group, private channel, public channel, and unknown-audience tasks may not.
- Sandbox egress and credential injection reject signed contexts with malformed actors or subjects.
- System actors use only explicit service-principal, install-owned, or delegated credential envelopes.
- Actor-sensitive Slack side effects use the current actor id.

Use unit tests for small parsing, signing, and assertion helpers.

Use evals only when the contract depends on model interpretation, such as preserving current actor semantics in natural-language follow-up handling.

## Related Specs

- `./chat-architecture.md`
- `./multi-actor-runs.md`
- `./task-execution.md`
- `./local-agent.md`
- `./agent-turn-handling.md`
- `./slack-agent-delivery.md`
- `./slack-outbound-contract.md`
- `./credential-injection.md`
- `./scheduler.md`
- `./plugin-dispatch.md`
- `./harness-tool-context.md`
- `./testing.md`
- `../policies/context-bound-systems.md`
