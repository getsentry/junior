-- The GitHub plugin now asks to resume merge conflict fixes with an action
-- item that has a Resume button. The old notices have no button, so this
-- dismisses the ones that are still open. The next check of a pull request
-- that is still stopped adds the new item. Like a dismiss when no agent can
-- act, it sends no message and does not change the Slack cards. A click on
-- an old card finds the item closed and updates the card.
-- junior:bounded-backfill: only open GitHub merge conflict notices, at most one per open Junior pull request, among open items, which the status index finds.
UPDATE "junior_review_items"
SET
  "status" = 'dismissed',
  "closed_at" = now(),
  "close_reason" = 'Replaced by an item with a Resume button.',
  "updated_at" = now()
WHERE "status" = 'open'
  AND "kind" = 'notice'
  AND "dedupe_key" LIKE 'plugin:github:merge-conflict:%';
