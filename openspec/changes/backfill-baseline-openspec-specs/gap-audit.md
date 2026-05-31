# Baseline Backfill Gap Audit

## Method

Audit each capability in tracker order. For each spec, classify gaps as:

- **Canonicalization gap**: OpenSpec artifacts are valid, but acceptance/archive/index/prose cleanup is unfinished.
- **Requirement vs implementation gap**: normative behavior is not implemented, weakly implemented, or implemented in a way that conflicts with the spec.
- **Verification gap**: behavior may be implemented, but tests/evals/manual checks do not prove the contract at the right layer.
- **Open question**: behavior is intentionally undefined and should remain explicit until product/engineering decides.

Severity:

- **P0**: likely current behavior/security/data-loss bug or blocks acceptance.
- **P1**: important acceptance gap, missing coverage for high-risk behavior, or cross-spec ambiguity likely to cause regressions.
- **P2**: cleanup, taxonomy, naming, brittle tests, or deferred governance.

## Audit Order

1. `agent-turn-handling`
2. `slack-agent-delivery`
3. `agent-session-resumability`
4. `agent-prompt`
5. `harness-agent`
6. `context-compaction`
7. Continue tracker order through Tier 1-6.

## `agent-turn-handling`

Sources reviewed:

- `openspec/changes/spec-agent-turn-handling/**`
- `specs/agent-turn-handling.md`
- `packages/junior/src/chat/ingress/message-router.ts`
- `packages/junior/src/chat/runtime/slack-runtime.ts`
- `packages/junior/src/chat/runtime/reply-executor.ts`
- `packages/junior/src/chat/prompt.ts`
- `packages/junior/src/chat/services/turn-result.ts`
- Referenced eval and verification maps

### Summary

Core participation/routing behavior appears implemented: DMs become active requests, subscribed messages are considered, explicit mentions route active when unsubscribed, and new mentions subscribe/reply. No P0 runtime mismatch was found in this pass.

The gaps are mostly canonicalization debt plus a few places where the spec says “SHALL” but enforcement is prompt/eval-shaped rather than deterministic runtime behavior.

### Canonicalization Gaps

| Severity | Gap                                                                                  | Evidence                                                                                                                                                                | Follow-up                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1       | OpenSpec change is complete but not archived/canonicalized into `openspec/specs/**`. | `openspec/specs/**` has no `agent-turn-handling`; active artifact remains under `openspec/changes/spec-agent-turn-handling`.                                            | Decide canonical model: archive to OpenSpec canonical tree or explicitly keep root `specs/agent-turn-handling.md` as canonical and mark OpenSpec artifact as backfill evidence only. |
| P1       | Backfill worksheet contains stale canonicalization language.                         | `openspec/changes/spec-agent-turn-handling/backfill-worksheet.md` still says drafted/not-yet-canonical while root `specs/agent-turn-handling.md` exists and is indexed. | Update during acceptance cleanup.                                                                                                                                                    |
| P2       | Verification map has stale “Need canonical spec publication” text.                   | `openspec/changes/spec-agent-turn-handling/verification-map.md`.                                                                                                        | Clean up after deciding canonical model.                                                                                                                                             |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                               | Evidence                                                                                                                                                                                                                                  | Follow-up                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Slack side-effect intent is mostly prompt/model policy, not a hard runtime guard. | Prompt requires explicit side-effect request; `turn-result` suppresses duplicate text after successful side effects. No hard guard was found preventing unintended model calls to `slackChannelPostMessage` or `slackMessageAddReaction`. | Decide whether eval/prompt enforcement is sufficient or whether Slack side-effect tools should require explicit detected intent/context from runtime. |
| P1       | “Non-trivial long-running work SHALL emit progress” is prompt-level only.         | Prompt has the progress rule; no deterministic enforcement that non-trivial work calls `reportProgress`.                                                                                                                                  | Decide whether this remains model-scored behavior or becomes deterministic for specific workflows/tools.                                              |
| P2       | Self-message prevention is implemented late.                                      | Guard exists in reply execution, not the earliest Slack runtime entry point.                                                                                                                                                              | If loop prevention is intended as ingress/routing behavior, move or add earlier guard; otherwise document reply-executor as the owning boundary.      |

### Verification Gaps

| Severity | Gap                                                                | Evidence                                                                                                               | Follow-up                                                                           |
| -------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| P1       | Self-message loop prevention lacks explicit coverage.              | Verification map marks this as `add`.                                                                                  | Add focused integration/unit coverage at the intended boundary.                     |
| P1       | “Requester differs from original reporter” is not clearly covered. | Verification map says not clearly mapped; nearby routing eval tests related role behavior but not this exact scenario. | Add or map an eval/integration case for requester vs original reporter attribution. |
| P1       | Missing-access/one-focused-question behavior is weakly covered.    | Eval coverage map says add focused eval if prompt/tool-access behavior changes; spec already makes it normative.       | Add explicit eval or mark deferral with rationale.                                  |
| P2       | Eval taxonomy still needs rename/split ownership decisions.        | Verification/eval coverage maps have multiple rename/split notes.                                                      | Create eval ownership map for `agent-turn-handling` cases.                          |

### Open Questions To Preserve

- Should OpenSpec canonical truth live under `openspec/specs/agent-turn-handling`, or should root `specs/agent-turn-handling.md` remain the only canonical target for now?
- Is prompt/eval enforcement enough for Slack side effects, or should tools reject calls without explicit intent?
- Should long-running progress be aspirational/model-scored or deterministic for known workflows?
- Should assistant app-thread user messages remain grouped with DMs or get separate requirements/tests?

### Suggested Follow-up Tasks

- **P1**: Decide and execute canonicalization/archive model for `spec-agent-turn-handling`.
- **P1**: Add self-message loop coverage.
- **P1**: Add or explicitly defer requester-vs-original-reporter coverage.
- **P1**: Add or explicitly defer missing-access one-question eval coverage.
- **P1**: Decide runtime guard versus eval-only enforcement for Slack side-effect intent.
- **P2**: Build eval rename/split plan for turn-handling cases.

## `slack-agent-delivery`

Sources reviewed:

- `openspec/changes/backfill-slack-agent-delivery/**`
- `specs/slack-agent-delivery.md`
- `specs/slack-outbound-contract.md`
- `packages/junior/src/chat/runtime/slack-resume.ts`
- `packages/junior/src/chat/runtime/reply-executor.ts`
- `packages/junior/src/chat/services/turn-failure-response.ts`
- `packages/junior/src/chat/ingress/slash-command.ts`
- Slack OAuth resume, assistant thread, processing reaction, and outbound normalization tests referenced by the verification map

### Summary

This spec is close enough to baseline, but it has two concrete P1 spec/code conflicts: OAuth resume currently posts a public connected banner that canonical Slack delivery prose says must not exist, and resumed file delivery treats upload failure as best-effort while live delivery treats file upload failure as strict. The remaining gaps are mostly outbound-boundary ownership and verification-map follow-through.

### Canonicalization Gaps

| Severity | Gap                                                                                   | Evidence                                                                                                                                                                          | Follow-up                                                                                                          |
| -------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| P1       | OpenSpec change still has unchecked canonical-alignment tasks.                        | `openspec/changes/backfill-slack-agent-delivery/tasks.md` leaves canonical alignment, deprecated `files.upload` wording, assistant-status timing, and OAuth `connectedText` open. | Resolve before archive; especially decide whether canonical OAuth resume should allow any public connected banner. |
| P1       | Verification-map actions have not been converted into tracked rename/split/add tasks. | `tasks.md` keeps verification follow-up open; verification map contains multiple `add`/`split` rows.                                                                              | Turn verification rows into concrete follow-up tasks with target test/eval layer.                                  |
| P2       | Migration/cleanup remains acceptance work.                                            | `design.md` still calls for review/archive/canonical cleanup after acceptance.                                                                                                    | Keep as archive checklist item.                                                                                    |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                    | Evidence                                                                                                                                                                                                                                                        | Follow-up                                                                                                                                       |
| -------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | OAuth resume public banner conflicts with canonical Slack delivery.    | `specs/slack-agent-delivery.md` says automatic auth resumes must not post a separate public “connected, continuing” banner; `slack-resume.ts` accepts `connectedText` and posts it before resumed work; OAuth resume tests assert the public post.              | Decide policy. Likely remove public `connectedText` for automatic resumes, or update spec/tests if the product intentionally wants that banner. |
| P1       | Resumed file delivery is weaker than live file delivery.               | Canonical resume/file rules say resume flows use the same file-delivery semantics as live turns. Live reply execution treats strict file upload failure as failed delivery; resume uses `best_effort` and tests expect text to still post after upload failure. | Make resume strict for files or explicitly document best-effort resume as a product difference.                                                 |
| P2       | Interruption marker ownership is split outside Slack output boundary.  | `specs/slack-outbound-contract.md` assigns interruption marker ownership to Slack output formatting; provider-error finalization appends the marker in `turn-failure-response.ts`.                                                                              | Move marker insertion into outbound planning/output or narrow the outbound contract.                                                            |
| P2       | Slash-command ephemeral responses bypass the shared outbound boundary. | Outbound contract says ephemeral delivery goes through shared outbound; `slash-command.ts` directly calls `event.channel.postEphemeral(...)`.                                                                                                                   | Route ephemeral delivery through the shared Slack outbound boundary or document slash-command acknowledgement as a narrow ingress exception.    |

### Verification Gaps

| Severity | Gap                                                                                | Evidence                                                                                                                                                                 | Follow-up                                                                                         |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| P1       | Assistant status failure best-effort behavior lacks direct coverage.               | Verification map marks status-send failure coverage as add; implementation logs status failures, but no direct test was found for `assistant.threads.setStatus` failure. | Add integration/unit coverage at the Slack outbound/status boundary.                              |
| P1       | Processing reaction add/remove failure best-effort behavior lacks direct coverage. | Existing processing-reaction tests cover timing/preservation, not Slack API failure behavior.                                                                            | Add failure-path coverage for add/remove reaction calls.                                          |
| P1       | Compaction-progress status before execution is not mapped to current coverage.     | Implementation starts compaction status before normal execution status; verification map marks coverage as add.                                                          | Add or map an integration test proving compacting status is visible before turn execution status. |
| P2       | Assistant title source and non-blocking update behavior need explicit coverage.    | Tests assert title calls and DM `thread_ts`, but not earliest-known-human-message title selection or non-blocking failure behavior.                                      | Add focused coverage if title behavior is treated as normative.                                   |
| P2       | Footer final-chunk-only behavior is incomplete for multi-chunk replies.            | Outbound block shape is covered; no direct multi-chunk final-only footer placement coverage was found.                                                                   | Add multi-chunk delivery test or narrow the spec.                                                 |
| P2       | Slack eval taxonomy remains unmapped.                                              | Verification map leaves eval split/ownership open.                                                                                                                       | Assign evals to Slack delivery versus turn handling versus prompt/reply quality.                  |

### Open Questions To Preserve

- Is assistant status debounce/refresh timing normative or merely implementation policy?
- Should footer fields be conditional based on available facts, or frozen exactly?
- Should deprecated `files.upload` wording be replaced with a transport-neutral file-delivery contract linked to outbound behavior?
- Are OAuth `connectedText` banners allowed for automatic auth resumes?
- What are the default semantics for channel-only replies with files?

### Suggested Follow-up Tasks

- **P1**: Resolve OAuth resume banner policy and align code/spec/tests.
- **P1**: Align resumed file upload failure semantics with live delivery, or document the intentional difference.
- **P1**: Add assistant status failure and processing reaction failure behavior tests.
- **P1**: Add compaction-progress integration coverage.
- **P2**: Move interruption marker ownership fully into Slack output/planning or update the outbound spec.
- **P2**: Add assistant-title source/non-blocking coverage and multi-chunk footer placement coverage.
- **P2**: Convert Slack verification-map actions into tracked follow-up tasks.

## `agent-prompt`

Sources reviewed:

- `openspec/changes/backfill-agent-prompt/**`
- `specs/agent-prompt.md`
- `packages/junior/src/chat/prompt.ts`
- `packages/junior/src/chat/respond.ts`
- `packages/junior/tests/unit/prompt.test.ts`
- Auth resume integration tests found by `rg pendingAuth|authorization|resumed`

### Summary

The implementation broadly matches the backfilled prompt ownership model. `buildSystemPrompt()` is parameterless and static after module initialization; `buildTurnContextPrompt(...)` owns volatile current-turn context; auth lifecycle state is not an input to `buildTurnContextPrompt(...)`; user-callable skill visibility and plugin metadata omission are implemented.

The gaps are mostly acceptance and verification gaps, not obvious product bugs.

### Canonicalization Gaps

| Severity | Gap                                                                       | Evidence                                                                                               | Follow-up                                                                                                                     |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| P1       | OpenSpec change still has unchecked canonical alignment tasks.            | `openspec/changes/backfill-agent-prompt/tasks.md` has 3.1-3.4, 3.6, 4.1, 4.2 unchecked.                | Complete canonical comparison against `specs/agent-prompt.md`, then narrow/link/archive overlapping prose at acceptance time. |
| P1       | Prompt/eval taxonomy has not been converted into concrete follow-up work. | Verification map contains many `add`, `split`, and `replace` entries; tasks 4.1 and 4.2 are unchecked. | Create follow-up task list for prompt structural tests and eval ownership mapping.                                            |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                                                                                                                              | Evidence                                                                                                                                                                                                                      | Follow-up                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1       | `WORLD.md` authority is still undefined, so it could become an ungoverned policy channel.                                                                                        | `specs/agent-prompt.md` is explicit that `SOUL.md` is voice-only; worksheet/design leave `WORLD.md` authority open. Code injects `JUNIOR_WORLD` inside `<world>` when `includeSessionContext` is true.                        | Decide whether `WORLD.md` is reference/context only or may carry organization policy; update `agent-prompt` and possibly `security-policy` if it can carry policy. |
| P2       | Runtime context spec prose mentions runtime facts such as runtime version/model ids/thinking level, but implementation only renders conversation id and trace id in `<runtime>`. | `specs/agent-prompt.md` says compact runtime block may include runtime version, model ids, selected thinking level, channel capabilities, sandbox root; `buildRuntimeSection()` only supports `conversationId` and `traceId`. | Either narrow prose to current implemented runtime IDs or decide which additional runtime facts are genuinely useful and add them with tests/evals.                |
| P2       | Prompt bloat/tool-guidance duplication is purely review-governed.                                                                                                                | Spec requires compact non-duplicative prompt layers; only partial CLI skill checks exist.                                                                                                                                     | Keep manual review as default; add lint only for repeated anti-patterns.                                                                                           |

