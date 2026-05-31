## ADDED Requirements

### Requirement: Capability-first backfill

The backfill program SHALL create OpenSpec specs around stable Junior capabilities rather than mirroring historical markdown files, test files, or eval filenames.

#### Scenario: Existing spec name is architectural

- **WHEN** an existing canonical spec describes architecture or ownership rather than a user-visible/runtime capability
- **THEN** the backfill SHALL extract capability requirements from it instead of copying the document name and structure verbatim

#### Scenario: Existing eval name conflicts with capability boundary

- **WHEN** an existing eval file mixes multiple capabilities or has a misleading name
- **THEN** the backfill SHALL map its cases to the correct capability requirements and propose keep, rename, split, move, replace, or delete actions

### Requirement: Required backfill worksheet

Each baseline spec backfill SHALL complete a worksheet covering source inventory, prior art, behavior extraction, undefined behavior, OpenSpec requirements, verification mapping, and migration.

#### Scenario: Backfilling one capability

- **WHEN** a contributor starts a baseline capability backfill
- **THEN** the contributor SHALL inspect current code, existing canonical specs, relevant tests/evals, fixtures, package docs, and relevant prior art before writing requirements

#### Scenario: Undefined behavior found

- **WHEN** code, tests, prior art, and product intent do not clearly define expected behavior
- **THEN** the backfill SHALL record the undefined behavior as an open question instead of silently creating a normative requirement

### Requirement: OpenSpec requirement format

Each backfilled capability SHALL produce OpenSpec-format requirements using normative SHALL/MUST language and scenario blocks with WHEN/THEN outcomes.

#### Scenario: Requirement lacks a scenario

- **WHEN** a draft capability requirement has no scenario
- **THEN** the backfill SHALL revise or remove the requirement before validation

#### Scenario: Existing prose is useful but non-normative

- **WHEN** existing markdown contains useful explanation, rationale, or historical context
- **THEN** the backfill SHALL convert only current behavior contracts into requirements and move rationale into design notes or related-spec links

### Requirement: Verification map

Each backfilled capability SHALL include a verification map that classifies every requirement as unit, integration, eval, manual, or intentionally unverified with rationale.

#### Scenario: Model interpretation is the contract

- **WHEN** a requirement depends on natural-language interpretation, prompt-following, reply quality, or tool-choice judgment
- **THEN** the verification map SHALL classify the primary coverage as eval

#### Scenario: Runtime wiring is the contract

- **WHEN** a requirement depends on deterministic Slack handling, persistence, auth callbacks, queueing, or external API request shape
- **THEN** the verification map SHALL classify the primary coverage as integration or unit according to `specs/testing.md`

### Requirement: Canonical alignment

Each backfilled capability SHALL update repository indexes and canonical spec pointers so future agents can discover the authoritative contract.

#### Scenario: Capability accepted

- **WHEN** a backfilled capability is accepted as canonical
- **THEN** the implementation SHALL update `specs/index.md`, relevant known-spec pointers, and related-spec links

#### Scenario: Superseded content remains

- **WHEN** existing canonical prose is superseded by the backfilled capability
- **THEN** the implementation SHALL either archive it, narrow it to non-overlapping ownership, or link it to the new authoritative capability
