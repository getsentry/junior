# Tasks

## 1. Source Metadata

- [ ] Add a compact source identity to deferred catalog tool metadata.
- [ ] Populate plugin tool sources during plugin tool registration.
- [ ] Use the plugin name as the first-party plugin source id, such as `memory`.
- [ ] Add or derive concise source descriptions without exposing full plugin
      manifests per tool.

## 2. Search Tool Contract

- [ ] Add optional nullable `source` input to `searchTools`.
- [ ] Treat omitted, null, and empty `query` as no query filter.
- [ ] Treat omitted and null `source` as all-source search.
- [ ] Filter catalog search by source when provided.
- [ ] Return structured empty results with known sources for unknown source
      values.
- [ ] Bound empty-query all-source responses so they do not dump the full
      catalog.

## 3. Model-Visible Guidance

- [ ] Update the `searchTools` description to advertise deferred sources.
- [ ] List source summaries, not every known tool, in the direct tool
      description.
- [ ] Keep `executeTool` guidance aligned with the discovery path.
- [ ] Summarize source and tool descriptions before rendering them to the model.

## 4. Result Shape

- [ ] Return unique compact `sources` summaries at the top level.
- [ ] Omit per-tool `source` when results are filtered to one source.
- [ ] Include only compact per-tool source ids for cross-source results.
- [ ] Avoid repeating expanded plugin or provider metadata per tool.
- [ ] Preserve useful tool fields: `tool_name`, description, input schema,
      input schema summary, call notes, and annotations.

## 5. Verification

- [ ] Add unit coverage for source filtering.
- [ ] Add unit coverage for unknown source responses.
- [ ] Add unit coverage for empty-query source listing behavior.
- [ ] Add unit coverage for filtered and mixed-source result shapes.
- [ ] Add unit coverage for description summarization/truncation.
- [ ] Add integration coverage that plugin deferred tools carry source metadata.
- [ ] Run focused memory workflow evals when local Postgres and model
      credentials are available.
- [ ] Run local-agent validation for explicit remember and forget flows.

## 6. Documentation

- [ ] Update canonical specs after the implementation contract is accepted.
- [ ] Link the accepted contract from plugin runtime and agent/tool specs where
      appropriate.