### Verification Gaps

| Severity | Gap                                                                                            | Evidence                                                                                                                                                                                                                              | Follow-up                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | No explicit prompt test proves auth lifecycle hints stay out of `buildTurnContextPrompt(...)`. | Code has no prompt `pendingAuth` input; integration tests prove session-log observations for auth completion, but prompt unit tests do not guard against reintroducing `pendingAuth`/`authorization_completed_provider` prompt flags. | Add a structural unit test or integration assertion that resumed/auth state is not materialized in turn prompt context; keep session-log projection as the only model-visible auth completion path. |
| P1       | Prompt unit tests rely heavily on inline snapshots, which overfit exact prose.                 | `packages/junior/tests/unit/prompt.test.ts` asserts large inline snapshots for context rendering. Backfill tasks explicitly ask whether snapshots should move to structural assertions.                                               | Replace broad snapshots with structural assertions for tags, omitted metadata, and key facts; reserve exact text checks for small stable labels only.                                               |
| P1       | Model-interpretation coverage is not mapped to prompt requirements.                            | Verification map lists `skill-invocation-control`, `research-reply-shape`, `passive-behavior`, `coding-file-tools`, provider evals, but action remains split/add and task 4.2 is unchecked.                                           | Map each prompt-facing eval case to `agent-prompt`, `agent-turn-handling`, `skill-runtime`, or provider specs; rename/split where needed.                                                           |
| P2       | No focused test for empty/custom `SOUL.md` preserving platform rules.                          | Verification map marks add; code builds platform behavior outside personality, but tests do not isolate customization.                                                                                                                | Add structural test with empty/custom SOUL fixture only if prompt loading is being touched.                                                                                                         |
| P2       | No explicit coverage for sandbox-unavailable prompt behavior or admin-action prompt safety.    | Verification map marks these as existing coverage unclear/add.                                                                                                                                                                        | Prefer evals/integration only if product behavior is high risk or recently regressed.                                                                                                               |

### Open Questions To Preserve

- Should prompt-builder unit tests move away from inline snapshots toward structural/tag assertions?
- Is `WORLD.md` reference context only, or can it carry broader organization policy?
- Should selected thinking level be disclosed inside runtime context?
- What threshold requires a new prompt eval for prompt changes?
- Should plugin tool guidance duplication be linted?

### Suggested Follow-up Tasks

- **P1**: Add auth-resume prompt boundary coverage proving auth completion is session-log projection only, not prompt context.
- **P1**: Convert prompt snapshot tests to structural assertions for key invariants.
- **P1**: Decide and document `WORLD.md` authority.
- **P1**: Build prompt eval ownership map from current eval taxonomy.
- **P2**: Decide whether runtime context prose should be narrowed or implementation should expose additional runtime facts.
- **P2**: Add SOUL customization structural coverage when prompt loading changes.

## `agent-session-resumability`

Sources reviewed:

- `openspec/changes/backfill-agent-session-resumability/**`
- `specs/agent-session-resumability.md`
- `specs/oauth-flows.md`
- `packages/junior/src/chat/state/session-log.ts`
- `packages/junior/src/chat/state/turn-session.ts`
- `packages/junior/src/chat/services/timeout-resume.ts`
- `packages/junior/src/handlers/turn-resume.ts`
- `packages/junior/src/chat/services/plugin-auth-orchestration.ts`
- `packages/junior/src/chat/services/mcp-auth-orchestration.ts`
- `packages/junior/src/handlers/oauth-callback.ts`
- `packages/junior/src/handlers/mcp-oauth-callback.ts`
- Session-log, OAuth, MCP auth, timeout-resume tests referenced by verification maps

### Summary

This spec has real target/current gaps. The recent auth-completion projection model is aligned: `authorization_completed` is appended in callback paths and projected into Pi as host-authored session history. But the larger canonical session-log architecture is not fully implemented: full event envelopes, `pause_event_id`, non-auth pause/delivery/error event families, and reducer-derived lifecycle are still target-state.

### Canonicalization Gaps

| Severity | Gap                                                               | Evidence                                                                                                         | Follow-up                                                                                             |
| -------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| P1       | OpenSpec task list still has unresolved target/current decisions. | `openspec/changes/backfill-agent-session-resumability/tasks.md` has 3.1, 3.2, 3.3, 3.5, 3.6, 4.1, 4.2 unchecked. | Do not archive until target/current mismatch is explicit and either implemented or formally deferred. |
| P1       | `pause_event_id` vs `expectedVersion` remains undecided.          | Task 3.2 open; implementation signs/verifies `expectedVersion`.                                                  | Decide migration or document `expectedVersion` as current accepted boundary.                          |
| P1       | `AgentTurnSessionRecord` permanence remains undecided.            | Task 3.3 open; current code stores lifecycle state in session record.                                            | Decide whether it is durable read model, rebuildable cache, or transitional scaffolding.              |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                                            | Evidence                                                                                                                                                                                                                     | Follow-up                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Canonical session-log event envelope is not implemented.                                       | Canonical spec requires event id/conversation id/turn id/created time envelope; current `session-log.ts` entries are narrow and auth entries lack event id/conversation id/turn id.                                          | Implement envelope or narrow canonical target to current event schema before acceptance.                                                    |
| P1       | Lifecycle is still primarily in `AgentTurnSessionRecord`, not derived from session-log events. | `turn-session.ts` stores `version`, `state`, `resumeReason`, `sliceId`, `committedMessageCount`, and `logSessionId`; spec says lifecycle/status/pause validity are reducer-derived and records transitional.                 | Decide/read-model strategy and update spec/code accordingly.                                                                                |
| P1       | Timeout callback validity uses `expectedVersion`, not `pause_event_id`.                        | `timeout-resume.ts` payload carries `expectedVersion`; `turn-resume.ts` checks record version.                                                                                                                               | Implement `pause_event_id` or explicitly accept expected-version concurrency for current baseline.                                          |
| P1       | Non-auth event families are absent.                                                            | Current session-log schema has `pi_message`, `projection_reset`, `mcp_provider_connected`, `authorization_requested`, `authorization_completed`; spec lists timeout/auth pause, resumed, delivered, abandoned, error events. | Prioritize event families needed for timeout/auth/delivery recovery, or mark target-state.                                                  |
| P1       | Auth pause ordering is not atomic with session-log event append.                               | Plugin/MCP orchestration calls `onPendingAuth` before `recordAuthorizationRequested`; if session-log append fails, routing state can exist without canonical auth event.                                                     | Reorder or transactionally group pending-auth/session-log updates; otherwise document pendingAuth as current source during failure windows. |
| P2       | Auth completion path is mostly aligned.                                                        | OAuth/MCP callbacks append completion before resume context; `session-log.ts` projects deterministic host observation.                                                                                                       | Keep; add ordering coverage.                                                                                                                |

### Verification Gaps

| Severity | Gap                                                                                                                                     | Evidence                                                                                                                                | Follow-up                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| P1       | No integration assertion that `authorization_requested` is stored only after successful private-link delivery/reuse for plugin and MCP. | Verification map marks this `add`.                                                                                                      | Add plugin and MCP tests for success, reuse, and failure-before-send behavior.            |
| P1       | Callback ordering is not directly proven for both plugin and MCP.                                                                       | Existing tests show resumed projection, but not that `authorization_completed` append happens before resume context is returned.        | Add callback ordering tests around `authorization_completed` and `resumeSlackTurn` setup. |
| P1       | Prompt denylist coverage for auth lifecycle flags is absent.                                                                            | Verification map marks lack of `pendingAuth`, `authorization_completed_provider`, `<turn-state>resumed</turn-state>` denylist coverage. | Add structural prompt/context test; also listed under `agent-prompt`.                     |
| P2       | Unsafe in-flight tool-call boundary coverage is missing/indirect.                                                                       | Verification map marks gap.                                                                                                             | Add explicit safe-boundary test for tool call without matching result.                    |
| P2       | Corrupt session-log parse/fail-loud coverage is unclear.                                                                                | Verification map marks gap.                                                                                                             | Add unit tests around malformed session-log entries and projection failure behavior.      |
| P2       | Resume eval taxonomy remains incomplete.                                                                                                | Verification map marks OAuth continuity eval split/inventory needed.                                                                    | Map resume evals to resumability vs OAuth vs Slack delivery.                              |

### Open Questions To Preserve

- When should `expectedVersion` be replaced by `pause_event_id`?
- Should `AgentTurnSessionRecord` remain durable read model, become rebuildable cache, or be removed after reducer support?
- Which non-auth session-log event families are needed first?
- Should timeout callbacks get a sweeper, or remain callback/user-follow-up/operator recovery only?
- How should visible-output detection work when Slack streaming has started but final delivery has not completed?

### Suggested Follow-up Tasks

- **P1**: Decide and document target/current boundary for event envelope, `pause_event_id`, and `AgentTurnSessionRecord`.
- **P1**: Fix or explicitly document auth pause atomicity around `pendingAuth` versus `authorization_requested`.
- **P1**: Add plugin and MCP tests for `authorization_requested` after private send/reuse and failure-before-send.
- **P1**: Add plugin and MCP callback ordering tests for `authorization_completed`.
- **P1**: Add prompt denylist coverage for auth lifecycle flags.
- **P2**: Add unsafe in-flight tool-call boundary and corrupt session-log parse tests.
- **P2**: Convert verification-map add/split rows into tracked follow-up tasks.

## `harness-agent`

Sources reviewed:

- `openspec/changes/backfill-harness-agent/**`
- `specs/harness-agent.md`
- `packages/junior/src/chat/respond.ts`
- `packages/junior/src/chat/services/turn-result.ts`
- `packages/junior/tests/unit/turn-result.test.ts`
- `packages/junior/tests/unit/runtime/respond-timeout-resume.test.ts`
- `packages/junior/tests/unit/runtime/respond-provider-retry.test.ts`
- Slack integration tests found by `rg onTextDelta|streaming_*|turn_timeout_resume`

### Summary

The core harness mechanics are largely implemented and have good deterministic unit coverage: terminal output extraction, execution-failure fallback, provider-error diagnostics, side-effect-only success, timeout resume, and provider retry are represented in code/tests. The largest gaps are acceptance debt, unclear ownership of side-effect-only success versus reply planning, and missing focused coverage for streaming callback/separator behavior.

### Canonicalization Gaps

| Severity | Gap                                                    | Evidence                                                                                                                                                                                                     | Follow-up                                                                                                                                  |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P1       | OpenSpec change still has unchecked acceptance tasks.  | `openspec/changes/backfill-harness-agent/tasks.md` has 3.1-3.3 and 4.1-4.2 unchecked.                                                                                                                        | Complete canonical comparison, diagnostics field stability decision, and eval taxonomy split before archiving.                             |
| P1       | Side-effect-only success ownership is still ambiguous. | OpenSpec task 3.2 asks whether side-effect-only delivery planning belongs in harness output resolution or reply planning; `buildTurnResult()` currently computes side-effect-only success and delivery plan. | Decide ownership. If reply planning owns it, narrow harness spec to output signal and move delivery suppression rules to `reply-planning`. |
| P2       | Diagnostics field stability is not decided.            | OpenSpec task 3.3 unchecked; `AgentTurnDiagnostics` has many fields used for footers/telemetry.                                                                                                              | Mark which diagnostics are contract versus presentation/telemetry details.                                                                 |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                                                                                                      | Evidence                                                                                                                                                                                                                            | Follow-up                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Canonical prose says final assistant messages are joined by `\"\\n\"`; implementation joins terminal assistant messages with blank lines (`\"\\n\\n\"`). | `specs/harness-agent.md` says joined by `\"\\n\"`; `buildTurnResult()` uses `.join(\"\\n\\n\")`. OpenSpec says join/trim without freezing separator except streaming separator scenario.                                            | Resolve by updating canonical prose/OpenSpec to the actual blank-line behavior, or change implementation/tests if single-newline is intended.                                |
| P1       | Streaming separator contract may not match final output separator precisely.                                                                             | OpenSpec requires separator so streamed text remains readable relative to final joined output; `respond.ts` inserts `\"\\n\\n\"` between consecutive assistant messages, which matches `buildTurnResult()` but not canonical prose. | Align canonical wording and add direct coverage for multi-message streaming separator.                                                                                       |
| P2       | Side-effect-only success includes `replyFiles.length > 0` regardless of whether file delivery later succeeds.                                            | `buildTurnResult()` treats files as success signal before Slack delivery; Slack runtime can still fail delivery later.                                                                                                              | Clarify that harness success means generated file output exists, while outer Slack completion still depends on delivery; cross-link `reply-planning`/`slack-agent-delivery`. |

### Verification Gaps

