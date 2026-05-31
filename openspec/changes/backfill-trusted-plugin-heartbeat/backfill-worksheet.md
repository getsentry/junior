# Backfill Worksheet: `trusted-plugin-heartbeat`

## Scope

- Capability: Trusted plugin heartbeat
- Change: `backfill-trusted-plugin-heartbeat`
- Owner: spec backfill program
- Status: draft
- Canonical target: existing `specs/trusted-plugin-heartbeat.md` plus `openspec/specs/trusted-plugin-heartbeat/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/trusted-plugin-heartbeat.md`: current prose heartbeat contract.
- `specs/trusted-plugin-dispatch.md`: dispatch API/recovery details.
- `specs/plugin-runtime.md`: trusted plugin registration and tool hooks.
- `specs/scheduler.md`: scheduler plugin domain behavior.
- `specs/security-policy.md`: route auth and secret redaction.
- `specs/testing.md`: verification layer ownership.

### Code Paths

- `packages/junior-plugin-api/src/index.ts`: heartbeat context/result and trusted plugin hooks.
- `packages/junior/src/handlers/heartbeat.ts`: authenticated internal endpoint.
- `packages/junior/src/chat/agent-dispatch/heartbeat.ts`: core heartbeat runner, dispatch recovery, plugin hook invocation, budgets.
- `packages/junior/src/chat/agent-dispatch/context.ts`: heartbeat context and dispatch fanout cap.
- `packages/junior/src/chat/plugins/agent-hooks.ts`: trusted plugin registration/validation and tool hooks.
- `packages/junior/src/chat/plugins/state.ts`: namespaced plugin state facade.
- `packages/junior/src/chat/plugins/logging.ts`: plugin logger facade.

### Tests And Evals

- Integration:
  - `packages/junior/tests/integration/heartbeat.test.ts`
  - Scheduler integration cases in the same file.
- Unit:
  - `packages/junior/tests/unit/app-config.test.ts`
  - `packages/junior/tests/unit/plugins/agent-hooks.test.ts`
- Evals:
  - Scheduler creation/confirmation evals may cover user-facing scheduled behavior, not heartbeat mechanics.

## Prior Art

- Cron systems provide best-effort timing, not a strict exactly-once execution model; durable state and idempotency own correctness.
- Queue systems commonly perform bounded recovery/redelivery before accepting new work.
- Trusted extension APIs should expose constrained capability objects rather than deployment internals.

Sources:

- Vercel Cron Jobs: https://vercel.com/docs/cron-jobs
- Vercel Queues: https://vercel.com/docs/queues

## Implemented Behavior

- Behavior that code currently enforces:
  - Heartbeat endpoint accepts `JUNIOR_SCHEDULER_SECRET` or `CRON_SECRET` as bearer secret and uses timing-safe comparison.
  - Unauthorized heartbeat requests return 401 and do not schedule work.
  - Authorized heartbeat requests schedule `runHeartbeat({ nowMs })` via `waitUntil` and return 202.
  - `runHeartbeat` calls `recoverStaleDispatches` before trusted plugin heartbeat hooks.
  - Trusted plugin hooks are invoked in registered plugin order with a default plugin limit and per-hook timeout.
  - Plugin hook failures are logged and isolated.
  - Heartbeat context includes plugin metadata, `nowMs`, plugin logger, plugin-scoped state, and dispatch/get.
  - Dispatch fanout is capped per heartbeat context, and invalid dispatch requests do not count.
  - Plugin state keys are hashed under plugin namespace; legacy prefixes are allowed only when configured.
  - Trusted plugin tools are collected during turn tool registration, not heartbeat.
- Behavior that tests currently verify:
  - Unauthorized and authorized heartbeat endpoint behavior.
  - Trusted plugin heartbeat invocation.
  - Plugin-scoped dispatch lookup.
  - Plugin state delimiter isolation and legacy scheduler state access.
  - Dispatch fanout cap and invalid-not-counted behavior.
  - Scheduler heartbeat claim/dispatch/reconcile/failure cases.
