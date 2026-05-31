## 1. Backfill Program Setup

- [x] 1.1 Create a reusable backfill worksheet template with sections for current-source inventory, prior art, implemented behavior, intended behavior, undefined behavior/open questions, OpenSpec requirements, verification map, and migration notes.
- [x] 1.2 Create a verification map template with columns: capability, requirement, scenario, primary layer, current test/eval, keep/rename/split/move/replace/delete, gap, and owner notes.
- [x] 1.3 Decide where accepted OpenSpec baseline specs live relative to `specs/`, and record the canonical ownership rule before archiving or rewriting any existing canonical doc.
- [x] 1.4 Define the acceptance checklist every backfilled spec must pass: source inventory complete, prior art reviewed, open questions recorded, requirements/scenarios valid, verification map complete, indexes updated, and `openspec validate` passing.

## 2. Tier 0 Core Agent Behavior

- [x] 2.1 Backfill `agent-turn-handling`: finish the existing `spec-agent-turn-handling` change by reviewing Slack/Teams/Discord chatbot prior art, `slack-runtime.ts`, `subscribed-decision.ts`, `prompt.ts`, `respond.ts`, `reply-executor.ts`, current Slack tests/evals, undefined participation behavior, OpenSpec requirements, and verification taxonomy.
- [x] 2.2 Backfill `slack-agent-delivery`: inspect `specs/slack-agent-delivery.md`, Slack API docs, `runtime/reply-executor.ts`, `slack/reply.ts`, `slack/output.ts`, assistant status modules, Slack delivery tests, continuation/file/image behavior, open questions around status/footer/chunking ownership, and produce OpenSpec requirements/scenarios.
- [x] 2.3 Backfill `agent-session-resumability`: inspect `specs/agent-session-resumability.md`, Pi continuation prior art, `respond.ts`, `state/turn-session.ts`, `services/turn-session-record.ts`, resume handlers/tests, timeout/auth pause behavior, undefined stale/duplicate callback behavior, and produce OpenSpec requirements/scenarios.
- [x] 2.4 Backfill `agent-prompt`: inspect `specs/agent-prompt.md`, prompt engineering prior art, `prompt.ts`, skill/tool prompt snippets, prompt tests/evals, undefined prompt ownership boundaries, and produce OpenSpec requirements/scenarios without freezing exact prose.
- [x] 2.5 Backfill `harness-agent`: inspect `specs/harness-agent.md`, Pi Agent docs/source, `respond.ts`, `services/turn-result.ts`, streaming/final-output tests, undefined output-resolution behavior, and produce OpenSpec requirements/scenarios.
- [x] 2.6 Backfill `context-compaction`: inspect `specs/context-compaction.md`, Codex/Pi compaction prior art, `services/context-compaction.ts`, session-log projection behavior, compaction tests/evals, undefined summary retention behavior, and produce OpenSpec requirements/scenarios.

## 3. Tier 1 Ingress, Routing, State, And Delivery Planning

- [x] 3.1 Backfill `slack-ingress-routing`: inspect Slack Events API docs, Chat SDK adapter contracts, `ingress/*`, `queue/thread-message-dispatcher.ts`, `runtime/thread-context.ts`, assistant lifecycle tests, direct-message routing tests, undefined event subtype behavior, and produce OpenSpec requirements/scenarios.
- [x] 3.2 Backfill `conversation-state`: inspect `state/conversation.ts`, `services/conversation-memory.ts`, `runtime/turn-preparation.ts`, persisted thread-state tests, skipped-message behavior, image cache state, active-turn pointers, undefined retention/TTL behavior, and produce OpenSpec requirements/scenarios.
- [x] 3.3 Backfill `queue-and-locking`: inspect Chat SDK queue/lock docs/source, `app/production.ts`, queue dispatcher, state adapter lock tests, skipped-message tests, retry behavior, undefined lock-expiry and dropped-message behavior, and produce OpenSpec requirements/scenarios.
- [x] 3.4 Backfill `reply-planning`: inspect `services/reply-delivery-plan.ts`, `services/turn-result.ts`, `slack/reply.ts`, `slack/footer.ts`, finalized reply tests, side-effect suppression tests, file-only reply tests, undefined channel-only/reaction-only combinations, and produce OpenSpec requirements/scenarios.
- [x] 3.5 Backfill `attachment-and-vision-context`: inspect Slack file/image docs, `services/vision-context.ts`, attachment/image hydration tests, `runtime/turn-user-message.ts`, private-file fetchers, unavailable vision behavior, undefined media-type handling, and produce OpenSpec requirements/scenarios.

## 4. Tier 2 Tool And Action Surfaces

