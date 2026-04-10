# Feature Issue Rules

Use this file only when issue type is `feature`.

## Primary Goal

Propose an intentional improvement with clear current-state analysis and practical options.

## Research Guidance

Use these steps to investigate — they inform what goes into the issue, but do not dictate issue structure.

1. Analyze current behavior and why it's insufficient.
2. Gather prior art when available — include links and what each proves. If none found, omit rather than stating "none found."
3. Frame options with tradeoffs when the thread discusses alternatives.

## Context Generalization

When deriving feature content from conversation, generalize to the capability gap.

Before (session-specific):

> @carol mentioned in the standup thread that she has to manually restart the worker every time the config changes

After (generalized):

> Workers do not pick up config changes without a restart, requiring manual intervention
