# Agent Steering

## Intent

Agent behavior needs clear steering. Extra natural-language lines in system
prompts, tool descriptions, and skills raise cost and noise when they repeat the
same rule. Prefer one owner for each rule, and prefer structure over stacked
prose.

## Policy

- Prefer structured tool contracts, schemas, runtime gates, and code invariants
  over additive natural-language prompt lines.
- Give each steering rule one home. Prefer the tool schema or description when
  the rule is about when or how to call that tool. Prefer the system prompt only
  for cross-tool delivery or protocol rules. Prefer a skill only for workflow
  that loads on demand.
- Do not restate the same rule in the system prompt and a tool description
  unless the second copy serves a different audience, such as the model versus a
  guardian or a human reviewer.
- When an eval flakes or fails, fix the product invariant, fixture, harness, or
  case shape first. Do not stack prompt or tool text only to force the case
  green.
- Keep prompts short. When behavior moves into code, schemas, or runtime gates,
  delete the obsolete natural-language steering in the same change.

## Exceptions

- A short cross-reference is fine when one surface must point readers to the
  owning rule without repeating it.
- Security, privacy, and hard safety backstops may appear in more than one
  surface when each copy is required for a different enforcement path.