- Behavior that appears accidental or weakly enforced:
  - Secret env var name remains scheduler-specific.
  - Plugin failure isolation is implemented but not strongly isolated in a direct multi-plugin failure test.
  - Plugin logger metadata is unconstrained.
  - Tool registration details live in plugin runtime code, while heartbeat prose describes them.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Heartbeat is trusted-only and core-owned.
  - Heartbeat endpoint is authenticated and generic.
  - Core dispatch recovery runs before plugin hooks.
  - Plugin hooks are bounded, idempotent, and failure-isolated.
  - Context exposes only narrow capabilities.
  - Durable plugin state is namespaced by plugin.
- Behavior that should remain implementation detail:
  - Exact per-plugin timeout and plugin limit.
  - Exact secret env var fallback names until naming is consolidated.
  - Exact logging event names and payload shape.
  - Exact state key hash algorithm.
- Behavior that should be non-goal:
  - Scheduler recurrence rules.
  - Dispatch retry state machine details.
  - Raw Slack or deployment adapter access.
  - Plugin-defined routes.

## Undefined Behavior / Open Questions

| Question                                         | Evidence                                                                 | Options                                                         | Recommendation                                        | Status |
| ------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------- | ------ |
| Should heartbeat secret env be renamed?          | Code accepts `JUNIOR_SCHEDULER_SECRET` even though heartbeat is generic. | Keep, alias, or migrate to `JUNIOR_HEARTBEAT_SECRET`.           | Alias before hard cutover if public config exists.    | open   |
| Should plugin logger metadata be restricted?     | Logger merges arbitrary metadata.                                        | Trust plugin, schema restrict, or central redaction.            | Central redaction plus documented safe metadata.      | open   |
| Should tool registration stay in heartbeat spec? | Prose includes tools; implementation in plugin runtime.                  | Split dedicated trusted tools spec, keep pointer, or keep here. | Keep only boundary pointer here during consolidation. | open   |
| How explicit should failure isolation tests be?  | Heartbeat catches each plugin; inspected tests focus scheduler paths.    | Add multi-plugin throw test or rely on code.                    | Add direct test if heartbeat changes.                 | open   |
| Who owns production cron config?                 | Endpoint exists, deployment scheduling separate.                         | Docs, release packaging, or heartbeat spec.                     | Public docs/release packaging should own.             | open   |

## OpenSpec Requirements Draft

| Requirement                    | Scenarios                                        | Source Evidence      | Notes                       |
| ------------------------------ | ------------------------------------------------ | -------------------- | --------------------------- |
| Trusted heartbeat availability | trusted, manifest-only, invalid identity         | spec/app tests       | Host-code only.             |
| Endpoint authentication        | missing, no secret, authorized                   | handler/tests        | Secret naming gap.          |
| Execution ordering             | recovery first, recovery fail continue           | heartbeat code/tests | Dispatch details elsewhere. |
| Bounded invocation             | skip, run, limit, timeout, throw, dispatch count | heartbeat code/tests | Constants detail.           |
| Reliability model              | missed, overlap, unfinished work                 | spec/scheduler tests | Idempotency.                |
| Namespaced plugin state        | valid, invalid, isolated, legacy                 | state/tests          | Hash impl detail.           |
| Capability boundaries          | no raw internals, dispatch/get, logging          | API/code             | Security boundary.          |
| Tool registration boundary     | tools hook, turn context, model-facing policy    | agent-hooks/spec     | Ownership split.            |
| Verification taxonomy          | endpoint, context, registration, scheduler       | testing spec         | Layer map.                  |

## Migration Notes

- Canonical spec updates:
  - Consolidate `specs/trusted-plugin-heartbeat.md` with this OpenSpec capability after review.
  - Keep dispatch internals in `trusted-plugin-dispatch`.
- Index/pointer updates:
  - Existing `specs/index.md` and root `AGENTS.md` already list trusted plugin heartbeat; add OpenSpec pointer after acceptance.
- Superseded content:
  - Move detailed trusted tool registration to plugin runtime or a future trusted-tools spec.
  - Move scheduler domain semantics to scheduler spec.
- Test/eval taxonomy changes:
  - Keep heartbeat mechanics in integration tests.
  - Use evals only for user-visible schedule authoring or schedule-result quality.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-trusted-plugin-heartbeat' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: secret naming, logger metadata restrictions, tool registration ownership, direct failure-isolation test, cron config ownership.
