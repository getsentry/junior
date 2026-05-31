## ADDED Requirements

### Requirement: Skill file format validation

Junior SHALL accept only valid SKILL.md files with supported frontmatter.

#### Scenario: Skill file has valid frontmatter

- **WHEN** a skill directory contains `SKILL.md` with valid YAML frontmatter, a valid kebab-case name, and a non-empty description
- **THEN** Junior SHALL parse the metadata and body

#### Scenario: Skill name does not match directory

- **WHEN** a skill file's `name` does not match the containing directory name during discovery or load
- **THEN** Junior SHALL reject that skill file

#### Scenario: Skill description contains angle brackets or exceeds budget

- **WHEN** a skill description contains unsupported markup or exceeds the configured description budget
- **THEN** Junior SHALL reject that skill file

#### Scenario: Deprecated capability/config frontmatter is present

- **WHEN** a skill file includes deprecated `requires-capabilities` or `uses-config` fields
- **THEN** Junior SHALL reject that skill file and treat plugin manifest declarations as the source of runtime capabilities/config

### Requirement: Skill discovery

Junior SHALL discover skill metadata from configured skill roots without loading every skill body into the active prompt.

#### Scenario: Skill roots are resolved

- **WHEN** Junior discovers skills
- **THEN** it SHALL scan additional roots, `SKILL_DIRS`, default skill roots, and plugin skill roots with duplicate roots removed

#### Scenario: Multiple roots contain same skill name

- **WHEN** the same skill name appears in more than one root
- **THEN** Junior SHALL keep the first discovered skill and skip later duplicates

#### Scenario: Skill root or skill file cannot be read

- **WHEN** a configured skill root or individual skill directory cannot be read or parsed
- **THEN** Junior SHALL skip that entry and continue discovering other skills

#### Scenario: Discovery cache is fresh

- **WHEN** discovery is called repeatedly for the same root set within the cache window
- **THEN** Junior MAY return cached metadata

### Requirement: Skill invocation parsing

Junior SHALL distinguish explicit skill invocations from ordinary domain mentions.

#### Scenario: User sends slash skill command

- **WHEN** a user message contains `/skill-name` for an available skill
- **THEN** Junior SHALL parse the skill name and trailing arguments

#### Scenario: User mentions unknown slash command

- **WHEN** a user message contains an unregistered slash command
- **THEN** Junior SHALL NOT treat it as a skill invocation

#### Scenario: User explicitly names a user-callable skill

- **WHEN** a skill is marked user-callable via disabled model invocation and the user explicitly asks to use, run, load, call, or invoke that skill
- **THEN** Junior SHALL parse it as an explicit skill invocation

#### Scenario: User negates skill use

- **WHEN** a user says not to use a skill
- **THEN** Junior SHALL NOT parse that text as a skill invocation

### Requirement: Skill loading tool

Junior SHALL load full skill instructions on demand through the `loadSkill` tool.

#### Scenario: Known skill is loaded

- **WHEN** `loadSkill` is called with an available skill name
- **THEN** Junior SHALL return skill name, description, sandbox skill directory, working directory, path-resolution guidance, and full instructions
- **AND** Junior SHALL notify the runtime that the skill is active for this turn

#### Scenario: Unknown skill is requested

- **WHEN** `loadSkill` is called with an unknown skill name
- **THEN** Junior SHALL return a model-visible unknown-skill result with available skill names

#### Scenario: Plugin-backed skill is loaded

- **WHEN** a loaded skill belongs to a plugin
- **THEN** Junior SHALL preserve plugin provider metadata and expose provider/MCP metadata returned by the load hook

### Requirement: Plugin runtime boundary injection

Junior SHALL make plugin-owned skill instructions subordinate to plugin manifest runtime declarations.

#### Scenario: Plugin-owned skill is loaded

- **WHEN** Junior loads a skill from a plugin-owned skill directory
- **THEN** it SHALL prepend a runtime-boundary notice identifying manifest-owned runtime setup surfaces

#### Scenario: Skill prose asks to configure provider runtime

- **WHEN** plugin-owned skill prose conflicts with plugin manifest ownership of credentials, config, MCP, runtime dependencies, or postinstall
- **THEN** Junior SHALL treat the plugin manifest as authoritative

#### Scenario: Skill metadata claims wrong plugin

- **WHEN** loaded skill metadata names a plugin provider but the skill path is not owned by that plugin
- **THEN** Junior SHALL fail rather than loading the skill under false provider ownership

### Requirement: Skill-scoped file sandbox

Junior SHALL allow skill references to be read only within the active or explicitly named skill directory.

#### Scenario: Skill lists files

- **WHEN** skill file listing is requested for an active or explicit skill
- **THEN** Junior SHALL return bounded sorted entries and indicate truncation when the entry budget is reached

#### Scenario: Skill reads reference file

- **WHEN** skill file read is requested for a file under the skill directory and within byte/character budgets
- **THEN** Junior SHALL return bounded UTF-8 content with path and truncation metadata

#### Scenario: Skill file path is absolute or escapes root

- **WHEN** skill file access receives an absolute path or traversal outside the skill directory
- **THEN** Junior SHALL reject it

#### Scenario: No active skill exists

- **WHEN** skill file access has no explicit skill and no active skill can be inferred
- **THEN** Junior SHALL fail with a model-visible instruction to load or name a skill first

### Requirement: Skill allowed tool filtering

Junior SHALL let loaded skills restrict available runtime tool names using exact tool-name allowlists.

#### Scenario: Active skill has no allowed-tools

- **WHEN** the active skill has no `allowed-tools` metadata
- **THEN** Junior SHALL leave the tool list unrestricted by the skill

#### Scenario: Active skill has allowed-tools

- **WHEN** the active skill lists allowed tools
- **THEN** Junior SHALL keep only matching exact runtime tool names

#### Scenario: Allowed-tools contains unsupported patterns

- **WHEN** `allowed-tools` includes portable or provider-specific patterns that do not exactly match runtime tool names
- **THEN** Junior SHALL ignore those tokens

### Requirement: Skill-runtime verification taxonomy

Skill-runtime verification SHALL separate deterministic parsing/loading from model-facing skill selection.

#### Scenario: Deterministic skill mechanics are verified

- **WHEN** verifying frontmatter, discovery, loading, plugin ownership, file sandboxing, allowed-tools filtering, or invocation parser rules
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Skill selection and application are verified

- **WHEN** verifying whether the model auto-loads, refuses, or applies a skill correctly for natural-language requests
- **THEN** the primary coverage SHALL be evals

#### Scenario: Plugin or MCP-backed skill workflow is verified

- **WHEN** verifying that a plugin/MCP-backed skill completes through provider tools
- **THEN** coverage SHALL include integration or eval tests owned jointly with plugin/MCP capabilities
