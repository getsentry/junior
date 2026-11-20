**Stacked on #2458.** Merge that first, then retarget this PR to `main`.

## What was wrong

- Some Junior posts in Slack went to the wrong thread, or had no session footer. They guessed the Slack thread from the Conversation id. That breaks for Automation and Watch threads, because their ids (like `agent-dispatch:watch-1`) are not Slack thread ids.
- Automations with no configured output still posted error messages and notices to Slack.

## What this changes

1. **One way to pick where a post goes.** A new `resolveSlackReplyTarget` in `slack/reply.ts` picks the channel and thread. Every Turn post (replies, error messages, auth notices) now goes through it and `sendSlackReply`, so each post lands in the right thread and has the footer.
2. **Automations stay quiet.** An Automation run posts only the outputs that it declares. When it has no outputs, it posts nothing, also when it fails. The failure is still recorded on the Turn and the Automation. Chat Turns still get their error reply, including a reply in an Automation's thread.
3. **A lint guard.** Two ast-grep rules block raw Slack posts and thread lookups from Conversation ids. A short allow list covers the posts that are not Turn output: stop acks, OAuth links, DMs, and the `requestUserInput` buttons.

A side fix: when a stuck Automation run was failed, its dispatch stayed `running`. It is now marked `failed`.

## Not changed

Plugin dispatches (`ctx.agent.dispatch`) keep their current behavior. They post their result to the destination they give.

## Tests

- `durable-queue.test.ts`: a failed reply in a Watch thread is posted in that thread, with the footer.
- `agent-dispatch-work.test.ts`: an Automation with no outputs that fails posts nothing to Slack.
- Typecheck, lint, ast-grep, unit and component tests (2377), and the touched integration tests pass. `event-automations` has one failure that also happens on the base branch.
