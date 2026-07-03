# Non-Normative Cleanup Notes

## Metadata

- Created: 2026-05-28
- Last Edited: 2026-05-28

## Changelog

- 2026-05-28: Captured roadmap and migration notes removed from active specs during spec cleanup.

## Status

Archived note, non-normative.

## Scope

This note preserves cleanup guidance that used to live inside active specs. Active specs remain the source of truth when this note conflicts with them.

## Chat Architecture Cutover Notes

Conditions that were previously called out as non-end-state:

1. Plugin and capability discovery still flow through a default module-level catalog cache instead of fully injected catalogs.
2. Eval harness still owns too many environment and runtime control knobs.
3. Legacy compatibility exports like `botConfig` still exist; new code should prefer explicit config readers when it needs more than one value or subsystem.

Previous migration sequence:

1. Document the contract in `AGENTS.md` and canonical specs.
2. Replace runtime-global behavior seams with injected services.
3. Split state into adapter and concern-specific stores.
4. Remove singleton-only queue dispatch and move runtime assembly fully behind explicit factories.
5. Replace prototype-patch ingress with an explicit ingress router boundary.
6. Replace plugin/capability registries with composition-bound catalogs and factories.
7. Shrink harness and remaining test hooks to local runtime fixtures or boundary spies.

## Slack Delivery Convergence Notes

Previous intended cleanup sequence:

1. Keep the shared Slack reply planner as the only authority for continuation markers, file delivery, and resumed post planning.
2. Keep persisted thread conversation state as the primary context source.
3. Keep the explicit separation between behavior integration tests and Slack transport-contract tests.
4. Keep assistant status as the baseline progress affordance.
5. If richer progress is needed later, prefer status/task-oriented surfaces over provisional assistant prose.
6. Keep visible answer text tied to finalized reply delivery, not mid-generation transport state.
7. Prefer documented adapter and Slack API surfaces over monkey-patching private adapter internals.
8. Keep reply correctness independent from optional adapter-level streaming behavior.

## Logging Migration Notes

Previous migration matrix:

1. `packages/junior/src/handlers/webhooks.ts`: unknown platform, handler failures, request lifecycle.
2. `packages/junior/src/chat/runtime/slack-runtime.ts`: attachment handling, thread lifecycle, handler failures.
3. `packages/junior/src/chat/agent-run.ts`: empty/fallback behaviors, retries, model/tool anomalies. Per-turn diagnostics are captured on turn spans, not required as info logs.
4. `packages/junior/src/chat/skills.ts`: skill discovery/read/frontmatter parse issues.
5. `packages/junior/src/chat/slack/output.ts`: output normalization fallback.

Previous rollout phases:

1. Define ambient context merge semantics and precedence.
2. Add the structured logging facade and normalization utilities.
3. Wire request context and remove repeated manual context blocks.
4. Replace legacy logging calls with event-based structured logs.
5. Add guardrails for redaction, attribute sanitization, context propagation, and event naming.
6. Reduce noisy logs and validate Sentry queries and dashboards.

Previous logging TODOs:

1. Migrate duplicated per-turn context in `packages/junior/src/chat/agent-run.ts` to ambient `withContext`/`withLogContext`.
2. Update `packages/junior/src/chat/runtime/slack-runtime.ts` logging call patterns to rely on ambient context by default.
3. Normalize remaining ad-hoc context passing in `packages/junior/src/chat/capabilities/*` and `packages/junior/src/chat/queue/*`.
4. Add unit tests for context merge precedence and async propagation in `packages/junior/src/chat/logging.ts`.
5. Add regression tests to verify optional context behavior for `logInfo`, `logWarn`, `logError`, and `logException`.
6. Add a lint/check rule that flags repeated baseline context keys when ambient context is already bound.
7. Audit noisy or low-value events after migration and reduce log volume where possible.
8. Validate Sentry dashboards/queries still group by `event.name` and retain correlation attributes after migration.
9. Investigate and fix duplicate Sentry emission in logger transport path.

