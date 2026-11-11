turn_api-msg_479c9a8f01c9e1aaf3003598:assistant:1
I found one, but I couldn't search the whole repository. I can only open files by path, so I checked about 20 likely files.
**What's still filtered inline:** `packages/junior/src/api/conversations/detail-etag.ts` has its own Quick question checks for a Conversation's fork list:
- `:114-115`: `eq(versionFork.forkedFromConversationId, conversationId), isNull(versionFork.quickQuestionAt)`. This is inside the `forks` subquery that goes into the detail version token (`:107-123`).
- `:168-169`: the same pair, `eq(fork.forkedFromConversationId, …), isNull(fork.quickQuestionAt)`.
This is not quite the same "inline pair" that #3071 removed. Both spots check only `quickQuestionAt`, not `parentConversationId`, and they scope by `forkedFromConversationId`. Swapping in `listedConversation()` would add a root check. That only keeps behavior the same if forks are always roots. The fork test says forks are created "without creating roots", which hints at that, but I didn't confirm it in the schema. Also, the fork test's `sourceForks()` expects `[]` while the Quick question is unkept. So the fork list depends on this filter just as the feed does, and it can drift the same way.
- `api/conversations/fork.ts`, `detail.ts`, `projection.ts`, `versions.ts`, `chat/conversations/retention.ts`, `chat/review-items/store.ts`, `api/people/spend.query.ts`, `chat/automations/execution-stats.ts` and `chat/plugins/conversation-sidebar.ts` don't mention `quickQuestionAt`.
- `api/conversations/access.ts:85-96` checks `parentConversationId` for access, not for a list.
- I ran out of tool budget before I could read `detail-etag.ts:160-175` in full. So I can't say which query the `:168` check belongs to.
- I also couldn't see whether `readConversationForks` (imported at `detail-etag.ts:23`) filters anywhere else.
A repo-wide `rg "quickQuestionAt"` in a checkout would settle both questions. That's also the check the Walkthrough's "all-sites-covered" assumption is missing.
