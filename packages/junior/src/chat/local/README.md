# Local Agent

The local CLI exercises the shared conversation runtime without Slack or the
provider mailbox worker.

## Contract

- `junior chat -p <prompt>` executes one turn; interactive mode reuses one
  process-scoped conversation until exit.
- Conversation IDs use `local:<workspace-key>:<conversation-slug>`.
- Source context is local, the credential actor is the `local-cli` system actor,
  and Slack-only authorization or delivery surfaces are disabled.
- User input is persisted before execution; finalized assistant output is
  persisted after stdout delivery succeeds.
- New CLI invocations do not promise restoration of prior interactive history.
- Status and diagnostics go to stderr; the final answer goes to stdout.
- Local file requests use paths named by the user. The adapter does not
  synthesize Slack attachments or file-delivery tools.

`conversation.ts` owns identity normalization and `runner.ts` owns the direct
runtime path. Manual validation is documented in
`packages/docs/src/content/docs/contribute/local-agent-validation.md`.