| Severity | Gap                                                                          | Evidence                                                                                                                                                                        | Follow-up                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1       | No focused test for consecutive assistant-message streaming separator.       | `respond.ts` has `needsSeparator` logic; `rg` found streaming integration tests for simple deltas but no direct assertion of separator between consecutive assistant messages.  | Add unit or integration test that simulates two assistant messages and asserts `onTextDelta` receives `\"\\n\\n\"` before the second message text.                 |
| P1       | No focused test for streaming callback failure being logged and non-fatal.   | `respond.ts` catches `onAssistantMessageStart`/`onTextDelta` rejections and logs `streaming_*_error`; existing tests mainly assert partial streaming survives runtime failures. | Add narrow unit test with throwing callback and successful final reply. Keep logging assertion only because this is the instrumentation/error contract under test. |
| P1       | Provider-error timeout fallback without safe resumability is marked unclear. | Verification map marks provider-error fallback coverage as `add`; timeout-resume tests focus on safe resumable boundary.                                                        | Add or locate a test where timeout occurs without conversation/session resumability and verify provider-error/failure path.                                        |
| P2       | Harness-related evals are not mapped to reply quality versus mechanics.      | Task 4.2 unchecked; verification map says split.                                                                                                                                | Assign answer-quality evals to `agent-turn-handling`/`agent-prompt`; keep deterministic mechanics in harness tests.                                                |

### Open Questions To Preserve

- Does side-effect-only delivery suppression belong to `harness-agent` or `reply-planning`?
- Which diagnostics fields are stable user/runtime contract?
- Should streaming callback errors be user-visible in any case, or always non-fatal telemetry?
- Should final-output separator be explicitly blank-line join?

### Suggested Follow-up Tasks

- **P1**: Align canonical final-output separator wording with implementation/tests.
- **P1**: Decide side-effect-only ownership and update `harness-agent`/`reply-planning` boundaries.
- **P1**: Add streaming separator coverage.
- **P1**: Add streaming callback failure non-fatal coverage.
- **P1**: Add timeout no-safe-resume fallback coverage if absent.
- **P2**: Decide stable diagnostics fields and map harness-related evals.

## `context-compaction`

Sources reviewed:

- `openspec/changes/backfill-context-compaction/**`
- `specs/context-compaction.md`
- `packages/junior/src/chat/services/context-compaction.ts`
- `packages/junior/src/chat/services/conversation-memory.ts`
- `packages/junior/src/chat/services/context-budget.ts`
- `packages/junior/src/chat/state/session-log.ts`
- `packages/junior/src/chat/runtime/reply-executor.ts`
- `packages/junior/tests/unit/services/context-compaction.test.ts`
- `packages/junior/tests/unit/state/session-log.test.ts`
- `packages/junior/tests/integration/slack/message-content-behavior.test.ts`

### Summary

Pi-history compaction has moved toward the right shape: it replaces the current model projection through the conversation session log rather than creating a parallel synthetic session, strips runtime context, preserves recent user-authored messages, and feeds compacted `piMessages` into the upcoming turn before agent execution. Visible Slack conversation-state compaction is also implemented as bounded older-message summaries plus recent messages.

The remaining gaps are important target/current decisions: projection reset events are appended through generic `commitMessages(...)` without deterministic compaction event ids or idempotency keys, the compactor does not itself know whether the latest lifecycle projection is awaiting resume, and several failure/secret/tool-result cases are only partially covered.

### Canonicalization Gaps

| Severity | Gap                                                                                                  | Evidence                                                                                                                                                                   | Follow-up                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1       | Canonical-alignment tasks remain unchecked.                                                          | `openspec/changes/backfill-context-compaction/tasks.md` leaves 3.1, 3.3, 3.4, 4.1, and 4.2 open.                                                                           | Do not archive until target/current decisions are explicit for idempotency and visible conversation-state ownership.                                               |
| P1       | Target same-log `projection_reset` is implemented, but not with the exact canonical event semantics. | Spec requires deterministic projection event id from source position or idempotency key; current `commitMessages(...)` creates a `projection_reset` with `session_#` only. | Decide whether deterministic event identity is required now or defer it as part of the broader session-log envelope work.                                          |
| P1       | Visible conversation-state compaction ownership is unresolved.                                       | Root spec includes visible Slack conversation-state compaction; tasks ask whether exact contract belongs here or `conversation-state`.                                     | Split high-level context bound here from detailed visible-thread persistence/routing rules in `conversation-state`, or keep the full contract here and cross-link. |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                                                | Evidence                                                                                                                                                                                                                                                                       | Follow-up                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Compaction does not have deterministic idempotency for a source log position.                      | `context-compaction.ts` calls `commitMessages(...)`; `session-log.ts` compares projection prefix and appends `projection_reset` when replacement differs, with no compaction-specific source event/idempotency key. A retry with a different summary can append another reset. | Add deterministic compaction reset identity after the session-log envelope is settled, or narrow the spec to current prefix-based reset behavior.               |
| P1       | Awaiting-resume safety is enforced by caller selection, not by the compactor contract.             | `reply-executor.ts` only compacts when `loadPiMessagesForTurn(...)` says `canCompact`; `createContextCompactor(...).maybeCompact(...)` accepts arbitrary `piMessages` and does not inspect lifecycle state.                                                                    | Document compactor as a pure projection service behind runtime eligibility, or pass lifecycle/source metadata so the service can reject awaiting-resume inputs. |
| P1       | Persistence-failure behavior conflicts with the spec’s “continue with prior reduced log” language. | `writeCompactedThreadContext(...)` awaits `commitMessages(...)`; failures propagate out of `maybeCompact(...)` and likely fail the turn rather than returning prior history.                                                                                                   | Catch projection persistence failure and return non-compacted prior history, or update the spec if persistence failure should be fatal.                         |
| P1       | Token-trigger source is estimate-only today.                                                       | Spec says server-reported input-token counts should be preferred when available; `estimateHistoryTokens(...)` uses local estimates from stripped Pi messages.                                                                                                                  | Either implement token-usage preference when stored usage is available, or mark this as target-state.                                                           |
| P2       | Tool-result exclusion is indirect.                                                                 | Retained messages only keep user-role text and summary rendering sanitizes text/base64, but explicit tool-result exclusion is not separately modeled/tested.                                                                                                                   | Keep if Pi tool results are never user-role semantic input; otherwise add explicit exclusion and coverage.                                                      |
| P2       | Secret-bearing text is only prompt-instructed/sanitized for known payload shapes.                  | Summary prompt says not to include secrets; sanitizer removes base64/image data but not generic API keys or credentials in tool output.                                                                                                                                        | Cross-link `security-policy`/`logging` and decide whether compaction must redact known secret patterns before summarization.                                    |

### Verification Gaps

| Severity | Gap                                                                           | Evidence                                                                                                                                                                                            | Follow-up                                                                                            |
| -------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| P1       | Retained newest oversized user message truncation lacks focused coverage.     | Verification map marks this `add`; current retained-message tests cover fitting messages and base64 exclusion.                                                                                      | Add unit test for newest eligible user message exceeding remaining budget.                           |
| P1       | Existing compaction summary exclusion lacks focused coverage.                 | `isCompactionSummary(...)` exists; no direct test was found.                                                                                                                                        | Add unit test that prior handoff summaries are not retained verbatim.                                |
| P1       | Summary failure continuation coverage is unclear.                             | Code returns `{ compacted: false, reason: "summary_failed" }`; verification map marks direct coverage as add.                                                                                       | Add unit test proving summarizer failure does not replace projection and returns prior-history path. |
| P1       | Projection persistence failure behavior is untested and likely mismatched.    | Verification map marks persistence failure as add; implementation currently propagates `commitMessages` failure.                                                                                    | Decide intended behavior, then add unit/integration coverage.                                        |
| P1       | Awaiting-resume skip has only service-level or caller-level partial coverage. | Verification map says unit covers service result for awaiting resume, but current compactor API has no lifecycle input; runtime integration for auth/timeout pause compaction skip is not explicit. | Add integration coverage at runtime eligibility boundary for awaiting timeout/auth resume.           |
| P2       | Automatic compaction “no Slack thread message” assertion is indirect.         | Integration test checks status sequencing and compacted `piMessages`, not absence of extra thread posts.                                                                                            | Add explicit no-message assertion if this has regressed before.                                      |
| P2       | Long-thread continuity eval is not mapped.                                    | Verification map marks no dedicated eval.                                                                                                                                                           | Add or map an eval only when model interpretation after summary matters.                             |

### Open Questions To Preserve

- Should deterministic compaction event ids wait for the broader session-log envelope?
- Is `commitMessages(...)` prefix/reset behavior an acceptable idempotency boundary for baseline, or only transitional?
- Should visible conversation-state compaction be specified here or under `conversation-state`?
- Should compaction perform generic secret redaction before sending summary input to the model provider?
- Should persistence failure be non-fatal for the user turn, as the root spec currently says?

### Suggested Follow-up Tasks

- **P1**: Decide deterministic projection reset identity and align with `agent-session-resumability`.
- **P1**: Decide whether compaction service or caller owns awaiting-resume eligibility, then update spec/code wording.
- **P1**: Resolve persistence-failure behavior and add coverage.
- **P1**: Add retained-message truncation, compaction-summary exclusion, and summary-failure tests.
- **P1**: Add runtime integration coverage for awaiting timeout/auth resume skip.
- **P2**: Decide secret-redaction scope before compaction model calls.
- **P2**: Map long-thread continuity eval ownership.

## `reply-planning`

Sources reviewed:

- `openspec/changes/backfill-reply-planning/**`
- `packages/junior/src/chat/services/reply-delivery-plan.ts`
- `packages/junior/src/chat/services/turn-result.ts`
- `packages/junior/src/chat/slack/reply.ts`
- `packages/junior/src/chat/slack/footer.ts`
- `packages/junior/tests/unit/delivery/plan.test.ts`
- `packages/junior/tests/unit/turn-result.test.ts`
- `packages/junior/tests/integration/slack/finalized-reply-behavior.test.ts`
- `packages/junior/tests/integration/slack/file-delivery-behavior.test.ts`
- OAuth resume file-delivery tests referenced by the verification map

### Summary

Terminal assistant output resolution, reaction-only suppression, canvas shortening, and footer helper behavior are mostly implemented and covered. The largest gaps are file-delivery planning semantics: the OpenSpec spec describes follow-up file stages and channel-only replies that still surface files, but the current delivery plan builder/resolver either drops files for `channel_only` or coerces every non-`none` file mode to `inline`.

### Canonicalization Gaps

| Severity | Gap                                                                           | Evidence                                                                                                             | Follow-up                                                                                                                 |
| -------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| P1       | Canonical-alignment tasks remain unchecked.                                   | `openspec/changes/backfill-reply-planning/tasks.md` leaves 3.1-3.4 and 4.1-4.3 open.                                 | Resolve file-follow-up ownership, provider-error partial text, canvas shortening, and footer canonicality before archive. |
| P1       | File-follow-up mode is specified but not implemented as a real planning mode. | OpenSpec has a follow-up file scenario; `resolveReplyDelivery(...)` maps any non-`none` attachment mode to `inline`. | Either implement follow-up planning or remove/narrow the requirement to outbound-specific resume behavior.                |
| P2       | Footer metadata may be product contract or diagnostic presentation.           | Tasks leave footer canonicality undecided; footer content is also covered by Slack delivery/outbound specs.          | Mark stable footer placement as contract; keep exact diagnostic fields flexible unless product wants them frozen.         |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                                 | Evidence                                                                                                                                                                                                                                | Follow-up                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Channel-only replies with files can drop visible files.                             | `buildReplyDeliveryPlan(...)` returns `attachFiles: "none"` whenever explicit channel-post intent and channel post succeeded, even if `hasFiles: true`; OpenSpec says channel-only replies with files still plan visible file delivery. | Change delivery-plan semantics to keep files visible for channel-only replies, or remove that OpenSpec scenario if channel posts are expected to carry all files themselves. |
| P1       | Follow-up file delivery cannot be realized through `planSlackReplyPosts(...)`.      | `ReplyFileDelivery` includes `"followup"`, but `resolveReplyDelivery(...)` returns `"inline"` for every non-`none` file plan, so the `attachFiles === "followup"` branch is unreachable for `AssistantReply.deliveryPlan`.              | Preserve `"followup"` through resolution and add direct post-plan coverage, or delete the dead mode.                                                                         |
| P1       | “Reply has no text and no files produces no stages” conflicts with current planner. | When `postThreadText` is true and `splitSlackReplyText(...)` returns no chunks, `planSlackReplyPosts(...)` still pushes a blank `thread_reply` stage. Delivery may skip visible work, but the planner does not produce no stages.       | Align code or spec; preferably make the planner return no stages for no visible content.                                                                                     |
| P2       | Provider-error partial text policy remains intentionally loose.                     | Spec says provider errors MAY include useful partial text; tasks ask whether it should be mandatory for every provider error.                                                                                                           | Keep `MAY` unless product requires stronger interrupted-output behavior.                                                                                                     |
| P2       | Canvas shortening ownership overlaps Slack/canvas tool behavior.                    | `buildTurnResult(...)` shortens verbose successful canvas replies; OpenSpec asks whether this belongs entirely here or in a canvas/tool capability.                                                                                     | Keep generic artifact reply shaping here; canvas-specific URL/content constraints can live with Slack/canvas tools.                                                          |

### Verification Gaps

