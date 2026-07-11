# Multi-Actor Runs Spec

## Metadata

- Created: 2026-07-07
- Last Edited: 2026-07-11

## Purpose

Define how a single run represents instruction input that originates from more
than one actor. A run executes as exactly one actor — its authority — but the
actors who contribute instructions to that run, through active steering or asks
batched before the turn started, are not always the same. This spec defines the
attribution model for those contributors, the membership semantics of the
contributor set, and the naming contract that separates attribution from
authority.

## Scope

- Run-level attribution of instruction-authority input to the actors that
  originated it (`run.actors`).
- Membership semantics: when an actor joins the set, ordering, and distinctness.
- The relationship between attribution and authority, and the terms that keep
  them separate.
- Exposure of the attribution set on the turn session record and the plugin run
  context.

## Non-Goals

- Changing run authority. A run still executes as one actor; this spec never
  introduces multi-actor authority.
- Credential issuance, credential-subject selection, memory scope ownership, or
  any permission decision. Those are owned by `identity.md` and the
  point-of-action authority model (issue #773 section D).
- Steer-versus-queue routing of cross-actor input. That is a UX optimization and
  must never gate authority; it is out of scope here.
- Reply-phrasing quality when a run blends multiple actors' asks. That is model
  quality, not an attribution contract.

## Terms

- **Actor:** unchanged from `identity.md`. A user or system that originates
  instructions or executes work. There is no separate "requester", "author", or
  "instruction author" concept — those were redundant names for the same thing
  in different positions. "Requester" is retired vocabulary for **run actor**;
  the codebase-wide rename is complete (#786). The only remaining `requester`
  spellings are string literals that decode legacy stored records.
- **Run actor:** the single actor a run executes as (credential binding, auth
  flows). Exposed as `run.actor`. One run, one run actor.
- **Run actors:** all distinct actors annotated on the run's committed
  instruction-authority messages, in first-seen order. Exposed as `run.actors`.
  Usually `[run.actor]`. Attribution only, never authority.
- **Per-instruction actor annotation:** every instruction committed to a run
  carries the actor it came from, via per-message provenance
  (`{ authority: "instruction" | "context", actor?: Actor }`; see `identity.md`,
  Conversation History). `run.actors` is a pure projection of these annotations:
  the distinct `actor` values across messages whose `authority` is
  `instruction`.

## Contracts

### Membership Rule

An actor joins `run.actors` when a message it originated is committed to the run
as **instruction authority**. This happens at the same commit points that record
instruction-authority provenance: turn start, batched parked input draining into
the run, and steering input draining mid-run. Membership is a pure projection of
per-message provenance. When handoff deliberately replaces those messages with
an unattributed summary, the turn-session record carries the already-derived
set across that lossy context boundary; it does not accept new members from the
summary.

### Fail-Closed Identity

An instruction-authority message requires a resolvable actor. Input that cannot
be attributed to a resolvable actor identity is committed as **context
authority** and never joins `run.actors`. There is no guessed or inferred actor:
a missing, malformed, or absent actor yields context authority, not a fabricated
member.

### Distinctness And Order

Distinctness is by identity ids only, never display fields: `platform` +
`teamId` + `userId` for Slack, `platform` + `userId` otherwise. The same actor
appearing under two display profiles collapses to one member. Matching user ids
on different teams are distinct members. First-seen order is preserved.

### Monotonic Mid-Run, Complete At Completion

The set only grows within a run; a committed instruction actor is never removed.
A reader of a **completed** run record receives the closed, final set. A reader
observing a run **mid-run** must treat the set as a lower bound: more actors may
still join before completion.

### Continuation Preserves Committed Attribution

A continuation (timeout resume, auth resume, later slice) reproduces the same
set from committed per-message provenance. A summary-only handoff is the one
lossy boundary: its turn-session record persists the derived actor set before
the raw messages disappear, and later slices merge it with actors from newly
committed instruction provenance. The set remains monotonic across slices.

### Attribution, Not Authority

`run.actors` is attribution only. It must never feed:

- credential issuance,
- credential-subject selection,
- memory scope ownership,
- or any other permission decision.

The intended consumer of run authority is the point-of-action authority model
(issue #773 section D), where each credentialed operation is checked against the
run actor and cross-actor instruction conflicts fail closed into a consent
request. `run.actors` informs provenance and citation; it does not select a
principal.

### Derivation Is Runtime-Owned

The set is derived by the runtime from per-message provenance. It is never
parsed from prompt text, transcript text, or model output. Prompt/transcript
text is untrusted for this purpose.

### Exposure

- `AgentTurnSessionRecord.actors` is derived from `piMessageProvenance` by the
  `instructionActors` projection. The storage record persists that derived set
  so summary-only handoff does not erase attribution, then merges it with actors
  derived from later committed instructions. `AgentTurnSessionRecord.actor`
  separately carries the run actor.
- The plugin run context exposes the same fields to plugin tasks:
  `pluginRunContextSchema.actor` (the run actor, absent only for actor-less
  legacy system records) and `pluginRunContextSchema.actors` (the run actors),
  populated in `loadPluginRun`. `run.actors` is derived from the full run
  provenance (the same source as the record), never from the sliced or stripped
  transcript, so it can exceed the actors visible in the transcript slice.
- The agent tool-execution plugin hook (`BeforeToolExecuteHookContext.actors`
  in `packages/junior-plugin-api`) exposes a live, run-scoped projection: a
  getter threaded from the run loop's committed instruction provenance so far,
  materialized once per tool call. It is a lower bound mid-run per the
  monotonicity contract above. Only this hook exposes `actors`; the sandbox
  preparation hook writes a static script and does not need it. The GitHub
  plugin is the first consumer, using it to credit additional run actors as
  `Co-Authored-By` git commit trailers (see `security-policy.md`) — attribution
  text only, never a credential or authority input.

## Failure Model

- Misaligned or absent provenance yields context authority (an empty or smaller
  set), never a guessed actor.
- A malformed actor on an otherwise instruction-authority entry does not join
  and does not fail the run; the entry degrades to context authority.
- A consumer must never treat a mid-run set as final, nor treat membership as an
  authority or permission signal.

## Observability

`run.actors` is attribution provenance, not a behavior contract. Logs and spans
may include the distinct actor count or safe identity dimensions (actor type and
id, per `identity.md`) when useful for debugging, but membership must never be
asserted as a monitored behavior and must never be logged as an authority or
permission signal.

## Verification

Unit tests (`packages/junior/tests/unit/state/session-log.test.ts`,
`instructionActors` helper):

- Single-actor run returns `[the run actor]`.
- Batched multi-actor input returns both actors in first-seen order, distinct by
  ids (a second display profile for the same id does not re-add).
- Matching user ids on different teams are distinct actors.
- Context and unattributable instruction messages are excluded; a run with no
  human instruction actor returns an empty set.
- The set is monotonic across a growing prefix, so a continuation derived from
  the committed prefix is a prefix of the full set.

Component tests (`packages/junior/tests/component/services/turn-session-record.test.ts`):

- Steering by a second actor adds that actor, and re-materializing the stored
  record reproduces the same first-seen-ordered set.
- A system-actor run with no human instructions has an empty set.

Component test (`packages/junior/tests/component/plugins/plugin-tasks.test.ts`):

- The plugin run context exposes `actor`, `actors`, and per-entry `isRunActor`.

## Related Specs

- `./identity.md`
- `./task-execution.md`
- `./agent-turn-handling.md`
- `./plugin-tasks.md`
- `./context-compaction.md`
