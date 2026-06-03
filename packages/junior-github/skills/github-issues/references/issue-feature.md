# Feature Issue Guide

Load when issue type is `feature`. Cross-type rules (title length, delegated footer, generalization, compression) live in `SKILL.md` § Draft issue content.

## Primary goal

Propose an intentional improvement with clear current-state analysis and practical options.

## Shape

A flat bullet list is fine for simple features. Use headed sections only when tradeoffs need detailed framing.

**Summary** — up to 3 sentences describing the improvement. Short imperative title (e.g. "Support SAML SSO for enterprise orgs").

**Suggested sections (use only what fits):**

- **Current behavior** — how the system works today
- **Gap** — why current behavior is insufficient, with concrete impact
- **Options** — viable approaches with tradeoffs (include only when the thread discusses alternatives)

For simple features, skip sections and use flat bullets describing the gap and desired capability.

## Research guidance

1. Analyze current behavior and why it's insufficient.
2. Gather prior art when available — include links and what each proves. If none found, omit rather than stating "none found."
3. Frame options with tradeoffs when the thread discusses alternatives.

## Context generalization

Before (session-specific):

> @carol mentioned in the standup thread that she has to manually restart the worker every time the config changes

After (generalized):

> Workers do not pick up config changes without a restart, requiring manual intervention
