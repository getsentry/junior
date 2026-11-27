-- The migration before this one adds the GitHub id of the pull request to
-- its opener's row. Copy it from Junior's code index, by repository name and
-- number. A renamed repository no longer has the name on the row, so the
-- second update below finds it through the opener's Conversation.
-- junior:bounded-backfill: only the opener rows of Junior pull requests, one per pull request that Junior opened for a person, each written once.
UPDATE junior_github_pull_request_requesters AS requester
SET pull_request_id = change.provider_id
FROM junior_code_changes AS change
JOIN junior_code_repositories AS repository
  ON repository.id = change.repository_id
WHERE requester.conversation_id IS NOT NULL
  AND requester.pull_request_id IS NULL
  AND change.provider = 'github'
  AND lower(repository.name) = requester.repository_full_name
  AND change.number = requester.number;--> statement-breakpoint
-- junior:bounded-backfill: only the opener rows that the update above left unset. Each gets the change with its number that its Conversation opened, when only one change matches. Two repositories with that number in one Conversation leave the row unset.
UPDATE junior_github_pull_request_requesters AS requester
SET pull_request_id = (
  SELECT min(change.provider_id)
  FROM junior_code_changes AS change
  WHERE change.provider = 'github'
    AND change.number = requester.number
    AND change.conversation_ids @> ARRAY[requester.conversation_id]
  HAVING count(*) = 1
)
WHERE requester.conversation_id IS NOT NULL
  AND requester.pull_request_id IS NULL;
