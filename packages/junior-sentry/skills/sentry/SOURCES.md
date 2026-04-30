# Sentry Skill Sources

Last updated: 2026-04-30

## Source inventory

| Source                                                          | Trust tier | Confidence | Contribution                                                                                                          | Usage constraints                                                   |
| --------------------------------------------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `https://github.com/getsentry/junior/issues/271`                | canonical  | high       | Regression report: Junior tried stale `sentry organizations list` and should verify current CLI help before blocking. | Use as issue context, not as a full command reference.              |
| `https://cli.sentry.dev/commands/issue/`                        | canonical  | high       | Current `sentry issue list`, target syntax, issue subcommands, and JSON support.                                      | Verify live help when runtime CLI differs.                          |
| `https://cli.sentry.dev/commands/org/`                          | canonical  | high       | Current `sentry org list` and `sentry org view` commands.                                                             | Verify live help when runtime CLI differs.                          |
| `https://cli.sentry.dev/commands/log/`                          | canonical  | high       | Current `sentry log list` and `sentry log view` commands, trace filtering, and log query flags.                       | Verify live help when runtime CLI differs.                          |
| `https://cli.sentry.dev/commands/trace/`                        | canonical  | high       | Current `sentry trace list`, `view`, and `logs` commands.                                                             | Verify live help when runtime CLI differs.                          |
| `https://cli.sentry.dev/commands/api/`                          | canonical  | high       | Authenticated `sentry api <endpoint>` fallback and request flags.                                                     | Use read-only requests unless the user asks for mutation.           |
| `https://cli.sentry.dev/configuration/`                         | canonical  | high       | `SENTRY_AUTH_TOKEN`, JSON/global flags, cache controls, and runtime configuration behavior.                           | Junior injects credentials; do not persist or print tokens.         |
| `pnpm view sentry version dist-tags description bin repository` | canonical  | high       | Confirmed npm package `sentry` latest is `0.30.0` and exposes `sentry` binary.                                        | Package metadata only; command behavior still comes from help/docs. |
| `pnpm dlx sentry@latest --help` and subcommand help             | canonical  | high       | Confirmed executable help lists org list/view, issue list/events/view, log list/view, trace list/view/logs, and api.  | Re-run when updating for a newer CLI.                               |
| `packages/junior-sentry/plugin.yaml`                            | canonical  | high       | Confirms runtime dependency is the npm `sentry` package and auth token env is `SENTRY_AUTH_TOKEN`.                    | Local repo contract.                                                |
| `packages/junior/src/chat/sandbox/eval-sentry-stub.ts`          | canonical  | medium     | Eval-only shim needed to avoid preserving stale command forms in tests.                                               | Not a production CLI source.                                        |

## Decisions

| Decision                                                   | Status   | Rationale                                                                                               |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| Use singular canonical command groups in runtime guidance. | adopted  | Current docs and latest executable help use `issue`, `org`, `log`, and `trace`.                         |
| Add a live-help verification gate before blocking.         | adopted  | Issue 271 showed a stale remembered command produced a false blocked answer.                            |
| Keep `sentry api <endpoint>` as a read-only fallback.      | adopted  | Current CLI exposes an authenticated API escape hatch for resources not covered by high-level commands. |
| Prefer `--json` and optional `--fields` for parsing.       | adopted  | Current CLI supports machine-readable output across command groups.                                     |
| Preserve stale plural subcommands as recommended forms.    | rejected | `organizations list` was the root failure; aliases should not be taught as canonical command shapes.    |
| Create a broad new troubleshooting reference.              | deferred | Current failure modes fit in the focused CLI reference without crowding `SKILL.md`.                     |

## Coverage matrix

| Dimension                          | Coverage status | Evidence                                                                                                                              |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| API surface and behavior contracts | complete        | `cli-commands.md` covers issue, org, log, trace, and API command shapes plus live help verification.                                  |
| Config/runtime options             | complete        | `sandbox-runtime.md`, `plugin.yaml`, and CLI configuration docs cover injected auth and runtime package installation.                 |
| Common use cases                   | complete        | `cli-commands.md` maps org listing, issue search/view/events, logs, traces, trace logs, and API fallback.                             |
| Known issues/workarounds           | complete        | `cli-commands.md` troubleshooting covers stale plural commands, target syntax, JSON parsing, cache, auth, scope, and access failures. |
| Version/migration variance         | complete        | The skill now treats live CLI help as final when references and installed CLI disagree.                                               |

## Open gaps

- Review the Sentry CLI docs and rerun `pnpm dlx sentry@latest --help` when the plugin pins or upgrades beyond npm `sentry@0.30.0`.

## Changelog

- 2026-04-30: Reconciled skill guidance with Sentry CLI `0.30.0`, replaced stale plural command forms, added live-help verification, expanded log/trace/API guidance, updated eval smoke artifacts, and added an org-list command-selection eval.
