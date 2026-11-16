# Tasks

## 1. Source Metadata

- [x] Add a compact source identity to deferred catalog tool metadata.
- [x] Populate plugin tool sources during plugin tool registration.
- [x] Use the plugin name as the first-party plugin source id, such as `memory`.
- [x] Add or derive concise source descriptions without exposing full plugin
      manifests per tool.

## 2. Search Tool Contract

- [x] Add optional nullable `source` input to `searchTools`.
- [x] Treat omitted, null, and empty `query` as no query filter.
- [x] Treat omitted and null `source` as all-source search.
- [x] Filter catalog search by source when provided.
- [x] Return structured empty results with known sources for unknown source
      values.
- [x] Bound empty-query all-source responses so they do not dump the full
      catalog.

## 3. Model-Visible Guidance

- [x] Update the `searchTools` description to advertise deferred sources.
- [x] List source summaries, not every known tool, in the direct tool
      description.
- [x] Keep `executeTool` guidance aligned with the discovery path.
- [x] Summarize source and tool descriptions before rendering them to the model.

## 4. Result Shape

- [x] Return unique compact `sources` summaries at the top level.
- [x] Omit per-tool `source` when results are filtered to one source.
- [x] Include only compact per-tool source ids for cross-source results.
- [x] Avoid repeating expanded plugin or provider metadata per tool.
- [x] Return `tool_name`, description, and call notes. Return the full input
      schema for the first result of a query only, and a params summary for
      other results. Do not return exposure or annotations.

## 5. Verification

- [x] Add unit coverage for source filtering.
- [x] Add unit coverage for unknown source responses.
- [x] Add unit coverage for empty-query source listing behavior.
- [x] Add unit coverage for filtered and mixed-source result shapes.
- [x] Add unit coverage for description summarization/truncation.
- [ ] Add integration coverage that plugin deferred tools carry source metadata.
- [ ] Run focused memory workflow evals when local Postgres and model
      credentials are available.
- [ ] Run local-agent validation for explicit remember and forget flows.

## 6. Documentation

- [ ] Update the owning plugin/tool README after the implementation contract is
      accepted.
- [ ] Delete this plan after durable documentation and verification land.