## Tracing Rollout Notes

Previous rollout guidance:

1. Start with lifecycle and I/O spans.
2. Avoid per-file child spans for skill synchronization in the initial rollout.
3. Expand only when a specific observability gap is identified and justified.

## Testing Consolidation Notes

Previous audit checklist:

1. Keep OAuth callback sanitization/token-shaping branches in unit tests and Slack app-home/thread-resume behavior in integration tests.
2. Keep MCP OAuth callback sanitization and local omitted-image/state reconstruction invariants in unit tests; keep resumed-thread delivery, file uploads, and Slack continuation behavior in integration tests.
3. Keep auth rejection, timeout re-enqueue, and persistence-failure edge handling in unit tests; keep successful resumed delivery, exhausted-depth user messaging, and shared file-delivery path coverage in integration tests.
4. Keep Slack runtime ordering, formatting, and local orchestration invariants in unit tests; keep scenario-level mention/subscribed-thread behavior in integration tests.
5. Let integration own deterministic routing gates, subscription state, and Slack delivery contracts; let evals own ambiguous natural-language direction, passive-participation quality, and continuity recall.
6. Keep OAuth callback routing and Slack API effects in integration tests; keep user-visible continuation quality and context retention in evals.
7. Keep local MCP auth-pause edge cases and checkpoint invariants in unit tests; keep the real Slack runtime plus OAuth callback happy path in integration tests.

## Scheduler Implementation Notes

Previous implementation sequence:

1. Introduce a small actor contract shared by runtime, scheduler, and auth boundaries. It should represent user actors, system actors, and future service actors without leaking Slack SDK types.
2. Keep `createdBy` as creator metadata and add an execution actor field to scheduled tasks. New scheduled tasks should default to a system actor such as `scheduled-task`; existing tasks may be read with that default until migrated.
3. Add conversation access metadata with separate audience and visibility fields. Slack direct-message destinations populate `direct/private`; private channels or group conversations are not eligible for delegated user credentials.
4. Update the scheduled runner to enter the agent runtime with the system actor and no user requester. Creator details may remain in run context and notification metadata, but not in the actor slot.
5. Update auth and credential resolution so scheduled runs can use an explicit private-direct credential subject but cannot start interactive auth flows. Missing credentials should produce a blocked run plus private notification.
6. Update telemetry, tests, and eval fixtures so scheduled execution assertions refer to creator metadata, execution actor, and credential subject separately.

## Advisor Prior Art Notes

1. Anthropic Advisor established the escalation pattern: a cheaper/faster executor calls a stronger advisor for strategic guidance and continues when the advisor fails. Junior kept the escalation pattern but did not use Anthropic's server-side `advisor_20260301` API, full-transcript injection, or tool-less advisor run.
2. Claude Code subagents showed the value of separate context, custom prompts, tool boundaries, and persistent memory. Junior uses those ideas for advisor continuity, but the advisor is a consultant, not a delegated worker.
3. Amp Oracle showed the coding-agent use case: expose a stronger model as a tool for review, debugging, analysis, and deciding what to do next without forcing it on routine work.

## Agent Session Resumability Prior Art

1. Pi ecosystem references: <https://pi.dev/> and <https://github.com/badlogic/pi-mono>.
2. LangGraph durable execution and checkpointing: <https://docs.langchain.com/oss/javascript/langgraph/durable-execution>.
3. Inngest durable step execution and checkpointing: <https://www.inngest.com/docs/learn/how-functions-are-executed> and <https://www.inngest.com/docs/setup/checkpointing>.
4. Vercel Workflow durability model: <https://vercel.com/docs/workflow>.
5. AWS SQS dead-letter and redrive policy patterns: <https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html>.
6. Azure Durable Functions orchestration checkpoints and replay: <https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-orchestrations>.
