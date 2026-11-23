-- Core migrations run first and drop the url columns, so this backfill
-- writes no links. The GitHub plugin builds them from the name and number.
INSERT INTO junior_code_repositories (
  id,
  name,
  provider,
  provider_id,
  updated_at
)
SELECT DISTINCT ON (repository_id)
  gen_random_uuid(),
  repository_full_name,
  'github',
  repository_id,
  updated_at
FROM junior_github_pull_requests
ORDER BY repository_id, updated_at DESC
ON CONFLICT (provider, provider_id) DO UPDATE SET
  name = EXCLUDED.name,
  updated_at = EXCLUDED.updated_at
WHERE junior_code_repositories.updated_at <= EXCLUDED.updated_at;
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
  updated_at
)
SELECT
  gen_random_uuid(),
  github_change.closed_at,
  github_change.conversation_ids,
  github_change.merged_at,
  github_change.number,
  github_change.opened_at,
  'github',
  github_change.pull_request_id,
  repository.id,
  CASE github_change.state
    WHEN 'closed_unmerged' THEN 'closed'
    ELSE github_change.state
  END,
  github_change.updated_at
FROM junior_github_pull_requests AS github_change
JOIN junior_code_repositories AS repository
  ON repository.provider = 'github'
  AND repository.provider_id = github_change.repository_id
ON CONFLICT (provider, provider_id) DO UPDATE SET
  closed_at = EXCLUDED.closed_at,
  conversation_ids = ARRAY(
    SELECT DISTINCT value
    FROM unnest(
      junior_code_changes.conversation_ids || EXCLUDED.conversation_ids
    ) AS value
    ORDER BY value
  ),
  merged_at = EXCLUDED.merged_at,
  number = EXCLUDED.number,
  opened_at = EXCLUDED.opened_at,
  repository_id = EXCLUDED.repository_id,
  state = EXCLUDED.state,
  updated_at = EXCLUDED.updated_at
WHERE junior_code_changes.updated_at <= EXCLUDED.updated_at;
