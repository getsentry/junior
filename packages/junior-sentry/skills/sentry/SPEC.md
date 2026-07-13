# Sentry Skill Specification

## Intent

The Sentry skill helps agents investigate live Sentry telemetry and create explicitly requested alerts and monitors through the Sentry CLI using per-user credentials injected by Junior.
It should produce useful investigation results, safe alerting mutations, or Sentry web links without exposing credentials.

## Scope

In scope:

- Listing and viewing Sentry issues, issue events, logs, traces, organizations, and related read-only data.
- Investigating Sentry's own product telemetry and product feature usage through Sentry CLI/API data surfaces.
- Using `sentry api <endpoint>` for authenticated requests when no high-level command exists.
- Creating explicitly requested metric alerts through `sentry alert metrics` after duplicate checks and dry-run validation, with API fallback only for unsupported alert behavior.
- Generating Sentry deep links for user-scoped or entity-specific views.
- Diagnosing auth, scope, and access failures without guessing missing scopes.

Out of scope:

- Repository, code search, commit, branch, and pull-request work.
- Mutating Sentry data outside explicitly requested alert or monitor operations.
- Persisting, printing, or transforming Sentry credentials.

## Users And Trigger Context

- Primary users: Junior users asking Slack or harness agents to investigate Sentry data.
- Common user requests: "list my Sentry issues", "show error logs", "inspect this trace", "which orgs can I access", "open the issue in Sentry", "use Sentry telemetry", "create a metric alert", and "notify this channel when this monitor fires".
- Should not trigger for: source-code tasks, GitHub PRs, repository searches, or generic questions about Sentry SDK implementation.

## Runtime Contract

- Required first actions: classify the Sentry operation, resolve configured org/project when needed, and verify current CLI help before blocking on an unknown command.
- Required outputs: concise findings, relevant Sentry URLs or deep links, created alerting resource URLs, and clear access/auth failure messages.
- Non-negotiable constraints: do not print credentials; default to read-only commands; only perform explicitly requested alerting mutations; check duplicates and dry-run before writing; use canonical current CLI command groups; use `sentry api` before claiming a surface is unavailable.
- Expected bundled files loaded at runtime: `references/cli-commands.md`, `references/deep-link-patterns.md`, and `references/sandbox-runtime.md`.

## Current CLI Data

- Verified date: 2026-07-13.
- Verified npm package: `sentry@0.38.0`, installed from the plugin `runtime-dependencies` entry.
- Auth model: Junior injects `SENTRY_AUTH_TOKEN` for authenticated Sentry commands during the requesting user's turn.
- Canonical command groups: `sentry issue`, `sentry org`, `sentry log`, `sentry trace`, `sentry alert metrics`, and `sentry api`.
- Required migration rule: prefer singular command groups such as `sentry org list`; do not teach stale plural command forms such as `sentry organizations list`.
- Required fallback rule: use `sentry api <endpoint>` when no high-level CLI command covers the requested surface.
- Alerting write rule: prefer `sentry alert metrics`; use the API fallback only when live CLI help confirms the requested behavior is unsupported.

## Source And Evidence Model

Authoritative sources:

- Current Sentry CLI docs and live `sentry --help` output.
- The Sentry plugin manifest and Junior runtime contracts.
- GitHub issues or PRs that document observed skill failures.

Useful improvement sources:

- positive examples: successful Sentry investigations with exact command choices.
- negative examples: false blocked answers, stale CLI command forms, or incorrect auth/scope recovery.
- commit logs/changelogs: Sentry CLI command migrations and Junior plugin runtime changes.
- issue or PR feedback: reports like issue 271.
- eval results: targeted Slack/harness evals for command selection and credential injection.

Data that must not be stored:

- secrets
- customer data
- private Sentry URLs or identifiers that are not needed for reproduction

## Reference Architecture

- `SKILL.md` contains activation, workflow routing, and non-negotiable guardrails.
- `SOURCES.md` contains provenance, decisions, coverage, gaps, and changelog.
- `references/cli-commands.md` contains command selection, flags, use cases, and troubleshooting.
- `references/deep-link-patterns.md` contains URL templates and link-generation rules.
- `references/sandbox-runtime.md` contains harness runtime and credential injection guidance.
- `references/evidence/`, `scripts/`, and `assets/` are currently unused.

## Evaluation

- Lightweight validation: run skill validation and grep for stale command forms after CLI updates.
- Deeper evaluation: add Slack/harness evals for org listing, issue search, log search, trace lookup, API fallback, auth recovery, explicit alert creation, duplicate prevention, and refusal of unrelated mutations.
- Holdout examples: requests that mention "organizations list", "orgs", "logs for this trace", and "use the API".
- Acceptance gates: command guidance matches latest CLI help, stale plural forms are not canonical, read-only fallback is available, alerting writes require explicit intent plus duplicate and dry-run checks, unrelated mutations remain blocked, and credential handling remains private.

## Known Limitations

- The skill depends on the runtime-installed npm `sentry` package, which may change independently of this repository.
- The eval shim is intentionally narrow and is not a full Sentry CLI replacement.
- Some live Sentry requests require org/project context or product access that the current user may not have.

## Maintenance Notes

- When to update `SKILL.md`: trigger language, workflow order, or global guardrails change.
- When to update `SOURCES.md`: command surfaces, docs, issue evidence, or runtime dependency behavior changes.
- When to update `README.md` and this `SPEC.md`: verified Sentry CLI version, canonical command groups, or migration/fallback rules change.
- When to update `references/cli-commands.md`: any Sentry CLI command, flag, target syntax, or fallback behavior changes.
- When to update `references/evidence/`: store durable examples of repeated false positives, false blocks, or corrected investigations.
