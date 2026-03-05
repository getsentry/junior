# Feature Issue Rules

Use this file only when issue type is `feature`.

## Primary Goal

Propose an intentional improvement with clear current-state analysis and practical options.

## Required Research Shape

1. Analyze how the system works today:
- current behavior
- known constraints
- why current behavior is insufficient

2. Gather prior art:
- target a couple relevant examples when available
- include links and what each example proves
- if none found, explicitly say no strong prior art was found

3. Frame options:
- at least one viable path, preferably multiple when tradeoffs are meaningful
- include implementation and operational tradeoffs

## Context Generalization

When deriving feature content from conversation, generalize to the capability gap.

Before (session-specific):
> @carol mentioned in the standup thread that she has to manually restart the worker every time the config changes

After (generalized):
> Workers do not pick up config changes without a restart, requiring manual intervention

## Completion Bar

A `feature` issue is ready when it has:
- clear problem framing and objective
- current-state analysis
- prior-art section (or explicit none found)
- concise option tradeoffs
