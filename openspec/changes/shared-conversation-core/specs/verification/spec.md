# Verification

## ADDED Requirements

### Requirement: Protocol Model Checked By A Machine

A TLA+ model of the core protocol SHALL live in `packages/junior/verification/`,
and CI SHALL check it with TLC on every change to that directory and once a week
(Decided: P37, P40, P41). It SHALL cover the worker lock and lock version, turn
states, the inbox, join now and wait, request records, `finishTurn` and
delivery, stop (including the tree), child results, sign-in pause and supersede,
restart and retry, sandbox processes tagged with their creator, and an
adversarial `send`.

#### Scenario: Safety invariant broken

- **WHEN** a model change lets two turns be open in one conversation
- **THEN** the checker reports a counterexample trace and CI fails.

#### Scenario: Worked examples

- **WHEN** CI checks the model
- **THEN** every worked example in `interfaces/*.md` runs as an `ex_*`
  check and reaches the "After" state that the example states.

### Requirement: Model Files And Expected Results

The model SHALL be `WorkerLock.tla`, `StopClock.tla`, `Cutover.tla`,
`CutoverTree.tla`, `CutoverShim.tla` and `DropGuard.tla`, with one TLC
config per instance in `cfg/`. `checks.txt` SHALL list each check
and its expected result: `holds`, or `violated` for a known counterexample,
a worked example (`ex_*`) or accepted behavior (`acc_*`). `check.sh` SHALL
run every check with TLC and fail on any other result (Decided: P37, P40).

#### Scenario: Changed result

- **WHEN** a model change makes a check give another result than
  `checks.txt` expects
- **THEN** `check.sh` fails and names the check.

### Requirement: Cutover Model Configs

`CutoverShim.tla` SHALL check the P45 shim (`cfg/shim_design.cfg`,
`cfg/shim_abandon.cfg`, `cfg/shim_long.cfg`, `cfg/shim_stop.cfg`,
`cfg/shim_inv.cfg`, `cfg/shim_ingress.cfg`, `cfg/shim_rollback.cfg`,
`cfg/shim_gap.cfg`, `cfg/shim_examples.cfg`), `CutoverTree.tla` C7 in the
shim's terms (`cfg/tree_shim.cfg`), and `DropGuard.tla` its column-drop
guard (`cfg/drop_design.cfg`) (Decided: P37, P45).

#### Scenario: Shim design check in CI

- **WHEN** `check.sh` runs `checks.txt`
- **THEN** each of these configs gives the result that `checks.txt`
  records, or `check.sh` fails and names it.

### Requirement: Cutover Evidence Variants

`evidence.txt` SHALL list the variants that `FINDINGS.md` cites: the shim
without one of its fixes (C10 to C14, the shared ingress claim,
`D(lease)`, the stop key, I15, the TTL refresh), `tree_shimNoFence`,
`tree_shimNoPin`, `tree_shimEarlyTomb`, `drop_oneMax`, `drop_noSpare`,
`drop_spare` and the earlier `Cutover.tla` and `CutoverTree.tla` drafts
(Decided: P37, P45).

#### Scenario: Evidence variant still fails

- **WHEN** `CHECKS=evidence.txt ./check.sh` runs
- **THEN** each listed variant gives its recorded counterexample, or
  `check.sh` fails and names it.

### Requirement: Turn Safety Invariants

The model SHALL check (Decided: P37):

- **I1** one open turn per conversation;
- **I2** a finished turn stays finished;
- **I3** no save or post is accepted with an old lock version;
- **I4** only `finishTurn` writes a final turn or request record status;
- **I12** each request id is in at most one turn.

#### Scenario: Old lock version

- **WHEN** the model lets a worker with an old lock version save
- **THEN** the checker reports a counterexample for I3.

### Requirement: Actor Invariants

The model SHALL check (Decided: P37):

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

### Requirement: Moved State Invariant

The model SHALL check **I15**: a turn or record that the cutover moves has
the verified old actor and subject, or it is closed (Decided: P45). A moved
Agent invocation row SHALL take its actor only from the parent turn or
request record whose id it stores, never from the parent's latest
invocation. The gate SHALL hold I15 before the cutover release.

#### Scenario: Move without a verified subject

- **WHEN** the model moves a turn whose old subject fails its check
- **THEN** the turn is closed, or the checker reports a counterexample for
  I15.

### Requirement: Proxy Invariant

The model SHALL check **I13**: the proxy adds credentials only for the
running turn's pass with a live lock, to a process tagged with that turn's
actor and subject (Decided: P37). Files left in the
sandbox SHALL NOT be a gate check: they are an accepted, documented limit
(Decided: P36).

#### Scenario: Process from an earlier actor

- **WHEN** a process tagged with A calls a declared domain during B's turn
- **THEN** no credentials are added, or the checker reports a
  counterexample for I13.

### Requirement: Delivery Invariants

The model SHALL check (Decided: P37):

- **I7** each delivery id is posted at most once, unless a takeover
  happened between its intent and its post;
- **I8** no parent turn starts from a child result after a tree stop.

#### Scenario: Takeover between intent and post

- **WHEN** a slow worker posts after a new worker took the lock
- **THEN** the repeat is the one I7 allows, and `find` detects it.

