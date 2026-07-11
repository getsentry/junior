# Model Execution Profiles

## Requirement: Conversation Model Profiles

Junior SHALL bind every context projection to a validated host-owned model
profile and record the resolved model id for audit.

#### Scenario: Initial conversation

- **WHEN** a new conversation first commits model-visible history
- **THEN** it opens an `initial` projection bound to `standard`
- **AND** records the resolved standard model id for audit.

#### Scenario: Handoff succeeds

- **WHEN** handoff commits with a selected configured profile
- **THEN** the new projection records that profile and its resolved model id
- **AND** every future turn starts directly on that profile.

#### Scenario: Projection is replaced

- **WHEN** compaction or rollback creates a replacement projection
- **THEN** it copies the current projection's authoritative profile
- **AND** records the model id resolved from current configuration.

#### Scenario: Configuration changes after an epoch

- **WHEN** a profile resolves to a different model than its stored epoch id
- **THEN** runtime uses the newly configured model
- **AND** preserves the stored id as audit evidence rather than a pin.

#### Scenario: Configured profile is removed

- **WHEN** durable history selects a custom profile that is no longer configured
- **THEN** runtime fails with a configuration error
- **AND** does not fall back to the audit id or another profile.

#### Scenario: Legacy history

- **WHEN** markerless history or a legacy replacement marker lacks a profile
- **THEN** it resolves to `standard`
- **AND** Junior does not invent an exact historical model id.

## Requirement: Host-Owned Model Catalog

Model-facing controls SHALL select configured profiles rather than raw provider
model ids.

#### Scenario: Default handoff profile

- **WHEN** `AI_HANDOFF_MODEL` is unset
- **THEN** `handoff` resolves to `openai/gpt-5.6-sol`.

#### Scenario: Additional named profiles

- **WHEN** `AI_MODEL_PROFILES` contains valid profile-to-model mappings
- **THEN** those non-standard profile names are available to handoff
- **AND** `standard` and `handoff` cannot be overridden.

#### Scenario: Tool schema is exposed

- **WHEN** Junior builds the standard agent's handoff tool
- **THEN** its optional profile argument contains only configured non-standard
  profile names
- **AND** omitting the argument or passing `null` selects `handoff`.
