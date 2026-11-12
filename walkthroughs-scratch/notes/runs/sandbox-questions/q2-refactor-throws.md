Neither new throw is handled inside the agent. Both happen before the main `try` in `executeAgentRunInPrivacyContext` (index.ts:451), so the Run never reaches the catch that would turn an error into a `provider_error` reply. The error goes up through `executeTurn`, which wraps it in `AgentRunError` (`runtime/turn-execution.ts`). The worker that started the Run then decides what happens.

**Missing child row** (`agent/index.ts:240`). Only the agent invocation worker sets `parentConversationId`, so this throw only reaches that worker (`agent-invocations/work.ts`, the catch after `executeTurn`):

- **Before the final attempt:** the worker rethrows and the queue tries again. Input was never committed, so the mailbox message is still there. If the row appears in time, a later attempt can succeed.
- **On the final attempt:** the invocation is marked `failed`, with the error text "Child Conversation … has no Conversation row". `finish` closes the child Turn as `model_execution_failed` and reports the failure to the parent's mailbox. The parent agent then sees a failed child result.
- The child posts no reply and no failure text. This check also runs before `withLogContext`, so the thrown error carries no Run log context.

**Person input on a task** (`kind-behavior.ts:109`, called at index.ts:298). A Slack or web source with an agent invocation worker can't reach this throw. Inference: it would come from the web/event mailbox worker (`task-execution/conversation-turn.ts`), if that worker ever ran a person's input on a task.

- **Before the final attempt:** the worker rethrows and the queue retries.
- **On the final attempt:** it fails the Turn record, marks the Turn and Message failed, records `lifecycle.fail` with `agent_run_failed`, captures the exception, and acks the input.
- The person gets no failure reply. The agent never produced one, and the failure path doesn't post one either.

**What I checked:** `executeAgentRun`, `turnBehavior`, `executeTurn`, and the error handling in both workers at the head commit. I couldn't clone the repository, so I didn't search for every caller of `executeAgentRun`. Other callers, such as the CLI, could handle these errors differently. Also, the code doesn't show how many retries the queue allows. That limit decides how long a missing row has to appear before the child fails for good.
