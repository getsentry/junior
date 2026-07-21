# Local Agent

The local CLI exercises the shared conversation runtime without Slack or the
provider mailbox worker.

## Contract

- `junior chat -p <prompt>` executes one turn; interactive mode reuses one
  process-scoped conversation until exit.
- Conversation IDs use `local:<workspace-key>:<conversation-slug>`.
- Source context is local, the credential actor is the `local-cli` system actor,
  and Slack-only authorization or delivery surfaces are disabled.
- User input is persisted before execution; each completed tool-free assistant
  message is written to stdout and recorded in conversation order. Text emitted
  alongside tool calls remains internal. Post-delivery state is attempted
  immediately, then persisted again at turn completion.
- Each invocation uses a collision-resistant turn ID independent of transcript
  length. It records `turn_started` after durable input, then a terminal
  success, no-reply, or privacy-safe failure after the owning boundary.
- Intentional no-reply turns do not call the stdout sink and do not synthesize
  an assistant transcript message.
- Event appends are idempotent when explicitly retried, but stdout acceptance
  and SQL persistence are not one transaction. A process death in that interval
  can strand a started turn; lifecycle history does not claim otherwise.
- New CLI invocations do not promise restoration of prior interactive history.
- Status and diagnostics go to stderr; assistant messages go to stdout in model
  message order.
- Local file requests use paths named by the user. The adapter does not
  synthesize Slack attachments or file-delivery tools.

`conversation.ts` owns identity normalization and `runner.ts` owns the direct
runtime path. Manual validation is documented in
`packages/docs/src/content/docs/contribute/local-agent-validation.md`.