### Requirement: Stop Invariants

The model SHALL check these against Junior's receive order: the database
stamps at inbox append and in the `stop()` transaction (Decided: P37,
P44):

- **I10** after the stop, no intent is saved for input that Junior
  received before it;
- **I11** no turn starts with, and no join takes in, input that Junior
  received before the stop (`i11j` for joins);
- **I14** a stop never stops a turn or input that Junior received after it
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
within the crash bound (Decided: P37):

- **L1** every request record ends `answered` or `stopped`;
- **L2** no turn stays `finishing` forever;
- **L3** a paused turn with work left is eventually resumed or finished.
  In runs with no lost notify, this holds without fairness for the repair
  job (needs the P32 sign-in and delayed notify fix). After a lost notify,
  it holds with the repair job (Decided: P46).

#### Scenario: Delivery never succeeds

- **WHEN** every post fails in the model
- **THEN** L2 still holds, because delivery attempts run out and the turn
  finishes.

### Requirement: Conformance Tests Against Real Wiring

Model-based integration tests SHALL drive real Junior wiring, faking only Slack
and the LLM, and SHALL run on every PR. After each step they SHALL compare
user-visible outcomes and the durable records the specs name (turn row, request
record, delivery) with the model. They SHALL NOT mock Junior modules. Crashes
SHALL come from the one `faults` port (Decided: P38, P42).

#### Scenario: Code drifts from the model

- **WHEN** a code change lets a finished turn reopen
- **THEN** a conformance run reports the first step where the records
  differ from the model.

#### Scenario: Counterexample found

- **WHEN** the checker finds a counterexample
- **THEN** its trace is added as a fixed conformance run.

### Requirement: Crash Points From One Faults Port

Runs SHALL crash (`kill`) or pause (`stall`) a worker at named fault points:
after each SQL write, Redis operation and post, and where the provider accepted
a post but the reply was lost. One optional `faults` port SHALL supply them
through the existing dependency wiring, as a no-op when absent. Production SHALL
never pass it, and it SHALL have no global, singleton or test-only module API.
Point names SHALL match `Crash_<Point>` actions in `WorkerLock.tla` (Decided:
P42).

#### Scenario: Crash between commit and inbox removal

- **WHEN** a run kills the worker after `startTurn` commits
- **THEN** after the next worker, the turn row and history match the
  model: one prompt, the message gone from the inbox.

#### Scenario: Stalled worker resumes

- **WHEN** a run stalls a worker after a save until its lock expired, then
  resumes it
- **THEN** its next save or post is refused, except the one post that P5
  "Limit" allows.

#### Scenario: Fault point with no model action

- **WHEN** a fault point name has no crash action in the model, or a model
  crash action has no fault point
- **THEN** the trace check fails and names it.

### Requirement: Races From Real Boundaries

Generated runs SHALL also use queue redelivery, lock expiry under the
database clock, the Slack fake for a lost reply, and two real workers on
real Postgres for the lock compare-and-set (Decided: P38, P42).

#### Scenario: Reply lost after the provider accepted

- **WHEN** the Slack fake accepts a post and drops the reply
- **THEN** the next worker finds the post by its delivery id and does not
  post again.

### Requirement: Single Writer Rules

Code checks SHALL enforce, and each failure SHALL name the requirement it
protects (Decided: P39):

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
(Decided: P39):

- **S3** only core person ingress makes a `VerifiedPersonActor`, and a
  person-actor record needs one (conversation-inbox: Core Mints Request
  Records, Copies Of A Verified Person Actor);
- **S4** only `finishTurn`, `askChild` and `messageParent` make agent
  messages and their records; plugin code cannot import `createRequest`
  or `send` (agent-tree: Only Matching Results Are Accepted).

#### Scenario: Plugin creates a person actor

- **WHEN** plugin code builds a request record with a person actor
- **THEN** typecheck or the import check fails, and at run time the record
  write throws.

### Requirement: Turn Row Access Rules

Code checks SHALL enforce, and each failure SHALL name the requirement it
protects (Decided: P39):

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
model invariant or trace, or a structural rule. The scenario-id list and the
check SHALL live in `packages/junior/verification/`, not in this plan. CI SHALL
fail on an unmapped scenario, and on a mapping to a scenario that no longer
exists (Decided: P40).

#### Scenario: New scenario without a check

- **WHEN** a spec gains a scenario with no mapping
- **THEN** the traceability check fails and names it.

#### Scenario: Requirement removed

- **WHEN** a requirement is deleted and a test still points to it
- **THEN** the traceability check fails and names the test.

#### Scenario: Plan deleted

- **WHEN** this plan folder is deleted after the last step
- **THEN** every verification job still runs.

### Requirement: The Sign-Off Gate

"The output adheres to the design" SHALL mean: the model check, the
conformance tests and the structural rules are green, the trace check shows
no gap, and the guardian evals for P15 and P20 pass. The gate SHALL ship
before the build steps, SHALL be green before the cutover release, and
every later release SHALL keep it green (Decided: P41).

#### Scenario: A step breaks an invariant

- **WHEN** a migration step makes a conformance test fail for an invariant
  that an earlier step's Verify line named
- **THEN** the step does not merge.
