# Turn Access

## ADDED Requirements

### Requirement: One Actor And One Whose-Access Per Turn

A turn SHALL act for one actor with one whose-access, read from its starting
request record. They SHALL NOT come from message text or tool arguments. A
resumed turn SHALL use its saved actor, access, source and route, never newer
input.

#### Scenario: Message names an actor

- **WHEN** an inbound message's text names an actor or a credential
- **THEN** it has no effect.

#### Scenario: Missing actor on resume

- **WHEN** a paused turn resumes with no saved actor
- **THEN** it fails. No fallback actor is used.

### Requirement: One Credential Builder

Only `credentialsForTurn` SHALL build a turn's credentials. Tools, MCP, the
sandbox pass and the credential proxy SHALL read its result. Real tokens
SHALL never reach the sandbox, files, arguments, logs or model context.

#### Scenario: Unlinked account

- **WHEN** a person unlinks an account
- **THEN** the next call needs sign-in, because user credentials are never
  cached.

### Requirement: Core Binds And Signs Delegated Access

A plugin SHALL pass only an unbound subject. Core SHALL bind and sign it. The
signature SHALL cover kind, scope, user id, team id, DM channel id and the
request id of the run. `createRequest` SHALL take the unbound subject, mint
the id, then bind it (Proposed, needs sign-off: P17). A delegated subject
SHALL be used only with a system actor. `credentialsForTurn` SHALL check it
at every turn start and resume (Proposed, needs sign-off: P17).

#### Scenario: Plugin passes a binding

- **WHEN** a plugin passes a subject that already has a binding
- **THEN** core refuses it.

#### Scenario: Subject reused for another run

- **WHEN** a signed subject is presented for a different request id
- **THEN** building credentials throws.

#### Scenario: Automation switched to system mode

- **WHEN** an Automation switches to system credentials after a run was
  created
- **THEN** that run's next turn start or resume uses system credentials.

### Requirement: Timer Grants Come From A Person's Turn

A timer Watch SHALL carry its creator's grant only when a person's turn made
it, bound to that conversation and Watch. Until P28 is decided, a child of
a turn with a grant SHALL get the parent turn's actor and delegated
subject, as today, bound again for the child's record.

#### Scenario: System turn sets a timer

- **WHEN** a system turn sets a timer
- **THEN** the timer has no delegated grant.

### Requirement: Results Act For The Request Record

A result or agent message SHALL act for the actor and whose-access of the
request record it answers, never the child's latest request. In a result
turn, messages from other actors SHALL reach the model as outside text,
from before or after the record was made (Proposed, needs sign-off: P15).

#### Scenario: Grandchild result after another person messaged the child

- **WHEN** A asks a child, the child starts a grandchild, then B messages the
  child, then the grandchild finishes
- **THEN** the result turn acts for A
- **AND** B's message is outside text and is not approval.

### Requirement: An Event Author Is Never The Actor

An event turn SHALL act as the system actor, with access only from its Watch
or Automation grant. Event author text SHALL reach the model as labeled
outside text and SHALL never be approval.

#### Scenario: Linked author comments

- **WHEN** a linked GitHub user comments on a watched pull request
- **THEN** their tokens are not used, and their text is not approval.

### Requirement: Agent Text Is Never Approval

A parent's task and a child's result SHALL carry no person's approval.
Action review SHALL count only root messages from the turn actor's person,
and SHALL get each turn's own actor.

#### Scenario: Child reads its task

- **WHEN** a child reads its parent's task text
- **THEN** action review does not treat it as approval.

### Requirement: Agent Messages To Other Conversations Fail Closed

A message to another top-level conversation SHALL need the same provider
tenant and visibility. A private target SHALL need the sender's person as a
member, and an unreachable one SHALL look missing. The target SHALL run it
as the system actor and send no result back.

#### Scenario: Private target, not a member

- **WHEN** the sender's person is not a member of a private target
- **THEN** the error is the same as for a missing conversation.

### Requirement: Lookups Outside A Turn

A lookup outside a turn, such as a conversation title, SHALL run as a system
actor with no user credentials, as today.

#### Scenario: Title for a private link

