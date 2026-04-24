# Bug Issue Guide

Load when issue type is `bug`. Cross-type rules (title length, delegated footer, generalization, compression) live in `SKILL.md` § Draft issue content.

## Primary goal

Produce a high-signal bug issue that drives root-cause discovery, not premature solutioning.

## Shape

A few bullets often suffice. Use headed sections only when complexity demands them.

**Summary** — up to 3 sentences describing the failure and its impact. Short descriptive title (e.g. "OAuth token refresh fails in long-running operations").

**Suggested sections (use only what fits):**

- **Root cause** — technical explanation with code snippets if relevant
- **Reproduction** — numbered steps any developer can follow independently
- **Expected behavior** — include only when the thread explicitly states what should happen
- **Workaround** — current mitigation if one exists

For simple bugs, skip sections and use flat bullet lists.

## Research guidance

Research informs what goes in the issue, not how structured it looks.

1. Capture concrete evidence: reproducible steps or explicit non-repro statement, exact error or symptom, impacted surface and scope.
2. Build a timeline with exact dates when known.
3. Separate verified facts from unknowns — label each explicitly.
4. Form root-cause hypotheses linked to evidence, with confidence (`high`, `medium`, `low`).

Include fix suggestions only when the thread discusses fixes. Do not present a fix as certain without explicit evidence.

## Context generalization

Before (session-specific):

> @alice ran `/github create` in #ops-alerts and saw "token refresh failed" when the OAuth token expired mid-thread

After (generalized):

> OAuth token refresh fails during long-running operations, producing "token refresh failed" errors
