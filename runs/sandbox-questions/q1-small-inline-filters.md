No. At the PR head (`6024898`), no list or search still checks both conditions inline. A search of the source for `quickQuestionAt` (tests and migrations left out) finds one place that filters on it as a list condition: `listed.ts:13`, the helper itself. All five callers the Walkthrough names use `listedConversation()`: `list.ts:151` and `:319`, `board/read.ts:118`, `search-top-level.ts:73` and `briefs/search.ts:96`.

The other `isNull(quickQuestionAt)` matches are in `detail-etag.ts:115` and `:169`. They filter on a different column: they choose which forks of one Conversation to show (`forkedFromConversationId = id`). They don't check for root Conversations, so the helper doesn't apply.

What's left are checks for root Conversations only, with no Quick question condition:

- **Locations list and stats** (`locations/query.ts:119`, `stats.query.ts:144`): the Walkthrough already raises these. They still include unkept Quick questions.
- **Slack message search** (`sql/message-search.ts:49`): this search only checks for roots. But it also requires `source = 'slack'` and a public destination. A Quick question is a private web Conversation (`fork.ts:183-186`), so the extra filters already exclude it. That reading comes from the fork code; I didn't find a test for it.
- **`listByActivity`** (`sql/store.ts:631`): its comment says "excluded from top-level listings", but it only checks for roots. Only tests call it, so no live list is affected. Still, a future caller would get unkept Quick questions back.
- **Purge, participants, the location bind and delivery pause** (`purge.ts:172`, `participants.ts:120`, `location.ts:151`, `delivery-pause.ts:17`): these check structure, not what a list shows. The helper's doc comment says checks like these shouldn't use it.

I searched a tarball of the head commit with `rg`, since `git fetch` failed here. Raw SQL that spells out `quick_question_at` would have shown up too, and there is none outside migrations.
