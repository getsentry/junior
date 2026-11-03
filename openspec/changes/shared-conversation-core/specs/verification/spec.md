# Verification

## ADDED Requirements

### Requirement: Protocol Model Checked By A Machine

The change SHALL keep a formal model of the core protocol in
`openspec/changes/shared-conversation-core/verification/`. CI SHALL check it
on every change to the model or to the core (Proposed, needs sign-off:
P37). The model SHALL cover the worker lock and lock version, turn states,
the inbox, join now and wait, request records, `finishTurn` and delivery,
stop (including the tree), child results, sign-in pause and supersede, and
restart and retry.

#### Scenario: Safety invariant broken

- **WHEN** a model change lets two turns be open in one conversation
- **THEN** the checker reports a counterexample trace and CI fails.

#### Scenario: Worked examples

- **WHEN** CI checks the model
- **THEN** every worked example in `interfaces/*.md` runs as a named trace
  and reaches the "After" state that the example states.

### Requirement: Turn Safety Invariants

The model SHALL check these turn invariants (Proposed, needs sign-off: P37):

- **I1** one open turn per conversation;
- **I2** a finished turn stays finished;
- **I3** no save or post is accepted with an old lock version;
- **I4** only `finishTurn` writes a final turn or request record status.

#### Scenario: Old lock version

- **WHEN** the model lets a worker with an old lock version save
- **THEN** the checker reports a counterexample for I3.

### Requirement: Actor And Delivery Safety Invariants

The model SHALL check these invariants (Proposed, needs sign-off: P37):

- **I5** a turn acts only with its request record's actor and whose-access;
- **I6** no message from a second person joins a turn;
- **I7** no response is sent twice without detection;
- **I8** no parent turn starts from a child result after a tree stop.

#### Scenario: Second person joins

- **WHEN** the model lets a message from a second person join an open turn
- **THEN** the checker reports a counterexample for I6.

### Requirement: Liveness Under Fairness

Under weak fairness for workers, the queue and the repair job, the model
SHALL check (Proposed, needs sign-off: P37):

- **L1** every request record ends `answered` or `stopped`;
- **L2** no turn stays `finishing` forever;
- **L3** a paused turn with work left is eventually notified.

#### Scenario: Delivery never succeeds

- **WHEN** every post fails in the model
- **THEN** L2 still holds, because delivery attempts run out and the turn
  finishes.

### Requirement: Conformance Tests Against Real Wiring

Model-based integration tests SHALL run model actions against real Junior
wiring, faking only Slack and the LLM, and SHALL compare the resulting state
with the model's state after each step (Proposed, needs sign-off: P38).
Generated runs SHALL include crashes between writes and lock expiry. Every
counterexample the checker finds SHALL become a regression test.

#### Scenario: Crash between commit and inbox removal

- **WHEN** a generated run kills the worker after `startTurn` commits
- **THEN** the real state after the next worker matches the model: one
  prompt in history, the message gone from the inbox.

#### Scenario: Code drifts from the model

- **WHEN** a code change lets a finished turn reopen
- **THEN** a conformance run reports the first step where the states differ.

### Requirement: Single Writer Rules

Code checks SHALL enforce these rules, and each failure SHALL name the
requirement it protects (Proposed, needs sign-off: P39):

- **S1** only `finishTurn` writes a final turn status or moves a request
  record out of `open` (turn-lifecycle: One Way To End A Turn);
- **S2** only `credentialsForTurn` builds turn credentials (turn-access: One
  Credential Builder).

#### Scenario: Second writer added

- **WHEN** a change writes `status = 'failed'` on the turn row outside
  `finishTurn`
- **THEN** the S1 check fails and names its requirement.

### Requirement: Single Creator Rules

Code checks SHALL enforce these rules, and each failure SHALL name the
requirement it protects (Proposed, needs sign-off: P39):

- **S3** only core person ingress creates a person-actor request record
  (conversation-inbox: Core Mints Request Records);
- **S4** only `finishTurn`, `askChild` and `messageParent` create
  `source: "agent"` messages (agent-tree: Only Matching Results Are
  Accepted).

#### Scenario: Plugin creates a person actor

- **WHEN** plugin code builds a request record with a person actor
- **THEN** the S3 check fails and names its requirement.

### Requirement: Turn Row Access Rules

Code checks SHALL enforce these rules, and each failure SHALL name the
requirement it protects (Proposed, needs sign-off: P39):

- **S5** every turn or request record status write goes through the
  lock-version helper (turn-lifecycle: Worker Lock And Lock Version);
- **S6** no module outside the turn module reads or writes the turn row
  (turn-lifecycle: The Turn Row Owns Turn Status).

#### Scenario: Status write without the lock version

- **WHEN** a change updates turn status with a plain `UPDATE`
- **THEN** the S5 check fails and names its requirement.

### Requirement: Traceability

Every scenario in `specs/` SHALL map to at least one test id, model
invariant or trace, or structural rule. A CI check SHALL fail on any
unmapped scenario, and on any mapping that names a scenario that no longer
exists (Proposed, needs sign-off: P40).

#### Scenario: New scenario without a check

- **WHEN** a spec gains a scenario with no mapping
- **THEN** the traceability check fails and names it.

#### Scenario: Requirement removed

- **WHEN** a requirement is deleted and a test still points to it
- **THEN** the traceability check fails and names the test.

### Requirement: The Sign-Off Gate

"The output adheres to the design" SHALL mean: the model check, the
conformance tests and the structural rules are all green, and the
traceability check shows no gap (Proposed, needs sign-off: P41). Every
migration step SHALL keep them green.

#### Scenario: A step breaks an invariant

- **WHEN** a migration step makes a conformance test fail for an invariant
  that an earlier step made required
- **THEN** the step does not merge.
