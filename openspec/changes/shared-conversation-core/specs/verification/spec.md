# Verification

## ADDED Requirements

### Requirement: Protocol Model Checked By A Machine

A formal model of the core protocol SHALL live in `verification/` at the
repo root, and CI SHALL check it on every change to the model or the core
(Proposed, needs sign-off: P37, P40). It SHALL cover the worker lock and
lock version, turn states, the inbox, join now and wait, request records,
`finishTurn` and delivery, stop (including the tree), child results,
sign-in pause and supersede, restart and retry, sandbox processes tagged
with their creator, and an adversarial `send`.

#### Scenario: Safety invariant broken

- **WHEN** a model change lets two turns be open in one conversation
- **THEN** the checker reports a counterexample trace and CI fails.

#### Scenario: Worked examples

- **WHEN** CI checks the model
- **THEN** every worked example in `interfaces/*.md` runs as a named trace
  and reaches the "After" state that the example states.

### Requirement: Turn Safety Invariants

The model SHALL check (Proposed, needs sign-off: P37):

- **I1** one open turn per conversation;
- **I2** a finished turn stays finished;
- **I3** no save or post is accepted with an old lock version;
- **I4** only `finishTurn` writes a final turn or request record status;
- **I12** each request id is in at most one turn.

#### Scenario: Old lock version

- **WHEN** the model lets a worker with an old lock version save
- **THEN** the checker reports a counterexample for I3.

### Requirement: Actor Invariants

The model SHALL check (Proposed, needs sign-off: P37):

- **I5** a turn acts only with its request record's actor and whose-access;
- **I6** a joined message has exactly the turn's actor, signed subject and
  source, and every batch a turn takes in, at start or by join, has one
  actor and one exact signed subject (P20);
- **I9** a taken message's record is in the receiving conversation and
  matches the message, and a result's sender, read from the child's turn
  row, is a child of the receiver.

#### Scenario: Events with different access

- **WHEN** two Watch events with different signed subjects wait in one
  window
- **THEN** each taken batch has one actor and one exact signed subject, or
  the checker reports a counterexample for I6.

#### Scenario: Forged message

- **WHEN** the adversarial `send` puts a message with another
  conversation's request id in an inbox
- **THEN** no turn takes it in, or the checker reports a counterexample
  for I9.

### Requirement: Proxy Invariant

The model SHALL check **I13**: the proxy adds credentials only for the
running turn's pass with a live lock, to a process tagged with that turn's
actor and subject (Proposed, needs sign-off: P37).

#### Scenario: Process from an earlier actor

- **WHEN** a process tagged with A calls a declared domain during B's turn
- **THEN** no credentials are added, or the checker reports a
  counterexample for I13.

### Requirement: Delivery Invariants

The model SHALL check (Proposed, needs sign-off: P37):

- **I7** each delivery id is posted at most once, unless a takeover
  happened between its intent and its post;
- **I8** no parent turn starts from a child result after a tree stop.

#### Scenario: Takeover between intent and post

- **WHEN** a slow worker posts after a new worker took the lock
- **THEN** the repeat is the one I7 allows, and `find` detects it.

### Requirement: Stop Invariants

The model SHALL check these against the person's real order of actions,
not the design's own stop test (Proposed, needs sign-off: P37):

- **I10** after the stop, no intent is saved for input sent before it;
- **I11** no turn starts with, and no join takes in, input older than the
  stop (`i11j` for joins);
- **I14** a stop never stops a turn or input newer than it
  (`spareNewerTurn`, `spareNewerInput`).

#### Scenario: Stop races a post

- **WHEN** a stop is saved between a turn's intent save and its post
- **THEN** the post is the one allowed, and no later intent is saved.

#### Scenario: Turn started after the click

- **WHEN** a turn for older input starts after the click and before the
  stop is saved
- **THEN** I10 holds: the turn is under the stop.

### Requirement: Liveness Under Fairness

TLC SHALL check, under weak fairness for workers and queue delivery and
within the crash bound (Proposed, needs sign-off: P37):

- **L1** every request record ends `answered` or `stopped`;
- **L2** no turn stays `finishing` forever;
- **L3** a paused turn with work left is eventually resumed or finished,
  without fairness for the repair job (needs the P32 sign-in and delayed
  notify fix).

#### Scenario: Delivery never succeeds

- **WHEN** every post fails in the model
- **THEN** L2 still holds, because delivery attempts run out and the turn
  finishes.

### Requirement: Conformance Tests Against Real Wiring

