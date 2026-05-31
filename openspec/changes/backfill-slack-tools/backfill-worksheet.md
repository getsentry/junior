# Backfill Worksheet: `slack-tools`

## Scope

- Capability: Slack tools
- Change: `backfill-slack-tools`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/slack-tools/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/tool-execution.md`: shared Pi tool wrapping, result normalization, expected tool failures, and turn-local idempotency.
- `specs/harness-tool-context.md`: context-bound Slack targeting and missing-context failure behavior.
- `specs/slack-outbound-contract.md`: direct Slack Web API formatting, retry, and error mapping.
- `specs/reply-planning.md`: final reply suppression after successful channel post/reaction/canvas side effects.
- `specs/testing.md`: test layer boundaries.

### Code Paths

- `packages/junior/src/chat/tools/index.ts`: Slack tool registration and channel capability gating.
- `packages/junior/src/chat/tools/channel-capabilities.ts`: channel capability derivation.
- `packages/junior/src/chat/tools/slack/message-add-reaction.ts`: current-message reaction tool.
- `packages/junior/src/chat/tools/slack/channel-post-message.ts`: active-channel post tool.
- `packages/junior/src/chat/tools/slack/channel-list-messages.ts`: active-channel history read tool.
- `packages/junior/src/chat/tools/slack/thread-read.ts`: URL/coordinate Slack thread read tool and safe projection.
- `packages/junior/src/chat/tools/slack/canvas-tools.ts`: canvas create/read/edit/write tool definitions.
- `packages/junior/src/chat/tools/slack/canvases.ts`: Slack Canvas API helpers, markdown normalization, file metadata validation, and private download.
- `packages/junior/src/chat/tools/slack/list-tools.ts` and `lists.ts`: Slack List create/add/read/update tools and API helpers.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/slack/tool-registration.test.ts`
  - `packages/junior/tests/unit/slack/slack-message-add-reaction-tool.test.ts`
  - `packages/junior/tests/unit/tools/slack-canvas-id.test.ts`
  - `packages/junior/tests/unit/slack/slack-canvas-markdown.test.ts`
- Integration:
  - `packages/junior/tests/integration/slack-channel-tools.test.ts`
  - `packages/junior/tests/integration/slack-thread-read.test.ts`
  - `packages/junior/tests/integration/slack-canvases.test.ts`
  - `packages/junior/tests/integration/slack-canvas-read.test.ts`
  - `packages/junior/tests/integration/slack-canvas-edit.test.ts`
  - `packages/junior/tests/integration/slack-list-tools.test.ts`
  - `packages/junior/tests/integration/tool-idempotency.test.ts`
  - `packages/junior/tests/integration/slack/assistant-context-canvas-routing.test.ts`
  - `packages/junior/tests/integration/slack/canvas-failure-recovery-behavior.test.ts`
- Evals:
  - Natural-language tool selection and reply quality belongs to agent behavior evals.

## Prior Art

- Slack reaction, channel post/history, Canvas, and List APIs require concrete Slack conversation/message/list/canvas identifiers and scopes.
- Slack Canvas APIs use markdown `document_content`; Canvas edit supports operations such as replace/insert/delete and currently applies one operation per API call.
- Slack Lists APIs require `list_id` for item operations and use rich field payloads for text fields.
- Junior intentionally hides most destination identifiers from model arguments and binds them from runtime context or artifact state.

Sources:

- Slack Canvas create docs: https://docs.slack.dev/reference/methods/canvases.create/
- Slack Canvas edit docs: https://docs.slack.dev/reference/methods/canvases.edit/
- Slack Canvas surface docs: https://docs.slack.dev/surfaces/canvases
- Slack Lists create docs: https://docs.slack.dev/reference/methods/slackLists.create/
- Slack Lists item create docs: https://docs.slack.dev/reference/methods/slackLists.items.create

## Implemented Behavior

- Behavior that code currently enforces:
  - Channel post/history tools are omitted in DM context; reactions and canvas create remain available when context allows.
  - Context-bound tools omit model-selected destination fields.
  - Reaction target is active channel/message timestamp and emoji aliases are normalized.
  - Channel post target is active channel and returns permalink when available.
  - Channel history returns bounded message data and handles invalid cursor with retry guidance.
  - Thread read parses Slack URLs, blocks private/DM reads outside current conversation, strips private URLs, and truncates returned messages.
  - Canvas create uses active conversation context, grants channel access best effort, stores recent canvas artifact state, and dedupes repeated creates.
  - Canvas read validates canvas/file IDs, uses `files.info`, confirms Canvas metadata, downloads private content, and returns bounded markdown.
  - Canvas edit uses exact replacements and compact diffs; canvas write is explicit full replacement.
  - Canvas markdown normalizes headings deeper than h3.
  - Slack list create stores active list ID/permalink/column map; follow-up list tools use artifact state.
  - List item operations dedupe identical same-turn operations.
