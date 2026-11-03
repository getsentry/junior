# Agent Tree

## ADDED Requirements

### Requirement: A Child Is A Conversation

A child agent SHALL be a conversation that runs on the same worker, inbox,
worker lock and `finishTurn` as a top-level agent. `spawnAgent` and
`messageAgent` SHALL call `askChild`, which saves a request record and sends
one inbox message. They SHALL NOT start a runner.

#### Scenario: messageAgent to an idle child

- **WHEN** the parent messages an idle child
- **THEN** the child's inbox gets one message and a worker starts its next
  turn
- **AND** no second runner starts.

### Requirement: spawnAgent Is Safe To Retry

A spawn SHALL be keyed by the parent turn id and the tool call id. The same
key with different input SHALL throw. A different title SHALL NOT count.

#### Scenario: Retried tool call

- **WHEN** the parent's turn restarts and calls `spawnAgent` again with the
  same tool call id
- **THEN** the first child and record are returned and nothing new starts.

### Requirement: Named Children

A named child SHALL be one stable child per parent and name. A second spawn
with that name SHALL fail and point to `messageAgent`. The name `parent`
SHALL be refused. `messageAgent` by conversation id SHALL work for unnamed
children.

#### Scenario: Second spawn with a name

- **WHEN** the parent spawns `reviewer` twice
- **THEN** the second spawn fails and points to `messageAgent`.

### Requirement: Limits On Children

Under the parent's SQL lock, a parent SHALL have at most 8 children with open
work, and a child at most 4 open request records. A waiting message on a busy
child SHALL NOT count twice. `maxAgentDepth` SHALL default to 1 (Decided).

#### Scenario: Grandchild spawns

- **WHEN** a child at depth 1 starts a grandchild
- **THEN** it works, and the grandchild cannot start more children.

### Requirement: A Child Keeps What It Was Started With

A child SHALL keep its agent type and model profile. A `fork` child SHALL
start with the parent history from before the spawn call, cut where every
tool call has a result. Other types SHALL start empty.

#### Scenario: Second task

- **WHEN** a child gets a second request record
- **THEN** it uses its own history, agent type and model profile.

### Requirement: A Child Has No Location And Cannot Ask A Person

A child SHALL read its root's Location and visibility and SHALL never post
to a provider. It SHALL have no review desk, no handoff and no interactive
sign-in. A sign-in need SHALL end it `blocked` (Decided).

#### Scenario: Child needs sign-in

- **WHEN** a child's tool needs the person to connect an account
- **THEN** the child ends `blocked` and the parent tells the person.

### Requirement: A Message To A Busy Child Joins

A message to a busy child with the same actor and exactly the same
whose-access SHALL join its running turn at a safe point, `now` or `wait`.
One result SHALL cover both request records (Decided). A message from
another actor SHALL wait and SHALL block later messages from joining.

#### Scenario: Same actor

- **WHEN** the parent messages a busy child for the same actor
- **THEN** the message joins and one result answers both.

#### Scenario: Different actor

- **WHEN** the message is for a different actor
- **THEN** it waits, and its own turn sends its own result.

### Requirement: One Result Per Turn

A child turn SHALL send one result message per parent reply target, at
`finishTurn`, with a fixed id. It SHALL be `wait` input from the system
identity, capped at 12,000 characters, with outcome `completed`, `failed`,
`blocked` or `stopped`, and name the title, the child, every record
answered and siblings still working. Only its outcome SHALL be trusted.

#### Scenario: Retries run out in a child

- **WHEN** a child's last try fails
- **THEN** the parent gets a `failed` result.

#### Scenario: Tool-call limit

- **WHEN** a child hits a per-turn limit
- **THEN** the result reports progress, not failure.

#### Scenario: Nothing to say

- **WHEN** a child completes with no assistant text
- **THEN** the result is `completed` with no text.

### Requirement: Only Matching Results Are Accepted

A parent SHALL accept a result only when its record's reply target is that
parent and its record belongs to the sending child (Proposed, needs
sign-off: P26). Only core agent code SHALL make `source: "agent"` messages.

#### Scenario: Forged result

- **WHEN** a result names a record whose reply target is another
  conversation
- **THEN** it is dropped with a recorded reason and starts no turn.

### Requirement: What Answered Means

`finishTurn` SHALL mark a record `answered` once its deliveries are sent or
failed. A later turn's output for it SHALL go as a follow-up, to the reply
target of the record it was made for. No follow-up SHALL go for a `stopped`
record (Proposed, needs sign-off: P6).

#### Scenario: Grandchild result after the child's turn ended

- **WHEN** a child's turn ends while its grandchild works, then the
  grandchild finishes
- **THEN** the parent gets the child's result first, then a follow-up from
  the new child turn
- **AND** A's work is never folded into B's result.

### Requirement: Result Turns In The Parent

A result SHALL start a new parent turn after the event window, so sibling
results share a turn. Results for different actors SHALL NOT share a turn. A
result SHALL never join a running parent turn. Results SHALL skip the
automated-turn check but count toward it (Decided).

#### Scenario: Two siblings finish together

- **WHEN** two children for the same actor finish inside one event window
- **THEN** one parent turn takes in both results.

### Requirement: A Child Can Message Its Parent

A child message to its parent SHALL reach the parent as agent input, marked
as not from a person, acting for the child turn's actor. With no open record
on the child's turn, the send SHALL fail.

#### Scenario: Message with no open record

- **WHEN** a child with no open record messages its parent
- **THEN** the send fails with "no parent agent".

### Requirement: One Open Turn Per Child

A child SHALL have at most one open turn. Input to a child (a grandchild
result, a message, a Watch event) SHALL start new child work.

#### Scenario: Two waiting requests from two actors

- **WHEN** records for A and B wait on an idle child
- **THEN** two turns run in order, each with its own result.

### Requirement: listAgents And Watches On A Child

`listAgents` SHALL read child state from turn rows and request records. A
child's Watches SHALL wake it like a top-level agent. The parent SHALL be
able to list and stop them.

#### Scenario: Child stopped

- **WHEN** a child with a Watch is stopped
- **THEN** its Watches are cancelled and `listAgents` shows it `stopped`.
