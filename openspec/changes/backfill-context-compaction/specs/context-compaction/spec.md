## ADDED Requirements

### Requirement: Context authority separation

Junior SHALL treat reusable Pi history and visible Slack conversation state as separate context authorities.

#### Scenario: Reusable Pi history is compacted

- **WHEN** Junior compacts model history reused for a later turn
- **THEN** it SHALL operate on reusable Pi/session history rather than visible Slack transcript state alone

#### Scenario: Visible conversation state is compacted

- **WHEN** Junior compacts persisted Slack conversation state for routing, thinking selection, or no-Pi-history prompt background
- **THEN** it SHALL preserve the bounded visible-thread information needed by those consumers without assuming it changes reusable Pi history

#### Scenario: Runtime context is needed after compaction

- **WHEN** a later turn starts after compaction
- **THEN** Junior SHALL reinject volatile runtime context through the normal prompt path instead of storing current runtime-turn context inside compacted history

### Requirement: Pre-turn Pi compaction eligibility

Junior SHALL compact reusable Pi history only before a later turn appends new user input and only when the source history is safe to replace.

#### Scenario: Prior reusable session is completed and oversized

- **WHEN** a completed reusable Pi history exceeds the automatic compaction threshold before the next turn starts
- **THEN** Junior MAY compact it before passing `piMessages` into assistant execution

#### Scenario: Prior session is awaiting resume

- **WHEN** the relevant session is awaiting timeout or auth resume
- **THEN** Junior SHALL skip or reject compaction for that session rather than compacting a continuable pause projection

#### Scenario: Prior session is running or missing

- **WHEN** the relevant session is running, failed to load, or lacks reusable Pi history
- **THEN** Junior SHALL continue without automatic compaction and SHALL NOT synthesize replacement history

#### Scenario: Active turn history exists

- **WHEN** thread state points at an active turn record with Pi history
- **THEN** Junior SHALL prefer that active-turn history over compacting older completed history for the upcoming turn

### Requirement: Replacement history shape

Junior SHALL replace oversized reusable Pi history with bounded user-authored retained messages plus one synthetic handoff summary.

#### Scenario: Replacement is built

- **WHEN** compaction succeeds
- **THEN** the replacement history SHALL contain newest eligible user-authored messages restored to chronological order and one synthetic user-role handoff summary

#### Scenario: Recent user wording exceeds the retained budget

- **WHEN** the newest eligible user message exceeds the remaining retained-message token budget
- **THEN** Junior MAY truncate that text to fit rather than dropping all recent user wording

#### Scenario: Existing compaction summary appears in source history

- **WHEN** source history already contains a compaction handoff summary
- **THEN** Junior SHALL NOT retain that prior summary as a verbatim retained user message

#### Scenario: Unsafe or non-semantic content appears in source history

- **WHEN** source history contains runtime-turn context, capability catalogs, raw base64/image payloads, tool results, or assistant messages
- **THEN** Junior SHALL exclude those items from verbatim retained user messages

### Requirement: Handoff summary construction

Junior SHALL summarize bounded source context into one concise handoff for a future model continuing the same thread.

#### Scenario: Summary prompt is built

- **WHEN** Junior calls the summarizer
- **THEN** it SHALL provide bounded visible-thread context and reusable Pi history sufficient to summarize outstanding asks, decisions, completed work, durable constraints, identifiers, artifact references, auth state, next steps, and blockers

#### Scenario: Summary input is too large

- **WHEN** source context must be bounded before summarization
- **THEN** Junior SHALL omit older context before newer context so recent history is preserved

#### Scenario: Summary is stored

- **WHEN** compaction writes replacement history
- **THEN** Junior SHALL store the handoff as one model-visible item instead of accumulating multiple visible compaction records

#### Scenario: Summary would expose secrets

- **WHEN** source context includes credentials, OAuth tokens, raw private file bytes, raw image base64, or secret-bearing tool output
- **THEN** Junior SHALL omit or redact that material from summary input and observability surfaces

### Requirement: Compaction projection persistence

Junior SHALL persist compaction as an append-only replacement projection without destructively rewriting prior history.

