# Guardian

Guardian reviews one tool action before it runs. A model rates the risk of
the action and how clearly the user authorized it. It then names one block
rule, or `none`. Code turns that rule into `allow`, `ask`, or `deny`. The model
never picks the decision.

The policy is adapted from the Codex Guardian. The block rules follow Claude
Code auto mode. The sources are in the header of `policy.ts`.

## Files

| File          | Owns                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| `gate.ts`     | The execution gate: which actions enter review, context checks, and rejection errors. |
| `proposal.ts` | The exact request that Guardian reviews, and the decision it returns.                 |
| `evidence.ts` | The bounded transcript evidence in a proposal.                                        |
| `history.ts`  | Prior rejections: the durable marker on a tool result and the restore from history.   |
| `policy.ts`   | The system prompt and the block rules.                                                |
| `reviewer.ts` | The prompt for one proposal, the model call, and the decision from the assessment.    |

`agent-invocations/root-conversation.ts` reads the root Conversation of a
child agent. See "User Approval" in `agent-invocations/README.md`.
`agent/tools.ts` connects the gate to a Run.

## Flow

1. `pi-tool-adapter.ts` calls `reviewToolAction` before each tool runs.
2. The gate decides if the action enters review. A core tool with no mode, or
   with `approve`, does not. An `auto` tool enters review unless it is a core
   tool with a full set of safe annotations. Every other mode enters review.
3. The gate checks the core context. The Actor and the user intent must be
   present. A credential Actor must be the same as the Run's Actor. When a
   check fails, review is not available.
4. The gate builds the proposal. It reads the evidence and, for a child agent,
   the root Conversation at this time, so a later message counts.
5. The reviewer renders the proposal and calls the model. It retries one
   invalid structured response. It times out after 60 seconds.
6. `guardianDecision` derives the decision. See "Decision" below.
7. The gate records the decision in the conversation event log before the
   action continues.
8. On `ask` or `deny`, the gate throws `ToolActionRejectedError`. The tool
   result tells the agent what to do next. `projectToolResult` adds a marker
   to that result. When the Turn resumes, the gate restores its prior
   rejections from these markers.

## Decision

- The named rule sets the decision. `none` is `allow`. Each rule in
  `GUARDIAN_BLOCK_RULES` sets `ask` or `deny`.
- A high or critical risk with `low` or `unknown` authorization becomes `ask`,
  also when the rule is `none`.
- When no person can answer, `ask` becomes `deny`. This is an Automation run,
  or a child agent whose root is an Automation run. The reason then says that
  no person can confirm.

## Rules To Keep

- Unavailable review fails closed. The action does not run, and the error
  goes to the owning Run boundary. Only an abort passes through as is.
- Only the `context` of a proposal is authority. Tool input, descriptions,
  annotations, evidence, and prior rejections are untrusted.
- A child agent has no message from a person. Its user intent is
  `CHILD_AGENT_USER_INTENT`. Its authority is the root user instructions
  section, which the reviewer renders outside the proposal JSON with a new
  random key for each request.
- Prior rejections are context, not binding decisions. Each attempt that
  enters review goes to Guardian again.
- After three rejections in a row, the rejection tells the agent to stop and
  explain. It does not end the execution slice.
- Only the gate can write the rejection marker. `projectToolResult` removes a
  marker that a tool supplied.
- The rejection marker is a durable format with `version: 1`. A change to its
  shape needs a new version or a migration.

## Change Guardian

- Policy text and block rules are in `policy.ts`. Keep each rule broad. Do not
  name a tool or a provider in a rule.
- A new rule needs only an entry in `GUARDIAN_BLOCK_RULES`. The schema and the
  prompt read the rule ids from it.
- The Guardian evals in `packages/junior-evals/evals/guardian/` send exact
  proposals to the real reviewer. CI runs them for each change in this
  directory. Run them with `pnpm --filter @sentry/junior-evals evals:guardian`.
- Telemetry names are in `TELEMETRY.md`.
