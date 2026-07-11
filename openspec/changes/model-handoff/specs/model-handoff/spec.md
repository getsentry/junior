# Model Handoff

## ADDED Requirements

### Requirement: Standard Main Agents Can Request Permanent Handoff

Junior SHALL expose an argument-free `handoff` tool only to standard main agents.

#### Scenario: Conversation has no resumable turn record

- **WHEN** a standard main agent has a durable conversation id but no resumable
  turn-session record
- **THEN** `handoff` remains available.

#### Scenario: Prompt identifies an advanced task

- **WHEN** a request primarily requires an enumerated advanced category such as
  code/configuration changes, debugging, architecture/migration/refactor work,
  or multi-file repository execution
- **AND** the handoff tool is available
- **THEN** the standard model is instructed to call `handoff`.

#### Scenario: Complexity is discovered later

- **WHEN** the standard agent reaches another assistant boundary after earlier
  completed work
- **THEN** `handoff` remains available
- **AND** it may upgrade after reads, tools, or mutations already occurred.

#### Scenario: Conversation is already advanced

- **WHEN** Junior constructs the active advanced main agent
- **THEN** `handoff` is absent
- **AND** every other normal main tool remains available.

### Requirement: Handoff Is A Standalone Terminal Tool

Junior SHALL treat a successfully executed handoff as a terminal control-flow
operation for the standard phase.

#### Scenario: Standalone handoff succeeds

- **WHEN** a standalone handoff finishes summary generation and commits its
  target epoch
- **THEN** `prepareNextTurn` replaces the live model/context before another
  provider request
- **AND** Pi makes no further standard model call
- **AND** provisional standard text is not delivered
- **AND** advanced continues the same turn.

#### Scenario: Handoff is mixed with sibling calls

- **WHEN** one assistant message contains handoff and any other tool call
- **THEN** Junior executes none of that batch
- **AND** returns model-repairable errors instructing standard to issue handoff
  alone.

#### Scenario: A tool is already in flight

- **WHEN** standard tools are currently executing
- **THEN** handoff cannot interrupt them
- **AND** standard may request handoff only at its next assistant boundary.

### Requirement: Handoff Failure Leaves Standard Execution Unchanged

Junior SHALL make the atomic target-epoch commit the handoff success point.

#### Scenario: Summary fails

- **WHEN** summary generation fails before the target epoch commits
- **THEN** no target projection or profile becomes active
- **AND** handoff returns through the normal Pi tool-error channel
- **AND** standard continues normally.

#### Scenario: Persistence fails

- **WHEN** target epoch persistence fails
- **THEN** the original epoch and standard profile remain authoritative
- **AND** no replacement projection is used
- **AND** standard may retry handoff or finish the request.

#### Scenario: Turn abort is observed before persistence starts

- **WHEN** the active turn abort signal is observed after summarization and
  before the target epoch transaction starts
- **THEN** handoff does not persist or activate the advanced epoch.

#### Scenario: Process stops after commit

- **WHEN** the target epoch commits but the process stops before advanced starts
- **THEN** recovery treats handoff as successful
- **AND** a resumable turn resumes advanced from the committed target epoch
- **AND** a recordless turn remains advanced on its next invocation without
  automatically resuming the interrupted request.

### Requirement: Handoff Opens A Summary-Only Epoch In The Same Conversation

Junior SHALL keep the stable conversation id and replace only model-visible
context.

#### Scenario: Target epoch is committed

- **WHEN** handoff succeeds
- **THEN** one transaction opens a context epoch with `reason: "handoff"`
- **AND** its marker records `modelProfile: "advanced"`
- **AND** writes exactly one synthetic user-role summary prompt.

#### Scenario: Summary input includes completed execution

- **WHEN** standard performed work before handoff
- **THEN** summarization may inspect its committed user, assistant, tool-call,
  tool-result, decision, error, verification, and mutation history
- **AND** preserves exact operational facts needed to continue.

#### Scenario: Target model input is built

- **WHEN** Junior builds the advanced provider context
- **THEN** its semantic history contains the summary prompt only
- **AND** the host-owned prompt tells advanced to continue the outstanding request now
- **AND** its in-process context also carries the current volatile runtime
  bootstrap as a sibling message
- **AND** raw source user/assistant/reasoning/tool messages and the handoff
  call/result are absent.

### Requirement: Handoff Preserves The Complete Runtime Environment

Junior SHALL change the owning model and model context without changing the
conversation's operational environment.

#### Scenario: Active Agent is upgraded

- **WHEN** handoff commits and `prepareNextTurn` runs
- **THEN** advanced receives the same system-prompt variant, workspace, sandbox
  id, artifacts, configuration, actors, credentials, source, destination,
  correlation, skills, plugins, MCP availability, and normal main-agent tools
- **AND** only handoff is removed from its toolset.

#### Scenario: Advanced performs normal behavior

- **WHEN** advanced executes after handoff
- **THEN** timeout, steering, follow-up, auth, delivery, tool, persistence, and
  recovery behavior remain the normal main-agent behavior.

#### Scenario: Later user turn arrives

- **WHEN** a conversation has successfully handed off
- **THEN** the new turn starts directly on advanced
- **AND** Junior provides no standard downgrade or return path.

### Requirement: Successful Handoff Is Durable And Auditable

Junior SHALL preserve the permanent upgrade in durable history.

#### Scenario: Successful call is redelivered

- **WHEN** recovery starts after the handoff epoch committed
- **THEN** it resolves the conversation as advanced
- **AND** the advanced toolset omits handoff
- **AND** it does not replay the original handoff call.

#### Scenario: Reporting reads the conversation

- **WHEN** reporting renders a handed-off conversation
- **THEN** it can identify the handoff epoch, advanced profile, and final model
  without following another conversation id.
