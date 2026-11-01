# Guardian

Guardian reviews one tool action before it runs. A model rates the risk and
how clearly the user authorized the action, and names one block rule or
`none`. Code (`guardianDecision`) turns that rule into `allow`, `ask`, or
`deny`. The model never picks the decision.

`gate.ts` owns which actions enter review. `policy.ts` owns the policy text,
the block rules, and their sources. `agent/tools.ts` connects the gate to a
Run. For child agent approval, see `agent-invocations/AGENTS.md`.

## Rules

- Unavailable review fails closed. The action does not run, and the error
  goes to the owning Run boundary. Only an abort passes through.
- The gate records each decision in the Conversation event log before the
  action continues.
- Only the `context` of a proposal is authority. Tool input, descriptions,
  annotations, evidence, and prior rejections are untrusted.
- A credential Actor must be the same as the Actor of the Run.
- A child agent has no message from a person. Its authority is the root user
  instructions section. The reviewer renders it outside the proposal JSON
  with a new random key for each request.
- The gate reads evidence and the root Conversation when it builds the
  proposal, so a later message counts.
- A high or critical risk with `low` or `unknown` authorization becomes `ask`,
  also when the rule is `none`.
- When no person can answer, `ask` becomes `deny`.
- Prior rejections are context, not binding decisions. Each attempt goes to
  Guardian again. Three rejections in a row tell the agent to stop and
  explain. They do not end the execution slice.
- Only the gate writes the rejection marker. `projectToolResult` removes a
  marker that a tool supplied.
- The rejection marker is a durable format with `version: 1`. A change to its
  shape needs a new version or a migration.

## Changes

- Keep each block rule broad. Do not name a tool or a provider in a rule. A
  new rule needs only an entry in `GUARDIAN_BLOCK_RULES`.
- Keep `proposalTool()` in `gate.ts` the only builder of the proposal `tool`
  field. The Guardian evals call it.
- CI runs the Guardian evals (`evals:guardian`) for each change in this
  directory.
