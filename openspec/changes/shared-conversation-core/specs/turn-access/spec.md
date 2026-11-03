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

### Requirement: Delegated Access Is Signed And Checked At Use

A delegated subject SHALL be used only with a system actor. The runtime
SHALL sign it. A plugin SHALL NOT supply the binding. A DM-bound subject
SHALL work only in its DM. `credentialsForTurn` SHALL check the binding at
every turn start and resume (Proposed, needs sign-off: P17).

#### Scenario: Automation switched to system mode

- **WHEN** an Automation switches to system credentials after a run was
  created
- **THEN** that run's next turn start or resume uses system credentials.

#### Scenario: Person actor with a subject

- **WHEN** a person actor carries a delegated subject
- **THEN** building credentials throws.

### Requirement: Timer Grants Come From A Person's Turn

A timer Watch SHALL carry its creator's grant only when a person's turn made
it, bound to that conversation and Watch. A child of a turn with a grant
SHALL get it, checked against the root conversation (Proposed, needs
sign-off: P28).

#### Scenario: System turn sets a timer

- **WHEN** a system turn sets a timer
- **THEN** the timer has no delegated grant.

### Requirement: Results Act For The Request Record

A result or agent message SHALL act for the actor and whose-access of the
request record it points to, never the child's latest request (Proposed,
needs sign-off: P15).

#### Scenario: Grandchild result after another person messaged the child

- **WHEN** A asks a child, the child starts a grandchild, then B messages the
  child, then the grandchild finishes
- **THEN** the grandchild's result turn acts for A.

### Requirement: An Event Author Is Never The Actor

An event turn SHALL act as the system actor, with access only from its Watch
or Automation grant. Event text SHALL reach the model as labeled external
text.

#### Scenario: Linked author comments

- **WHEN** a linked GitHub user comments on a watched pull request
- **THEN** their tokens are not used.

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

A lookup outside a turn SHALL NOT use installation credentials on a
person's text. Title lookups SHALL use the latest person turn's credentials
(Proposed, needs sign-off: P25).

#### Scenario: Title for a private repo link

- **WHEN** a conversation title is built from a link to data that the person cannot see
- **THEN** the lookup uses that person's credentials and gets nothing.

### Requirement: Sandbox Pass Ends With Its Turn

A sandbox pass SHALL be bound to one turn and one VM, issued per attempt,
and revoked in `finishTurn` and at a lost-worker restart (Decided; Proposed,
needs sign-off: P29). The proxy SHALL check the VM token, the signature,
expiry, revocation and a declared host before it adds credentials.
Undeclared hosts SHALL stay open with no credentials (Decided).

#### Scenario: Background process after the turn

- **WHEN** a process from an ended turn calls a declared domain
- **THEN** the proxy refuses it.

#### Scenario: Pass for another VM

- **WHEN** the pass's VM differs from the token's sandbox
- **THEN** the proxy refuses it.

### Requirement: One Sandbox Per Conversation

Turns of different actors in one conversation SHALL share its sandbox
(Decided). Child conversations SHALL have their own. The user docs SHALL say
so. Snapshot builds SHALL run as the system actor with no credential route.

#### Scenario: Two people in one thread

- **WHEN** A's turn clones a repo, then B's turn runs in the same conversation
- **THEN** B's turn sees the checkout
- **AND** B's turn cannot use A's credentials, because A's pass was revoked.

### Requirement: Signals Belong To Their Turn

A sign-in-needed or permission-denied signal from the proxy SHALL reach only
the turn named on the pass.

#### Scenario: Old process during another turn

- **WHEN** a process from A's turn hits a provider during B's turn
- **THEN** B's turn gets no sign-in prompt for A.

### Requirement: Sign-In Pause

Only a turn whose policy can ask a person SHALL send a sign-in link. The link
SHALL be private, one use, last 10 minutes, and be bound to the actor and the
turn id (Proposed, needs sign-off: P13). The thread SHALL get a short notice.
A child or plugin-started agent SHALL end `blocked` (Decided). The callback
SHALL only save the sign-in and notify a worker.

#### Scenario: No private delivery

- **WHEN** no private delivery is possible
- **THEN** no link is posted in public.

### Requirement: Sign-In Supersede

New input from the same person SHALL end a turn that waits for sign-in with
a short note, and that input SHALL run next. Other people's input and events
SHALL wait until sign-in or link expiry. At expiry the turn SHALL end with a
short note. The rule SHALL be the same for every kind (Decided). The ended
turn SHALL be `stopped` (Proposed, needs sign-off: P13, P24).

#### Scenario: Same person

- **WHEN** A's turn waits for sign-in and A posts again
- **THEN** the old turn ends with a note and A's new message runs.

#### Scenario: Another person

- **WHEN** A's turn waits for sign-in and B posts
- **THEN** B's message runs after A signs in and that turn ends, or after the
  link expires.
