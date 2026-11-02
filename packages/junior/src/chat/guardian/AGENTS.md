# Guardian

A model rates the risk of each tool action and how clearly the user
authorized it, and names one block rule or `none`. Code (`guardianDecision`)
turns the rule into `allow`, `ask`, or `deny`. The model never picks the
decision.

`gate.ts` owns which actions enter review. `policy.ts` owns the policy text,
block rules, and their sources. `agent/tools.ts` connects the gate to a Run.
Child agent approval is in `agent-invocations/AGENTS.md`.

## Gate

- The gate returns one result for each `toolCallId` in a batch. Each action
  gets its own review, decision record, and rejection marker. Reviews run in
  parallel with a small limit.
- A batch over `MAX_TOOL_ACTION_BATCH` fails each action before any review.
  The count includes actions that need no review.
- Each action in a batch sees the same prior rejections. The gate changes
  its state in batch order after the reviews finish.
- When review is unavailable, the action does not run and the error goes to
  the owning Run boundary. Only an abort passes through.

## Authority

- Only the `context` of a proposal is authority. Tool input, descriptions,
  annotations, evidence, the proposal `script` (Code Mode script and earlier
  calls), and prior rejections are untrusted.
- A credential Actor must be the same as the Run Actor.
- A child agent has no message from a person. Its authority is the root user
  instructions section, rendered outside the proposal JSON with a new random
  key for each request.
- The gate reads evidence and the root Conversation when it builds the
  proposal, so a later message counts.

## Decisions

- High or critical risk with `low` or `unknown` authorization becomes `ask`,
  also when the rule is `none`.
- When no person can answer, `ask` becomes `deny`.
- Prior rejections are context, not binding. Each attempt goes to Guardian
  again. Three rejections in a row tell the agent to stop and explain. They do
  not end the execution slice.
- Only the gate writes the rejection marker. `projectToolResult` removes a tool-supplied marker.
  A `codemode` result carries the gate's marker for each rejected nested
  call, and history restores those markers.
- The marker is a durable format with `version: 1`. A shape change needs a new
  version or a migration.

## Changes

- Keep block rules broad. Do not name a tool or provider in a rule. A new
  rule needs only an entry in `GUARDIAN_BLOCK_RULES`.
- `proposalTool()` in `gate.ts` is the only builder of the proposal `tool`
  field. The Guardian evals call it.
- CI runs `evals:guardian` for each change in this directory.