| Severity | Gap                                                                                   | Evidence                                                                                                                                        | Follow-up                                                                                       |
| -------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| P1       | Follow-up file planning lacks direct unit coverage and currently appears unreachable. | Verification map marks follow-up planner coverage as add; existing integration file-delivery test only covers ignoring follow-up when no files. | Add direct `planSlackReplyPosts(...)` unit coverage after deciding/implementing follow-up mode. |
| P1       | Channel-only plus files needs direct coverage.                                        | `delivery/plan.test.ts` currently asserts channel-only with files returns `attachFiles: "none"`, which contradicts the OpenSpec scenario.       | Update test/spec according to policy decision.                                                  |
| P1       | Blank reply/no-files stage behavior lacks focused coverage.                           | Verification map marks add; current planner can return a blank stage.                                                                           | Add unit coverage for zero visible stages or update requirement.                                |
| P2       | Footer placement on multi-chunk replies lacks direct focused coverage.                | Verification map marks add; Slack delivery audit also found no final-chunk-only multi-chunk test.                                               | Add planner/API delivery test proving footer only on last text chunk.                           |
| P2       | Canvas success without URL lacks direct coverage.                                     | `turn-result.test.ts` covers verbose canvas reply with URL; no no-URL case was found.                                                           | Add unit test if no-URL canvas text remains normative.                                          |
| P2       | Attachment-claim mismatch scenario coverage is unclear.                               | `turn-result.ts` calls `enforceAttachmentClaimTruth(...)`; verification map marks explicit scenario naming as add.                              | Add or map a focused unit test for misleading attachment claims.                                |

### Open Questions To Preserve

- Should files produced during a channel-only side-effect turn still be uploaded to the original thread?
- Is `"followup"` a real reply-planning mode, or only a legacy/resume delivery concept?
- Should provider-error partial text be required whenever available, or remain best-effort?
- Which footer fields are stable product surface versus diagnostic detail?
- Does canvas reply shortening belong in generic reply planning or a Slack/canvas capability?

### Suggested Follow-up Tasks

- **P1**: Resolve channel-only-with-files semantics and update spec/code/tests together.
- **P1**: Either implement reachable follow-up file planning or remove the mode/scenario.
- **P1**: Align no-text/no-files planning behavior with the spec and add a unit test.
- **P2**: Add multi-chunk footer placement coverage.
- **P2**: Add canvas-without-URL and attachment-claim mismatch unit coverage if those scenarios stay normative.
- **P2**: Map broad finalized-reply integration tests to named reply-planning scenarios.

## `conversation-state`

Sources reviewed:

- `openspec/changes/backfill-conversation-state/**`
- `specs/chat-architecture.md`
- `specs/agent-turn-handling.md`
- `specs/agent-session-resumability.md`
- `specs/context-compaction.md`
- `specs/agent-prompt.md`
- `specs/slack-agent-delivery.md`
- `packages/junior/src/chat/state/conversation.ts`
- `packages/junior/src/chat/services/conversation-memory.ts`
- `packages/junior/src/chat/runtime/turn-preparation.ts`
- `packages/junior/src/chat/runtime/delivered-turn-state.ts`
- Conversation-state, conversation-memory, compaction, Slack/OAuth/image integration tests referenced by the verification map

### Summary

The backfill correctly separates visible Slack conversation state from durable Pi/session history. The main gap is that the draft mixes target architecture with transitional code: root resumability specs say Pi history comes from the session log and visible thread state must not carry fresh-turn “last session” model history pointers, but current code and tests still preserve/use `conversation.piMessages`. The draft also names a `lastSessionId` pointer that does not match current implementation and conflicts with the desired conversation-log model.

### Canonicalization Gaps

| Severity | Gap                                                                                 | Evidence                                                                                                                                                                                                                                                                                                    | Follow-up                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| P1       | `conversation.piMessages` needs explicit migration framing before canonicalization. | OpenSpec draft says reusable Pi history loads from agent session projection; implementation still stores `piMessages` on `ThreadConversationState`, resume paths pass it into reply context, and tests assert it as durable state. Root resumability says follow-up turns should not depend on this mirror. | Label `piMessages` as legacy/transitional fallback, or update root specs if it remains supported.                           |
| P1       | Draft `lastSessionId` pointer does not match code or root architecture.             | Spec names `lastSessionId`; code uses `activeTurnId`, `lastCompletedAtMs`, and `pendingAuth`, and root specs reject fresh-turn “last session” pointers for model history.                                                                                                                                   | Remove `lastSessionId`; include `lastCompletedAtMs` only if it is normative.                                                |
| P1       | Visible compaction ownership remains unresolved with `context-compaction`.          | Both changes leave visible conversation-state compaction ownership open.                                                                                                                                                                                                                                    | Decide whether this spec owns concrete visible-state reducer behavior while `context-compaction` owns cross-surface bounds. |
| P2       | Retention/TTL policy is intentionally open but under-owned.                         | Draft leaves retention/TTL ambiguous.                                                                                                                                                                                                                                                                       | Mark out of scope or point to a storage/state spec before archive.                                                          |
| P2       | “Skipped/replied markers” wording is stronger than implementation.                  | Implementation renders skipped/no-reply markers, not positive replied markers.                                                                                                                                                                                                                              | Tighten wording to skipped/no-reply/failure markers unless positive replied markers are intended.                           |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                            | Evidence                                                                                                                                                                                            | Follow-up                                                                                                   |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P1       | Non-text/image-only current messages lose important attachment metadata.       | Placeholder handling drops attachment count, image count, hydration state, Slack timestamp, and bot flag metadata, conflicting with new-message metadata and Slack attachment context requirements. | Persist attachment/image metadata even when current message has no text.                                    |
| P1       | Queued non-text messages can be skipped before attachment metadata extraction. | `createConversationMessageFromSdkMessage(...)` returns `null` before extracting attachment metadata; queued persistence only upserts returned messages.                                             | Build visible-state entries for image/file-only queued messages or explicitly define them as non-persisted. |
| P1       | Fresh follow-up Pi history target is not fully code-aligned.                   | Root target says session-log projection should provide Pi history; code/tests still rely on `conversation.piMessages` as fallback.                                                                  | Add session-log-only recovery coverage and plan `conversation.piMessages` migration.                        |
| P2       | Thread-history seeding may be weaker than the requirement.                     | Code caps raw newest-first iteration before filtering newer-than-current messages, so newer messages can exhaust the limit before older usable history is seeded.                                   | Decide if this is acceptable bound behavior or adjust seeding to filter before limiting.                    |

### Verification Gaps

| Severity | Gap                                                                         | Evidence                                                                                                                                                                                                                           | Follow-up                                                                                           |
| -------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| P1       | Non-text/image-only queued/skipped path lacks focused integration coverage. | Existing coverage does not prove persisted visible state retains attachment/image metadata for later turns.                                                                                                                        | Add Slack integration coverage for image-only or file-only queued/skipped messages.                 |
| P1       | Session-log-only Pi history recovery lacks explicit coverage.               | Verification map should distinguish legacy `conversation.piMessages` compatibility from target canonical behavior.                                                                                                                 | Add test where fresh follow-up Pi history comes from session log without `conversation.piMessages`. |
| P2       | Coercion and reducer edge cases need unit coverage.                         | Thin coverage for malformed conversation coercion, malformed pending auth omission, duplicate upsert metadata merging, stats refresh, context rendering metadata, missing image-summary omission, and visible compaction fallback. | Convert these into targeted unit follow-ups.                                                        |
| P2       | Visible compaction reducer/fallback behavior is unmapped.                   | Ownership remains split with `context-compaction`.                                                                                                                                                                                 | Add or move tests after ownership decision.                                                         |

### Open Questions To Preserve

- Is `conversation.piMessages` a legacy compatibility field scheduled for removal, or a supported fallback?
- Should `pendingAuth` remain in visible conversation state or move to a dedicated auth-routing store?
- Which spec owns visible conversation compaction details?
- What explicit TTL/retention policy applies to visible conversation memory?

### Suggested Follow-up Tasks

- **P1**: Revise OpenSpec to remove `lastSessionId`, include `lastCompletedAtMs` only if normative, and label `piMessages` as transitional or supported.
- **P1**: Decide visible compaction ownership with `context-compaction`.
- **P1**: Add non-text/image-only persistence coverage.
- **P1**: Add session-log-only Pi history recovery coverage.
- **P2**: Add coercion/upsert/stats/context-rendering edge-case unit tests.

## `slack-ingress-routing`

Sources reviewed:

- `openspec/changes/backfill-slack-ingress-routing/**`
- `specs/chat-architecture.md`
- `specs/agent-turn-handling.md`
- `specs/slack-agent-delivery.md`
- `specs/slack-outbound-contract.md`
- `specs/testing.md`
- `specs/integration-testing.md`
- `specs/index.md`
- `packages/junior/src/chat/ingress/*`
- `packages/junior/src/chat/queue/thread-message-dispatcher.ts`
- `packages/junior/src/chat/app/production.ts`
- `packages/junior/src/chat/runtime/slack-runtime.ts`
- `packages/junior/src/handlers/webhooks.ts`
- Relevant Slack ingress unit/integration tests referenced by the verification map

### Summary

The capability boundary is mostly right: ingress should normalize/classify/handoff, runtime should decide turn behavior, and Slack delivery/outbound should own writes. The gaps are mostly canonical precision and overstated verification. Two important requirements need tightening: subscribed-thread explicit mentions are ambiguous across specs, and the `waitUntil` invariant does not cleanly match all current code paths.

### Canonicalization Gaps

| Severity | Gap                                                            | Evidence                                                                                                                                                                                                                                                                                             | Follow-up                                                                                                                                     |
| -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Change is not yet canonical/indexed.                           | No canonical `openspec/specs/slack-ingress-routing` exists; `specs/index.md` does not list it; canonical alignment tasks remain open.                                                                                                                                                                | Finish alignment, then add index/pointers after acceptance.                                                                                   |
| P1       | Explicit mentions in already-subscribed threads are ambiguous. | Adjacent specs say explicit mentions bypass passive routing; ingress backfill only says explicit mention in unsubscribed thread routes active, while subscribed non-DM routes subscribed. Code sends subscribed explicit mentions through `handleSubscribedMessage` with explicit-mention preflight. | Decide whether subscribed explicit mentions should normalize to `new_mention` or remain `subscribed_message` with explicit-mention preflight. |
| P1       | Thread `ts` fallback needs narrower wording.                   | Queue/conversation identity can fall back to message `ts`, but Slack delivery forbids substituting DM `ts` for assistant status/title when Slack omits `thread_ts`.                                                                                                                                  | Separate durable queue/thread identity from live assistant-thread Slack IDs.                                                                  |
| P1       | Stale testing spec reference remains.                          | `integration-testing.md` references `routeIncomingMessageToWorkflow(...)`, which does not match current dispatcher/routing code.                                                                                                                                                                     | Reconcile with `createThreadMessageDispatcher(...)` or current Chat SDK routing language.                                                     |
| P2       | Background webhook surface is underspecified.                  | Spec names message/reaction/action/slash/lifecycle/app-home; implementation also handles modal close.                                                                                                                                                                                                | Include modal close or explicitly scope it elsewhere.                                                                                         |
| P2       | Slack subtype scope could imply too much.                      | Backfill should say only consumed subtypes are specified.                                                                                                                                                                                                                                            | Add narrow subtype-scope wording.                                                                                                             |

### Requirement vs Implementation Gaps

| Severity | Gap                                                            | Evidence                                                                                                                                                                                                           | Follow-up                                                                                                                |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| P1       | `waitUntil` requirement is stronger than code.                 | `JuniorChat.processMessage` forces `waitUntil` for message factories, but object/synthetic messages can call `super.processMessage(...)` directly; some async tasks are created before missing-`waitUntil` checks. | Narrow requirement to paths that can safely enforce it, or refactor so every long-running path fails before work starts. |
| P1       | Bot-authored filtering is not clearly Junior-owned at ingress. | Self-message guard exists later in reply/runtime paths; external Slack Connect filtering exists; unsupported non-Junior bot messages may be adapter-owned.                                                         | Specify adapter-owned vs Junior-owned bot filtering, and add ingress coverage for the Junior-owned cases.                |
| P2       | Modal close is implemented but absent from requirements.       | `JuniorChat.processModalClose` exists.                                                                                                                                                                             | Add scenario or state it belongs to interaction ingress only.                                                            |
| P2       | Edited-message raw identity preservation wording is too broad. | Implementation preserves required channel/ts/thread/user/team/source fields, not all raw Slack fields.                                                                                                             | Wording should say required raw identity fields, not wholesale raw preservation.                                         |

### Verification Gaps

| Severity | Gap                                                    | Evidence                                                                                                                                               | Follow-up                                                                      |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| P1       | Verification map overstates queue dispatcher coverage. | Current dispatcher test covers subscribed dispatch only, not mention dispatch or attachment rehydration.                                               | Mark those rows `add` or add tests.                                            |
| P1       | `waitUntil` coverage is partial.                       | Tests cover action/slash `waitUntil`, not missing `waitUntil`, reaction, modal close, assistant lifecycle, app-home, or message-factory normalization. | Add path-specific coverage after requirement is narrowed.                      |
| P1       | Edited-message mention-loss scenario is not covered.   | Map marks it covered, but no scenario for edited text no longer mentioning Junior was found.                                                           | Add unit/integration coverage or correct the map.                              |
| P1       | External-user drop is not covered through ingress.     | Existing coverage tests `isExternalSlackUser(...)` directly, not process-message drop before queue/runtime dispatch.                                   | Add ingress-path coverage.                                                     |
| P2       | DM production registration is indirect.                | Comments and behavior tests imply it, but no explicit production registration test proves DMs bypass passive subscribed routing.                       | Add a narrow registration/wiring test only if production wiring has regressed. |

### Open Questions To Preserve

- Should subscribed-thread explicit mentions normalize to `new_mention`, or remain `subscribed_message` plus explicit-mention preflight?
- Is `waitUntil` a hard invariant for every Slack message path, including synthetic edited mentions?
- Does Junior own all bot-authored filtering, or only self-authored messages while the Slack adapter owns other bot subtypes?
- Should modal-close webhooks be included in this capability or scoped elsewhere?

### Suggested Follow-up Tasks

