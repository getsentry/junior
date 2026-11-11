turn_api-msg_a43aca11453eb3dd20e12201:assistant:1
Neither throw ends the Turn with a reply. Both errors escape `executeAgentRun` as plain exceptions, so the worker retries the Turn and, once retries run out, records it as failed with nothing posted. I could trace this all the way for the second throw (person input on a task). I couldn't for the first one (child Run with no Conversation row).
**Why they skip the normal failure reply**
- Throw 1 runs in `executeAgentRun` before the privacy wrapper (`agent/index.ts:238-244`).
- Throw 2 is `turnBehavior` (`kind-behavior.ts:108`). It is called at the top of `executeAgentRunInPrivacyContext` (`agent/index.ts:~296`), before the main `try`.
- Errors inside that `try` usually come back as a `completed` result with `outcome: "provider_error"`. The worker then posts the cleaned-up failure text for that result. These two throws never reach that `catch`, so that fallback never runs.
**What the mailbox worker does with them** (`task-execution/conversation-turn.ts`)
- `executeTurn` wraps the error in `AgentRunError` (`runtime/turn-execution.ts`).
- **Before the final attempt,** the worker rethrows. `processConversationWork` (`task-execution/worker.ts`) records a failed delivery attempt, releases the Lease and wakes the Conversation again. The error comes from stored state, so every retry fails the same way. The retries are cheap because the throw happens before the sandbox, tools or model start.
  - logs `conversation.turn.agent_run_failed` to Sentry
  - fails the Turn record (`failTurnRecord`)
  - marks the Turn failed in thread state (`markTurnFailed`)
  - writes the failed-Turn lifecycle event with `failureCode: "agent_run_failed"` (`lifecycle.fail`)
  - acks the input and returns `completed`
- `deliverAssistantMessage` is never called, so no text reaches the Location. My guess, not checked in the UI code, is that the person sees a failed Turn with no reply.
- **Throw 2** can happen through this mailbox worker. Web input that lands on a task Conversation would take the path above.
- **Throw 1** only fires when the Run sets `parentConversationId`. The mailbox worker's `AgentRun` doesn't set it, so this worker can't hit throw 1. Child Runs come from the agent invocation worker. I couldn't find that file at the head of #3059 by guessing its path, so I haven't checked how it handles the error: whether it tells the parent, retries, or drops the work. Reading that worker's error path would answer it.
The concern in the Walkthrough holds for the mailbox path: a legacy row or a spawn race now gives up after retries and fails the Turn quietly, where it used to run.
