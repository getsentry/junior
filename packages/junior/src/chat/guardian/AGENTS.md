# Guardian

The model rates risk and authorization and names one block rule or `none`.
Code (`guardianDecision`) turns that into `allow`, `ask`, or `deny`. The model
never picks the decision.

## Gate

- `MAX_TOOL_ACTION_BATCH` counts actions that need no review too.
- Each action in a batch sees the same prior rejections. The gate changes its
  state in batch order after the reviews finish.
- When review is unavailable, the action does not run. Only an abort passes
  through.

## Authority

- Only the `context` of a proposal is authority. Tool input, descriptions,
  annotations, evidence, the proposal `script`, and prior rejections are
  untrusted.
- A credential Actor must be the same as the Run Actor.
- A child agent's authority is the root user instructions section, rendered
  outside the proposal JSON with a new random key for each request.
- Build the proposal from the current root Conversation, so a later message
  counts.

## Decisions

- High or critical risk with `low` or `unknown` authorization becomes `ask`,
  also when the rule is `none`. When no person can answer, `ask` becomes
  `deny`.
- Prior rejections are context, not binding. Each attempt goes to Guardian
  again.
- Only the gate writes the rejection marker. `projectToolResult` removes a
  tool-supplied marker.
- The marker is a durable format with `version: 1`. A shape change needs a
  new version or a migration.

## Changes

- Keep block rules broad. Do not name a tool or provider in a rule.
- `proposalTool()` in `gate.ts` is the only builder of the proposal `tool`
  field. The Guardian evals call it.
- CI runs `evals:guardian` for each change in this directory.