- **P1**: Resolve OpenSpec tasks 3.1-3.4 before canonicalization.
- **P1**: Tighten spec wording for queue thread identity versus assistant-thread live IDs.
- **P1**: Update verification map rows from `keep` to `add` where coverage is partial.
- **P1**: Reconcile stale `integration-testing.md` workflow-router reference with current dispatcher/routing code.
- **P2**: Add canonical spec/index/pointer updates only after acceptance.

## `queue-and-locking`

Sources reviewed:

- `openspec/changes/backfill-queue-and-locking/**`
- `specs/index.md`
- `specs/chat-architecture.md`
- `specs/agent-session-resumability.md`
- `specs/agent-turn-handling.md`
- `specs/slack-agent-delivery.md`
- `specs/testing.md`
- Related OpenSpec drafts for `slack-ingress-routing` and `agent-session-resumability`
- `packages/junior/src/chat/app/production.ts`
- `packages/junior/src/chat/state/adapter.ts`
- `packages/junior/src/chat/ingress/*`
- `packages/junior/src/chat/queue/thread-message-dispatcher.ts`
- `packages/junior/src/chat/runtime/slack-runtime.ts`
- `packages/junior/src/chat/runtime/turn-preparation.ts`
- `packages/junior/src/chat/runtime/reply-executor.ts`
- `packages/junior/src/chat/runtime/slack-resume.ts`
- `packages/junior/src/handlers/turn-resume.ts`
- Targeted queue, lock, ingress, and resume tests referenced by the verification map

### Summary

The backfill matches the broad intent: Chat SDK queueing coordinates Slack transport work, skipped messages are preserved into turn preparation/state when the SDK supplies them, state-adapter locks are heartbeated for long live turns, and timeout resume uses the same logical Slack thread lock. The main gaps are ownership and policy: the spec overlaps with ingress routing and session resumability, references a non-existent root ingress spec, and does not decide queue overflow/TTL semantics.

### Canonicalization Gaps

| Severity | Gap                                                                                         | Evidence                                                                                                                                                                                       | Follow-up                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| P1       | Backfill references a root `specs/slack-ingress-routing.md` that does not exist.            | Only `openspec/changes/backfill-slack-ingress-routing/**` exists; queue spec depends on `slack-ingress-routing`.                                                                               | Resolve archive order/cross-links or create canonical ingress spec before treating this as canonical.                |
| P1       | Active continuation follow-up behavior is specified here but owned by session resumability. | Queue spec includes active continuation follow-up behavior; canonical `agent-session-resumability` already owns retry/reschedule/continuation behavior.                                        | Narrow this spec to queue/lock coordination and cross-link resumability for follow-up turn recovery.                 |
| P1       | Dispatcher kind routing overlaps ingress routing.                                           | Queue spec discusses `new_mention`/`subscribed_message` routing; production handlers route through Chat SDK registration, and `createThreadMessageDispatcher(...)` is not the production path. | Move routing-kind ownership to `slack-ingress-routing`; keep only queue payload preservation/lock coordination here. |
| P2       | Queue TTL is qualitative while code has formulas.                                           | Production queue TTL is `turnTimeoutMs + 60_000`; lock max age is `turnTimeoutMs + ACTIVE_LOCK_TTL_MS`.                                                                                        | Decide whether formulas are normative or implementation detail.                                                      |
| P2       | Queue max-size/drop policy is not canonicalized.                                            | Chat SDK defaults are bounded queue and drop-oldest.                                                                                                                                           | State preservation as “messages the SDK still provides” or configure/document a product-specific policy.             |
| P2       | Direct-message queue/skipped handling is undernamed.                                        | Production config registers DMs too; spec names `new_mention` and `subscribed_message`.                                                                                                        | Add DM to queue/skipped message scope.                                                                               |

### Requirement vs Implementation Gaps

| Severity | Gap                                                     | Evidence                                                                                                                                                                                            | Follow-up                                                                                                        |
| -------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| P1       | Resume lock release contract is muddy.                  | Spec says release before deferred side effects that do not require exclusive state mutation; implementation releases before all deferred handlers, including callbacks that mutate persisted state. | Decide whether post-lock terminalization/pause writes are allowed by design, then update spec or implementation. |
| P1       | Queue preservation language can overstate losslessness. | SDK queue may drop/expire messages; current code preserves skipped/queued messages only when supplied to runtime.                                                                                   | Clarify queue loss policy and preservation limits.                                                               |
| P2       | Resume lock acquisition appears aligned.                | `resumeSlackTurn` acquires lock before `beforeStart` reads state.                                                                                                                                   | Keep; add direct contract test if considered high-risk.                                                          |
| P2       | Skipped message preservation appears aligned.           | Runtime passes queued messages and turn preparation upserts them into conversation state.                                                                                                           | Keep; cross-link attachment fetcher rehydration with attachment spec.                                            |

### Verification Gaps

| Severity | Gap                                                            | Evidence                                                                                                      | Follow-up                                                                   |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| P1       | No focused production queue config test.                       | No direct assertion for production `concurrency.strategy = "queue"` or TTL math.                              | Add small composition test if production queue config is normative.         |
| P1       | Dispatcher coverage is partial.                                | Dispatcher unit coverage covers subscribed routing only; mention routing and fetcher rehydration remain gaps. | Add tests only if dispatcher remains normative.                             |
| P1       | Queue overflow/drop/expiry behavior unverified.                | Policy undecided and no tests found.                                                                          | Decide policy first, then test configured behavior or document SDK default. |
| P1       | Resume deferred side-effect lock ordering is unverified.       | No isolated test proves chosen ordering around deferred pause/failure side effects.                           | Add test after semantics are clarified.                                     |
| P2       | Resume lock key equivalence is implied, not directly asserted. | Tests imply `slack:<channel>:<thread_ts>` usage.                                                              | Add direct contract test if lock-key drift risk is high.                    |

### Open Questions To Preserve

- Is SDK default `maxQueueSize=10`/drop-oldest acceptable, or should Junior configure its own queue policy?
- Should queue TTL be exact (`turnTimeoutMs + 60s`) or just longer than live turn timeout?
- Should deferred resume pause/failure state writes happen outside the lock by design?
- Should `queue-and-locking` own dispatcher kind routing, or should that remain solely in `slack-ingress-routing`?

### Suggested Follow-up Tasks

- **P1**: Resolve queue OpenSpec tasks 3.1-3.4 before archive.
- **P1**: Narrow spec to queue/lock contracts and replace duplicated session/ingress scenarios with cross-links.
- **P1**: Decide bounded queue max size/drop/expiry policy.
- **P1**: Clarify resume deferred side-effect lock semantics and add one targeted test.
- **P2**: Add production queue config, dispatcher mention routing, and attachment fetcher rehydration tests only if those remain normative in this spec.

## `attachment-and-vision-context`

Sources reviewed:

- `openspec/changes/backfill-attachment-and-vision-context/**`
- `specs/slack-agent-delivery.md`
- `specs/slack-outbound-contract.md`
- Adjacent backfills for `conversation-state`, `queue-and-locking`, `slack-ingress-routing`, `agent-turn-handling`, and `reply-planning`
- `packages/junior/src/chat/services/vision-context.ts`
- `packages/junior/src/chat/runtime/turn-preparation.ts`
- `packages/junior/src/chat/runtime/turn-user-message.ts`
- `packages/junior/src/chat/queue/thread-message-dispatcher.ts`
- `packages/junior/src/chat/ingress/message-changed.ts`
- `packages/junior/src/chat/slack/legacy-attachments.ts`
- Attachment, media, image-hydration, message-changed, DM file-share, resume, and legacy-attachment tests referenced by the verification map

### Summary

The current implementation has good coverage for the main live-turn attachment paths: direct attachment fetcher rehydration, DM `file_share` image ingress, edited-message image attachments, mixed media, vision-disabled image omission, cached/current image summaries, and passive screenshot hydration. The main gaps are around policy and edge cases: Slack Connect incomplete file metadata, exact limits versus tunables, current-image failure strictness, non-text message persistence, and text-preview/binary prompt projection.

### Canonicalization Gaps

| Severity | Gap                                                               | Evidence                                                                                                                                                                                               | Follow-up                                                                                     |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| P1       | Slack Connect `check_file_info` posture is undecided.             | Tasks leave whether `check_file_info` is current behavior or explicit future gap open; current vision hydration uses thread replies and private URLs, not a general incomplete-metadata recovery path. | Mark metadata lookup as future gap or implement/specify the current supported lookup surface. |
| P1       | Current-image vision failure policy is strict but still open.     | Implementation throws for image attachment analysis failure before main agent; tasks ask whether failure should depend on user intent.                                                                 | Decide strict fail-before-agent versus intent-sensitive omitted-image behavior.               |
| P1       | Non-text/image-only persistence overlaps `conversation-state`.    | Attachment spec requires attachment metadata persisted to conversation state; current `turn-preparation` fallback for `[non-text message]` drops attachment/image counts and Slack timestamp.          | Coordinate with `conversation-state` and make this metadata persistence explicit.             |
| P2       | Exact image/file count and byte limits are not clearly normative. | Tasks ask whether limits are exact values or tunable bounds; code uses configured constants.                                                                                                           | Specify limits as tunable implementation bounds unless product requires stable values.        |
| P2       | Legacy attachment text rendering ownership overlaps ingress.      | Tasks ask whether legacy Slack attachment rendering belongs here or `slack-ingress-routing`.                                                                                                           | Keep pure legacy attachment text transform here; ingress owns event eligibility/routing.      |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                    | Evidence                                                                                                                                                                                                                                                               | Follow-up                                                                                                    |
| -------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| P1       | Incomplete Slack file metadata recovery is not fully implemented.      | Spec says preserve file identity for later recovery when private URL/MIME type is unavailable; current hydration needs thread reply file metadata with `mimetype` and private URL, and no broad `files.info`/`check_file_info` path was found for inbound attachments. | Narrow requirement to current recoverable metadata or add Slack file-info recovery.                          |
| P1       | Non-text current message placeholder drops required metadata.          | `prepareTurnState(...)` upserts `[non-text message]` with only `explicitMention` metadata when normalization returns null.                                                                                                                                             | Include attachment count, image count, hydration status, Slack timestamp, and bot flag on fallback messages. |
| P1       | Queued non-text attachment messages may be skipped before persistence. | `createConversationMessageFromSdkMessage(...)` returns `null` when normalized text is empty, so queued image/file-only messages are not upserted.                                                                                                                      | Persist metadata-bearing entries for image/file-only queued messages or declare them unsupported.            |
| P2       | Attachment text-preview projection appears target-state.               | Spec says supported text preview enters routing context; implementation passes non-image bytes to agent context, but no dedicated bounded text-preview projection was found in routing context.                                                                        | Either implement text preview projection or narrow requirement to agent attachment data only.                |
| P2       | Binary-byte projection wording needs precision.                        | Current code preserves file data in `userAttachments`; routing context avoids raw binary by default.                                                                                                                                                                   | Make clear binary bytes are agent attachment context, not visible transcript/routing text.                   |

### Verification Gaps

| Severity | Gap                                                                                            | Evidence                                                                                                                                      | Follow-up                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| P1       | Edited-message attachment preservation coverage exists for image context but should be mapped. | `message-changed-behavior.test.ts` covers edited image attachments; verification map still marks edited attachments unclear/add.              | Update map from `add` to `keep` for image attachment case; add non-image edit only if required. |
| P1       | Incomplete Slack file metadata behavior is unverified.                                         | Verification map marks Slack Connect file identifier and metadata-unavailable paths as add.                                                   | Add tests after deciding current/future behavior.                                               |
| P1       | Non-text/image-only queued or skipped persistence lacks focused coverage.                      | Conversation-state audit also found this gap.                                                                                                 | Add integration coverage for queued/skipped image-only or file-only state persistence.          |
| P2       | Resumed unhydrated image metadata coverage is partial.                                         | `respond-timeout-resume.test.ts` asserts omitted image attachments in prompt; verification map asks for focused `turn-user-message` coverage. | Add a small unit test around `getTurnUserReplyAttachmentContext(...)`.                          |
| P2       | Missing URL and hydration oversize paths need explicit mapping.                                | Image hydration tests cover some missing/cached/download cases, but verification map says missing URL/oversize are mixed/unclear.             | Map existing cases precisely or add focused unit/integration coverage.                          |
| P2       | Text-preview/binary projection lacks direct coverage.                                          | Verification map marks supported preview and binary-byte scenarios add.                                                                       | Add tests only after narrowing/implementing the projection contract.                            |

### Open Questions To Preserve

- Is Slack Connect incomplete metadata recovery a baseline requirement or a future capability?
- Are image/file count and byte limits exact contract values or tunable operational limits?
- Should current-image analysis failure always abort before the main agent, or only when the user’s request depends on the image?
- Does legacy Slack attachment text rendering belong here or in ingress routing?
- Should non-image text preview be projected into routing context, agent attachments only, or both?

### Suggested Follow-up Tasks

- **P1**: Decide Slack Connect/incomplete file metadata posture and align spec/code/tests.
- **P1**: Decide strict current-image failure policy.
- **P1**: Fix or explicitly document non-text/image-only metadata persistence for current and queued messages.
- **P1**: Update verification map for existing edited-image coverage and add missing incomplete-metadata tests after policy decision.
- **P2**: Add resumed omitted-image unit coverage.
- **P2**: Narrow or implement text-preview/binary prompt projection requirements.

## `web-tools`

Sources reviewed:

