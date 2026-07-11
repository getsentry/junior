# Model Execution Profiles

## Requirement: Conversation Model Profiles

Junior SHALL expose validated `standard` and `advanced` conversation profiles.

#### Scenario: Initial conversation

- **WHEN** a conversation has no projection marker
- **THEN** it resolves to the configured standard model.

#### Scenario: Handoff succeeds

- **WHEN** a handoff projection commits
- **THEN** it binds `modelProfile: "advanced"`
- **AND** every future turn starts directly on the advanced model.

#### Scenario: Projection is replaced

- **WHEN** compaction or rollback creates a replacement projection
- **THEN** it copies the current projection's model binding.

#### Scenario: Legacy replacement marker

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
