## ADDED Requirements

### Requirement: Prompt ownership boundaries

Junior SHALL keep platform behavior, personality, dynamic runtime context, skill guidance, and tool schemas in separate prompt ownership layers.

#### Scenario: Core platform behavior is needed

- **WHEN** Junior needs to instruct the agent about tool-use policy, source hierarchy, execution bias, Slack output shape, safety, or failure reporting
- **THEN** Junior SHALL place that generic platform behavior in the core prompt rather than in deployment personality files or individual skills

#### Scenario: Deployment personality is customized

- **WHEN** `SOUL.md` or another deployment-authored personality file is empty, missing, or customized
- **THEN** Junior's platform behavior SHALL still work because personality files are voice/context overlays, not runtime policy authority

#### Scenario: Domain workflow guidance is needed

- **WHEN** guidance is specific to a skill, plugin, provider, account, config key, or domain workflow
- **THEN** Junior SHALL deliver it through skill bodies, tool descriptions, schemas, `promptSnippet`, or `promptGuidelines` instead of core prompt prose

### Requirement: Static system prompt

Junior SHALL keep the system prompt stable and free of turn-specific runtime facts.

#### Scenario: System prompt is built

- **WHEN** `buildSystemPrompt()` is called
- **THEN** it SHALL require no parameters and SHALL NOT depend on requester, thread, session, runtime, model, provider, tool catalog, artifact, or configuration values that vary by turn

#### Scenario: Stable assistant identity is needed

- **WHEN** deployment-stable identity such as the bot Slack username is needed
- **THEN** Junior MAY include it in the static system prompt

#### Scenario: Dynamic capability surface changes

- **WHEN** available skills, active MCP catalogs, requester identity, artifacts, configuration, or runtime IDs differ by turn
- **THEN** Junior SHALL NOT insert those facts into the static system prompt

### Requirement: Session bootstrap runtime context

Junior SHALL put dynamic prompt facts in a session bootstrap context block that is attached once to the active Pi session projection and omitted from ordinary follow-up user messages in the same projection.

#### Scenario: First turn or bootstrap context is needed

- **WHEN** Junior builds prompt context for a turn whose reduced Pi projection lacks session bootstrap facts
- **THEN** `buildTurnContextPrompt(...)` MAY include available skills, active MCP catalog summaries, tool guidance, reference files, world context, requester, artifacts, configuration, runtime IDs, and explicit skill triggers

#### Scenario: Follow-up turn already has session bootstrap context

- **WHEN** prior durable Pi/session history already contains the session bootstrap context marker
- **THEN** Junior SHALL append the ordinary follow-up user input without duplicating available skills, active MCP catalogs, requester, artifacts, configuration, runtime IDs, reference files, or world context

#### Scenario: Projection is compacted

- **WHEN** compaction builds a replacement Pi projection
- **THEN** Junior SHALL omit old session bootstrap context from the replacement history so the next turn can inject fresh bootstrap context exactly once

#### Scenario: Authorization resume context is built

- **WHEN** Junior builds prompt context for a turn resumed after plugin or MCP authorization
- **THEN** Junior SHALL NOT add prompt-only authorization lifecycle hints such as pending auth state, resumed-turn flags, or completed-provider fields
- **AND** model-visible authorization completion SHALL come from the agent session history projection

### Requirement: Prompt section structure

Junior SHALL keep prompt sections separated by decision owner so future changes do not collapse unrelated policies into a flat list.

#### Scenario: Core behavior sections are rendered

- **WHEN** Junior builds core behavior instructions
- **THEN** it SHALL keep distinct sections for tool policy, tool-call style, skill policy, execution contract, conversation/thread continuity, Slack side-effect actions, safety, and failure handling

#### Scenario: Output formatting guidance is rendered

- **WHEN** Junior renders the Slack output section
- **THEN** it SHALL limit that section to formatting and final-response shape, not generic tool-use or execution policy

#### Scenario: Runtime facts are rendered

- **WHEN** Junior renders runtime facts
- **THEN** it SHALL keep facts separate from behavior instructions

### Requirement: Execution bias and source hierarchy

Junior SHALL instruct the model to act in-turn using the nearest authoritative available source before asking for help or ending with an unexecuted plan.