Model-based integration tests SHALL drive real Junior wiring, faking only
Slack and the LLM. After each step they SHALL compare user-visible outcomes
and the durable records the specs name (turn row, request record, delivery)
with the model. They SHALL NOT mock Junior modules or use test-only
mutation APIs (Proposed, needs sign-off: P38).

#### Scenario: Code drifts from the model

- **WHEN** a code change lets a finished turn reopen
- **THEN** a conformance run reports the first step where the records
  differ from the model.

#### Scenario: Counterexample found

- **WHEN** the checker finds a counterexample
- **THEN** its trace is added as a fixed conformance run.

### Requirement: Crash Points From Real Boundaries

Generated runs SHALL crash a worker after each durable write, each Redis
operation and each post, and where the provider accepted a post but the
reply was lost. They SHALL also use queue redelivery, lock expiry under a
controlled clock, and two concurrent workers on real Postgres. A seam
SHALL only be an existing adapter boundary (Proposed, needs sign-off: P42).

#### Scenario: Crash between commit and inbox removal

- **WHEN** a run kills the worker after `startTurn` commits
- **THEN** after the next worker, the turn row and history match the
  model: one prompt, the message gone from the inbox.

#### Scenario: Reply lost after the provider accepted

- **WHEN** the Slack fake accepts a post and drops the reply
- **THEN** the next worker finds the post by its delivery id and does not
  post again.

### Requirement: Single Writer Rules

Code checks SHALL enforce, and each failure SHALL name the requirement it
protects (Proposed, needs sign-off: P39):

- **S1** only `finishTurn` writes a final turn status or moves a request
  record out of `open` (turn-lifecycle: One Way To End A Turn);
- **S2** only `credentialsForTurn` builds turn credentials, through a
  branded type and an import boundary (turn-access: One Credential
  Builder).

#### Scenario: Second writer added

- **WHEN** a change writes `status = 'failed'` on the turn row outside
  `finishTurn`
- **THEN** the S1 check fails and names its requirement.

### Requirement: Trusted Construction Rules

Types, an import-boundary check and runtime asserts SHALL enforce
(Proposed, needs sign-off: P39):

- **S3** only core person ingress makes a `VerifiedPersonActor`, and a
  person-actor record needs one (conversation-inbox: Core Mints Request
  Records);
- **S4** only `finishTurn`, `askChild` and `messageParent` make agent
  messages and their records; plugin code cannot import `createRequest`
  or `send` (agent-tree: Only Matching Results Are Accepted).

#### Scenario: Plugin creates a person actor

- **WHEN** plugin code builds a request record with a person actor
- **THEN** typecheck or the import check fails, and at run time the record
  write throws.

### Requirement: Turn Row Access Rules

Code checks SHALL enforce, and each failure SHALL name the requirement it
protects (Proposed, needs sign-off: P39):

- **S5** every turn or request record status write goes through the
  lock-version helper (turn-lifecycle: Worker Lock And Lock Version);
- **S6** an import rule in `scripts/check-test-architecture.mjs` keeps
  every module outside the turn module off the turn table (turn-lifecycle:
  The Turn Row Owns Turn Status).

#### Scenario: Status write without the lock version

- **WHEN** a change updates turn status with a plain `UPDATE`
- **THEN** the S5 check fails and names its requirement.

### Requirement: Traceability

Every scenario in `specs/` other than this spec's SHALL map to a test id, a
model invariant or trace, or a structural rule. The scenario-id list and
the check SHALL live in `verification/`, not in this plan. CI SHALL fail on
an unmapped scenario, and on a mapping to a scenario that no longer exists
(Proposed, needs sign-off: P40).

#### Scenario: New scenario without a check

- **WHEN** a spec gains a scenario with no mapping
- **THEN** the traceability check fails and names it.

#### Scenario: Requirement removed

- **WHEN** a requirement is deleted and a test still points to it
- **THEN** the traceability check fails and names the test.

#### Scenario: Plan deleted

- **WHEN** this plan folder is deleted after step 22
- **THEN** every verification job still runs.

### Requirement: The Sign-Off Gate

"The output adheres to the design" SHALL mean: the model check, the
conformance tests and the structural rules are green, the trace check shows
no gap, and the guardian evals for P15 and P20 pass. The gate SHALL be
green before the first step that changes the protocol, and every later step
SHALL keep it green (Proposed, needs sign-off: P41).

#### Scenario: A step breaks an invariant

- **WHEN** a migration step makes a conformance test fail for an invariant
  that an earlier step's Verify line named
- **THEN** the step does not merge.
