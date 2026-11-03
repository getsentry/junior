# Plugin-Started Agents

## ADDED Requirements

### Requirement: Created Once

A plugin-started agent SHALL be created once per plugin and key. A copy
SHALL return the first one. Its request record SHALL replace the dispatch
record. The repair job SHALL send its input again when it was lost
(Proposed, needs sign-off: P7). A run older than 24 h with no turn SHALL
fail.

#### Scenario: Copy from the plugin

- **WHEN** a plugin starts a run with a key that it already used
- **THEN** it gets the first run's id and nothing new starts.

### Requirement: Own Conversation And Stored Actor

Each run SHALL get its own conversation with a fixed Location (Proposed,
needs sign-off: P14). Its turn SHALL act as the stored system actor with an
optional delegated subject. Its inbox message SHALL hold only the request
id.

#### Scenario: Inbox message names an actor

- **WHEN** the inbox message text names another actor
- **THEN** the turn still acts as the stored system actor.

### Requirement: Cannot Ask A Person

A plugin-started agent SHALL NOT send a sign-in link. A missing credential
SHALL end it `blocked`, with a reason for the credential mode.

#### Scenario: Creator mode, no account

- **WHEN** a creator-mode run needs an account the creator has not connected
- **THEN** it ends `blocked` with "needs a connected account" and sends no link.

### Requirement: What A Plugin Sees

A plugin SHALL see only `{id, status, resultMessageTs?, errorMessage?}` for
its own runs. `status` SHALL be computed from the request record and SHALL
never change after it is final (Proposed, needs sign-off: P21).

#### Scenario: Result already saved

- **WHEN** the turn already has a sent delivery
- **THEN** the run is `completed` and the agent does not run again.

### Requirement: An Automation Run Says How It Ends

An Automation run SHALL end with `finishAutomationRun`: `send_message`,
`no_action` or `misconfigured`. Its responses SHALL be the declared outcome
messages. Other assistant text SHALL be saved only (Proposed, needs
sign-off: P18).

#### Scenario: No declared outcome

- **WHEN** the model stops without the call
- **THEN** the runtime adds one reminder, then the run fails and the failure
  shows on the Automation.

#### Scenario: Misconfigured

- **WHEN** the result is `misconfigured`
- **THEN** the run is `blocked`.

### Requirement: Outcomes

A run SHALL post only to its stored outcomes, in order, once each.
`current_conversation` SHALL be the Automation's Location. `task_creator`
SHALL be the creator's DM. An empty list SHALL post nothing.

#### Scenario: Empty outcomes

- **WHEN** a run has an empty outcome list
- **THEN** nothing is posted, not even a failure.

### Requirement: One Run Per Scheduled Time

The scheduler SHALL make at most one run per task and scheduled time. That
pair SHALL be the request record's idempotency key.

#### Scenario: Late run

- **WHEN** a run is more than 24 h late
- **THEN** it is skipped.

#### Scenario: Run still open

- **WHEN** the task has another run that is not done
- **THEN** no new run is claimed.

### Requirement: Creator Or System Credentials

In creator mode, a run SHALL carry a subject bound to the creator and the
task. In system mode, none. Only the creator SHALL turn on creator mode. A
change by someone else to the instruction, trigger, outcomes or Location
SHALL switch it to system mode.

#### Scenario: Someone else edits the instruction

- **WHEN** a person who is not the creator changes the instruction
- **THEN** the Automation switches to system mode.

### Requirement: A Blocked Run Blocks Its Automation

A blocked run SHALL set its Automation to `blocked` with a reason, and the
creator SHALL get one DM after the block is saved. Run rows SHALL settle
from the run's request record.

#### Scenario: Paused Automation

- **WHEN** a run of a paused Automation ends `blocked`
- **THEN** the Automation stays paused and the creator gets one DM.

### Requirement: Event Automations

An event SHALL match only active Automations in the same team, with a
matching identifier, event type and filters. Each pair SHALL run once. Too
many runs in the window SHALL block that Automation only, with one DM. Each
run SHALL get its own conversation and act as the system actor, with the
creator's subject only in creator mode.

#### Scenario: Too many runs

- **WHEN** an Automation goes over the run limit in the window
- **THEN** only that Automation is blocked, with one DM.
