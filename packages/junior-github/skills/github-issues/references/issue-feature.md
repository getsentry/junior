# Feature Issue Guide

Load when issue type is `feature`. Cross-type rules (title length, delegated footer, generalization, compression) live in `SKILL.md` § Draft issue content.

## Primary goal

Describe an intentional improvement through verified current-state analysis, the gap, and its impact without prescribing implementation.

## Shape

A flat bullet list is fine for simple features. Use headed sections only when the current-state evidence and impact need detailed framing.

**Summary** — up to 3 sentences describing the improvement. Short imperative title (e.g. "Support SAML SSO for enterprise orgs").

**Suggested sections (use only what fits):**

- **Current behavior** — how the system works today
- **Gap** — why current behavior is insufficient, with concrete impact

For simple features, skip sections and use flat bullets describing the current behavior, gap, and impact.

## Research guidance

1. Analyze current behavior and why it's insufficient.
2. Gather prior art when available — include links and what each proves. If none found, omit rather than stating "none found."
3. Do not generate approaches or options. Preserve a specific proposal only when the user explicitly asks, attribute it, and keep it separate from the gap analysis.

## Context generalization

Before (session-specific):

> @carol mentioned in the standup thread that she has to manually restart the worker every time the config changes

After (generalized):

> Workers do not pick up config changes without a restart, requiring manual intervention
