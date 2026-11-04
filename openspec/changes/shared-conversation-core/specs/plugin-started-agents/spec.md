# Plugin-Started Agents

## ADDED Requirements

### Requirement: Created Once

A plugin-started agent SHALL be created once per plugin and key: the key
fixes the record's inbound message id, so a copy is a duplicate and returns
the first one. Its request record SHALL replace the dispatch record. The
record is the inbox entry, so there is no input to resend (Decided: P7,
P23). There SHALL be no separate age rule.

#### Scenario: Copy from the plugin

- **WHEN** a plugin starts a run with a key that it already used
- **THEN** it gets the first run's id and nothing new starts.

#### Scenario: Notify lost after the run is saved

- **WHEN** a run's record is saved and its notify is lost
- **THEN** the repair job finds the past `wakeAtMs` and notifies a worker,
  and the run starts once.

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
one result, which each `destination` reply target gets (Decided: P18). A
`failed` or `stopped` run SHALL post nothing to its destinations.

#### Scenario: Draft stays in the web view

- **WHEN** the run writes a draft before its result
- **THEN** the draft shows only in the web view and nothing is posted.

### Requirement: Where The Result Comes From

The result SHALL come from the finished run: its final response, or a
`finishAutomationRun` call when the run makes one, so the source can vary
(Decided: P18; David: "it's ok for this to vary").

#### Scenario: Result from the final response

- **WHEN** the run completes with a final response and no
  `finishAutomationRun` call
- **THEN** that response is the result, and each destination gets it.

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

### Requirement: Destinations

A run SHALL post its result only to the `destination` reply targets on its
request record, in order, once each. Core's Automation runner SHALL copy
one per outcome that Automation creation saved: `current_conversation` is
the Automation's Location, and `task_creator` is the creator's DM. Only
Automation creation SHALL set a destination. A run with no reply target
SHALL be stored and post nothing. A failure SHALL NOT be posted to the
destinations (Decided: P18).

#### Scenario: No destinations

- **WHEN** a run's record has an empty `replyTo` list
- **THEN** nothing is posted, not even a failure.

#### Scenario: Plugin asks for a destination

- **WHEN** a plugin calls `startPluginAgent` with a `destination` reply
  target
- **THEN** the call is refused, because only Automation creation sets
  one.

### Requirement: One Run Per Scheduled Time

The scheduler SHALL make at most one run per task and scheduled time. That
pair SHALL fix the request record's inbound message id.

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
creator SHALL get one DM after the block is saved. A run row SHALL store
only its claim, `automationVersion`, and a status from before dispatch
(`pending`, `skipped`, or a failure before dispatch). After dispatch, its
status SHALL be computed from the run's request record (Decided: P18).

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
