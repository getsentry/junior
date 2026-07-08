# Deferred Tool Discovery

## ADDED Requirements

### Requirement: Deferred Tools Are Discoverable By Source

Junior SHALL expose deferred catalog tool availability through a stable
model-facing `source` grouping.

#### Scenario: Deferred plugin tool has source identity

- **WHEN** a plugin registers a deferred tool
- **THEN** Junior records a compact source id for that tool
- **AND** first-party plugin tools use the plugin name as the source id
- **AND** source ids do not include actor ids, workspace ids, credential
  subjects, or transient connection state.

#### Scenario: Future MCP provider source

- **WHEN** MCP provider tools are represented in the deferred catalog
- **THEN** Junior groups them under provider-qualified source ids such as
  `mcp:sentry`
- **AND** Junior does not create separate source ids for individual upstream
  tools, resources, projects, or issues.

### Requirement: Search Tool Advertises Deferred Sources

The native `searchTools` tool SHALL tell the model that deferred tools exist and
list the known searchable sources when those sources are known at turn start.

#### Scenario: Search tool description includes sources

- **WHEN** Junior creates the native `searchTools` definition
- **THEN** the description explains that deferred tools are grouped by source
- **AND** the description tells the model to search a source before using
  `executeTool`
- **AND** the description lists compact source summaries
- **AND** the description does not enumerate every tool in every source.

### Requirement: Search Tools Supports Source Filtering

`searchTools` SHALL accept an optional nullable `source` field that filters
catalog discovery.

#### Scenario: Search within a source

- **WHEN** the model calls `searchTools` with `source: "memory"`
- **THEN** Junior returns only catalog tools from the `memory` source
- **AND** query matching is applied within that source when `query` is present.

#### Scenario: Empty source query lists source tools

- **WHEN** the model calls `searchTools` with a source and no query filter
- **THEN** Junior returns a bounded list of tools from that source.

#### Scenario: Search across all sources

- **WHEN** the model calls `searchTools` without a source
- **THEN** Junior searches across all eligible catalog tools
- **AND** an empty query returns source summaries and only a bounded tool sample.

#### Scenario: Unknown source

- **WHEN** the model calls `searchTools` with an unknown source
- **THEN** Junior returns a structured result with no tools
- **AND** the result includes known sources so the model can repair the call
- **AND** Junior does not throw a runtime exception for the unknown source.

### Requirement: Search Results Are Compact

`searchTools` results SHALL avoid repeating expanded source metadata on every
tool.

#### Scenario: Filtered result shape

- **WHEN** a search is filtered to one source
- **THEN** the result includes the selected source in a top-level `sources`
  array
- **AND** individual tool results omit per-tool `source`.

#### Scenario: Cross-source result shape

- **WHEN** a search returns tools from multiple sources
- **THEN** the result includes unique compact source summaries at the top level
- **AND** individual tool results may include only the compact source id
- **AND** individual tool results do not include expanded plugin manifests, MCP
  provider configuration, credential state, or connection metadata.

### Requirement: Model-Visible Descriptions Are Summarized

Junior SHALL summarize source and tool descriptions before rendering them in
native tool descriptions or `searchTools` results.

#### Scenario: Long description is rendered

- **WHEN** a source or tool description contains multiple paragraphs or exceeds
  the model-visible summary cap
- **THEN** Junior normalizes whitespace
- **AND** Junior prefers the first meaningful line or paragraph before a blank
  break
- **AND** Junior truncates the rendered summary to a hard cap around 160-200
  characters.

#### Scenario: Search indexing uses richer text

- **WHEN** Junior searches the catalog
- **THEN** it may use full tool descriptions, prompt snippets, prompt
  guidelines, schemas, and annotations for matching
- **AND** the rendered result still uses summarized model-visible descriptions.

### Requirement: Execute Tool Remains The Deferred Execution Bridge

Junior SHALL continue using `executeTool` to execute deferred catalog tools until
Junior supports first-class deferred tool loading.

#### Scenario: Model discovers then executes a tool

- **WHEN** the model needs a deferred capability but does not know the exact
  tool name
- **THEN** it can call `searchTools`
- **AND** use the returned exact `tool_name` in `executeTool`
- **AND** pass arguments matching the selected tool schema.

#### Scenario: Invalid catalog execution

- **WHEN** the model calls `executeTool` for a tool outside the executable
  catalog or with invalid arguments
- **THEN** Junior returns the existing model-repairable tool error
- **AND** it does not silently execute an unavailable or mismatched tool.
