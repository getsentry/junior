-- The GitHub plugin no longer adds a merge conflict notice, and it no longer
-- closes one. This dismisses the notices that are still open, so they do not
-- stay in the Inbox. Like a dismiss when no agent can act, it sends no
-- message and does not change the Slack cards. A click on an old card finds
-- the item closed and updates the card.
-- junior:bounded-backfill: only open GitHub merge conflict notices, at most one per open Junior pull request, among open items, which the status index finds.
UPDATE "junior_review_items"
SET
  "status" = 'dismissed',
  "closed_at" = now(),
  "close_reason" = 'Junior no longer adds merge conflict notices.',
  "updated_at" = now()
WHERE "status" = 'open'
  AND "kind" = 'notice'
  AND "dedupe_key" LIKE 'plugin:github:merge-conflict:%';
