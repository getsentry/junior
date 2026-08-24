INSERT INTO junior_code_repositories (
  id,
  name,
  provider,
  provider_id,
  url,
  updated_at
)
SELECT DISTINCT ON (repository_id)
  '6:github:' || repository_id,
  repository_full_name,
  'github',
  repository_id,
  'https://github.com/' || repository_full_name,
  updated_at
FROM junior_github_pull_requests
ORDER BY repository_id, updated_at DESC
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  url = EXCLUDED.url,
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
  updated_at,
  url
)
SELECT
  '6:github:' || pull_request_id,
  closed_at,
  conversation_ids,
  merged_at,
  number,
  opened_at,
  'github',
  pull_request_id,
  '6:github:' || repository_id,
  CASE state WHEN 'closed_unmerged' THEN 'closed' ELSE state END,
  updated_at,
  'https://github.com/' || repository_full_name || '/pull/' || number
FROM junior_github_pull_requests
ON CONFLICT (id) DO UPDATE SET
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
  updated_at = EXCLUDED.updated_at,
  url = EXCLUDED.url
WHERE junior_code_changes.updated_at <= EXCLUDED.updated_at;
