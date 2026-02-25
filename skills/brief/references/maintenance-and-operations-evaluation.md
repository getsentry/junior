# Maintenance and Operations Evaluation

Use this reference to evaluate reliability and long-term ownership signals from public artifacts.

## Scope

- Review release cadence, dependency hygiene, CI health, issue follow-through, and operational documentation.
- Focus on whether the candidate can keep systems healthy after initial delivery.

## Minimum evidence

- Review at least 2 maintenance/operations artifacts when available.
- Include one recency signal and one reliability signal.

## What to inspect

- Maintenance cadence: regular updates, patch follow-through, and release hygiene.
- Reliability practices: CI stability, regression handling, and rollback/fix behavior.
- Dependency management: update discipline and security hygiene.
- Operational readiness: runbooks, troubleshooting notes, deployment guidance.

## Authenticity checks

- Prefer artifact history over one-time cleanup commits.
- Corroborate claims of reliability with issue/PR timelines or release evidence.
- If operations evidence is missing, call out uncertainty explicitly.

## Scoring guide (1-5)

- `5`: strong long-term maintenance discipline with reliable operations evidence.
- `4`: solid maintenance practices with limited gaps.
- `3`: mixed maintenance maturity or uneven follow-through.
- `2`: recurring reliability/maintenance problems.
- `1`: high-risk maintenance profile with little credible evidence.

## Required output shape

- `Maintenance and operations evaluation`: include score, positives, risks, and a `References` subsection.
- `References`: at least 2 citations when available.
- Each citation should include URL + artifact pointer + short impact statement.

