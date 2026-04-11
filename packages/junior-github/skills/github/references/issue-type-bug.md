# Bug Issue Rules

Use this file only when issue type is `bug`.

## Primary Goal

Produce a high-signal bug issue that drives root-cause discovery, not premature solutioning.

## Research Guidance

Use these steps to investigate — they inform what goes into the issue, but do not dictate issue structure. The issue should be terse; research justifies what's included.

1. Capture concrete evidence: reproducible steps or explicit non-repro statement, exact error or symptom, impacted surface and scope.
2. Build a timeline with exact dates when known.
3. Separate verified facts from unknowns — label each explicitly.
4. Form root-cause hypotheses linked to evidence, with confidence (`high`, `medium`, `low`).

Include fix suggestions only when the thread discusses fixes. Do not present a fix as certain without explicit evidence.

## Context Generalization

When deriving bug content from conversation, generalize to the technical problem.

Before (session-specific):

> @alice ran `/github create` in #ops-alerts and saw "token refresh failed" when the OAuth token expired mid-thread

After (generalized):

> OAuth token refresh fails during long-running operations, producing "token refresh failed" errors
