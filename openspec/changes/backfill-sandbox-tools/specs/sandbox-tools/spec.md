## ADDED Requirements

### Requirement: Sandbox lifecycle for tools

Junior SHALL execute sandbox tools against an active Vercel Sandbox workspace without promising durable recovery after sandbox stop.

#### Scenario: Sandbox tool is called and active sandbox exists

- **WHEN** a sandbox-backed tool is called and an active sandbox can be reused
- **THEN** Junior SHALL execute the tool against that active sandbox workspace

#### Scenario: Sandbox tool is called without active sandbox

- **WHEN** a sandbox-backed tool is called and no active sandbox exists
- **THEN** Junior SHALL create or retrieve a sandbox according to session-manager policy before executing the tool

#### Scenario: Runtime dependency snapshot is available

- **WHEN** a fresh sandbox is needed and a valid runtime dependency snapshot exists
- **THEN** Junior MAY create the sandbox from that snapshot as a warm start
- **AND** Junior SHALL treat the resulting sandbox as a new active workspace, not a resumed stopped workspace

#### Scenario: Sandbox remains active during a long turn

- **WHEN** sandbox-backed work is active
- **THEN** Junior SHALL extend the sandbox timeout when supported so the active workspace remains available for the turn

#### Scenario: Sandbox has stopped

- **WHEN** a non-persistent sandbox has stopped or timed out
- **THEN** Junior SHALL NOT assume files from that stopped workspace remain recoverable unless a separate persistent/snapshot contract provides them

### Requirement: Sandbox executor routing

Junior SHALL expose sandbox tool definitions through the shared tool wrapper while executing them through the sandbox executor.

#### Scenario: Host implementation is called directly

- **WHEN** a sandbox tool's host `execute` implementation is invoked without sandbox execution enabled
- **THEN** it SHALL fail with a clear sandbox-unavailable error

#### Scenario: Shared wrapper owns a sandbox tool

- **WHEN** `tool-execution` detects that the sandbox executor owns a sandbox tool name
- **THEN** it SHALL route the call to the sandbox executor with normalized sandbox input

#### Scenario: Sandbox executor returns a result

- **WHEN** the sandbox executor returns tool output
- **THEN** Junior SHALL return the normalized content/details through the Pi tool result channel

### Requirement: Workspace path confinement

Junior SHALL keep sandbox filesystem inspection and mutation tools scoped to the sandbox workspace unless a tool explicitly documents a broader generated-artifact path.

#### Scenario: File tool receives relative path

- **WHEN** a structured filesystem tool receives a relative path
- **THEN** Junior SHALL resolve it under `/vercel/sandbox`

#### Scenario: File tool receives workspace absolute path

- **WHEN** a structured filesystem tool receives an absolute path under `/vercel/sandbox`
- **THEN** Junior MAY operate on that path

#### Scenario: File tool receives path outside workspace

- **WHEN** a structured filesystem tool receives a path outside `/vercel/sandbox`
- **THEN** Junior SHALL reject the call as a model-repairable input error

#### Scenario: Attachment tool receives generated artifact path

- **WHEN** `attachFile` receives an absolute generated-artifact path outside the workspace such as `/tmp/...`
- **THEN** Junior MAY read it only through the sandbox workspace abstraction and SHALL NOT read from the host filesystem

### Requirement: Bounded file reading

Junior SHALL read sandbox files in bounded line windows suitable for model context.

#### Scenario: Read file without explicit range

- **WHEN** `readFile` reads a small file without offset or limit
- **THEN** Junior SHALL return the file content with line-count metadata

#### Scenario: Read file with range

- **WHEN** `readFile` receives offset or limit
- **THEN** Junior SHALL return only that line window with start/end line metadata

#### Scenario: File has more content after returned range

- **WHEN** `readFile` returns a truncated range
- **THEN** Junior SHALL include continuation guidance for reading the next range

#### Scenario: Read target is missing

- **WHEN** `readFile` target is missing
- **THEN** Junior SHALL return or throw a model-visible missing-file result according to the sandbox executor contract

### Requirement: Bounded workspace discovery

Junior SHALL provide deterministic, bounded file listing and search tools.

#### Scenario: Listing a directory

- **WHEN** `listDir` lists a workspace directory
- **THEN** Junior SHALL return sorted entries and mark directories distinctly

#### Scenario: Finding files by glob

- **WHEN** `findFiles` searches by glob pattern
- **THEN** Junior SHALL return bounded paths relative to the search root
- **AND** Junior SHALL skip dependency/cache directories such as `.git` and `node_modules`