#### Scenario: Request is actionable

- **WHEN** the user's request can be advanced with available context, skills, or tools
- **THEN** the prompt SHALL bias the model to act in the current turn and continue until done or genuinely blocked

#### Scenario: User asks a repository or implementation question

- **WHEN** the answer depends on repository or implementation facts
- **THEN** the prompt SHALL require repository evidence before generic product framing or memory

#### Scenario: Fact may be mutable

- **WHEN** a requested fact may change over time or depends on live provider state
- **THEN** the prompt SHALL instruct the model to use a live/source-backed check rather than stale memory

#### Scenario: Source evidence conflicts

- **WHEN** available sources conflict
- **THEN** the prompt SHALL instruct the model to compare sources and identify the authoritative one where possible

### Requirement: Skill and tool policy

Junior SHALL disclose only actionable skill/tool surfaces and SHALL let schemas and skill/tool guidance own parameter/domain details.

#### Scenario: Skills are available

- **WHEN** auto-selectable skills are available
- **THEN** turn context SHALL disclose their names, descriptions, and load locations without exposing plugin metadata as core prompt knowledge

#### Scenario: User-callable skill is relevant but not explicitly invoked

- **WHEN** a skill is marked user-callable-only and the user has not explicitly named or invoked it
- **THEN** the prompt SHALL NOT direct the model to auto-load it

#### Scenario: Tool parameters are needed

- **WHEN** the model needs to call a tool
- **THEN** the prompt SHALL treat the tool schema as parameter authority and SHALL NOT re-document every parameter in core prompt prose

#### Scenario: Tool-specific usage guidance is needed

- **WHEN** a tool has concise prompt guidance
- **THEN** Junior MAY expose that guidance through the dynamic tool-guidance context for the current native tool set

### Requirement: Runtime and safety boundaries

Junior SHALL use the prompt to communicate runtime boundaries that affect safe tool use without expanding access beyond the user's request.

#### Scenario: Sandbox-backed tools are available

- **WHEN** the prompt describes file or shell tool behavior
- **THEN** it SHALL make clear that those tools operate in the isolated sandbox workspace, not arbitrary host files

#### Scenario: Sandbox execution is unavailable

- **WHEN** sandbox-backed inspection is unavailable
- **THEN** the prompt SHALL instruct the model to report the blocker rather than implying inspection succeeded

#### Scenario: Administrative action is considered

- **WHEN** an action would change prompts, tool policy, security settings, credentials, or runtime configuration
- **THEN** the prompt SHALL require explicit user request and available tool support before acting

### Requirement: Prompt bloat control

Junior SHALL keep prompt rules compact, non-duplicative, and owned by the narrowest appropriate layer.

#### Scenario: New prompt rule is proposed

- **WHEN** adding a prompt rule
- **THEN** the change SHALL first check whether an existing rule with the same decision owner can be sharpened or replaced

#### Scenario: Duplicate behavior appears

- **WHEN** core prompt, skills, tool guidance, or personality files express the same generic harness behavior with different wording
- **THEN** the duplication SHALL be removed or moved to the owning layer

#### Scenario: Example is proposed

- **WHEN** adding an example to the core prompt
- **THEN** the change SHALL justify why compact rules and dynamic guidance are insufficient, preferably with eval evidence

### Requirement: Prompt verification taxonomy

Prompt verification SHALL avoid treating exact prose as the behavior contract unless the requirement is structural.

#### Scenario: Prompt structure is deterministic

- **WHEN** verifying static prompt parameterlessness, context tag placement, or plugin metadata omission
- **THEN** unit tests MAY assert structural output from prompt builders

#### Scenario: Model interpretation is the contract

- **WHEN** verifying tool-use bias, skill selection, ask-only-when-blocked behavior, source use, Slack reply shape, or prompt-following quality
- **THEN** verification SHALL use evals or behavior integration tests rather than static substring assertions

#### Scenario: Runtime wiring feeds prompt context

- **WHEN** verifying that Slack messages, queued messages, attachments, artifacts, configuration, or session state reach the assistant prompt/context
- **THEN** verification SHALL use integration tests at the runtime boundary