#### Scenario: Target session-log projection is available

- **WHEN** Junior persists compacted reusable Pi history
- **THEN** it SHALL append a projection event to the same conversation log rather than deleting or rewriting previous entries
- **AND** it SHALL advance the conversation-local session marker used to filter active projection entries

#### Scenario: Projection is loaded after compaction

- **WHEN** a later turn loads reusable Pi history after compaction
- **THEN** Junior SHALL materialize the compacted projection from the active session marker rather than from a synthetic compaction turn record

#### Scenario: Automatic compaction is retried for the same source

- **WHEN** automatic compaction is retried for an unchanged source position
- **THEN** Junior SHALL avoid creating an unbounded chain of duplicate replacement projections for the same source history

### Requirement: Automatic compaction timing and Slack UX

Junior SHALL run automatic compaction as a pre-turn runtime step and keep user-visible delivery owned by Slack runtime.

#### Scenario: Automatic compaction runs

- **WHEN** a new turn is about to use oversized reusable Pi history
- **THEN** Junior SHALL run compaction after loading reusable history and before assistant execution receives `piMessages`

#### Scenario: Upcoming turn uses compacted history

- **WHEN** compaction succeeds before assistant execution
- **THEN** Junior SHALL pass the compacted replacement history to the upcoming turn

#### Scenario: Slack status is available

- **WHEN** automatic compaction may take noticeable time and a status surface is available
- **THEN** Junior MAY show compaction progress before summarization and SHALL return to normal turn status before agent execution begins

#### Scenario: Compaction finishes

- **WHEN** automatic compaction completes
- **THEN** it SHALL NOT post a Slack thread message by itself

### Requirement: Token budget triggers

Junior SHALL base compaction thresholds on model context capacity rather than cumulative turn token totals alone.

#### Scenario: Agent Pi-history threshold is calculated

- **WHEN** Junior calculates automatic Pi-history compaction threshold
- **THEN** it SHALL derive the threshold from the active agent model context window, output reserve, and configured override when model metadata is missing or intentionally constrained

#### Scenario: Visible conversation threshold is calculated

- **WHEN** Junior calculates visible conversation-state compaction threshold
- **THEN** it SHALL derive the threshold from auxiliary model metadata used by routing and summary calls

#### Scenario: Usage measurements are available

- **WHEN** server-reported input-token counts are available for relevant prompt sizing
- **THEN** Junior SHOULD prefer them over character estimates

#### Scenario: Only cumulative usage is available

- **WHEN** only cumulative multi-call turn token usage is available
- **THEN** Junior SHALL NOT use it as the sole trigger input because it can overstate the next prompt size

### Requirement: Compaction failure behavior

Junior SHALL keep compaction failures non-destructive and avoid blocking ordinary turn handling when safe.

#### Scenario: Summarization fails

- **WHEN** automatic pre-turn summary generation fails before provider prompt rejection
- **THEN** Junior SHALL continue with the prior reusable history

#### Scenario: Replacement persistence fails

- **WHEN** compacted replacement history cannot be persisted
- **THEN** Junior SHALL continue with the prior reusable history and SHALL NOT update the reusable session pointer to a missing projection

#### Scenario: Retained-message parsing fails

- **WHEN** Junior cannot parse an individual source message shape for retained verbatim history
- **THEN** it SHALL omit that message from retained user messages and rely on the handoff summary

### Requirement: Compaction verification taxonomy

Context compaction verification SHALL separate deterministic replacement mechanics, runtime pre-turn wiring, and model-visible continuity quality.

#### Scenario: Retained-message and budget mechanics are verified

- **WHEN** verifying text selection, runtime-context stripping, base64 omission, token threshold math, summary input bounding, or projection non-rewrite behavior
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Slack runtime wiring is verified

- **WHEN** verifying compaction status, use of compacted Pi history on the next turn, active-session precedence, or awaiting-resume skip behavior
- **THEN** the primary coverage SHALL be integration tests

#### Scenario: Long-thread continuity is verified

- **WHEN** verifying whether the model answers correctly from a compacted handoff
- **THEN** verification SHALL use evals because the contract depends on model interpretation