- `openspec/changes/backfill-web-tools/**`
- Adjacent specs/backfills for `tool-execution`, `security-policy`, `reply-planning`, `attachment-and-vision-context`, `agent-prompt`, `eval-testing`, and `testing`
- `packages/junior/src/chat/tools/web/search.ts`
- `packages/junior/src/chat/tools/web/fetch-tool.ts`
- `packages/junior/src/chat/tools/web/fetch-content.ts`
- `packages/junior/src/chat/tools/web/network.ts`
- `packages/junior/src/chat/tools/web/image-generate.ts`
- `packages/junior/tests/unit/web-search.test.ts`
- `packages/junior/tests/unit/web-fetch-tool.test.ts`
- `packages/junior/tests/unit/web/web-fetch-convert.test.ts`
- `packages/junior/tests/unit/network-url-guards.test.ts`
- `packages/junior/tests/unit/web/image-generate.test.ts`
- Referenced research/source evals

### Summary

Web search, direct fetch, and image generation are separated well. The implementation has meaningful SSRF defenses, pinned DNS lookup for hostnames, redirect revalidation, bounded extraction, Gateway-backed search, image fetch attachment, and Gateway image generation. The main gaps are policy and coverage: several URL-safety cases are implemented but only partially tested, source/citation quality belongs outside deterministic tool specs, and zero-image image generation currently returns success even though the expected product behavior is undecided.

### Canonicalization Gaps

| Severity | Gap                                                                 | Evidence                                                                                                                                                                                 | Follow-up                                                                                                                   |
| -------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| P1       | Failure result/error shape is undecided for `webSearch`/`webFetch`. | Tasks leave whether failures should be expected tool errors open; current `webFetch` returns `{ ok: false, retryable }`, while `imageGenerate` throws for credential/model/API failures. | Decide expected tool-error shape per tool and align with `tool-execution`.                                                  |
| P1       | Source/citation requirements are cross-owned.                       | Web-tools spec includes source-backed answer quality taxonomy, but citation behavior depends on prompt/evals/model interpretation.                                                       | Keep deterministic URL/search result fields here; move citation/source answer quality to `agent-prompt` and `eval-testing`. |
| P1       | Zero-image image generation policy is undecided.                    | `imageGenerate` returns `{ ok: true, image_count: 0 }` if API returns no usable images; tasks ask whether this should be success or failure.                                             | Decide and update spec/tests.                                                                                               |
| P2       | PDF/document extraction support remains open.                       | Spec says fetch extracts supported public URL responses; tasks ask whether PDF/document extraction should be supported.                                                                  | Mark PDF/document extraction as non-goal unless implementation is added.                                                    |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                                 | Evidence                                                                                                                                                                                    | Follow-up                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Image-generation remote URL fetch is not SSRF guarded.                              | `imageGenerate` fetches remote image URLs returned by Gateway directly with `fetchImpl(url)`; spec says fetchable remote URLs are decoded/fetched but does not state public-URL validation. | Decide whether Gateway-returned URLs are trusted. If not, reuse public URL safety checks for remote image fetches.                |
| P1       | Image-fetch attachment body reads are not streaming-bounded before `arrayBuffer()`. | `webFetch` image path reads `response.arrayBuffer()` then checks `MAX_FETCH_BYTES`; large image bodies can be loaded before failure.                                                        | Use bounded body reader for image responses or document this as acceptable because fetch timeout/transport limits are sufficient. |
| P2       | Text/XML extraction is implemented but not specifically tested.                     | `extractWebFetchResponse(...)` allows `text/`, JSON, and XML, but current visible tests focus HTML/JSON.                                                                                    | Add focused Text/XML tests if the scenario remains normative.                                                                     |
| P2       | Unsupported content type behavior is implemented.                                   | `extractWebFetchResponse(...)` throws `unsupported content type`; test coverage appears unclear.                                                                                            | Add or map unit coverage.                                                                                                         |
| P2       | Image generation has no max byte/SSRF/budget handling for remote image URLs.        | Remote image URL responses are fetched and attached without size check or public URL validation.                                                                                            | Add constraints if remote URLs remain supported.                                                                                  |

### Verification Gaps

| Severity | Gap                                                                                    | Evidence                                                                                                                                                                                                                          | Follow-up                                                                          |
| -------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P1       | URL guard coverage is partial.                                                         | `network-url-guards.test.ts` covers IPv4-mapped loopback, IPv6 link-local, and DNS mapped private IPv6; verification map asks for non-http, private IPv4/IPv6/local names, DNS private IPv4, unsafe redirect, and redirect limit. | Add focused network unit tests for the missing cases.                              |
| P1       | `webFetch` image attachment path lacks direct hook coverage.                           | `fetch-tool.ts` emits `onGeneratedFiles`; verification map marks image response/oversize image add.                                                                                                                               | Add unit tests for image file hook and oversize behavior.                          |
| P1       | Image generation missing-credentials and zero-image policy coverage need confirmation. | Existing image-generation tests cover default model, enrichment, bad model, data URL; zero-image behavior is policy gap.                                                                                                          | Add missing-credential and zero-image tests once policy is chosen.                 |
| P2       | Provider integration/live Gateway checks are absent or optional.                       | Verification map marks provider integration optional/credentialed.                                                                                                                                                                | Keep optional; do not block baseline unless product wants live checks.             |
| P2       | Research/source eval mapping is incomplete.                                            | `research-reply-shape.eval.ts` and related evals need ownership mapping.                                                                                                                                                          | Map to `agent-prompt`/`eval-testing` with web-tools as deterministic tool support. |

### Open Questions To Preserve

- Should `webSearch`/`webFetch` failures be structured successful tool results, expected tool errors, or thrown runtime errors?
- Should image generation returning zero usable images be success with `image_count: 0` or a failure?
- Should `webFetch` support PDF/document extraction?
- Are Gateway-returned remote image URLs trusted enough to bypass SSRF checks and byte-budget streaming?
- Which source/citation requirements belong to web-tools versus prompt/evals?

### Suggested Follow-up Tasks

- **P1**: Decide tool failure-result shape with `tool-execution`.
- **P1**: Decide zero-image generation policy and add tests.
- **P1**: Add missing URL guard tests, including redirect revalidation and redirect limit.
- **P1**: Add webFetch image hook and oversize tests; consider bounded image body reads.
- **P1**: Decide and document remote image URL trust/SSRF handling for `imageGenerate`.
- **P2**: Mark PDF/document extraction as non-goal or add implementation/tests.
- **P2**: Move citation/source answer-quality requirements into prompt/eval taxonomy.

## `skill-runtime`

Sources reviewed:

- `openspec/changes/backfill-skill-runtime/**`
- Adjacent specs/backfills for `agent-prompt`, `tool-execution`, `sandbox-tools`, `plugin-runtime`, `mcp-tool-runtime`, `testing`, and `eval-testing`
- `packages/junior/src/chat/skills.ts`
- `packages/junior/src/chat/tools/skill/load-skill.ts`
- `packages/junior/src/chat/sandbox/skill-sandbox.ts`
- `packages/junior/src/chat/pi/derived-state.ts`
- `packages/junior/tests/unit/skills/*`
- `packages/junior/tests/unit/skills-plugin-provider.test.ts`
- `packages/junior/tests/unit/mcp/tool-manager.test.ts`
- Skill-related integration tests and evals referenced by the verification map

### Summary

The deterministic mechanics are mostly implemented: frontmatter parsing rejects unsupported metadata, discovery scans configured roots with cache and first-name-wins behavior, explicit invocation parsing works for slash commands and user-callable skills, `loadSkill` returns host-loaded instructions with sandbox path guidance, plugin-owned skills get a runtime-boundary notice, file access is scoped to the skill root, and allowed-tools filtering uses exact runtime names.

The main gaps are semantic and verification-related. `disable-model-invocation` is a confusing field name for the current behavior: it suppresses model auto-selection but still allows explicit user invocation. Plugin metadata mismatch protection exists at load time, but targeted coverage appears thin. Cache TTL and unknown-skill error shape should be decided before canonicalization.

### Canonicalization Gaps

| Severity | Gap                                                                | Evidence                                                                                                                                                                            | Follow-up                                                                                                              |
| -------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| P1       | `disable-model-invocation` semantics need exact canonical wording. | Tasks leave this open; implementation parses explicit user invocation only for skills with `disableModelInvocation === true`, while prompt auto-selection semantics live elsewhere. | Rename concept in prose to “user-callable / model auto-invocation disabled” and define prompt/parser behavior clearly. |
| P1       | Unknown-skill result shape is unresolved.                          | `loadSkill` returns `{ ok: false, error, available_skills }`; tasks ask whether unknown skill results should be expected tool errors.                                               | Align with `tool-execution` error taxonomy.                                                                            |
| P2       | `allowed-tools` portability is intentionally exact today.          | Implementation ignores unsupported patterns and only keeps exact runtime names; tasks ask whether portable patterns should be supported.                                            | Keep exact-name contract for baseline; mark portable patterns future.                                                  |
| P2       | Discovery cache TTL may be implementation detail.                  | Spec says MAY return cached metadata; code has `SKILL_CACHE_TTL_MS`.                                                                                                                | Avoid freezing TTL unless operationally needed.                                                                        |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                                       | Evidence                                                                                                                          | Follow-up                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| P1       | Plugin metadata mismatch protection is load-time only.                                    | `resolveSkillPlugin(...)` throws when metadata names the wrong plugin; discovery attaches provider based on path.                 | Ensure canonical text says false ownership is rejected when loading/activating, not necessarily during metadata discovery. |
| P1       | Skill auto-selection versus explicit invocation is split across prompt/eval and parser.   | Parser only detects slash and explicit user-callable forms; general “load most specific matching skill” is prompt/model behavior. | Keep deterministic parser requirements here and move model skill-selection quality to `agent-prompt`/evals.                |
| P2       | Discovery output is sorted after first-wins selection.                                    | Root/entry scan order determines duplicate winner, then output is sorted by skill name.                                           | Document first-wins precedence independent of returned sort order if this matters.                                         |
| P2       | No-active-skill file access throws exceptions, not structured tool results at this layer. | `SkillSandbox.requireSkill(...)` throws; wrapping tools may convert to model-visible errors.                                      | Align wording with owning tool surface if structured result is required.                                                   |

### Verification Gaps

| Severity | Gap                                                              | Evidence                                                                                 | Follow-up                                                                                                                           |
| -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Duplicate skill precedence coverage is unclear.                  | Verification map marks duplicate skill name as add.                                      | Add unit test proving earlier root wins and output sort does not change winner.                                                     |
| P1       | Read failure/cache freshness coverage is unclear.                | Verification map marks root/file read failure and cache fresh as add.                    | Add focused unit tests or mark cache as implementation detail.                                                                      |
| P1       | Plugin metadata mismatch needs explicit safety coverage.         | Verification map marks metadata claims wrong plugin as add; code has protection.         | Add unit test for load-time mismatch failure.                                                                                       |
| P1       | No-active-skill sandbox access coverage is unclear.              | Verification map marks add; `SkillSandbox` throws a useful error.                        | Add unit test for `listFiles`/`readFile` without active or explicit skill.                                                          |
| P2       | Skill eval taxonomy is unmapped.                                 | Verification map says skill evals and plugin/MCP skill workflows need mapping/splitting. | Assign natural-language skill selection/application evals to skill-runtime plus prompt, and provider workflows to plugin/MCP specs. |
| P2       | Exact `allowed-tools` unrestricted behavior coverage is partial. | Tests cover exact filtering; map asks for no-allowed-tools behavior.                     | Add unit test that no active/no allowed-tools returns unrestricted/null as intended.                                                |

### Open Questions To Preserve

- Should `disable-model-invocation` be renamed in docs/specs, or kept as manifest/frontmatter compatibility with clearer prose?
- Should unknown skill be an expected tool error or an `ok: false` model-visible result?
- Will `allowed-tools` ever support portable patterns, or should exact runtime names remain the permanent contract?
- Is skill discovery cache TTL normative?

### Suggested Follow-up Tasks

- **P1**: Define `disable-model-invocation` semantics in canonical prose and eval taxonomy.
- **P1**: Decide unknown-skill error/result shape with `tool-execution`.
- **P1**: Add duplicate precedence, read failure/cache, plugin mismatch, and no-active-skill tests.
- **P2**: Keep `allowed-tools` exact-name only for baseline or explicitly plan portable pattern support.
- **P2**: Map skill evals to deterministic skill-runtime versus prompt/model behavior versus plugin/MCP workflows.

## `mcp-tool-runtime`

Sources reviewed:

- `openspec/changes/backfill-mcp-tool-runtime/**`
- Adjacent specs/backfills for plugin, skill, auth, resumability, prompt, tool execution, and testing
- `packages/junior/src/chat/mcp/client.ts`
- `packages/junior/src/chat/mcp/tool-manager.ts`
- `packages/junior/src/chat/tools/skill/search-mcp-tools.ts`
- `packages/junior/src/chat/tools/skill/call-mcp-tool.ts`
- `packages/junior/src/chat/tools/skill/mcp-tool-summary.ts`
- `packages/junior/src/chat/services/mcp-auth-orchestration.ts`
- `packages/junior/src/chat/respond.ts`
- `packages/junior/src/chat/state/session-log.ts`
- MCP manager/client/search/call unit tests and MCP dynamic/auth integration tests referenced by the verification map

### Summary

The core MCP bridge is implemented in the expected shape: providers are configured from plugin manifests, activation is lazy, active MCP tools are exposed through static bridge tools, canonical names are provider-prefixed, exact dispatch validates nested arguments, auth challenges can park the turn, and durable Pi/session-log history can restore previously connected providers. The main gaps are edge-case conversion coverage, eval taxonomy, and keeping connection/auth persistence owned by session-resumability instead of burying it in MCP runtime.

### Canonicalization Gaps

