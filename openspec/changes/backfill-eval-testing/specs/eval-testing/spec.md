## ADDED Requirements

### Requirement: Eval Scope

Junior evals SHALL validate agent-facing conversational behavior through realistic harnessed scenarios.

#### Scenario: Behavior depends on model interpretation

- **WHEN** the contract involves natural-language understanding, prompt behavior, reply quality, multi-turn continuity, passive participation, skill behavior, provider routing, or conversational safety
- **THEN** coverage SHALL be written as an eval unless a deterministic lower-level spec owns the contract

#### Scenario: Behavior is low-level transport

- **WHEN** the contract is Slack HTTP payload shape, retry, pagination, or handler serialization
- **THEN** it SHALL be tested as integration, not eval

### Requirement: Eval Harness Execution

Junior evals SHALL use the shared Slack eval harness and real runtime path.

#### Scenario: Eval case runs

- **WHEN** an eval case runs
- **THEN** it SHALL use `describeEval()` with shared Slack harness options
- **AND** it SHALL drive events through eval event builders and the harness runtime path
- **AND** it SHALL return structured observed artifacts for judging

#### Scenario: Eval needs controlled environment behavior

- **WHEN** an eval requires auth completion, seeded credentials, image generation stubs, reply failure, plugin fixtures, replayed web calls, or subscribed-message decisions
- **THEN** it SHALL use documented case-level harness overrides
- **AND** the rubric SHALL NOT claim behavior controlled entirely by an override is being validated

### Requirement: Eval Rubrics

Junior evals SHALL express judge criteria as structured behavior rubrics.

#### Scenario: Eval case is added or changed

- **WHEN** an eval case defines criteria
- **THEN** it SHALL use a rubric with `contract` and `pass`
- **AND** it MAY use `allow` and `fail` for optional variations and forbidden regressions
- **AND** each section SHALL be human-readable and behavior-focused

#### Scenario: Rubric over-specifies implementation

- **WHEN** criteria require exact prompt prose, internal commands, incidental tool names, or non-user-visible sequencing
- **THEN** the eval SHALL be revised unless that exact surface is the user-visible behavior under test

### Requirement: Prompt Realism

Junior eval prompts SHALL resemble realistic user interaction.

#### Scenario: User event is authored

- **WHEN** an eval writes a user prompt or thread event
- **THEN** it SHALL use plausible Slack wording
- **AND** it SHALL NOT prescribe internal command sequences or tool choices merely to force the desired path

### Requirement: Eval Boundaries

Junior evals SHALL not import or assert lower-level integration contracts.

#### Scenario: Eval file uses Slack internals

- **WHEN** an eval imports Slack action internals, MSW Slack capture helpers, or raw Slack HTTP contract utilities
- **THEN** boundary enforcement SHALL fail or the eval SHALL be rejected in review

#### Scenario: Tool evidence is used

- **WHEN** eval criteria inspect tool-call traces
- **THEN** those traces SHALL prove a behavior boundary such as source grounding, mutation safety, provider routing, or auth sequencing

### Requirement: Eval Execution Environment

Junior eval execution SHALL make external dependency requirements explicit.

#### Scenario: Eval suite runs normally

- **WHEN** `pnpm evals` runs
- **THEN** evals SHALL use memory state and configured replay mode by default
- **AND** evals SHALL use the shared MSW setup
- **AND** missing Gateway or Sandbox readiness SHALL fail with actionable bootstrap errors

#### Scenario: Eval needs fresh recordings

- **WHEN** web replay recordings must be refreshed
- **THEN** contributors SHALL use the record-mode eval command
- **AND** regenerated recordings SHALL be reviewed for stale exploratory fetches and secret-like values before commit

### Requirement: Eval Naming And Organization

Junior evals SHALL be organized by behavior area and named by user-observable scenario.

#### Scenario: Eval case is added

- **WHEN** an eval case is added
- **THEN** it SHALL live under `evals/core` or `evals/<plugin>` according to ownership
- **AND** the case name SHOULD use a `when <trigger>, <outcome>` shape

#### Scenario: Existing eval scope is unclear

- **WHEN** an eval file or case appears misnamed, too broad, or wrong-scoped
- **THEN** the eval taxonomy migration map SHALL mark it keep, rename, split, move, replace, or delete

### Requirement: Eval Verification

Eval changes SHALL be verified with the narrowest practical eval command.

#### Scenario: Eval file changes

- **WHEN** an eval file changes
- **THEN** the focused eval command for that file or matching test name SHOULD pass when required credentials are available
- **AND** inability to run due to missing/expired Gateway or Sandbox credentials SHALL be reported explicitly

#### Scenario: Eval harness changes

- **WHEN** eval helpers, harness runtime, replay behavior, or output serialization changes
- **THEN** representative core evals and harness unit tests SHOULD pass
