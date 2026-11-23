-- Junior's code index holds the lifecycle and the linked Conversations of
-- Junior pull requests, and 0019 drops their copies here. Copy a pull
-- request that the code index does not have, and a newer lifecycle or
-- Conversation link of one that it has. Only those rows change.
INSERT INTO junior_code_repositories (
  id,
  name,
  provider,
  provider_id,
  url,
  updated_at
)
SELECT DISTINCT ON (repository_id)
  gen_random_uuid(),
  repository_full_name,
  'github',
  repository_id,
  'https://github.com/' || repository_full_name,
  updated_at
FROM junior_github_pull_requests
ORDER BY repository_id, updated_at DESC
ON CONFLICT (provider, provider_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO junior_code_changes (
  id,
  closed_at,
  conversation_ids,
  merged_at,
  number,
  opened_at,
  provider,
  provider_id,
  repository_id,
  state,
  updated_at,
  url
)
SELECT
  gen_random_uuid(),
  CASE WHEN github_change.state <> 'open' THEN github_change.finished_at END,
  github_change.conversation_ids,
  CASE WHEN github_change.state = 'merged' THEN github_change.finished_at END,
  github_change.number,
  github_change.opened_at,
  'github',
  github_change.pull_request_id,
  repository.id,
  CASE github_change.state
    WHEN 'closed_unmerged' THEN 'closed'
    ELSE github_change.state
  END,
  github_change.updated_at,
  'https://github.com/' || github_change.repository_full_name || '/pull/' || github_change.number
FROM junior_github_pull_requests AS github_change
JOIN junior_code_repositories AS repository
  ON repository.provider = 'github'
  AND repository.provider_id = github_change.repository_id
ON CONFLICT (provider, provider_id) DO UPDATE SET
  closed_at = CASE
    WHEN junior_code_changes.updated_at < EXCLUDED.updated_at
      THEN EXCLUDED.closed_at
    ELSE junior_code_changes.closed_at
  END,
  conversation_ids = ARRAY(
    SELECT DISTINCT value
    FROM unnest(
      junior_code_changes.conversation_ids || EXCLUDED.conversation_ids
    ) AS value
    ORDER BY value
  ),
  merged_at = CASE
    WHEN junior_code_changes.updated_at < EXCLUDED.updated_at
      THEN EXCLUDED.merged_at
    ELSE junior_code_changes.merged_at
  END,
  state = CASE
    WHEN junior_code_changes.updated_at < EXCLUDED.updated_at
      THEN EXCLUDED.state
    ELSE junior_code_changes.state
  END,
  updated_at = GREATEST(junior_code_changes.updated_at, EXCLUDED.updated_at)
WHERE junior_code_changes.updated_at < EXCLUDED.updated_at
  OR NOT junior_code_changes.conversation_ids @> EXCLUDED.conversation_ids;
