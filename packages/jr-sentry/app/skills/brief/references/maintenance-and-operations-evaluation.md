# Maintenance and Operations Evaluation

Use this reference to evaluate maintainership and reliability signals from public repository history.

## Scope

- Review release cadence, dependency hygiene, CI health, and issue/PR follow-through visible in public artifacts.
- Focus on observable maintainership behavior after initial delivery.

## Minimum evidence

- Review at least 2 maintenance/operations artifacts when available.
- Include one recency signal and one reliability signal.
- If public maintenance history is too thin, mark `limited` or `not-assessed`.

## What to inspect

- Maintenance cadence: regular updates, patch follow-through, and release hygiene.
- Reliability practices visible publicly: CI stability, regression fixes, and bug follow-through.
- Dependency management: update discipline and security hygiene.
- Troubleshooting/operational docs that are publicly available.

## Authenticity checks

- Prefer artifact history over one-time cleanup commits.
- Corroborate claims of reliability with issue/PR timelines or release evidence.
- If operations evidence is missing, call out uncertainty explicitly.

## Not evaluable from public data

- Private incident timelines and on-call execution quality.
- Internal deployment processes and internal SLO performance.

## Scoring guide (1-5)

- `5`: strong long-term maintenance discipline with reliable operations evidence.
- `4`: solid maintenance practices with limited gaps.
- `3`: mixed maintenance maturity or uneven follow-through.
- `2`: recurring reliability/maintenance problems.
- `1`: high-risk maintenance profile with little credible evidence.

## Required output shape

- `Maintenance and operations evaluation`: include `evidence sufficiency` (`assessed`, `limited`, or `not-assessed`), score when assessable, positives, risks, and a `References` subsection.
- `References`: at least 2 citations when available.
- Each citation should include URL + artifact pointer + short impact statement.
