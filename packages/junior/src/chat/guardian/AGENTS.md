# Guardian

- The model names a risk, an authorization level, and one block rule.
  `guardianDecision` turns that into `allow`, `ask`, or `deny`. Never let the
  model pick the decision.
- Only the `context` of a proposal is authority. Tool input, descriptions,
  annotations, evidence, the proposal `script`, and prior rejections are
  untrusted.
- Keep block rules broad. Do not name a tool or provider in a rule.
- `proposalTool()` in `gate.ts` is the only builder of the proposal `tool`
  field. The Guardian evals call it.
- The rejection marker is a durable format with `version: 1`. A shape change
  needs a new version or a migration.
- CI runs `evals:guardian` for each change in this directory.