- [x] 4.1 Backfill `tool-execution`: inspect `tools/definition.ts`, `tools/agent-tools.ts`, `tools/execution/*`, `specs/agent-execution.md`, tool-error tests, idempotency tests, prior art from Pi tool semantics, undefined model-repairable error behavior, and produce OpenSpec requirements/scenarios.
- [x] 4.2 Backfill `sandbox-tools`: inspect Vercel Sandbox docs/source, `sandbox/*`, `tools/sandbox/*`, sandbox tests/evals, command interruption behavior, generated file attachment behavior, undefined filesystem/path behavior, and produce OpenSpec requirements/scenarios.
- [x] 4.3 Backfill `slack-tools`: inspect Slack API docs, `tools/slack/*`, `slack/outbound.ts`, channel/reaction/canvas/list tests, context-bound target prior art, undefined tool availability by channel type, and produce OpenSpec requirements/scenarios.
- [x] 4.4 Backfill `web-tools`: inspect `tools/web/*`, web search/fetch/image generation tests/evals, provider docs, current-data/source hierarchy behavior, network failure behavior, undefined citation/source requirements, and produce OpenSpec requirements/scenarios.
- [x] 4.5 Backfill `skill-runtime`: inspect `skills.ts`, `sandbox/skill-sandbox.ts`, `tools/skill/load-skill.ts`, skill invocation evals, available/user-callable skill prompt behavior, undefined skill precedence behavior, and produce OpenSpec requirements/scenarios.
- [x] 4.6 Backfill `mcp-tool-runtime`: inspect MCP docs, `mcp/*`, `tools/skill/search-mcp-tools.ts`, `call-mcp-tool.ts`, MCP auth/runtime tests, provider restoration behavior, undefined provider activation behavior, and produce OpenSpec requirements/scenarios.
- [x] 4.7 Backfill `advisor-tool`: inspect `specs/advisor-tool.md`, `tools/advisor/*`, advisor integration tests/evals, prior art for sub-agent/advisor tools, undefined session isolation behavior, and produce OpenSpec requirements/scenarios.

## 5. Tier 3 Auth, Credentials, And Plugins

- [x] 5.1 Backfill `credential-injection`: inspect `specs/credential-injection.md`, credential brokers, sandbox egress credential injection, security policy, credential tests, undefined requester-bound lease behavior, and produce OpenSpec requirements/scenarios.
- [x] 5.2 Backfill `oauth-flows`: inspect `specs/oauth-flows.md`, OAuth provider docs, `oauth-flow.ts`, OAuth callback handlers, auth resume tests/evals, private Slack delivery behavior, undefined stale-auth completion behavior, and produce OpenSpec requirements/scenarios.
- [x] 5.3 Backfill `plugin-manifest`: inspect `specs/plugin-manifest.md`, plugin manifest parser/tests, package discovery, plugin API docs, undefined manifest compatibility/versioning behavior, and produce OpenSpec requirements/scenarios.
- [x] 5.4 Backfill `plugin-runtime`: inspect `specs/plugin.md`, `specs/plugin-runtime.md`, plugin registry/discovery/state, trusted plugin hooks, plugin eval fixtures, undefined isolation/loading failures, and produce OpenSpec requirements/scenarios.
- [x] 5.5 Backfill `plugin-auth`: inspect `plugins/auth/*`, plugin OAuth/API-header brokers, user token store, provider package auth patterns, undefined scope refresh/revocation behavior, and produce OpenSpec requirements/scenarios.
- [x] 5.6 Backfill `trusted-plugin-dispatch`: inspect `specs/trusted-plugin-dispatch.md`, `agent-dispatch/*`, dispatch runner/store/signing tests, prior art for durable dispatch, undefined retry/abandonment behavior, and produce OpenSpec requirements/scenarios.
- [x] 5.7 Backfill `trusted-plugin-heartbeat`: inspect `specs/trusted-plugin-heartbeat.md`, heartbeat implementation/tests, scheduler interactions, undefined missed-heartbeat behavior, and produce OpenSpec requirements/scenarios.

## 6. Tier 4 Configuration, Scheduler, Providers, CLI, Docs, And Packaging

