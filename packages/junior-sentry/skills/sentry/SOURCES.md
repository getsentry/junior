# Sentry Skill Sources

Last updated: 2026-07-13

## Source inventory

| Source                                                          | Trust tier | Confidence | Contribution                                                                                                                                       | Usage constraints                                                   |
| --------------------------------------------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `https://github.com/getsentry/junior/issues/271`                | canonical  | high       | Regression report: Junior tried stale `sentry organizations list` and should verify current CLI help before blocking.                              | Use as issue context, not as a full command reference.              |
| `https://cli.sentry.dev/commands/issue/`                        | canonical  | high       | Current `sentry issue list`, target syntax, issue subcommands, and JSON support.                                                                   | Verify live help when runtime CLI differs.                          |
| `https://cli.sentry.dev/commands/org/`                          | canonical  | high       | Current `sentry org list` and `sentry org view` commands.                                                                                          | Verify live help when runtime CLI differs.                          |
| `https://cli.sentry.dev/commands/log/`                          | canonical  | high       | Current `sentry log list` and `sentry log view` commands, trace filtering, and log query flags.                                                    | Verify live help when runtime CLI differs.                          |
| `https://cli.sentry.dev/commands/trace/`                        | canonical  | high       | Current `sentry trace list`, `view`, and `logs` commands.                                                                                          | Verify live help when runtime CLI differs.                          |
| `https://cli.sentry.dev/commands/api/`                          | canonical  | high       | Authenticated `sentry api <endpoint>` fallback and request flags.                                                                                  | Use read-only requests unless the user asks for mutation.           |
| `https://cli.sentry.dev/configuration/`                         | canonical  | high       | `SENTRY_AUTH_TOKEN`, JSON/global flags, cache controls, and runtime configuration behavior.                                                        | Junior injects credentials; do not persist or print tokens.         |
| `pnpm view sentry version dist-tags description bin repository` | canonical  | high       | Confirmed npm package `sentry` latest is `0.38.0` and exposes the `sentry` binary.                                                                   | Package metadata only; command behavior still comes from help/docs. |
| `pnpm dlx sentry@latest --help` and subcommand help             | canonical  | high       | Confirmed `alert metrics list|view|create|edit|delete`, including triggers and dry-run, plus the existing investigation commands.                   | Re-run when updating for a newer CLI.                               |
| `packages/junior-sentry/plugin.yaml`                            | canonical  | high       | Confirms runtime dependency is the npm `sentry` package and auth token env is `SENTRY_AUTH_TOKEN`.                                                 | Local repo contract.                                                |
| `https://github.com/getsentry/junior/issues/615`                | canonical  | high       | Regression report: Sentry product feature usage routed to Hex, then an explicit "use Sentry telemetry" redirect was ignored after Hex auth paused. | Use as routing evidence, not as command reference.                  |
| `https://docs.sentry.io/api/monitors/create-a-monitor-for-a-project/` | canonical | high | Current public monitor creation endpoint, payload fields, and metric monitor examples. | Alerting API may evolve; verify live docs before writes. |
| `https://docs.sentry.io/api/monitors/create-an-alert-for-an-organization/` | canonical | high | Current public alert workflow endpoint, connection fields, conditions, and actions. | Resolve integration and target IDs; never guess action identifiers. |
| `getsentry/sentry` workflow engine endpoint and frontend form sources | canonical | high | Confirms `alerts:write`, `detectors`/`workflows` paths, dynamic anomaly payload shape, and legacy alert-rule deprecation. | Source-backed implementation detail; public API docs remain the user-facing contract. |

## Decisions

| Decision                                                                                             | Status   | Rationale                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| Use singular canonical command groups in runtime guidance.                                           | adopted  | Current docs and latest executable help use `issue`, `org`, `log`, and `trace`.                               |
| Add a live-help verification gate before blocking.                                                   | adopted  | Issue 271 showed a stale remembered command produced a false blocked answer.                                  |
| Keep `sentry api <endpoint>` as a read-only fallback.                                                | adopted  | Current CLI exposes an authenticated API escape hatch for resources not covered by high-level commands.       |
| Prefer `--json` and optional `--fields` for parsing.                                                 | adopted  | Current CLI supports machine-readable output across command groups.                                           |
| Treat Sentry product feature usage and explicit Sentry telemetry redirects as Sentry skill triggers. | adopted  | Issue 615 showed the previous trigger language under-specified product-introspection queries and let Hex win. |
| Preserve stale plural subcommands as recommended forms.                                              | rejected | `organizations list` was the root failure; aliases should not be taught as canonical command shapes.          |
| Create a broad new troubleshooting reference.                                                        | deferred | Current failure modes fit in the focused CLI reference without crowding `SKILL.md`.                           |
| Permit explicitly requested alert/monitor writes only.                                               | adopted  | `alerts:write` is intentionally narrow; unrelated Sentry mutations remain out of scope.                       |
| Prefer first-class `sentry alert metrics` commands.                                                    | adopted  | CLI `0.38.0` supports list, view, create, edit, delete, triggers, and dry-run.                                 |
| Keep API fallback for dynamic anomaly detection.                                                       | adopted  | The current CLI create flags expose threshold triggers but no dynamic/anomaly configuration.                  |

## Coverage matrix

| Dimension                          | Coverage status | Evidence                                                                                                                                                                                                 |
| ---------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API surface and behavior contracts | complete        | `cli-commands.md` covers issue, org, log, trace, first-class metric-alert commands, and API fallback plus live help verification.                                                                        |
| Config/runtime options             | complete        | `sandbox-runtime.md`, `plugin.yaml`, and CLI configuration docs cover injected auth and runtime package installation.                                                                                    |
| Common use cases                   | complete        | `cli-commands.md` maps org listing, issue search/view/events, logs, traces, trace logs, and API fallback.                                                                                                |
| Product telemetry routing          | documented      | `SKILL.md` and `SPEC.md` cover Sentry product feature usage and explicit "Sentry telemetry" redirects after an unrelated auth pause. A dedicated eval should wait for the eval harness boundary cleanup. |
| Known issues/workarounds           | complete        | `cli-commands.md` troubleshooting covers stale plural commands, target syntax, JSON parsing, cache, auth, scope, and access failures.                                                                    |
| Version/migration variance         | complete        | The skill now treats live CLI help as final when references and installed CLI disagree.                                                                                                                  |

## Open gaps

- Review the Sentry CLI docs and rerun `pnpm dlx sentry@latest --help` when the plugin pins or upgrades beyond npm `sentry@0.38.0`.

## Changelog

- 2026-07-13: Added CLI-first `sentry alert metrics` guidance, explicit-write and duplicate safeguards, API fallback for unsupported anomaly configuration, and `alerts:write` scope behavior.
- 2026-06-18: Expanded trigger language for Sentry product telemetry and feature usage, and recorded issue 615 routing evidence.
- 2026-04-30: Reconciled skill guidance with Sentry CLI `0.30.0`, replaced stale plural command forms, added live-help verification, expanded log/trace/API guidance, updated eval smoke artifacts, and added an org-list command-selection eval.
