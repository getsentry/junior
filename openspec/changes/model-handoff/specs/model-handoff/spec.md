# Model Handoff

## ADDED Requirements

### Requirement: Standard Main Agents Can Request Permanent Handoff

Junior SHALL expose `handoff` only to standard main agents. Its optional profile
argument SHALL select a configured non-standard profile and default to
`handoff` when omitted or `null`.

#### Scenario: Prompt identifies higher-capability work

- **WHEN** a request primarily requires coding, debugging, architecture,
  migration, broad refactoring, research-heavy synthesis, or complex planning
- **AND** handoff is available
- **THEN** the standard model is instructed to call it before ordinary work
- **AND** choose the profile whose name best fits the task or use the default.

#### Scenario: Conversation has no resumable turn record

- **WHEN** a standard main agent has a durable conversation id but no resumable
  turn-session record
- **THEN** handoff remains available.

#### Scenario: Conversation has already handed off

- **WHEN** Junior constructs a main agent bound to any non-standard profile
- **THEN** handoff is absent
- **AND** every other normal main tool remains available.

### Requirement: Handoff Is A Standalone Terminal Tool

Junior SHALL treat successful handoff as a terminal control-flow operation for
the standard phase.

#### Scenario: Standalone handoff succeeds

- **WHEN** handoff commits its target epoch
- **THEN** `prepareNextTurn` replaces the live model/context before another
  provider request
- **AND** Pi makes no further standard-model call
- **AND** provisional standard text is not delivered
- **AND** the selected profile continues the same turn.

#### Scenario: Handoff is mixed with sibling calls

- **WHEN** one assistant message contains handoff and any other tool call
- **THEN** Junior executes none of that batch
- **AND** returns model-repairable errors instructing the model to issue
  handoff alone.

#### Scenario: A tool is already in flight

- **WHEN** standard tools are currently executing
- **THEN** handoff cannot interrupt them
- **AND** standard may request handoff only at its next assistant boundary.

### Requirement: Handoff Failure Leaves Standard Execution Unchanged

Junior SHALL make the atomic target-epoch commit the handoff success point.

#### Scenario: Profile resolution, summary, or persistence fails

- **WHEN** a failure occurs before the target epoch commits
- **THEN** no target projection or profile becomes active
- **AND** handoff returns through the normal Pi tool-error channel
- **AND** standard continues normally.

#### Scenario: Turn abort is observed before persistence starts

- **WHEN** the active abort signal is observed after summarization and before
  the target epoch transaction starts
- **THEN** handoff does not persist or activate the target epoch.

#### Scenario: Process stops after commit

- **WHEN** the target epoch commits but the process stops before its model starts
- **THEN** recovery treats handoff as successful
- **AND** a resumable turn resumes from the committed target epoch
- **AND** a recordless turn uses that profile on its next invocation.

### Requirement: Handoff Opens A Summary-Only Epoch In The Same Conversation

Junior SHALL keep the stable conversation id and replace only model-visible
context.

#### Scenario: Target epoch is committed

- **WHEN** handoff succeeds
- **THEN** one transaction opens a context epoch with `reason: "handoff"`
- **AND** records the selected `modelProfile` and resolved `modelId`
- **AND** writes exactly one synthetic user-role continuation summary.

#### Scenario: Target model input is built

- **WHEN** Junior builds the selected profile's provider context
- **THEN** durable semantic history contains the summary prompt only
- **AND** in-process context also carries the current volatile runtime bootstrap
- **AND** raw source messages and the handoff call/result are absent.

### Requirement: Handoff Preserves The Complete Runtime Environment

Junior SHALL change the owning model and context without changing the
conversation's operational environment.

#### Scenario: Active agent switches profiles

- **WHEN** handoff commits and `prepareNextTurn` runs
- **THEN** the selected profile receives the same system prompt, workspace,
  sandbox id, artifacts, configuration, actors, credentials, source,
  destination, correlation, skills, plugins, MCP availability, and normal tools
- **AND** only handoff is removed from its toolset.

#### Scenario: Later user turn arrives

- **WHEN** a conversation has successfully handed off
- **THEN** the new turn starts directly on its selected profile
- **AND** Junior provides no downgrade or repeated-handoff path.

### Requirement: Successful Handoff Is Durable And Auditable

Junior SHALL preserve the permanent profile selection in durable history.

#### Scenario: Successful call is recovered

- **WHEN** recovery starts after the handoff epoch committed
- **THEN** it resolves the conversation through the selected profile
- **AND** omits handoff from the toolset
- **AND** does not replay the original handoff call.

#### Scenario: Reporting reads the conversation

- **WHEN** reporting renders a handed-off conversation
- **THEN** it can identify the handoff epoch, selected profile, and exact model
  snapshot without following another conversation id.