- **WHEN** a title is built from a link that needs user access
- **THEN** the lookup gets no user credentials and the title skips those
  facts.

### Requirement: Sandbox Pass Ends With Its Turn

A turn SHALL have at most one pass, saved on its turn row (Decided: ends
with its turn). Each attempt SHALL renew the same pass, with an expiry
capped near the attempt limit. `finishTurn` and the `sign_in`, `post_retry`
and `error_retry` pauses SHALL apply a no-credentials policy (Proposed,
needs sign-off: P36). Undeclared hosts SHALL stay open with no credentials
(Decided).

#### Scenario: Background process after the turn

- **WHEN** a process from an ended turn calls a declared domain
- **THEN** no credentials are added.

### Requirement: The Proxy Checks The Running Turn

The proxy SHALL add credentials only when the pass is the open turn's pass,
that turn is running and its lock is live, plus today's checks (Proposed,
needs sign-off: P36).

#### Scenario: Pass from an older turn

- **WHEN** a request carries a pass that is not the open turn's pass
- **THEN** the proxy refuses it.

#### Scenario: Lost worker's lock expired

- **WHEN** a lost worker's process calls a declared domain after the lock
  expired and before a new worker took it
- **THEN** the proxy refuses it.

### Requirement: One Sandbox Per Conversation

Turns of different actors in one conversation SHALL share its sandbox and
files (Decided). When a turn's actor or access differs from the last pass's
turn, the worker SHALL kill user processes before it applies the new pass
(Proposed, needs sign-off: P36). Child conversations SHALL have their own
sandbox. The user docs SHALL say so.

#### Scenario: Two people in one thread

- **WHEN** A's turn leaves a process running and then B's turn uses the
  sandbox
- **THEN** the process is killed before B's pass is applied, and A's files
  stay.

### Requirement: Shared Files Run Under The Next Pass

Files that one actor's turn leaves (git hooks, shell rc files, `PATH`
shims, package scripts) SHALL be named as a risk: they can run again under
the next actor's pass. B's commands SHALL run with git hooks and package
scripts turned off and with a clean `HOME` and `PATH` (Proposed, needs
sign-off: P36). It needs David's decision: accept the risk, or reopen
sandbox sharing.

#### Scenario: Planted git hook

- **WHEN** A's turn writes a git hook and B's turn runs `git commit`
- **THEN** the hook does not run.

### Requirement: Signals Belong To Their Turn

A sign-in-needed or permission-denied signal from the proxy SHALL reach only
the turn named on the pass.

#### Scenario: Signal after the turn ended

- **WHEN** a signal names a turn that has ended
- **THEN** no other turn gets a sign-in prompt for it.

### Requirement: Sign-In Pause

Only a turn with a person actor, in a conversation that can ask a person,
SHALL send a sign-in link. A system-actor turn SHALL end `blocked` (Proposed,
needs sign-off: P13). A child or plugin-started agent SHALL end `blocked`
(Decided). The link SHALL be private, one use, last 10 minutes, and be bound
to the actor and the turn id. The callback SHALL only save the sign-in and
notify a worker.

#### Scenario: Timer turn needs sign-in

- **WHEN** a timer turn needs an account
- **THEN** no link is sent and the turn ends `blocked` with the reason.

#### Scenario: No private delivery

- **WHEN** no private delivery is possible
- **THEN** no link is posted in public.

### Requirement: Sign-In Supersede

New input from the same person SHALL end a turn that waits for sign-in with
a short note, and that input SHALL run next. Other people's input and events
SHALL wait until sign-in or link expiry. At expiry the turn SHALL end with a
short note. The rule SHALL be the same for every kind (Decided). "Same
person" SHALL mean a person actor equal to the turn's actor; the ended turn
SHALL be `stopped` (Proposed, needs sign-off: P13).

#### Scenario: Same person

- **WHEN** A's turn waits for sign-in and A posts again
- **THEN** the old turn ends with a note and A's new message runs next.

#### Scenario: Another person

- **WHEN** A's turn waits for sign-in and B posts
- **THEN** B's message runs after A's turn ends, by sign-in or by link
  expiry.