- Behavior that tests currently verify:
  - Tool registration by channel context.
  - Reaction normalization and target behavior.
  - Channel post/history behavior.
  - Thread read URL parsing and safe projection.
  - Canvas create/read/edit/write, assistant context routing, markdown normalization, and failure recovery.
  - List creation/add/read/update and idempotency.
- Behavior that appears accidental or weakly enforced:
  - Several `{ ok:false }` paths are not yet classified; repairable failures should throw `ToolInputError`, while legitimate read-domain negative results need explicit spec coverage.
  - Read access for public channels relies on Slack API success and local prefix rules for private/DM refusal.
  - List APIs are newer and may need stronger schema/version monitoring.
  - Canvas access grants are best effort; tool result may succeed even if access set fails.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Bind Slack targets from runtime/artifact state.
  - Expose Slack tools only when active context supports them.
  - Keep private URLs/secrets out of tool results.
  - Deduplicate repeated same-turn side effects.
  - Treat canvases as document handles and lists as active artifacts.
- Behavior that should remain implementation detail:
  - Exact Slack API helper names.
  - Exact Slack request payload construction owned by outbound/tools helpers.
  - Exact recent-canvas list length.
  - Exact text truncation thresholds unless product fixes them.
- Behavior that should be non-goal:
  - Normal final thread reply delivery.
  - Slack outbound retry/error mapping.
  - Natural-language decision to use a Slack tool.
  - Cross-workspace arbitrary Slack administration.

## Undefined Behavior / Open Questions

| Question                                                                 | Evidence                                                                                             | Options                                                                                            | Recommendation                                                                                                                                 | Status |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Which Slack `{ ok:false }` results are failures versus read-domain data? | Tool-execution policy says repairable failures must throw; current tools often return sentinel data. | Convert all failures, keep explicitly specified read no-results as data, or carve out named tools. | Audit and convert missing context/invalid input; keep true read no-results only when the Slack tool spec names them as successful domain data. | open   |
| Should channel-history tools work in DM context?                         | Registration omits channel tools in DMs.                                                             | Keep omitted, allow current DM history, or add separate DM read tool.                              | Keep omitted unless product asks for DM history reads.                                                                                         | open   |
| Is canvas create in DMs intended?                                        | Registration allows canvas create for D context.                                                     | Keep, disable, or configure by workspace.                                                          | Keep if access grant path is verified.                                                                                                         | open   |
| Should canvas/list idempotency be durable?                               | Current cache is turn-local.                                                                         | Turn-local, session-local, or provider-level durable.                                              | Keep turn-local until duplicate side effects across resume are observed.                                                                       | open   |
| Should canvas access grant failure fail creation?                        | Current helper logs and continues.                                                                   | Best effort, warning result, or hard failure.                                                      | Keep best effort but make visibility caveat explicit in product docs if needed.                                                                | open   |

## OpenSpec Requirements Draft

| Requirement                     | Scenarios                                     | Source Evidence                 | Notes                               |
| ------------------------------- | --------------------------------------------- | ------------------------------- | ----------------------------------- |
| Slack tool availability         | shared channel, DM, none                      | registration tests              | Capability gating.                  |
| Context-bound Slack targets     | reaction, post, list, missing context         | harness-tool-context, tool code | Main safety rule.                   |
| Slack reaction tool             | normalize, invalid, dedupe                    | reaction tool/tests             | Failure shape gap.                  |
| Slack channel post tool         | success, dedupe, normal reply                 | channel tool/tests              | Reply planning cross-link.          |
| Slack channel/thread read tools | history, cursor, URL, private, files          | thread/channel code/tests       | Safe projection.                    |
| Slack canvas tools              | create, normalize, invalid, read, edit, write | canvas code/tests               | Document tools.                     |
| Slack list tools                | create, add, get, update, missing list        | list code/tests                 | Artifact state.                     |
| Slack side-effect idempotency   | canvas/list/reaction/post repeat, later turn  | idempotency tests               | Turn-local.                         |
| Verification taxonomy           | unit, integration, eval                       | testing spec                    | Keep low-level HTTP in integration. |

## Migration Notes

- Canonical spec updates:
  - Add `slack-tools` to index after acceptance.
  - Keep raw API request rules in `slack-outbound-contract`.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Keep broad Slack delivery spec focused on user-visible final delivery, not tool internals.
- Test/eval taxonomy changes:
  - Rename broad Slack tool tests only if discoverability improves.
  - Map natural-language tool-use evals separately from deterministic tool contracts.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-slack-tools' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: sentinel failure alignment, DM canvas create policy, channel-history DM policy, and durable idempotency.