| Severity | Gap                                                                | Evidence                                                                                                                                                   | Follow-up                                                                                                                              |
| -------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Provider restoration/session-log ownership crosses specs.          | `respond.ts` restores connected providers from `loadConnectedMcpProviders(...)` and derived Pi history; `session-log.ts` records `mcp_provider_connected`. | Keep activation/search/dispatch here; put durable provider connection event semantics in `agent-session-resumability` with cross-link. |
| P1       | Authorization interrupt behavior overlaps auth/resumability specs. | MCP spec describes pending authorization and parking; auth projection/event ordering is owned by session resumability and OAuth/MCP auth flows.            | Reference auth specs for session-log events, private delivery, callback ordering, and resume projection.                               |
| P2       | “Allowlisted tool missing” product policy is strong.               | Spec says activation SHALL fail if allowlist names missing tool; implementation does.                                                                      | Keep as baseline if plugin manifests are treated as strict contracts; otherwise downgrade to warning policy explicitly.                |
| P2       | Model-facing discovery behavior belongs partly to prompt/evals.    | Spec includes eval guidance for copying disclosed `callMcpTool` shape.                                                                                     | Keep deterministic descriptor shape here; map model behavior to prompt/eval taxonomy.                                                  |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                                | Evidence                                                                                                                                                                                                                    | Follow-up                                                                                              |
| -------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| P1       | MCP result conversion edge cases are implemented but under-specified for budgets.  | `toAgentToolContent(...)` passes text/images, summarizes audio/resource blobs by base64 length, serializes structured content, and returns `ok`; no explicit size budget was found for large text/structured/resource text. | Decide whether MCP conversion needs bounded text/structured output budgets and add tests.              |
| P1       | Auth-pending placeholder result is an implementation nuance not clearly reflected. | On handled auth challenge during tool call, manager returns `Authorization pending.` placeholder so the aborted turn parks cleanly.                                                                                         | Document this as internal placeholder behavior, with user-visible behavior owned by auth/resume specs. |
| P2       | Provider-scoped activation from `searchMcpTools`/`callMcpTool` is implemented.     | Search activates configured provider; call parses provider from canonical name and activates before lookup.                                                                                                                 | Keep; add explicit activation-before-resolution tests if not already precise.                          |
| P2       | Missing saved MCP server session retry is specified and covered in client tests.   | Verification map marks keep.                                                                                                                                                                                                | Keep in MCP runtime.                                                                                   |

### Verification Gaps

| Severity | Gap                                                                          | Evidence                                                                                                                         | Follow-up                                                                                                              |
| -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| P1       | Result conversion edge cases lack focused coverage.                          | Verification map marks image, audio, resource link, embedded text/binary resource, structured fallback, and empty result as add. | Add unit tests for each conversion branch and any budget decisions.                                                    |
| P1       | Two-provider same raw tool name needs explicit collision coverage.           | Existing manager test covers collision-safe naming generally; map asks for explicit same-name case.                              | Add or map exact same raw name across providers.                                                                       |
| P1       | Provider-scoped search/call activation assertions may be indirect.           | Verification map marks add/assert activation in search and call bridge paths.                                                    | Add focused unit tests that inactive configured provider is activated before search/call resolution.                   |
| P1       | Auth event projection verification belongs in auth/resumability.             | Verification map notes event projection should be cross-checked after auth change.                                               | Add tests under auth/resumability for MCP `authorization_requested`/`authorization_completed` ordering and projection. |
| P2       | Eval taxonomy is unmapped.                                                   | MCP auth/skill eval fixtures need rename/split.                                                                                  | Map evals to MCP runtime versus skill-runtime versus auth resume/model behavior.                                       |
| P2       | Descriptor title/output/annotation details may need more precise assertions. | Verification map asks for title-specific assertion if absent.                                                                    | Add low-cost unit coverage if descriptor shape is user/model-facing contract.                                          |

### Open Questions To Preserve

- Should MCP result conversion enforce explicit text/structured/resource budgets?
- Should allowlisted missing MCP tools always fail activation, or can providers evolve with warning-only behavior?
- Which MCP auth-resume tests belong here versus `agent-session-resumability` and `oauth-flows`?
- How much of model-facing MCP discovery behavior should be eval-owned versus deterministic descriptor tests?

### Suggested Follow-up Tasks

- **P1**: Cross-link provider connection and authorization event persistence to `agent-session-resumability`.
- **P1**: Add MCP result conversion edge-case tests and decide output budgets.
- **P1**: Add explicit same-raw-name collision and activation-before-search/call tests.
- **P1**: Add MCP auth session-log ordering/projection tests under auth/resumability.
- **P2**: Map MCP eval fixtures to MCP runtime, skill-runtime, prompt, and auth specs.

## `tool-execution`

Sources reviewed:

- `openspec/changes/backfill-tool-execution/**`
- `specs/agent-execution.md`
- `specs/harness-agent.md`
- `specs/harness-tool-context.md`
- `specs/agent-session-resumability.md`
- `specs/credential-injection.md`
- `specs/testing.md`
- Adjacent OpenSpec backfills for MCP, Slack, sandbox, web, skill, and plugin tools
- `packages/junior/src/chat/tools/definition.ts`
- `packages/junior/src/chat/tools/agent-tools.ts`
- `packages/junior/src/chat/tools/index.ts`
- `packages/junior/src/chat/tools/execution/*`
- `packages/junior/src/chat/tools/idempotency.ts`
- `packages/junior/src/chat/mcp/tool-manager.ts`
- Sampled concrete tools and tool execution tests referenced by the verification map

### Summary

The shared wrapper boundary is real and mostly implemented: metadata forwarding, no-op missing execute handling, progress status, sandbox routing, result normalization, MCP auth propagation, and turn-local idempotency all map to code. The major baseline gap is policy: the OpenSpec draft says repairable/expected tool failures should become tool errors, not successful `{ ok: false }` payloads, but multiple concrete tools still return sentinel failure objects. That mismatch affects web tools, Slack tools, skill loading, and list/thread tools, so canonicalization needs either a migration plan or explicit temporary exceptions.

### Canonicalization Gaps

| Severity | Gap                                                              | Evidence                                                                                                                                                 | Follow-up                                                                                                                       |
| -------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| P1       | No canonical root/index pointer yet.                             | `specs/tool-execution.md` is absent; `specs/index.md`/`AGENTS.md` do not point to it.                                                                    | Canonicalize only after resolving policy mismatches.                                                                            |
| P1       | Failure semantics conflict with existing root `agent-execution`. | `agent-execution.md` currently owns the `{ ok:false }` prohibition directly; tool-execution wants to own it.                                             | Move shared tool failure policy to `tool-execution` and make `agent-execution` reference it.                                    |
| P1       | Turn-local idempotency conflicts with resumability language.     | Tool-execution says idempotency is turn-local; session resumability says side-effect/idempotency entries must be committed before a safe pause boundary. | Define which side-effect families need durable idempotency markers across timeout/auth resume and which are wrapper-local only. |
| P1       | Plugin hook `env` mutation is under-specified.                   | Wrapper applies hook-modified input; plugin hooks can add `env`, but spec only describes input rewrite.                                                  | Decide whether env mutation belongs to `tool-execution`, `plugin-runtime`, or credential/security specs.                        |
| P2       | “Core tools are always available” is too loose.                  | Tool registration includes safe/read tools and bridge tools while side-effect tools are capability-gated.                                                | Distinguish always-registered safe tools, bridge tools, and capability-gated side-effect tools.                                 |
| P2       | Image result wording should match actual contract.               | Implementation uses Pi-style `mimeType`, while prose says media type.                                                                                    | Use actual contract term or intentionally keep abstract.                                                                        |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                                  | Evidence                                                                                                                                                                                                                                                                   | Follow-up                                                                                       |
| -------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| P1       | Expected failure semantics do not match many concrete tools.                         | Spec forbids successful sentinel failures; sampled tools still return `{ ok:false }` for unknown `loadSkill`, `webSearch`/`webFetch` failures, Slack list missing artifact context, reaction missing context/invalid emoji, and Slack thread invalid/missing access paths. | Run a concrete sentinel-failure audit by tool family and decide migration/exceptions.           |
| P1       | Slack action error classification is ambiguous.                                      | Spec says preserve Slack error attributes while applying expected/unexpected family classification; implementation preserves attributes mainly for unexpected exceptions and does not treat `SlackActionError` as expected by default.                                     | Define Slack action expected-error taxonomy and update handler/tests.                           |
| P1       | Durable side-effect idempotency is not owned.                                        | Turn-local dedupe exists, but resumability safe-boundary contract needs durable markers for some side effects.                                                                                                                                                             | Assign durable idempotency to side-effect specs/session log, or explicitly state not supported. |
| P2       | Shared wrapper paths are mostly aligned.                                             | Metadata forwarding, missing execute no-op, progress, sandbox routing, auth propagation, and normalization are implemented.                                                                                                                                                | Keep; fill focused coverage gaps.                                                               |
| P2       | MCP handled-auth placeholder is aligned with MCP runtime but should be cross-linked. | MCP `isError` becomes expected error; handled auth can return placeholder pending result.                                                                                                                                                                                  | Keep MCP-specific nuance in MCP/auth specs.                                                     |

### Verification Gaps

| Severity | Gap                                                                            | Evidence                                                                                                                                                                                                                                                                                 | Follow-up                                                                                                |
| -------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| P1       | No targeted runtime tests were run for this audit.                             | Worksheet records OpenSpec validation, not runtime verification.                                                                                                                                                                                                                         | Run targeted tests when moving from gap audit to closure.                                                |
| P1       | Wrapper gap coverage is incomplete.                                            | Verification map marks no-op tools, MCP-manager absent omission, plugin/core conflict mapping, plugin input error classification, image structured content, host fallback when sandbox cannot execute, new-turn idempotency freshness, and Pi `toolResult.isError=true` repair behavior. | Convert map rows into focused tasks.                                                                     |
| P1       | End-to-end Pi repair behavior for expected tool errors is not directly proven. | Existing tests cover handler pieces; evals cover some natural-language repair.                                                                                                                                                                                                           | Add Pi/runtime integration for `toolResult.isError=true`; keep natural-language repair quality in evals. |
| P2       | MCP static bridge evidence is split.                                           | `mcp-dynamic-tools.test.ts` is partly hand-rolled; runtime progressive-loading tests provide stronger wiring evidence.                                                                                                                                                                   | Map stronger tests and avoid overstating hand-rolled fixture coverage.                                   |

### Open Questions To Preserve

- Are current `{ ok:false }` concrete tool results known noncompliance, or do some tool families intentionally retain sentinel success payloads?
- Which side-effect tools require durable idempotency across timeout/auth resume?
- Should plugin hook `env` mutation be a tool-execution, plugin-runtime, or credential-injection/security contract?
- Should expected tool-error repair be verified by Pi integration plus evals for reply quality?

### Suggested Follow-up Tasks

- **P1**: Decide sentinel failure policy and audit Slack/web/skill tools for `{ ok:false }` returns.
- **P1**: Reconcile idempotency with session resumability safe-boundary language.
- **P1**: Define Slack action expected-error classification.
- **P1**: Decide plugin hook `env` ownership.
- **P1**: Add expected tool-error Pi integration coverage.
- **P2**: Canonicalize root/index pointers after the policy decisions are settled.

## `sandbox-tools`

Sources reviewed:

- `openspec/changes/backfill-sandbox-tools/**`
- `specs/security-policy.md`
- `specs/sandbox-snapshots.md`
- `specs/agent-prompt.md`
- `specs/testing.md`
- Related `tool-execution` OpenSpec draft
- `packages/junior/src/chat/tools/sandbox/*`
- `packages/junior/src/chat/sandbox/sandbox.ts`
- `packages/junior/src/chat/sandbox/session.ts`
- `packages/junior/src/chat/tools/agent-tools.ts`
- Sandbox tool, sandbox executor, attach-file, build-sandbox-input, keepalive, and interruption tests referenced by the verification map

### Summary

The backfill captures much of the current sandbox tool behavior, but it overstates the path/lifecycle model. The spec describes a clean “all structured filesystem tools are workspace-confined and executor-routed” contract; current code has broader behavior: `readFile`/`writeFile` preserve absolute paths, `attachFile` is a host-executed tool over the sandbox workspace, `readFile` can serve virtual host-side skill/reference files before sandbox boot, and keepalive is best-effort/config-gated.

### Canonicalization Gaps

| Severity | Gap                                                                          | Evidence                                                                                                                                                                            | Follow-up                                                                                                   |
| -------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P1       | Workspace confinement is overstated.                                         | Spec says structured filesystem tools reject paths outside `/vercel/sandbox`; only list/find/grep/edit use workspace path resolution, while read/write preserve raw absolute paths. | Decide path policy for read/write and update spec/code/tests.                                               |
| P1       | `attachFile` needs an explicit execution-model exception or different owner. | It is registered as a normal host tool and is not in `SANDBOX_TOOL_NAMES`; it reads from sandbox workspace but does not execute through sandbox tool routing.                       | Either carve it out in sandbox-tools or move ownership to reply/file-delivery with sandbox read dependency. |
| P1       | Missing-path sentinel behavior conflicts with `tool-execution`.              | Sandbox tools intentionally return `ok:false`/`success:false` for read/search misses; tool-execution draft says repairable failures should not be successful sentinel payloads.     | Resolve with shared tool-execution failure policy.                                                          |
| P1       | Lifecycle wording is too broad.                                              | Spec says no active sandbox means create/retrieve before execution; `readFile` may read virtual skill/reference files without booting a sandbox.                                    | Document virtual read exception or move it to skill-runtime.                                                |
| P1       | Keepalive requirement is stronger than implementation.                       | Spec says keepalive SHALL extend; implementation only extends when `VERCEL_SANDBOX_KEEPALIVE_MS` is set and swallows extension failures.                                            | Reword as configured best-effort or make keepalive mandatory.                                               |
| P2       | Source inventory references absent root specs.                               | Worksheet references root `specs/tool-execution.md` and `specs/reply-planning.md`, which are OpenSpec backfills only.                                                               | Fix inventory/cross-link wording.                                                                           |
| P2       | Non-persistence evidence is overstated.                                      | Design says sandbox creation passes explicit `persistent:false`; code only passes it when network policy is present.                                                                | State intent carefully or update creation path.                                                             |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                  | Evidence                                                                                                          | Follow-up                                                                                   |
| -------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P1       | `readFile`/`writeFile` path policy is unresolved.                    | Current code does not locally reject absolute non-workspace paths before delegation; tests preserve `/tmp` paths. | Decide whether sandbox-absolute paths are valid.                                            |
| P1       | `attachFile` path policy is broader than generated-artifact wording. | `attachFile` accepts arbitrary absolute sandbox paths, not only generated artifacts.                              | Specify supported sources: generated files only, arbitrary sandbox paths, or both.          |
| P1       | `attachFile` input failures are generic errors.                      | Missing/empty/oversized failures throw generic `Error`, not `ToolInputError`.                                     | Decide if generic failure is acceptable or align with tool-execution expected input errors. |
| P2       | Missing read versus edit target behavior differs.                    | `readFile` missing target returns structured missing result; `editFile` throws `ToolInputError`.                  | Resolve under shared error taxonomy.                                                        |
| P2       | Full-file write guidance is not enforced.                            | Spec says write is reserved for creation/replacement; implementation permits any write.                           | Keep as model guidance or add enforcement if needed.                                        |