#### Scenario: Grepping file contents

- **WHEN** `grep` searches workspace file contents
- **THEN** Junior SHALL return bounded line-numbered matches with optional context lines

#### Scenario: Search output exceeds limits

- **WHEN** list/find/grep output exceeds result, line, or character budgets
- **THEN** Junior SHALL truncate output with an explicit model-visible notice

#### Scenario: Search root is missing

- **WHEN** list/find/grep target path is missing
- **THEN** Junior SHALL return a model-visible not-found result instead of treating the missing path as a sandbox system failure

### Requirement: Exact edit behavior

Junior SHALL apply targeted edits through exact, ordered text replacements.

#### Scenario: Edit replacement is unique

- **WHEN** `editFile` receives exact replacements that each match uniquely and do not overlap
- **THEN** Junior SHALL apply the replacements, preserve original line-ending style and BOM when present, and return a compact diff

#### Scenario: Edit replacement is ambiguous

- **WHEN** an `editFile` replacement matches more than one location
- **THEN** Junior SHALL reject the edit as a model-repairable input error

#### Scenario: Edit replacement is missing

- **WHEN** an `editFile` replacement does not match the target file
- **THEN** Junior SHALL reject the edit as a model-repairable input error

#### Scenario: Multiple replacements target same file

- **WHEN** multiple replacements are needed in one file
- **THEN** Junior SHALL support applying them in one `editFile` call against the original file content

### Requirement: Full-file write behavior

Junior SHALL reserve full-file writes for intentional file creation or deliberate full replacement.

#### Scenario: New file is written

- **WHEN** `writeFile` writes a new workspace path
- **THEN** Junior SHALL write the supplied UTF-8 content to that path

#### Scenario: Existing file needs targeted change

- **WHEN** the model intends to change a small portion of an existing file
- **THEN** Junior SHOULD use `editFile` rather than replacing the whole file with `writeFile`

### Requirement: Bash command behavior

Junior SHALL run shell commands inside the isolated sandbox workspace when shell execution is required.

#### Scenario: Bash command is executed

- **WHEN** the model calls `bash`
- **THEN** Junior SHALL run the command in the sandbox environment rather than on the host

#### Scenario: Bash command has timeout

- **WHEN** the model supplies a command timeout
- **THEN** Junior SHALL pass the bounded timeout to the sandbox executor when supported

#### Scenario: Bash command output is large or interrupted

- **WHEN** command output exceeds executor limits or the command is interrupted
- **THEN** Junior SHALL surface bounded stdout/stderr/status details so the model can decide whether to retry, narrow, or report failure

### Requirement: Sandbox file attachment

Junior SHALL let the agent attach sandbox-generated files to the final Slack reply through reply file hooks.

#### Scenario: Existing sandbox file is attached

- **WHEN** `attachFile` reads a non-empty sandbox file within the attachment size budget
- **THEN** Junior SHALL emit a `FileUpload` with filename, MIME type, and bytes through generated-file hooks

#### Scenario: Same-turn generated file is already available

- **WHEN** `attachFile` cannot read the sandbox path but a same-turn generated file with the requested basename exists
- **THEN** Junior SHALL attach the generated file from the hook cache

#### Scenario: Attachment MIME type is not explicit

- **WHEN** `attachFile` lacks an explicit MIME type
- **THEN** Junior SHALL detect it from the sandbox `file` command when available and otherwise infer it from filename extension

#### Scenario: Attachment file is missing, empty, or too large

- **WHEN** `attachFile` cannot find the file, reads an empty file, or reads a file larger than the attachment budget
- **THEN** Junior SHALL fail the tool call rather than claiming the file was attached

### Requirement: Sandbox-tools verification taxonomy

Sandbox-tools verification SHALL separate pure file algorithms, sandbox adapter wiring, and live sandbox/network behavior.

#### Scenario: Pure file helpers are verified

- **WHEN** verifying path resolution, bounded reads, exact edits, list/find/grep traversal, truncation, or missing-path formatting
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Sandbox adapter wiring is verified

- **WHEN** verifying Vercel Sandbox SDK shape adaptation, lazy sandbox acquisition, timeout extension, generated-file handoff, or sandbox executor routing
- **THEN** the primary coverage SHALL be unit or integration tests with a mocked sandbox SDK

#### Scenario: Live sandbox egress or network behavior is verified

- **WHEN** verifying real Vercel Sandbox network, credentials, or egress proxy behavior
- **THEN** the primary coverage MAY require integration tests or evals with host credentials and network access
