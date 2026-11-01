# Local Agent

This module runs the shared Conversation runtime from the local CLI, without
Slack or the queue worker. `conversation.ts` owns identity. `runner.ts` owns
the direct runtime path.

## Invariants

- The credential Actor is the `local-cli` user.
- Save user input before execution. Write each completed tool-free assistant
  message to stdout and record it in Conversation order.
- Text sent with tool calls stays internal. A no-reply Turn writes nothing to
  stdout and adds no assistant message.
- Assistant messages go to stdout. Status and diagnostics go to stderr.
- Turn ids do not depend on transcript length.
- Follow-up Turns keep the full accepted history, including the final reply.
  Do not remove an accepted reply.
- Stdout and SQL writes are not one transaction. Do not claim that a crash
  between them is recoverable.
- Child-agent work runs in the CLI process. Drain it before exit. The CLI
  sends no child results to the root.
- Use only file paths that the user names. Do not make Slack attachments or
  file-delivery tools.
- Local OAuth sends plugin credentials back to the dev server over a signed
  loopback request. Never send a credential to the Sandbox.
