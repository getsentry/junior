# GitHub/Code Evaluation

Use this reference for repository-based engineering signal quality.

## Scope

- Evaluate code quality, architecture, testing discipline, and scope handling from public repos.
- Prioritize recent candidate-owned repositories when available.
- Include collaborative evidence (shared repos, PRs, or review activity) when available.
- Exclude private/internal engineering signals that are not publicly observable.

## Minimum evidence

- Target at least 3 code artifacts when available.
- Prefer at least one file-level code read and one test/CI signal.
- If fewer artifacts are available publicly, mark this component `limited` or `not-assessed`.

## What to inspect

- Architecture clarity: module boundaries, layering, dependency direction, complexity control.
- Correctness and quality gates: tests, CI checks, lint/type discipline, failure handling.
- Delivery quality: feature completeness, bug fix follow-through, production-readiness indicators.
- Documentation quality: README setup, architecture notes, operational guidance.

## Authenticity checks

- Prefer sustained commit/review history over single bulk drops.
- Corroborate ownership with repeated technical decisions across commits/PRs/issues.
- Watch for generated/copied code with little evidence of understanding.
- If ownership is unclear, mark the signal as uncertain and lower confidence.

## Not evaluable from public data

- Internal architecture debates not posted publicly.
- Private incident response execution.
- Internal performance ratings or team-level throughput metrics.

## Scoring guide (1-5)

- `5`: consistently strong architecture, robust tests/CI, and clear ownership across multiple artifacts.
- `4`: strong overall quality with minor gaps.
- `3`: mixed quality; some strengths but important weaknesses.
- `2`: frequent quality gaps, weak testing, or low confidence in ownership.
- `1`: high risk quality profile with little trustworthy evidence.

## Required output shape

- `GitHub/code evaluation`: include `evidence sufficiency` (`assessed`, `limited`, or `not-assessed`), score when assessable, positives, risks, and a `References` subsection.
- `References`: at least 3 concrete citations when available.
- Each citation should include URL + artifact pointer + short impact statement.

Citation format:

- `<url or repo path> - <what was observed> - <why it matters>`
