# Plugin-Started Agents

## ADDED Requirements

### Requirement: Created Once

A plugin-started agent SHALL be created once per plugin and key. A copy
SHALL return the first one. Its request record SHALL replace the dispatch
record. Lost input SHALL go through the one repair job, and a run the job
gives up on SHALL end through a closing turn (Decided: P7, P30). There
SHALL be no separate age rule.

#### Scenario: Copy from the plugin

- **WHEN** a plugin starts a run with a key that it already used
- **THEN** it gets the first run's id and nothing new starts.

#### Scenario: Input never reaches the inbox

- **WHEN** a run's input is not added and the repair job reaches its limit
- **THEN** a closing turn ends the run `failed` and the plugin sees
  `failed`.

### Requirement: Own Conversation And System Actor

Each run SHALL get its own conversation with a fixed Location (Decided: P14).
Its turn SHALL act as the system actor for that plugin. A plugin SHALL NOT pass
an actor. A plugin SHALL pass only an unbound subject, which core binds
(Decided: P17).

#### Scenario: Inbox message names an actor

- **WHEN** the inbox message text names another actor
- **THEN** the turn still acts as the system actor.

### Requirement: Cannot Ask A Person

A plugin-started agent SHALL NOT send a sign-in link. A missing credential
SHALL end it `blocked`, with a reason for the credential mode.

#### Scenario: Creator mode, no account

- **WHEN** a creator-mode run needs an account the creator has not connected
- **THEN** it ends `blocked` with "needs a connected account" and sends no
  link.

### Requirement: What A Plugin Sees

A plugin SHALL see only `{id, status, resultMessageTs?, errorMessage?}` for
its own runs. `status` SHALL be computed from the request record and its
turn, and SHALL never change after it is final (Decided: P21).

#### Scenario: Result already sent

- **WHEN** the turn already has a sent delivery
- **THEN** the run is `completed` and the agent does not run again.

### Requirement: An Automation Run Makes One Result

An Automation run SHALL be a conversation with no Slack reply target. Its
responses SHALL go only to the web and dashboard view. The run SHALL make
one result, which its outcomes deliver (Decided: P18). A `failed` or
`stopped` run SHALL post nothing to the outcomes.

#### Scenario: Draft stays in the web view

- **WHEN** the run writes a draft before its result
- **THEN** the draft shows only in the web view and nothing is posted.

### Requirement: Where The Result Comes From

The result SHALL come from the finished run: its final response, or a
`finishAutomationRun` call when the run makes one, so the source can vary
(Proposed, needs sign-off: P18; David: "it's ok for this to vary").

#### Scenario: Result from the final response

- **WHEN** the run completes with a final response and no
  `finishAutomationRun` call
- **THEN** that response is the result, and each outcome gets it.

#### Scenario: Result from the tool call

- **WHEN** the run calls `finishAutomationRun(send_message, text)`
- **THEN** `text` is the result.

### Requirement: What A Result Ends As

`send_message` and `no_action` SHALL end the run `completed`.
`misconfigured` SHALL end it `blocked`.

#### Scenario: No action

- **WHEN** the result is `no_action`
- **THEN** nothing is posted, the reason is saved, and the run is
  `completed`.

#### Scenario: Misconfigured

- **WHEN** the result is `misconfigured`
- **THEN** nothing is posted and the run is `blocked`.

### Requirement: Outcomes

A run SHALL post its result only to its stored outcomes, in order, once
each.
`current_conversation` SHALL be the Automation's Location. `task_creator`
SHALL be the creator's DM. An empty list SHALL post nothing. A failure SHALL
NOT be posted to the outcomes.

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

In creator mode, a run SHALL carry a subject bound to the creator, the task
and the run. In system mode, none. Only the creator SHALL turn on creator
mode. A change by someone else to the instruction, trigger, outcomes or
Location SHALL switch it to system mode.

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