- [x] 6.1 Backfill `channel-configuration`: inspect `configuration/*`, `capabilities/jr-rpc-command.ts`, prompt configuration blocks, config tests/evals, undefined key ownership/default precedence behavior, and produce OpenSpec requirements/scenarios.
- [x] 6.2 Backfill `scheduler`: inspect `specs/scheduler.md`, `packages/junior-scheduler`, scheduler evals/tests, Slack schedule tools, trusted plugin heartbeat interactions, undefined missed-run/backfill behavior, and produce OpenSpec requirements/scenarios.
- [x] 6.3 Backfill `provider-packages`: inspect `packages/junior-github`, `junior-sentry`, `junior-linear`, `junior-notion`, `junior-datadog`, `junior-hex`, `junior-agent-browser`, provider skill evals, external provider docs, undefined shared provider contract behavior, and decide whether to split into per-provider specs.
- [x] 6.4 Backfill `agent-dispatch`: inspect `chat/agent-dispatch/*`, handlers, plugin dispatch tests, signing/validation behavior, undefined dispatch ownership relative to trusted plugin specs, and produce OpenSpec requirements/scenarios.
- [x] 6.5 Backfill `cli`: inspect `src/cli`, package scripts, CLI tests, plugin/skill install/check commands, undefined output/error compatibility behavior, and produce OpenSpec requirements/scenarios.
- [x] 6.6 Backfill `docs-site`: inspect `packages/docs`, public docs skill guidance, docs build tests, information architecture, undefined docs publishing/versioning behavior, and produce OpenSpec requirements/scenarios.
- [x] 6.7 Backfill `release-packaging`: inspect `.craft.yml`, release version scripts, CI workflows, README/release docs, `pnpm release:check`, package publish behavior, undefined package-list ownership behavior, and produce OpenSpec requirements/scenarios.

## 7. Tier 5 Testing And Evaluation Governance

- [x] 7.1 Backfill `testing`: inspect `specs/testing.md`, test boundary scripts, package test configs, current unit/integration/eval distribution, undefined test-layer ownership behavior, and produce OpenSpec requirements/scenarios.
- [x] 7.2 Backfill `unit-testing`: inspect `specs/unit-testing.md`, current unit test patterns, mocking rules, undefined pure-logic boundary behavior, and produce OpenSpec requirements/scenarios.
- [x] 7.3 Backfill `integration-testing`: inspect `specs/integration-testing.md`, Slack/MSW harnesses, integration tests, undefined external HTTP and fake-agent boundary behavior, and produce OpenSpec requirements/scenarios.
- [x] 7.4 Backfill `eval-testing`: inspect `specs/eval-testing.md`, `packages/junior-evals`, eval harness, judge rubrics, existing eval naming/scope, undefined eval flake and provider credential behavior, and produce OpenSpec requirements/scenarios.
- [x] 7.5 Backfill `slack-http-mocking`: inspect `specs/slack-http-mocking.md`, MSW handlers/fixtures, Slack API contract tests, undefined request ordering/fixture ownership behavior, and produce OpenSpec requirements/scenarios.
- [x] 7.6 Create the eval taxonomy migration map: map every existing eval case to a capability requirement, then mark each file/case keep, rename, split, move, replace, or delete.

## 8. Tier 6 Observability And Security Governance

- [x] 8.1 Backfill `security-policy`: inspect `specs/security-policy.md`, sandbox egress policy, credential handling, OAuth/plugin auth, external prior art where relevant, undefined security exception behavior, and produce OpenSpec requirements/scenarios or decide to keep as policy-only.
- [x] 8.2 Backfill `instrumentation`: inspect `specs/instrumentation.md`, logging/tracing specs, instrumentation code/tests, OpenTelemetry prior art, undefined telemetry ownership behavior, and produce OpenSpec requirements/scenarios.
- [x] 8.3 Backfill `logging`: inspect `specs/logging.md`, `logging.ts`, log event names in runtime/tests, undefined attribute naming behavior, and produce OpenSpec requirements/scenarios.
- [x] 8.4 Backfill `tracing`: inspect `specs/tracing.md`, span helpers, Pi tracing, Sentry integration, undefined span lifecycle behavior, and produce OpenSpec requirements/scenarios.
- [x] 8.5 Backfill `otel-semantics`: inspect `specs/otel-semantics.md`, OpenTelemetry semantic conventions, current attributes, undefined custom `app.*` naming behavior, and produce OpenSpec requirements/scenarios.

## 9. Cross-Spec Cleanup And Canonicalization

- [x] 9.1 Update `specs/index.md` ownership map after each accepted backfill so capability ownership is discoverable and non-overlapping.
- [x] 9.2 Update root `AGENTS.md` known-spec pointers after each accepted backfill.
- [x] 9.3 For each superseded prose section, either archive it, narrow it to non-overlapping rationale, or link it to the authoritative OpenSpec capability.
- [x] 9.4 Run `openspec validate` for every backfill change before it is considered complete.
- [x] 9.5 Run the verification commands identified by each capability's verification map, and explicitly record any unverified scenarios or deferred open questions.
