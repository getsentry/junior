# Model Execution Profiles

## Requirement: Conversation Model Profiles

Junior SHALL expose validated `standard` and `advanced` conversation profiles.

#### Scenario: Initial conversation

- **WHEN** a new conversation first commits model-visible history
- **THEN** it opens an `initial` projection bound to `standard`
- **AND** records the resolved standard model id for audit.

#### Scenario: Legacy markerless conversation

- **WHEN** a legacy conversation has no projection marker
- **THEN** it resolves to the configured standard model
- **AND** Junior does not invent a historical exact model id.

#### Scenario: Handoff succeeds

- **WHEN** a handoff projection commits
- **THEN** it binds `modelProfile: "advanced"`
- **AND** records the resolved advanced model id for audit
- **AND** every future turn starts directly on the advanced model.

#### Scenario: Projection is replaced

- **WHEN** compaction or rollback creates a replacement projection
- **THEN** it copies the current projection's authoritative model profile
- **AND** records the model id resolved from current configuration.

#### Scenario: Configuration changes after an epoch

- **WHEN** a profile resolves to a different model than its stored epoch id
- **THEN** runtime uses the newly configured model
- **AND** preserves the stored id as audit evidence rather than a pin.

#### Scenario: Legacy marker without audit id

- **WHEN** a legacy marker omits `modelId`
- **THEN** it remains readable with no invented audit value.

#### Scenario: Legacy replacement marker without profile

- **WHEN** a legacy compaction or rollback marker omits `modelProfile`
- **THEN** it resolves to standard.

#### Scenario: Invalid binding

- **WHEN** handoff omits its advanced binding or any projection selects another
  profile
- **THEN** strict durable-history decoding rejects the marker.

## Requirement: Host-Owned Model Catalog

Model-facing controls SHALL select profiles rather than raw provider model ids.

#### Scenario: Advanced configuration

- **WHEN** `AI_ADVANCED_MODEL` is configured
- **THEN** handoff resolves advanced through that host-owned value.