### Verification Gaps

| Severity | Gap                                                                    | Evidence                                                                                  | Follow-up                                |
| -------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| P1       | No targeted tests were run for this audit.                             | Only OpenSpec validation is recorded.                                                     | Run targeted tests during closure.       |
| P1       | Outside-workspace read/write policy lacks focused coverage.            | Verification map does not prove chosen policy because policy is undecided.                | Add tests after path decision.           |
| P1       | `attachFile` empty-file failure lacks focused coverage.                | Subagent found missing coverage.                                                          | Add unit test after deciding error type. |
| P1       | Bash timeout/AbortSignal and output truncation coverage is incomplete. | Verification map should be checked against sandbox executor tests.                        | Add focused tests if gaps remain.        |
| P2       | Verification map has stale unclear/add rows.                           | Keepalive, missing edit target, and stream interruption appear covered in existing tests. | Refresh map to avoid false gaps.         |

### Open Questions To Preserve

- Should `readFile` and `writeFile` be workspace-only, or should sandbox-absolute paths be allowed?
- Is `attachFile` owned by sandbox-tools, reply/file delivery, or both?
- Should missing read/search paths be expected tool errors or model-visible sentinel results?
- Is keepalive required behavior or configured best effort?
- Should virtual skill/reference reads be documented here or in skill-runtime?

### Suggested Follow-up Tasks

- **P1**: Resolve read/write path policy and update spec/code/tests.
- **P1**: Add explicit `attachFile` exception or move ownership to reply/file-delivery.
- **P1**: Reconcile missing-path sentinel behavior with tool-execution.
- **P1**: Decide keepalive requirement strength.
- **P2**: Fix worksheet source inventory and refresh verification map for already-covered cases.

## `slack-tools`

Sources reviewed:

- `openspec/changes/backfill-slack-tools/**`
- `specs/harness-tool-context.md`
- `specs/agent-execution.md`
- `specs/slack-outbound-contract.md`
- `specs/slack-agent-delivery.md`
- `specs/agent-turn-handling.md`
- `specs/testing.md`
- `packages/junior/src/chat/tools/index.ts`
- `packages/junior/src/chat/tools/slack/*`
- Slack channel, thread, canvas, list, user lookup, and tool registration tests referenced by the verification map

### Summary

The backfill mostly matches implemented Slack reaction, channel post/history, thread read, canvas, list, context-binding, and turn-local idempotency behavior. It is not ready to canonicalize because it leaves the shared repairable-failure policy unresolved, omits the implemented `slackUserLookup` tool entirely, and includes model intent language that belongs in `agent-turn-handling`/prompt evals rather than the deterministic Slack tool contract.

### Canonicalization Gaps

| Severity | Gap                                                                         | Evidence                                                                                                                                                                 | Follow-up                                                                                                                   |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| P1       | Repairable Slack tool failures conflict with canonical tool-failure policy. | Spec says surface model-repairable failure; root specs require `ToolInputError`/`isError=true` and forbid final `{ ok:false }` sentinel outputs; design leaves it open.  | Resolve under `tool-execution` and update Slack tools accordingly.                                                          |
| P1       | `slackUserLookup` is missing from the capability.                           | Tool is registered unconditionally, implemented, and covered by `slack-user-lookup.test.ts`, but absent from OpenSpec requirements.                                      | Add requirements/verification rows or split into Slack identity/read capability.                                            |
| P1       | Channel-post intent language is in the wrong spec.                          | Spec says channel post is only for user-requested posts; implementation posts when called and does not enforce intent locally; design says model choice is out of scope. | Move natural-language intent requirements to `agent-turn-handling`/prompt/evals; keep tool spec to execution/preconditions. |
| P1       | Thread-read coordinate targeting is under-specified.                        | Implementation allows model-provided `channel_id` + `ts` for public/readable channels; spec only covers archive URLs and private/DM refusal.                             | Explicitly bless or prohibit coordinate reads.                                                                              |
| P1       | Canvas access grant wording is too strong.                                  | Spec says Junior SHALL grant active conversation access; implementation treats grant failure as best-effort and still succeeds.                                          | Rewrite as best-effort or change implementation.                                                                            |
| P2       | Availability wording is incomplete.                                         | Some Slack read/document/list/user tools are always registered while side-effect/context tools are gated.                                                                | Distinguish always-available Slack read/identity tools from context-gated side-effect tools.                                |
| P2       | DM canvas/channel-history and durable idempotency remain open.              | Tasks/design leave those decisions unresolved.                                                                                                                           | Settle or explicitly defer before canonicalization.                                                                         |

### Requirement vs Implementation Gaps

| Severity | Gap                                                                 | Evidence                                                                                                                         | Follow-up                                                                            |
| -------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| P1       | Multiple Slack tools return `{ ok:false }` for repairable failures. | Reaction, channel post, thread read, list follow-ups, and user lookup use sentinel results for missing/invalid context or input. | Convert to expected tool errors or document exceptions after shared policy decision. |
| P1       | `slackUserLookup` behavior is unrepresented.                        | Inputs, errors, pagination/search semantics, and registration are not specified.                                                 | Add to spec or split capability.                                                     |
| P1       | Channel post does not enforce user intent.                          | Implementation executes the tool without intent checking.                                                                        | Keep this as prompt/eval behavior, not tool requirement.                             |
| P2       | Canvas access grant is best-effort.                                 | Tool can succeed even when access grant fails.                                                                                   | Align prose with implementation.                                                     |

### Verification Gaps

| Severity | Gap                                                                     | Evidence                                                                                     | Follow-up                                                  |
| -------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P1       | Failure-context coverage must be revisited after error policy decision. | Current tests may assert sentinel behavior that will change if tool errors become canonical. | Update tests after policy decision.                        |
| P1       | `slackUserLookup` needs verification-map entries.                       | Existing tests exist but are not mapped.                                                     | Add scenarios for lookup/search/pagination/error behavior. |
| P2       | Verification map has stale missing rows.                                | Reaction/post dedupe and private URL stripping appear covered, but map marks maybe/add.      | Refresh map.                                               |
| P2       | Broad integration tests need scenario mapping.                          | Task 4.2 captures this.                                                                      | Map integration cases to named Slack tool requirements.    |
| P2       | Natural-language tool choice should be eval-owned.                      | Current spec mixes model choice with tool execution.                                         | Move eval mapping to agent behavior/prompt.                |

### Open Questions To Preserve

- Which Slack tool failures become `ToolInputError`, and are any `{ ok:false }` read results intentionally data rather than failure?
- Is `slackUserLookup` part of `slack-tools` or a separate Slack identity/read capability?
- Are public-channel `channel_id` + `ts` thread reads intended model-facing targeting exceptions?
- Should canvas access grant failure remain successful best-effort behavior?
- Is DM canvas creation permanent product behavior?

### Suggested Follow-up Tasks

- **P1**: Resolve Slack tool failure semantics with `tool-execution`.
- **P1**: Add `slackUserLookup` requirements and verification rows, or split it out.
- **P1**: Move channel-post intent requirements to `agent-turn-handling`/eval mapping.
- **P1**: Clarify thread-read URL versus coordinate targeting rules.
- **P1**: Rewrite canvas access wording to best-effort or change implementation.
- **P2**: Refresh verification map for already-covered dedupe/private URL cases.

## `advisor-tool`

Sources reviewed:

- `openspec/changes/backfill-advisor-tool/**`
- `specs/advisor-tool.md`
- Related specs for execution, tool, prompt, compaction, resumability, instrumentation, and testing
- `packages/junior/src/chat/tools/advisor/tool.ts`
- `packages/junior/src/chat/tools/advisor/session-store.ts`
- `packages/junior/src/chat/tools/index.ts`
- `packages/junior/src/chat/respond.ts`
- `packages/junior/src/chat/config.ts`
- Advisor integration and config tests referenced by the verification map

### Summary

The advisor tool is comparatively aligned: exposure is gated on advisor runtime context, config defaults/validation exist, inputs are trimmed and XML-escaped into explicit `<advisor-task>`/`<executor-context>` sections, parent transcript is not implicitly forwarded, the advisor uses a separate Pi agent/session id, read-only tools are filtered, and session history persists by parent conversation id. The main gap is cross-spec failure semantics: advisor intentionally returns non-fatal `{ ok:false, error_code }` results, which conflicts with the emerging `tool-execution` policy unless advisor is explicitly carved out as advisory/non-fatal.

### Canonicalization Gaps

| Severity | Gap                                                                  | Evidence                                                                                                                                           | Follow-up                                                                                                                             |
| -------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Advisor failure shape conflicts with shared tool-error policy.       | Spec requires `ok:false` stable error codes for advisor failures; `tool-execution` draft aims to move repairable failures to expected tool errors. | Decide whether advisor is an explicit exception because failure guidance is useful and non-fatal, or convert to expected tool errors. |
| P1       | Observability scenarios should not become behavior-test obligations. | Spec has detailed span requirements; repo policy says telemetry is not behavior unless instrumentation spec owns it.                               | Keep observability under instrumentation, and do not require advisor tests to assert spans except targeted instrumentation tests.     |
| P2       | Model-facing advisor-use eval scope is not mapped.                   | Verification map marks advisor-use quality evals as add.                                                                                           | Define eval scope only for “when to consult advisor/use guidance,” not deterministic tool mechanics.                                  |

### Requirement vs Implementation Gaps

| Severity | Gap                                                       | Evidence                                                                                                                                                                                                                  | Follow-up                                                                                                       |
| -------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| P1       | Empty advisor assistant text may be treated as success.   | Implementation extracts assistant text and saves/returns it if assistant exists and stop reason is not error/aborted; no explicit empty-text check was found. Spec says no usable assistant text returns unavailable.     | Add empty-text check or relax spec.                                                                             |
| P1       | Advisor recursive self-exclusion may be indirect.         | `createAdvisorToolDefinitions(...)` excludes MCP bridge tools and only includes read-only annotations; `advisor` itself likely excluded because it is not read-only, not by explicit name. Spec says advisor is excluded. | Add explicit `name !== "advisor"` guard or narrow wording to metadata-based exclusion plus MCP bridge denylist. |
| P2       | Follow-up advisor calls preserve private advisor history. | Implementation does this; spec says executor should include new evidence rather than assuming history has it.                                                                                                             | Keep as prompt/tool-description guidance; model behavior eval optional.                                         |

### Verification Gaps

| Severity | Gap                                                       | Evidence                                                                                                                                                               | Follow-up                                                     |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P1       | Parent transcript isolation lacks direct proof.           | Current tests assert curated context reaches advisor; no direct test proves unsupplied parent transcript/tool results are absent.                                      | Add integration test with parent-only sentinel not forwarded. |
| P1       | Failure classes are undercovered.                         | Verification map marks empty/non-string question, no assistant/error/aborted stop, advisor run throw, missing conversation id, store load failure, store save failure. | Add focused unit/integration tests.                           |
| P1       | XML escaping assertion is missing.                        | Tests check content appears, not that XML-sensitive executor text is escaped.                                                                                          | Add test with `<`/`&` in question/context.                    |
| P2       | Advisor/self and MCP bridge exclusion should be explicit. | Tests cover real read-only tool set and exclude MCP bridge indirectly if present; map asks for explicit self/MCP exclusion.                                            | Add focused tool-filtering assertions.                        |
| P2       | Eval coverage is unmapped.                                | Advisor prompt policy and executor use of advisor guidance are model-dependent.                                                                                        | Add evals only after deciding desired trigger/usage behavior. |

### Open Questions To Preserve

- Is advisor an explicit `{ ok:false }` non-fatal exception to tool-execution expected-error policy?
- Should empty advisor text be unavailable, or can an empty memo be a valid advisory result?
- Should advisor self-exclusion be explicit by name even if annotations already exclude it?
- What eval scope, if any, proves the main executor consults advisor appropriately?

### Suggested Follow-up Tasks

- **P1**: Decide advisor failure-shape exception with `tool-execution`.
- **P1**: Add empty-assistant-text handling or relax spec.
- **P1**: Add parent-transcript isolation, XML escaping, missing conversation id, store failure, run failure, and no-assistant tests.
- **P2**: Add explicit advisor/MCP bridge exclusion assertions.
- **P2**: Keep observability assertions under instrumentation-only tests.
